/**
 * Mermaid-SVG diagram renderer for a `diagram` work item.
 *
 * Pele parses the Mermaid source and returns SVG. Rendering is synchronous and
 * deterministic for one source, so the read view memoizes it; a parse or layout
 * failure keeps the source editable and shows the failing line instead of an
 * empty pane. Links and images are disabled: the viewer never makes a network
 * request on behalf of diagram text, and Pele escapes label text itself.
 */
import { useId, useMemo } from 'react'
import type { ReactElement } from 'react'
import { PeleError, render } from 'pele'

/** Result of one render attempt. */
type DiagramState =
  | { readonly ok: true; readonly svg: string; readonly type: string }
  | { readonly ok: false; readonly message: string; readonly line: number; readonly column: number; readonly snippet: string }

/** The failure branch of {@link DiagramState}. */
type DiagramFailure = Extract<DiagramState, { readonly ok: false }>

/** Validate-safe id prefix: Pele only accepts letters, digits, `-` and `_`. */
function idPrefixOf(raw: string): string {
  const prefix = raw.replace(/[^A-Za-z0-9_-]/g, '')
  return prefix === '' ? 'cwi-diagram' : `cwi-${prefix}`
}

/** Render one source, turning a `PeleError` into display data. */
function renderDiagram(source: string, idPrefix: string): DiagramState {
  try {
    const result = render(source, { links: false, images: false, idPrefix })
    return { ok: true, svg: result.svg, type: result.type }
  } catch (error) {
    if (error instanceof PeleError) {
      return {
        ok: false,
        message: error.message,
        line: error.line,
        column: error.column,
        snippet: error.snippet,
      }
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error), line: 0, column: 0, snippet: '' }
  }
}

/** Human position of a parse failure. */
function errorPosition(line: number, column: number): string {
  if (line <= 0) return '定位未知'
  return column > 0 ? `第 ${String(line)} 行第 ${String(column)} 列` : `第 ${String(line)} 行`
}

/** The failure pane; the empty snippet is hidden by the stylesheet. */
function DiagramError({ state }: { readonly state: DiagramFailure }): ReactElement {
  return (
    <div className="cwi-diagram cwi-diagram-error" data-testid="cwi-diagram-error" role="alert">
      <div className="cwi-diagram-error-title">图表无法渲染（{errorPosition(state.line, state.column)}）</div>
      <div className="cwi-diagram-error-message">{state.message}</div>
      <pre className="cwi-diagram-error-snippet">{state.snippet}</pre>
      <div className="cwi-hint">可以切到源码修改 Mermaid 文本，或把文件交给模型继续修改。</div>
    </div>
  )
}

/** Props of the read-only diagram pane. */
export interface DiagramViewProps {
  /** Mermaid source from the registered file. */
  readonly source: string
}

/**
 * Render one Mermaid source to SVG, or explain why it cannot be drawn.
 * @param props - the current file text.
 * @returns the diagram pane.
 */
export function DiagramView({ source }: DiagramViewProps): ReactElement {
  const rawId = useId()
  const idPrefix = useMemo(() => idPrefixOf(rawId), [rawId])
  const state = useMemo(() => renderDiagram(source, idPrefix), [idPrefix, source])
  return state.ok
    ? (
        <div
          className="cwi-diagram"
          data-testid="cwi-diagram"
          data-diagram-type={state.type}
          // Pele escapes label text and emits no scripts or event handlers;
          // links and images are disabled above, so the SVG carries no network
          // surface.
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )
    : <DiagramError state={state} />
}
