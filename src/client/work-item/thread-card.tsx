/**
 * One comment thread card in the work-item rail.
 *
 * The card owns no data: the viewer supplies the folded thread, its delivery
 * batch, and the callbacks. It renders the anchor quote, the comment runs with
 * author avatars, delivery state, and resolve/reply actions. A resolved thread
 * folds to one row instead of disappearing.
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import type { ArtifactDispatchSummary } from '../../panel/artifact-contract.js'
import {
  anchorLabel,
  anchorStatusLabel,
  commentAuthor,
  commentBody,
  dispatchLabel,
  formatBytes,
  formatRelativeTime,
  isRetryableDispatch,
  type WorkItemThread,
} from './model.ts'

/** Props of one thread card. */
export interface ThreadCardProps {
  readonly thread: WorkItemThread
  readonly now: Date
  readonly pending: boolean
  readonly dispatch: ArtifactDispatchSummary | null
  readonly retrying: boolean
  readonly onToggle: (thread: WorkItemThread) => void
  readonly onReply: (thread: WorkItemThread) => void
  readonly onRetry: (dispatch: ArtifactDispatchSummary) => void
  readonly onFocus: (thread: WorkItemThread) => void
  readonly attachmentUrl: (attachmentId: string) => string
}

/**
 * Render one thread card.
 * @param props - the folded thread, its delivery batch, and rail callbacks.
 * @returns the card; a resolved thread keeps its row and folds its comments.
 */
export function ThreadCard({
  thread,
  now,
  pending,
  dispatch,
  retrying,
  onToggle,
  onReply,
  onRetry,
  onFocus,
  attachmentUrl,
}: ThreadCardProps): ReactElement {
  const stale = anchorStatusLabel(thread.anchorStatus)
  const [expanded, setExpanded] = useState(false)
  const showComments = !thread.resolved || expanded
  return (
    <div className="cwi-thread" data-testid="cwi-thread" data-thread-id={thread.threadId} data-resolved={thread.resolved ? 'true' : 'false'}>
      <div className="cwi-thread-meta">
        <span>{anchorLabel(thread.anchor)}</span>
        {stale === null ? null : <span className="cwi-stale">{stale}</span>}
        <span>{formatRelativeTime(thread.latestAt, now)}</span>
        {dispatch === null ? null : (
          <span className="cwi-thread-meta" data-testid="cwi-thread-dispatch">
            <span
              className="cwi-chip"
              data-tone={dispatch.state === 'failed' || dispatch.state === 'blocked' ? 'error' : (dispatch.state === 'replied' ? 'done' : 'pending')}
            >
              {dispatchLabel(dispatch.state)}
            </span>
            {dispatch.errorCode === null ? null : <span className="cwi-stale">{dispatch.errorCode}</span>}
            {isRetryableDispatch(dispatch) ? (
              <button
                type="button"
                className="cwi-secondary"
                data-testid="cwi-dispatch-retry"
                disabled={retrying}
                onClick={() => { onRetry(dispatch) }}
              >
                {retrying ? '重试中…' : '重试'}
              </button>
            ) : null}
          </span>
        )}
        <span className="cwi-toolbar-spacer" style={{ flex: 1 }} />
        {thread.resolved ? null : (
          <button
            type="button"
            className="cwi-secondary"
            data-testid="cwi-thread-reply"
            disabled={pending}
            onClick={() => { onReply(thread) }}
          >
            回复
          </button>
        )}
        <button
          type="button"
          className="cwi-secondary"
          data-testid="cwi-thread-toggle"
          data-resolved={thread.resolved ? 'true' : 'false'}
          disabled={pending}
          onClick={() => { onToggle(thread) }}
        >
          {thread.resolved ? '重新打开' : '标记已解决'}
        </button>
      </div>
      {thread.anchor !== null && 'quote' in thread.anchor && thread.anchor.quote !== ''
        ? (
            <button type="button" className="cwi-quote" data-testid="cwi-thread-focus" onClick={() => { onFocus(thread) }}>
              {thread.anchor.quote}
            </button>
          )
        : null}
      {thread.resolved ? (
        <button type="button" className="cwi-secondary" data-testid="cwi-thread-expand" onClick={() => { setExpanded(value => !value) }}>
          {expanded ? `收起 ${String(thread.comments.length)} 条` : `已解决 · 展开 ${String(thread.comments.length)} 条`}
        </button>
      ) : null}
      {(showComments ? thread.comments : []).map((event) => (
        <div key={event.eventId} className={event.type === 'reply' ? 'cwi-thread-reply' : undefined}>
          <div className="cwi-thread-meta">
            {(event.type === 'create' || event.type === 'reply')
              ? (
                  <span className="cwi-avatar" data-author={event.author === 'model' ? 'model' : 'user'} aria-hidden="true">
                    {event.author === 'model' ? 'M' : 'Y'}
                  </span>
                )
              : null}
            <span className="cwi-comment-author">{commentAuthor(event)}</span>
            <span>{formatRelativeTime(event.createdAt, now)}</span>
          </div>
          <div className="cwi-thread-body">{commentBody(event)}</div>
          {((event.type === 'create' || event.type === 'reply') ? event.attachments ?? [] : []).map((attachment) => (
            attachment.mediaType.startsWith('image/')
              ? (
                  <img
                    key={attachment.attachmentId}
                    className="cwi-attachment-thumb"
                    data-testid="cwi-attachment-thumb"
                    src={attachmentUrl(attachment.attachmentId)}
                    alt={attachment.name}
                  />
                )
              : (
                  <a
                    key={attachment.attachmentId}
                    className="cwi-attachment-link"
                    data-testid="cwi-attachment-link"
                    href={attachmentUrl(attachment.attachmentId)}
                    download={attachment.name}
                  >
                    {attachment.name}
                  </a>
                )
          ))}
          {((event.type === 'create' || event.type === 'reply') ? event.attachments ?? [] : []).map((attachment) => (
            <span key={`${attachment.attachmentId}-meta`} className="cwi-thread-meta" data-testid="cwi-attachment-meta">
              {attachment.name} · {attachment.mediaType} · {formatBytes(attachment.size)}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}
