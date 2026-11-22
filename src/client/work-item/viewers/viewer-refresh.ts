/**
 * State transitions applied when a server refresh replaces a work-item file.
 *
 * The viewer keeps a dirty draft recoverable and avoids remounting a clean
 * canvas for the save's own `file.changed` replay. This module owns that
 * decision so the unit lane can cover every branch without React.
 */
import type { ArtifactFileResponse } from '../../../panel/artifact-contract.js'
import type { SavePhase } from '../model.ts'
import { refreshResetsCanvas, type ViewerKind } from './document.ts'

/** The state sinks used when a server refresh replaces the file content. */
export interface RefreshFileEffects {
  readonly setEditDraft: (content: string) => void
  readonly setSavedContent: (content: string) => void
  readonly setCanvasReset: (update: (value: number) => number) => void
  readonly setSavePhase: (phase: SavePhase) => void
  readonly setReceipt: (value: string | null) => void
}

/** Tell a dirty editor that the server file moved under its draft. */
function notifyDraftRefresh(fileChanged: boolean, setReceipt: RefreshFileEffects['setReceipt']): void {
  if (fileChanged) setReceipt('模型已修改文件；保存时会自动合并，重叠则提示冲突')
}

/** Mark a clean refresh as saved without touching a dirty draft. */
function markRefreshSavePhase(editing: boolean, setSavePhase: RefreshFileEffects['setSavePhase']): void {
  if (!editing) setSavePhase('saved')
}

/**
 * Apply one server file refresh without tearing down a dirty draft.
 * @param file - refreshed file, or null when the refresh did not fetch one.
 * @param fileChanged - whether the SSE event named a file change.
 * @param keepDraft - whether the editor is dirty and must keep its base.
 * @param kind - the active presentation family.
 * @param editing - whether the editor is open.
 * @param savedContent - file text before the refresh.
 * @param effects - state sinks owned by the viewer container.
 */
export function applyRefreshedFile(
  file: ArtifactFileResponse | null,
  fileChanged: boolean,
  keepDraft: boolean,
  kind: ViewerKind,
  editing: boolean,
  savedContent: string,
  effects: RefreshFileEffects,
): void {
  if (file === null) return
  if (keepDraft) {
    notifyDraftRefresh(fileChanged, effects.setReceipt)
    return
  }
  effects.setEditDraft(file.content)
  effects.setSavedContent(file.content)
  if (refreshResetsCanvas(kind, editing, savedContent, file.content)) {
    effects.setCanvasReset(value => value + 1)
  }
  markRefreshSavePhase(editing, effects.setSavePhase)
}
