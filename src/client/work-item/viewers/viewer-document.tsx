/**
 * Document-tab surfaces for the work-item viewer.
 *
 * The container owns loading, saving, and presence. These components only
 * choose the editor or read-only renderer for the active artifact family, so
 * each function stays below the full-function thresholds as new viewer types
 * arrive.
 */
import type { ReactElement } from 'react'
import type { ArtifactFileResponse } from '../../../panel/artifact-contract.js'
import type { SaveConflict } from '../api.ts'
import { TextEditor } from '../editor.tsx'
import type { LineSelection } from '../model.ts'
import { CanvasSurface } from './canvas.tsx'
import { editorLanguage, readSurfaceKind, sourceLinesMarkdown, type ViewerKind } from './document.ts'
import { DiagramView } from './diagram.tsx'
import { HtmlPreview } from './html.tsx'
import { SourceLines } from './source-lines.tsx'

/** Props shared by the document-tab renderers. */
export interface DocumentSurfaceProps {
  readonly kind: ViewerKind
  readonly file: ArtifactFileResponse | null
  readonly visible: boolean
  readonly editing: boolean
  readonly editDraft: string
  readonly readMode: boolean
  readonly canvasBroken: boolean
  readonly canvasReset: number
  readonly artifactId: string
  readonly anchoredLineList: readonly number[]
  readonly dirty: boolean
  readonly conflict: SaveConflict | null
  readonly selection: LineSelection | null
  readonly lines: readonly string[]
  readonly anchoredLines: ReadonlySet<number>
  readonly onChangeDraft: (content: string) => void
  readonly onSaveDraft: () => void
  readonly onAnnotate: () => void
  readonly onClearSelection: () => void
  readonly onPickLine: (line: number, extend: boolean) => void
}

/** The editor used by the document tab. */
function EditorSurface({
  kind,
  editDraft,
  canvasBroken,
  canvasReset,
  artifactId,
  anchoredLineList,
  dirty,
  conflict,
  onChangeDraft,
  onSaveDraft,
}: Pick<DocumentSurfaceProps,
  | 'kind'
  | 'editDraft'
  | 'canvasBroken'
  | 'canvasReset'
  | 'artifactId'
  | 'anchoredLineList'
  | 'dirty'
  | 'conflict'
  | 'onChangeDraft'
  | 'onSaveDraft'
>): ReactElement {
  const sceneKey = `edit-${artifactId}-${String(canvasReset)}`
  return kind === 'canvas' && !canvasBroken ? (
    <CanvasSurface
      key={sceneKey}
      content={editDraft}
      editable
      sceneKey={sceneKey}
      onChange={onChangeDraft}
    />
  ) : (
    <TextEditor
      value={editDraft}
      language={editorLanguage(kind, canvasBroken)}
      ariaLabel="编辑文件内容"
      anchoredLines={anchoredLineList}
      anchorsAuthoritative={!dirty}
      onChange={onChangeDraft}
      onBlur={() => { if (dirty && conflict === null) onSaveDraft() }}
    />
  )
}

/** The source-line surface, including the range annotation bar. */
function SourceSurface({
  selection,
  lines,
  anchoredLines,
  markdown,
  onAnnotate,
  onClearSelection,
  onPickLine,
}: Pick<DocumentSurfaceProps, 'selection' | 'lines' | 'anchoredLines' | 'onAnnotate' | 'onClearSelection' | 'onPickLine'> & {
  readonly markdown: boolean
}): ReactElement {
  return (
    <>
      {selection === null ? null : (
        <div className="cwi-selection-bar">
          <span>
            已选第 {selection.startLine}
            {selection.endLine === selection.startLine ? '' : `–${selection.endLine}`} 行
          </span>
          <button type="button" className="cwi-primary" data-testid="cwi-annotate" onClick={onAnnotate}>
            批注
          </button>
          <button type="button" className="cwi-secondary" onClick={onClearSelection}>
            取消
          </button>
        </div>
      )}
      <SourceLines
        lines={lines}
        selection={selection}
        anchoredLines={anchoredLines}
        markdown={markdown}
        onPick={onPickLine}
      />
    </>
  )
}

/** The document tab in read or source mode. */
function ReadSurface({
  kind,
  file,
  readMode,
  selection,
  lines,
  anchoredLines,
  onAnnotate,
  onClearSelection,
  onPickLine,
}: Pick<DocumentSurfaceProps,
  | 'kind'
  | 'file'
  | 'readMode'
  | 'selection'
  | 'lines'
  | 'anchoredLines'
  | 'onAnnotate'
  | 'onClearSelection'
  | 'onPickLine'
>): ReactElement {
  const surface = readSurfaceKind(kind, readMode, file !== null)
  // `readSurfaceKind` only returns a renderer when the file exists.
  if (surface === 'diagram') return <DiagramView source={file!.content} />
  if (surface === 'html') return <HtmlPreview source={file!.content} />
  if (surface === 'canvas') {
    const sceneKey = `view-${String(file!.revision)}`
    return <CanvasSurface key={sceneKey} content={file!.content} editable={false} sceneKey={sceneKey} />
  }
  return (
    <SourceSurface
      selection={selection}
      lines={lines}
      anchoredLines={anchoredLines}
      markdown={sourceLinesMarkdown(kind, readMode)}
      onAnnotate={onAnnotate}
      onClearSelection={onClearSelection}
      onPickLine={onPickLine}
    />
  )
}

/**
 * Render the active document tab.
 * @param props - editor/read state and callbacks owned by the viewer container.
 * @returns the document surface for the active artifact family.
 */
export function DocumentSurface(props: DocumentSurfaceProps): ReactElement {
  return (
    <div
      className="cwi-doc-view"
      data-testid="cwi-doc-view"
      data-kind={props.kind}
      hidden={!props.visible}
      data-mode={props.readMode ? 'read' : 'source'}
    >
      {props.editing ? <EditorSurface {...props} /> : <ReadSurface {...props} />}
    </div>
  )
}
