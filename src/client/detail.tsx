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
import type { HandoffPayload, PanelThread } from '../api-contract.ts'
import {
  formatLocalTimestamp,
  formatRelativeTime,
  shortThreadId,
} from './model.ts'
import { ExitChip, StatusBadge } from './chips.tsx'

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
  readonly onCopyPath: () => void
  /** Drill-down return control; `null` in split mode. */
  readonly onBack: (() => void) | null
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
