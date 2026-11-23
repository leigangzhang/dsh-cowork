/**
 * Reading-surface behavior for the work-item viewer.
 *
 * The container owns data loading, saving, and the rail; this module owns the
 * reading state machine that sits between them: the read/source switch, the
 * annotate gate, selection-to-anchor mapping, block-pin focus, and the viewport
 * handoff. It is React-free (plain functions over setters) so `node --test` can
 * cover every transition, and so the viewer container stays a container.
 */
import type {
  ArtifactAnchor,
  ArtifactFileResponse,
  ArtifactRecordV1,
} from '../../panel/artifact-contract.js'
import type { SaveConflict } from './api.ts'
import {
  lineRangeAnnotation,
  pinThread,
  type LineSelection,
  type SavePhase,
  type ThreadPin,
  type WorkItemThread,
} from './model.ts'
import { readFallbackReason } from './viewers/markdown.ts'
import type { ViewerKind } from './viewers/document.ts'

/** Read-mode state the Markdown flow surface consumes. */
export interface ReadingSurfaceConfig {
  /** Saved text, or the unsaved draft while the viewer is dirty. */
  readonly content: string
  /** The draft differs from the saved file: pins hide and annotating stops. */
  readonly dirty: boolean
  /** Why the floating annotate entry is disabled, if it is. */
  readonly annotateDisabled: boolean
  readonly annotateReason: string | null
  /** The selected thread's anchor, highlighted in the flow surface. */
  readonly selectedAnchor: ArtifactAnchor | null
  /** Source line to bring to the top after a source-to-read switch. */
  readonly focusLine: number | null
  /** Bumped on every focus request so the same line can scroll again. */
  readonly focusToken: number
  /** Set when the file is too large to render; the source lines take over. */
  readonly fallback: string | null
  readonly threads: readonly WorkItemThread[]
  readonly imageUrl: (src: string) => string | null
  readonly onAnnotate: (startLine: number, endLine: number, selectedText: string) => void
  readonly onPickPin: (ordinal: number) => void
  readonly onViewportLine: (line: number) => void
  /** Clear the selected thread highlight. */
  readonly onClearThread: () => void
}

/** One mutable viewport-line slot shared by both surfaces. */
export interface ViewportLineSlot {
  current: number
}

/** Everything the reading state machine reads. */
export interface ReadingSurfaceInput {
  readonly kind: ViewerKind
  readonly file: ArtifactFileResponse | null
  readonly record: ArtifactRecordV1 | null
  readonly lines: readonly string[]
  readonly threads: readonly WorkItemThread[]
  /** Line pins keyed by source line; the source-lines surface uses them. */
  readonly pins: ReadonlyMap<number, ThreadPin>
  readonly selectedThreadId: string | null
  readonly selection: LineSelection | null
  readonly dirty: boolean
  readonly conflict: SaveConflict | null
  readonly readOnly: boolean
  readonly editing: boolean
  readonly readMode: boolean
  readonly editDraft: string
  readonly savedContent: string
  readonly viewportLineRef: ViewportLineSlot
  readonly focusLine: number | null
  readonly focusToken: number
  /** The visible toolbar tab: only the document tab shows the mode switch. */
  readonly viewTab: 'document' | 'versions' | 'attachments'
  /** URL of one stored attachment, or null when there is no owner context. */
  readonly attachmentUrl: (attachmentId: string) => string | null
}

/** State sinks owned by the viewer container. */
export interface ReadingSurfaceSinks {
  readonly setEditing: (value: boolean) => void
  readonly setReadMode: (value: boolean) => void
  readonly setEditDraft: (value: string) => void
  readonly setSavedContent: (value: string) => void
  readonly setSavePhase: (phase: SavePhase) => void
  readonly setConflict: (value: SaveConflict | null) => void
  readonly setReceipt: (value: string | null) => void
  readonly setSelection: (value: LineSelection | null) => void
  readonly setPendingAnchor: (value: ArtifactAnchor | null) => void
  readonly setReplyTarget: (value: null) => void
  readonly setViewTab: (tab: 'document') => void
  readonly setShowRail: (value: boolean) => void
  readonly setReadFocusLine: (line: number | null) => void
  readonly clearThread: () => void
  readonly focusComposer: () => void
  readonly openThread: (thread: WorkItemThread) => void
}

/** What the viewer container consumes from the reading state machine. */
export interface ReadingSurface {
  readonly config: ReadingSurfaceConfig
  /** Whether the toolbar shows the read/source switch. */
  readonly showMode: boolean
  /** Enter or leave the source editor without discarding a draft. */
  readonly toggleEditing: () => void
  /** The toolbar read/source switch. */
  readonly toggleReadMode: () => void
  /** Annotate the current line selection, if any. */
  readonly annotate: () => void
  /** Keyboard annotation from the numbered line list. */
  readonly annotateLine: (line: number) => void
  /** A numbered line's pin opens the thread it numbers. */
  readonly focusPin: (line: number) => void
}

/** Why a new annotation is unavailable, or null when it is available. */
function annotateReason(input: ReadingSurfaceInput): string | null {
  if (input.readOnly) return '跨会话只读：切到所属会话后才能批注'
  if (input.dirty) return '未保存草稿：保存后可批注'
  if (input.conflict !== null) return '版本冲突：先在源码中处理'
  return null
}

/** The text the reading surface renders: draft when dirty, saved otherwise. */
function readingContent(input: ReadingSurfaceInput): string {
  return input.dirty ? input.editDraft : (input.file?.content ?? '')
}

/** The fallback notice for oversized Markdown, or null for other files. */
function fallbackFor(input: ReadingSurfaceInput, content: string): string | null {
  return input.kind === 'text' ? readFallbackReason(content) : null
}

/** The selected thread's anchor, if the rail has one selected. */
function selectedThreadAnchor(input: ReadingSurfaceInput): ArtifactAnchor | null {
  return input.threads.find(thread => thread.threadId === input.selectedThreadId)?.anchor ?? null
}

/**
 * Resolve one sanitized image source to its final URL.
 *
 * `http(s)` goes straight to the browser; an attachment URI uses the work
 * item's attachment route; every other allowed form (project-relative paths)
 * has no read route in this version and stays unresolved.
 * @param src - a source that already passed `sanitizeImageSrc`.
 * @param attachmentUrl - resolver for one attachment id, or null.
 * @returns the URL to load, or null when no route can serve it.
 */
function readingImageUrl(
  src: string,
  attachmentUrl: (attachmentId: string) => string | null,
): string | null {
  if (/^https?:\/\//i.test(src)) return src
  const match = /^cowork-attachment:\/\/([A-Za-z0-9_-]+)$/.exec(src)
  const attachmentId = match?.[1]
  return attachmentId === undefined ? null : attachmentUrl(attachmentId)
}

/**
 * Build the reading-surface state machine and its callbacks.
 *
 * One factory keeps the viewer container declarative: every decision about
 * surfaces, drafts, and annotation lives here, while the container keeps the
 * loaded record and the rail.
 * @param input - current viewer state the reading surface depends on.
 * @param sinks - state setters and focus/open callbacks owned by the container.
 * @returns the config for the flow renderer plus the actions the container uses.
 */
export function createReadingSurface(
  input: ReadingSurfaceInput,
  sinks: ReadingSurfaceSinks,
): ReadingSurface {
  const readContent = readingContent(input)
  const readFallback = fallbackFor(input, readContent)
  const selectedAnchor = selectedThreadAnchor(input)

  /** Enter the editor without replacing a draft the user still owns. */
  const enterEditing = (): void => {
    if (input.readOnly) return
    if (input.editDraft === input.savedContent && input.file !== null) {
      sinks.setEditDraft(input.file.content)
      sinks.setSavedContent(input.file.content)
      sinks.setSavePhase('saved')
    }
    sinks.setEditing(true)
    sinks.setConflict(null)
    sinks.setReceipt(null)
  }

  const toggleEditing = (): void => {
    if (input.readOnly) return
    if (!input.editing) {
      enterEditing()
      sinks.setReadMode(false)
      return
    }
    sinks.setReadFocusLine(input.viewportLineRef.current)
    sinks.setEditing(false)
    sinks.setReadMode(true)
  }

  const toggleReadMode = (): void => {
    // A cross-session preview must never open an editor for the owner's file.
    if (input.readOnly) return
    if (input.kind !== 'text') {
      sinks.setReadMode(!input.readMode)
      return
    }
    if (input.readMode) {
      sinks.setReadMode(false)
      enterEditing()
      return
    }
    sinks.setReadFocusLine(input.viewportLineRef.current)
    sinks.setReadMode(true)
    sinks.setEditing(false)
  }

  const annotateRange = (startLine: number, endLine: number, selectedText?: string): void => {
    if (input.readOnly || input.dirty || input.record === null) return
    const range = lineRangeAnnotation(
      input.lines,
      input.file,
      input.record.primaryPath,
      startLine,
      endLine,
      selectedText,
    )
    if (range === null) return
    // A new annotation is not a reply: the composer must not inherit a thread.
    sinks.setReplyTarget(null)
    sinks.setSelection({ startLine: range.startLine, endLine: range.endLine })
    sinks.setPendingAnchor({ kind: 'line-range', ...range })
    sinks.setViewTab('document')
    sinks.setShowRail(true)
    // The rail may still be collapsed in this frame; focus after the state
    // flush that makes the composer focusable.
    sinks.focusComposer()
  }

  const annotate = (): void => {
    if (input.selection === null) return
    annotateRange(input.selection.startLine, input.selection.endLine)
  }

  const focusPinOrdinal = (ordinal: number): void => {
    const thread = input.threads[ordinal - 1]
    if (thread !== undefined) sinks.openThread(thread)
  }

  const focusPin = (line: number): void => {
    const thread = pinThread(input.pins, input.threads, line)
    if (thread !== null) sinks.openThread(thread)
  }

  const config: ReadingSurfaceConfig = {
    content: readContent,
    dirty: input.dirty,
    annotateDisabled: input.readOnly || input.dirty || input.conflict !== null,
    annotateReason: annotateReason(input),
    selectedAnchor,
    focusLine: input.focusLine,
    focusToken: input.focusToken,
    fallback: readFallback,
    threads: input.threads,
    imageUrl: (src) => readingImageUrl(src, input.attachmentUrl),
    onAnnotate: (startLine, endLine, selectedText) => { annotateRange(startLine, endLine, selectedText) },
    onPickPin: focusPinOrdinal,
    onViewportLine: (line) => { input.viewportLineRef.current = line },
    onClearThread: () => { sinks.clearThread() },
  }

  return {
    config,
    toggleEditing,
    toggleReadMode,
    annotate,
    annotateLine: line => { annotateRange(line, line) },
    focusPin,
    showMode: input.viewTab === 'document' && input.file !== null && !input.readOnly
      && (input.kind === 'text' || !input.editing),
  }
}
