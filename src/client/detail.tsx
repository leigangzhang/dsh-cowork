/**
 * One thread's detail: subject, status, id, update time, the latest handoff
 * (summary / verification / changed paths / absolute file path) and the
 * collapsible MASTER message.
 *
 * The MASTER block is evidence, not content to re-render: the host re-renders
 * the exact text it delivered (`masterMessage`) and the panel shows it verbatim
 * in a monospace `<pre>` — no trimming, no reflow, no summary. Its height is
 * capped to about 40% of the measured panel area with its own scroll.
 */
import type { ReactElement } from 'react'
import type { HandoffPayload, PanelReviewPayload, PanelThread } from '../api-contract.ts'
import {
  findingSeverityLabel,
  findingSeverityTone,
  formatLocalTimestamp,
  formatRelativeTime,
  reviewAbsentMessage,
  reviewDetailUnavailableMessage,
  reviewPendingMessage,
  shortThreadId,
} from './model.ts'
import { ExitChip, ReviewBadge, StatusBadge } from './chips.tsx'

/** Where the handoff fetch stands for the selected thread. */
export type HandoffPhase = 'idle' | 'loading' | 'ready' | 'none' | 'error'

/** One visible action receipt (copy path, open session). */
export interface DetailFeedback {
  readonly kind: 'ok' | 'failed'
  readonly text: string
}

export interface ThreadDetailProps {
  readonly thread: PanelThread
  readonly nowMs: number
  readonly handoff: HandoffPayload | null
  readonly handoffPhase: HandoffPhase
  readonly handoffError: string | null
  /** Inline max-height for the MASTER message block, measured from the panel. */
  readonly masterMaxHeight: number
  readonly canOpenSession: boolean
  readonly openSessionHint: string
  readonly feedback: DetailFeedback | null
  readonly onOpenSession: () => void
  /** Whether the review session can be opened (session recorded and service present). */
  readonly canOpenReviewSession: boolean
  /** Why the review-session button is disabled. */
  readonly reviewOpenHint: string
  readonly onOpenReviewSession: () => void
  readonly onCopyPath: () => void
  /** Drill-down return control; `null` in split mode. */
  readonly onBack: (() => void) | null
}

/**
 * Where one finding points: `file:line`, `file`, or nothing. Kept local to the
 * render because both halves come from the same row.
 */
function findingLocation(file: string | undefined, line: number | undefined): string | null {
  if (file === undefined) return null
  return line === undefined ? file : `${file}:${line}`
}

/** The review section: verdict, reviewer, summary, findings and the review file. */
function ReviewSection({
  thread,
  review,
  nowMs,
  canOpen,
  openHint,
  onOpen,
}: {
  readonly thread: PanelThread
  readonly review: PanelReviewPayload | null
  readonly nowMs: number
  readonly canOpen: boolean
  readonly openHint: string
  readonly onOpen: () => void
}): ReactElement {
  const record = review?.record ?? null
  // The review file is the evidence; the index row is the current state. When
  // both exist they should agree, and the file wins because it is the artifact.
  const status = record?.verdict ?? thread.reviewStatus
  const reviewedAt = record?.createdAt ?? thread.reviewedAt
  const reviewerSessionId = record?.reviewerSessionId ?? thread.reviewerSessionId
  const findingCount = record?.findings.length ?? 0
  return (
    <div className="cw-section cw-review" data-review-state={status ?? 'none'}>
      <h3 className="cw-section-title">审查</h3>

      <div className="cw-review-head">
        {status === null
          ? <span className="cw-review-absent">尚无 review</span>
          : <ReviewBadge status={status} reviewedAt={reviewedAt} findingCount={findingCount} />}
        {reviewedAt === null ? null : (
          <span className="cw-review-time" title={formatLocalTimestamp(reviewedAt)}>
            审查于 {formatRelativeTime(reviewedAt, nowMs)}
          </span>
        )}
        {reviewerSessionId === null ? null : (
          <span className="cw-review-reviewer">
            reviewer <code className="cw-code">{shortThreadId(reviewerSessionId)}</code>
          </span>
        )}
      </div>

      {record === null || review === null ? (
        <p className="cw-muted">
          {status === 'pending'
            ? reviewPendingMessage()
            : status === null
              ? reviewAbsentMessage()
              : reviewDetailUnavailableMessage(status)}
        </p>
      ) : (
        <>
          <p className="cw-summary">{record.summary}</p>

          {record.findings.length === 0 ? (
            <p className="cw-muted">没有 finding。</p>
          ) : (
            <ul className="cw-finding-list">
              {record.findings.map((finding, index) => {
                const location = findingLocation(finding.file, finding.line)
                return (
                  <li
                    key={`${finding.id}-${index}`}
                    className="cw-finding"
                    data-tone={findingSeverityTone(finding.severity)}
                  >
                    <div className="cw-finding-head">
                      <span
                        className="cw-finding-severity"
                        data-tone={findingSeverityTone(finding.severity)}
                      >
                        {findingSeverityLabel(finding.severity)}
                      </span>
                      <code className="cw-code">{finding.id}</code>
                      {location === null ? null : (
                        <code className="cw-finding-location">{location}</code>
                      )}
                    </div>
                    <p className="cw-finding-problem">{finding.problem}</p>
                    <p className="cw-finding-fix">修复：{finding.requiredFix}</p>
                  </li>
                )
              })}
            </ul>
          )}

          <div className="cw-section">
            <h4 className="cw-review-subtitle">reviewer 验证</h4>
            {record.verification.length === 0 ? (
              <p className="cw-muted">reviewer 没有记录验证命令。</p>
            ) : (
              <ul className="cw-verify-list">
                {record.verification.map((item, index) => (
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
          </div>

          <div className="cw-section">
            <h4 className="cw-review-subtitle">review 文件</h4>
            <code className="cw-filepath">{review.filePath}</code>
            <p className="cw-muted">只读展示；面板不会修改 review 文件。</p>
          </div>
        </>
      )}

      <div className="cw-actions">
        <button
          type="button"
          className="cw-button"
          onClick={onOpen}
          disabled={!canOpen}
          title={canOpen ? '在会话区打开这个 thread 的 review 会话' : openHint}
        >
          打开 review 会话
        </button>
      </div>
    </div>
  )
}

/** Detail pane for the selected thread. */
export function ThreadDetail({
  thread,
  nowMs,
  handoff,
  handoffPhase,
  handoffError,
  masterMaxHeight,
  canOpenSession,
  openSessionHint,
  feedback,
  onOpenSession,
  canOpenReviewSession,
  reviewOpenHint,
  onOpenReviewSession,
  onCopyPath,
  onBack,
}: ThreadDetailProps): ReactElement {
  const subject = thread.subject.length > 0 ? thread.subject : '（无标题）'
  const handoffState = handoffPhase === 'ready' && handoff !== null ? 'handoff' : 'no-handoff'
  return (
    <section
      className="cw-detail"
      role="region"
      aria-label={`Thread 详情：${subject}`}
      data-handoff-state={handoffState}
    >
      {onBack === null ? null : (
        <button type="button" className="cw-back" onClick={onBack} aria-label="返回全部 thread 列表" autoFocus>
          ← 全部 thread
        </button>
      )}

      <h2 className="cw-detail-subject" title={thread.subject}>{subject}</h2>

      <div className="cw-detail-meta">
        <StatusBadge status={thread.status} />
        <span>
          thread <code className="cw-code">{shortThreadId(thread.threadId)}</code>
        </span>
        <span title={formatLocalTimestamp(thread.updatedAt)}>
          更新于 {formatRelativeTime(thread.updatedAt, nowMs)}
        </span>
      </div>

      <div className="cw-actions">
        <button
          type="button"
          className="cw-button-primary"
          onClick={onOpenSession}
          disabled={!canOpenSession}
          title={canOpenSession ? '在会话区打开这个 thread 的会话' : openSessionHint}
        >
          打开 thread 会话
        </button>
      </div>

      {feedback === null ? null : (
        <p className="cw-feedback" data-kind={feedback.kind} role="status" aria-live="polite">
          {feedback.text}
        </p>
      )}

      {handoffPhase === 'loading' ? <p className="cw-muted">正在读取交接单…</p> : null}

      {handoffPhase === 'error' ? (
        <p className="cw-feedback" data-kind="failed" role="alert">
          交接单读取失败：{handoffError ?? '未知错误'}
        </p>
      ) : null}

      {handoffPhase === 'none' ? (
        <p className="cw-muted">这个 thread 还没有交接单；master 收到 handoff 后，这里会显示摘要与投递原文。</p>
      ) : null}

      <ReviewSection
        thread={thread}
        review={handoffPhase === 'ready' && handoff !== null ? handoff.review : null}
        nowMs={nowMs}
        canOpen={canOpenReviewSession}
        openHint={reviewOpenHint}
        onOpen={onOpenReviewSession}
      />

      {handoff !== null && handoffPhase === 'ready' ? (
        <>
          <div className="cw-section">
            <h3 className="cw-section-title">摘要</h3>
            <p className="cw-summary">{handoff.record.summary}</p>
          </div>

          <div className="cw-section">
            <h3 className="cw-section-title">验证</h3>
            {handoff.record.verification.length === 0 ? (
              <p className="cw-muted">没有验证记录。</p>
            ) : (
              <ul className="cw-verify-list">
                {handoff.record.verification.map((item, index) => (
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
          </div>

          <div className="cw-section">
            <h3 className="cw-section-title">变更文件</h3>
            {handoff.record.changedPaths.length === 0 ? (
              <p className="cw-muted">没有变更文件。</p>
            ) : (
              <ul className="cw-path-list">
                {handoff.record.changedPaths.map((path, index) => (
                  <li key={`${path}-${index}`} className="cw-path">{path}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="cw-section">
            <h3 className="cw-section-title">交接单</h3>
            <div className="cw-file-row">
              <code className="cw-filepath">{handoff.filePath}</code>
              <button
                type="button"
                className="cw-button"
                onClick={onCopyPath}
                title="复制交接单 JSON 的绝对路径"
              >
                复制交接单路径
              </button>
            </div>
          </div>

          <details className="cw-master-details">
            <summary className="cw-master-summary">MASTER 收到的消息</summary>
            <pre className="cw-master" style={{ maxHeight: `${masterMaxHeight}px` }}>{handoff.masterMessage}</pre>
          </details>
        </>
      ) : null}
    </section>
  )
}
