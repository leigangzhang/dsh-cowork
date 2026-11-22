/**
 * The viewer's bottom status strip: delivery summary on the left, content
 * version and update time on the right.
 */
import type { ReactElement } from 'react'
import { formatClock } from './model.ts'

/** Props of the viewer footer. */
export interface ViewerFooterProps {
  readonly summary: string
  readonly revision: number
  readonly updatedAt: string
}

/**
 * Render the viewer footer.
 * @param props - delivery summary, content revision, and record update time.
 * @returns the footer strip.
 */
export function ViewerFooter({ summary, revision, updatedAt }: ViewerFooterProps): ReactElement {
  return (
    <footer className="cwi-viewer-foot" data-testid="cwi-viewer-footer">
      <span className="cwi-foot-summary">{summary}</span>
      <span className="cwi-foot-spacer" />
      <span className="cwi-foot-meta">内容版本 r{revision}</span>
      <span className="cwi-foot-dot" aria-hidden="true" />
      <span className="cwi-foot-meta">更新于 {formatClock(updatedAt)}</span>
    </footer>
  )
}
