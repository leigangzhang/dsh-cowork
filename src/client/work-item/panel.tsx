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
  type AttachmentPublishV1,
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
import { createReadingSurface } from './reading-surface.ts'
import {
  activeDispatchSummary,
  anchoredLineNumbers,
  attachmentDisplayRows,
  type AttachmentDisplayRow,
  baseName,
  detailMeta,
  contentLines,
  errorPresentation,
  foldThreads,
  missingFileState,
  olderCall,
  olderCursor,
  olderEntryVisible,
  olderPageAvailable,
  readOwnDraft,
  rebindFailure,
  removePersistedDraft,
  savePersistedDraft,
  saveTarget,
  selectLine,
  sortThreads,
  staleLineNumbers,
  typeLabel,
  type LineSelection,
  type OlderCall,
  type SavePhase,
  type WorkItemThread,
  deliverySummary,
  threadForDispatch,
  withOlderPage,
  withRecord,
  threadLinePins,
  threadOrdinals,
  type ThreadFilter,
} from './model.ts'
import { openOwnerSession } from './session-open.ts'
import { workItemOpenStore, type WorkItemOpenContext } from './store.ts'
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
import { CommentRail, useRailNavigation } from './rail.tsx'
import { ViewerFooter } from './viewer-footer.tsx'
import { ViewerToolbar } from './viewer-toolbar.tsx'
import { ViewerHeader } from './viewer-header.tsx'
import { AttachmentsPanel, VersionsPanel } from './viewer-side-tabs.tsx'
import { AttachmentPreviewProvider } from './attachment-preview.tsx'

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
  /** Published attachment log, or null on a host that predates it. */
  readonly publishedAttachments: readonly AttachmentPublishV1[] | null
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

/**
 * The owner context one delivery retry may use, or null when the action must
 * not run: read-only preview, no open context, or a retry already in flight.
 */
function deliveryRetryTarget(
  readOnly: boolean,
  context: WorkItemOpenContext | null,
  pending: string | null,
): WorkItemOpenContext | null {
  return readOnly || pending !== null ? null : context
}

/** Clear submitted UI state only when the user has not replaced it meanwhile. */
function clearIfUnchanged<T>(current: T, submitted: T, cleared: T): T {
  return current === submitted ? cleared : current
}

/** The rail ordinal of one thread, or null when the thread is not in view. */
function ordinalOf(
  thread: WorkItemThread | null,
  ordinals: ReadonlyMap<string, number>,
): number | null {
  return thread === null ? null : (ordinals.get(thread.threadId) ?? null)
}

/** Focus the rail composer after the state flush that reveals the rail. */
function focusComposerAfterFlush(ref: { readonly current: HTMLTextAreaElement | null }): void {
  requestAnimationFrame(() => { ref.current?.focus() })
}

/** The footer's delivery line for the loaded data, or empty before load. */
function deliveryLine(
  data: { readonly dispatches: readonly ArtifactDispatchSummary[] } | null,
  threads: readonly WorkItemThread[],
): string {
  return data === null ? '' : deliverySummary(threads, data.dispatches)
}

/** The thread the record's active dispatch belongs to, if any. */
function activeThreadOf(
  data: { readonly record: ArtifactRecordV1; readonly dispatches: readonly ArtifactDispatchSummary[] } | null,
  threads: readonly WorkItemThread[],
): WorkItemThread | null {
  if (data === null || data.record.activeDispatch === null) return null
  return threadForDispatch(data.record.activeDispatch.dispatchId, data.dispatches, threads)
}

/** Whether a canvas file cannot be parsed and must fall back to the editor. */
function canvasUnreadable(kind: ViewerKind, file: ArtifactFileResponse | null, content: string): boolean {
  return kind === 'canvas' && file !== null && !parseCanvasScene(content).ok
}

/** Source lines of the loaded file, or an empty list before it arrives. */
function linesOf(file: ArtifactFileResponse | null | undefined): string[] {
  return file == null ? [] : contentLines(file.content)
}

/** Attachment URL in the owner session, or null without an open context. */
function ownerAttachmentUrl(context: WorkItemOpenContext | null, attachmentId: string): string | null {
  if (context === null) return null
  return workItemApi.attachmentUrl({
    sessionId: context.ownerSessionId,
    artifactId: context.artifactId,
    attachmentId,
  })
}

/** Reopen a persisted draft for the owning session, never for a preview. */
function restoreDraft(
  file: ArtifactFileResponse | null,
  crossSession: boolean,
  artifactId: string,
  sinks: {
    readonly setEditing: (value: boolean) => void
    readonly setReadMode: (value: boolean) => void
    readonly setReadFocusToken: (value: number) => void
    readonly setEditDraft: (value: string) => void
    readonly setDraftBase: (value: { revision: number; baseVersion: string | null } | null) => void
    readonly setReceipt: (value: string | null) => void
  },
): void {
  if (file === null) return
  const restored = readOwnDraft(artifactId, crossSession)
  if (restored === null) return
  if (restored.content === file.content) {
    removePersistedDraft(artifactId)
    return
  }
  sinks.setEditing(true)
  sinks.setReadMode(false)
  sinks.setReadFocusToken(0)
  sinks.setEditDraft(restored.content)
  sinks.setDraftBase({ revision: restored.baseRevision, baseVersion: restored.baseVersion })
  sinks.setReceipt('已恢复上次未保存的草稿')
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

/** State setters the attachment upload writes. */
interface AttachmentUploadSinks {
  readonly setReceipt: Dispatch<SetStateAction<string | null>>
  readonly setUploading: Dispatch<SetStateAction<boolean>>
  readonly setPendingAttachments: Dispatch<SetStateAction<AttachmentRefV1[]>>
}

async function uploadAttachment(
  context: WorkItemOpenContext,
  file: File,
  publish: boolean,
): Promise<AttachmentRefV1> {
  const uploaded = await workItemApi.upload({
    sessionId: context.ownerSessionId,
    artifactId: context.artifactId,
    name: file.name,
    bytes: file,
  })
  if (!publish) return uploaded.attachment
  const published = await workItemApi.attachArtifact({
    sessionId: context.ownerSessionId,
    artifactId: context.artifactId,
    attachmentId: uploaded.attachment.attachmentId,
    name: uploaded.attachment.name,
  })
  return published.attachment
}

/** The most pending attachments one comment keeps. */
const MAX_PENDING_ATTACHMENTS = 5

async function uploadAttachments(
  context: WorkItemOpenContext,
  files: readonly File[],
  publish: boolean,
): Promise<AttachmentRefV1[]> {
  const added: AttachmentRefV1[] = []
  for (const file of files) added.push(await uploadAttachment(context, file, publish))
  return added
}

/** The context an upload can run in, or null while the viewer is not ready. */
function uploadTarget(context: WorkItemOpenContext | null, ready: boolean): WorkItemOpenContext | null {
  return context !== null && ready ? context : null
}

/** The bounded file list of one upload, or null when it carries nothing. */
function uploadFiles(files: FileList | readonly File[] | null): File[] | null {
  if (files === null) return null
  const list = Array.from(files).slice(0, MAX_PENDING_ATTACHMENTS)
  return list.length === 0 ? null : list
}

/** One upload attempt: the target, the files, and whether to publish first. */
function uploadPlan(
  context: WorkItemOpenContext | null,
  ready: boolean,
  files: FileList | readonly File[] | null,
): { readonly target: WorkItemOpenContext; readonly files: File[] } | null {
  const target = uploadTarget(context, ready)
  if (target === null) return null
  const list = uploadFiles(files)
  return list === null ? null : { target, files: list }
}

/**
 * Upload picked files for the next comment; `publish` (paste) publishes them
 * before they join the pending list (the comment path re-publishes idempotently).
 */
function useAttachmentUpload(
  context: WorkItemOpenContext | null,
  ready: boolean,
  sinks: AttachmentUploadSinks,
): (files: FileList | readonly File[] | null, options?: { readonly publish?: boolean }) => Promise<void> {
  const { setPendingAttachments, setReceipt, setUploading } = sinks
  return useCallback(async (
    files: FileList | readonly File[] | null,
    options?: { readonly publish?: boolean },
  ) => {
    const plan = uploadPlan(context, ready, files)
    if (plan === null) return
    setUploading(true)
    setReceipt(null)
    try {
      const added = await uploadAttachments(plan.target, plan.files, options?.publish === true)
      setPendingAttachments(current => [...current, ...added].slice(0, MAX_PENDING_ATTACHMENTS))
    } catch (error) {
      setReceipt(`附件上传失败：${messageOf(error)}`)
    } finally {
      setUploading(false)
    }
  }, [context, ready, setPendingAttachments, setReceipt, setUploading])
}

function useAttachmentRows(data: ViewerData | null, threads: readonly WorkItemThread[]): readonly AttachmentDisplayRow[] {
  const published = data?.publishedAttachments ?? null
  return useMemo(() => attachmentDisplayRows(published, threads), [published, threads])
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
  /** Block line to bring to the top after switching source → read. */
  const [readFocusLine, setReadFocusLine] = useState<number | null>(null)
  /** Bumped on every focus request so the same line scrolls again. */
  const [readFocusToken, setReadFocusToken] = useState(0)
  /** Top visible source line of the active surface, shared by the switch. */
  const viewportLineRef = useRef(1)
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
  const dirty = data !== null && data.file !== null && editDraft !== savedContent
  const [ownerOpening, setOwnerOpening] = useState(false)
  const [ownerError, setOwnerError] = useState<string | null>(null)
  const crossSession = context !== null && context.ownerSessionId !== sessionId
  // Cross-session viewers are read-only previews: editing, confirming, and
  // commenting all belong to the owning session.
  const readOnly = crossSession
  const {
    showRail, state: rail, setShowRail, toggleRail, openSession, openThread, focusAnchor,
    backToList: backToRailList, closeRail, reset: resetRail,
  } = useRailNavigation({
    setSelectedThreadId, setViewTab, setSelection,
    setReadFocusLine, setReadFocusToken, setReplyTarget,
  })

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
    if (context === null || data?.file == null || readOnly || editDraft === savedContent) return
    savePersistedDraft(context.artifactId, {
      content: editDraft,
      baseRevision: draftBase?.revision ?? data.file.revision,
      baseVersion: draftBase?.baseVersion ?? data.file.fsVersion,
      savedAt: new Date().toISOString(),
    })
  }, [context, data?.file, draftBase, editDraft, readOnly, savedContent])

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
      setReadMode(true)
      setReadFocusLine(null)
      viewportLineRef.current = 1
      setEditDraft(file?.content ?? '')
      setSavedContent(file?.content ?? '')
      setConflict(null)
      setConflictLatest('')
      setShowConflictDiff(false)
      setSavePhase('saved')
      setBackArmed(false)
      setDraftBase(null)
      restoreDraft(file, crossSession, context.artifactId, {
        setEditing, setReadMode, setReadFocusToken, setEditDraft, setDraftBase, setReceipt,
      })
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
  }, [context, crossSession, refreshToken])

  // A different work item starts with the default rail projection and the
  // list level; the session target and its filter never leak across items.
  useEffect(() => {
    setThreadFilter('all')
    setShowResolved(false)
    resetRail()
  }, [context, resetRail])

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
    const target = saveTarget(readOnly, context, data === null ? null : data.file)
    if (target === null) return
    const { owner, file } = target
    const content = options?.content ?? editDraft
    setSavePhase('saving')
    setBackArmed(false)
    try {
      const response = await workItemApi.edit({
        sessionId: owner.ownerSessionId,
        artifactId: owner.artifactId,
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
            const latest = await workItemApi.file(owner.ownerSessionId, owner.artifactId, file.path)
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
  }, [clearPersistedDraft, context, data, draftBase, editDraft, readOnly])

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

  /** Back: a dirty draft needs a second click so it is never lost silently. */
  const requestClose = useCallback(() => {
    if (dirty && !backArmed) {
      setBackArmed(true)
      return
    }
    persistDraft()
    close()
  }, [backArmed, close, dirty, persistDraft])

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
    // A draft can be dirty while the reading surface shows it; the refresh
    // guard and the exit warning both own the user's only copy.
    dirtyRef.current = editDraft !== savedContent
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
      const keepDraft = dirtyRef.current
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

  const attachFiles = useAttachmentUpload(context, data !== null, {
    setReceipt, setUploading, setPendingAttachments,
  })

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

  const lines = useMemo(() => linesOf(data?.file), [data?.file])
  const threads = useMemo(() => sortThreads(foldThreads(data?.events ?? [])), [data?.events])
  const ordinals = useMemo(() => threadOrdinals(threads), [threads])
  const linePins = useMemo(() => threadLinePins(threads), [threads])
  const activeThread = useMemo(() => activeThreadOf(data, threads), [data, threads])
  const activeOrdinal = ordinalOf(activeThread, ordinals)
  const footerSummary = useMemo(() => deliveryLine(data, threads), [data, threads])
  const attachmentUrl = useCallback(
    (attachmentId: string) => ownerAttachmentUrl(context, attachmentId),
    [context],
  )

  const anchoredLines = useMemo(() => anchoredLineNumbers(threads), [threads])
  const anchoredLineList = useMemo(
    () => [...anchoredLines].sort((left, right) => left - right),
    [anchoredLines],
  )
  const staleLines = useMemo(() => staleLineNumbers(threads), [threads])
  const attachmentRows = useAttachmentRows(data, threads)

  const pickLine = (line: number, extend: boolean): void => {
    setSelection(current => selectLine(current, line, extend))
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
      openSession(response.comment.threadId)
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
    openSession(thread.threadId)
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
    const target = deliveryRetryTarget(readOnly, context, pendingDispatch)
    if (target === null) return
    setPendingDispatch(dispatch.dispatchId)
    setReceipt(null)
    try {
      await workItemApi.retryDispatch({
        sessionId: target.ownerSessionId,
        artifactId: target.artifactId,
        dispatchId: dispatch.dispatchId,
      })
      await refreshFromServer()
      setReceipt('已重新投递')
    } catch (reason) {
      setReceipt(`重试失败：${messageOf(reason)}`)
    } finally {
      setPendingDispatch(null)
    }
  }, [context, pendingDispatch, readOnly, refreshFromServer])

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
  const canvasBroken = canvasUnreadable(kind, data.file, savedContent)
  const activity = activeDispatchSummary(record.activeDispatch)
  const missingFile = missingFileState(record, fileProblem.code)
  const olderBefore = olderCursor(data.events)
  const reading = createReadingSurface({
    kind, file: data.file, record, lines, threads, pins: linePins, selectedThreadId, selection,
    dirty, conflict, readOnly, editing, readMode, editDraft, savedContent, viewportLineRef,
    focusLine: readFocusLine, focusToken: readFocusToken, viewTab, attachmentUrl,
  }, {
    setEditing, setReadMode, setEditDraft, setSavedContent, setSavePhase, setConflict, setReceipt,
    setSelection, setPendingAnchor, setReplyTarget, setViewTab, setShowRail,
    setReadFocusLine: (line) => { setReadFocusLine(line); setReadFocusToken(token => token + 1) },
    clearThread: () => { setSelectedThreadId(null) },
    focusComposer: () => { focusComposerAfterFlush(composerRef) },
    openThread,
  })
  return (
    <AttachmentPreviewProvider
      urlFor={(attachmentId) => workItemApi.attachmentUrl({
        sessionId: context.ownerSessionId,
        artifactId: context.artifactId,
        attachmentId,
      })}
    >
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
          onToggleEditing={reading.toggleEditing}
          onOpen={() => { void openInApp() }}
          onExport={exportCurrentFile}
          onRefresh={() => { setRefreshToken(token => token + 1) }}
          onCopyPath={() => { void copyPath() }}
        />
        <RebindFileEntry
          state={missingFile}
          context={context}
          record={record}
          readOnly={readOnly}
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
          showMode={reading.showMode}
          savePhase={savePhase}
          dirty={dirty}
          revision={data.file?.revision ?? record.revision}
          showRail={showRail}
          threadCount={threads.length}
          onTab={setViewTab}
          onToggleReadMode={reading.toggleReadMode}
          onToggleRail={toggleRail}
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
              reading={reading.config}
              editorStartLine={viewportLineRef.current}
              onChangeDraft={(content) => { setEditDraft(content); setBackArmed(false) }}
              onSaveDraft={() => { void saveDraft() }}
              onAnnotateRange={reading.annotateLines}
              onClearSelection={() => { setSelection(null) }}
              onPickLine={pickLine}
              onPickPin={reading.focusPin}
            />
            {viewTab === 'versions' ? (
              <VersionsPanel record={record} file={data.file} revisions={data.revisions} />
            ) : null}
            {viewTab === 'attachments' ? (
              <AttachmentsPanel
                rows={attachmentRows}
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
          <CommentRail
            visible={showRail}
            state={rail}
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
            activeDispatch={record.activeDispatch}
            activeOrdinal={activeOrdinal}
            draft={draft}
            composerRef={composerRef}
            pendingAttachments={pendingAttachments}
            uploading={uploading}
            submitting={submitting}
            receipt={receipt}
            replyTarget={replyTarget}
            pendingAnchor={pendingAnchor}
            onFilter={setThreadFilter}
            onToggleResolved={() => { setShowResolved(value => !value) }}
            onEnterThread={openThread}
            onLocate={focusAnchor}
            onToggle={toggleThread}
            onReply={startReply}
            onRetry={(dispatch) => { void retryDispatch(dispatch) }}
            onLoadOlder={loadOlderPage}
            onCloseDrawer={closeRail}
            onBackToList={backToRailList}
            attachmentUrl={(attachmentId) => workItemApi.attachmentUrl({
              sessionId: context.ownerSessionId,
              artifactId: context.artifactId,
              attachmentId,
            })}
            onDraft={setDraft}
            onCancelReply={() => { setReplyTarget(null) }}
            onCancelAnchor={() => { setPendingAnchor(null) }}
            onAttach={(
              files: FileList | readonly File[] | null,
              options?: { readonly publish?: boolean },
            ) => { void attachFiles(files, options) }}
            onRemoveAttachment={(attachmentId) => {
              setPendingAttachments(current => current.filter((entry) => entry.attachmentId !== attachmentId))
            }}
            onSubmit={() => { void submit() }}
          />
        </div>
        <ViewerFooter
          summary={footerSummary}
          revision={data.file?.revision ?? record.revision}
          updatedAt={record.updatedAt}
        />
      </div>
    </AttachmentPreviewProvider>
  )
}
