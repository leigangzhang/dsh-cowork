/**
 * Numbered source lines shared by every text-based work item.
 *
 * The line list is the annotation surface: a click selects a line (Shift extends
 * the range) and an unresolved anchor marks its line. Markdown files may render
 * a light read view; diagram, HTML, and canvas source stay literal so a line
 * number always addresses the stored bytes.
 */
import { useMemo, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import {
  inlineMarkdown,
  isSelected,
  markdownLines,
  moveActiveLine,
  type LineSelection,
  type ReadLine,
  type ThreadPin,
} from '../model.ts'

/** Props of the numbered source view. */
export interface SourceLinesProps {
  /** Lines of the stored file, without the trailing newline entry. */
  readonly lines: readonly string[]
  /** Current line selection, if any. */
  readonly selection: LineSelection | null
  /** 1-based lines carrying an unresolved annotation. */
  readonly anchoredLines: ReadonlySet<number>
  /** Anchored-line pins keyed by line; the ordinal is the rail's thread number. */
  readonly pins: ReadonlyMap<number, ThreadPin>
  /** Lines whose anchor moved; they get the stale tint. */
  readonly staleLines: ReadonlySet<number>
  /** Render Markdown emphasis and fenced code; source modes pass false. */
  readonly markdown: boolean
  /** Select one line; `extend` is the Shift-click range extension. */
  readonly onPick: (line: number, extend: boolean) => void
  /** Enter/Space on the keyboard-active line opens its comment entry. */
  readonly onAnnotateLine: (line: number) => void
  /** A pin opens the thread it numbers. */
  readonly onPickPin: (line: number) => void
}

/** One line's class, row kind, and display text. */
interface LineView {
  readonly className: string
  readonly kind: string
  readonly text: string
}

/** Shape one line's precomputed classification into its row view. */
function lineView(text: string, rendered: ReadLine | undefined): LineView {
  if (rendered === undefined) return { className: 'cwi-line-text', kind: 'source', text }
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

/** The numbered anchor marker, or nothing when the line has no comment. */
function LinePin({
  pin,
  line,
  onPickPin,
}: {
  readonly pin: ThreadPin | undefined
  readonly line: number
  readonly onPickPin: (line: number) => void
}): ReactElement | null {
  if (pin === undefined) return null
  return (
    <button
      type="button"
      className="cwi-line-pin"
      data-testid="cwi-line-pin"
      data-tone={pin.tone}
      data-ordinal={pin.ordinal}
      aria-label={`第 ${String(pin.ordinal)} 条批注`}
      title={`第 ${String(pin.ordinal)} 条批注`}
      onClick={(event) => { event.stopPropagation(); onPickPin(line) }}
    >
      {pin.ordinal}
    </button>
  )
}

/** Props of one rendered source line. */
interface SourceLineProps {
  readonly line: number
  readonly selection: LineSelection | null
  readonly anchored: boolean
  readonly stale: boolean
  readonly view: LineView
  readonly pin: ThreadPin | undefined
  readonly markdown: boolean
  readonly active: boolean
  readonly onPick: (line: number, extend: boolean) => void
  readonly onPickPin: (line: number) => void
}

/** One focusable line row. */
// One line's anchor/selection/stale matrix; the browser lane owns these states.
// fallow-ignore-next-line complexity
function SourceLine({
  line,
  selection,
  anchored,
  stale,
  view,
  pin,
  markdown,
  active,
  onPick,
  onPickPin,
}: SourceLineProps): ReactElement {
  const inline = markdown && view.kind !== 'code' && view.kind !== 'fence'
  return (
    <div
      className="cwi-line"
      data-testid="cwi-line"
      data-line={line}
      data-kind={markdown ? view.kind : undefined}
      data-selected={String(isSelected(selection, line))}
      data-anchored={String(anchored)}
      data-stale={String(stale)}
      data-active={String(active)}
      onClick={(event) => { onPick(line, event.shiftKey) }}
    >
      <span className="cwi-line-number">{line}</span>
      <LinePin pin={pin} line={line} onPickPin={onPickPin} />
      <span className={view.className}>
        {inline ? <InlineText text={view.text === '' ? ' ' : view.text} /> : (view.text === '' ? ' ' : view.text)}
      </span>
    </div>
  )
}

/**
 * Render the annotated line list.
 * @param props - lines, selection, anchors, and the pick handler.
 * @returns the scrollable line list.
 */
export function SourceLines({
  lines,
  selection,
  anchoredLines,
  staleLines,
  pins,
  markdown,
  onPick,
  onAnnotateLine,
  onPickPin,
}: SourceLinesProps): ReactElement {
  const views = useMemo(() => (markdown ? markdownLines(lines) : undefined), [lines, markdown])
  const [active, setActive] = useState(1)
  const activeLine = lines.length === 0 ? 1 : Math.min(active, lines.length)
  const moveTo = (line: number): void => {
    setActive(line)
    requestAnimationFrame(() => {
      document.querySelector(`[data-line="${String(line)}"]`)?.scrollIntoView({ block: 'nearest' })
    })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // A pin is its own button: its Enter/Space belongs to the pin, not the list.
    if (event.target !== event.currentTarget) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveTo(moveActiveLine(activeLine, event.key === 'ArrowDown' ? 1 : -1, lines.length))
      return
    }
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onAnnotateLine(activeLine)
  }
  const pick = (line: number, extend: boolean): void => {
    setActive(line)
    onPick(line, extend)
  }
  return (
    <div
      className="cwi-lines"
      data-testid="cwi-lines"
      role="group"
      tabIndex={0}
      aria-label="文件内容：方向键移动，回车批注当前行"
      onKeyDown={onKeyDown}
    >
      {lines.map((text, index) => (
        <SourceLine
          key={index + 1}
          line={index + 1}
          selection={selection}
          anchored={anchoredLines.has(index + 1)}
          stale={staleLines.has(index + 1)}
          view={lineView(text, views?.[index])}
          pin={pins.get(index + 1)}
          markdown={markdown}
          active={index + 1 === activeLine}
          onPick={pick}
          onPickPin={onPickPin}
        />
      ))}
    </div>
  )
}
