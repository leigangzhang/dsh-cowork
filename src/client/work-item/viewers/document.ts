/**
 * Pure preparation for the non-Markdown work-item renderers.
 *
 * The three stage-4 types are text files with different presentation rules: a
 * diagram is a Mermaid source rendered to SVG, an HTML page runs inside an
 * opaque sandbox, and a canvas is an Excalidraw scene. Everything that can be
 * decided without the DOM lives here so the unit lane can cover the security
 * policy, the scene shape check, and the viewer dispatch without a browser.
 */
import type { ArtifactType } from '../../../panel/artifact-contract.js'
import { changedLineRanges, type LineSelection } from '../model.ts'

/** The four presentation families the viewer knows. */
const VIEWER_KINDS = ['text', 'diagram', 'html', 'canvas', 'source'] as const

/** One presentation family; `source` means "numbered text lines only". */
export type ViewerKind = (typeof VIEWER_KINDS)[number]

/** A read-mode surface that renders a file instead of numbered source lines. */
export type ReadSurfaceKind = 'diagram' | 'html' | 'canvas' | 'source'

/** Read-mode surfaces keyed by their viewer family. */
const READ_SURFACES: Partial<Record<ViewerKind, ReadSurfaceKind>> = {
  diagram: 'diagram',
  html: 'html',
  canvas: 'canvas',
}

/** Text-editor languages for the families with a dedicated source mode. */
const EDITOR_LANGUAGES: Partial<Record<ViewerKind, 'html' | 'plain'>> = {
  html: 'html',
  diagram: 'plain',
}

/**
 * Content policy for the static HTML preview.
 *
 * No scripts, no network, no forms, no nested frames: a preview may style
 * itself and show in-document data images, nothing else. Inline styles remain
 * because ordinary HTML files carry their presentation inline.
 */
const HTML_PREVIEW_STATIC_POLICY =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"

/**
 * Content policy for the interactive HTML preview.
 *
 * Inline scripts are allowed because the file is a demo; network, forms and
 * frames stay blocked, and the iframe never gets `allow-same-origin`, so a
 * script cannot read the host page, cookies, or storage.
 */
const HTML_PREVIEW_INTERACTIVE_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"

/**
 * Build the document an HTML work item preview loads into its iframe.
 *
 * The policy and referrer metas are prepended rather than parsed into a DOM:
 * both are only valid before the first resource request, and a browser moves a
 * meta that precedes `<html>` into the implied head. A source document may
 * carry its own policy; policies intersect, so the result can only be
 * stricter, never wider.
 * @param source - the registered `.html` file text.
 * @param interactive - allow inline scripts in the sandbox.
 * @returns a complete document string for an iframe `srcDoc`.
 */
export function htmlPreviewDocument(source: string, interactive: boolean): string {
  const policy = interactive ? HTML_PREVIEW_INTERACTIVE_POLICY : HTML_PREVIEW_STATIC_POLICY
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">${source}`
}

/** The scene payload Excalidraw needs to mount a file. */
export interface CanvasScene {
  /** Scene elements; each one is a struct with at least an id and a type. */
  readonly elements: readonly Record<string, unknown>[]
  /** Excalidraw view state; the file may omit it. */
  readonly appState: Record<string, unknown>
  /** Embedded image files keyed by file id; the file may omit them. */
  readonly files: Record<string, unknown>
}

/** Result of reading one `.excalidraw` file. */
export type CanvasSceneCheck =
  | { readonly ok: true; readonly scene: CanvasScene }
  | { readonly ok: false; readonly reason: string }

/** A plain object (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One scene element: a plain object with a non-empty id and type. */
function isElement(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.id !== ''
    && typeof value.type === 'string'
    && value.type !== ''
}

/**
 * Parse one Excalidraw scene from the registered file text.
 *
 * Only the shape Excalidraw itself requires is checked; element fields are the
 * library's contract and a canvas saved by it always carries them. A record
 * from an older or hand-written file is rejected with the failing reason so the
 * viewer can show the source instead of crashing the panel.
 * @param content - the `.excalidraw` JSON text.
 * @returns the scene, or the reason it is not one.
 */
export function parseCanvasScene(content: string): CanvasSceneCheck {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { ok: false, reason: '画布文件不是有效的 JSON' }
  }
  if (!isRecord(parsed)) return { ok: false, reason: '画布文件必须是一个 JSON 对象' }
  const elements = parsed.elements
  if (!Array.isArray(elements)) return { ok: false, reason: '画布文件缺少 elements 数组' }
  if (!elements.every(isElement)) return { ok: false, reason: '画布元素缺少 id 或 type' }
  const appState = parsed.appState
  if (appState !== undefined && !isRecord(appState)) return { ok: false, reason: 'appState 必须是一个对象' }
  const files = parsed.files
  if (files !== undefined && !isRecord(files)) return { ok: false, reason: 'files 必须是一个对象' }
  return {
    ok: true,
    scene: {
      elements,
      appState: appState ?? {},
      files: files ?? {},
    },
  }
}

/**
 * The presence range a canvas edit reports.
 *
 * A scene has no line concept, so the whole file is the edit range: every
 * structured write that overlaps the reported span is refused while the user
 * holds the canvas. The range covers the current line count; an appended model
 * write can still start past it, which keeps the guard conservative rather than
 * pretending the file has a line lock it cannot express.
 * @param content - current canvas file text.
 * @returns one 1-based inclusive line range.
 */
function canvasPresenceRanges(content: string): readonly { readonly startLine: number; readonly endLine: number }[] {
  const lineCount = content === '' ? 1 : content.split('\n').length
  return [{ startLine: 1, endLine: lineCount }]
}

/**
 * Resolve the presence ranges for the current editor kind.
 *
 * A canvas holds the whole scene while editing; every other viewer reports the
 * lines that differ from the saved text so the server can guard those ranges.
 * @param kind - the active presentation family.
 * @param saved - file text at the loaded revision.
 * @param draft - current editor text.
 * @returns the ranges to report; empty means there is nothing to hold.
 */
export function presenceRangesFor(kind: ViewerKind, saved: string, draft: string): readonly LineSelection[] {
  return kind === 'canvas' ? canvasPresenceRanges(draft) : changedLineRanges(saved, draft)
}

/**
 * Decide whether a refreshed file must rebuild the mounted canvas.
 *
 * A clean canvas editor still holds the old scene after a server refresh, but a
 * save also replays as `file.changed`; only a changed file while the user is
 * editing needs a new scene key. Non-canvas viewers never remount this way.
 * @param kind - the active presentation family.
 * @param editing - whether the editor is open.
 * @param previous - file text before the refresh.
 * @param next - file text returned by the refresh.
 * @returns true when the canvas scene must be rebuilt.
 */
export function refreshResetsCanvas(kind: ViewerKind, editing: boolean, previous: string, next: string): boolean {
  return kind === 'canvas' && editing && previous !== next
}

/**
 * Pick the read-mode surface for one file.
 *
 * A viewer only replaces the numbered source lines when the file exists and
 * read mode is active. Feature types without a renderer stay on source lines.
 * @param kind - the active presentation family.
 * @param readMode - whether the user chose the rendered read mode.
 * @param hasFile - whether the current file content is available.
 * @returns the surface to render.
 */
export function readSurfaceKind(kind: ViewerKind, readMode: boolean, hasFile: boolean): ReadSurfaceKind {
  return readMode && hasFile ? READ_SURFACES[kind] ?? 'source' : 'source'
}

/**
 * Pick the CodeMirror language for the document editor.
 * @param kind - the active presentation family.
 * @param canvasBroken - whether the canvas failed its scene check.
 * @returns the editor language.
 */
export function editorLanguage(kind: ViewerKind, canvasBroken: boolean): 'html' | 'plain' | 'markdown' {
  return canvasBroken ? 'plain' : EDITOR_LANGUAGES[kind] ?? 'markdown'
}

/**
 * Decide whether the source-line surface may render Markdown inline styles.
 * @param kind - the active presentation family.
 * @param readMode - whether the user chose the rendered read mode.
 * @returns true only for text files in read mode.
 */
export function sourceLinesMarkdown(kind: ViewerKind, readMode: boolean): boolean {
  return kind === 'text' && readMode
}

/**
 * Choose the viewer for one artifact type.
 *
 * `text` keeps the Markdown/source viewer; the stage-4 types get their own
 * renderer; the remaining registered types (Doc, table, PDF, image) have no
 * renderer in this stage and fall back to numbered source lines.
 * @param type - the record's type.
 * @returns the presentation family.
 */
export function viewerKindOf(type: ArtifactType): ViewerKind {
  switch (type) {
    case 'diagram':
      return 'diagram'
    case 'html':
      return 'html'
    case 'canvas':
      return 'canvas'
    case 'text':
      return 'text'
    default:
      return 'source'
  }
}
