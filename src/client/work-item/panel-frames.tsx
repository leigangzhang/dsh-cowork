/**
 * Small frames of the work-item viewer: the narrow breakpoint, the missing-file
 * rebind entry, the idle/loading/error placeholder, and the drawer dismiss
 * behaviours.
 *
 * They live beside the container so the container stays a readable state
 * machine; each frame owns only its own local form/drawer state and receives
 * request state from the container.
 */
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ArtifactRecordV1 } from '../../panel/artifact-contract.js'
import { workItemApi, type SaveConflict } from './api.ts'
import {
  drawerClosesOnEscape,
  errorPresentation,
  isEscapeKey,
  rebindFailure,
  rebindOldPath,
  rebindReceipt,
  rebindTarget,
  type MissingFileState,
} from './model.ts'
import type { WorkItemOpenContext } from './store.ts'

/** The breakpoint below which the comment rail is a drawer over the content. */
const NARROW_QUERY = '(max-width: 900px)'

/** Track the drawer breakpoint; a host without matchMedia stays wide. */
export function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia(NARROW_QUERY).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(NARROW_QUERY)
    const update = (): void => { setNarrow(query.matches) }
    update()
    query.addEventListener('change', update)
    return () => { query.removeEventListener('change', update) }
  }, [])
  return narrow
}

/** Props of the missing-file rebind entry. */
interface RebindFileProps {
  readonly state: MissingFileState | null
  readonly context: WorkItemOpenContext
  readonly record: ArtifactRecordV1
  /** Cross-session preview: the rebind request is a write and stays disabled. */
  readonly readOnly: boolean
  readonly onRecord: (record: ArtifactRecordV1) => void
  readonly reloadFile: (path: string) => Promise<void>
  readonly onReceipt: (message: string) => void
}

/** Whether the rebind submit is unavailable while busy or read-only. */
function rebindSubmitDisabled(pending: boolean, readOnly: boolean): boolean {
  return pending || readOnly
}

/** Readable reason a read-only preview cannot rebind the primary file. */
function rebindReadOnlyTitle(readOnly: boolean): string | undefined {
  return readOnly ? '跨会话只读：切到所属会话后才能重新绑定文件。' : undefined
}

/** The missing-file entry: one path input, local validation, and the request. */
export function RebindFileEntry({ state, context, record, readOnly, onRecord, reloadFile, onReceipt }: RebindFileProps): ReactElement | null {
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (state === null) return null

  /** Send the validated path, apply the returned record, then re-read the file. */
  const send = async (newPath: string): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      const response = await workItemApi.rebind({
        sessionId: context.ownerSessionId,
        artifactId: context.artifactId,
        oldPath: rebindOldPath(record),
        newPath,
      })
      setValue('')
      onReceipt(rebindReceipt(response.changed, newPath))
      onRecord(response.record)
      await reloadFile(response.record.primaryPath)
    } catch (reason) {
      const failure = rebindFailure(reason as { code?: string; message?: string })
      setError(`${failure.title}：${failure.detail}`)
    } finally {
      setPending(false)
    }
  }

  /** Validate the typed path, then send it. */
  const submit = async (): Promise<void> => {
    if (readOnly) return
    const target = rebindTarget(value)
    if (!target.ok) {
      setError(target.error)
      return
    }
    await send(target.path)
  }

  return (
    <form
      className="cwi-rebind"
      data-testid="cwi-rebind"
      title={rebindReadOnlyTitle(readOnly)}
      onSubmit={(event) => { event.preventDefault(); void submit() }}
    >
      <div className="cwi-rebind-title">
        文件缺失：<span className="cwi-mono">{state.path}</span>
      </div>
      <p className="cwi-rebind-hint">{state.hint}</p>
      <div className="cwi-rebind-row">
        <input
          className="cwi-rebind-input"
          data-testid="cwi-rebind-input"
          value={value}
          disabled={readOnly}
          placeholder="项目内的新路径，如 docs/spec.md"
          aria-label="文件在项目中的新路径"
          onChange={(event) => { setValue(event.target.value) }}
        />
        <button
          type="submit"
          className="cwi-primary"
          data-testid="cwi-rebind-submit"
          disabled={rebindSubmitDisabled(pending, readOnly)}
        >
          {pending ? '绑定中…' : '重新绑定文件'}
        </button>
      </div>
      {error === null ? null : <div className="cwi-rebind-error" data-testid="cwi-rebind-error" role="alert">{error}</div>}
    </form>
  )
}

/** The viewer's loading and error states. */
export function ViewerPlaceholder({ phase, error, onRetry, onBack }: {
  readonly phase: 'loading' | 'error'
  readonly error?: unknown
  readonly onRetry?: () => void
  readonly onBack?: () => void
}): ReactElement {
  if (phase === 'loading') {
    return (
      <div className="cwi-viewer" data-testid="cwi-viewer" data-phase="loading" aria-busy="true" data-conversation-composer-overlay="">
        <div className="cwi-viewer-empty">正在加载工作项…</div>
      </div>
    )
  }
  const presentation = errorPresentation(error as { code?: string; message?: string } | null)
  return (
    <div className="cwi-viewer" data-testid="cwi-viewer" data-phase="error" data-conversation-composer-overlay="">
      <div className="cwi-viewer-empty">
        <div data-testid="cwi-viewer-error">{presentation.title}</div>
        <div>{presentation.detail}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 10 }}>
          <button type="button" className="cwi-secondary" onClick={onRetry}>
            重试
          </button>
          <button type="button" className="cwi-secondary" data-testid="cwi-back" onClick={onBack}>
            返回会话
          </button>
        </div>
      </div>
    </div>
  )
}

/** Escape closes the narrow drawer first and never reaches a submit control. */
export function RailEscape({ narrow, showRail, onClose }: {
  readonly narrow: boolean
  readonly showRail: boolean
  readonly onClose: (open: boolean) => void
}): ReactElement | null {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isEscapeKey(event)) return
      // The header's overflow menu owns Escape while it is open.
      const menuOpen = document.querySelector('.cwi-menu') !== null
      if (!drawerClosesOnEscape(narrow, showRail, menuOpen)) return
      event.preventDefault()
      onClose(false)
      document.querySelector<HTMLButtonElement>('[data-testid="cwi-rail-toggle"]')?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [narrow, showRail, onClose])
  return null
}

/** The narrow drawer's backdrop, or null when the rail is not over content. */
export function railBackdrop(narrow: boolean, showRail: boolean, onClose: () => void): ReactElement | null {
  if (!narrow || !showRail) return null
  return <div className="cwi-rail-backdrop" data-testid="cwi-rail-backdrop" aria-hidden="true" onClick={onClose} />
}

/** The read-only owner banner for a cross-session preview. */
export function CrossSessionBanner({ readOnly, sessionTitle, opening, onOpen }: {
  readonly readOnly: boolean
  readonly sessionTitle: string | null
  readonly opening: boolean
  readonly onOpen: () => void
}): ReactElement | null {
  if (!readOnly) return null
  return (
    <div className="cwi-cross" data-testid="cwi-cross-banner" role="status">
      <span className="cwi-cross-text">
        当前会话不是该工作项所属会话
        {sessionTitle === null ? '' : ` · 所属：主题「${sessionTitle}」`}
      </span>
      <button
        type="button"
        className="cwi-secondary"
        data-testid="cwi-cross-open"
        disabled={opening}
        onClick={onOpen}
      >
        {opening ? '切换中…' : '在所属会话打开'}
      </button>
    </div>
  )
}

/** The failed "open in owning session" attempt, with its retry. */
export function CrossSessionError({ error, opening, onRetry }: {
  readonly error: string | null
  readonly opening: boolean
  readonly onRetry: () => void
}): ReactElement | null {
  if (error === null) return null
  return (
    <div className="cwi-cross-error" data-testid="cwi-cross-error" role="alert">
      <span>{error}</span>
      <button
        type="button"
        className="cwi-secondary"
        data-testid="cwi-cross-retry"
        disabled={opening}
        onClick={onRetry}
      >
        重试
      </button>
    </div>
  )
}

/**
 * A viewer-level receipt for the collapsed rail.
 *
 * The composer inside the rail owns the receipt while the rail is open; when it
 * is collapsed this strip keeps header and menu feedback visible without
 * duplicating the message inside the hidden composer.
 */
export function CollapsedRailReceipt({ hidden, text }: {
  readonly hidden: boolean
  readonly text: string | null
}): ReactElement | null {
  if (!hidden || text === null) return null
  return <div className="cwi-receipt" data-testid="cwi-viewer-receipt" role="status">{text}</div>
}

/** The save-conflict card: the overlapping ranges and its three resolutions. */
export function ConflictCard({ conflict, latest, showDiff, onToggleDiff, onLoadLatest, onKeepMine }: {
  readonly conflict: SaveConflict | null
  readonly latest: string
  readonly showDiff: boolean
  readonly onToggleDiff: () => void
  readonly onLoadLatest: () => void
  readonly onKeepMine: () => void
}): ReactElement | null {
  if (conflict === null) return null
  return (
    <div className="cwi-conflict" data-testid="cwi-conflict" role="alert">
      <div>
        保存冲突：最新内容与你编辑的行重叠（
        {conflict.conflictRanges.map((range) => (range.startLine === range.endLine
          ? `第 ${range.startLine} 行`
          : `第 ${range.startLine}–${range.endLine} 行`)).join('、')}
        ）。
      </div>
      <div className="cwi-composer-row">
        <button type="button" className="cwi-secondary" data-testid="cwi-conflict-diff" onClick={onToggleDiff}>
          查看差异
        </button>
        <button type="button" className="cwi-secondary" data-testid="cwi-conflict-load" onClick={onLoadLatest}>
          加载最新
        </button>
        <button type="button" className="cwi-primary" data-testid="cwi-conflict-keep" onClick={onKeepMine}>
          保留我的
        </button>
      </div>
      {showDiff ? (
        <div className="cwi-conflict-diff">
          <div className="cwi-thread-meta">最新内容</div>
          <pre className="cwi-conflict-latest" data-testid="cwi-conflict-latest">{latest}</pre>
        </div>
      ) : null}
    </div>
  )
}
