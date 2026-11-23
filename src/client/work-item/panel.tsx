/**
 * Work-item viewer: the body of the Cowork conversation view.
 *
 * It reads the open context from the external store, loads the record, the
 * primary file, and the comment log, and renders the numbered document, the
 * range selection that becomes an anchored comment, and the thread rail.
 *
 * The seat injects the session currently displayed (`sessionId`); the open
 * item's owner is `context.ownerSessionId`. Every `artifact.*` call uses the
 * owner so a cross-session preview still resolves the right project, and the
 * two differ exactly when the viewer is read-only.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Dispatch, ReactElement, SetStateAction } from 'react'
import {
  ARTIFACT_EVENT_TYPES,
  ARTIFACT_EVENTS_PATH,
  ARTIFACT_PRESENCE_REPORT_INTERVAL_MS,
  ARTIFACT_SAVE_DEBOUNCE_MS,
  type ArtifactAnchor,
  type ArtifactDispatchSummary,
  type ArtifactFileResponse,
  type ArtifactRecordV1,
  type AttachmentRefV1,
  type CommentEventV1,
} from '../../panel/artifact-contract.js'
import { useClientServices } from '../contracts.ts'
import { WorkItemApiError, workItemApi, type SaveConflict } from './api.ts'
import {
  parseCanvasScene,
  presenceRangesFor,
  viewerKindOf,
  type ViewerKind,
} from './viewers/document.ts'
import { DocumentSurface } from './viewers/viewer-document.tsx'
import { applyRefreshedFile } from './viewers/viewer-refresh.ts'
import {
  activeDispatchSummary,
  anchoredLineNumbers,
  attachmentRowsOf,
  baseName,
  detailMeta,
  contentLines,
  errorPresentation,
  foldThreads,
  lineRangeAnnotation,
  missingFileState,
  olderCall,
  olderCursor,
  olderEntryVisible,
  olderPageAvailable,
  pinThread,
  readPersistedDraft,
  rebindFailure,
  removePersistedDraft,
  savePersistedDraft,
  selectLine,
  sortThreads,
  staleLineNumbers,
  typeLabel,
  type LineSelection,
  type OlderCall,
  type SavePhase,
  type WorkItemThread,
  dispatchDetailLabel,
  deliverySummary,
  formatElapsed,
  threadForDispatch,
  withOlderPage,
  withRecord,
  threadLinePins,
  threadOrdinals,
  type ThreadFilter,
} from './model.ts'
import { openOwnerSession } from './session-open.ts'
import { workItemOpenStore, type WorkItemOpenContext } from './store.ts'
import { CommentComposer } from './comment-composer.tsx'
import {
  CollapsedRailReceipt,
  ConflictCard,
  CrossSessionBanner,
  CrossSessionError,
  railBackdrop,
  RebindFileEntry,
  RailEscape,
  useNarrowLayout,
  ViewerPlaceholder,
} from './panel-frames.tsx'
import { ThreadList } from './thread-list.tsx'
import { ViewerFooter } from './viewer-footer.tsx'
import { ViewerToolbar } from './viewer-toolbar.tsx'
import { ViewerHeader } from './viewer-header.tsx'
import { AttachmentsPanel, VersionsPanel } from './viewer-side-tabs.tsx'

/** The loaded viewer state; one snapshot per open work item. */
interface ViewerData {
  readonly record: ArtifactRecordV1
  readonly file: ArtifactFileResponse | null
  readonly events: readonly CommentEventV1[]
  readonly dispatches: readonly ArtifactDispatchSummary[]
  /** True when the comments route holds a page older than the loaded one. */
  readonly hasOlder: boolean
  readonly sessionTitle: string | null
  readonly revisions: readonly number[]
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

/** Clear submitted UI state only when the user has not replaced it meanwhile. */
function clearIfUnchanged<T>(current: T, submitted: T, cleared: T): T {
  return current === submitted ? cleared : current
}

/** The open context as a React value. */
function useOpenContext() {
  return useSyncExternalStore(
    (listener) => workItemOpenStore.subscribe(listener),
    () => workItemOpenStore.getSnapshot(),
    () => workItemOpenStore.getSnapshot(),
  ).context
}

/** Read the initial file; a refusal becomes a notice instead of failing the view. */
async function readInitialFile(
  sessionId: string,
  artifactId: string,
  path: string,
): Promise<{ file: ArtifactFileResponse | null; notice: string | null; code: string | null }> {
  try {
    return { file: await workItemApi.file(sessionId, artifactId, path), notice: null, code: null }
  } catch (reason) {
    const error = reason as { code?: string; message?: string }
    return { file: null, notice: errorPresentation(error).detail, code: error.code ?? null }
  }
}

/** The viewer data after one successful reload. */
function reloadedView(
  current: ViewerData,
  detail: Awaited<ReturnType<typeof workItemApi.detail>>,
  latest: ArtifactFileResponse,
): ViewerData {
  return {
    record: detail.record,
    file: latest,
    events: current.events,
    dispatches: detail.dispatches,
    hasOlder: current.hasOlder,
    ...detailMeta(detail, current),
  }
}

/** Open the primary file in the host app, returning the receipt to show. */
async function openReceipt(sessionId: string, artifactId: string): Promise<string> {
  try {
    await workItemApi.open({ sessionId, artifactId })
    return '已在本地应用中打开'
  } catch (error) {
    return `打开失败：${messageOf(error)}`
  }
}

/** Paging state for the rail's "load older" entry. */
function useOlderPages(
  context: WorkItemOpenContext | null,
  data: ViewerData | null,
  setData: Dispatch<SetStateAction<ViewerData | null>>,
  setReceipt: Dispatch<SetStateAction<string | null>>,
): { readonly loadingOlder: boolean; readonly loadOlderPage: () => void } {
  const [loadingOlder, setLoadingOlder] = useState(false)

  /** Fetch and prepend the page before the earliest loaded comment. */
  const run = async (call: OlderCall): Promise<void> => {
    setLoadingOlder(true)
    setReceipt(null)
    try {
      const page = await workItemApi.comments(call.ownerSessionId, call.artifactId, undefined, call.before)
      setData(current => withOlderPage(current, page))
    } catch (reason) {
      setReceipt(`加载更早的批注失败：${messageOf(reason)}`)
    } finally {
      setLoadingOlder(false)
    }
  }

  /** Start load-older when the viewer is idle. */
  const loadOlderPage = (): void => {
    if (data === null) return
    const before = olderCursor(data.events)
    if (before === null) return
    const call = olderCall(context, data, loadingOlder, before)
    if (call === null) return
    void run(call)
  }

  return { loadingOlder, loadOlderPage }
}

/** Props the `conversation.view` seat injects into the viewer. */
export interface WorkItemViewProps {
  /** Session currently displayed; the open item's owner may be another one. */
  readonly sessionId: string
}

/** The work-item viewer. */
export function WorkItemViewer({ sessionId }: WorkItemViewProps): ReactElement | null {
  const services = useClientServices()
  const context = useOpenContext()
  const narrow = useNarrowLayout()
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [data, setData] = useState<ViewerData | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [fileProblem, setFileProblem] = useState<{ notice: string | null; code: string | null }>({ notice: null, code: null })
  const [selection, setSelection] = useState<LineSelection | null>(null)
  const [pendingAnchor, setPendingAnchor] = useState<ArtifactAnchor | null>(null)
  const [replyTarget, setReplyTarget] = useState<WorkItemThread | null>(null)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [pendingThread, setPendingThread] = useState<string | null>(null)
  const [pendingDispatch, setPendingDispatch] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [viewTab, setViewTab] = useState<'document' | 'versions' | 'attachments'>('document')
  const [readMode, setReadMode] = useState(true)
  const [showRail, setShowRail] = useState(false)
  // Bumped when the editor must rebuild its scene from the stored file; a
  // save alone must not remount Excalidraw (that would drop undo history).
  const [canvasReset, setCanvasReset] = useState(0)
  const [receipt, setReceipt] = useState<string | null>(null)
  const { loadingOlder, loadOlderPage } = useOlderPages(context, data, setData, setReceipt)
  const [refreshToken, setRefreshToken] = useState(0)
  const [now, setNow] = useState(() => new Date())
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [savePhase, setSavePhase] = useState<SavePhase>('saved')
  const [draftBase, setDraftBase] = useState<{ revision: number; baseVersion: string | null } | null>(null)
  const [conflict, setConflict] = useState<SaveConflict | null>(null)
  const [conflictLatest, setConflictLatest] = useState('')
  const [showConflictDiff, setShowConflictDiff] = useState(false)
  const [backArmed, setBackArmed] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentRefV1[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [opening, setOpening] = useState(false)
  const [threadFilter, setThreadFilter] = useState<ThreadFilter>('all')
  const [showResolved, setShowResolved] = useState(false)
  const [sseNotice, setSseNotice] = useState<string | null>(null)
  const [sseToken, setSseToken] = useState(0)
  const editingRef = useRef(false)
  const dirtyRef = useRef(false)
  const kindRef = useRef<ViewerKind>('source')
  const savedTextRef = useRef('')
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const persistDraftRef = useRef<() => void>(() => {})
  const contextKeyRef = useRef<string | null>(null)
  const dirty = editing && data !== null && data.file !== null && editDraft !== savedContent
  const [ownerOpening, setOwnerOpening] = useState(false)
  const [ownerError, setOwnerError] = useState<string | null>(null)
  const crossSession = context !== null && context.ownerSessionId !== sessionId
  // Cross-session viewers are read-only previews: editing, confirming, and
  // commenting all belong to the owning session.
  const readOnly = crossSession

  // Relative times and activity ages stay current without a data refresh.
  useEffect(() => {
    if (data === null) return
    const timer = window.setInterval(() => { setNow(new Date()) }, 30_000)
    return () => { window.clearInterval(timer) }
  }, [data])

  const close = useCallback(() => {
    workItemOpenStore.close()
  }, [])

  /** Persist the user's only copy locally; reopening restores it. */
  const persistDraft = useCallback(() => {
    if (context === null || data?.file == null || !editing || editDraft === savedContent) return
    savePersistedDraft(context.artifactId, {
      content: editDraft,
      baseRevision: draftBase?.revision ?? data.file.revision,
      baseVersion: draftBase?.baseVersion ?? data.file.fsVersion,
      savedAt: new Date().toISOString(),
    })
  }, [context, data?.file, draftBase, editDraft, editing, savedContent])

  const clearPersistedDraft = useCallback(() => {
    if (context === null) return
    removePersistedDraft(context.artifactId)
  }, [context])

  // Load the work item whenever the context or an explicit retry changes.
  useEffect(() => {
    if (context === null) return
    const contextKey = `${context.ownerSessionId}\u0000${context.artifactId}`
    if (contextKeyRef.current !== contextKey) {
      contextKeyRef.current = contextKey
      setOwnerError(null)
      setDraft('')
      setReplyTarget(null)
      setPendingAttachments([])
      setSelectedThreadId(null)
      setBackArmed(false)
    }
    let active = true
    setPhase(current => (current === 'ready' ? 'ready' : 'loading'))
    setError(null)
    setFileProblem({ notice: null, code: null })
    setSelection(null)
    setPendingAnchor(null)
    const load = async (): Promise<void> => {
      const detail = await workItemApi.detail(context.ownerSessionId, context.artifactId)
      const { file, notice, code } = await readInitialFile(context.ownerSessionId, context.artifactId, detail.record.primaryPath)
      const comments = await workItemApi.comments(context.ownerSessionId, context.artifactId)
      if (!active) return
      setData({
        record: detail.record,
        file,
        events: comments.events,
        dispatches: detail.dispatches,
        hasOlder: olderPageAvailable(comments),
        ...detailMeta(detail),
      })
      setFileProblem({ notice, code })
      setNow(new Date())
      setEditing(false)
      setEditDraft(file?.content ?? '')
      setSavedContent(file?.content ?? '')
      setConflict(null)
      setConflictLatest('')
      setShowConflictDiff(false)
      setSavePhase('saved')
      setBackArmed(false)
      setDraftBase(null)
      if (file !== null) {
        const restored = readPersistedDraft(context.artifactId)
        if (restored !== null && restored.content !== file.content) {
          setEditing(true)
          setEditDraft(restored.content)
          setDraftBase({ revision: restored.baseRevision, baseVersion: restored.baseVersion })
          setReceipt('已恢复上次未保存的草稿')
        } else if (restored !== null) {
          removePersistedDraft(context.artifactId)
        }
      }
      setPhase('ready')
      // Opening the viewer records first-view; the server is idempotent and the
      // failure must not block reading.
      workItemApi.status({ sessionId: context.ownerSessionId, artifactId: context.artifactId, action: 'view' })
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
    return () => {
      active = false
      // Switching to another work item must leave the old draft recoverable.
      persistDraftRef.current()
    }
  }, [context, refreshToken])

  // A different work item starts with the default rail projection.
  useEffect(() => {
    setThreadFilter('all')
    setShowResolved(false)
  }, [context])

  /**
   * Switch to the owning session and make its Cowork tab active.
   *
   * A failure keeps this read-only viewer on screen and is rendered next to the
   * retry; the viewer never pretends the session changed.
   */
  const openOwner = useCallback(async () => {
    if (context === null) return
    setOwnerOpening(true)
    setOwnerError(null)
    const result = await openOwnerSession({
      ownerSessionId: context.ownerSessionId,
      uiWorkspace: services.uiWorkspace,
      sessions: services.sessions,
    })
    setOwnerOpening(false)
    if (!result.ok) setOwnerError(result.message)
  }, [context, services.sessions, services.uiWorkspace])

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
        sessionId: context.ownerSessionId,
        artifactId: context.artifactId,
        path: file.path,
        baseRevision: options?.baseRevision ?? draftBase?.revision ?? file.revision,
        baseVersion: options?.baseVersion === undefined
          ? (draftBase?.baseVersion ?? file.fsVersion)
          : options.baseVersion,
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
      setDraftBase(null)
      clearPersistedDraft()
      setSavePhase('saved')
      setReceipt(response.merged ? '已合并模型修改并保存' : '已保存')
    } catch (error) {
      if (error instanceof WorkItemApiError && error.code === 'artifact/version-conflict') {
        const info = (error as WorkItemApiError & { conflict?: SaveConflict }).conflict ?? null
        setConflict(info)
        setSavePhase('conflict')
        if (info !== null) {
          try {
            const latest = await workItemApi.file(context.ownerSessionId, context.artifactId, file.path)
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
  }, [clearPersistedDraft, context, data, draftBase, editDraft])

  // Debounced autosave: every edit restarts the 800 ms window; a conflict
  // pauses saving until the user picks a resolution.
  useEffect(() => {
    if (!dirty || conflict !== null || data?.file == null) return
    const timer = window.setTimeout(() => { void saveDraft() }, ARTIFACT_SAVE_DEBOUNCE_MS)
    return () => { window.clearTimeout(timer) }
  }, [conflict, data?.file, dirty, draft, saveDraft])

  // Keep the local copy current on every edit, not only after a failed save.
  useEffect(() => {
    if (!dirty) return
    persistDraft()
  }, [dirty, editDraft, persistDraft])

  // Closing or switching work items may unmount this viewer at any time; the
  // stored copy is what the next open restores. Keep the ref current in a
  // separate effect so a successful save (which changes persistDraft) does not
  // run an old closure that still considers the draft dirty.
  useEffect(() => {
    persistDraftRef.current = persistDraft
  }, [persistDraft])
  useEffect(() => () => { persistDraftRef.current() }, [])

  // Editing presence: report the changed lines every 300 ms while the draft
  // differs from the saved text. The server expires the report on its own.
  useEffect(() => {
    if (context === null || data?.file == null || !editing) return
    // A canvas has no line concept: the edit session holds the whole file, not
    // only the lines that changed, so a model write is refused from the moment
    // the user enters edit mode until they leave it.
    const ranges = presenceRangesFor(viewerKindOf(data.record.type), savedContent, editDraft)
    if (ranges.length === 0) return
    const report = (): void => {
      void workItemApi.presence({
        sessionId: context.ownerSessionId,
        artifactId: context.artifactId,
        path: data.file!.path,
        ranges,
      }).catch(() => {})
    }
    report()
    const timer = window.setInterval(report, ARTIFACT_PRESENCE_REPORT_INTERVAL_MS)
    return () => { window.clearInterval(timer) }
  }, [context, data?.file, data?.record.type, editing, savedContent, editDraft])

  /** Leave editing: flush a dirty draft first. */
  const toggleEditing = useCallback(() => {
    if (data?.file == null) return
    if (!editing) {
      // A draft that differs from the last save must not be replaced by the
      // server content (a failed save is the common case): it is the user's
      // only copy until a retry or an explicit discard.
      if (editDraft === savedContent) {
        setEditDraft(data.file.content)
        setSavedContent(data.file.content)
        setSavePhase('saved')
      }
      setEditing(true)
      setConflict(null)
      setReceipt(null)
      return
    }
    if (dirty) void saveDraft()
    setEditing(false)
  }, [data?.file, dirty, editDraft, editing, saveDraft, savedContent])

  /** Back: a dirty draft needs a second click so it is never lost silently. */
  const requestClose = useCallback(() => {
    if (editing && dirty && !backArmed) {
      setBackArmed(true)
      return
    }
    persistDraft()
    close()
  }, [backArmed, close, dirty, editing, persistDraft])

  const loadLatest = useCallback(async () => {
    if (context === null || data?.file == null) return
    try {
      const latest = await workItemApi.file(context.ownerSessionId, context.artifactId, data.file.path)
      const detail = await workItemApi.detail(context.ownerSessionId, context.artifactId)
      setData(reloadedView(data, detail, latest))
      setEditDraft(latest.content)
      setSavedContent(latest.content)
      setConflict(null)
      setConflictLatest('')
      setShowConflictDiff(false)
      setDraftBase(null)
      clearPersistedDraft()
      setCanvasReset(value => value + 1)
      setSavePhase('saved')
      setReceipt('已加载最新内容')
    } catch (error) {
      setReceipt(`加载失败：${messageOf(error)}`)
    }
  }, [clearPersistedDraft, context, data])

  const keepMine = useCallback(() => {
    if (conflict === null) return
    void saveDraft({
      baseVersion: conflict.currentVersion,
      baseRevision: conflict.revision > 0 ? conflict.revision : 1,
    })
  }, [conflict, saveDraft])

  useEffect(() => {
    editingRef.current = editing
    dirtyRef.current = editing && editDraft !== savedContent
    kindRef.current = data === null ? 'source' : viewerKindOf(data.record.type)
    savedTextRef.current = savedContent
  }, [data?.record.type, editDraft, editing, savedContent])

  /**
   * Re-read the record and threads; optionally the file when it changed.
   *
   * Depends only on the open context: the SSE effect subscribes with this
   * callback, so a new `data` identity must not tear the stream down and
   * reconnect. A dirty draft keeps its old file base (so the save merges or
   * conflicts) and only gets a receipt; a clean viewer reloads the content.
   */
  const refreshFromServer = useCallback(async (withFile = false, fileChanged = false) => {
    if (context === null) return
    try {
      const detail = await workItemApi.detail(context.ownerSessionId, context.artifactId)
      const comments = await workItemApi.comments(context.ownerSessionId, context.artifactId)
      let file: ArtifactFileResponse | null = null
      if (withFile) {
        try {
          file = await workItemApi.file(context.ownerSessionId, context.artifactId, detail.record.primaryPath)
        } catch {
          // A missing file keeps the last content; the next event retries.
        }
      }
      const keepDraft = editingRef.current && dirtyRef.current
      setData(current => {
        if (current === null) return current
        const next = {
          ...current,
          record: detail.record,
          events: comments.events,
          dispatches: detail.dispatches,
          hasOlder: olderPageAvailable(comments),
          ...detailMeta(detail, current),
        }
        return file === null || keepDraft ? next : { ...next, file }
      })
      applyRefreshedFile(
        file, fileChanged, keepDraft, kindRef.current, editingRef.current, savedTextRef.current,
        { setEditDraft, setSavedContent, setCanvasReset, setSavePhase, setReceipt },
      )
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
      const url = `${ARTIFACT_EVENTS_PATH}?sessionId=${encodeURIComponent(context.ownerSessionId)}&artifactId=${encodeURIComponent(context.artifactId)}`
      source = new EventSource(url)
      source.onopen = () => {
        if (closed) return
        failures = 0
        setSseNotice(null)
        void refreshFromServer(true)
      }
      // Named SSE events (`event: comment.created`) do not reach `onmessage`;
      // every artifact event type is registered explicitly.
      const onFrame = (message: MessageEvent<string>): void => {
        if (closed) return
        try {
          const event = JSON.parse(message.data) as { type?: unknown }
          if (event.type === 'reset') void refreshFromServer(true)
          if (event.type === 'file.changed') void refreshFromServer(true, true)
          if (
            event.type === 'comment.created'
            || event.type === 'comment.updated'
            || event.type === 'reply.created'
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
          sessionId: context.ownerSessionId,
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

  /** Re-read one file after a rebind and adopt its content. */
  const reloadFile = async (path: string): Promise<void> => {
    if (context === null) return
    try {
      const file = await workItemApi.file(context.ownerSessionId, context.artifactId, path)
      setData(current => (current === null ? current : { ...current, file }))
      setFileProblem({ notice: null, code: null })
      setEditDraft(file.content)
      setSavedContent(file.content)
      setCanvasReset(value => value + 1)
      setSavePhase('saved')
    } catch (reason) {
      const failure = rebindFailure(reason as { code?: string; message?: string })
      const code = (reason as { code?: string }).code ?? null
      setFileProblem({ notice: `${failure.title}：${failure.detail}`, code })
    }
  }

  /** Adopt a committed record and reload the shared viewer data. */
  const applyRecord = (next: ArtifactRecordV1): void => {
    setData(current => withRecord(current, next))
  }

  /** Close the narrow drawer. */
  const closeRail = (): void => { setShowRail(false) }

  const lines = useMemo(() => contentLines(data?.file?.content ?? ''), [data?.file?.content])
  const threads = useMemo(() => sortThreads(foldThreads(data?.events ?? [])), [data?.events])
  const ordinals = useMemo(() => threadOrdinals(threads), [threads])
  const linePins = useMemo(() => threadLinePins(threads), [threads])
  const activeThread = useMemo(
    () => (data?.record.activeDispatch == null
      ? null
      : threadForDispatch(data.record.activeDispatch.dispatchId, data.dispatches, threads)),
    [data?.record.activeDispatch, data?.dispatches, threads],
  )
  const activeOrdinal = activeThread === null ? null : ordinals.get(activeThread.threadId) ?? null
  const footerSummary = useMemo(
    () => (data === null ? '' : deliverySummary(threads, data.dispatches)),
    [data, threads],
  )
  const focusThread = useCallback((thread: WorkItemThread) => {
    setSelectedThreadId(thread.threadId)
    const anchor = thread.anchor
    if (anchor === null || anchor.kind !== 'line-range') return
    setViewTab('document')
    setShowRail(true)
    setSelection({ startLine: anchor.startLine, endLine: anchor.endLine })
    requestAnimationFrame(() => {
      document.querySelector(`[data-line="${String(anchor.startLine)}"]`)?.scrollIntoView({ block: 'center' })
    })
  }, [])

  const anchoredLines = useMemo(() => anchoredLineNumbers(threads), [threads])
  const anchoredLineList = useMemo(
    () => [...anchoredLines].sort((left, right) => left - right),
    [anchoredLines],
  )
  const staleLines = useMemo(() => staleLineNumbers(threads), [threads])
  const attachmentRows = useMemo(() => attachmentRowsOf(threads), [threads])

  const pickLine = (line: number, extend: boolean): void => {
    setSelection(current => selectLine(current, line, extend))
  }

  /** Open the comment entry for one line range and focus its composer. */
  const annotateRange = (startLine: number, endLine: number): void => {
    if (readOnly || data === null) return
    const range = lineRangeAnnotation(lines, data.file, data.record.primaryPath, startLine, endLine)
    if (range === null) return
    setReplyTarget(null)
    setSelection({ startLine: range.startLine, endLine: range.endLine })
    setPendingAnchor({ kind: 'line-range', ...range })
    composerRef.current?.focus()
  }

  const annotate = (): void => {
    if (selection === null) return
    annotateRange(selection.startLine, selection.endLine)
  }

  /** Keyboard annotation from the line list: one line, then the composer. */
  const annotateLine = (line: number): void => { annotateRange(line, line) }

  /** A line's pin opens the thread it numbers. */
  const focusPin = (line: number): void => {
    const thread = pinThread(linePins, threads, line)
    if (thread !== null) focusThread(thread)
  }

  const submit = useCallback(async () => {
    if (context === null || data === null || draft.trim() === '' || submitting) return
    const submitted = {
      draft, anchor: pendingAnchor, reply: replyTarget, selection, attachments: pendingAttachments,
    }
    setSubmitting(true)
    setReceipt(null)
    try {
      const response = await workItemApi.comment({
        sessionId: context.ownerSessionId,
        artifactId: context.artifactId,
        body: submitted.draft.trim(),
        ...(submitted.reply === null
          ? (submitted.anchor === null ? {} : { anchor: submitted.anchor })
          : { threadId: submitted.reply.threadId }),
        ...(submitted.attachments.length === 0 ? {} : { attachments: submitted.attachments }),
      })
      setData(current => current === null
        ? current
        : { ...current, record: response.record, events: [...current.events, response.comment] })
      setDraft(current => clearIfUnchanged(current, submitted.draft, ''))
      setPendingAnchor(current => clearIfUnchanged(current, submitted.anchor, null))
      setReplyTarget(current => clearIfUnchanged(current, submitted.reply, null))
      setSelection(current => clearIfUnchanged(current, submitted.selection, null))
      setPendingAttachments(current => clearIfUnchanged(current, submitted.attachments, []))
      setSelectedThreadId(response.comment.threadId)
      setReceipt(response.dispatchError === null
        ? '评论已提交'
        : `评论已保存，但投递失败：${response.dispatchError.message}`)
    } catch (reason) {
      setReceipt(`提交失败：${messageOf(reason)}`)
    } finally {
      setSubmitting(false)
    }
  }, [context, data, draft, pendingAnchor, pendingAttachments, replyTarget, selection, submitting])

  const startReply = useCallback((thread: WorkItemThread) => {
    if (readOnly) return
    setSelectedThreadId(thread.threadId)
    setReplyTarget(thread)
    setPendingAnchor(null)
    setSelection(null)
    composerRef.current?.focus()
  }, [readOnly])

  const confirmWork = useCallback(async () => {
    if (context === null || confirming) return
    setConfirming(true)
    setReceipt(null)
    try {
      await workItemApi.status({ sessionId: context.ownerSessionId, artifactId: context.artifactId, action: 'confirm' })
      await refreshFromServer()
      setReceipt('已确认完成')
    } catch (reason) {
      setReceipt(`确认失败：${messageOf(reason)}`)
    } finally {
      setConfirming(false)
    }
  }, [confirming, context, refreshFromServer])

  const retryDispatch = useCallback(async (dispatch: ArtifactDispatchSummary) => {
    if (context === null || pendingDispatch !== null) return
    setPendingDispatch(dispatch.dispatchId)
    setReceipt(null)
    try {
      await workItemApi.retryDispatch({
        sessionId: context.ownerSessionId,
        artifactId: context.artifactId,
        dispatchId: dispatch.dispatchId,
      })
      await refreshFromServer()
      setReceipt('已重新投递')
    } catch (reason) {
      setReceipt(`重试失败：${messageOf(reason)}`)
    } finally {
      setPendingDispatch(null)
    }
  }, [context, pendingDispatch, refreshFromServer])

  const toggleThread = useCallback(async (thread: WorkItemThread) => {
    if (context === null || data === null || pendingThread !== null) return
    setPendingThread(thread.threadId)
    setReceipt(null)
    try {
      const response = await workItemApi.resolveComment({
        sessionId: context.ownerSessionId,
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

  const openInApp = useCallback(async () => {
    if (context === null || data?.file == null) return
    setOpening(true)
    setReceipt(null)
    setReceipt(await openReceipt(context.ownerSessionId, context.artifactId))
    setOpening(false)
  }, [context, data?.file])

  const exportCurrentFile = useCallback(() => {
    if (data?.file == null) return
    const name = baseName(data.file.path)
    const url = URL.createObjectURL(new Blob([data.file.content], { type: data.file.mediaType }))
    try {
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      link.remove()
      setReceipt(`已导出 ${name}`)
    } catch (error) {
      setReceipt(`导出失败：${messageOf(error)}`)
    } finally {
      window.setTimeout(() => { URL.revokeObjectURL(url) }, 0)
    }
  }, [data?.file])

  const copyPath = useCallback(async () => {
    const path = data?.record.primaryPath
    if (path === undefined) return
    try {
      await navigator.clipboard.writeText(path)
      setReceipt('路径已复制')
    } catch {
      setReceipt('复制失败：浏览器未授权剪贴板')
    }
  }, [data?.record.primaryPath])

  // The view is registered only while an item is open; a null context here is
  // the closing frame before the registration is disposed.
  if (context === null) return null
  if (phase === 'loading') return <ViewerPlaceholder phase="loading" />
  if (phase === 'error' || data === null) {
    const onRetry = (): void => { setRefreshToken(token => token + 1) }
    return <ViewerPlaceholder phase="error" error={error} onRetry={onRetry} onBack={close} />
  }
  const record = data.record
  const kind = viewerKindOf(record.type)
  // A canvas whose JSON cannot be parsed falls back to the source editor so a
  // broken file stays repairable instead of trapping the user in an error pane.
  const canvasBroken = kind === 'canvas' && data.file !== null && !parseCanvasScene(savedContent).ok
  const activity = activeDispatchSummary(record.activeDispatch)
  const missingFile = missingFileState(record, fileProblem.code)
  const olderBefore = olderCursor(data.events)
  return (
    <div
      className="cwi-viewer"
      data-testid="cwi-viewer"
      data-phase="ready"
      data-artifact-id={record.artifactId}
      data-conversation-composer-overlay=""
    >
      <CrossSessionBanner
        readOnly={readOnly}
        sessionTitle={data.sessionTitle}
        opening={ownerOpening}
        onOpen={() => { void openOwner() }}
      />
      <CrossSessionError
        error={ownerError}
        opening={ownerOpening}
        onRetry={() => { void openOwner() }}
      />
      <ViewerHeader
        record={record}
        file={data.file}
        activity={activity}
        now={now}
        editing={editing}
        confirming={confirming}
        opening={opening}
        readOnly={readOnly}
        onReturn={requestClose}
        onConfirm={() => { void confirmWork() }}
        onToggleEditing={toggleEditing}
        onOpen={() => { void openInApp() }}
        onExport={exportCurrentFile}
        onRefresh={() => { setRefreshToken(token => token + 1) }}
        onCopyPath={() => { void copyPath() }}
      />
      <RebindFileEntry
        state={missingFile}
        context={context}
        record={record}
        onRecord={applyRecord}
        reloadFile={reloadFile}
        onReceipt={setReceipt}
      />
      <ViewerToolbar
        viewTab={viewTab}
        revisions={data.revisions.length}
        attachments={attachmentRows.length}
        editing={editing}
        readMode={readMode}
        savePhase={savePhase}
        revision={data.file?.revision ?? record.revision}
        showRail={showRail}
        threadCount={threads.length}
        onTab={setViewTab}
        onToggleReadMode={() => { setReadMode(value => !value) }}
        onToggleRail={() => { setShowRail(value => !value) }}
      />
      {fileProblem.notice === null ? null : (
        <div className="cwi-receipt" data-testid="cwi-file-notice">{fileProblem.notice}</div>
      )}
      <CollapsedRailReceipt hidden={!showRail} text={receipt} />
      {backArmed
        ? <div className="cwi-receipt" data-testid="cwi-unsaved-notice">还有未保存内容：再点一次返回会关闭查看器</div>
        : null}
      <div className="cwi-body">
        <div className="cwi-content" data-testid="cwi-content" data-kind={kind} data-editing={String(editing)}>
          {sseNotice === null ? null : (
            <div className="cwi-receipt" data-testid="cwi-sse-notice">
              {sseNotice}{' '}
              <button type="button" className="cwi-secondary" data-testid="cwi-sse-retry" onClick={() => { setSseNotice(null); setSseToken(token => token + 1) }}>
                重试
              </button>
            </div>
          )}
          <ConflictCard
            conflict={conflict}
            latest={conflictLatest}
            showDiff={showConflictDiff}
            onToggleDiff={() => { setShowConflictDiff(value => !value) }}
            onLoadLatest={() => { void loadLatest() }}
            onKeepMine={keepMine}
          />
          <DocumentSurface
            kind={kind}
            file={data.file}
            typeName={typeLabel(record.type)}
            visible={viewTab === 'document'}
            editing={editing}
            editDraft={editDraft}
            readMode={readMode}
            canvasBroken={canvasBroken}
            canvasReset={canvasReset}
            readOnly={readOnly}
            artifactId={record.artifactId}
            anchoredLineList={anchoredLineList}
            dirty={dirty}
            conflict={conflict}
            selection={selection}
            lines={lines}
            anchoredLines={anchoredLines}
            staleLines={staleLines}
            pins={linePins}
            attachments={attachmentRows}
            onChangeDraft={(content) => { setEditDraft(content); setBackArmed(false) }}
            onSaveDraft={() => { void saveDraft() }}
            onAnnotate={annotate}
            onAnnotateLine={annotateLine}
            onClearSelection={() => { setSelection(null) }}
            onPickLine={pickLine}
            onPickPin={focusPin}
          />
          {viewTab === 'versions' ? (
            <VersionsPanel record={record} file={data.file} revisions={data.revisions} />
          ) : null}
          {viewTab === 'attachments' ? (
            <AttachmentsPanel
              attachments={attachmentRows}
              urlFor={(attachmentId) => workItemApi.attachmentUrl({
                sessionId: context.ownerSessionId,
                artifactId: context.artifactId,
                attachmentId,
              })}
            />
          ) : null}
        </div>
        <RailEscape narrow={narrow} showRail={showRail} onClose={setShowRail} />
        {railBackdrop(narrow, showRail, closeRail)}
        <aside className="cwi-rail" data-testid="cwi-rail" data-drawer={String(narrow)} hidden={!showRail}>
          <ThreadList
            threads={threads}
            ordinals={ordinals}
            selectedThreadId={selectedThreadId}
            pendingThread={pendingThread}
            now={now}
            dispatches={data.dispatches}
            retrying={pendingDispatch !== null}
            filter={threadFilter}
            showResolved={showResolved}
            hasOlder={olderEntryVisible(data.hasOlder, olderBefore)}
            loadingOlder={loadingOlder}
            drawer={narrow}
            readOnly={readOnly}
            onFilter={setThreadFilter}
            onToggleResolved={() => { setShowResolved(value => !value) }}
            onSelect={(thread) => { setSelectedThreadId(thread.threadId) }}
            onToggle={toggleThread}
            onReply={startReply}
            onRetry={(dispatch) => { void retryDispatch(dispatch) }}
            onFocus={focusThread}
            onLoadOlder={loadOlderPage}
            onCloseDrawer={closeRail}
            attachmentUrl={(attachmentId) => workItemApi.attachmentUrl({
              sessionId: context.ownerSessionId,
              artifactId: context.artifactId,
              attachmentId,
            })}
          >
          {record.activeDispatch === null ? null : (
            <div className="cwi-activity" data-tone={activity?.tone ?? 'active'} data-testid="cwi-activity-strip">
              <span className="cwi-activity-dot" aria-hidden="true" />
              <span className="cwi-activity-label">
                模型正在处理{activeOrdinal === null ? '' : ` #${String(activeOrdinal)}`}：{dispatchDetailLabel(record.activeDispatch.state)}
              </span>
              <span className="cwi-activity-age">{formatElapsed(record.activeDispatch.updatedAt, now)}</span>
            </div>
          )}
          </ThreadList>
          <CommentComposer
            replyTarget={replyTarget}
            pendingAnchor={pendingAnchor}
            draft={draft}
            composerRef={composerRef}
            pendingAttachments={pendingAttachments}
            uploading={uploading}
            submitting={submitting}
            receipt={showRail ? receipt : null}
            readOnly={readOnly}
            onDraft={setDraft}
            onCancelReply={() => { setReplyTarget(null) }}
            onCancelAnchor={() => { setPendingAnchor(null) }}
            onAttach={(files) => { void attachFiles(files) }}
            onRemoveAttachment={(attachmentId) => {
              setPendingAttachments(current => current.filter((entry) => entry.attachmentId !== attachmentId))
            }}
            onSubmit={() => { void submit() }}
          />
        </aside>
      </div>
      <ViewerFooter
        summary={footerSummary}
        revision={data.file?.revision ?? record.revision}
        updatedAt={record.updatedAt}
      />
    </div>
  )
}
