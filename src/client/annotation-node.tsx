/**
 * Plugin renderer for the keyed Chat Node seat, key `user`.
 *
 * The host's own user row renders every message as a right-aligned bubble. This
 * renderer keeps that path byte-for-byte where it can (content delegated to the
 * host `conversation.chat.user.content` factory, message-source chain rendered,
 * only the time/copy row self-implemented) and adds one special case: a message
 * whose text starts with {@link ANNOTATION_MARKER} is a batch delivery from the
 * work-item dispatcher, so it renders as a full-width disclosure row instead of
 * a bubble. The marker line never reaches the DOM.
 *
 * The registration is installed through `registerAnnotationNode`, which owns the
 * `conversation.chat.node` key `user` registration and its child declaration for
 * the message-source seat.
 */
import { useEffect, useReducer, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
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
import type { AnnotationDisplay, AnnotationNodeBindingDeps } from './annotation-model.ts'
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

/** The minimal time + copy row; MessageIconActions is not exported by primitives. */
function UserActions({ text, time }: { readonly text: string; readonly time: number | undefined }): ReactElement {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current)
  }, [])

  const onCopy = (): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard === undefined) return
    void clipboard.writeText(text).then(() => {
      setCopied(true)
      if (resetTimer.current !== null) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => { setCopied(false) }, 1_500)
    }).catch(() => {
      // A denied clipboard permission is not a row failure; the affordance stays.
    })
  }

  const clock = formatMessageClock(time)
  return (
    <div className="cw-user-actions" data-clock="start">
      {clock === null ? null : <span className="cw-user-time">{clock}</span>}
      <button
        type="button"
        className="cw-user-action"
        aria-label={copied ? COPIED_LABEL : COPY_LABEL}
        title={copied ? COPIED_LABEL : COPY_LABEL}
        onClick={onCopy}
      >
        {copied ? <CheckGlyph /> : <CopyGlyph />}
      </button>
    </div>
  )
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
  const content: UserContentDataView = {
    text: parts.text,
    attachments: parts.attachments,
    extraBlocks: parts.extraBlocks,
    ...(data?.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }),
  }
  const facts = {
    ...(data?.referenceLabels === undefined ? {} : { sessionLabels: data.referenceLabels }),
    ...(data?.skillNames === undefined ? {} : { skillNames: data.skillNames }),
  }
  const before = renderSlotChain?.(
    'conversation.chat.user.before',
    { source: data?.source, kind: 'user' },
    { fallback: null },
  ) ?? null
  const delegated = renderFactorySlot?.(
    'conversation.chat.user.content',
    { content, loadImage, facts, interactive: true },
  ) ?? null
  return (
    <div className="cw-user-row">
      {before}
      {delegated ?? <div className="cw-user-fallback">{parts.text}</div>}
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
