#!/usr/bin/env node
/**
 * Map Chromium V8 coverage for the built client bundle back to client sources.
 *
 * The browser lane owns TSX coverage; Node `test:coverage` keeps ownership of
 * the client TypeScript modules. This module is deliberately independent of Playwright
 * and the repository build so its mapping and gate can be exercised with a
 * synthetic bundle in the ordinary Node test lane.
 *
 * Coverage is line/function only. V8 precise ranges are not a branch metric;
 * manufacturing one would make the report look stricter than it is.
 */
import { existsSync } from 'node:fs'
import { SourceMap } from 'node:module'
import { extname, relative, resolve, sep } from 'node:path'

/** Files whose browser execution is blocked by a known host capability. */
export const CLIENT_BROWSER_BLOCKED = Object.freeze({
  'src/client/notice.tsx': Object.freeze({
    reason: 'the running DSH host has no ctx.sessionNotices (KI-40)',
    issue: 'KI-40',
    retireWhen: 'the host exposes ctx.sessionNotices and notice.tsx is counted',
  }),
})

/** The TSX files a complete browser report must contain. */
export const CLIENT_BROWSER_TSX = Object.freeze([
  'src/client/index.tsx',
  'src/client/panel.tsx',
  'src/client/list.tsx',
  'src/client/inbox.tsx',
  'src/client/notice.tsx',
  'src/client/work-item/editor.tsx',
  'src/client/work-item/list.tsx',
  'src/client/work-item/panel.tsx',
])

/** The client source extensions this lane reports. */
export const CLIENT_SOURCE_EXTENSIONS = Object.freeze(['.ts', '.tsx'])

/** Convert a repository path to the POSIX spelling used by reports and gates. */
export function repoRelative(repoRoot, absolutePath) {
  return relative(repoRoot, absolutePath).split(sep).join('/')
}

/**
 * Normalize one source-map source to a client repository path.
 *
 * Standalone maps use relative paths such as `../src/client/panel.tsx`. Combo
 * maps served by the host relocate those paths under the plugin package URL,
 * so a package prefix is the only reliable way to distinguish this plugin from
 * another client package with the same `src/client` suffix.
 */
export function clientSourceFile(
  source,
  repoRoot,
  mapDirectory = resolve(repoRoot, 'lib'),
  sourceExists = existsSync,
  options = {},
) {
  if (typeof source !== 'string') return null
  const qualified = /\/plugins\/@dsh-external\/dsh-cowork\/(src\/client\/[^?#]+)/.exec(source)
  if (qualified !== null) {
    return sourceExists(resolve(repoRoot, qualified[1])) ? qualified[1] : null
  }
  if (options.allowUnqualifiedPackage === true) {
    // The host relocates this plugin's authored map under @dsh-external/ and
    // drops the package segment. A combo section index, not the path, binds it.
    const unqualified = /\/plugins\/@dsh-external\/(src\/client\/[^?#]+)/.exec(source)
    if (unqualified !== null) {
      return sourceExists(resolve(repoRoot, unqualified[1])) ? unqualified[1] : null
    }
  }
  if (source.startsWith('/plugins/') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(source)) return null
  const file = repoRelative(repoRoot, resolve(mapDirectory, source))
  return file.startsWith('src/client/') && sourceExists(resolve(repoRoot, file)) ? file : null
}

/** Resolve this plugin's index in a combo URL such as `/plugins/??a,b`. */
export function comboSectionIndex(entryUrl) {
  if (typeof entryUrl !== 'string') return null
  const combo = entryUrl.split('/??')[1]
  if (typeof combo !== 'string' || combo === '') return null
  const packages = combo.split(',').map(part => decodeURIComponent(part.split('/client.js', 1)[0]))
  const index = packages.indexOf('@dsh-external/dsh-cowork')
  return index < 0 ? null : index
}

/**
 * Flatten regular and indexed source-map sources.
 *
 * When `sectionIndex` is supplied, only that combo section is returned. The
 * browser lane uses this to bind relocated `@dsh-external/src/client` paths to
 * the package entry that produced them instead of trusting the path alone.
 */
export function flattenSourceMapSources(payload, sectionIndex = null) {
  const sources = []
  const visit = (map) => {
    if (Array.isArray(map?.sections)) {
      for (const section of map.sections) {
        if (section !== null && typeof section === 'object' && section.map !== undefined) visit(section.map)
      }
      return
    }
    if (!Array.isArray(map?.sources)) return
    map.sources.forEach((source, index) => {
      if (typeof source === 'string') {
        sources.push({ source, content: map.sourcesContent?.[index] ?? '' })
      }
    })
  }
  if (sectionIndex !== null) {
    const section = payload?.sections?.[sectionIndex]
    if (section === undefined || section.map === undefined) return []
    visit(section.map)
    return sources
  }
  visit(payload)
  return sources
}

/** The generated line range owned by one combo source-map section. */
export function comboGeneratedRange(payload, sectionIndex) {
  const sections = payload?.sections
  if (!Array.isArray(sections) || !Number.isInteger(sectionIndex)) return null
  const start = sections[sectionIndex]?.offset?.line
  if (!Number.isInteger(start)) return null
  const next = sections[sectionIndex + 1]?.offset?.line
  return { start, end: Number.isInteger(next) ? next : Number.POSITIVE_INFINITY }
}

/** Build offset -> 0-based generated line/column arrays for a bundle string. */
export function positionsOf(text) {
  const lineAt = new Uint32Array(text.length)
  const columnAt = new Uint32Array(text.length)
  let line = 0
  let column = 0
  for (let offset = 0; offset < text.length; offset += 1) {
    lineAt[offset] = line
    columnAt[offset] = column
    if (text.charCodeAt(offset) === 10) {
      line += 1
      column = 0
    } else {
      column += 1
    }
  }
  return { lineAt, columnAt }
}

function indexClientSources({ sourceMapPayload, repoRoot, mapDirectory, sourceExists, sectionIndex }) {
  const sourceByFile = new Map()
  flattenSourceMapSources(sourceMapPayload, sectionIndex).forEach(({ source, content }) => {
    const file = clientSourceFile(source, repoRoot, mapDirectory, sourceExists, {
      allowUnqualifiedPackage: sectionIndex !== null,
    })
    if (file === null) return
    if (!CLIENT_SOURCE_EXTENSIONS.includes(extname(file))) return
    sourceByFile.set(source, {
      file,
      content,
      lineCount: content === '' ? null : content.split('\n').length,
      executableLines: new Set(),
      executedLines: new Set(),
      functions: new Map(),
    })
  })
  return sourceByFile
}

/** The offsets a Playwright or V8 range may expose under either spelling. */
function rangeOffsets(range) {
  return { start: range.start ?? range.startOffset, end: range.end ?? range.endOffset }
}

/** A usable range has integer offsets in ascending order. */
function validOffsets(start, end) {
  return Number.isInteger(start) && Number.isInteger(end) && end > start
}

function clampOffset(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

/**
 * Clamp one range to the generated source, or null when it covers no byte.
 *
 * Playwright can report offsets past the script or a zero-length range; both
 * are ignored instead of shrinking to an artificial covered line.
 */
function rangeBounds(range, sourceLength) {
  const { start: rawStart, end: rawEnd } = rangeOffsets(range)
  if (!validOffsets(rawStart, rawEnd)) return null
  const start = clampOffset(rawStart, 0, sourceLength)
  const end = clampOffset(rawEnd, start, sourceLength)
  return end <= start ? null : { start, end, count: range.count }
}

function appendRange(index, key, range) {
  const list = index.get(key)
  if (list === undefined) index.set(key, [range])
  else list.push(range)
}

function buildRangeIndex(ranges, sourceText) {
  const starts = new Map()
  const ends = new Map()
  for (const range of ranges) {
    const normalized = rangeBounds(range, sourceText.length)
    if (normalized === null) continue
    appendRange(starts, normalized.start, normalized)
    appendRange(ends, normalized.end, normalized)
  }
  return { starts, ends }
}

function removeEnding(active, ending) {
  for (const range of ending) {
    const index = active.indexOf(range)
    if (index >= 0) active.splice(index, 1)
  }
}

function addStarting(active, starting) {
  for (const range of starting) active.push(range)
}

function containsOffset(range, offset) {
  return range.start <= offset && offset < range.end
}

/** The innermost active range wins; an outer range never covers its children. */
function narrowerThan(range, other) {
  return other === null || range.end - range.start < other.end - other.start
}

function innermostRange(active, offset) {
  let innermost = null
  for (const range of active) {
    if (containsOffset(range, offset) && narrowerThan(range, innermost)) innermost = range
  }
  return innermost
}

function advanceActive(active, starts, ends, offset) {
  removeEnding(active, ends.get(offset) ?? [])
  addStarting(active, starts.get(offset) ?? [])
}

function buildCoverageMask(sourceText, starts, ends) {
  const active = []
  const covered = new Uint8Array(sourceText.length)
  for (let offset = 0; offset < sourceText.length; offset += 1) {
    advanceActive(active, starts, ends, offset)
    const innermost = innermostRange(active, offset)
    if (innermost !== null && innermost.count > 0) covered[offset] = 1
  }
  return covered
}

function insideGeneratedRange(line, generatedRange) {
  return generatedRange === null || (line >= generatedRange.start && line < generatedRange.end)
}

/** A mapped line must exist in the authored source; maps can point past the last newline. */
function withinSource(source, line) {
  return source.lineCount === null || (line >= 1 && line <= source.lineCount)
}

/** Resolve one origin to a mapped source entry, or null when it is unusable. */
function sourceForOrigin(origin, sourceByFile) {
  if (typeof origin.fileName !== 'string' || typeof origin.lineNumber !== 'number') return null
  const source = sourceByFile.get(origin.fileName)
  if (source === undefined || !withinSource(source, origin.lineNumber)) return null
  return source
}

function mapLineCoverage({ sourceText, lineAt, columnAt, sourceMap, sourceByFile, covered, generatedRange }) {
  for (let offset = 0; offset < sourceText.length; offset += 1) {
    if (!insideGeneratedRange(lineAt[offset], generatedRange)) continue
    const origin = sourceMap.findOrigin(lineAt[offset] + 1, columnAt[offset] + 1)
    const source = sourceForOrigin(origin, sourceByFile)
    if (source === null) continue
    source.executableLines.add(origin.lineNumber)
    if (covered[offset] === 1) source.executedLines.add(origin.lineNumber)
  }
}

/** The first range of one Playwright function, or undefined when it has none. */
function firstRange(ranges) {
  return Array.isArray(ranges) ? ranges[0] : undefined
}

function rangeStart(range) {
  return range?.start ?? range?.startOffset
}

function validFunctionStart(start, sourceLength) {
  return Number.isInteger(start) && start >= 0 && start < sourceLength
}

function executedFunction(fn) {
  return (fn.ranges ?? []).some(range => range.count > 0)
}

/**
 * Resolve one function to its mapped source and origin.
 *
 * A function is mapped only when its first range starts inside the generated
 * text and that generated line belongs to this combo section.
 */
function locatedFunction(fn, context) {
  const start = rangeStart(firstRange(fn.ranges))
  if (!validFunctionStart(start, context.sourceText.length)) return null
  if (!insideGeneratedRange(context.lineAt[start], context.generatedRange)) return null
  const origin = context.sourceMap.findOrigin(context.lineAt[start] + 1, context.columnAt[start] + 1)
  const source = sourceForOrigin(origin, context.sourceByFile)
  return source === null ? null : { origin, source }
}

function recordFunction(fn, located) {
  const { origin, source } = located
  const key = `${origin.lineNumber}:${origin.columnNumber ?? 0}:${fn.functionName || 'anonymous'}`
  const previous = source.functions.get(key)
  source.functions.set(key, Boolean(previous) || executedFunction(fn))
}

function mapFunctionCoverage({ functions, sourceText, lineAt, columnAt, sourceMap, sourceByFile, generatedRange }) {
  const context = { sourceText, lineAt, columnAt, sourceMap, sourceByFile, generatedRange }
  for (const fn of functions) {
    const located = locatedFunction(fn, context)
    if (located !== null) recordFunction(fn, located)
  }
}

function coverageFiles(sourceByFile) {
  return [...sourceByFile.values()]
    .map((source) => {
      const totalFunctions = source.functions.size
      const executedFunctions = [...source.functions.values()].filter(Boolean).length
      const blocked = CLIENT_BROWSER_BLOCKED[source.file] ?? null
      return {
        file: source.file,
        owner: extname(source.file) === '.tsx' ? 'browser' : 'node',
        status: blocked === null ? 'counted' : 'blocked',
        ...(blocked === null ? {} : { blockedReason: blocked.reason }),
        executableLines: source.executableLines.size,
        executedLines: source.executedLines.size,
        coveredLines: [...source.executedLines].sort((left, right) => left - right),
        lineCoverage: source.executableLines.size === 0
          ? 0
          : Number(((source.executedLines.size / source.executableLines.size) * 100).toFixed(2)),
        totalFunctions,
        executedFunctions,
        functionCoverage: totalFunctions === 0
          ? 100
          : Number(((executedFunctions / totalFunctions) * 100).toFixed(2)),
        uncoveredLines: [...source.executableLines].filter(line => !source.executedLines.has(line)).sort((a, b) => a - b),
        sourceLines: source.content === '' ? 0 : source.content.split('\n').length,
      }
    })
    .sort((left, right) => left.file.localeCompare(right.file))
}

function entryFunctions(entry) {
  return Array.isArray(entry.functions) ? entry.functions : []
}

/** The entry text; an entry needs either function ranges or a plain range list. */
function entrySourceText(entry) {
  const sourceText = entry?.source ?? entry?.text
  if (typeof sourceText !== 'string') throw new Error('client coverage entry needs source and function ranges')
  if (!Array.isArray(entry.functions) && !Array.isArray(entry.ranges)) {
    throw new Error('client coverage entry needs source and function ranges')
  }
  return sourceText
}

/** The ranges a phase reports: function ranges, or a plain range list as fallback. */
function entryRanges(entry, functions) {
  if (functions.length === 0) return entry.ranges ?? []
  return functions.flatMap(fn => fn.ranges ?? [])
}

/**
 * Fold one JSCoverage entry into the shared per-source sets.
 *
 * Playwright returns `source` and a per-function range tree. A position is
 * covered only when its innermost range has a positive count; treating the
 * top-level count as universal would mark uncalled functions as covered.
 * Every entry contributes to the same sets, so separate collection phases
 * union instead of replacing each other.
 */
function accumulateEntry({ entry, sourceMap, generatedRange, sourceByFile }) {
  const sourceText = entrySourceText(entry)
  const functions = entryFunctions(entry)
  const { lineAt, columnAt } = positionsOf(sourceText)
  const { starts, ends } = buildRangeIndex(entryRanges(entry, functions), sourceText)
  const covered = buildCoverageMask(sourceText, starts, ends)
  mapLineCoverage({ sourceText, lineAt, columnAt, sourceMap, sourceByFile, covered, generatedRange })
  mapFunctionCoverage({ functions, sourceText, lineAt, columnAt, sourceMap, sourceByFile, generatedRange })
  return sourceText.length
}

/**
 * Map several JSCoverage entries for one bundle into one report.
 *
 * Coverage phases exist because Chromium's `Profiler.takePreciseCoverage` only
 * reports scripts that are still alive: a page reload before `stopJSCoverage`
 * drops everything the previous document executed. The lane collects one entry
 * set per phase and this function unions their line/function verdicts, so the
 * report describes what the whole run executed instead of only the last phase.
 *
 * @param {object} input
 * @param {Array<object>} input.entries Playwright JSCoverage entries from every phase.
 * @param {object} input.sourceMapPayload Parsed combo source map served to the page.
 * @param {string} input.repoRoot Repository root used for source paths.
 * @param {string} [input.mapDirectory] Directory the authored source map lives in.
 * @param {(path: string) => boolean} [input.sourceExists] File-existence check for mapped sources.
 * @param {number|null} [input.sectionIndex] Combo source-map section owned by these entries.
 * @returns {{generatedLength: number, files: Array<object>}}
 */
export function clientCoverageFromEntries({
  entries,
  sourceMapPayload,
  repoRoot,
  mapDirectory = resolve(repoRoot, 'lib'),
  sourceExists = existsSync,
  sectionIndex = null,
}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('client coverage needs at least one entry')
  }
  const sourceMap = new SourceMap(sourceMapPayload)
  const generatedRange = comboGeneratedRange(sourceMapPayload, sectionIndex)
  const sourceByFile = indexClientSources({ sourceMapPayload, repoRoot, mapDirectory, sourceExists, sectionIndex })
  let generatedLength = 0
  for (const entry of entries) {
    generatedLength = Math.max(generatedLength, accumulateEntry({ entry, sourceMap, generatedRange, sourceByFile }))
  }
  return { generatedLength, files: coverageFiles(sourceByFile) }
}

/**
 * Map one Playwright JSCoverage entry through a v3 source map.
 *
 * @param {object} input
 * @param {object} input.entry One Playwright JSCoverage entry.
 * @param {object} input.sourceMapPayload Parsed `lib/client.js.map`.
 * @param {string} input.repoRoot Repository root used for source paths.
 * @param {string} [input.mapDirectory] Directory the source map lives in.
 * @param {(path: string) => boolean} [input.sourceExists] File-existence check for mapped sources.
 * @param {number|null} [input.sectionIndex] Combo source-map section owned by this entry.
 * @returns {{generatedLength: number, files: Array<object>}}
 */
export function clientCoverageFromEntry(options) {
  return clientCoverageFromEntries({ ...options, entries: [options.entry] })
}

/**
 * Every JSCoverage entry that contains this plugin's client bundle.
 *
 * The bundle is served once per document, so one coverage phase may hold one
 * entry and a second phase another. Mapping must see only these entries: other
 * page scripts would be resolved against a combo map they do not belong to.
 */
export function pluginBundleEntries(entries) {
  return entries.filter(entry => {
    const source = entry.source ?? entry.text ?? ''
    return source.includes('window.__ModuleLoader__.load')
      && source.includes('@dsh-external/dsh-cowork')
  })
}

/** Pick the first entry that contains this plugin's client bundle. */
export function pluginBundleEntry(entries) {
  return pluginBundleEntries(entries)[0] ?? null
}

/**
 * Count main-frame navigations per coverage phase.
 *
 * A reload before `stopJSCoverage` drops everything the previous document
 * executed, so each phase may contain exactly the navigations it declares.
 * A scenario that navigates outside its declared phase would silently shrink
 * the measured surface; failing here forces it into a declared phase instead.
 *
 * @param {{on: (event: string, handler: (frame: object) => void) => void, mainFrame: () => object}} page Playwright page, or an equivalent observer.
 * @returns {{enterSecond: () => void, assertFirstEmpty: () => void, assertSecondReloadOnly: () => void}}
 */
export function coverageNavigationGuard(page) {
  const counts = { first: 0, second: 0 }
  let phase = 'first'
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) counts[phase] += 1
  })
  return {
    enterSecond() { phase = 'second' },
    assertFirstEmpty() {
      if (counts.first > 0) {
        throw new Error(`browser coverage phase one recorded ${counts.first} navigation(s); a reload there discards earlier coverage, so move that scenario to the second phase`)
      }
    },
    assertSecondReloadOnly() {
      if (counts.second !== 1) {
        throw new Error(`browser coverage phase two recorded ${counts.second} navigation(s); exactly the single reload is allowed, and a second one needs its own coverage phase`)
      }
    },
  }
}

/** The host-generated indexed source map URL for one combo entry. */
export function comboSourceMapUrl(entryUrl) {
  return entryUrl.replaceAll('/client.js', '/client.js.map')
}

/**
 * Failures for a report that is missing an expected TSX surface or a duplicate.
 *
 * Presence is separate from a reviewed coverage floor: the browser lane first
 * has to prove it mapped the whole reachable client surface. `notice.tsx` must
 * be present as blocked until KI-40 is retired.
 *
 * @param {{files?: Array<{file: string, status: string, blockedReason?: string, executableLines?: number}>}} report
 * @param {readonly string[]} [expected]
 * @returns {string[]}
 */
function indexReportFiles(files) {
  const byFile = new Map()
  const failures = []
  for (const entry of files) {
    if (typeof entry?.file !== 'string') {
      failures.push('coverage report contains an entry without a file')
      continue
    }
    if (byFile.has(entry.file)) failures.push(`${entry.file}: duplicate entry in browser coverage report`)
    else byFile.set(entry.file, entry)
  }
  return { byFile, failures }
}

function expectedFileFailure(file, entry) {
  if (entry === undefined) return [`${file}: missing from browser coverage report`]
  const blocked = CLIENT_BROWSER_BLOCKED[file]
  if (blocked !== undefined) {
    if (entry.status !== 'blocked') return [`${file}: expected blocked, got ${entry.status}`]
    if (typeof entry.blockedReason !== 'string' || entry.blockedReason.trim() === '') {
      return [`${file}: blocked entry needs a reason`]
    }
    return []
  }
  if (entry.status !== 'counted') return [`${file}: expected counted, got ${entry.status}`]
  if (!Number.isInteger(entry.executableLines) || entry.executableLines <= 0) {
    return [`${file}: no executable lines mapped`]
  }
  return []
}

export function coverageCompletenessFailures(report, expected = CLIENT_BROWSER_TSX) {
  const files = Array.isArray(report?.files) ? report.files : []
  const { byFile, failures } = indexReportFiles(files)
  for (const file of expected) failures.push(...expectedFileFailure(file, byFile.get(file)))
  return failures
}

/**
 * Render the mapped browser report as LCOV so the layered gate consumes one
 * report format for both lanes. Blocked files stay in the report with their
 * mapped line counts; the checker skips them by status.
 *
 * @param {object} report `coverage/client.json` content.
 * @returns {string} LCOV text.
 */
export function clientCoverageLcov(report) {
  const chunks = ['TN:']
  for (const file of report?.files ?? []) {
    chunks.push(`SF:${file.file}`)
    const covered = new Set(file.coveredLines ?? [])
    const lines = [...new Set([...covered, ...(file.uncoveredLines ?? [])])].sort((left, right) => left - right)
    for (const line of lines) chunks.push(`DA:${line},${covered.has(line) ? 1 : 0}`)
    chunks.push(`LF:${lines.length}`)
    chunks.push(`LH:${covered.size}`)
    chunks.push('end_of_record')
  }
  return `${chunks.join('\n')}\n`
}

/** Per-file failures for a set of reviewed floors. Blocked files are skipped. */
export function coverageGateFailures(report, floors = {}) {
  const byFile = new Map((report?.files ?? []).map(file => [file.file, file]))
  const failures = []
  for (const [file, floor] of Object.entries(floors)) {
    const entry = byFile.get(file)
    if (entry === undefined) {
      failures.push(`${file}: missing from browser coverage report`)
      continue
    }
    if (entry.status === 'blocked') continue
    if (typeof floor.lineCoverage === 'number' && entry.lineCoverage < floor.lineCoverage) {
      failures.push(`${file}: line ${entry.lineCoverage}% < ${floor.lineCoverage}%`)
    }
    if (typeof floor.functionCoverage === 'number' && entry.functionCoverage < floor.functionCoverage) {
      failures.push(`${file}: function ${entry.functionCoverage}% < ${floor.functionCoverage}%`)
    }
  }
  return failures
}
