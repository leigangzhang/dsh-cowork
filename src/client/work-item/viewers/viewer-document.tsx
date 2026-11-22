/**
 * Document-tab surfaces for the work-item viewer.
 *
 * The container owns loading, saving, and presence. These components only
 * choose the editor or read-only renderer for the active artifact family, so
 * each function stays below the full-function thresholds as new viewer types
 * arrive.
 *
 * Text-based families render on a centred paper card with a file head: the
 * stored lines are still the annotation surface, but the reading view looks
 * like a document rather than an editor. Diagram, HTML, and canvas keep their
 * own renderer and card.
 */
import type { ReactElement } from 'react'
import type { ArtifactFileResponse } from '../../../panel/artifact-contract.js'
import type { SaveConflict } from '../api.ts'
import { TextEditor } from '../editor.tsx'
import { formatBytes, type LineSelection } from '../model.ts'
import { CanvasSurface } from './canvas.tsx'
import { editorLanguage, readSurfaceKind, sourceLinesMarkdown, type ViewerKind } from './document.ts'
import { DiagramView } from './diagram.tsx'
import { HtmlPreview } from './html.tsx'
import { SourceLines } from './source-lines.tsx'

/** Props shared by the document-tab renderers. */
export interface DocumentSurfaceProps {
  readonly kind: ViewerKind
  readonly file: ArtifactFileResponse | null
  readonly typeName: string
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

/** The last path segment, which is what the paper head names. */
function baseName(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}

/** The two-letter file badge of one viewer family. */
const FILE_BADGES: Readonly<Record<ViewerKind, string>> = {
  text: 'MD',
  diagram: 'MM',
  html: 'H',
  canvas: 'EX',
  source: 'TXT',
}

/** The badge of one viewer family. */
function fileBadge(kind: ViewerKind): string {
  return FILE_BADGES[kind]
}

/** The file strip above a paper surface. */
function FileHead({ kind, file, typeName }: {
  readonly kind: ViewerKind
  readonly file: ArtifactFileResponse
  readonly typeName: string
}): ReactElement {
  return (
    <div className="cwi-paper-head" data-testid="cwi-file-head">
      <span className="cwi-file-icon" data-kind={kind}>{fileBadge(kind)}</span>
      <span className="cwi-file-name" title={file.path}>{baseName(file.path)}</span>
      <span className="cwi-file-meta">{typeName} · r{file.revision}</span>
      <span className="cwi-paper-spacer" />
      <span className="cwi-file-meta">{formatBytes(file.size)}</span>
    </div>
  )
}

/** Props of a paper card; the head only renders when a file is loaded. */
interface PaperProps {
  readonly kind: ViewerKind
  readonly file: ArtifactFileResponse | null
  readonly typeName: string
  readonly children: ReactElement | readonly ReactElement[]
  readonly footer?: string | undefined
}

/** The centred document card shared by text, diagram, and source surfaces. */
function Paper({ kind, file, typeName, children, footer }: PaperProps): ReactElement {
  return (
    <section className="cwi-paper" data-testid="cwi-paper">
      {file === null ? null : <FileHead kind={kind} file={file} typeName={typeName} />}
      <div className="cwi-paper-body">{children}</div>
      <div className="cwi-paper-foot">
        <span className="cwi-paper-hint">{footer ?? '选中行后可直接批注 · 模型回复会挂到批注上'}</span>
      </div>
    </section>
  )
}

/** The editor used by the document tab. */
function EditorSurface({
  kind,
  file,
  typeName,
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
  | 'file'
  | 'typeName'
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
  if (kind === 'canvas' && !canvasBroken) {
    return <CanvasSurface key={sceneKey} content={editDraft} editable sceneKey={sceneKey} onChange={onChangeDraft} />
  }
  return (
    <Paper kind={kind} file={file} typeName={typeName} footer="编辑中：失焦或退出编辑时保存，冲突时停在同一版本">
      <div className="cwi-editor-paper">
        <TextEditor
          value={editDraft}
          language={editorLanguage(kind, canvasBroken)}
          ariaLabel="编辑文件内容"
          anchoredLines={anchoredLineList}
          anchorsAuthoritative={!dirty}
          onChange={onChangeDraft}
          onBlur={() => { if (dirty && conflict === null) onSaveDraft() }}
        />
      </div>
    </Paper>
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
  typeName,
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
  | 'typeName'
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
  if (surface === 'diagram') {
    return (
      <Paper kind={kind} file={file} typeName={typeName} footer="图表按文本保存 · 切到源码修改 Mermaid 文本">
        <div className="cwi-figure" data-testid="cwi-figure">
          <DiagramView source={file!.content} />
        </div>
      </Paper>
    )
  }
  if (surface === 'html') return <HtmlPreview source={file!.content} />
  if (surface === 'canvas') {
    const sceneKey = `view-${String(file!.revision)}`
    return <CanvasSurface key={sceneKey} content={file!.content} editable={false} sceneKey={sceneKey} />
  }
  return (
    <Paper
      kind={kind}
      file={file}
      typeName={typeName}
      footer={sourceLinesMarkdown(kind, readMode)
        ? '选中行后可直接批注 · 模型回复会挂到批注上'
        : '源码按行展示 · 选中行后可直接批注'}
    >
      <SourceSurface
        selection={selection}
        lines={lines}
        anchoredLines={anchoredLines}
        markdown={sourceLinesMarkdown(kind, readMode)}
        onAnnotate={onAnnotate}
        onClearSelection={onClearSelection}
        onPickLine={onPickLine}
      />
    </Paper>
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
