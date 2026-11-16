#!/usr/bin/env node
/**
 * Read, merge, and write LCOV used by the layered coverage gate.
 *
 * Node's test runner emits one LCOV report per process. The unit lane runs every
 * test file in its own process and merges the reports by union: a source line
 * counts as covered when any test process executed it, and the merge result is
 * independent of report order or test scheduling.
 *
 * Only the records the gate needs are modeled: DA lines, BRDA branches, and
 * FN/FNDA functions. Other LCOV fields are ignored, and unknown records are
 * dropped instead of being copied through.
 */

/** A `-` taken count in BRDA means the branch was never reached. */
const NEVER_TAKEN = 0

/** A fresh record accumulator. */
function makeRecord() {
  return { lines: new Map(), branches: new Map(), functions: new Map() }
}

function parseDa(current, _state, line) {
  const [atLine, count] = line.slice(3).split(',')
  const parsedLine = Number.parseInt(atLine, 10)
  const parsedCount = Number.parseInt(count, 10)
  if (!Number.isInteger(parsedLine) || parsedLine < 1 || !Number.isInteger(parsedCount)) {
    throw new Error(`invalid LCOV DA record: ${line}`)
  }
  current.lines.set(parsedLine, Math.max(current.lines.get(parsedLine) ?? 0, parsedCount))
}

function parseBrda(current, _state, line) {
  const [atLine, block, branch, taken] = line.slice(5).split(',')
  const key = `${atLine}:${block}:${branch}`
  const value = taken === '-' ? NEVER_TAKEN : Number.parseInt(taken, 10)
  if (!Number.isFinite(value)) throw new Error(`invalid LCOV BRDA record: ${line}`)
  current.branches.set(key, Math.max(current.branches.get(key) ?? 0, value))
}

function parseFn(current, state, line) {
  const comma = line.indexOf(',', 3)
  if (comma < 0) throw new Error(`invalid LCOV FN record: ${line}`)
  const atLine = Number.parseInt(line.slice(3, comma), 10)
  const name = line.slice(comma + 1)
  if (!Number.isInteger(atLine) || name === '') throw new Error(`invalid LCOV FN record: ${line}`)
  state.functionLineByName.set(name, atLine)
  current.functions.set(`${atLine}:${name}`, 0)
}

function parseFnda(current, state, line) {
  const comma = line.indexOf(',', 5)
  if (comma < 0) throw new Error(`invalid LCOV FNDA record: ${line}`)
  const count = Number.parseInt(line.slice(5, comma), 10)
  const name = line.slice(comma + 1)
  const atLine = state.functionLineByName.get(name)
  if (!Number.isInteger(count) || atLine === undefined) throw new Error(`invalid LCOV FNDA record: ${line}`)
  const key = `${atLine}:${name}`
  current.functions.set(key, Math.max(current.functions.get(key) ?? 0, count))
}

const RECORD_PARSERS = Object.freeze({
  DA: parseDa,
  BRDA: parseBrda,
  FN: parseFn,
  FNDA: parseFnda,
})

/** Apply one non-structural LCOV record; unknown tags are ignored. */
function applyRecord(current, state, line) {
  const tag = line.slice(0, line.indexOf(':'))
  const parser = RECORD_PARSERS[tag]
  if (parser === undefined) return
  parser(current, state, line)
}

/** Start one SF record; a duplicate or empty path fails the report. */
function startRecord(records, line) {
  const file = line.slice(3)
  if (file === '') throw new Error('LCOV record has an empty SF path')
  if (records.has(file)) throw new Error(`LCOV contains duplicate record for ${file}`)
  records.set(file, makeRecord())
  return records.get(file)
}

/**
 * Parse LCOV text into records keyed by source file.
 *
 * @param {string} text LCOV content.
 * @returns {Map<string, {lines: Map<number, number>, branches: Map<string, number>, functions: Map<string, number>}>}
 * @throws {Error} on a duplicate record, an empty path, or a malformed record.
 */
export function parseLcov(text) {
  const records = new Map()
  let current = null
  const state = { functionLineByName: new Map() }
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('TN:')) continue
    if (line.startsWith('SF:')) {
      current = startRecord(records, line)
      state.functionLineByName = new Map()
      continue
    }
    if (line === 'end_of_record') {
      current = null
      continue
    }
    if (current === null) throw new Error(`LCOV record before SF: ${line.slice(0, 40)}`)
    applyRecord(current, state, line)
  }
  return records
}

/** Fold one record into the merged record for the same file. */
function mergeRecordInto(target, record) {
  for (const [line, count] of record.lines) {
    target.lines.set(line, Math.max(target.lines.get(line) ?? 0, count))
  }
  for (const [key, count] of record.branches) {
    target.branches.set(key, Math.max(target.branches.get(key) ?? 0, count))
  }
  for (const [key, count] of record.functions) {
    target.functions.set(key, Math.max(target.functions.get(key) ?? 0, count))
  }
}

/**
 * Merge parsed records by union: max count per line, branch, and function.
 *
 * @param {...Map<string, {lines: Map<number, number>, branches: Map<string, number>, functions: Map<string, number>}>} recordSets
 * @returns {Map<string, {lines: Map<number, number>, branches: Map<string, number>, functions: Map<string, number>}>}
 */
export function mergeLcovRecords(...recordSets) {
  const merged = new Map()
  for (const records of recordSets) {
    for (const [file, record] of records) {
      const target = merged.get(file) ?? makeRecord()
      mergeRecordInto(target, record)
      merged.set(file, target)
    }
  }
  return merged
}

/** Total/covered line counts for one record. */
export function lineTotals(record) {
  let covered = 0
  for (const count of record.lines.values()) if (count > 0) covered += 1
  return { total: record.lines.size, covered }
}

/** Total/covered branch counts for one record. */
export function branchTotals(record) {
  let covered = 0
  for (const count of record.branches.values()) if (count > 0) covered += 1
  return { total: record.branches.size, covered }
}

/** Total/covered function counts for one record. */
export function functionTotals(record) {
  let covered = 0
  for (const count of record.functions.values()) if (count > 0) covered += 1
  return { total: record.functions.size, covered }
}

/** Aggregate the same totals across every record. */
export function totalsOf(records) {
  const aggregate = {
    lines: { total: 0, covered: 0 },
    branches: { total: 0, covered: 0 },
    functions: { total: 0, covered: 0 },
  }
  for (const record of records.values()) {
    for (const [key, total] of [['lines', lineTotals], ['branches', branchTotals], ['functions', functionTotals]]) {
      const value = total(record)
      aggregate[key].total += value.total
      aggregate[key].covered += value.covered
    }
  }
  return aggregate
}

/** Uncovered DA lines for one record, sorted. */
export function uncoveredLines(record) {
  const lines = []
  for (const [line, count] of record.lines) if (count === 0) lines.push(line)
  return lines.sort((left, right) => left - right)
}

/** Render merged records as deterministic LCOV text. */
export function renderLcov(records) {
  const chunks = ['TN:']
  for (const file of [...records.keys()].sort()) {
    const record = records.get(file)
    chunks.push(`SF:${file}`)
    const functionKeys = [...record.functions.keys()].sort(functionKeyOrder)
    for (const key of functionKeys) {
      const comma = key.indexOf(':')
      chunks.push(`FN:${key.slice(0, comma)},${key.slice(comma + 1)}`)
    }
    for (const key of functionKeys) {
      chunks.push(`FNDA:${record.functions.get(key)},${key.slice(key.indexOf(':') + 1)}`)
    }
    const functions = functionTotals(record)
    chunks.push(`FNF:${functions.total}`)
    chunks.push(`FNH:${functions.covered}`)
    for (const key of [...record.branches.keys()].sort(branchKeyOrder)) {
      chunks.push(`BRDA:${key.replaceAll(':', ',')},${record.branches.get(key)}`)
    }
    const branches = branchTotals(record)
    chunks.push(`BRF:${branches.total}`)
    chunks.push(`BRH:${branches.covered}`)
    for (const line of [...record.lines.keys()].sort((left, right) => left - right)) {
      chunks.push(`DA:${line},${record.lines.get(line)}`)
    }
    const lines = lineTotals(record)
    chunks.push(`LF:${lines.total}`)
    chunks.push(`LH:${lines.covered}`)
    chunks.push('end_of_record')
  }
  return `${chunks.join('\n')}\n`
}

function functionKeyOrder(left, right) {
  const leftLine = Number.parseInt(left, 10)
  const rightLine = Number.parseInt(right, 10)
  return leftLine === rightLine ? left.localeCompare(right) : leftLine - rightLine
}

function branchKeyOrder(left, right) {
  const [leftLine, leftBlock, leftBranch] = left.split(':').map(Number)
  const [rightLine, rightBlock, rightBranch] = right.split(':').map(Number)
  if (leftLine !== rightLine) return leftLine - rightLine
  if (leftBlock !== rightBlock) return leftBlock - rightBlock
  return leftBranch - rightBranch
}
