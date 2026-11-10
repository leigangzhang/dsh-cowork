/**
 * Session notice renderer for the host A2 `notice` conversation node.
 *
 * The host A2 contract is not available in the running DSH (decision B), so
 * nothing here is registered: `registerNoticeRenderer` feature-detects
 * `ctx.sessionNotices` and returns null without touching the slot registry when
 * the service is missing. The renderer is kept complete so the A2 adapter only
 * has to call `registerNoticeRenderer(ctx)` once the host ships the service.
 *
 * One notice is one card. The card is read-only unless the model gave it an
 * action; actions are plain buttons (no nested interactive elements), and
 * rendering never prompts the model or opens a turn.
 */
import type { ReactElement } from 'react'
import {
  canRegisterNoticeRenderer,
  NOTICE_NODE_KIND,
  NOTICE_SEAT,
  noticeCard,
  type NoticeActionView,
  type NoticeCardView,
  type NoticeContext,
  type NoticeInput,
} from './notice-model.ts'
import type { ClientContext } from './contracts.ts'

export interface NoticeCardProps {
  readonly card: NoticeCardView
  readonly onAction?: (action: NoticeActionView) => void
}

/** One notice card: kind, title, summary, state and its (optional) actions. */
export function NoticeCard({ card, onAction }: NoticeCardProps): ReactElement {
  return (
    <article
      className="cw-notice-card"
      data-notice-kind={card.kind}
      data-notice-status={card.status}
      data-audience={card.audience}
      aria-label={`${card.kindLabel}：${card.title}`}
    >
      <header className="cw-notice-card-head">
        <span className="cw-notice-card-kind">{card.kindLabel}</span>
        <span className="cw-notice-card-status" data-status={card.status}>{card.statusLabel}</span>
      </header>
      <h3 className="cw-notice-card-title">{card.title}</h3>
      {card.summary.length === 0 ? null : <p className="cw-notice-card-summary">{card.summary}</p>}
      {card.actions.length === 0 ? null : (
        <div className="cw-notice-card-actions">
          {card.actions.map(action => (
            <button
              key={action.type}
              type="button"
              className="cw-button"
              data-action={action.type}
              data-tone={action.tone}
              disabled={action.disabled}
              onClick={() => { onAction?.(action) }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </article>
  )
}

export interface NoticeNodeProps {
  readonly notice: NoticeInput
  readonly context: NoticeContext
  readonly onAction?: (action: NoticeActionView) => void
}

/** The node component a host with A2 would mount for `kind: 'notice'`. */
export function NoticeNode({ notice, context, onAction }: NoticeNodeProps): ReactElement | null {
  const card = noticeCard(notice, context)
  if (card === null) return null
  return <NoticeCard card={card} onAction={onAction} />
}

/**
 * Register the notice node in the conversation seat, but only on a host that
 * exposes session notices (A2). Under B this returns null and registers
 * nothing; callers do not need to special-case the host version.
 */
export function registerNoticeRenderer(ctx: ClientContext): (() => void) | null {
  if (!canRegisterNoticeRenderer({ sessionNotices: ctx.sessionNotices })) return null
  return ctx.slots.inject(NOTICE_SEAT, () => ctx.slots.register({
    name: NOTICE_SEAT,
    key: NOTICE_NODE_KIND,
    kind: NOTICE_NODE_KIND,
  }, NoticeNode))
}
