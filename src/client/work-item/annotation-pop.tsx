/**
 * The floating annotate entry shared by the Markdown reading surface and the
 * numbered source surface.
 *
 * The surface owns where the selection is and which source lines it maps to;
 * this component owns the visible entry: the read-only line-range chip, the
 * annotate button, and the "do not collapse the browser selection" press
 * behaviour. Both surfaces render the same markup so right-click and menu-key
 * entry points look and behave identically.
 */
import type { ReactElement, Ref } from 'react'
import { lineRangeLabel } from './rail-geometry.ts'

/** Props of the floating annotate entry. */
export interface AnnotationPopProps {
  /** 1-based first selected source line, shown in the read-only chip. */
  readonly startLine: number
  readonly endLine: number
  /** Fixed-position coordinates from `annotationPopPosition`. */
  readonly left: number
  readonly top: number
  /** Cross-session read-only, unsaved draft, or a save conflict. */
  readonly disabled: boolean
  /** Why annotating is unavailable; also the button's title. */
  readonly disabledTitle: string | undefined
  /**
   * Host test id: the reading surface keeps its `cwi-md-selection` id for the
   * browser lane, the source surface uses `cwi-annotate-pop`.
   */
  readonly testId: string
  /** Set by a surface that must recognize presses inside the entry. */
  readonly entryRef?: Ref<HTMLDivElement>
  readonly onAnnotate: () => void
}

/**
 * Render the floating annotate entry.
 * @param props - mapped line range, position, disabled state, and click handler.
 * @returns one entry positioned over the content; mounted only while a
 * selection is usable.
 */
export function AnnotationPop({
  startLine,
  endLine,
  left,
  top,
  disabled,
  disabledTitle,
  testId,
  entryRef,
  onAnnotate,
}: AnnotationPopProps): ReactElement {
  return (
    <div
      ref={entryRef}
      className="cwi-annotate-pop"
      data-testid={testId}
      role="group"
      aria-label="选区批注"
      style={{ left: `${String(left)}px`, top: `${String(top)}px` }}
    >
      <span className="cwi-annotate-range">{lineRangeLabel(startLine, endLine)}</span>
      <button
        type="button"
        className="cwi-primary cwi-annotate-button"
        data-testid="cwi-annotate"
        aria-label="批注所选内容"
        disabled={disabled}
        title={disabledTitle ?? '对所选内容创建批注'}
        // Keeping focus/selection in the surface: a press must not collapse the
        // browser selection the anchor is being built from.
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={onAnnotate}
      >
        批注
      </button>
    </div>
  )
}
