/**
 * Line-level three-way merge for work-item text saves.
 *
 * The browser sends the content it edited; the host still holds the current
 * file and the revision the browser had loaded. Both sides are diffed against
 * that base revision. Non-overlapping line changes merge into one result; an
 * actual overlap is reported as a conflict range so the browser can show the
 * conflict UI instead of silently overwriting the other writer.
 *
 * Diffs are Myers line diffs with a bounded edit distance. A rewrite larger
 * than the bound is treated as one conflict: the merge cannot prove the two
 * writers touched different lines, and guessing would be worse than asking.
 */
import type { ArtifactConflictRange } from '../../panel/artifact-contract.js'

/** The largest edit distance the merge will compute. */
export const MERGE_MAX_EDITS = 2000

/** One single-side change: replace base lines `[baseStart, baseEnd)` with `lines`. */
export interface MergeHunk {
  readonly baseStart: number
  readonly baseEnd: number
  readonly lines: readonly string[]
}

/** Result of a merge attempt. */
export type MergeResult =
  | { readonly ok: true; readonly content: string; readonly lines: string[] }
  | { readonly ok: false; readonly conflictRanges: readonly ArtifactConflictRange[] }

/** Split text for line merging; `join('\n')` restores the exact text. */
export function splitLines(content: string): string[] {
  return content.split('\n')
}

/** Join merged lines back into text. */
export function joinLines(lines: readonly string[]): string {
  return lines.join('\n')
}

/** Values of the edit script. */
type EditOp = 'equal' | 'delete' | 'insert'

/**
 * Myers line diff of `base` to `side`, as hunks of base ranges.
 *
 * Returns null when the edit distance exceeds {@link MERGE_MAX_EDITS}; the
 * caller then reports a conflict rather than a partial guess.
 */
export function diffHunks(
  base: readonly string[],
  side: readonly string[],
  maxEdits: number = MERGE_MAX_EDITS,
): MergeHunk[] | null {
  const n = base.length
  const m = side.length
  const maxD = Math.min(maxEdits, n + m)
  const offset = maxD
  const trace: number[][] = []
  let found = -1
  let v = new Int32Array(2 * maxD + 1)
  for (let d = 0; d <= maxD; d += 1) {
    trace.push([...v])
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset]
      } else {
        x = v[k - 1 + offset] + 1
      }
      let y = x - k
      while (x < n && y < m && base[x] === side[y]) {
        x += 1
        y += 1
      }
      v[k + offset] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    if (found !== -1) break
  }
  if (found === -1) return null

  // Backtrack the trace into an ordered edit script.
  const ops: EditOp[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d -= 1) {
    const previous = trace[d]
    const k = x - y
    let previousK: number
    if (k === -d || (k !== d && previous[k - 1 + offset] < previous[k + 1 + offset])) {
      previousK = k + 1
    } else {
      previousK = k - 1
    }
    const previousX = previous[previousK + offset]
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) {
      ops.push('equal')
      x -= 1
      y -= 1
    }
    if (x === previousX) {
      ops.push('insert')
      y -= 1
    } else {
      ops.push('delete')
      x -= 1
    }
    x = previousX
    y = previousY
  }
  // The common prefix before the first recorded edit is still unwalked.
  while (x > 0 && y > 0) {
    ops.push('equal')
    x -= 1
    y -= 1
  }
  ops.reverse()

  // Fold the script into hunks: one replacement per changed base span.
  const hunks: MergeHunk[] = []
  let baseIndex = 0
  let pendingStart = -1
  let pendingLines: string[] = []
  const flush = (): void => {
    if (pendingStart === -1) return
    hunks.push({ baseStart: pendingStart, baseEnd: baseIndex, lines: pendingLines })
    pendingStart = -1
    pendingLines = []
  }
  let sideIndex = 0
  for (const op of ops) {
    if (op === 'equal') {
      flush()
      baseIndex += 1
      sideIndex += 1
      continue
    }
    if (pendingStart === -1) pendingStart = baseIndex
    if (op === 'delete') {
      baseIndex += 1
    } else {
      pendingLines = [...pendingLines, side[sideIndex]]
      sideIndex += 1
    }
  }
  flush()
  return hunks
}

/** Whether one hunk and one base span share a changed line (inclusive rules). */
function overlaps(left: MergeHunk, right: MergeHunk): boolean {
  const leftEmpty = left.baseStart === left.baseEnd
  const rightEmpty = right.baseStart === right.baseEnd
  if (leftEmpty && rightEmpty) return left.baseStart === right.baseStart
  if (leftEmpty) return right.baseStart < left.baseStart && left.baseStart < right.baseEnd
  if (rightEmpty) return left.baseStart < right.baseStart && right.baseStart < left.baseEnd
  return left.baseStart < right.baseEnd && right.baseStart < left.baseEnd
}

/** Two hunks are the same edit when their base span and replacement agree. */
function sameHunk(left: MergeHunk, right: MergeHunk): boolean {
  if (left.baseStart !== right.baseStart || left.baseEnd !== right.baseEnd) return false
  return left.lines.length === right.lines.length
    && left.lines.every((line, index) => line === right.lines[index])
}

/** Map one base span to the line range the merge result currently shows. */
function conflictRangeOf(hunk: MergeHunk, baseLine: number, resultLine: number): ArtifactConflictRange {
  if (hunk.baseStart === hunk.baseEnd) {
    return { startLine: resultLine + 1, endLine: resultLine + 1 }
  }
  const startLine = resultLine + 1 + Math.max(0, hunk.baseStart - baseLine)
  return { startLine, endLine: startLine + Math.max(0, hunk.baseEnd - hunk.baseStart - 1) }
}

/**
 * Three-way merge of `base` → `current` (the file on disk) and `base` → `mine`
 * (the browser's content).
 */
export function mergeText(input: {
  readonly base: string
  readonly current: string
  readonly mine: string
  readonly maxEdits?: number
}): MergeResult {
  const base = splitLines(input.base)
  const current = splitLines(input.current)
  const mine = splitLines(input.mine)
  if (input.current === input.mine) return { ok: true, content: input.current, lines: current }
  if (input.base === input.current) return { ok: true, content: input.mine, lines: mine }
  if (input.base === input.mine) return { ok: true, content: input.current, lines: current }
  const left = diffHunks(base, current, input.maxEdits)
  const right = diffHunks(base, mine, input.maxEdits)
  if (left === null || right === null) {
    const displayLines = current.length > 1 && current[current.length - 1] === ''
      ? current.length - 1
      : current.length
    return {
      ok: false,
      conflictRanges: [{ startLine: 1, endLine: Math.max(1, displayLines) }],
    }
  }

  // Merge strictly in base order. Equal hunks from both sides collapse to one.
  const result: string[] = []
  const conflicts: ArtifactConflictRange[] = []
  let baseIndex = 0
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length || rightIndex < right.length) {
    const nextLeft = leftIndex < left.length ? left[leftIndex] : null
    const nextRight = rightIndex < right.length ? right[rightIndex] : null
    if (nextLeft !== null && nextRight !== null) {
      if (sameHunk(nextLeft, nextRight)) {
        for (; baseIndex < nextLeft.baseStart; baseIndex += 1) result.push(base[baseIndex])
        result.push(...nextLeft.lines)
        baseIndex = nextLeft.baseEnd
        leftIndex += 1
        rightIndex += 1
        continue
      }
      if (overlaps(nextLeft, nextRight)) {
        for (; baseIndex < nextLeft.baseStart; baseIndex += 1) result.push(base[baseIndex])
        conflicts.push(conflictRangeOf(nextRight, baseIndex, result.length))
        // A conflict aborts the save; the caller returns the ranges without
        // publishing anything, so the rest of the walk is unnecessary.
        return { ok: false, conflictRanges: conflicts }
      }
      const leftFirst = nextLeft.baseStart < nextRight.baseStart
        || (nextLeft.baseStart === nextRight.baseStart
          && nextLeft.baseEnd === nextLeft.baseStart
          && nextRight.baseEnd !== nextRight.baseStart)
      if (leftFirst) {
        for (; baseIndex < nextLeft.baseStart; baseIndex += 1) result.push(base[baseIndex])
        result.push(...nextLeft.lines)
        baseIndex = nextLeft.baseEnd
        leftIndex += 1
      } else {
        for (; baseIndex < nextRight.baseStart; baseIndex += 1) result.push(base[baseIndex])
        result.push(...nextRight.lines)
        baseIndex = nextRight.baseEnd
        rightIndex += 1
      }
      continue
    }
    const hunk = (nextLeft ?? nextRight) as MergeHunk
    for (; baseIndex < hunk.baseStart; baseIndex += 1) result.push(base[baseIndex])
    result.push(...hunk.lines)
    baseIndex = hunk.baseEnd
    if (nextLeft !== null) leftIndex += 1
    else rightIndex += 1
  }
  for (; baseIndex < base.length; baseIndex += 1) result.push(base[baseIndex])
  return { ok: true, content: joinLines(result), lines: result }
}
