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
import { formatBytes, type LineSelection, type ThreadPin,
  baseName,
} from '../model.ts'
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
  /** Cross-session preview: the selection bar's annotate entry is disabled. */
  readonly readOnly: boolean
  readonly anchoredLines: ReadonlySet<number>
  readonly pins: ReadonlyMap<number, ThreadPin>
  readonly staleLines: ReadonlySet<number>
  readonly attachments: readonly PaperAttachment[]
  readonly onChangeDraft: (content: string) => void
  readonly onSaveDraft: () => void
  readonly onAnnotate: () => void
  /** Enter/Space on the keyboard-active line opens its comment entry. */
  readonly onAnnotateLine: (line: number) => void
  readonly onClearSelection: () => void
  readonly onPickLine: (line: number, extend: boolean) => void
  /** A line's pin opens the thread it numbers. */
  readonly onPickPin: (line: number) => void
}

/** One attachment chip in the file strip or paper foot. */
export interface PaperAttachment {
  readonly attachmentId: string
  readonly name: string
  readonly mediaType: string
}

/** The first two attachment names plus an overflow count. */
function attachmentChips(attachments: readonly PaperAttachment[]): {
  readonly shown: readonly PaperAttachment[]
  readonly overflow: number
} {
  return { shown: attachments.slice(0, 2), overflow: Math.max(0, attachments.length - 2) }
}

/** Attachment chips rendered in the paper head and foot. */
function AttachmentChips({ attachments }: { readonly attachments: readonly PaperAttachment[] }): ReactElement | null {
  if (attachments.length === 0) return null
  const { shown, overflow } = attachmentChips(attachments)
  return (
    <span className="cwi-attach-chips" data-testid="cwi-paper-attachments">
      {shown.map((attachment) => (
        <span key={attachment.attachmentId} className="cwi-attach-chip" title={attachment.name}>
          <span className="cwi-attach-dot" data-type={attachment.mediaType.startsWith('image/') ? 'image' : 'file'} aria-hidden="true" />
          {attachment.name}
        </span>
      ))}
      {overflow === 0 ? null : <span className="cwi-attach-chip">+{overflow}</span>}
    </span>
  )
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
function FileHead({ kind, file, typeName, attachments }: {
  readonly kind: ViewerKind
  readonly file: ArtifactFileResponse
  readonly typeName: string
  readonly attachments: readonly PaperAttachment[]
}): ReactElement {
  return (
    <div className="cwi-paper-head" data-testid="cwi-file-head">
      <span className="cwi-file-icon" data-kind={kind}>{fileBadge(kind)}</span>
      <span className="cwi-file-name" title={file.path}>{baseName(file.path)}</span>
      <span className="cwi-file-meta">{typeName} · r{file.revision}</span>
      <span className="cwi-paper-spacer" />
      <AttachmentChips attachments={attachments} />
      <span className="cwi-file-meta">{formatBytes(file.size)}</span>
    </div>
  )
}

/** Props of a paper card; the head only renders when a file is loaded. */
interface PaperProps {
  readonly kind: ViewerKind
  readonly file: ArtifactFileResponse | null
  readonly typeName: string
  readonly attachments: readonly PaperAttachment[]
  readonly children: ReactElement | readonly ReactElement[]
  readonly footer?: string | undefined
}

/** The centred document card shared by text, diagram, and source surfaces. */
function Paper({ kind, file, typeName, attachments, children, footer }: PaperProps): ReactElement {
  return (
    <section className="cwi-paper" data-testid="cwi-paper">
      {file === null ? null : <FileHead kind={kind} file={file} typeName={typeName} attachments={attachments} />}
      <div className="cwi-paper-body">{children}</div>
      <div className="cwi-paper-foot">
        <AttachmentChips attachments={attachments} />
        <span className="cwi-paper-spacer" />
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
  attachments,
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
  | 'attachments'
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
    <Paper kind={kind} file={file} typeName={typeName} attachments={attachments} footer="编辑中：失焦或退出编辑时保存，冲突时停在同一版本">
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
  staleLines,
  pins,
  markdown,
  readOnly,
  onAnnotate,
  onAnnotateLine,
  onClearSelection,
  onPickLine,
  onPickPin,
}: Pick<DocumentSurfaceProps,
  | 'selection'
  | 'lines'
  | 'anchoredLines'
  | 'staleLines'
  | 'pins'
  | 'readOnly'
  | 'onAnnotate'
  | 'onAnnotateLine'
  | 'onClearSelection'
  | 'onPickLine'
  | 'onPickPin'
> & {
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
          <button
            type="button"
            className="cwi-primary"
            data-testid="cwi-annotate"
            disabled={readOnly}
            title={readOnly ? '跨会话只读：切到所属会话后才能批注' : undefined}
            onClick={onAnnotate}
          >
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
        staleLines={staleLines}
        pins={pins}
        markdown={markdown}
        onPick={onPickLine}
        onAnnotateLine={onAnnotateLine}
        onPickPin={onPickPin}
      />
    </>
  )
}

/** The document tab in read or source mode. */
// Read-mode surface selection (markdown vs source) for one document type.
// fallow-ignore-next-line complexity
function ReadSurface({
  kind,
  file,
  typeName,
  attachments,
  staleLines,
  pins,
  readMode,
  selection,
  lines,
  anchoredLines,
  readOnly,
  onAnnotate,
  onAnnotateLine,
  onClearSelection,
  onPickLine,
  onPickPin,
}: Pick<DocumentSurfaceProps,
  | 'kind'
  | 'file'
  | 'typeName'
  | 'attachments'
  | 'staleLines'
  | 'pins'
  | 'readMode'
  | 'selection'
  | 'lines'
  | 'anchoredLines'
  | 'readOnly'
  | 'onAnnotate'
  | 'onAnnotateLine'
  | 'onClearSelection'
  | 'onPickLine'
  | 'onPickPin'
>): ReactElement {
  const surface = readSurfaceKind(kind, readMode, file !== null)
  // `readSurfaceKind` only returns a renderer when the file exists.
  if (surface === 'diagram') {
    return (
      <Paper kind={kind} file={file} typeName={typeName} attachments={attachments} footer="图表按文本保存 · 切到源码修改 Mermaid 文本">
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
      attachments={attachments}
      footer={readOnly
        ? '跨会话只读预览 · 批注和回复在所属会话中进行'
        : (sourceLinesMarkdown(kind, readMode)
          ? '选中行后可直接批注 · 模型回复会挂到批注上'
          : '源码按行展示 · 选中行后可直接批注')}
    >
      <SourceSurface
        selection={selection}
        lines={lines}
        anchoredLines={anchoredLines}
        staleLines={staleLines}
        pins={pins}
        markdown={sourceLinesMarkdown(kind, readMode)}
        readOnly={readOnly}
        onAnnotate={onAnnotate}
        onAnnotateLine={onAnnotateLine}
        onClearSelection={onClearSelection}
        onPickLine={onPickLine}
        onPickPin={onPickPin}
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
