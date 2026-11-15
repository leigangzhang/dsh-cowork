import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  CLIENT_BROWSER_BLOCKED,
  CLIENT_BROWSER_TSX,
  clientCoverageFromEntry,
  clientSourceFile,
  coverageCompletenessFailures,
  coverageGateFailures,
  flattenSourceMapSources,
  pluginBundleEntry,
} from '../../scripts/evidence/client-coverage.mjs'

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
    'src/client/panel.tsx',
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
