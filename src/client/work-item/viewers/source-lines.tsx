/**
 * Numbered source lines shared by every text-based work item.
 *
 * The line list is the annotation surface: a click selects a line (Shift extends
 * the range) and an unresolved anchor marks its line. Markdown files may render
 * a light read view; diagram, HTML, and canvas source stay literal so a line
 * number always addresses the stored bytes.
 */
import type { ReactElement } from 'react'
import { inlineMarkdown, isSelected, markdownLine, type LineSelection } from '../model.ts'

/** Props of the numbered source view. */
export interface SourceLinesProps {
  /** Lines of the stored file, without the trailing newline entry. */
  readonly lines: readonly string[]
  /** Current line selection, if any. */
  readonly selection: LineSelection | null
  /** 1-based lines carrying an unresolved annotation. */
  readonly anchoredLines: ReadonlySet<number>
  /** Render Markdown emphasis in the line text; source modes pass false. */
  readonly markdown: boolean
  /** Select one line; `extend` is the Shift-click range extension. */
  readonly onPick: (line: number, extend: boolean) => void
}

/** One line's class, row kind, and display text. */
interface LineView {
  readonly className: string
  readonly kind: string
  readonly text: string
}

/** Resolve one line's rendering without branching inside the React tree. */
function lineView(text: string, markdown: boolean): LineView {
  if (!markdown) return { className: 'cwi-line-text', kind: 'source', text }
  const rendered = markdownLine(text)
  return {
    className: `cwi-line-text cwi-md-${rendered.kind}`,
    kind: rendered.kind,
    text: rendered.text,
  }
}

/** Inline Markdown runs rendered as elements; no HTML is parsed. */
function InlineText({ text }: { readonly text: string }): ReactElement {
  return (
    <>
      {inlineMarkdown(text).map((run, index) => (run.kind === 'text'
        ? run.text
        : <span key={index} className={`cwi-inline-${run.kind}`}>{run.text}</span>))}
    </>
  )
}

/** The anchor marker, or nothing when the line has no open annotation. */
function LinePin({ visible }: { readonly visible: boolean }): ReactElement | null {
  return visible
    ? <span className="cwi-line-pin" data-testid="cwi-line-pin" title="这一行有批注">●</span>
    : null
}

/** Props of one rendered source line. */
interface SourceLineProps {
  readonly text: string
  readonly line: number
  readonly selection: LineSelection | null
  readonly anchored: boolean
  readonly markdown: boolean
  readonly onPick: (line: number, extend: boolean) => void
}

/** One focusable line row. */
function SourceLine({ text, line, selection, anchored, markdown, onPick }: SourceLineProps): ReactElement {
  const view = lineView(text, markdown)
  return (
    <div
      className="cwi-line"
      data-testid="cwi-line"
      data-line={line}
      data-kind={markdown ? view.kind : undefined}
      data-selected={String(isSelected(selection, line))}
      data-anchored={String(anchored)}
      onClick={(event) => { onPick(line, event.shiftKey) }}
    >
      <span className="cwi-line-number">{line}</span>
      <LinePin visible={anchored} />
      <span className={view.className}>
        {markdown ? <InlineText text={view.text === '' ? ' ' : view.text} /> : (view.text === '' ? ' ' : view.text)}
      </span>
    </div>
  )
}

/**
 * Render the annotated line list.
 * @param props - lines, selection, anchors, and the pick handler.
 * @returns the scrollable line list.
 */
export function SourceLines({ lines, selection, anchoredLines, markdown, onPick }: SourceLinesProps): ReactElement {
  return (
    <div className="cwi-lines" data-testid="cwi-lines">
      {lines.map((text, index) => (
        <SourceLine
          key={index + 1}
          text={text}
          line={index + 1}
          selection={selection}
          anchored={anchoredLines.has(index + 1)}
          markdown={markdown}
          onPick={onPick}
        />
      ))}
    </div>
  )
}
