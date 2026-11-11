/**
 * Browser components for the Cowork request inbox (topic inbox, 2026-11-10).
 *
 * One inbox row is either a request thread — persisted left message, the card
 * for its kind, then the right-hand user reply once resolved — or a centered
 * gray notification note. All presentation decisions come from
 * `inbox-model.ts`; this module only holds the per-card input state (review
 * comment, question paging/answers, plan revise box) and renders it.
 *
 * The panel owns the wire read, the resolve write, the in-flight set and the
 * receipts; every card action is a `<button>` and every input has a `<label>`,
 * and the `data-testid` names below are the contract the GUI verification
 * drives, so they must not be renamed.
 */
import { useId, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { InboxAnswerInput, RequestAction } from '../inbox-contract.ts'
import type { PanelErrorInfo } from './contracts.ts'
import {
  INBOX_ALL_TOPICS_LABEL,
  INBOX_EMPTY_LABEL,
  INBOX_LOADING_LABEL,
  INBOX_TITLE,
  REQUEST_ACTION_LABELS,
  type InboxNoteView,
  type InboxRequestView,
  type InboxViewModel,
  answersComplete,
  unansweredAnswerHint,
  unansweredQuestionCount,
  type InboxAnswerDraft,
} from './inbox-model.ts'

/** One per-row receipt: submission/open feedback that never fakes a reply. */
export interface InboxReceipt {
  readonly kind: 'ok' | 'warn' | 'error'
  readonly text: string
}

/** What a card action sends along with the action name. */
export interface InboxActionInput {
  readonly comment?: string
  readonly answers?: readonly InboxAnswerInput[]
}

export interface InboxPanelProps {
  /** Null until the first read succeeds. */
  readonly view: InboxViewModel | null
  readonly phase: 'loading' | 'ready' | 'error'
  readonly error: PanelErrorInfo | null
  /** Request ids with a resolve/open write in flight. */
  readonly pendingRequestIds: ReadonlySet<string>
  /** Per-row receipts keyed by request id or notice id. */
  readonly receipts: ReadonlyMap<string, InboxReceipt>
  readonly onResolve: (item: InboxRequestView, action: RequestAction, input: InboxActionInput) => void
  readonly onOpen: (item: InboxRequestView | InboxNoteView) => void
  readonly onClearFilter: () => void
  readonly onRetry: () => void
}

/** Narrowed request view per kind, so a card reads its own payload. */
type ReviewRequestView = Extract<InboxRequestView, { requestKind: 'user-review' }>
type AuthorizationRequestView = Extract<InboxRequestView, { requestKind: 'authorization' }>
type QuestionRequestView = Extract<InboxRequestView, { requestKind: 'question' }>
type PlanRequestView = Extract<InboxRequestView, { requestKind: 'plan' }>

/** The inbox column: title, filter, rows, empty/loading/error states. */
export function InboxPanel({
  view,
  phase,
  error,
  pendingRequestIds,
  receipts,
  onResolve,
  onOpen,
  onClearFilter,
  onRetry,
}: InboxPanelProps): ReactElement {
  return (
    <section className="cw-inbox" data-testid="cw-inbox" aria-label="收件箱">
      <header className="cw-inbox-head">
        <span className="cw-inbox-heading">
          {INBOX_TITLE} · {view?.filterTopicTitle ?? INBOX_ALL_TOPICS_LABEL}
          {' '}
          <span className="cw-inbox-count" data-testid="cw-inbox-title-count">
            {view === null ? 0 : view.titleCount}
          </span>
        </span>
        {view !== null && view.filterTopicTitle !== null ? (
          <button
            type="button"
            className="cw-inbox-filter-clear"
            data-testid="cw-inbox-filter-clear"
            onClick={onClearFilter}
            title="清除主题筛选"
            aria-label="清除主题筛选"
          >
            只看「{view.filterTopicTitle}」×
          </button>
        ) : null}
        <span className="cw-inbox-hint">按时间从新到旧</span>
      </header>

      {error === null ? null : (
        <div className="cw-inbox-error" data-testid="cw-inbox-error" role="status" aria-live="polite">
          <p className="cw-inbox-error-text">读取收件箱失败：{error.message}</p>
          <button type="button" className="cw-button" onClick={onRetry}>重试</button>
        </div>
      )}

      <div className="cw-inbox-list">
        {view === null && phase === 'loading' ? (
          <p className="cw-inbox-loading" role="status">{INBOX_LOADING_LABEL}</p>
        ) : null}
        {view !== null && view.items.length === 0 ? (
          <p className="cw-inbox-empty" data-testid="cw-inbox-empty">{INBOX_EMPTY_LABEL}</p>
        ) : null}
        {view === null ? null : view.items.map((item) => item.kind === 'request' ? (
          <RequestThread
            key={`request:${item.requestId}`}
            item={item}
            pending={pendingRequestIds.has(item.requestId)}
            receipt={receipts.get(item.requestId) ?? null}
            onResolve={onResolve}
            onOpen={onOpen}
          />
        ) : (
          <InboxNote
            key={`notification:${item.noticeId}`}
            item={item}
            pending={pendingRequestIds.has(item.noticeId)}
            receipt={receipts.get(item.noticeId) ?? null}
            onOpen={onOpen}
          />
        ))}
        {view !== null && view.truncated ? (
          <p className="cw-inbox-truncated">只显示最近的收件箱记录，更早的已折叠。</p>
        ) : null}
      </div>
    </section>
  )
}

interface RequestThreadProps {
  readonly item: InboxRequestView
  readonly pending: boolean
  readonly receipt: InboxReceipt | null
  readonly onResolve: InboxPanelProps['onResolve']
  readonly onOpen: InboxPanelProps['onOpen']
}

/** One request thread: left message, card, then the resolved right reply. */
export function RequestThread({
  item,
  pending,
  receipt,
  onResolve,
  onOpen,
}: RequestThreadProps): ReactElement {
  return (
    <article
      className="cw-thread"
      data-testid="cw-inbox-item"
      data-item-kind="request"
      data-request-id={item.requestId}
      data-request-kind={item.requestKind}
      data-status={item.status}
      data-pending={item.pending ? 'true' : 'false'}
      data-topic-id={item.topicId}
    >
      <div className="cw-thread-msg cw-thread-msg-in">
        <span className="cw-thread-avatar" aria-hidden="true">题</span>
        <p className="cw-thread-bubble" data-testid="cw-inbox-request-message">{item.requestMessage}</p>
      </div>
      <div
        className="cw-req-card"
        data-testid="cw-inbox-request-card"
        data-request-kind={item.requestKind}
        data-status={item.status}
      >
        <RequestCard
          item={item}
          pending={pending}
          onResolve={onResolve}
          onOpen={onOpen}
        />
        {receipt === null ? null : (
          <p
            className="cw-inbox-receipt"
            data-testid="cw-inbox-receipt"
            data-kind={receipt.kind}
            role="status"
            aria-live="polite"
          >
            {receipt.text}
          </p>
        )}
      </div>
      {item.showsResolution ? (
        <div className="cw-thread-msg cw-thread-msg-out">
          <p className="cw-thread-bubble" data-testid="cw-inbox-resolution">{item.resolutionMessage}</p>
          <span className="cw-thread-avatar cw-thread-avatar-user" aria-hidden="true">你</span>
        </div>
      ) : null}
    </article>
  )
}

interface RequestCardProps {
  readonly item: InboxRequestView
  readonly pending: boolean
  readonly onResolve: InboxPanelProps['onResolve']
  readonly onOpen: InboxPanelProps['onOpen']
}

/** Dispatch one request card by kind. */
function RequestCard({ item, pending, onResolve, onOpen }: RequestCardProps): ReactElement {
  switch (item.requestKind) {
    case 'user-review':
      return <UserReviewCard item={item} pending={pending} onResolve={onResolve} />
    case 'authorization':
      return <AuthorizationCard item={item} pending={pending} onResolve={onResolve} />
    case 'question':
      return <QuestionCard item={item} pending={pending} onResolve={onResolve} />
    case 'plan':
      return <PlanCard item={item} pending={pending} onResolve={onResolve} onOpen={onOpen} />
  }
}

interface CardHeadProps {
  readonly statusText: string
  readonly tone: 'warn' | 'neutral' | 'done'
  readonly children?: ReactNode
}

/** The card title bar: status on the left, an open link on the right. */
function CardHead({ statusText, tone, children }: CardHeadProps): ReactElement {
  return (
    <div className="cw-req-head" data-tone={tone}>
      <span className="cw-req-status">{statusText}</span>
      {children}
    </div>
  )
}

interface ActionButtonsProps {
  readonly actions: readonly RequestAction[]
  readonly pending: boolean
  readonly isDisabled?: (action: RequestAction) => boolean
  readonly onAction: (action: RequestAction) => void
}

/** The card's action row; every control is a plain button. */
function ActionButtons({ actions, pending, isDisabled, onAction }: ActionButtonsProps): ReactElement {
  return (
    <div className="cw-req-actions">
      {actions.map(action => (
        <button
          key={action}
          type="button"
          className="cw-req-action"
          data-testid="cw-inbox-action"
          data-action={action}
          disabled={pending || (isDisabled?.(action) ?? false)}
          onClick={() => { onAction(action) }}
        >
          {REQUEST_ACTION_LABELS[action]}
        </button>
      ))}
    </div>
  )
}

interface ReviewCardProps {
  readonly item: ReviewRequestView
  readonly pending: boolean
  readonly onResolve: InboxPanelProps['onResolve']
}

/**
 * The user-review card: purpose, changed paths and verification rows are
 * shown directly (never folded); the return comment is optional.
 */
function UserReviewCard({ item, pending, onResolve }: ReviewCardProps): ReactElement {
  const [comment, setComment] = useState('')
  const commentId = useId()
  const changedPaths = item.payload.changedPaths ?? []
  const verification = item.payload.verification ?? []
  return (
    <>
      <CardHead statusText={item.statusText} tone={item.pending ? 'warn' : 'done'} />
      <div className="cw-req-body">
        <p className="cw-req-text">{item.payload.purpose}</p>
        {changedPaths.length === 0 ? null : (
          <div className="cw-req-section">
            <span className="cw-req-label">改动文件（{changedPaths.length}）</span>
            <ul className="cw-req-paths">
              {changedPaths.map(path => <li key={path}><code>{path}</code></li>)}
            </ul>
          </div>
        )}
        {verification.length === 0 ? null : (
          <div className="cw-req-section">
            <span className="cw-req-label">验证</span>
            <ul className="cw-req-verify">
              {verification.map(row => (
                <li key={`${row.command}:${row.exitCode}`}>
                  <code>{row.command}</code>
                  <span className="cw-req-exit" data-exit={row.exitCode === 0 ? 'ok' : 'failed'}>exit {row.exitCode}</span>
                  {row.evidence.trim() === '' ? null : <span className="cw-req-evidence">{row.evidence}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {item.actions.length === 0 ? null : (
        <div className="cw-req-actions-block">
          <label className="cw-req-field" htmlFor={commentId}>
            <span className="cw-req-label">退回评论（可选）</span>
            <textarea
              id={commentId}
              className="cw-req-input"
              data-testid="cw-inbox-comment"
              rows={2}
              value={comment}
              disabled={pending}
              onChange={(event) => { setComment(event.target.value) }}
            />
          </label>
          <ActionButtons
            actions={item.actions}
            pending={pending}
            onAction={action => { onResolve(item, action, comment.trim() === '' ? {} : { comment }) }}
          />
        </div>
      )}
    </>
  )
}

interface AuthorizationCardProps {
  readonly item: AuthorizationRequestView
  readonly pending: boolean
  readonly onResolve: InboxPanelProps['onResolve']
}

/** The authorization card: summary, optional monospaced command, deny/allow. */
function AuthorizationCard({ item, pending, onResolve }: AuthorizationCardProps): ReactElement {
  return (
    <>
      <CardHead statusText={item.statusText} tone={item.pending ? 'warn' : 'done'} />
      <div className="cw-req-body">
        <p className="cw-req-text">{item.payload.summary}</p>
        {item.payload.command === undefined ? null : (
          <code className="cw-req-command">{item.payload.command}</code>
        )}
      </div>
      {item.actions.length === 0 ? null : (
        <ActionButtons
          actions={item.actions}
          pending={pending}
          onAction={action => { onResolve(item, action, {}) }}
        />
      )}
    </>
  )
}

/** The card's per-question draft; the model owns the answered rule. */
type QuestionAnswers = InboxAnswerDraft

interface QuestionCardProps {
  readonly item: QuestionRequestView
  readonly pending: boolean
  readonly onResolve: InboxPanelProps['onResolve']
}

/**
 * The ask-user card: one question per page with `1/N`, single-choice or
 * multi-choice options, an optional free-text answer, then skip/submit.
 */
function QuestionCard({ item, pending, onResolve }: QuestionCardProps): ReactElement {
  const [page, setPage] = useState(0)
  const [answers, setAnswers] = useState<Readonly<Record<string, QuestionAnswers>>>({})
  const answerId = useId()
  const questions = item.payload.questions
  const index = questions.length === 0 ? 0 : Math.min(page, questions.length - 1)
  const current = questions[index]
  const answerOf = (questionId: string): QuestionAnswers => answers[questionId] ?? { selected: [], text: '' }
  const updateAnswer = (questionId: string, patch: Partial<QuestionAnswers>): void => {
    setAnswers((previous) => {
      const base = previous[questionId] ?? { selected: [], text: '' }
      return { ...previous, [questionId]: { ...base, ...patch } }
    })
  }
  // The host requires every question to be answered; the card blocks submit
  // until then and says how many are still open, so a partial submit never
  // round-trips into an English `inbox/invalid-answer`.
  const unanswered = unansweredQuestionCount(questions, answers)
  const allAnswered = answersComplete(questions, answers)
  const submit = (): void => {
    const payload: InboxAnswerInput[] = []
    for (const question of questions) {
      const answer = answers[question.id]
      if (answer === undefined) continue
      const text = answer.text.trim()
      if (answer.selected.length === 0 && text === '') continue
      payload.push({
        questionId: question.id,
        ...(answer.selected.length === 0 ? {} : { selected: answer.selected }),
        ...(text === '' ? {} : { text }),
      })
    }
    onResolve(item, 'submit', { answers: payload })
  }
  const groupName = `cw-answer-${item.requestId}`
  const selected = current === undefined ? [] : answerOf(current.id).selected
  return (
    <>
      <CardHead statusText={item.statusText} tone={item.pending ? 'warn' : 'neutral'} />
      {current === undefined ? (
        <div className="cw-req-body"><p className="cw-req-text">这个问题没有题目内容。</p></div>
      ) : (
        <div className="cw-req-body">
          <p className="cw-req-question">{current.prompt}</p>
          {current.options === undefined || current.options.length === 0 ? null : (
            <div className={current.mode === 'multi' ? 'cw-inbox-options cw-inbox-options-multi' : 'cw-inbox-options'}>
              {current.options.map((option) => {
                const checked = selected.includes(option.id)
                const toggle = (): void => {
                  if (pending) return
                  if (current.mode === 'multi') {
                    const next = checked
                      ? selected.filter(id => id !== option.id)
                      : [...selected, option.id]
                    updateAnswer(current.id, { selected: next })
                  } else {
                    updateAnswer(current.id, { selected: [option.id] })
                  }
                }
                return (
                  <label
                    key={option.id}
                    className="cw-inbox-option"
                    data-testid="cw-inbox-option"
                    data-option-id={option.id}
                    data-selected={checked ? 'true' : 'false'}
                  >
                    <input
                      type={current.mode === 'multi' ? 'checkbox' : 'radio'}
                      name={current.mode === 'multi' ? undefined : groupName}
                      checked={checked}
                      disabled={pending}
                      onChange={toggle}
                    />
                    <span className="cw-inbox-option-body">
                      <span className="cw-inbox-option-label">{option.label}</span>
                      {option.recommended === true ? <span className="cw-inbox-option-tag">推荐</span> : null}
                      {option.description === undefined ? null : (
                        <span className="cw-inbox-option-desc">{option.description}</span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
          {current.allowText === true ? (
            <label className="cw-req-field" htmlFor={answerId}>
              <span className="cw-req-label">输入你的答案</span>
              <input
                id={answerId}
                type="text"
                className="cw-req-input"
                data-testid="cw-inbox-answer"
                value={answerOf(current.id).text}
                disabled={pending}
                onChange={(event) => { updateAnswer(current.id, { text: event.target.value }) }}
              />
            </label>
          ) : null}
          <div className="cw-inbox-pager">
            <button
              type="button"
              className="cw-inbox-pager-button"
              aria-label="上一题"
              disabled={index === 0 || pending}
              onClick={() => { setPage(Math.max(0, index - 1)) }}
            >
              ‹
            </button>
            <span className="cw-inbox-pager-label">{questions.length === 0 ? 0 : index + 1}/{questions.length}</span>
            <button
              type="button"
              className="cw-inbox-pager-button"
              aria-label="下一题"
              disabled={index >= questions.length - 1 || pending}
              onClick={() => { setPage(Math.min(questions.length - 1, index + 1)) }}
            >
              ›
            </button>
          </div>
        </div>
      )}
      {item.actions.length === 0 || !pending || unanswered === 0 ? null : (
        <p
          className="cw-inbox-hint"
          data-testid="cw-inbox-answer-hint"
          role="status"
          aria-live="polite"
        >
          {unansweredAnswerHint(unanswered)}
        </p>
      )}
      {item.actions.length === 0 ? null : (
        <ActionButtons
          actions={item.actions}
          pending={pending}
          isDisabled={action => action === 'submit' && !allAnswered}
          onAction={(action) => {
            if (action === 'submit') submit()
            else onResolve(item, action, {})
          }}
        />
      )}
    </>
  )
}

interface PlanCardProps {
  readonly item: PlanRequestView
  readonly pending: boolean
  readonly onResolve: InboxPanelProps['onResolve']
  readonly onOpen: InboxPanelProps['onOpen']
}

/**
 * The PLAN card: title and summary, "查看全文" through the host file opener,
 * "同意执行", and an inline revise box that expands from "要求修改".
 */
function PlanCard({ item, pending, onResolve, onOpen }: PlanCardProps): ReactElement {
  const [revising, setRevising] = useState(false)
  const [comment, setComment] = useState('')
  const commentId = useId()
  const canOpen = item.payload.planPath.trim() !== ''
  return (
    <>
      <CardHead statusText={item.statusText} tone={item.pending ? 'warn' : 'done'}>
        {canOpen ? (
          <button
            type="button"
            className="cw-req-open"
            data-testid="cw-inbox-open"
            onClick={() => { onOpen(item) }}
          >
            查看全文 ›
          </button>
        ) : null}
      </CardHead>
      <div className="cw-req-body">
        {item.payload.planTitle === undefined ? null : (
          <p className="cw-req-plan-title">{item.payload.planTitle}</p>
        )}
        <p className="cw-req-text">{item.summary}</p>
      </div>
      {revising ? (
        <div className="cw-req-revise">
          <label className="cw-req-field" htmlFor={commentId}>
            <span className="cw-req-label">修改要求</span>
            <input
              id={commentId}
              type="text"
              className="cw-req-input"
              data-testid="cw-inbox-comment"
              value={comment}
              disabled={pending}
              onChange={(event) => { setComment(event.target.value) }}
            />
          </label>
          <div className="cw-req-actions">
            <button
              type="button"
              className="cw-req-action"
              data-testid="cw-inbox-action"
              data-action="cancel-revise"
              disabled={pending}
              onClick={() => { setRevising(false); setComment('') }}
            >
              取消
            </button>
            <button
              type="button"
              className="cw-req-action"
              data-testid="cw-inbox-action"
              data-action="revise"
              disabled={pending || comment.trim() === ''}
              onClick={() => { onResolve(item, 'revise', { comment }) }}
            >
              提交
            </button>
          </div>
        </div>
      ) : item.actions.length === 0 ? null : (
        <ActionButtons
          actions={item.actions}
          pending={pending}
          onAction={(action) => {
            if (action === 'revise') {
              setRevising(true)
              return
            }
            onResolve(item, action, {})
          }}
        />
      )}
    </>
  )
}

interface InboxNoteProps {
  readonly item: InboxNoteView
  readonly pending: boolean
  readonly receipt: InboxReceipt | null
  readonly onOpen: InboxPanelProps['onOpen']
}

/** One centered gray notification note; only a proposal offers a link. */
function InboxNote({ item, pending, receipt, onOpen }: InboxNoteProps): ReactElement {
  const showOpen = item.canOpen && item.proposalPath !== null
  return (
    <div
      className="cw-inbox-item-note"
      data-testid="cw-inbox-item"
      data-item-kind="notification"
      data-notice-id={item.noticeId}
      data-topic-id={item.topicId}
    >
      <div className="cw-inbox-note" data-testid="cw-inbox-note" data-notice-kind={item.noticeKind}>
        <span className="cw-inbox-note-label">{item.noteLabel} · {item.topicTitle}</span>
        <span className="cw-inbox-note-summary">{item.summary}</span>
        {showOpen ? (
          <button
            type="button"
            className="cw-inbox-note-link"
            data-testid="cw-inbox-open"
            disabled={pending}
            onClick={() => { onOpen(item) }}
          >
            查看提案
          </button>
        ) : null}
        <span className="cw-inbox-note-time">{item.timeLabel}</span>
      </div>
      {receipt === null ? null : (
        <p
          className="cw-inbox-receipt"
          data-testid="cw-inbox-receipt"
          data-kind={receipt.kind}
          role="status"
          aria-live="polite"
        >
          {receipt.text}
        </p>
      )}
    </div>
  )
}
