/**
 * Pure helpers for the annotation user-node renderer.
 *
 * This module owns the browser-side delivery marker, the parser that mirrors
 * the host-side message format, message-content extraction, stable ARIA ids, the
 * fold reducer, and the slot-registration seam. It imports types only, so
 * `node:test` can exercise every function without React or a host.
 *
 * Why the marker and parser are declared here instead of imported from
 * `src/platform/annotation-prompt.ts`: a client module may import only client
 * modules and the shared `src/panel/*-contract.ts` leaves, and
 * `tests/guards/architecture.test.mjs` enforces that boundary. The design keeps
 * one declaration per half for the same reason. `tests/client/annotation-model.test.mjs`
 * pins the literal marker and compares both parsers on the same inputs, so the
 * two declarations cannot drift without a red test.
 */
import type {
  ChatUserMessageData,
  SlotComponent,
  SlotRegisterOptions,
  SlotsService,
  UserContentAttachmentView,
} from './contracts.ts'

/**
 * First-line sentinel of one delivered annotation message.
 *
 * `U+E000`/`U+E001` are private-use characters a keyboard cannot produce, and
 * the ASCII core carries a format version. The value must stay identical to
 * `ANNOTATION_MARKER` in `src/platform/annotation-prompt.ts`.
 */
export const ANNOTATION_MARKER = '\uE000cowork-annotation/v1\uE001'

/** Row title shown before the summary; also the empty-summary fallback. */
const ANNOTATION_ROW_TITLE = '批注投递'

/** Copy-button labels; the row has no locale seat, so the plugin's copy is fixed. */
export const COPY_LABEL = '复制'
export const COPIED_LABEL = '已复制'

/** Whether one text starts with the delivery marker line. */
function isAnnotationDelivery(text: unknown): text is string {
  return typeof text === 'string' && text.startsWith(`${ANNOTATION_MARKER}\n`)
}

/** The annotation text the browser renders: one-line summary plus expanded body. */
export interface ParsedAnnotationText {
  readonly summary: string
  readonly body: string
}

/**
 * Parse one delivered annotation message.
 *
 * The mirror of the host-side parser: the first line alone decides, the second
 * line is the summary, the third is the blank separator, and the fourth onward
 * is the expanded body. A missing or empty summary/body falls back to the row
 * title instead of throwing, so a damaged message still renders.
 *
 * @param text - the joined message text, or any untrusted value
 * @returns the parsed parts, or `null` when this is a normal user message
 */
export function parseAnnotationText(text: unknown): ParsedAnnotationText | null {
  if (!isAnnotationDelivery(text)) return null
  const lines = text.split('\n')
  const summary = (lines[1] ?? '').trim() || ANNOTATION_ROW_TITLE
  const body = lines.slice(3).join('\n').trim() || ANNOTATION_ROW_TITLE
  return { summary, body }
}

/** The text one content value contributes: text blocks only, unknown blocks skipped. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return textOfBlock(content) ?? ''
  let text = ''
  for (const block of content) text += textOfBlock(block) ?? ''
  return text
}

/** One text block's text; a bare string counts as text, anything else is skipped. */
function textOfBlock(block: unknown): string | null {
  if (typeof block === 'string') return block
  if (block === null || typeof block !== 'object') return null
  const candidate = block as { type?: unknown; text?: unknown }
  return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : null
}

/** Extracted message content in the shape the host content factory accepts. */
export interface MessageContentParts {
  readonly text: string
  readonly attachments: readonly UserContentAttachmentView[]
  readonly extraBlocks: readonly unknown[]
}

/**
 * Split a durable message's content into text, attachments, and unknown blocks.
 *
 * The projection mirrors the host's own `contentParts`: text joins without a
 * separator, image/file blocks become attachment inputs, and every other block
 * is handed through untouched so the host's content factory can decide how to
 * render or ignore it. A null or non-array value never throws.
 *
 * @param content - host ContentBlock array, a plain string, or an untrusted value
 * @returns the three content groups, always present
 */
export function messageContentParts(content: unknown): MessageContentParts {
  if (typeof content === 'string') return { text: content, attachments: [], extraBlocks: [] }
  if (!Array.isArray(content)) {
    const single = textOfBlock(content)
    if (single !== null) return { text: single, attachments: [], extraBlocks: [] }
    return { text: '', attachments: [], extraBlocks: content === null || content === undefined ? [] : [content] }
  }
  const text: string[] = []
  const attachments: UserContentAttachmentView[] = []
  const extraBlocks: unknown[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      text.push(block)
      continue
    }
    if (block === null || typeof block !== 'object') {
      extraBlocks.push(block)
      continue
    }
    const candidate = block as { type?: unknown; text?: unknown; attachment?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      text.push(candidate.text)
      continue
    }
    if (candidate.type === 'image' && candidate.attachment !== undefined) {
      attachments.push({ type: 'image', image: { attachment: candidate.attachment } })
      continue
    }
    if (candidate.type === 'file' && candidate.attachment !== undefined) {
      attachments.push({ type: 'file', file: candidate.attachment })
      continue
    }
    extraBlocks.push(block)
  }
  return { text: text.join(''), attachments, extraBlocks }
}

/** What one delivered message shows: a fixed title, the summary, and the body. */
export interface AnnotationDisplay {
  readonly title: string
  readonly summary: string
  readonly body: string
}

/**
 * Recognize one delivery and extract its display parts in a single step.
 *
 * @param content - the node's message content
 * @returns the display parts, or `null` when the message has no marker
 */
export function annotationDisplay(content: unknown): AnnotationDisplay | null {
  const parsed = parseAnnotationText(contentText(content))
  if (parsed === null) return null
  return { title: ANNOTATION_ROW_TITLE, summary: parsed.summary, body: parsed.body }
}

/** Stable ids one annotation row derives from its message identity. */
export interface AnnotationNodeIds {
  readonly triggerId: string
  readonly bodyId: string
}

/** One id-safe key segment for a message identity. */
function idPart(node: Pick<ChatUserMessageData, 'messageId' | 'seq'> | undefined): string {
  const raw = typeof node?.messageId === 'string' && node.messageId.trim() !== ''
    ? node.messageId
    : typeof node?.seq === 'number' && Number.isFinite(node.seq) ? `seq-${String(node.seq)}` : 'message'
  return raw.replace(/[^A-Za-z0-9_-]/g, '-')
}

/**
 * Derive the trigger and body ids of one row.
 *
 * The durable message id is unique within its session, so two messages never
 * share a disclosure pair; a projection without an id falls back to its
 * sequence and then to a fixed word.
 *
 * @param node - the message identity source
 * @returns the two ids, stable for the same message
 */
export function annotationNodeIds(node: Pick<ChatUserMessageData, 'messageId' | 'seq'> | undefined): AnnotationNodeIds {
  const key = idPart(node)
  return { triggerId: `cw-annotation-trigger-${key}`, bodyId: `cw-annotation-body-${key}` }
}

/** User intent on one annotation disclosure. */
export type AnnotationFoldAction = 'toggle' | 'escape'

/**
 * Fold state of one delivered annotation row.
 *
 * A row starts collapsed (`false`), `toggle` flips it, and `escape` always
 * returns to collapsed so the caller can restore focus to the trigger.
 *
 * @param open - current state
 * @param action - user intent
 * @returns the next state
 */
export function annotationFoldReducer(open: boolean, action: AnnotationFoldAction): boolean {
  if (action === 'escape') return false
  return !open
}

/**
 * Format one durable message timestamp as a local `HH:mm`.
 *
 * @param time - epoch ms from the source session event
 * @returns the clock text, or `null` when the timestamp is missing or invalid
 */
export function formatMessageClock(time: unknown): string | null {
  if (typeof time !== 'number' || !Number.isFinite(time)) return null
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return null
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * Keyed Chat Node registration this renderer owns.
 *
 * The `user` key replaces the host's own user-row renderer. The host occupies
 * that cell at the default priority 0, so the replacement registers at -1:
 * rank is ascending and the lowest renders, which keeps the replacement
 * independent of load order. The declared `conversation.chat.user.before`
 * child keeps the message-source decoration seat available.
 */
const ANNOTATION_NODE_OPTIONS: SlotRegisterOptions = Object.freeze({
  name: 'conversation.chat.node',
  key: 'user',
  priority: -1,
  children: Object.freeze({
    'conversation.chat.user.before': Object.freeze({ kind: 'chain' as const, scope: 'session' as const }),
  }),
})

/**
 * Failure reporting hook for the registration seam. The host logger is
 * injected rather than imported, because `src/` must not log directly.
 */
export interface AnnotationNodeBindingDeps {
  readonly warn?: (message: string) => void
}

function noop(): void {
  // Intentional no-op: a host without the slot capability keeps its own renderer.
}

/**
 * Register one component under `conversation.chat.node` key `user`.
 *
 * The registration is installed through `slots.inject`, so it waits for the
 * Chat slot declaration and is owned by the caller's fiber in turn. A host
 * without the slot service (or without `inject`/`register`) degrades to a no-op
 * disposer; a registry that rejects the declaration also degrades instead of
 * failing the whole panel apply, because replacing one row is cosmetic.
 *
 * @param slots - the host slot service, or a runtime value that is not one
 * @param component - the `user` renderer
 * @param deps - failure reporting
 * @returns an idempotent disposer for the injection and its registration
 */
export function bindAnnotationNode(
  slots: SlotsService | undefined,
  component: SlotComponent,
  deps: AnnotationNodeBindingDeps = {},
): () => void {
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return noop
  try {
    const dispose = slots.inject(ANNOTATION_NODE_OPTIONS.name, () => slots.register(ANNOTATION_NODE_OPTIONS, component))
    return typeof dispose === 'function' ? dispose : noop
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    deps.warn?.(`[dsh-cowork] annotation node renderer registration failed; keeping the host user renderer: ${detail}`)
    return noop
  }
}
