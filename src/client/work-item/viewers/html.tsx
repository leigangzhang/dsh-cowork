/**
 * HTML work-item preview.
 *
 * The registered file is rendered inside an opaque iframe; the host page never
 * parses it. Static mode runs no script and allows no network. Interactive mode
 * lets the page run its own inline scripts, which is what an HTML demo needs,
 * but the sandbox still omits `allow-same-origin`, and the prepended policy
 * keeps network, forms, frames, and top-level navigation unavailable.
 */
import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { htmlPreviewDocument } from './document.ts'

/** Props of the HTML preview. */
export interface HtmlPreviewProps {
  /** Registered `.html` file text. */
  readonly source: string
}

/**
 * Preview one HTML file in a sandboxed frame.
 * @param props - the current file text.
 * @returns the preview pane with its script switch.
 */
export function HtmlPreview({ source }: HtmlPreviewProps): ReactElement {
  const [interactive, setInteractive] = useState(false)
  const documentText = useMemo(() => htmlPreviewDocument(source, interactive), [interactive, source])
  return (
    <div className="cwi-html" data-testid="cwi-html">
      <div className="cwi-html-bar">
        <span className="cwi-hint" data-testid="cwi-html-mode">
          {interactive ? '交互预览：内联脚本在沙箱中运行，网络与表单不可用' : '静态预览：不运行脚本，不加载外部资源'}
        </span>
        <button
          type="button"
          className="cwi-secondary"
          data-testid="cwi-html-interactive"
          data-interactive={interactive ? 'true' : 'false'}
          onClick={() => { setInteractive(value => !value) }}
        >
          {interactive ? '停止脚本' : '运行脚本'}
        </button>
      </div>
      <iframe
        className="cwi-html-frame"
        data-testid="cwi-html-frame"
        data-interactive={interactive ? 'true' : 'false'}
        title="HTML 预览"
        sandbox={interactive ? 'allow-scripts' : ''}
        referrerPolicy="no-referrer"
        srcDoc={documentText}
      />
    </div>
  )
}
