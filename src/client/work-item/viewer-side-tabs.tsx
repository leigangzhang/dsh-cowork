/**
 * The viewer's read-only side tabs: version metadata and the attachment list.
 *
 * Both surfaces are pure projections of the loaded detail; the container keeps
 * loading, URL construction, and tab state.
 */
import type { ReactElement } from 'react'
import type { ArtifactFileResponse, ArtifactRecordV1, AttachmentRefV1 } from '../../panel/artifact-contract.js'
import { formatBytes } from './model.ts'

/** Props of the version metadata tab. */
export interface VersionsPanelProps {
  readonly record: ArtifactRecordV1
  readonly file: ArtifactFileResponse | null
  readonly revisions: readonly number[]
}

/** Current file metadata plus the kept snapshot numbers. */
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
  readonly attachments: readonly AttachmentRefV1[]
  /** Attachment URL builder owned by the container (session/artifact bound). */
  readonly urlFor: (attachmentId: string) => string
}

/** Every attachment referenced by the work item's comments. */
export function AttachmentsPanel({ attachments, urlFor }: AttachmentsPanelProps): ReactElement {
  return (
    <div className="cwi-panel" data-testid="cwi-attachments">
      <div className="cwi-panel-title">附件（{attachments.length}）</div>
      {attachments.length === 0 ? <p className="cwi-hint">还没有附件。在批注或回复里添加图片或文本文件。</p> : null}
      {attachments.map((attachment) => (
        <div key={attachment.attachmentId} className="cwi-attachment-row" data-testid="cwi-attachment-row">
          {attachment.mediaType.startsWith('image/') ? (
            <img
              className="cwi-attachment-thumb"
              data-testid="cwi-attachment-thumb"
              src={urlFor(attachment.attachmentId)}
              alt={attachment.name}
            />
          ) : null}
          <div className="cwi-attachment-info">
            <span>{attachment.name}</span>
            <span className="cwi-hint">{attachment.mediaType} · {formatBytes(attachment.size)}</span>
          </div>
          <a
            className="cwi-secondary"
            data-testid="cwi-attachment-link"
            href={urlFor(attachment.attachmentId)}
            download={attachment.name}
          >
            下载
          </a>
        </div>
      ))}
    </div>
  )
}
