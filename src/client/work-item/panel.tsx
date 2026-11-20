/**
 * Main-area work-item viewer (`cowork-work-item` keyed panel).
 *
 * It reads the open context from the external store, loads the record, the
 * primary file, and the comment log, and renders the read-only chain: numbered
 * lines, a range selection that becomes an anchored comment, and the thread
 * rail. Saving and delivery are later stages; this component never pretends
 * they happened.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import {
  ARTIFACT_STATUS_LABELS,
  type ArtifactAnchor,
  type ArtifactFileResponse,
  type ArtifactRecordV1,
  type CommentEventV1,
} from '../../panel/artifact-contract.js'
import { useClientServices } from '../contracts.ts'
import { workItemApi } from './api.ts'
import {
  anchorLabel,
  anchorStatusLabel,
  commentAuthor,
  commentBody,
  contentLines,
  errorPresentation,
  fileSummary,
  foldThreads,
  formatRelativeTime,
  isSelected,
  revisionSummary,
  selectLine,
  sortThreads,
  typeLabel,
  type LineSelection,
  type WorkItemThread,
} from './model.ts'
import { workItemOpenStore } from './store.ts'

/** The loaded viewer state; one snapshot per open work item. */
interface ViewerData {
  readonly record: ArtifactRecordV1
  readonly file: ArtifactFileResponse | null
  readonly events: readonly CommentEventV1[]
}

/** A short message from any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The open context as a React value. */
function useOpenContext() {
  return useSyncExternalStore(
    (listener) => workItemOpenStore.subscribe(listener),
    () => workItemOpenStore.getSnapshot(),
    () => workItemOpenStore.getSnapshot(),
  ).context
}

/** One thread card in the rail. */
function ThreadCard({
  thread,
  now,
  pending,
  onToggle,
}: {
  readonly thread: WorkItemThread
  readonly now: Date
  readonly pending: boolean
  readonly onToggle: (thread: WorkItemThread) => void
}): ReactElement {
  const stale = anchorStatusLabel(thread.anchorStatus)
  return (
    <div className="cwi-thread" data-testid="cwi-thread" data-resolved={thread.resolved ? 'true' : 'false'}>
      <div className="cwi-thread-meta">
        <span>{anchorLabel(thread.anchor)}</span>
        {stale === null ? null : <span className="cwi-stale">{stale}</span>}
        <span>{formatRelativeTime(thread.latestAt, now)}</span>
        <span className="cwi-toolbar-spacer" style={{ flex: 1 }} />
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
        ? <div className="cwi-quote">{thread.anchor.quote}</div>
        : null}
      {thread.comments.map((event) => (
        <div key={event.eventId} className={event.type === 'reply' ? 'cwi-thread-reply' : undefined}>
          <div className="cwi-thread-meta">
            <span>{commentAuthor(event)}</span>
            <span>{formatRelativeTime(event.createdAt, now)}</span>
          </div>
          <div className="cwi-thread-body">{commentBody(event)}</div>
        </div>
      ))}
    </div>
  )
}

/** The work-item viewer. */
export function WorkItemViewer(): ReactElement {
  const services = useClientServices()
  const context = useOpenContext()
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [data, setData] = useState<ViewerData | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [fileNotice, setFileNotice] = useState<string | null>(null)
  const [selection, setSelection] = useState<LineSelection | null>(null)
  const [pendingAnchor, setPendingAnchor] = useState<ArtifactAnchor | null>(null)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pendingThread, setPendingThread] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [now, setNow] = useState(() => new Date())
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const layout = services.layout
  const canReturn = layout !== undefined && typeof layout.selectPanel === 'function'

  const close = useCallback(() => {
    workItemOpenStore.close()
    if (canReturn) layout.selectPanel(null)
  }, [canReturn, layout])

  // Load the work item whenever the context or an explicit retry changes.
  useEffect(() => {
    if (context === null) {
      setPhase('idle')
      setData(null)
      return
    }
    let active = true
    setPhase(current => (current === 'ready' ? 'ready' : 'loading'))
    setError(null)
    setFileNotice(null)
    setSelection(null)
    setPendingAnchor(null)
    const load = async (): Promise<void> => {
      const detail = await workItemApi.detail(context.sessionId, context.artifactId)
      let file: ArtifactFileResponse | null = null
      let notice: string | null = null
      try {
        file = await workItemApi.file(context.sessionId, context.artifactId, detail.record.primaryPath)
      } catch (reason) {
        notice = errorPresentation(reason as { code?: string; message?: string }).detail
      }
      const comments = await workItemApi.comments(context.sessionId, context.artifactId)
      if (!active) return
      setData({ record: detail.record, file, events: comments.events })
      setFileNotice(notice)
      setNow(new Date())
      setPhase('ready')
      // Opening the viewer records first-view; the server is idempotent and the
      // failure must not block reading.
      workItemApi.status({ sessionId: context.sessionId, artifactId: context.artifactId, action: 'view' })
        .then((response) => {
          if (!active) return
          setData(current => (current === null ? current : { ...current, record: response.record }))
        })
        .catch(() => {})
    }
    load().catch((reason: unknown) => {
      if (!active) return
      setData(null)
      setError(reason)
      setPhase('error')
    })
    return () => { active = false }
  }, [context, refreshToken])

  // The viewer closes itself when the host switches the main area away from the
  // session it was opened for (`retainedBy.mainView` falls to zero).
  useEffect(() => {
    if (context === null) return
    const sessions = services.sessions
    if (sessions === undefined || typeof sessions.retainInfo !== 'function') return
    let info
    try {
      info = sessions.retainInfo(context.sessionId)
    } catch {
      return
    }
    let previous = info.getSnapshot().retainedBy.mainView ?? 0
    return info.subscribe(() => {
      const current = info.getSnapshot().retainedBy.mainView ?? 0
      if (previous > 0 && current === 0) workItemOpenStore.close()
      previous = current
    })
  }, [context, services.sessions])

  const lines = useMemo(() => contentLines(data?.file?.content ?? ''), [data?.file?.content])
  const threads = useMemo(() => sortThreads(foldThreads(data?.events ?? [])), [data?.events])
  const anchoredLines = useMemo(() => {
    const values = new Set<number>()
    for (const thread of threads) {
      if (thread.resolved) continue
      if (thread.anchor !== null && thread.anchor.kind === 'line-range') {
        for (let line = thread.anchor.startLine; line <= thread.anchor.endLine; line += 1) values.add(line)
      }
    }
    return values
  }, [threads])

  const pickLine = useCallback((line: number, extend: boolean) => {
    setSelection(current => selectLine(current, line, extend))
  }, [])

  const annotate = useCallback(() => {
    if (data === null || selection === null) return
    const startLine = Math.max(1, selection.startLine)
    const endLine = Math.min(selection.endLine, lines.length)
    const quote = lines.slice(startLine - 1, endLine).join('\n')
    setPendingAnchor({
      kind: 'line-range',
      path: data.file?.path ?? data.record.primaryPath,
      startLine,
      endLine,
      quote,
    })
    composerRef.current?.focus()
  }, [data, lines, selection])

  const submit = useCallback(async () => {
    if (context === null || data === null || draft.trim() === '' || submitting) return
    setSubmitting(true)
    setReceipt(null)
    try {
      const response = await workItemApi.comment({
        sessionId: context.sessionId,
        artifactId: context.artifactId,
        body: draft.trim(),
        ...(pendingAnchor === null ? {} : { anchor: pendingAnchor }),
      })
      setData(current => current === null
        ? current
        : { ...current, record: response.record, events: [...current.events, response.comment] })
      setDraft('')
      setPendingAnchor(null)
      setSelection(null)
      setReceipt('评论已提交')
    } catch (reason) {
      setReceipt(`提交失败：${messageOf(reason)}`)
    } finally {
      setSubmitting(false)
    }
  }, [context, data, draft, pendingAnchor, submitting])

  const toggleThread = useCallback(async (thread: WorkItemThread) => {
    if (context === null || data === null || pendingThread !== null) return
    setPendingThread(thread.threadId)
    setReceipt(null)
    try {
      const response = await workItemApi.resolveComment({
        sessionId: context.sessionId,
        artifactId: context.artifactId,
        commentId: thread.threadId,
        resolved: !thread.resolved,
      })
      setData(current => current === null
        ? current
        : {
            ...current,
            record: response.record,
            events: response.comment === null ? current.events : [...current.events, response.comment],
          })
    } catch (reason) {
      setReceipt(`更新失败：${messageOf(reason)}`)
    } finally {
      setPendingThread(null)
    }
  }, [context, data, pendingThread])

  if (context === null) {
    return (
      <div className="cwi-viewer" data-testid="cwi-viewer" data-phase="idle">
        <div className="cwi-viewer-empty">从右栏的「工作项」标签打开一份交付物。</div>
      </div>
    )
  }
  if (phase === 'loading') {
    return (
      <div className="cwi-viewer" data-testid="cwi-viewer" data-phase="loading" aria-busy="true">
        <div className="cwi-viewer-empty">正在加载工作项…</div>
      </div>
    )
  }
  if (phase === 'error' || data === null) {
    const presentation = errorPresentation(error as { code?: string; message?: string } | null)
    return (
      <div className="cwi-viewer" data-testid="cwi-viewer" data-phase="error">
        <div className="cwi-viewer-empty">
          <div data-testid="cwi-viewer-error">{presentation.title}</div>
          <div>{presentation.detail}</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 10 }}>
            <button type="button" className="cwi-secondary" onClick={() => { setRefreshToken(token => token + 1) }}>
              重试
            </button>
            <button type="button" className="cwi-secondary" data-testid="cwi-back" onClick={close}>
              返回会话
            </button>
          </div>
        </div>
      </div>
    )
  }
  const record = data.record
  return (
    <div className="cwi-viewer" data-testid="cwi-viewer" data-phase="ready" data-artifact-id={record.artifactId}>
      <header className="cwi-viewer-header">
        <button
          type="button"
          className="cwi-back"
          data-testid="cwi-back"
          onClick={close}
          disabled={!canReturn}
          title={canReturn ? '返回会话' : '当前宿主没有主区域布局服务'}
        >
          ← 返回会话
        </button>
        <span className="cwi-title" data-testid="cwi-title">{record.title}</span>
        <span className="cwi-chip">{typeLabel(record.type)}</span>
        <span className="cwi-status" data-testid="cwi-status">{ARTIFACT_STATUS_LABELS[record.status]}</span>
      </header>
      <div className="cwi-toolbar">
        <span className="cwi-path" data-testid="cwi-primary-path">{record.primaryPath}</span>
        <span>{revisionSummary(record.revision, record.commentCount, record.attachmentCount)}</span>
        {data.file === null ? null : <span>{fileSummary({ ...record.files[0], size: data.file.size })}</span>}
        <span className="cwi-spacer" />
        <span>只读</span>
      </div>
      {fileNotice === null ? null : (
        <div className="cwi-receipt" data-testid="cwi-file-notice">{fileNotice}</div>
      )}
      <div className="cwi-body">
        <div className="cwi-content">
          {selection === null ? null : (
            <div className="cwi-selection-bar">
              <span>
                已选第 {selection.startLine}
                {selection.endLine === selection.startLine ? '' : `–${selection.endLine}`} 行
              </span>
              <button type="button" className="cwi-primary" data-testid="cwi-annotate" onClick={annotate}>
                批注
              </button>
              <button type="button" className="cwi-secondary" onClick={() => { setSelection(null) }}>
                取消
              </button>
            </div>
          )}
          <div className="cwi-lines" data-testid="cwi-content">
            {lines.map((text, index) => {
              const line = index + 1
              return (
                <div
                  key={line}
                  className="cwi-line"
                  data-testid="cwi-line"
                  data-line={line}
                  data-selected={isSelected(selection, line) ? 'true' : 'false'}
                  data-anchored={anchoredLines.has(line) ? 'true' : 'false'}
                  onClick={(event) => { pickLine(line, event.shiftKey) }}
                >
                  <span className="cwi-line-number">{line}</span>
                  <span className="cwi-line-text">{text === '' ? ' ' : text}</span>
                </div>
              )
            })}
          </div>
        </div>
        <aside className="cwi-rail" data-testid="cwi-rail">
          <div className="cwi-rail-header" data-testid="cwi-thread-count">
            {threads.length === 0 ? '还没有批注' : `${threads.length} 条批注线程`}
          </div>
          <div className="cwi-threads">
            {threads.map((thread) => (
              <ThreadCard
                key={thread.threadId}
                thread={thread}
                now={now}
                pending={pendingThread === thread.threadId}
                onToggle={toggleThread}
              />
            ))}
          </div>
          <div className="cwi-composer">
            {pendingAnchor === null ? null : (
              <div className="cwi-thread-meta">
                <span>{anchorLabel(pendingAnchor)}</span>
                <button type="button" className="cwi-secondary" onClick={() => { setPendingAnchor(null) }}>
                  取消位置
                </button>
              </div>
            )}
            <textarea
              ref={composerRef}
              data-testid="cwi-composer"
              value={draft}
              placeholder={pendingAnchor === null ? '写下整体批注…' : '写下对所选行的批注…'}
              onChange={(event) => { setDraft(event.target.value) }}
            />
            <div className="cwi-composer-row">
              <span className="cwi-composer-hint">Enter 换行；提交后进入评论线程</span>
              <button
                type="button"
                className="cwi-primary"
                data-testid="cwi-submit"
                disabled={draft.trim() === '' || submitting}
                onClick={() => { void submit() }}
              >
                {submitting ? '提交中…' : '提交批注'}
              </button>
            </div>
            {receipt === null ? null : <div className="cwi-receipt" role="status">{receipt}</div>}
          </div>
        </aside>
      </div>
    </div>
  )
}
