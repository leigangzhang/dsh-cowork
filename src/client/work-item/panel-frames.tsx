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
import { workItemApi } from './api.ts'
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
  readonly onRecord: (record: ArtifactRecordV1) => void
  readonly reloadFile: (path: string) => Promise<void>
  readonly onReceipt: (message: string) => void
}

/** The missing-file entry: one path input, local validation, and the request. */
export function RebindFileEntry({ state, context, record, onRecord, reloadFile, onReceipt }: RebindFileProps): ReactElement | null {
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
          placeholder="项目内的新路径，如 docs/spec.md"
          aria-label="文件在项目中的新路径"
          onChange={(event) => { setValue(event.target.value) }}
        />
        <button type="submit" className="cwi-primary" data-testid="cwi-rebind-submit" disabled={pending}>
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
