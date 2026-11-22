/**
 * The work-item viewer's header: breadcrumb, title/type/status, file facts, and
 * the action row (confirm, edit, open in app, export, overflow).
 *
 * The header owns only presentation and the overflow menu's open state; every
 * action is a callback owned by the viewer container, which holds the request
 * context and the save/draft state.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  ARTIFACT_STATUS_LABELS,
  type ArtifactFileResponse,
  type ArtifactRecordV1,
} from '../../panel/artifact-contract.js'
import {
  fileSummary,
  formatRelativeTime,
  revisionSummary,
  typeLabel,
  type ActiveDispatchBadge,
} from './model.ts'

/** Props of the viewer header. */
export interface ViewerHeaderProps {
  readonly record: ArtifactRecordV1
  readonly file: ArtifactFileResponse | null
  readonly sessionTitle: string | null
  readonly activity: ActiveDispatchBadge | null
  readonly now: Date
  readonly editing: boolean
  readonly confirming: boolean
  readonly opening: boolean
  readonly canReturn: boolean
  readonly onReturn: () => void
  readonly onConfirm: () => void
  readonly onToggleEditing: () => void
  readonly onOpen: () => void
  readonly onExport: () => void
  readonly onRefresh: () => void
  readonly onCopyPath: () => void
}

/** The location breadcrumb: project shell, owning topic, work item. */
function Crumbs({ sessionTitle }: { readonly sessionTitle: string | null }): ReactElement {
  return (
    <nav className="cwi-crumbs" data-testid="cwi-crumbs" aria-label="位置">
      <span>Cowork</span>
      <span className="cwi-crumb-sep" aria-hidden="true">/</span>
      {sessionTitle === null ? null : (
        <>
          <span className="cwi-crumb-topic" title={sessionTitle}>主题「{sessionTitle}」</span>
          <span className="cwi-crumb-sep" aria-hidden="true">/</span>
        </>
      )}
      <b>工作项</b>
    </nav>
  )
}

/**
 * Render the viewer header.
 * @param props - record/file facts, action state, and action callbacks.
 * @returns the header with the overflow menu it owns.
 */
// Breadcrumb/title/action row plus the overflow menu. The conditional actions
// are the header's state matrix; the browser lane owns the interactions.
// fallow-ignore-next-line complexity
export function ViewerHeader({
  record,
  file,
  sessionTitle,
  activity,
  now,
  editing,
  confirming,
  opening,
  canReturn,
  onReturn,
  onConfirm,
  onToggleEditing,
  onOpen,
  onExport,
  onRefresh,
  onCopyPath,
}: ViewerHeaderProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: PointerEvent): void => {
      if (menuRef.current !== null && event.target instanceof Node && menuRef.current.contains(event.target)) return
      setMenuOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [menuOpen])

  const runMenu = (action: () => void): void => {
    setMenuOpen(false)
    action()
    triggerRef.current?.focus()
  }

  return (
    <header className="cwi-viewer-header">
      <div className="cwi-header-bar">
        <button
          type="button"
          className="cwi-back"
          data-testid="cwi-back"
          onClick={onReturn}
          disabled={!canReturn}
          title={canReturn ? '返回会话' : '当前宿主没有主区域布局服务'}
        >
          <span className="cwi-back-icon" aria-hidden="true">←</span>
          返回会话
        </button>
        <span className="cwi-header-sep" aria-hidden="true">/</span>
        <Crumbs sessionTitle={sessionTitle} />
      </div>
      <div className="cwi-title-row">
        <h1 className="cwi-title" data-testid="cwi-title">{record.title}</h1>
        <span className="cwi-chip cwi-type-chip">{typeLabel(record.type)}</span>
        <span className="cwi-status" data-testid="cwi-status" data-status={record.status}>
          {ARTIFACT_STATUS_LABELS[record.status]}
        </span>
        <span className="cwi-title-spacer" />
        {record.status === 'confirmed' ? null : (
          <button
            type="button"
            className="cwi-primary"
            data-testid="cwi-confirm"
            disabled={confirming}
            onClick={onConfirm}
          >
            {confirming ? '确认中…' : '确认完成'}
          </button>
        )}
        {file === null ? null : (
          <button type="button" className="cwi-secondary" data-testid="cwi-edit" onClick={onToggleEditing}>
            {editing ? '退出编辑' : '编辑'}
          </button>
        )}
        <button
          type="button"
          className="cwi-secondary"
          data-testid="cwi-open"
          disabled={file === null || opening}
          title={file === null ? '文件不可用' : '在本地应用中打开'}
          onClick={onOpen}
        >
          {opening ? '打开中…' : '在应用中打开'}
        </button>
        <button
          type="button"
          className="cwi-secondary"
          data-testid="cwi-export"
          disabled={file === null}
          title={file === null ? '文件不可用' : '导出当前文件'}
          onClick={onExport}
        >
          导出
        </button>
        <div className="cwi-more-wrap" ref={menuRef}>
          <button
            type="button"
            ref={triggerRef}
            className="cwi-secondary cwi-more-button"
            data-testid="cwi-more"
            aria-label="更多操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => { setMenuOpen(value => !value) }}
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="cwi-menu" role="menu" data-testid="cwi-menu">
              <button type="button" role="menuitem" className="cwi-menu-item" data-testid="cwi-menu-copy" onClick={() => { runMenu(onCopyPath) }}>
                复制路径
              </button>
              <button type="button" role="menuitem" className="cwi-menu-item" data-testid="cwi-menu-refresh" onClick={() => { runMenu(onRefresh) }}>
                刷新
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="cwi-sub">
        <span className="cwi-path" data-testid="cwi-primary-path">
          {file === null ? record.primaryPath : fileSummary({ ...record.files[0], size: file.size })}
        </span>
        <span className="cwi-dot" aria-hidden="true" />
        <span className="cwi-sub-fact">{revisionSummary(record.revision, record.commentCount, record.attachmentCount)}</span>
        <span className="cwi-dot" aria-hidden="true" />
        <span className="cwi-sub-fact">更新 {formatRelativeTime(record.updatedAt, now)}</span>
        {activity === null ? null : (
          <span className="cwi-live" data-tone={activity.tone} data-testid="cwi-activity">
            <span className="cwi-live-dot" aria-hidden="true" />
            {activity.label}
          </span>
        )}
      </div>
    </header>
  )
}
