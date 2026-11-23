/**
 * The work-item comment composer: reply/line context, textarea, attachments,
 * submit state, and the receipt line.
 *
 * All state stays in the viewer container; this component is the presentational
 * shell driven by test ids.
 */
import type { ClipboardEvent, ReactElement, Ref } from 'react'
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
  /** Cross-session preview: keep the composer visible but disable every input. */
  readonly readOnly: boolean
  readonly onDraft: (value: string) => void
  readonly onCancelReply: () => void
  readonly onCancelAnchor: () => void
  /** Files from the picker or an image pasted into the textarea. */
  readonly onAttach: (files: FileList | readonly File[] | null) => void
  readonly onRemoveAttachment: (attachmentId: string) => void
  readonly onSubmit: () => void
}

/** Images pasted into the textarea; other clipboard kinds stay text. */
function pastedImages(event: ClipboardEvent<HTMLTextAreaElement>): File[] {
  return Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
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
  readOnly,
  onDraft,
  onCancelReply,
  onCancelAnchor,
  onAttach,
  onRemoveAttachment,
  onSubmit,
}: CommentComposerProps): ReactElement {
  return (
    <div className="cwi-composer" data-testid="cwi-composer-shell" data-readonly={String(readOnly)}>
      <p className="cwi-composer-lead">
        {readOnly
          ? '跨会话只读：可以阅读批注和附件，回复与提交不可用。'
          : '在文档中选择行后批注；也可以直接评论整份文档。'}
      </p>
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
          {pendingAnchor.kind !== 'line-range' || pendingAnchor.selectedText === undefined ? null : (
            <span className="cwi-composer-selected" data-testid="cwi-selected-text" title={pendingAnchor.selectedText}>
              {pendingAnchor.selectedText}
            </span>
          )}
          <button type="button" className="cwi-secondary" onClick={onCancelAnchor}>
            取消位置
          </button>
        </div>
      )}
      <textarea
        ref={composerRef}
        data-testid="cwi-composer"
        value={draft}
        disabled={readOnly}
        placeholder={readOnly
          ? '切到所属会话后才能批注'
          : (replyTarget !== null ? '回复这条批注…' : (pendingAnchor === null ? '写下整体批注…' : '写下对所选行的批注…'))}
        onChange={(event) => { onDraft(event.target.value) }}
        onPaste={(event) => {
          const files = pastedImages(event)
          if (files.length === 0) return
          event.preventDefault()
          onAttach(files)
        }}
      />
      <div className="cwi-composer-row">
        <label
          className="cwi-secondary cwi-attach-label"
          data-testid="cwi-attach-label"
          title={readOnly ? '跨会话只读：切到所属会话后才能添加附件' : '添加附件'}
        >
          附件
          <input
            type="file"
            className="cwi-file-input"
            data-testid="cwi-file-input"
            disabled={readOnly}
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
          disabled={readOnly || draft.trim() === '' || submitting}
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
