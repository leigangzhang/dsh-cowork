/**
 * The viewer's read-only side tabs: version metadata and the attachment list.
 *
 * Both surfaces are pure projections of the loaded detail; the container keeps
 * loading, URL construction, and tab state. The attachment page renders the
 * publish log (`detail.publishedAttachments`) with its `模型生成` badge; a row's
 * thumbnail opens the shared preview overlay.
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import type { ArtifactFileResponse, ArtifactRecordV1 } from '../../panel/artifact-contract.js'
import { useAttachmentPreview } from './attachment-preview.tsx'
import {
  attachmentSourceBadge,
  ATTACHMENT_EMPTY_TEXT,
  ATTACHMENT_MISSING_TEXT,
  formatBytes,
  type AttachmentDisplayRow,
} from './model.ts'

/** Props of the version metadata tab. */
export interface VersionsPanelProps {
  readonly record: ArtifactRecordV1
  readonly file: ArtifactFileResponse | null
  readonly revisions: readonly number[]
}

/** Current file metadata plus the kept snapshot numbers. */
// Metadata projection; every ternary is a display fallback for a missing file.
// fallow-ignore-next-line complexity
export function VersionsPanel({ record, file, revisions }: VersionsPanelProps): ReactElement {
  return (
    <div className="cwi-panel" data-testid="cwi-versions">
      <div className="cwi-panel-title">当前版本</div>
      <dl className="cwi-meta-list">
        <dt>文件</dt><dd>{record.primaryPath}</dd>
        <dt>版本</dt><dd>r{file?.revision ?? record.revision}</dd>
        <dt>大小</dt><dd>{file === null ? '—' : formatBytes(file.size)}</dd>
        <dt>类型</dt><dd>{file?.mediaType ?? record.files[0]?.mediaType ?? '—'}</dd>
        <dt>SHA-256</dt><dd className="cwi-mono">{file?.sha256 ?? record.files[0]?.sha256 ?? '—'}</dd>
        <dt>文件系统版本</dt><dd className="cwi-mono">{file?.fsVersion ?? '—'}</dd>
        <dt>保留快照</dt>
        <dd>{revisions.length === 0 ? '暂无' : `${String(revisions.length)} 份 · r${revisions.join(' / r')}`}</dd>
      </dl>
      <p className="cwi-hint">服务端为每个工作项保留最近 20 份文本快照；此视图展示当前文件的版本元数据。</p>
    </div>
  )
}

/** Props of the attachment tab. */
export interface AttachmentsPanelProps {
  /** Published rows, or the comment-ref fallback on an older host. */
  readonly rows: readonly AttachmentDisplayRow[]
  /** Attachment URL builder owned by the container (session/artifact bound). */
  readonly urlFor: (attachmentId: string) => string
}

/** The file-block label of a non-image attachment: its extension or type. */
function fileBlockLabel(row: AttachmentDisplayRow): string {
  const dot = row.name.lastIndexOf('.')
  const extension = dot === -1 ? '' : row.name.slice(dot + 1).toUpperCase()
  return extension === '' ? 'FILE' : extension.slice(0, 4)
}

/** The colour block a non-image (or missing) attachment shows. */
function FileBlock({ row, missing }: {
  readonly row: AttachmentDisplayRow
  readonly missing: boolean
}): ReactElement {
  return (
    <span className="cwi-attachment-file" data-testid="cwi-attachment-file" data-missing={missing ? 'true' : 'false'}>
      {missing ? '!' : fileBlockLabel(row)}
    </span>
  )
}

/** The row's preview trigger: an image thumbnail or a file colour block. */
function AttachmentThumb({ row, urlFor, missing, onMissing }: {
  readonly row: AttachmentDisplayRow
  readonly urlFor: (attachmentId: string) => string
  readonly missing: boolean
  readonly onMissing: (attachmentId: string) => void
}): ReactElement {
  const preview = useAttachmentPreview()
  const isImage = row.mediaType.startsWith('image/') && !missing
  return (
    <button
      type="button"
      className="cwi-attachment-open"
      data-testid="cwi-attachment-preview"
      aria-label={`预览 ${row.name}`}
      onClick={() => { preview?.open(row) }}
    >
      {isImage
        ? (
            <img
              className="cwi-attachment-thumb"
              data-testid="cwi-attachment-thumb"
              src={urlFor(row.attachmentId)}
              alt={row.name}
              onError={() => { onMissing(row.attachmentId) }}
            />
          )
        : <FileBlock row={row} missing={missing} />}
    </button>
  )
}

/** One attachment row: preview trigger, name/badge, type-size meta, download. */
function AttachmentRow({ row, urlFor, missing, onMissing }: {
  readonly row: AttachmentDisplayRow
  readonly urlFor: (attachmentId: string) => string
  readonly missing: boolean
  readonly onMissing: (attachmentId: string) => void
}): ReactElement {
  const badge = attachmentSourceBadge(row.source)
  return (
    <div
      className="cwi-attachment-row"
      data-testid="cwi-attachment-row"
      data-source={row.source}
      data-missing={missing ? 'true' : 'false'}
    >
      <AttachmentThumb row={row} urlFor={urlFor} missing={missing} onMissing={onMissing} />
      <div className="cwi-attachment-info">
        <span className="cwi-attachment-name">
          {row.name}
          {badge === null ? null : <span className="cwi-attachment-model" data-testid="cwi-attachment-model">{badge}</span>}
        </span>
        <span className="cwi-hint" data-testid="cwi-attachment-meta">
          {missing ? ATTACHMENT_MISSING_TEXT : `${row.mediaType} · ${formatBytes(row.size)}`}
        </span>
      </div>
      <a
        className="cwi-secondary"
        data-testid="cwi-attachment-link"
        href={urlFor(row.attachmentId)}
        download={row.name}
      >
        下载
      </a>
    </div>
  )
}

/** Every published attachment of the work item, with its source badge. */
export function AttachmentsPanel({ rows, urlFor }: AttachmentsPanelProps): ReactElement {
  const [missingIds, setMissingIds] = useState<ReadonlySet<string>>(() => new Set())
  const markMissing = (attachmentId: string): void => {
    setMissingIds((current) => {
      if (current.has(attachmentId)) return current
      const next = new Set(current)
      next.add(attachmentId)
      return next
    })
  }
  return (
    <div className="cwi-panel" data-testid="cwi-attachments">
      <div className="cwi-panel-title">附件（{rows.length}）</div>
      {rows.length === 0 ? <p className="cwi-hint" data-testid="cwi-attachment-empty">{ATTACHMENT_EMPTY_TEXT}</p> : null}
      {rows.map((row) => (
        <AttachmentRow
          key={row.attachmentId}
          row={row}
          urlFor={urlFor}
          missing={missingIds.has(row.attachmentId)}
          onMissing={markMissing}
        />
      ))}
    </div>
  )
}
