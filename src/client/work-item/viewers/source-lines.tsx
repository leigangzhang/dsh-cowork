/**
 * Numbered source lines shared by every text-based work item.
 *
 * The line list is the annotation surface: a click selects a line (Shift extends
 * the range) and an unresolved anchor marks its line. Markdown files may render
 * a light read view; diagram, HTML, and canvas source stay literal so a line
 * number always addresses the stored bytes.
 */
import type { ReactElement } from 'react'
import { isSelected, markdownLine, type LineSelection } from '../model.ts'

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

/**
 * Render the annotated line list.
 * @param props - lines, selection, anchors, and the pick handler.
 * @returns the scrollable line list.
 */
export function SourceLines({ lines, selection, anchoredLines, markdown, onPick }: SourceLinesProps): ReactElement {
  return (
    <div className="cwi-lines" data-testid="cwi-lines">
      {lines.map((text, index) => {
        const line = index + 1
        const rendered = markdown ? markdownLine(text) : null
        return (
          <div
            key={line}
            className="cwi-line"
            data-testid="cwi-line"
            data-line={line}
            data-selected={isSelected(selection, line) ? 'true' : 'false'}
            data-anchored={anchoredLines.has(line) ? 'true' : 'false'}
            onClick={(event) => { onPick(line, event.shiftKey) }}
          >
            <span className="cwi-line-number">{line}</span>
            {anchoredLines.has(line) ? <span className="cwi-line-pin" data-testid="cwi-line-pin" title="这一行有批注">●</span> : null}
            {rendered === null
              ? <span className="cwi-line-text">{text === '' ? ' ' : text}</span>
              : <span className={`cwi-line-text cwi-md-${rendered.kind}`}>{rendered.text === '' ? ' ' : rendered.text}</span>}
          </div>
        )
      })}
    </div>
  )
}
