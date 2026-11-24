/**
 * One comment thread card in the work-item rail.
 *
 * The card owns no data: the viewer supplies the folded thread, its delivery
 * batch, and the callbacks. It follows the interaction reference's card shape:
 * an author row with the `#N` anchor chip, the quoted source line, the root
 * comment, model replies, a delivery state row, and a footer action row. A
 * resolved thread folds to a compact row and keeps an expand entry.
 */
import { useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import type { ArtifactDispatchSummary, CommentEventV1 } from '../../panel/artifact-contract.js'
import {
  anchorLabel,
  anchorStatusLabel,
  attachmentSourceBadge,
  commentAuthor,
  commentBody,
  dispatchDetailLabel,
  formatBytes,
  formatElapsed,
  formatRelativeTime,
  isRetryableDispatch,
  type WorkItemThread,
} from './model.ts'
import { useAttachmentPreview } from './attachment-preview.tsx'

/** Props of one thread card. */
export interface ThreadCardProps {
  readonly thread: WorkItemThread
  /** 1-based position in the rail; rendered as the `#N` anchor chip. */
  readonly ordinal: number
  readonly selected: boolean
  /** Render a resolved card's body directly (rail group or resolved filter). */
  readonly expandedByGroup?: boolean
  /**
   * The rail's list level: one read-only summary row.
   *
   * A summary card never expands in place and holds no reply or resolve
   * control; clicking it (or Enter) enters the session level.
   */
  readonly summaryOnly?: boolean
  readonly now: Date
  readonly pending: boolean
  readonly dispatch: ArtifactDispatchSummary | null
  readonly retrying: boolean
  /** Cross-session preview: reply and resolve stay visible but disabled. */
  readonly readOnly: boolean
  readonly onSelect: (thread: WorkItemThread) => void
  /** Resolve/reopen; absent while the list level has no session controls. */
  readonly onToggle: (thread: WorkItemThread) => void
  /** Reply; absent while the list level has no composer to receive it. */
  readonly onReply?: (thread: WorkItemThread) => void
  readonly onRetry: (dispatch: ArtifactDispatchSummary) => void
  readonly onFocus: (thread: WorkItemThread) => void
  readonly attachmentUrl: (attachmentId: string) => string
}

/** Whether the delivery retry action is unavailable while busy or read-only. */
function dispatchRetryDisabled(retrying: boolean, readOnly: boolean): boolean {
  return retrying || readOnly
}

/** Readable reason a read-only preview cannot retry a delivery. */
function dispatchRetryTitle(readOnly: boolean): string | undefined {
  return readOnly ? '跨会话只读：切到所属会话后才能重试投递' : undefined
}

/** A comment that carries an author and a body. */
type ThreadComment = Extract<CommentEventV1, { type: 'create' | 'reply' }>

/** One avatar for a comment author. */
function Avatar({ event }: { readonly event: ThreadComment }): ReactElement {
  return (
    <span className="cwi-avatar" data-author={event.author === 'model' ? 'model' : 'user'} aria-hidden="true">
      {event.author === 'model' ? 'M' : 'Y'}
    </span>
  )
}

/**
 * Attachments carried by one comment, as a thumbnail or a download link.
 *
 * A model-authored comment marks each of its attachments with the 模型生成
 * badge; the button opens the same preview overlay as the attachment page.
 */
function Attachments({ event, attachmentUrl }: {
  readonly event: ThreadComment
  readonly attachmentUrl: (attachmentId: string) => string
}): ReactElement | null {
  const preview = useAttachmentPreview()
  const attachments = event.attachments ?? []
  if (attachments.length === 0) return null
  const source = event.author === 'model' ? 'model' : 'user'
  const badge = attachmentSourceBadge(source)
  return (
    <div className="cwi-attachments">
      {attachments.map((attachment) => (
        <span key={attachment.attachmentId} className="cwi-attachment-item">
          {attachment.mediaType.startsWith('image/')
            ? (
                <button
                  type="button"
                  className="cwi-attachment-open"
                  data-testid="cwi-attachment-preview"
                  aria-label={`预览 ${attachment.name}`}
                  onClick={() => {
                    preview?.open({
                      attachmentId: attachment.attachmentId,
                      name: attachment.name,
                      mediaType: attachment.mediaType,
                      size: attachment.size,
                      source,
                    })
                  }}
                >
                  <img
                    className="cwi-attachment-thumb"
                    data-testid="cwi-attachment-thumb"
                    src={attachmentUrl(attachment.attachmentId)}
                    alt={attachment.name}
                  />
                </button>
              )
            : (
                <a
                  className="cwi-attachment-link"
                  data-testid="cwi-attachment-link"
                  href={attachmentUrl(attachment.attachmentId)}
                  download={attachment.name}
                >
                  {attachment.name}
                </a>
              )}
          {badge === null ? null : <span className="cwi-attachment-model" data-testid="cwi-attachment-model">{badge}</span>}
        </span>
      ))}
      {attachments.map((attachment) => (
        <span key={`${attachment.attachmentId}-meta`} className="cwi-thread-meta" data-testid="cwi-attachment-meta">
          {attachment.name} · {attachment.mediaType} · {formatBytes(attachment.size)}
        </span>
      ))}
    </div>
  )
}

/** One comment body; the card head already names the root author. */
function Comment({ event, now, attachmentUrl, showMeta }: {
  readonly event: ThreadComment
  readonly now: Date
  readonly attachmentUrl: (attachmentId: string) => string
  readonly showMeta: boolean
}): ReactElement {
  return (
    <>
      {showMeta
        ? (
            <div className="cwi-thread-meta">
              <Avatar event={event} />
              <span className="cwi-comment-author">{commentAuthor(event)}</span>
              {event.author === 'model' ? <span className="cwi-reply-mark">已回复</span> : null}
              <span className="cwi-thread-time">{formatRelativeTime(event.createdAt, now)}</span>
            </div>
          )
        : null}
      <div className="cwi-thread-body">{commentBody(event)}</div>
      <Attachments event={event} attachmentUrl={attachmentUrl} />
    </>
  )
}

/**
 * Render one thread card.
 * @param props - folded thread, rail position, delivery batch, and callbacks.
 * @returns the card; a resolved thread shows a compact row until expanded.
 */
// One comment thread as a card: quote, state, replies, and actions. The
// branchiness is the card's visible state matrix; the browser lane owns it.
// fallow-ignore-next-line complexity
export function ThreadCard({
  thread,
  ordinal,
  selected,
  expandedByGroup = false,
  summaryOnly = false,
  now,
  pending,
  dispatch,
  retrying,
  readOnly,
  onSelect,
  onToggle,
  onReply,
  onRetry,
  onFocus,
  attachmentUrl,
}: ThreadCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const comments = thread.comments.filter(
    (event): event is ThreadComment => event.type === 'create' || event.type === 'reply',
  )
  const root = comments[0] ?? null
  const replies = comments.slice(1)
  const compact = !summaryOnly && thread.resolved && !expanded && !expandedByGroup
  const open = !thread.resolved
  const statusLabel = anchorStatusLabel(thread.anchorStatus)
  const stale = thread.anchorStatus === 'stale'
  const quote = thread.anchor !== null && 'quote' in thread.anchor ? thread.anchor.quote : ''
  const dispatchTone = dispatch === null
    ? 'pending'
    : dispatch.state === 'failed' || dispatch.state === 'blocked'
      ? 'error'
      : dispatch.state === 'replied'
        ? 'done'
        : dispatch.state === 'stale'
          ? 'warn'
          : 'pending'
  const onCardKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // A nested button owns its own Enter/Space; only the card itself selects.
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onSelect(thread)
  }
  return (
    <article
      className="cwi-thread"
      data-testid="cwi-thread"
      data-thread-id={thread.threadId}
      data-resolved={thread.resolved ? 'true' : 'false'}
      data-selected={selected ? 'true' : 'false'}
      data-open={open ? 'true' : 'false'}
      data-summary={summaryOnly ? 'true' : 'false'}
      tabIndex={0}
      onKeyDown={onCardKeyDown}
      onClick={() => { onSelect(thread) }}
    >
      <div className="cwi-thread-head">
        {root === null ? null : <Avatar event={root} />}
        <span className="cwi-thread-author">{root === null ? '批注' : commentAuthor(root)}</span>
        <span className="cwi-thread-anchor">{anchorLabel(thread.anchor)}</span>
        <span className="cwi-anchor-chip" data-tone={stale ? 'warn' : (thread.resolved ? 'done' : 'open')}>#{ordinal}</span>
      </div>
      {summaryOnly ? (
        <>
          <div className="cwi-thread-summary" data-testid="cwi-thread-summary">
            {root === null ? '已解决' : commentBody(root)}
          </div>
          {thread.resolved ? (
            <div className="cwi-thread-meta">
              <span className="cwi-resolved-mark">✓ 已解决</span>
              <span className="cwi-thread-time">{formatRelativeTime(thread.latestAt, now)}</span>
            </div>
          ) : null}
          {quote === ''
            ? null
            : (
                <button
                  type="button"
                  className="cwi-quote"
                  data-testid="cwi-thread-focus"
                  onClick={(event) => { event.stopPropagation(); onFocus(thread) }}
                >
                  {quote}
                </button>
              )}
        </>
      ) : compact ? (
        <>
          <div className="cwi-thread-summary">{root === null ? '已解决' : commentBody(root)}</div>
          <div className="cwi-thread-meta">
            <span className="cwi-resolved-mark">✓ 已解决</span>
            <span className="cwi-thread-time">{formatRelativeTime(thread.latestAt, now)}</span>
          </div>
        </>
      ) : (
        <>
          {quote === ''
            ? null
            : (
                <button
                  type="button"
                  className="cwi-quote"
                  data-testid="cwi-thread-focus"
                  onClick={(event) => { event.stopPropagation(); onFocus(thread) }}
                >
                  {quote}
                </button>
              )}
          {root === null ? null : <Comment event={root} now={now} attachmentUrl={attachmentUrl} showMeta={false} />}
          {replies.map((event) => (
            <div key={event.eventId} className="cwi-thread-reply">
              <Comment event={event} now={now} attachmentUrl={attachmentUrl} showMeta />
            </div>
          ))}
        </>
      )}
          {dispatch === null
            ? null
            : (
                <div className="cwi-tstate" data-tone={dispatchTone} data-testid="cwi-thread-dispatch">
                  <span className="cwi-tstate-icon" data-state={dispatch.state} aria-hidden="true" />
                  <span>{dispatchDetailLabel(dispatch.state)}</span>
                  {dispatch.errorCode === null ? null : <span className="cwi-stale">{dispatch.errorCode}</span>}
                  {isRetryableDispatch(dispatch)
                    ? (
                        <button
                          type="button"
                          className="cwi-tstate-retry"
                          data-testid="cwi-dispatch-retry"
                          disabled={dispatchRetryDisabled(retrying, readOnly)}
                          title={dispatchRetryTitle(readOnly)}
                          onClick={(event) => { event.stopPropagation(); onRetry(dispatch) }}
                        >
                          {retrying ? '重试中…' : '重试'}
                        </button>
                      )
                    : null}
                  <span className="cwi-tstate-age">{formatElapsed(dispatch.updatedAt, now)}</span>
                </div>
              )}
          {statusLabel === null
            ? null
            : (
                <div className="cwi-tstate" data-tone={stale ? 'warn' : 'done'}>
                  <span className="cwi-tstate-icon" data-state={stale ? 'stale' : 'moved'} aria-hidden="true" />
                  <span>{statusLabel}</span>
                  {stale ? <span className="cwi-tstate-age">原文已移动</span> : null}
                </div>
              )}
      <div className="cwi-thread-actions">
        {summaryOnly
          ? null
          : (thread.resolved
              ? (expandedByGroup
                  ? null
                  : (
                      <button
                        type="button"
                        className="cwi-thread-action"
                        data-testid="cwi-thread-expand"
                        onClick={() => { setExpanded(value => !value) }}
                      >
                        {expanded ? `收起 ${String(comments.length)} 条` : `已解决 · 展开 ${String(comments.length)} 条`}
                      </button>
                    ))
              : (
                  <button
                    type="button"
                    className="cwi-thread-action"
                    data-testid="cwi-thread-reply"
                    disabled={pending || readOnly}
                    title={readOnly ? '跨会话只读：切到所属会话后才能回复' : undefined}
                    onClick={(event) => { event.stopPropagation(); onReply?.(thread) }}
                  >
                    回复
                  </button>
                ))}
        <button
          type="button"
          className="cwi-thread-action"
          data-testid="cwi-thread-locate"
          onClick={(event) => { event.stopPropagation(); onFocus(thread) }}
        >
          定位
        </button>
        {summaryOnly
          ? null
          : (
              <>
                <span className="cwi-thread-actions-spacer" />
                <button
                  type="button"
                  className="cwi-thread-action"
                  data-testid="cwi-thread-toggle"
                  data-resolved={thread.resolved ? 'true' : 'false'}
                  disabled={pending || readOnly}
                  title={readOnly ? '跨会话只读：切到所属会话后才能修改批注状态' : undefined}
                  onClick={(event) => { event.stopPropagation(); onToggle(thread) }}
                >
                  {thread.resolved ? '重新打开' : '标记已解决 ✓'}
                </button>
              </>
            )}
      </div>
    </article>
  )
}
