/**
 * Excalidraw surface for a `canvas` work item.
 *
 * The registered `.excalidraw` file is the only content source. Read mode mounts
 * Excalidraw with editing disabled; edit mode reports the serialized scene to
 * the viewer, which owns the debounce, save, and presence. Changes are reported
 * only after the user interacts with the canvas so mounting cannot rewrite a
 * scene just by opening it.
 *
 * CSS ships as text in the client bundle (the host loads one CJS closure) and is
 * mounted once as a `<style>` tag here. Excalidraw's font assets are not bundled:
 * the host asset route serves only image types, so Excalidraw falls back to its
 * own font source; an offline host renders canvas text with system fonts.
 */
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import { useMemo, useRef } from 'react'
import type { ReactElement } from 'react'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
// The package publishes a CSS stylesheet without a declaration file. The
// client build imports it as text (`--loader:.css=text`), so the runtime value
// is a string; the suppression is the boundary between the two halves.
// @ts-expect-error -- no declaration is published for the stylesheet export.
import excalidrawCssText from '@excalidraw/excalidraw/index.css'
import { parseCanvasScene } from './document.ts'

/** Same-origin base for Excalidraw fonts; the asset route serves only images. */
const EXCALIDRAW_ASSET_PATH = '/plugins/@dsh-external/dsh-cowork/assets/'

/** Props of the canvas surface. */
export interface CanvasSurfaceProps {
  /** Current file text. */
  readonly content: string
  /** False mounts a read-only scene. */
  readonly editable: boolean
  /** Reports the serialized scene after a user edit. */
  readonly onChange?: ((content: string) => void) | undefined
  /** Remounts the scene when the stored file changes from the outside. */
  readonly sceneKey: string
}

/** Mount the Excalidraw stylesheet once in the browser. */
function ensureExcalidrawStyles(doc: Document): void {
  const selector = 'style[data-plugin-css="cwi-excalidraw"]'
  if (doc.head.querySelector(selector) !== null) return
  const tag = doc.createElement('style')
  tag.dataset.pluginCss = 'cwi-excalidraw'
  tag.textContent = excalidrawCssText as string
  doc.head.appendChild(tag)
}

/** Point Excalidraw's asset resolver at a same-origin base before it mounts. */
function ensureExcalidrawAssets(): void {
  if (typeof window === 'undefined') return
  const target = window as Window & { EXCALIDRAW_ASSET_PATH?: string }
  if (target.EXCALIDRAW_ASSET_PATH === undefined) target.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH
}

if (typeof document !== 'undefined') {
  ensureExcalidrawStyles(document)
  ensureExcalidrawAssets()
}

/**
 * Mount one Excalidraw scene.
 *
 * The caller remounts this component through its React `key` when the server
 * revision or edit session changes, so a mount's own state callback can never
 * look like a user edit. Later content updates arrive through the save path.
 * @param props - scene text, mode, and the change sink.
 * @returns the canvas surface, or the reason the file is not a scene.
 */
export function CanvasSurface({ content, editable, onChange, sceneKey }: CanvasSurfaceProps): ReactElement {
  const parsed = useMemo(() => parseCanvasScene(content), [content])
  const interacted = useRef(false)
  if (!parsed.ok) {
    return (
      <div className="cwi-canvas-error" data-testid="cwi-canvas-error" role="alert">
        <div className="cwi-diagram-error-title">画布无法打开</div>
        <div className="cwi-diagram-error-message">{parsed.reason}</div>
        <div className="cwi-hint">切到源码可以检查 JSON；损坏的文件不会被保存覆盖，除非你主动修改并保存。</div>
      </div>
    )
  }
  // The shape check above proves the three scene containers exist; Excalidraw
  // owns the element contract inside `elements`, exactly as it does for a file
  // it wrote itself.
  const initialData = parsed.scene as unknown as ExcalidrawInitialDataState
  return (
    <div
      className="cwi-canvas"
      data-testid="cwi-canvas"
      data-editable={editable ? 'true' : 'false'}
      onPointerDownCapture={() => { interacted.current = true }}
      onKeyDownCapture={() => { interacted.current = true }}
    >
      <Excalidraw
        key={sceneKey}
        initialData={initialData}
        viewModeEnabled={!editable}
        theme="light"
        // A scene file can carry embeddable elements; the viewer never loads a
        // third-party frame from a work-item file.
        validateEmbeddable={false}
        onChange={(elements, appState, files) => {
          if (!editable || !interacted.current || onChange === undefined) return
          onChange(serializeAsJSON(elements, appState, files, 'local'))
        }}
      />
    </div>
  )
}
