/**
 * Plugin renderer for the keyed Chat Node seat, key `user`.
 *
 * The host's own user row renders every message as a right-aligned bubble. This
 * renderer keeps that path byte-for-byte where it can (content delegated to the
 * host `conversation.chat.user.content` factory, message-source chain rendered,
 * only the time/copy row self-implemented) and adds one special case: a message
 * whose text starts with {@link ANNOTATION_MARKER_TEXT} is a batch delivery from the
 * work-item dispatcher, so it renders as a full-width disclosure row instead of
 * a bubble. The marker line never reaches the DOM. {@link parseAnnotationMessage}
 * in the model owns the marker check and the summary/body split; this node only
 * renders its result.
 *
 * The registration is installed through `registerAnnotationNode`, which owns the
 * `conversation.chat.node` key `user` registration and its child declaration for
 * the message-source seat.
 */
import { useEffect, useReducer, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import {
  COPIED_LABEL,
  COPY_LABEL,
  annotationDisplay,
  annotationFoldReducer,
  annotationNodeIds,
  bindAnnotationNode,
  formatMessageClock,
  messageContentParts,
} from './annotation-model.ts'
import type { AnnotationDisplay, AnnotationNodeBindingDeps, MessageContentParts } from './annotation-model.ts'
import type {
  ChatUserMessageData,
  ChatUserNodeProps,
  SlotsService,
  UserContentDataView,
} from './contracts.ts'

/** 14px annotation glyph drawn inline so the bundle needs no host icon module. */
function AnnotationGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" focusable="false" aria-hidden="true">
      <path
        d="M2.5 3.5h9v6H6.2L3.6 11V9.5h-1.1z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M4.6 5.6h4.8M4.6 7.4h3.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

/** 12px chevron; CSS rotates it when the row is open. */
function ChevronGlyph(): ReactElement {
  return (
    <svg className="cw-annotation-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" focusable="false" aria-hidden="true">
      <path d="M4 2.5 7.5 6 4 9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Copy affordance glyph. */
function CopyGlyph(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" focusable="false" aria-hidden="true">
      <rect x="4" y="1.5" width="6.5" height="6.5" rx="1.2" stroke="currentColor" strokeWidth="1.1" />
      <path d="M8 9.5v.4a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2V5.8A1.2 1.2 0 0 1 2.7 4.6h.4" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

/** Copied confirmation glyph. */
function CheckGlyph(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" focusable="false" aria-hidden="true">
      <path d="m2.5 6.3 2.2 2.2 4.8-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** How long the copy confirmation stays visible. */
const COPIED_RESET_MS = 1_500

/** One clipboard write; resolves false when the API is absent or denied. */
async function copyText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard === undefined) return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    // A denied clipboard permission is not a row failure; the affordance stays.
    return false
  }
}

/** The copy flag plus the action that sets it and clears it after the window. */
function useCopiedFlag(): { readonly copied: boolean; readonly markCopied: () => void } {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current)
  }, [])
  const markCopied = (): void => {
    setCopied(true)
    if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => { setCopied(false) }, COPIED_RESET_MS)
  }
  return { copied, markCopied }
}

/** The optional time label of the action row. */
function UserClock({ time }: { readonly time: number | undefined }): ReactElement | null {
  const clock = formatMessageClock(time)
  return clock === null ? null : <span className="cw-user-time">{clock}</span>
}

/** The copy button; its label and glyph follow the confirmation flag. */
function CopyButton({ copied, onCopy }: {
  readonly copied: boolean
  readonly onCopy: () => void
}): ReactElement {
  const label = copied ? COPIED_LABEL : COPY_LABEL
  return (
    <button type="button" className="cw-user-action" aria-label={label} title={label} onClick={onCopy}>
      {copied ? <CheckGlyph /> : <CopyGlyph />}
    </button>
  )
}

/** The minimal time + copy row; MessageIconActions is not exported by primitives. */
function UserActions({ text, time }: { readonly text: string; readonly time: number | undefined }): ReactElement {
  const { copied, markCopied } = useCopiedFlag()
  const onCopy = (): void => { void copyText(text).then((ok) => { if (ok) markCopied() }) }
  return (
    <div className="cw-user-actions" data-clock="start">
      <UserClock time={time} />
      <CopyButton copied={copied} onCopy={onCopy} />
    </div>
  )
}

/** The host factory's content output, or null when no factory is mounted. */
function delegatedUserContent(
  renderFactorySlot: ChatUserNodeProps['renderFactorySlot'],
  content: UserContentDataView,
  facts: Record<string, unknown>,
  loadImage: ChatUserNodeProps['loadImage'],
): ReactNode {
  return renderFactorySlot?.(
    'conversation.chat.user.content',
    { content, loadImage, facts, interactive: true },
  ) ?? null
}

/** The bubble content: the host factory output, else the plain-text fallback. */
function UserRowBody({ text, delegated }: {
  readonly text: string
  readonly delegated: ReactNode
}): ReactElement {
  return <>{delegated ?? <div className="cw-user-fallback">{text}</div>}</>
}

/**
 * Normal user message: the host-equivalent thin shell.
 *
 * Content is delegated whole to the host `conversation.chat.user.content`
 * factory; the message-source chain is rendered from the declared child slot.
 * Only the right-aligned column and the time/copy row are local, because the
 * host keeps `MessageIconActions` and `UserStyleBubble` inside `ui-chat`.
 */
/** The content view the host user-content factory receives. */
function userContentView(parts: MessageContentParts, data: ChatUserMessageData | undefined): UserContentDataView {
  return {
    text: parts.text,
    attachments: parts.attachments,
    extraBlocks: parts.extraBlocks,
    ...(data?.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }),
  }
}

/** The session labels fact, omitted when the host sent none. */
function sessionLabelsOf(data: ChatUserMessageData | undefined): Record<string, unknown> {
  return data?.referenceLabels === undefined ? {} : { sessionLabels: data.referenceLabels }
}

/** The skill names fact, omitted when the host sent none. */
function skillNamesOf(data: ChatUserMessageData | undefined): Record<string, unknown> {
  return data?.skillNames === undefined ? {} : { skillNames: data.skillNames }
}

/** The optional user facts the host factory reads. */
function userFactsOf(data: ChatUserMessageData | undefined): Record<string, unknown> {
  return { ...sessionLabelsOf(data), ...skillNamesOf(data) }
}

/** The message-source chain above the row, or null. */
function userBeforeSlot(
  renderSlotChain: ChatUserNodeProps['renderSlotChain'],
  data: ChatUserMessageData | undefined,
): ReactNode {
  return renderSlotChain?.('conversation.chat.user.before', { source: data?.source, kind: 'user' }, { fallback: null }) ?? null
}

/**
 * Normal user message: the host-equivalent thin shell.
 *
 * Content is delegated whole to the host `conversation.chat.user.content`
 * factory; the message-source chain is rendered from the declared child slot.
 * Only the right-aligned column and the time/copy row are local, because the
 * host keeps `MessageIconActions` and `UserStyleBubble` inside `ui-chat`.
 */
function NormalUserRow({
  data, renderFactorySlot, renderSlotChain, loadImage,
}: {
  readonly data: ChatUserMessageData | undefined
} & Pick<ChatUserNodeProps, 'renderFactorySlot' | 'renderSlotChain' | 'loadImage'>): ReactElement {
  const parts = messageContentParts(data?.content)
  const before = userBeforeSlot(renderSlotChain, data)
  const delegated = delegatedUserContent(renderFactorySlot, userContentView(parts, data), userFactsOf(data), loadImage)
  return (
    <div className="cw-user-row">
      {before}
      <UserRowBody text={parts.text} delegated={delegated} />
      <UserActions text={parts.text} time={data?.time} />
    </div>
  )
}

/** One delivered annotation batch: a collapsed disclosure row by default. */
function AnnotationRow({ data, display }: {
  readonly data: ChatUserMessageData | undefined
  readonly display: AnnotationDisplay
}): ReactElement {
  const [open, dispatch] = useReducer(annotationFoldReducer, false)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const ids = annotationNodeIds(data)

  const collapse = (): void => {
    dispatch('escape')
    trigger.current?.focus()
  }
  const onEscape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    collapse()
  }

  return (
    <div className="cw-annotation-row" data-open={open ? 'true' : undefined}>
      <button
        ref={trigger}
        type="button"
        id={ids.triggerId}
        className="cw-annotation-trigger"
        aria-expanded={open}
        aria-controls={ids.bodyId}
        onClick={() => { dispatch('toggle') }}
        onKeyDown={onEscape}
      >
        <span className="cw-annotation-icon" aria-hidden="true"><AnnotationGlyph /></span>
        <span className="cw-annotation-title">{display.title}</span>
        <span className="cw-annotation-sep" aria-hidden="true">·</span>
        <span className="cw-annotation-summary" title={display.summary}>{display.summary}</span>
        <ChevronGlyph />
      </button>
      <div
        id={ids.bodyId}
        className="cw-annotation-body"
        role="region"
        aria-label="批注上下文"
        hidden={!open}
        tabIndex={open ? 0 : undefined}
        onKeyDown={onEscape}
      >
        <pre className="cw-annotation-pre">{display.body}</pre>
      </div>
    </div>
  )
}

/**
 * The `user` renderer: a marker delivery collapses, everything else keeps the
 * host's user-bubble composition. The branch is decided per message, and the
 * marker line is never rendered.
 */
export function CwUserNode(props: ChatUserNodeProps): ReactElement {
  const data = props.node?.data
  const display = annotationDisplay(data?.content)
  if (display === null) {
    return (
      <NormalUserRow
        data={data}
        renderFactorySlot={props.renderFactorySlot}
        renderSlotChain={props.renderSlotChain}
        loadImage={props.loadImage}
      />
    )
  }
  return <AnnotationRow data={data} display={display} />
}

/**
 * Register {@link CwUserNode} under `conversation.chat.node` key `user`.
 *
 * @param slots - the host slot service
 * @returns the registration disposer (a no-op on a host without the capability)
 */
export function registerAnnotationNode(
  slots: SlotsService | undefined,
  deps?: AnnotationNodeBindingDeps,
): () => void {
  return bindAnnotationNode(slots, CwUserNode, deps)
}
