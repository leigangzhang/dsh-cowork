/**
 * The thread list (left column in split mode, the only column in drill mode).
 *
 * One roving-tabindex listbox: the selected row is the single tab stop, and
 * ArrowUp / ArrowDown / Home / End move the selection and the focus together.
 * Server order is preserved (the host already sorts), the first row is selected
 * by the panel on load, and every row pairs the status dot with its Chinese
 * label so status never depends on color alone.
 */
import { useRef } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import type { PanelThread } from '../api-contract.ts'
import {
  formatLocalTimestamp,
  formatRelativeTime,
  isLongList,
  isLongSubject,
  statusLabel,
  statusTone,
} from './model.ts'
import { StatusDot } from './chips.tsx'

export interface ThreadListProps {
  readonly threads: readonly PanelThread[]
  readonly selectedId: string | null
  readonly nowMs: number
  readonly onSelect: (threadId: string) => void
}

/** Thread list with roving tabindex and keyboard selection. */
export function ThreadList({ threads, selectedId, nowMs, onSelect }: ThreadListProps): ReactElement {
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const listState = isLongList(threads.length) ? 'long-list' : 'default'

  const selectAt = (index: number, focus: boolean): void => {
    if (threads.length === 0) return
    const clamped = Math.min(Math.max(index, 0), threads.length - 1)
    const thread = threads[clamped]
    if (thread === undefined) return
    onSelect(thread.threadId)
    if (focus) optionRefs.current.get(thread.threadId)?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentIndex = threads.findIndex(thread => thread.threadId === selectedId)
    const base = currentIndex < 0 ? 0 : currentIndex
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        selectAt(base + 1, true)
        break
      case 'ArrowUp':
        event.preventDefault()
        selectAt(base - 1, true)
        break
      case 'Home':
        event.preventDefault()
        selectAt(0, true)
        break
      case 'End':
        event.preventDefault()
        selectAt(threads.length - 1, true)
        break
      default:
        break
    }
  }

  return (
    <div
      className="cw-list"
      role="listbox"
      aria-label="Cowork thread 列表"
      aria-orientation="vertical"
      data-list-state={listState}
      onKeyDown={handleKeyDown}
    >
      {threads.map((thread, index) => {
        const selected = thread.threadId === selectedId
        const tabbable = selected || (selectedId === null && index === 0)
        return (
          <button
            key={thread.threadId}
            type="button"
            role="option"
            aria-selected={selected}
            tabIndex={tabbable ? 0 : -1}
            data-thread-id={thread.threadId}
            data-subject-state={isLongSubject(thread.subject) ? 'long-subject' : 'normal'}
            className="cw-row"
            title={thread.subject}
            ref={node => {
              if (node === null) optionRefs.current.delete(thread.threadId)
              else optionRefs.current.set(thread.threadId, node)
            }}
            onClick={() => onSelect(thread.threadId)}
          >
            <span className="cw-row-head">
              <span className="cw-row-status">
                <StatusDot tone={statusTone(thread.status)} />
                <span className="cw-status-text">{statusLabel(thread.status)}</span>
              </span>
              <span className="cw-row-time" title={formatLocalTimestamp(thread.updatedAt)}>
                {formatRelativeTime(thread.updatedAt, nowMs)}
              </span>
            </span>
            <span className="cw-row-body">
              <span className="cw-row-subject">{thread.subject.length > 0 ? thread.subject : '（无标题）'}</span>
              {thread.hasHandoff
                ? <span className="cw-handoff-mark" title="这个 thread 有交接单">交接单</span>
                : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
