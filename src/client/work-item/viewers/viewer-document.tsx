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
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ArtifactFileResponse } from '../../../panel/artifact-contract.js'
import type { SaveConflict } from '../api.ts'
import { TextEditor } from '../editor.tsx'
import { formatBytes, type LineSelection, type ThreadPin, baseName } from '../model.ts'
import { AnnotationPop } from '../annotation-pop.tsx'
import {
  annotationPopPosition,
  intersectRects,
  isMenuKey,
  selectedTextOf,
  type PopPosition,
  type PopRect,
} from '../rail-geometry.ts'
import { CanvasSurface } from './canvas.tsx'
import type { ReadingSurfaceConfig } from '../reading-surface.ts'
import { editorLanguage, readSurfaceKind, type ViewerKind } from './document.ts'
import { DiagramView } from './diagram.tsx'
import { HtmlPreview } from './html.tsx'
import { MarkdownReadView } from './markdown-view.tsx'
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
  /** Cross-session preview: the annotate entry is disabled. */
  readonly readOnly: boolean
  readonly anchoredLines: ReadonlySet<number>
  readonly pins: ReadonlyMap<number, ThreadPin>
  readonly staleLines: ReadonlySet<number>
  readonly attachments: readonly PaperAttachment[]
  /** Markdown read-mode state; non-text families ignore it. */
  readonly reading: ReadingSurfaceConfig
  /** First source line the editor should show when it mounts. */
  readonly editorStartLine: number
  readonly onChangeDraft: (content: string) => void
  readonly onSaveDraft: () => void
  /**
   * Create a comment for the mapped lines; `selectedText` is the browser's
   * sub-line selection when the source surface has one.
   */
  readonly onAnnotateRange: (startLine: number, endLine: number, selectedText?: string) => void
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
  editorStartLine,
  reading,
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
  | 'editorStartLine'
  | 'reading'
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
          initialLine={editorStartLine}
          onViewportLine={reading.onViewportLine}
          onChange={onChangeDraft}
          onBlur={() => { if (dirty && conflict === null) onSaveDraft() }}
        />
      </div>
    </Paper>
  )
}

/** One pending source annotation: the mapped lines plus any partial selection. */
interface SourceAnnotateTarget {
  readonly startLine: number
  readonly endLine: number
  readonly selectedText?: string
}

/** A browser selection inside the line list, mapped back to source lines. */
interface SourceSelection {
  readonly startLine: number
  readonly endLine: number
  readonly selectedText: string | undefined
  readonly rect: PopRect
}

/** One pending source annotation: the mapped lines plus any partial selection. */
interface SourceAnnotateTarget {
  readonly startLine: number
  readonly endLine: number
  readonly selectedText?: string
}

/** A target plus the rectangle the floating entry should anchor to. */
interface SourceShowTarget {
  readonly target: SourceAnnotateTarget
  readonly rect: PopRect | null
}

/** A browser selection inside the line list, mapped back to source lines. */
interface SourceSelection {
  readonly startLine: number
  readonly endLine: number
  readonly selectedText: string | undefined
  readonly rect: PopRect
}

/** The element carrying one node, or null for a detached node. */
function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
}

/** A 1-based source line number, or null when the value is not one. */
function parseLineNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

/** The 1-based source line containing one node, or null outside a line row. */
function lineNumberOf(node: Node | null): number | null {
  if (node === null) return null
  return parseLineNumber(elementOf(node)?.closest('[data-line]')?.getAttribute('data-line'))
}

/** The union of rectangles, or null when any of them is empty. */
function unionBounds(rects: readonly PopRect[]): PopRect | null {
  if (rects.length === 0) return null
  const left = Math.min(...rects.map((rect) => rect.left))
  const top = Math.min(...rects.map((rect) => rect.top))
  const width = Math.max(...rects.map((rect) => rect.left + rect.width)) - left
  const height = Math.max(...rects.map((rect) => rect.top + rect.height)) - top
  return width <= 0 || height <= 0 ? null : { left, top, width, height }
}

/** The union rectangle of a range's client rects, or null when unmeasured. */
function rangeRect(range: Range): PopRect | null {
  const rects = Array.from(range.getClientRects())
    .map((rect) => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }))
  const union = unionBounds(rects)
  if (union !== null) return union
  const single = range.getBoundingClientRect()
  return unionBounds([{ left: single.left, top: single.top, width: single.width, height: single.height }])
}

/** Whether the selection cannot produce an entry at all. */
function selectionMissing(selection: Selection | null): selection is null {
  return selection === null || selection.isCollapsed || selection.rangeCount === 0
}

/** Whether both range endpoints belong to the line list. */
function rangeInside(container: HTMLElement, range: Range): boolean {
  return container.contains(range.startContainer) && container.contains(range.endContainer)
}

/** The browser selection and range, when both endpoints are inside the list. */
function selectionRange(container: HTMLElement): { readonly range: Range; readonly selection: Selection } | null {
  const selection = window.getSelection()
  if (selectionMissing(selection)) return null
  const range = selection.getRangeAt(0)
  return rangeInside(container, range) ? { range, selection } : null
}

/** The 1-based line bounds of a range, ordered from top to bottom. */
function lineBounds(range: Range): { readonly startLine: number; readonly endLine: number } | null {
  const start = lineNumberOf(range.startContainer)
  const end = lineNumberOf(range.endContainer)
  if (start === null || end === null) return null
  return start <= end ? { startLine: start, endLine: end } : { startLine: end, endLine: start }
}

/** The display data one usable in-list selection carries. */
function selectionData(found: { readonly range: Range; readonly selection: Selection }): SourceSelection | null {
  const selectedText = selectedTextOf(found.selection)
  const bounds = lineBounds(found.range)
  const rect = rangeRect(found.range)
  if (selectedText === undefined || bounds === null || rect === null) return null
  return { ...bounds, selectedText, rect }
}

/** The current browser selection, when it lies inside the line list. */
function browserSelection(container: HTMLElement): SourceSelection | null {
  const found = selectionRange(container)
  if (found === null) return null
  return selectionData(found)
}

/** The union rectangle of the selected source lines. */
function linesRect(container: HTMLElement, startLine: number, endLine: number): PopRect | null {
  const first = container.querySelector(`[data-line="${String(startLine)}"]`)
  const last = container.querySelector(`[data-line="${String(endLine)}"]`)
  if (first === null || last === null) return null
  const toRect = (element: Element): PopRect => {
    const box = element.getBoundingClientRect()
    return { left: box.left, top: box.top, width: box.width, height: box.height }
  }
  return unionBounds([toRect(first), toRect(last)])
}

/** The browser viewport as a rectangle. */
function viewportRect(): PopRect {
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}

/** The content box clipped by the viewport; the floating entry stays inside. */
function contentBounds(container: HTMLElement): PopRect {
  const content = container.closest('[data-testid="cwi-content"]')
  const box = content?.getBoundingClientRect()
  if (box === undefined) return viewportRect()
  return intersectRects(
    { left: box.left, top: box.top, width: box.width, height: box.height },
    viewportRect(),
  )
}

/** The keyboard-active line of the list (arrow-key navigation). */
function activeLineOf(container: HTMLElement): number | null {
  return lineNumberOf(container.querySelector('[data-line][data-active="true"]'))
}

/** Whether focus sits inside the line list or the floating entry. */
function focusInside(container: HTMLElement, entry: HTMLElement | null): boolean {
  const active = document.activeElement
  if (active === null) return false
  return container.contains(active) || (entry !== null && entry.contains(active))
}

/** The line one event targets inside the list, or null outside it. */
function eventLine(container: HTMLElement, event: MouseEvent): number | null {
  if (!(event.target instanceof Element)) return null
  return container.contains(event.target) ? lineNumberOf(event.target) : null
}

/** The target a right-click asks to annotate, or null outside the lines. */
function contextTarget(container: HTMLElement, event: MouseEvent): SourceShowTarget | null {
  const browser = browserSelection(container)
  if (browser !== null) {
    return {
      target: { startLine: browser.startLine, endLine: browser.endLine, selectedText: browser.selectedText },
      rect: browser.rect,
    }
  }
  const line = eventLine(container, event)
  return line === null
    ? null
    : { target: { startLine: line, endLine: line }, rect: linesRect(container, line, line) }
}

/** The target the menu key asks to annotate: the selection or the active line. */
function menuTarget(container: HTMLElement, entry: HTMLElement | null): SourceShowTarget | null {
  const browser = browserSelection(container)
  if (browser !== null) {
    return {
      target: { startLine: browser.startLine, endLine: browser.endLine, selectedText: browser.selectedText },
      rect: browser.rect,
    }
  }
  if (!focusInside(container, entry)) return null
  const line = activeLineOf(container)
  return line === null
    ? null
    : { target: { startLine: line, endLine: line }, rect: linesRect(container, line, line) }
}

/** Whether one node belongs to the floating entry. */
function insideEntry(entry: HTMLElement | null, target: Node): boolean {
  return entry !== null && entry.contains(target)
}

/** What one pointer press hit: the entry, the lines, or anywhere else. */
function dismissTarget(
  container: HTMLElement,
  entry: HTMLElement | null,
  target: EventTarget | null,
): 'entry' | 'line' | 'outside' {
  if (!(target instanceof Node)) return 'outside'
  if (insideEntry(entry, target)) return 'entry'
  return container.contains(target) ? 'line' : 'outside'
}

/**
 * The source-line surface, including its floating annotate entry.
 *
 * A line click, a partial text selection, a right-click, or the menu key all
 * map the same range and open the same entry. When no reliable DOM rectangle
 * exists (the line list is detached or unmeasured) the surface falls back to an
 * inline annotate button on the range's last line instead of a floating entry.
 */
// Selection source/disabled/dismiss state matrix; the browser lane owns it.
// fallow-ignore-next-line complexity
function SourceSurface({
  selection,
  lines,
  anchoredLines,
  staleLines,
  pins,
  markdown,
  readOnly,
  annotateDisabled = false,
  onAnnotateRange,
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
  | 'onAnnotateRange'
  | 'onClearSelection'
  | 'onPickLine'
  | 'onPickPin'
> & {
  readonly markdown: boolean
  /** An unsaved draft or a conflict also blocks new line annotations. */
  readonly annotateDisabled?: boolean
}): ReactElement {
  const linesRef = useRef<HTMLDivElement | null>(null)
  const entryRef = useRef<HTMLDivElement | null>(null)
  const targetRef = useRef<SourceAnnotateTarget | null>(null)
  const [target, setTarget] = useState<SourceAnnotateTarget | null>(null)
  const [position, setPosition] = useState<PopPosition | null>(null)
  const disabled = readOnly || annotateDisabled
  const disabledTitle = readOnly
    ? '跨会话只读：切到所属会话后才能批注'
    : (annotateDisabled ? '未保存草稿或版本冲突：处理后可批注' : undefined)

  useEffect(() => {
    const container = linesRef.current
    if (container === null) return
    const clear = (): void => {
      targetRef.current = null
      setTarget(null)
      setPosition(null)
    }
    const show = (next: SourceAnnotateTarget, rect: PopRect | null): void => {
      targetRef.current = next
      setTarget(next)
      setPosition(rect === null ? null : annotationPopPosition(rect, contentBounds(container)))
    }
    const refresh = (): void => {
      const browser = browserSelection(container)
      if (browser !== null) {
        show({ startLine: browser.startLine, endLine: browser.endLine, selectedText: browser.selectedText }, browser.rect)
        return
      }
      if (selection === null) {
        clear()
        return
      }
      show(
        { startLine: selection.startLine, endLine: selection.endLine },
        linesRect(container, selection.startLine, selection.endLine),
      )
    }
    const onContextMenu = (event: MouseEvent): void => {
      const next = contextTarget(container, event)
      if (next === null) return
      event.preventDefault()
      show(next.target, next.rect)
    }
    const dismissOnEscape = (): void => {
      if (targetRef.current === null) return
      clear()
      onClearSelection()
    }
    const openMenuEntry = (event: KeyboardEvent): void => {
      const next = menuTarget(container, entryRef.current)
      if (next === null) return
      event.preventDefault()
      show(next.target, next.rect)
      window.requestAnimationFrame(() => {
        entryRef.current?.querySelector('button')?.focus()
      })
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        dismissOnEscape()
        return
      }
      if (isMenuKey(event)) openMenuEntry(event)
    }
    const onPointerDown = (event: PointerEvent): void => {
      const where = dismissTarget(container, entryRef.current, event.target)
      if (where === 'entry') return
      clear()
      if (where === 'outside') onClearSelection()
    }
    refresh()
    document.addEventListener('selectionchange', refresh)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('scroll', refresh, true)
    window.addEventListener('resize', refresh)
    return () => {
      document.removeEventListener('selectionchange', refresh)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('scroll', refresh, true)
      window.removeEventListener('resize', refresh)
    }
  }, [annotateDisabled, lines, onClearSelection, readOnly, selection])

  const annotate = (): void => {
    if (target === null) return
    onAnnotateRange(target.startLine, target.endLine, target.selectedText)
    targetRef.current = null
    setTarget(null)
    setPosition(null)
  }
  return (
    <>
      {target === null || position === null ? null : (
        <AnnotationPop
          startLine={target.startLine}
          endLine={target.endLine}
          left={position.left}
          top={position.top}
          disabled={disabled}
          disabledTitle={disabledTitle}
          testId="cwi-annotate-pop"
          entryRef={entryRef}
          onAnnotate={annotate}
        />
      )}
      <SourceLines
        rootRef={linesRef}
        inlineAnnotate={target === null || position !== null
          ? null
          : {
              startLine: target.startLine,
              endLine: target.endLine,
              disabled,
              disabledTitle,
              onAnnotate: annotate,
            }}
        lines={lines}
        selection={selection}
        anchoredLines={anchoredLines}
        staleLines={staleLines}
        pins={pins}
        markdown={markdown}
        onPick={onPickLine}
        onAnnotateLine={line => { onAnnotateRange(line, line) }}
        onPickPin={onPickPin}
      />
    </>
  )
}

/** Footer hint of the Markdown reading surface. */
function readingFooter(reading: ReadingSurfaceConfig, readOnly: boolean): string {
  if (readOnly) return '跨会话只读预览 · 批注和回复在所属会话中进行'
  if (reading.dirty) return '未保存草稿：保存后可批注'
  if (reading.annotateDisabled) return '当前状态不可批注'
  return '选中文字后点「批注」 · 模型回复会挂到批注上'
}

/** The Markdown flow surface, or the numbered fallback when it is too large. */
function MarkdownSurface({ reading }: {
  readonly reading: ReadingSurfaceConfig
}): ReactElement {
  return (
    <MarkdownReadView
      content={reading.content}
      threads={reading.threads}
      pinsVisible={!reading.dirty}
      annotateDisabled={reading.annotateDisabled}
      annotateReason={reading.annotateReason}
      selectedAnchor={reading.selectedAnchor}
      focusLine={reading.focusLine}
      focusToken={reading.focusToken}
      imageUrl={reading.imageUrl}
      onAnnotate={reading.onAnnotate}
      onPickPin={reading.onPickPin}
      onViewportLine={reading.onViewportLine}
      onClearThread={reading.onClearThread}
    />
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
  reading,
  onAnnotateRange,
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
  | 'reading'
  | 'onAnnotateRange'
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
  if (surface === 'markdown' && reading.fallback === null) {
    return (
      <Paper kind={kind} file={file} typeName={typeName} attachments={attachments} footer={readingFooter(reading, readOnly)}>
        <MarkdownSurface reading={reading} />
      </Paper>
    )
  }
  if (surface === 'markdown') {
    return (
      <Paper kind={kind} file={file} typeName={typeName} attachments={attachments} footer="文件较大 · 已切换为源码视图">
        <div className="cwi-receipt" data-testid="cwi-md-fallback">{reading.fallback}</div>
        <SourceSurface
          selection={selection}
          lines={lines}
          anchoredLines={anchoredLines}
          staleLines={staleLines}
          pins={pins}
          markdown={kind === 'text'}
          readOnly={readOnly}
          annotateDisabled={reading.annotateDisabled}
          onAnnotateRange={onAnnotateRange}
          onClearSelection={onClearSelection}
          onPickLine={onPickLine}
          onPickPin={onPickPin}
        />
      </Paper>
    )
  }
  return (
    <Paper
      kind={kind}
      file={file}
      typeName={typeName}
      attachments={attachments}
      footer={readOnly
        ? '跨会话只读预览 · 批注和回复在所属会话中进行'
        : '源码按行展示 · 选中行后可直接批注'}
    >
      <SourceSurface
        selection={selection}
        lines={lines}
        anchoredLines={anchoredLines}
        staleLines={staleLines}
        pins={pins}
        markdown={false}
        readOnly={readOnly}
        onAnnotateRange={onAnnotateRange}
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
