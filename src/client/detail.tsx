/**
 * One topic's detail: state, resolution source, digest/scope/owned paths, the
 * work-item table, the review-request cards (range, verdict, findings,
 * verification) and the topic's activity tail — plus the write actions the
 * panel offers (open / resolve / reopen / move / copy path).
 *
 * The panel owns data and writes; this component renders and keeps only the
 * move form's local form state. Every action receipt arrives through
 * `feedback`, so a failed write is visible instead of silent.
 */
import { useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import type { PanelReviewRequest, PanelTopic, TopicResponse } from '../api-contract.ts'
import {
  findingSeverityLabel,
  findingSeverityTone,
  formatLocalTimestamp,
  formatRelativeTime,
  moveIntentPrefill,
  resolvedByLabel,
  shortCommit,
  shortTopicId,
  topicActions,
  workItemStatusLabel,
  workItemStatusTone,
} from './model.ts'
import { ExitChip, ReviewBadge, StatusBadge } from './chips.tsx'

/** Where the detail fetch stands for the selected topic. */
export type DetailPhase = 'idle' | 'loading' | 'ready' | 'error'

/** One visible action receipt (open / resolve / reopen / move / copy). */
export interface DetailFeedback {
  readonly kind: 'ok' | 'failed'
  readonly text: string
}

export interface TopicDetailProps {
  readonly topic: PanelTopic
  readonly detail: TopicResponse | null
  readonly detailPhase: DetailPhase
  readonly detailError: string | null
  readonly nowMs: number
  readonly feedback: DetailFeedback | null
  readonly canOpen: boolean
  readonly openHint: string
  /** Other open topics this topic's routing may be moved to, in overview order. */
  readonly moveTargets: readonly PanelTopic[]
  readonly onOpen: () => void
  readonly onResolve: () => void
  readonly onReopen: () => void
  readonly onMove: (fromTopicId: string, toTopicId: string, intent: string) => void
  readonly onCopyPath: () => void
  /** Drill-down return control; `null` in split mode. */
  readonly onBack: (() => void) | null
}

/** Pending title fallback so the header is never blank. */
const UNTITLED = '（无标题）'

/** `file:line`, `file`, or null when a review row names no location. */
function findingLocation(file: string | undefined, line: number | undefined): string | null {
  if (file === undefined) return null
  return line === undefined ? file : `${file}:${line}`
}

/** The findings of one review request; malformed rows never reach this point. */
function ReviewFindings({ request }: { readonly request: PanelReviewRequest }): ReactElement | null {
  if (request.findings.length === 0) return null
  return (
    <ul className="cw-finding-list">
      {request.findings.map(finding => {
        const location = findingLocation(finding.file, finding.line)
        return (
          <li key={finding.id} className="cw-finding" data-tone={findingSeverityTone(finding.severity)}>
            <div className="cw-finding-head">
              <span className="cw-finding-severity" data-tone={findingSeverityTone(finding.severity)}>
                {findingSeverityLabel(finding.severity)}
              </span>
              <code className="cw-code">{finding.id}</code>
              {location === null ? null : <code className="cw-finding-location">{location}</code>}
            </div>
            <p className="cw-finding-problem">{finding.problem}</p>
            <p className="cw-finding-fix">修复：{finding.requiredFix}</p>
          </li>
        )
      })}
    </ul>
  )
}

/** One review-request card: range, verdict, summary, findings, verification. */
function ReviewCard({
  request,
  nowMs,
}: {
  readonly request: PanelReviewRequest
  readonly nowMs: number
}): ReactElement {
  return (
    <li className="cw-review-card" data-status={request.status}>
      <div className="cw-review-card-head">
        <code className="cw-code" title={request.requestId}>{shortTopicId(request.requestId)}</code>
        <ReviewBadge
          status={request.status}
          reviewedAt={request.reviewedAt}
          findingCount={request.findings.length}
        />
        <span className="cw-review-time" title={formatLocalTimestamp(request.requestedAt)}>
          请求于 {formatRelativeTime(request.requestedAt, nowMs)}
        </span>
        {request.reviewedAt === null ? null : (
          <span className="cw-review-time" title={formatLocalTimestamp(request.reviewedAt)}>
            审查于 {formatRelativeTime(request.reviewedAt, nowMs)}
          </span>
        )}
      </div>

      <p className="cw-review-purpose">{request.purpose.length > 0 ? request.purpose : '（没有填写评审目的）'}</p>
      {request.summary === null ? null : <p className="cw-summary">{request.summary}</p>}

      <div className="cw-review-range">
        <span className="cw-muted">范围</span>
        <code className="cw-sha" title={`${request.baseCommit} → ${request.headCommit}`}>
          {shortCommit(request.baseCommit)}→{shortCommit(request.headCommit)}
        </code>
        {request.workItemId === null ? null : (
          <code className="cw-code">工作项 {shortTopicId(request.workItemId)}</code>
        )}
      </div>

      {request.changedPaths.length === 0 ? null : (
        <ul className="cw-path-list">
          {request.changedPaths.map(path => <li key={path} className="cw-path">{path}</li>)}
        </ul>
      )}

      <ReviewFindings request={request} />

      {request.verification.length === 0 ? null : (
        <ul className="cw-verify-list">
          {request.verification.map((item, index) => (
            <li key={`${item.command}-${index}`} className="cw-verify">
              <div className="cw-verify-head">
                <code className="cw-verify-command">{item.command}</code>
                <ExitChip exitCode={item.exitCode} />
              </div>
              <p className="cw-verify-evidence">{item.evidence}</p>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** Detail pane for the selected topic. */
export function TopicDetail({
  topic,
  detail,
  detailPhase,
  detailError,
  nowMs,
  feedback,
  canOpen,
  openHint,
  moveTargets,
  onOpen,
  onResolve,
  onReopen,
  onMove,
  onCopyPath,
  onBack,
}: TopicDetailProps): ReactElement {
  const [moveOpen, setMoveOpen] = useState(false)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [intent, setIntent] = useState('')

  const title = topic.title.length > 0 ? topic.title : UNTITLED
  const actions = topicActions(topic)
  const canMoveNow = moveTargets.length > 0

  const toggleMoveForm = (): void => {
    if (moveOpen) {
      setMoveOpen(false)
      return
    }
    setTargetId(moveTargets[0]?.topicId ?? null)
    setIntent(moveIntentPrefill(topic))
    setMoveOpen(true)
  }

  const submitMove = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (targetId === null || intent.trim().length === 0) return
    onMove(topic.topicId, targetId, intent.trim())
    setMoveOpen(false)
  }

  return (
    <section className="cw-detail" role="region" aria-label={`主题详情：${title}`}>
      {onBack === null ? null : (
        <button type="button" className="cw-back" onClick={onBack} aria-label="返回主题列表" autoFocus>
          ← 全部主题
        </button>
      )}

      <h2 className="cw-detail-subject" title={topic.title}>{title}</h2>

      <div className="cw-detail-meta">
        <StatusBadge status={topic.status} />
        <span>主题 <code className="cw-code">{shortTopicId(topic.topicId)}</code></span>
        <span title={formatLocalTimestamp(topic.updatedAt)}>
          更新于 {formatRelativeTime(topic.updatedAt, nowMs)}
        </span>
        {topic.resolvedBy === null ? null : (
          <span className="cw-resolved-source">来源：{resolvedByLabel(topic.resolvedBy)}</span>
        )}
        {topic.resolvedAt === null ? null : (
          <span title={formatLocalTimestamp(topic.resolvedAt)}>
            解决于 {formatRelativeTime(topic.resolvedAt, nowMs)}
          </span>
        )}
        {topic.activeWorkItems === 0 ? null : (
          <span className="cw-active-work">{topic.activeWorkItems} 个工作项在跑</span>
        )}
      </div>

      <div className="cw-actions">
        <button
          type="button"
          className="cw-button-primary"
          onClick={onOpen}
          disabled={!canOpen}
          title={canOpen ? '在会话区打开这个主题' : openHint}
        >
          打开主题
        </button>
        {actions.canResolve ? (
          <button type="button" className="cw-button" onClick={onResolve}>标记已解决</button>
        ) : null}
        {actions.canReopen ? (
          <button type="button" className="cw-button" onClick={onReopen}>重新打开</button>
        ) : null}
        {actions.canMove ? (
          <button
            type="button"
            className="cw-button"
            onClick={toggleMoveForm}
            disabled={!canMoveNow}
            title={canMoveNow ? '把这个主题收到的路由改投到另一个未解决主题' : '没有可改投的其它未解决主题'}
          >
            移动到其他主题
          </button>
        ) : null}
        <button type="button" className="cw-button" onClick={onCopyPath} title="复制项目仓库的绝对路径">
          复制路径
        </button>
      </div>

      {actions.canResolve && actions.resolveWarning !== null ? (
        <p className="cw-warning">{actions.resolveWarning}</p>
      ) : null}

      {feedback === null ? null : (
        <p className="cw-feedback" data-kind={feedback.kind} role="status" aria-live="polite">
          {feedback.text}
        </p>
      )}

      {moveOpen ? (
        <form className="cw-move-form" onSubmit={submitMove}>
          <label className="cw-field">
            <span className="cw-field-label">目标主题</span>
            <select
              className="cw-select"
              value={targetId ?? ''}
              onChange={event => setTargetId(event.target.value)}
              disabled={!canMoveNow}
            >
              {moveTargets.map(target => (
                <option key={target.topicId} value={target.topicId}>
                  {target.title.length > 0 ? target.title : shortTopicId(target.topicId)}
                </option>
              ))}
            </select>
          </label>
          <label className="cw-field">
            <span className="cw-field-label">改投理由</span>
            <input
              className="cw-input"
              value={intent}
              maxLength={500}
              onChange={event => setIntent(event.target.value)}
              placeholder="说明为什么改投，例如：这条路由实际属于另一个主题"
            />
          </label>
          <div className="cw-form-actions">
            <button
              type="submit"
              className="cw-button-primary"
              disabled={targetId === null || intent.trim().length === 0}
            >
              确认移动
            </button>
            <button type="button" className="cw-button" onClick={() => setMoveOpen(false)}>取消</button>
          </div>
          {canMoveNow ? null : <p className="cw-muted">没有可改投的其它未解决主题。</p>}
        </form>
      ) : null}

      <div className="cw-section">
        <h3 className="cw-section-title">摘要</h3>
        <p className="cw-summary">{topic.digest.length > 0 ? topic.digest : '（还没有摘要）'}</p>
        {topic.scope.length === 0 ? null : <p className="cw-muted">范围：{topic.scope}</p>}
        {topic.ownedPaths.length === 0 ? null : (
          <ul className="cw-path-list">
            {topic.ownedPaths.map(path => <li key={path} className="cw-path">{path}</li>)}
          </ul>
        )}
      </div>

      <div className="cw-section">
        <h3 className="cw-section-title">工作项</h3>
        {detailPhase === 'loading' ? <p className="cw-muted">正在读取工作项…</p> : null}
        {detailPhase === 'error' ? (
          <p className="cw-feedback" data-kind="failed" role="alert">
            详情读取失败：{detailError ?? '未知错误'}
          </p>
        ) : null}
        {detailPhase === 'ready' && detail !== null ? (
          detail.workItems.length === 0 ? <p className="cw-muted">没有工作项。</p> : (
            <table className="cw-work-table">
              <thead>
                <tr>
                  <th scope="col">状态</th>
                  <th scope="col">分支</th>
                  <th scope="col">提交</th>
                  <th scope="col">更新</th>
                </tr>
              </thead>
              <tbody>
                {detail.workItems.map(item => (
                  <tr key={item.workItemId}>
                    <td>
                      <span className="cw-wi-status" data-tone={workItemStatusTone(item.status)}>
                        {workItemStatusLabel(item.status)}
                      </span>
                    </td>
                    <td><code className="cw-code">{item.branch.length > 0 ? item.branch : '—'}</code></td>
                    <td>
                      <code className="cw-sha" title={`${item.baseCommit ?? '—'} → ${item.headCommit ?? '—'}`}>
                        {shortCommit(item.baseCommit)}→{shortCommit(item.headCommit)}
                      </code>
                    </td>
                    <td title={formatLocalTimestamp(item.updatedAt)}>
                      {formatRelativeTime(item.updatedAt, nowMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </div>

      <div className="cw-section">
        <h3 className="cw-section-title">评审请求</h3>
        {detailPhase === 'ready' && detail !== null ? (
          detail.reviewRequests.length === 0 ? <p className="cw-muted">还没有评审请求；master 发起评审后出现在这里。</p> : (
            <ul className="cw-review-list">
              {detail.reviewRequests.map(request => (
                <ReviewCard key={request.requestId} request={request} nowMs={nowMs} />
              ))}
            </ul>
          )
        ) : null}
      </div>

      <div className="cw-section">
        <h3 className="cw-section-title">活动</h3>
        {detailPhase === 'ready' && detail !== null ? (
          detail.activity.length === 0 ? <p className="cw-muted">没有活动记录。</p> : (
            <ul className="cw-activity-list">
              {detail.activity.map(event => (
                <li key={event.eventId} className="cw-activity">
                  <span className="cw-activity-time" title={formatLocalTimestamp(event.time)}>
                    {formatRelativeTime(event.time, nowMs)}
                  </span>
                  <code className="cw-code">{event.type}</code>
                  <span className="cw-activity-summary">{event.summary}</span>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </section>
  )
}
