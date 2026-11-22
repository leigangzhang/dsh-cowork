/**
 * The work-item comment composer: reply/line context, textarea, attachments,
 * submit state, and the receipt line.
 *
 * All state stays in the viewer container; this component is the presentational
 * shell driven by test ids.
 */
import type { ReactElement, Ref } from 'react'
import type { ArtifactAnchor, AttachmentRefV1 } from '../../panel/artifact-contract.js'
import { anchorLabel, type WorkItemThread } from './model.ts'

/** Props of the comment composer. */
interface CommentComposerProps {
  readonly replyTarget: WorkItemThread | null
  readonly pendingAnchor: ArtifactAnchor | null
  readonly draft: string
  readonly composerRef: Ref<HTMLTextAreaElement>
  readonly pendingAttachments: readonly AttachmentRefV1[]
  readonly uploading: boolean
  readonly submitting: boolean
  readonly receipt: string | null
  readonly onDraft: (value: string) => void
  readonly onCancelReply: () => void
  readonly onCancelAnchor: () => void
  readonly onAttach: (files: FileList | null) => void
  readonly onRemoveAttachment: (attachmentId: string) => void
  readonly onSubmit: () => void
}

// Profile/state display matrix (reply, line context, attachments, receipt).
// fallow-ignore-next-line complexity
export function CommentComposer({
  replyTarget,
  pendingAnchor,
  draft,
  composerRef,
  pendingAttachments,
  uploading,
  submitting,
  receipt,
  onDraft,
  onCancelReply,
  onCancelAnchor,
  onAttach,
  onRemoveAttachment,
  onSubmit,
}: CommentComposerProps): ReactElement {
  return (
    <div className="cwi-composer">
      <p className="cwi-composer-lead">在文档中选择行后批注；也可以直接评论整份文档。</p>
      {replyTarget === null ? null : (
        <div className="cwi-thread-meta" data-testid="cwi-reply-target">
          <span>回复 {anchorLabel(replyTarget.anchor)} 的批注</span>
          <button type="button" className="cwi-secondary" onClick={onCancelReply}>
            取消回复
          </button>
        </div>
      )}
      {pendingAnchor === null ? null : (
        <div className="cwi-thread-meta">
          <span>{anchorLabel(pendingAnchor)}</span>
          <button type="button" className="cwi-secondary" onClick={onCancelAnchor}>
            取消位置
          </button>
        </div>
      )}
      <textarea
        ref={composerRef}
        data-testid="cwi-composer"
        value={draft}
        placeholder={replyTarget !== null ? '回复这条批注…' : (pendingAnchor === null ? '写下整体批注…' : '写下对所选行的批注…')}
        onChange={(event) => { onDraft(event.target.value) }}
      />
      <div className="cwi-composer-row">
        <label className="cwi-secondary" data-testid="cwi-attach-label" title="添加附件">
          附件
          <input
            type="file"
            data-testid="cwi-file-input"
            hidden
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.markdown,.csv,.tsv,.json"
            onChange={(event) => {
              onAttach(event.target.files)
              event.target.value = ''
            }}
          />
        </label>
        {uploading ? <span className="cwi-composer-hint">附件上传中…</span> : null}
        <span className="cwi-composer-hint">Enter 换行；提交后进入评论线程</span>
        <button
          type="button"
          className="cwi-primary"
          data-testid="cwi-submit"
          disabled={draft.trim() === '' || submitting}
          onClick={onSubmit}
        >
          {submitting ? '提交中…' : (replyTarget === null ? '提交批注' : '提交回复')}
        </button>
      </div>
      {pendingAttachments.length === 0 ? null : (
        <div className="cwi-thread-meta" data-testid="cwi-pending-attachments">
          {pendingAttachments.map((attachment) => (
            <span key={attachment.attachmentId} className="cwi-chip">
              {attachment.name}
              <button
                type="button"
                className="cwi-secondary"
                aria-label={`移除附件 ${attachment.name}`}
                onClick={() => { onRemoveAttachment(attachment.attachmentId) }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {receipt === null ? null : <div className="cwi-receipt" role="status">{receipt}</div>}
    </div>
  )
}
