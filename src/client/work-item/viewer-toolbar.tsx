/**
 * The viewer toolbar: document/versions/attachments tabs, read-mode switch,
 * save state, and the rail toggle.
 */
import type { ReactElement } from 'react'
import { saveStateLabel, viewerTabs, type SavePhase } from './model.ts'

/** Props of the viewer toolbar. */
interface ViewerToolbarProps {
  readonly viewTab: 'document' | 'versions' | 'attachments'
  readonly revisions: number
  readonly attachments: number
  readonly editing: boolean
  readonly readMode: boolean
  readonly savePhase: SavePhase
  readonly revision: number
  readonly showRail: boolean
  readonly threadCount: number
  readonly onTab: (tab: 'document' | 'versions' | 'attachments') => void
  readonly onToggleReadMode: () => void
  readonly onToggleRail: () => void
}

/** Render the viewer toolbar. */
// Tab/mode/save display matrix; the browser lane owns these states.
// fallow-ignore-next-line complexity
export function ViewerToolbar({
  viewTab,
  revisions,
  attachments,
  editing,
  readMode,
  savePhase,
  revision,
  showRail,
  threadCount,
  onTab,
  onToggleReadMode,
  onToggleRail,
}: ViewerToolbarProps): ReactElement {
  return (
    <div className="cwi-toolbar">
      <div className="cwi-view-tabs" role="tablist" aria-label="工作项视图">
        {viewerTabs(revisions, attachments).map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="cwi-view-tab"
            data-testid="cwi-view-tab"
            data-tab={id}
            data-active={viewTab === id ? 'true' : 'false'}
            aria-selected={viewTab === id}
            onClick={() => { onTab(id) }}
          >
            {label}
          </button>
        ))}
      </div>
      <span className="cwi-spacer" />
      {viewTab === 'document' && !editing ? (
        <button
          type="button"
          className="cwi-mode"
          data-testid="cwi-mode"
          data-mode={readMode ? 'read' : 'source'}
          aria-pressed={readMode}
          aria-label="切换阅读或源码视图"
          title={readMode ? '切换到源码视图' : '切换到阅读视图'}
          onClick={onToggleReadMode}
        >
          <span className="cwi-mode-option" data-active={readMode ? 'true' : 'false'}>阅读</span>
          <span className="cwi-mode-option" data-active={readMode ? 'false' : 'true'}>源码</span>
        </button>
      ) : null}
      <span className="cwi-save" data-testid="cwi-save-state" data-phase={editing ? savePhase : 'readonly'}>
        <span className="cwi-save-dot" aria-hidden="true" />
        {editing ? saveStateLabel(savePhase, revision) : '只读'}
      </span>
      <button
        type="button"
        className="cwi-rail-toggle"
        data-testid="cwi-rail-toggle"
        data-visible={showRail ? 'true' : 'false'}
        aria-expanded={showRail}
        onClick={onToggleRail}
      >
        批注{threadCount === 0 ? '' : ` ${String(threadCount)}`}
      </button>
    </div>
  )
}
