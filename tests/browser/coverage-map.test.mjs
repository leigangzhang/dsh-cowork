import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  CLIENT_BROWSER_BLOCKED,
  CLIENT_BROWSER_TSX,
  clientCoverageFromEntries,
  clientCoverageFromEntry,
  clientCoverageLcov,
  clientSourceFile,
  comboGeneratedRange,
  comboSectionIndex,
  coverageCompletenessFailures,
  coverageGateFailures,
  coverageNavigationGuard,
  flattenSourceMapSources,
  pluginBundleEntry,
} from '../../scripts/evidence/client-coverage.mjs'
import { parseLcov, uncoveredLines } from '../../scripts/evidence/coverage-lcov.mjs'

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Encode one signed VLQ segment value. */
function vlq(value) {
  let number = value < 0 ? ((-value) << 1) | 1 : value << 1
  let encoded = ''
  do {
    let digit = number & 31
    number >>>= 5
    if (number > 0) digit |= 32
    encoded += BASE64[digit]
  } while (number > 0)
  return encoded
}

/**
 * Build a one-source v3 map where generated line N starts at source line N.
 * The mapper only needs line/column fidelity; this synthetic map exercises the
 * same `SourceMap.findOrigin` path as the real esbuild map.
 */
function syntheticMap(source, lines) {
  let previousSource = 0
  let previousSourceLine = 0
  let previousSourceColumn = 0
  const mappings = lines.map((sourceLine, generatedLine) => {
    const sourceDelta = 0 - previousSource
    const lineDelta = sourceLine - previousSourceLine
    const columnDelta = 0 - previousSourceColumn
    previousSource = 0
    previousSourceLine = sourceLine
    previousSourceColumn = 0
    return `${vlq(0)}${vlq(sourceDelta)}${vlq(lineDelta)}${vlq(columnDelta)}`
    // `generatedLine` is implicit: mappings are joined with ';'.
  }).join(';')
  return {
    version: 3,
    sources: [source],
    sourcesContent: [lines.map((_, line) => `source line ${line + 1}`).join('\n')],
    names: [],
    mappings,
  }
}

test('synthetic sourcemap maps executed lines and exposes a failing gate', () => {
  const text = [
    'const first = 1',
    'function Demo() {',
    '  return first',
    '}',
    '',
  ].join('\n')
  const map = syntheticMap('../src/client/demo.tsx', [0, 1, 2, 3, 4])
  const coveredUntil = text.indexOf('  return first')
  const report = clientCoverageFromEntry({
    entry: {
      url: 'http://127.0.0.1/client.js',
      source: text,
      functions: [{
        functionName: '(top-level)',
        ranges: [
          { startOffset: 0, endOffset: text.length, count: 1 },
          { startOffset: coveredUntil, endOffset: text.length, count: 0 },
        ],
      }],
    },
    sourceMapPayload: map,
    repoRoot: '/repo',
    mapDirectory: '/repo/lib',
    sourceExists: () => true,
  })
  const demo = report.files.find(file => file.file === 'src/client/demo.tsx')
  assert.ok(demo, 'the synthetic source appears in the report')
  assert.equal(demo.owner, 'browser')
  assert.equal(demo.status, 'counted')
  assert.equal(demo.executableLines, 4)
  assert.equal(demo.executedLines, 2)
  assert.equal(demo.totalFunctions, 1)
  assert.equal(demo.executedFunctions, 1)
  assert.deepEqual(coverageGateFailures(report, {
    'src/client/demo.tsx': { lineCoverage: 60 },
  }), ['src/client/demo.tsx: line 50% < 60%'])
  assert.deepEqual(coverageGateFailures(report, {
    'src/client/demo.tsx': { lineCoverage: 50, functionCoverage: 100 },
  }), [])
  assert.deepEqual(coverageGateFailures(report, {
    'src/client/missing.tsx': { lineCoverage: 100 },
  }), ['src/client/missing.tsx: missing from browser coverage report'])
})

test('the mapped report renders LCOV with the same covered and uncovered lines', () => {
  const text = ['const first = 1', 'function Demo() {', '  return first', '}', ''].join('\n')
  const report = clientCoverageFromEntry({
    entry: {
      url: 'http://127.0.0.1/client.js',
      source: text,
      functions: [{
        functionName: '(top-level)',
        ranges: [
          { startOffset: 0, endOffset: text.length, count: 1 },
          { startOffset: text.indexOf('  return first'), endOffset: text.length, count: 0 },
        ],
      }],
    },
    sourceMapPayload: syntheticMap('../src/client/demo.tsx', [0, 1, 2, 3, 4]),
    repoRoot: '/repo',
    mapDirectory: '/repo/lib',
    sourceExists: () => true,
  })
  const demo = report.files.find(file => file.file === 'src/client/demo.tsx')
  const lcov = clientCoverageLcov(report)
  const record = parseLcov(lcov).get('src/client/demo.tsx')
  assert.ok(record, 'the browser LCOV carries the mapped file')
  assert.equal(record.lines.size, demo.executableLines)
  assert.deepEqual(uncoveredLines(record), demo.uncoveredLines)
  assert.deepEqual(
    [...record.lines].filter(([, count]) => count > 0).map(([line]) => line).sort((left, right) => left - right),
    demo.coveredLines,
  )
})

test('mapped lines outside the source content are dropped', () => {
  const text = ['const first = 1', 'function Demo() {', '  return first', '}', ''].join('\n')
  const map = syntheticMap('../src/client/demo.tsx', [0, 1, 2, 3, 10])
  const report = clientCoverageFromEntry({
    entry: {
      url: 'http://127.0.0.1/client.js',
      source: text,
      functions: [{ functionName: '(top-level)', ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }] }],
    },
    sourceMapPayload: map,
    repoRoot: '/repo',
    mapDirectory: '/repo/lib',
    sourceExists: () => true,
  })
  const demo = report.files.find(file => file.file === 'src/client/demo.tsx')
  assert.equal(demo.sourceLines, 5)
  assert.equal(demo.executableLines, 4)
  assert.ok([...demo.coveredLines, ...demo.uncoveredLines].every(line => line >= 1 && line <= demo.sourceLines))
})

test('blocked notice renderer stays visible as a reason, never as covered', () => {
  const text = 'export function NoticeCard() {\n  return null\n}\n'
  const map = syntheticMap('../src/client/notice.tsx', [0, 1, 2, 3])
  const report = clientCoverageFromEntry({
    entry: {
      url: 'http://127.0.0.1/client.js',
      source: text,
      functions: [{ functionName: 'NoticeCard', ranges: [{ start: 0, end: text.length, count: 0 }] }],
    },
    sourceMapPayload: map,
    repoRoot: '/repo',
    mapDirectory: '/repo/lib',
    sourceExists: () => true,
  })
  const notice = report.files.find(file => file.file === 'src/client/notice.tsx')
  assert.equal(notice.status, 'blocked')
  assert.equal(notice.blockedReason, CLIENT_BROWSER_BLOCKED['src/client/notice.tsx'].reason)
  assert.equal(notice.executedLines, 0)
  assert.deepEqual(coverageGateFailures(report, {
    'src/client/notice.tsx': { lineCoverage: 100 },
  }), [])
})

test('completeness requires every expected TSX and a blocked notice entry', () => {
  assert.deepEqual(
    coverageCompletenessFailures({ files: [] }),
    CLIENT_BROWSER_TSX.map(file => `${file}: missing from browser coverage report`),
  )
  const counted = CLIENT_BROWSER_TSX
    .filter(file => file !== 'src/client/notice.tsx')
    .map(file => ({ file, status: 'counted', executableLines: 1 }))
  const blocked = {
    file: 'src/client/notice.tsx',
    status: 'blocked',
    blockedReason: CLIENT_BROWSER_BLOCKED['src/client/notice.tsx'].reason,
    executableLines: 1,
  }
  assert.deepEqual(coverageCompletenessFailures({ files: [...counted, blocked] }), [])
  assert.deepEqual(
    coverageCompletenessFailures({ files: [...counted, { ...blocked, status: 'counted' }] }),
    ['src/client/notice.tsx: expected blocked, got counted'],
  )
  assert.deepEqual(
    coverageCompletenessFailures({ files: [...counted, { ...blocked, blockedReason: '' }] }),
    ['src/client/notice.tsx: blocked entry needs a reason'],
  )
  assert.deepEqual(
    coverageCompletenessFailures({ files: [counted[0], counted[0]] }, ['src/client/index.tsx']),
    ['src/client/index.tsx: duplicate entry in browser coverage report'],
  )
})

test('browser TSX expectation matches the directory and carries the KI-40 trigger', () => {
  const actual = readdirSync(new URL('../../src/client/', import.meta.url))
    .filter(name => name.endsWith('.tsx'))
    .map(name => `src/client/${name}`)
    .sort()
  assert.deepEqual([...CLIENT_BROWSER_TSX].sort(), actual)
  const blocked = CLIENT_BROWSER_BLOCKED['src/client/notice.tsx']
  assert.equal(blocked.issue, 'KI-40')
  assert.match(blocked.retireWhen, /sessionNotices/)
  const issues = readFileSync(new URL('../../docs/KNOWN_ISSUES.md', import.meta.url), 'utf8')
  assert.match(issues, /KI-40/)
  assert.match(issues, /sessionNotices/)
})

test('combo source paths stay scoped to this plugin and indexed maps expose their sections', () => {
  assert.equal(
    clientSourceFile('/plugins/@dsh-external/dsh-cowork/src/client/panel.tsx', '/repo', '/repo/lib', () => true),
    'src/client/panel.tsx',
  )
  assert.equal(
    clientSourceFile('/plugins/@dsh-external/src/client/panel.tsx', '/repo', '/repo/lib', () => true),
    null,
    'an unqualified @dsh-external path is only accepted from a bound combo section',
  )
  assert.equal(
    clientSourceFile(
      '/plugins/@dsh-external/src/client/panel.tsx',
      '/repo',
      '/repo/lib',
      () => true,
      { allowUnqualifiedPackage: true },
    ),
    'src/client/panel.tsx',
  )
  assert.equal(
    clientSourceFile('/plugins/@dsh-external/other/src/client/panel.tsx', '/repo', '/repo/lib', () => true),
    null,
    'a same-named file from another @dsh-external package must not be attributed here',
  )
  assert.equal(
    clientSourceFile('/plugins/@deepseek-ai/dsh-client-ui-chat/src/client/chat.tsx', '/repo', '/repo/lib', () => true),
    null,
  )
  assert.equal(
    clientSourceFile('../src/client/foreign.tsx', '/repo', '/repo/lib', () => false),
    null,
  )
  const regular = syntheticMap('../src/client/demo.tsx', [0, 1])
  const indexed = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: regular },
      { offset: { line: 2, column: 0 }, map: syntheticMap('../src/client/notice.tsx', [0, 1]) },
    ],
  }
  assert.deepEqual(
    flattenSourceMapSources(indexed).map(entry => entry.source),
    ['../src/client/demo.tsx', '../src/client/notice.tsx'],
  )
  assert.deepEqual(
    flattenSourceMapSources(indexed, 1).map(entry => entry.source),
    ['../src/client/notice.tsx'],
  )
  assert.deepEqual(comboGeneratedRange(indexed, 1), { start: 2, end: Number.POSITIVE_INFINITY })
  assert.equal(comboSectionIndex(
    'http://127.0.0.1/plugins/??@scope/one/client.js,@dsh-external/dsh-cowork/client.js&rev=r',
  ), 1)
  assert.equal(comboSectionIndex('http://127.0.0.1/plugins/??@scope/one/client.js'), null)
})

test('one combo section is mapped end to end without leaking the adjacent section', () => {
  const text = [
    'const first = 1',
    'const second = 2',
    'function Second() {',
    '  return second',
    '}',
    '',
  ].join('\n')
  const indexed = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: syntheticMap('../src/client/first.tsx', [0, 1]) },
      { offset: { line: 2, column: 0 }, map: syntheticMap('../src/client/second.tsx', [0, 1, 2]) },
    ],
  }
  const secondStart = text.indexOf('function Second')
  const report = clientCoverageFromEntry({
    entry: {
      url: 'http://127.0.0.1/plugins/??@scope/one/client.js,@dsh-external/dsh-cowork/client.js',
      source: text,
      functions: [
        { functionName: 'first', ranges: [{ startOffset: 0, endOffset: secondStart, count: 1 }] },
        { functionName: 'Second', ranges: [{ startOffset: secondStart, endOffset: text.length, count: 1 }] },
      ],
    },
    sourceMapPayload: indexed,
    repoRoot: '/repo',
    mapDirectory: '/repo/lib',
    sourceExists: () => true,
    sectionIndex: 1,
  })
  assert.deepEqual(report.files.map(file => file.file), ['src/client/second.tsx'])
  const second = report.files[0]
  assert.equal(second.executableLines, 3, 'generated lines 2..4 map to the second section only')
  assert.equal(second.executedLines, 3)
  assert.equal(second.totalFunctions, 1, 'a function starting outside the section is not mapped')
  assert.equal(second.uncoveredLines.length, 0)
})

test('the bundle selector accepts the combo containing this plugin and rejects host scripts', () => {
  assert.equal(pluginBundleEntry([
    { url: 'http://127.0.0.1/assets/app.js', source: 'host app' },
    {
      url: 'http://127.0.0.1/plugins/??@scope/one/client.js,@dsh-external/dsh-cowork/client.js&rev=r',
      source: 'window.__ModuleLoader__.load({ id: "@dsh-external/dsh-cowork" })',
    },
  ])?.url, 'http://127.0.0.1/plugins/??@scope/one/client.js,@dsh-external/dsh-cowork/client.js&rev=r')
  assert.equal(pluginBundleEntry([{ url: 'http://127.0.0.1/loader.js', source: 'host' }]), null)
})

test('raw range lists clamp to the bundle and ignore empty or inverted offsets', () => {
  const text = ['alpha', 'beta'].join('\n')
  const report = clientCoverageFromEntry({
    entry: {
      url: 'http://127.0.0.1/client.js',
      source: text,
      ranges: [
        { startOffset: -8, endOffset: 5, count: 1 },
        { startOffset: 6, endOffset: 6, count: 1 },
        { startOffset: 20, endOffset: 4, count: 1 },
        { startOffset: 12, endOffset: 20, count: 1 },
        { startOffset: 8, endOffset: 30, count: 0 },
      ],
    },
    sourceMapPayload: syntheticMap('../src/client/ranges.ts', [0, 1]),
    repoRoot: '/repo',
    mapDirectory: '/repo/lib',
    sourceExists: () => true,
  })
  const file = report.files.find(item => item.file === 'src/client/ranges.ts')
  assert.ok(file, 'the range-only entry still maps its source')
  assert.equal(file.executableLines, 2)
  assert.equal(file.executedLines, 1)
  assert.deepEqual(file.coveredLines, [1])
  assert.deepEqual(file.uncoveredLines, [2])
})

test('the innermost range decides whether a line is covered', () => {
  const text = ['outer', 'inner'].join('\n')
  const report = clientCoverageFromEntry({
    entry: {
      url: 'http://127.0.0.1/client.js',
      source: text,
      ranges: [
        { startOffset: 0, endOffset: text.length, count: 1 },
        { startOffset: text.indexOf('inner'), endOffset: text.length, count: 0 },
      ],
    },
    sourceMapPayload: syntheticMap('../src/client/nested.ts', [0, 1]),
    repoRoot: '/repo',
    mapDirectory: '/repo/lib',
    sourceExists: () => true,
  })
  const file = report.files.find(item => item.file === 'src/client/nested.ts')
  assert.ok(file)
  assert.equal(file.lineCoverage, 50)
  assert.deepEqual(file.coveredLines, [1])
  assert.deepEqual(file.uncoveredLines, [2])
})

test('function ranges outside the generated text are ignored', () => {
  const text = 'const x = 1\n'
  const report = clientCoverageFromEntry({
    entry: {
      url: 'http://127.0.0.1/client.js',
      source: text,
      functions: [
        { functionName: 'negative', ranges: [{ startOffset: -8, endOffset: -1, count: 1 }] },
        { functionName: 'past-end', ranges: [{ startOffset: text.length + 3, endOffset: text.length + 8, count: 1 }] },
        { functionName: 'missing-ranges' },
      ],
    },
    sourceMapPayload: syntheticMap('../src/client/functions.ts', [0]),
    repoRoot: '/repo',
    mapDirectory: '/repo/lib',
    sourceExists: () => true,
  })
  const file = report.files.find(item => item.file === 'src/client/functions.ts')
  assert.ok(file)
  assert.equal(file.totalFunctions, 0)
  assert.equal(file.executedLines, 0)
})

test('a function mapped twice stays executed when either range entry executed', () => {
  const text = 'function Demo() { return 1 }\n'
  const report = clientCoverageFromEntry({
    entry: {
      url: 'http://127.0.0.1/client.js',
      source: text,
      functions: [
        { functionName: 'Demo', ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }] },
        { functionName: 'Demo', ranges: [{ startOffset: 0, endOffset: text.length, count: 0 }] },
      ],
    },
    sourceMapPayload: syntheticMap('../src/client/duplicate.ts', [0, 1]),
    repoRoot: '/repo',
    mapDirectory: '/repo/lib',
    sourceExists: () => true,
  })
  const file = report.files.find(item => item.file === 'src/client/duplicate.ts')
  assert.ok(file)
  assert.equal(file.totalFunctions, 1)
  assert.equal(file.executedFunctions, 1)
})

test('coverage phases union so a reload cannot erase earlier execution', () => {
  const text = ['const first = 1', 'function Demo() {', '  return first', '}', ''].join('\n')
  const bodyStart = text.indexOf('  return first')
  const map = syntheticMap('../src/client/phase.tsx', [0, 1, 2, 3, 4])
  // The first document ran only the declarations; the reloaded document ran
  // only the body. A single phase would report one half; the union reports both.
  const beforeReload = {
    url: 'http://127.0.0.1/client.js',
    source: text,
    functions: [{
      functionName: '(top-level)',
      ranges: [
        { startOffset: 0, endOffset: text.length, count: 1 },
        { startOffset: bodyStart, endOffset: text.length, count: 0 },
      ],
    }],
  }
  const afterReload = {
    url: 'http://127.0.0.1/client.js',
    source: text,
    functions: [{
      functionName: '(top-level)',
      ranges: [
        { startOffset: 0, endOffset: text.length, count: 1 },
        { startOffset: 0, endOffset: bodyStart, count: 0 },
      ],
    }],
  }
  const options = {
    sourceMapPayload: map,
    repoRoot: '/repo',
    mapDirectory: '/repo/lib',
    sourceExists: () => true,
  }
  const secondOnly = clientCoverageFromEntry({ ...options, entry: afterReload })
  const secondFile = secondOnly.files.find(file => file.file === 'src/client/phase.tsx')
  assert.ok(secondFile)
  assert.equal(secondFile.executedLines, 2, 'one phase alone cannot see the earlier document')

  const union = clientCoverageFromEntries({ ...options, entries: [beforeReload, afterReload] })
  const file = union.files.find(entry => entry.file === 'src/client/phase.tsx')
  assert.ok(file)
  assert.equal(file.executableLines, 4)
  assert.equal(file.executedLines, 4)
  assert.deepEqual(file.uncoveredLines, [])
  assert.equal(file.executedFunctions, 1)
  assert.deepEqual(coverageGateFailures(union, {
    'src/client/phase.tsx': { lineCoverage: 100, functionCoverage: 100 },
  }), [])
})

/** A page-shaped observer whose main-frame navigations the test controls. */
function fakeNavigator() {
  const main = {}
  const child = {}
  const listeners = []
  const page = {
    mainFrame: () => main,
    on(event, handler) { listeners.push({ event, handler }) },
  }
  const navigate = (frame) => {
    for (const listener of listeners) {
      if (listener.event === 'framenavigated') listener.handler(frame)
    }
  }
  return { page, main, child, navigate }
}

test('the coverage navigation guard rejects every undeclared navigation count', () => {
  const first = fakeNavigator()
  const firstGuard = coverageNavigationGuard(first.page)
  firstGuard.assertFirstEmpty()
  first.navigate(first.main)
  assert.throws(() => firstGuard.assertFirstEmpty(), /phase one recorded 1 navigation/)

  const zero = fakeNavigator()
  const zeroGuard = coverageNavigationGuard(zero.page)
  zeroGuard.enterSecond()
  assert.throws(() => zeroGuard.assertSecondReloadOnly(), /phase two recorded 0 navigation/)

  const two = fakeNavigator()
  const twoGuard = coverageNavigationGuard(two.page)
  twoGuard.enterSecond()
  two.navigate(two.main)
  two.navigate(two.main)
  assert.throws(() => twoGuard.assertSecondReloadOnly(), /phase two recorded 2 navigation/)

  // Exactly one main-frame navigation passes, and a subframe does not count.
  const one = fakeNavigator()
  const oneGuard = coverageNavigationGuard(one.page)
  oneGuard.enterSecond()
  one.navigate(one.child)
  one.navigate(one.main)
  oneGuard.assertSecondReloadOnly()
})

test('an entry with an empty function list needs no range list', () => {
  const text = 'const value = 1\n'
  const report = clientCoverageFromEntry({
    entry: {
      url: 'http://127.0.0.1/client.js',
      source: text,
      functions: [],
    },
    sourceMapPayload: syntheticMap('../src/client/empty-ranges.ts', [0, 1]),
    repoRoot: '/repo',
    mapDirectory: '/repo/lib',
    sourceExists: () => true,
  })
  const file = report.files.find(item => item.file === 'src/client/empty-ranges.ts')
  assert.ok(file)
  assert.equal(file.totalFunctions, 0)
  assert.equal(file.executedLines, 0)
  assert.ok(file.executableLines > 0)
})
