/**
 * Editing presence: which lines a browser user is editing right now, and the
 * tool guard that refuses a model write overlapping them.
 *
 * Reports expire after {@link ARTIFACT_PRESENCE_TTL_MS}, so a closed tab stops
 * blocking model writes without a cleanup call. Keys are absolute paths: the
 * guard sees the tool's own `cwd` and relative argument, while the browser
 * reports a project-relative path; the route joins them against the same
 * project root, so both spellings meet on one absolute path without a store
 * scan on every tool call.
 *
 * The text cache is best-effort: the file route fills it when it reads a file.
 * Without it the guard refuses an `edit` on a file with active ranges instead
 * of guessing where `old_string` lands (design: conservative deny).
 */
import { isAbsolute, resolve } from 'node:path'
import {
  ARTIFACT_PRESENCE_TTL_MS,
  type ArtifactConflictRange,
} from '../panel/artifact-contract.js'

/** One line range the user is editing; 1-based and inclusive. */
export interface PresenceRange {
  readonly startLine: number
  readonly endLine: number
}

/** One report plus its expiry. */
interface PresenceEntry {
  readonly ranges: readonly PresenceRange[]
  readonly expiresAt: number
  readonly text: string | null
}

/** In-memory presence registry; never persisted. */
export class ArtifactPresenceRegistry {
  private readonly entries = new Map<string, PresenceEntry>()
  private readonly ttlMs: number
  private readonly clock: () => number

  constructor(options: { ttlMs?: number; clock?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? ARTIFACT_PRESENCE_TTL_MS
    this.clock = options.clock ?? (() => Date.now())
  }

  /** Record the ranges one file has active; a later report replaces them. */
  report(absolutePath: string, ranges: readonly PresenceRange[], text?: string): number {
    const now = this.clock()
    this.entries.set(absolutePath, {
      ranges,
      expiresAt: now + this.ttlMs,
      text: text ?? this.entries.get(absolutePath)?.text ?? null,
    })
    return this.ttlMs
  }

  /** Cache the current text for the guard's `old_string` lookup. */
  cacheText(absolutePath: string, text: string): void {
    const existing = this.liveEntry(absolutePath)
    if (existing === null) {
      this.entries.set(absolutePath, { ranges: [], expiresAt: this.clock() + this.ttlMs, text })
      return
    }
    this.entries.set(absolutePath, { ...existing, text })
  }

  /** Ranges still inside their TTL; an expired entry is removed. */
  activeRanges(absolutePath: string): readonly PresenceRange[] {
    return this.liveEntry(absolutePath)?.ranges ?? []
  }

  /** Cached text of an actively edited file, or null. */
  cachedText(absolutePath: string): string | null {
    return this.liveEntry(absolutePath)?.text ?? null
  }

  /** Drop one file's entry (used when editing stops). */
  clear(absolutePath: string): void {
    this.entries.delete(absolutePath)
  }

  /** Drop every entry. */
  dispose(): void {
    this.entries.clear()
  }

  private liveEntry(absolutePath: string): PresenceEntry | null {
    const entry = this.entries.get(absolutePath)
    if (entry === undefined) return null
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(absolutePath)
      return null
    }
    return entry
  }
}

/** The shape of one tool execution the guard reads. */
export interface GuardExecutionLike {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: {
    readonly session?: { readonly header?: { readonly cwd?: unknown } }
  }
}

/** The three structured write tools the guard covers. */
export const GUARDED_WRITE_TOOLS: readonly string[] = ['write', 'edit', 'str_replace_editor']

/** Outcome of the guard: a denial reason, or undefined to allow. */
function deny(reason: string): string {
  return reason
}

/** Resolve the tool's file argument to an absolute path, or null. */
function guardTarget(execution: GuardExecutionLike): string | null {
  if (typeof execution.arguments !== 'object' || execution.arguments === null) return null
  const args = execution.arguments as Record<string, unknown>
  const raw = execution.name === 'str_replace_editor' ? args.path : args.file_path
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const path = raw.trim()
  if (isAbsolute(path)) return path
  const cwd = execution.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') return null
  return resolve(cwd, path)
}

/** The line of the first occurrence of `needle` in `text`, 1-based, or null. */
export function lineOfNeedle(text: string, needle: string): { startLine: number; endLine: number } | null {
  if (needle === '') return null
  const lines = text.split('\n')
  const needleLines = needle.split('\n')
  for (let index = 0; index + needleLines.length <= lines.length; index += 1) {
    let matched = true
    for (let offset = 0; offset < needleLines.length; offset += 1) {
      if (lines[index + offset] !== needleLines[offset]) {
        matched = false
        break
      }
    }
    if (matched) return { startLine: index + 1, endLine: index + needleLines.length }
  }
  return null
}

/** Whether two line ranges share a line. */
function overlaps(left: ArtifactConflictRange, right: PresenceRange): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine
}

/** Describe one active set for a denial reason. */
function describeRanges(ranges: readonly PresenceRange[]): string {
  return ranges
    .map((range) => (range.startLine === range.endLine
      ? `第 ${String(range.startLine)} 行`
      : `第 ${String(range.startLine)}–${String(range.endLine)} 行`))
    .join('、')
}

/**
 * Build the `tools.guard` adapter for the three structured write tools.
 *
 * `write` replaces the whole file, so any active range denies it. `edit` and
 * `str_replace_editor` locate `old_string` in the cached text and deny only an
 * overlap; without cached text they deny when the file is actively edited.
 * `bash` is not covered: the design records that as a known gap.
 */
export function createArtifactWriteGuard(
  presence: ArtifactPresenceRegistry,
): (execution: GuardExecutionLike) => string | undefined {
  return (execution) => {
    if (!GUARDED_WRITE_TOOLS.includes(execution.name)) return undefined
    const target = guardTarget(execution)
    if (target === null) return undefined
    const ranges = presence.activeRanges(target)
    if (ranges.length === 0) return undefined
    const args = execution.arguments as Record<string, unknown>
    if (execution.name === 'write') {
      return deny(`用户正在编辑 ${target}（${describeRanges(ranges)}），整文件写入会覆盖未保存内容；请等用户保存或先与他们确认`)
    }
    if (execution.name === 'str_replace_editor') {
      if (args.command === 'create') {
        return deny(`用户正在编辑 ${target}（${describeRanges(ranges)}），不能新建覆盖；请等用户保存`)
      }
      if (args.command !== 'str_replace' && args.command !== 'insert') return undefined
    }
    if (execution.name === 'str_replace_editor' && args.command === 'insert') {
      const insertLine = args.insert_line
      if (typeof insertLine !== 'number' || !Number.isSafeInteger(insertLine)) {
        return deny(`用户正在编辑 ${target}（${describeRanges(ranges)}），无法判断插入位置；请先读取文件`)
      }
      const point = { startLine: insertLine + 1, endLine: insertLine + 1 }
      return ranges.some((range) => overlaps(point, range))
        ? deny(`用户正在编辑 ${target}（${describeRanges(ranges)}），插入位置与他们的编辑范围重叠；稍后重试或先与用户确认`)
        : undefined
    }
    const needle = execution.name === 'edit' ? args.old_string : args.old_str
    if (typeof needle !== 'string' || needle === '') return undefined
    const text = presence.cachedText(target)
    if (text === null) {
      return deny(`用户正在编辑 ${target}（${describeRanges(ranges)}），宿主还没有该文件的最新内容；先读取文件再重试`)
    }
    const found = lineOfNeedle(text, needle)
    if (found === null) return undefined
    return ranges.some((range) => overlaps(found, range))
      ? deny(`用户正在编辑 ${target}（${describeRanges(ranges)}），本次修改与他们的编辑范围重叠；稍后重试或先与用户确认`)
      : undefined
  }
}
