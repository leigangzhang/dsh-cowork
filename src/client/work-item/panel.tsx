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
  ARTIFACT_EVENT_TYPES,
  ARTIFACT_EVENTS_PATH,
  ARTIFACT_PRESENCE_REPORT_INTERVAL_MS,
  ARTIFACT_SAVE_DEBOUNCE_MS,
  ARTIFACT_STATUS_LABELS,
  type ArtifactAnchor,
  type ArtifactFileResponse,
  type ArtifactRecordV1,
  type AttachmentRefV1,
  type CommentEventV1,
} from '../../panel/artifact-contract.js'
import { useClientServices } from '../contracts.ts'
import { WorkItemApiError, workItemApi, type SaveConflict } from './api.ts'
import {
  activeDispatchSummary,
  anchorLabel,
  anchorStatusLabel,
  changedLineRanges,
  commentAuthor,
  commentBody,
  contentLines,
  errorPresentation,
  fileSummary,
  foldThreads,
  formatRelativeTime,
  isSelected,
  revisionSummary,
  saveStateLabel,
  selectLine,
  sortThreads,
  typeLabel,
  type LineSelection,
  type SavePhase,
  type WorkItemThread,
} from './model.ts'
import { workItemOpenStore } from './store.ts'

/** The loaded viewer state; one snapshot per open work item. */
interface ViewerData {
  readonly record: ArtifactRecordV1
  readonly file: ArtifactFileResponse | null
  readonly events: readonly CommentEventV1[]
}

const BYTE_ENCODER = new TextEncoder()

/** UTF-8 byte length, the unit the server's text cap uses. */
function byteLength(text: string): number {
  return BYTE_ENCODER.encode(text).byteLength
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
  attachmentUrl,
}: {
  readonly thread: WorkItemThread
  readonly now: Date
  readonly pending: boolean
  readonly onToggle: (thread: WorkItemThread) => void
  readonly attachmentUrl: (attachmentId: string) => string
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
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [savePhase, setSavePhase] = useState<SavePhase>('saved')
  const [conflict, setConflict] = useState<SaveConflict | null>(null)
  const [conflictLatest, setConflictLatest] = useState('')
  const [showConflictDiff, setShowConflictDiff] = useState(false)
  const [backArmed, setBackArmed] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentRefV1[]>([])
  const [uploading, setUploading] = useState(false)
  const [sseNotice, setSseNotice] = useState<string | null>(null)
  const [sseToken, setSseToken] = useState(0)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const gutterRef = useRef<HTMLPreElement | null>(null)
  const dirty = editing && data !== null && data.file !== null && editDraft !== savedContent
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
      setEditing(false)
      setEditDraft(file?.content ?? '')
      setSavedContent(file?.content ?? '')
      setConflict(null)
      setConflictLatest('')
      setShowConflictDiff(false)
      setSavePhase('saved')
      setBackArmed(false)
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

  /** Save the draft through the optimistic-concurrency route. */
  const saveDraft = useCallback(async (options?: {
    readonly baseVersion?: string | null
    readonly baseRevision?: number
    readonly content?: string
  }) => {
    if (context === null || data === null || data.file === null) return
    const file = data.file
    const content = options?.content ?? editDraft
    setSavePhase('saving')
    setBackArmed(false)
    try {
      const response = await workItemApi.edit({
        sessionId: context.sessionId,
        artifactId: context.artifactId,
        path: file.path,
        baseRevision: options?.baseRevision ?? file.revision,
        baseVersion: options?.baseVersion === undefined ? file.fsVersion : options.baseVersion,
        content,
      })
      setData(current => current === null || current.file === null
        ? current
        : {
            ...current,
            record: response.record,
            file: {
              ...current.file,
              content: response.content,
              revision: response.revision,
              fsVersion: response.fsVersion,
              sha256: '',
              size: byteLength(response.content),
            },
          })
      setEditDraft(response.content)
      setSavedContent(response.content)
      setConflict(null)
      setConflictLatest('')
      setShowConflictDiff(false)
      setSavePhase('saved')
      setReceipt(response.merged ? '已合并模型修改并保存' : '已保存')
    } catch (error) {
      if (error instanceof WorkItemApiError && error.code === 'artifact/version-conflict') {
        const info = (error as WorkItemApiError & { conflict?: SaveConflict }).conflict ?? null
        setConflict(info)
        setSavePhase('conflict')
        if (info !== null) {
          try {
            const latest = await workItemApi.file(context.sessionId, context.artifactId, file.path)
            setConflictLatest(latest.content)
          } catch {
            setConflictLatest('')
          }
        }
        return
      }
      setSavePhase('failed')
      setReceipt(`保存失败：${messageOf(error)}`)
    }
  }, [context, data, editDraft])

  // Debounced autosave: every edit restarts the 800 ms window; a conflict
  // pauses saving until the user picks a resolution.
  useEffect(() => {
    if (!dirty || conflict !== null || data?.file == null) return
    const timer = window.setTimeout(() => { void saveDraft() }, ARTIFACT_SAVE_DEBOUNCE_MS)
    return () => { window.clearTimeout(timer) }
  }, [conflict, data?.file, dirty, draft, saveDraft])

  // Editing presence: report the changed lines every 300 ms while the draft
  // differs from the saved text. The server expires the report on its own.
  useEffect(() => {
    if (context === null || data?.file == null || !editing) return
    const ranges = changedLineRanges(savedContent, editDraft)
    if (ranges.length === 0) return
    const report = (): void => {
      void workItemApi.presence({
        sessionId: context.sessionId,
        artifactId: context.artifactId,
        path: data.file!.path,
        ranges,
      }).catch(() => {})
    }
    report()
    const timer = window.setInterval(report, ARTIFACT_PRESENCE_REPORT_INTERVAL_MS)
    return () => { window.clearInterval(timer) }
  }, [context, data?.file, editing, savedContent, editDraft])

  /** Leave editing: flush a dirty draft first. */
  const toggleEditing = useCallback(() => {
    if (data?.file == null) return
    if (!editing) {
      setEditDraft(data.file.content)
      setSavedContent(data.file.content)
      setEditing(true)
      setSavePhase('saved')
      setConflict(null)
      setReceipt(null)
      return
    }
    if (dirty) void saveDraft()
    setEditing(false)
  }, [data?.file, dirty, editing, saveDraft])

  /** Back: a dirty draft needs a second click so it is never lost silently. */
  const requestClose = useCallback(() => {
    if (editing && dirty && !backArmed) {
      setBackArmed(true)
      setReceipt('还有未保存内容：再点一次返回会关闭查看器')
      return
    }
    close()
  }, [backArmed, close, dirty, editing])

  const loadLatest = useCallback(async () => {
    if (context === null || data?.file == null) return
    try {
      const latest = await workItemApi.file(context.sessionId, context.artifactId, data.file.path)
      const detail = await workItemApi.detail(context.sessionId, context.artifactId)
      setData({ record: detail.record, file: latest, events: data.events })
      setEditDraft(latest.content)
      setSavedContent(latest.content)
      setConflict(null)
      setConflictLatest('')
      setShowConflictDiff(false)
      setSavePhase('saved')
      setReceipt('已加载最新内容')
    } catch (error) {
      setReceipt(`加载失败：${messageOf(error)}`)
    }
  }, [context, data])

  const keepMine = useCallback(() => {
    if (conflict === null) return
    void saveDraft({
      baseVersion: conflict.currentVersion,
      baseRevision: conflict.revision > 0 ? conflict.revision : 1,
    })
  }, [conflict, saveDraft])

  /**
   * Re-read the record and threads without touching the editor draft.
   *
   * Depends only on the open context: the SSE effect subscribes with this
   * callback, so a new `data` identity must not tear the stream down and
   * reconnect (which would refresh, change data, and reconnect forever).
   */
  const refreshFromServer = useCallback(async () => {
    if (context === null) return
    try {
      const detail = await workItemApi.detail(context.sessionId, context.artifactId)
      const comments = await workItemApi.comments(context.sessionId, context.artifactId)
      setData(current => current === null
        ? current
        : { ...current, record: detail.record, events: comments.events })
    } catch {
      // A failed refresh keeps the last good view; the stream retries.
    }
  }, [context])

  // Live updates: the project SSE stream refreshes this work item on comment,
  // file, dispatch, and reset events. EventSource reconnects natively; after
  // three consecutive errors the viewer stops and offers a retry instead of
  // spinning forever.
  useEffect(() => {
    if (context === null || typeof EventSource === 'undefined') return
    let closed = false
    let failures = 0
    let source: EventSource | null = null
    const connect = (): void => {
      const url = `${ARTIFACT_EVENTS_PATH}?sessionId=${encodeURIComponent(context.sessionId)}&artifactId=${encodeURIComponent(context.artifactId)}`
      source = new EventSource(url)
      source.onopen = () => {
        if (closed) return
        failures = 0
        setSseNotice(null)
        void refreshFromServer()
      }
      // Named SSE events (`event: comment.created`) do not reach `onmessage`;
      // every artifact event type is registered explicitly.
      const onFrame = (message: MessageEvent<string>): void => {
        if (closed) return
        try {
          const event = JSON.parse(message.data) as { type?: unknown }
          if (event.type === 'reset') void refreshFromServer()
          if (
            event.type === 'comment.created'
            || event.type === 'comment.updated'
            || event.type === 'reply.created'
            || event.type === 'file.changed'
            || event.type === 'artifact.updated'
            || event.type === 'dispatch.updated'
          ) {
            void refreshFromServer()
          }
        } catch {
          // Ignore a malformed frame; the next event re-syncs.
        }
      }
      for (const type of ARTIFACT_EVENT_TYPES) {
        source.addEventListener(type, onFrame as EventListener)
      }
      source.onerror = () => {
        if (closed) return
        failures += 1
        if (failures >= 3) {
          source?.close()
          setSseNotice('实时更新中断，点击重试')
        }
      }
    }
    connect()
    return () => {
      closed = true
      source?.close()
    }
  }, [context, refreshFromServer, sseToken])

  /** Upload one picked file and keep the returned refs for the next comment. */
  const attachFiles = useCallback(async (files: FileList | null) => {
    if (context === null || data === null || files === null || files.length === 0) return
    setUploading(true)
    setReceipt(null)
    try {
      const added: AttachmentRefV1[] = []
      for (const file of Array.from(files).slice(0, 5)) {
        const uploaded = await workItemApi.upload({
          sessionId: context.sessionId,
          artifactId: context.artifactId,
          name: file.name,
          bytes: file,
        })
        added.push(uploaded.attachment)
      }
      setPendingAttachments(current => [...current, ...added].slice(0, 5))
    } catch (error) {
      setReceipt(`附件上传失败：${messageOf(error)}`)
    } finally {
      setUploading(false)
    }
  }, [context, data])

  const syncEditorScroll = useCallback(() => {
    if (editorRef.current === null || gutterRef.current === null) return
    gutterRef.current.scrollTop = editorRef.current.scrollTop
  }, [])

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
        ...(pendingAttachments.length === 0 ? {} : { attachments: pendingAttachments }),
      })
      setData(current => current === null
        ? current
        : { ...current, record: response.record, events: [...current.events, response.comment] })
      setDraft('')
      setPendingAnchor(null)
      setSelection(null)
      setPendingAttachments([])
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
  const activity = activeDispatchSummary(record.activeDispatch)
  return (
    <div className="cwi-viewer" data-testid="cwi-viewer" data-phase="ready" data-artifact-id={record.artifactId}>
      <header className="cwi-viewer-header">
        <button
          type="button"
          className="cwi-back"
          data-testid="cwi-back"
          onClick={requestClose}
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
        {activity === null ? null : (
          <span className="cwi-chip" data-tone={activity.tone} data-testid="cwi-activity">{activity.label}</span>
        )}
        {data.file === null ? null : (
          <button type="button" className="cwi-secondary" data-testid="cwi-edit" onClick={toggleEditing}>
            {editing ? '退出编辑' : '编辑'}
          </button>
        )}
        <span data-testid="cwi-save-state">{editing ? saveStateLabel(savePhase, data.file?.revision ?? record.revision) : '只读'}</span>
      </div>
      {fileNotice === null ? null : (
        <div className="cwi-receipt" data-testid="cwi-file-notice">{fileNotice}</div>
      )}
      <div className="cwi-body">
        <div className="cwi-content" data-testid="cwi-content">
          {sseNotice === null ? null : (
            <div className="cwi-receipt" data-testid="cwi-sse-notice">
              {sseNotice}{' '}
              <button type="button" className="cwi-secondary" data-testid="cwi-sse-retry" onClick={() => { setSseNotice(null); setSseToken(token => token + 1) }}>
                重试
              </button>
            </div>
          )}
          {conflict === null ? null : (
            <div className="cwi-conflict" data-testid="cwi-conflict" role="alert">
              <div>
                保存冲突：最新内容与你编辑的行重叠（
                {conflict.conflictRanges.map((range) => (range.startLine === range.endLine
                  ? `第 ${range.startLine} 行`
                  : `第 ${range.startLine}–${range.endLine} 行`)).join('、')}
                ）。
              </div>
              <div className="cwi-composer-row">
                <button type="button" className="cwi-secondary" data-testid="cwi-conflict-diff" onClick={() => { setShowConflictDiff(value => !value) }}>
                  查看差异
                </button>
                <button type="button" className="cwi-secondary" data-testid="cwi-conflict-load" onClick={() => { void loadLatest() }}>
                  加载最新
                </button>
                <button type="button" className="cwi-primary" data-testid="cwi-conflict-keep" onClick={keepMine}>
                  保留我的
                </button>
              </div>
              {showConflictDiff ? (
                <div className="cwi-conflict-diff">
                  <div className="cwi-thread-meta">最新内容</div>
                  <pre className="cwi-conflict-latest" data-testid="cwi-conflict-latest">{conflictLatest}</pre>
                </div>
              ) : null}
            </div>
          )}
          {editing ? (
            <div className="cwi-editor-wrap">
              <pre className="cwi-gutter" ref={gutterRef} aria-hidden="true">
                {contentLines(editDraft).map((_text, index) => String(index + 1)).join('\n')}
              </pre>
              <textarea
                ref={editorRef}
                className="cwi-editor"
                data-testid="cwi-editor"
                aria-label="编辑文件内容"
                value={editDraft}
                spellCheck={false}
                onChange={(event) => {
                  setEditDraft(event.target.value)
                  setBackArmed(false)
                }}
                onScroll={syncEditorScroll}
                onBlur={() => { if (dirty && conflict === null) void saveDraft() }}
              />
            </div>
          ) : (
            <>
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
              <div className="cwi-lines" data-testid="cwi-lines">
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
            </>
          )}
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
                attachmentUrl={(attachmentId) => workItemApi.attachmentUrl({
                  sessionId: context.sessionId,
                  artifactId: context.artifactId,
                  attachmentId,
                })}
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
              <label className="cwi-secondary" data-testid="cwi-attach-label" title="添加附件">
                附件
                <input
                  type="file"
                  data-testid="cwi-file-input"
                  hidden
                  multiple
                  accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.markdown,.csv,.tsv,.json"
                  onChange={(event) => {
                    void attachFiles(event.target.files)
                    event.target.value = ''
                  }}
                />
              </label>
              {uploading ? <span className="cwi-composer-hint">附件上传中…</span> : null}
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
            {pendingAttachments.length === 0 ? null : (
              <div className="cwi-thread-meta" data-testid="cwi-pending-attachments">
                {pendingAttachments.map((attachment) => (
                  <span key={attachment.attachmentId} className="cwi-chip">
                    {attachment.name}
                    <button
                      type="button"
                      className="cwi-secondary"
                      aria-label={`移除附件 ${attachment.name}`}
                      onClick={() => {
                        setPendingAttachments(current => current.filter((entry) => entry.attachmentId !== attachment.attachmentId))
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {receipt === null ? null : <div className="cwi-receipt" role="status">{receipt}</div>}
          </div>
        </aside>
      </div>
    </div>
  )
}
