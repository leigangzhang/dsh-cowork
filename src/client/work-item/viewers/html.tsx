/**
 * HTML work-item preview.
 *
 * The registered file is rendered inside an opaque iframe; the host page never
 * parses it. Static mode runs no script and allows no network. Interactive mode
 * lets the page run its own inline scripts, which is what an HTML demo needs,
 * but the sandbox still omits `allow-same-origin`, and the prepended policy
 * keeps network, forms, frames, and top-level navigation unavailable.
 *
 * The iframe can still navigate itself to an external URL: no sandbox flag and
 * no supported CSP directive blocks a frame navigating its own browsing
 * context. Interactive mode therefore stays opt-in and names that limit in the
 * UI; only trusted pages should run with scripts.
 */
import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { htmlPreviewDocument } from './document.ts'

/** Mode copy, indexed by `Number(interactive)`. */
const MODE_TEXT = [
  '静态预览：不运行脚本，不加载外部资源',
  '交互预览：内联脚本在沙箱中运行；脚本仍可导航到外部地址，只打开可信文件',
] as const

/** Toggle copy, indexed by `Number(interactive)`. */
const BUTTON_TEXT = ['运行脚本', '停止脚本'] as const

/** Sandbox flags, indexed by `Number(interactive)`. */
const SANDBOX = ['', 'allow-scripts'] as const

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
  const index = Number(interactive)
  const documentText = useMemo(() => htmlPreviewDocument(source, interactive), [interactive, source])
  return (
    <div className="cwi-html" data-testid="cwi-html">
      <div className="cwi-html-bar">
        <span className="cwi-hint" data-testid="cwi-html-mode">{MODE_TEXT[index]}</span>
        <button
          type="button"
          className="cwi-secondary"
          data-testid="cwi-html-interactive"
          data-interactive={String(interactive)}
          onClick={() => { setInteractive(value => !value) }}
        >
          {BUTTON_TEXT[index]}
        </button>
      </div>
      <iframe
        className="cwi-html-frame"
        data-testid="cwi-html-frame"
        data-interactive={String(interactive)}
        title="HTML 预览"
        sandbox={SANDBOX[index]}
        referrerPolicy="no-referrer"
        srcDoc={documentText}
      />
    </div>
  )
}
