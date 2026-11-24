/**
 * The attachment preview overlay shared by the attachment page and the rail.
 *
 * A provider owns the one open attachment and the element that opened it, so
 * every trigger (page row, thread thumbnail, rail session) opens the same
 * dialog and closing restores focus to that trigger. The dialog fills the
 * available viewport: images choose contain/width fit and support 10% zoom plus
 * drag-to-pan, text files show a read-only slice, and unknown types only offer
 * the download.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
  RefObject,
  SyntheticEvent,
} from 'react'
import {
  attachmentSourceBadge,
  ATTACHMENT_MISSING_TEXT,
  type AttachmentDisplayRow,
} from './model.ts'
import {
  defaultFitForImage,
  fitLabel,
  imageDisplaySize,
  nextFit,
  previewKindOf,
  previewTitle,
  restoreFocus,
  textPreview,
  zoomStep,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_ZOOM_MAX,
  PREVIEW_ZOOM_MIN,
  PREVIEW_ZOOM_RESET,
  type AttachmentPreviewKind,
  type PreviewFit,
  type TextPreview,
} from './attachment-preview-model.ts'

/** Kilobyte label of the text preview cap. */
const PREVIEW_TEXT_KB = Math.round(PREVIEW_TEXT_MAX_BYTES / 1024)

/** The preview entry point a trigger calls. */
export interface AttachmentPreviewer {
  readonly open: (attachment: AttachmentDisplayRow) => void
}

const AttachmentPreviewContext = createContext<AttachmentPreviewer | null>(null)

/**
 * The shared preview overlay, or null when no provider is mounted (a surface
 * rendered outside the viewer still paints thumbnails, just without preview).
 */
export function useAttachmentPreview(): AttachmentPreviewer | null {
  return useContext(AttachmentPreviewContext)
}

/** Props of the preview provider. */
export interface AttachmentPreviewProviderProps {
  readonly children: ReactNode
  /** Attachment URL builder owned by the viewer container. */
  readonly urlFor: (attachmentId: string) => string
}

/**
 * Own the one open preview and restore focus to its trigger on close.
 * @param props - the tree that can open previews and its URL builder.
 */
export function AttachmentPreviewProvider({ children, urlFor }: AttachmentPreviewProviderProps): ReactElement {
  const [current, setCurrent] = useState<AttachmentDisplayRow | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const open = useCallback((attachment: AttachmentDisplayRow) => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setCurrent(attachment)
  }, [])
  const close = useCallback(() => {
    setCurrent(null)
    restoreFocus(triggerRef.current)
    triggerRef.current = null
  }, [])
  const value = useMemo<AttachmentPreviewer>(() => ({ open }), [open])
  return (
    <AttachmentPreviewContext.Provider value={value}>
      {children}
      {current === null ? null : (
        <AttachmentPreview attachment={current} url={urlFor(current.attachmentId)} onClose={close} />
      )}
    </AttachmentPreviewContext.Provider>
  )
}

/** Props of the preview dialog. */
export interface AttachmentPreviewProps {
  readonly attachment: AttachmentDisplayRow
  readonly url: string
  readonly onClose: () => void
}

/** The header: name, the model badge, and the close button. */
function PreviewHeader({ attachment, closeRef, onClose }: {
  readonly attachment: AttachmentDisplayRow
  readonly closeRef: RefObject<HTMLButtonElement>
  readonly onClose: () => void
}): ReactElement {
  const badge = attachmentSourceBadge(attachment.source)
  return (
    <header className="cwi-preview-head">
      <span className="cwi-preview-title" title={attachment.name}>{attachment.name}</span>
      {badge === null ? null : <span className="cwi-attachment-model" data-testid="cwi-preview-model">{badge}</span>}
      <button
        ref={closeRef}
        type="button"
        className="cwi-preview-close"
        data-testid="cwi-preview-close"
        aria-label="关闭附件预览"
        onClick={onClose}
      >
        ×
      </button>
    </header>
  )
}

/** A dashed placeholder for bytes that cannot be shown. */
function PreviewFallback({ text }: { readonly text: string }): ReactElement {
  return (
    <div className="cwi-preview-missing" data-testid="cwi-preview-missing">
      <span className="cwi-preview-missing-mark" aria-hidden="true">!</span>
      <span>{text}</span>
    </div>
  )
}

/** The image stage box; the natural size arrives on load. */
function PreviewImage({ attachment, url, width, height, onLoad, onError }: {
  readonly attachment: AttachmentDisplayRow
  readonly url: string
  readonly width: number
  readonly height: number
  readonly onLoad: (event: SyntheticEvent<HTMLImageElement>) => void
  readonly onError: () => void
}): ReactElement {
  return (
    <img
      className="cwi-preview-image"
      data-testid="cwi-preview-image"
      src={url}
      alt={attachment.name}
      style={width > 0 && height > 0 ? { width: `${String(width)}px`, height: `${String(height)}px` } : undefined}
      onLoad={onLoad}
      onError={onError}
    />
  )
}

/** The image body, or the dashed placeholder when the bytes failed. */
function PreviewImageBody({ attachment, url, image, failed, onImageLoad, onImageError }: {
  readonly attachment: AttachmentDisplayRow
  readonly url: string
  readonly image: { readonly width: number; readonly height: number }
  readonly failed: boolean
  readonly onImageLoad: (event: SyntheticEvent<HTMLImageElement>) => void
  readonly onImageError: () => void
}): ReactElement {
  if (failed) return <PreviewFallback text={`${ATTACHMENT_MISSING_TEXT}：${attachment.name}`} />
  return (
    <PreviewImage
      attachment={attachment}
      url={url}
      width={image.width}
      height={image.height}
      onLoad={onImageLoad}
      onError={onImageError}
    />
  )
}

/** The read-only text slice, or the same placeholder when it failed. */
function PreviewTextBody({ attachment, failed, text }: {
  readonly attachment: AttachmentDisplayRow
  readonly failed: boolean
  readonly text: TextPreview | null
}): ReactElement {
  if (failed) return <PreviewFallback text={`${ATTACHMENT_MISSING_TEXT}：${attachment.name}`} />
  return (
    <pre className="cwi-preview-text" data-testid="cwi-preview-text">
      {text === null ? '正在加载…' : text.text}
    </pre>
  )
}

/** The body of the dialog: image, read-only text, or an unsupported type. */
function PreviewBody({ kind, attachment, url, image, text, failed, onImageLoad, onImageError }: {
  readonly kind: AttachmentPreviewKind
  readonly attachment: AttachmentDisplayRow
  readonly url: string
  readonly image: { readonly width: number; readonly height: number }
  readonly text: TextPreview | null
  readonly failed: boolean
  readonly onImageLoad: (event: SyntheticEvent<HTMLImageElement>) => void
  readonly onImageError: () => void
}): ReactElement {
  if (kind === 'image') {
    return (
      <PreviewImageBody
        attachment={attachment}
        url={url}
        image={image}
        failed={failed}
        onImageLoad={onImageLoad}
        onImageError={onImageError}
      />
    )
  }
  if (kind === 'text') return <PreviewTextBody attachment={attachment} failed={failed} text={text} />
  return <p className="cwi-preview-unknown">该附件类型不支持预览，请下载查看。</p>
}

/** The image zoom and fit controls. */
function ImageControls({ zoom, fit, onZoom, onReset, onFit }: {
  readonly zoom: number
  readonly fit: PreviewFit
  readonly onZoom: (direction: 1 | -1) => void
  readonly onReset: () => void
  readonly onFit: () => void
}): ReactElement {
  return (
    <>
      <button
        type="button"
        className="cwi-preview-tool"
        data-testid="cwi-preview-zoom-out"
        aria-label="缩小"
        disabled={zoom <= PREVIEW_ZOOM_MIN}
        onClick={() => { onZoom(-1) }}
      >
        −
      </button>
      <span className="cwi-preview-zoom" data-testid="cwi-preview-zoom">{zoom}%</span>
      <button
        type="button"
        className="cwi-preview-tool"
        data-testid="cwi-preview-zoom-in"
        aria-label="放大"
        disabled={zoom >= PREVIEW_ZOOM_MAX}
        onClick={() => { onZoom(1) }}
      >
        +
      </button>
      <button
        type="button"
        className="cwi-preview-tool"
        data-testid="cwi-preview-zoom-reset"
        aria-label="缩放复位到 100%"
        onClick={onReset}
      >
        100%
      </button>
      <button
        type="button"
        className="cwi-preview-tool"
        data-testid="cwi-preview-fit"
        onClick={onFit}
      >
        {fitLabel(fit)}
      </button>
    </>
  )
}

/** The truncation note shown under a capped text preview. */
function TextTruncationNotice({ kind, text }: {
  readonly kind: AttachmentPreviewKind
  readonly text: TextPreview | null
}): ReactElement | null {
  if (kind !== 'text' || text === null || !text.truncated) return null
  return <span className="cwi-preview-hint" data-testid="cwi-preview-truncated">内容较大，仅显示前 {PREVIEW_TEXT_KB} KB</span>
}

/** The footer: zoom/fit controls, truncation note, and the full download. */
function PreviewFooter({ kind, attachment, url, zoom, fit, text, onZoom, onReset, onFit }: {
  readonly kind: AttachmentPreviewKind
  readonly attachment: AttachmentDisplayRow
  readonly url: string
  readonly zoom: number
  readonly fit: PreviewFit
  readonly text: TextPreview | null
  readonly onZoom: (direction: 1 | -1) => void
  readonly onReset: () => void
  readonly onFit: () => void
}): ReactElement {
  return (
    <footer className="cwi-preview-foot">
      {kind === 'image'
        ? <ImageControls zoom={zoom} fit={fit} onZoom={onZoom} onReset={onReset} onFit={onFit} />
        : null}
      <TextTruncationNotice kind={kind} text={text} />
      <span className="cwi-preview-spacer" />
      <a
        className="cwi-secondary cwi-preview-download"
        data-testid="cwi-preview-download"
        href={url}
        download={attachment.name}
      >
        下载
      </a>
    </footer>
  )
}

/**
 * Render the filled-viewport attachment dialog.
 * @param props - the attachment, its URL, and the close callback.
 * @returns the modal dialog; mounted only while an attachment is open.
 */
// Dialog state matrix (kind, fit, zoom, drag, failure); the browser lane owns it.
// fallow-ignore-next-line complexity
export function AttachmentPreview({ attachment, url, onClose }: AttachmentPreviewProps): ReactElement {
  const kind = previewKindOf(attachment.mediaType, attachment.name)
  const closeRef = useRef<HTMLButtonElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const sizedRef = useRef(false)
  const dragRef = useRef<{ readonly x: number; readonly y: number; readonly left: number; readonly top: number } | null>(null)
  const [zoom, setZoom] = useState(PREVIEW_ZOOM_RESET)
  const [fit, setFit] = useState<PreviewFit>('contain')
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const [natural, setNatural] = useState({ width: 0, height: 0 })
  const [failed, setFailed] = useState(false)
  const [text, setText] = useState<TextPreview | null>(null)

  // Modal lifecycle: lock background scrolling and focus the close button.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => { document.body.style.overflow = previous }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // The stage size decides the default fit and the rendered image box.
  useEffect(() => {
    const measure = (): void => {
      const node = stageRef.current
      if (node === null) return
      setStage({ width: node.clientWidth, height: node.clientHeight })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => { window.removeEventListener('resize', measure) }
  }, [])

  // Text previews read only the leading slice of the stored bytes; the download
  // keeps the full file.
  useEffect(() => {
    if (kind !== 'text') return
    let active = true
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`attachment preview failed (HTTP ${String(response.status)})`)
        return response.text()
      })
      .then((value) => { if (active) setText(textPreview(value)) })
      .catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [kind, url])

  const onImageLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget
    setNatural({ width: image.naturalWidth, height: image.naturalHeight })
    if (sizedRef.current) return
    sizedRef.current = true
    setFit(defaultFitForImage(image.naturalHeight, stageRef.current?.clientHeight ?? 0))
  }, [])

  const onImageError = useCallback(() => { setFailed(true) }, [])
  const onZoom = useCallback((direction: 1 | -1) => { setZoom(current => zoomStep(current, direction)) }, [])
  const onReset = useCallback(() => { setZoom(PREVIEW_ZOOM_RESET) }, [])
  const onFit = useCallback(() => { setFit(current => nextFit(current)) }, [])

  const size = imageDisplaySize({
    naturalWidth: natural.width,
    naturalHeight: natural.height,
    stageWidth: stage.width,
    stageHeight: stage.height,
    fit,
    zoomPercent: zoom,
  })
  const zoomed = zoom > PREVIEW_ZOOM_RESET

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (kind !== 'image' || !zoomed) return
    const node = stageRef.current
    if (node === null) return
    dragRef.current = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop }
    node.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const node = stageRef.current
    if (drag === null || node === null) return
    node.scrollLeft = drag.left - (event.clientX - drag.x)
    node.scrollTop = drag.top - (event.clientY - drag.y)
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    const node = stageRef.current
    if (node !== null && node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId)
  }
  // Close on click, not on mousedown: the browser's default mousedown handling
  // blurs a pressed non-focusable backdrop to <body> after the handler runs, so
  // a restoreFocus inside a mousedown handler would be undone immediately. By
  // the click, that default handling has already happened and the provider's
  // focus restore to the trigger sticks.
  const onBackdrop = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }

  return (
    <div
      className="cwi-preview-backdrop"
      data-testid="cwi-preview"
      onClick={onBackdrop}
    >
      <section
        className="cwi-preview"
        data-testid="cwi-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={previewTitle(attachment)}
      >
        <PreviewHeader attachment={attachment} closeRef={closeRef} onClose={onClose} />
        <div
          ref={stageRef}
          className="cwi-preview-stage"
          data-kind={kind}
          data-zoom={zoomed ? 'true' : 'false'}
          data-fit={fit}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <PreviewBody
            kind={kind}
            attachment={attachment}
            url={url}
            image={size}
            text={text}
            failed={failed}
            onImageLoad={onImageLoad}
            onImageError={onImageError}
          />
        </div>
        <PreviewFooter
          kind={kind}
          attachment={attachment}
          url={url}
          zoom={zoom}
          fit={fit}
          text={text}
          onZoom={onZoom}
          onReset={onReset}
          onFit={onFit}
        />
      </section>
    </div>
  )
}
