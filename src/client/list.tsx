/**
 * The topic list (left column in split mode, the only column in drill mode).
 *
 * One roving-tabindex listbox: the selected row is the single tab stop, and
 * ArrowUp / ArrowDown / Home / End move the selection and the focus together.
 * Server order is preserved (the host already sorts), the first row is selected
 * by the panel on load, and every row pairs its tone with a Chinese label so
 * state never depends on color alone. Resolved topics stay listed and say who
 * resolved them.
 */
import { useRef } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import type { PanelTopic } from '../api-contract.ts'
import {
  formatLocalTimestamp,
  formatRelativeTime,
  isLongList,
  isLongSubject,
  topicRow,
} from './model.ts'
import { MarkerChips, StatusDot } from './chips.tsx'

export interface TopicListProps {
  readonly topics: readonly PanelTopic[]
  readonly selectedId: string | null
  readonly nowMs: number
  readonly onSelect: (topicId: string) => void
}

/** Pending title fallback so a row is never blank. */
const UNTITLED = '（无标题）'

/** Topic list with roving tabindex and keyboard selection. */
export function TopicList({ topics, selectedId, nowMs, onSelect }: TopicListProps): ReactElement {
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const listState = isLongList(topics.length) ? 'long-list' : 'default'

  const selectAt = (index: number, focus: boolean): void => {
    if (topics.length === 0) return
    const clamped = Math.min(Math.max(index, 0), topics.length - 1)
    const topic = topics[clamped]
    if (topic === undefined) return
    onSelect(topic.topicId)
    if (focus) optionRefs.current.get(topic.topicId)?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentIndex = topics.findIndex(topic => topic.topicId === selectedId)
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
        selectAt(topics.length - 1, true)
        break
      default:
        break
    }
  }

  return (
    <div
      className="cw-list"
      role="listbox"
      aria-label="Cowork 主题列表"
      aria-orientation="vertical"
      data-list-state={listState}
      onKeyDown={handleKeyDown}
    >
      {topics.map((topic, index) => {
        const row = topicRow(topic)
        const title = topic.title.length > 0 ? topic.title : UNTITLED
        const selected = topic.topicId === selectedId
        const tabbable = selected || (selectedId === null && index === 0)
        return (
          <button
            key={topic.topicId}
            type="button"
            role="option"
            aria-selected={selected}
            tabIndex={tabbable ? 0 : -1}
            data-topic-id={topic.topicId}
            data-status={topic.status}
            data-subject-state={isLongSubject(title) ? 'long-subject' : 'normal'}
            data-active-work={row.hasActiveWork ? 'true' : 'false'}
            className="cw-row"
            title={title}
            ref={node => {
              if (node === null) optionRefs.current.delete(topic.topicId)
              else optionRefs.current.set(topic.topicId, node)
            }}
            onClick={() => onSelect(topic.topicId)}
          >
            <span className="cw-row-head">
              <span className="cw-row-status">
                <StatusDot tone={row.statusTone} />
                <span className="cw-status-text">{row.statusLabel}</span>
                <MarkerChips markers={row.markers} />
                {row.reviewLabel === null ? null : (
                  <span
                    className="cw-review-badge"
                    data-tone={row.reviewTone ?? 'idle'}
                    title={row.reviewTitle ?? row.reviewLabel}
                  >
                    {row.reviewLabel}
                  </span>
                )}
                {row.hasActiveWork ? (
                  <span className="cw-work-mark" title="这个主题有正在运行的工作项">
                    {topic.activeWorkItems} 工作项
                  </span>
                ) : null}
              </span>
              <span className="cw-row-time" title={formatLocalTimestamp(topic.lastActiveAt)}>
                {formatRelativeTime(topic.lastActiveAt, nowMs)}
              </span>
            </span>
            <span className="cw-row-body">
              <span className="cw-row-subject">{title}</span>
              {row.resolvedByLabel === null ? null : (
                <span className="cw-resolved-by">解决：{row.resolvedByLabel}</span>
              )}
            </span>
            {row.digest.trim().length === 0 ? null : (
              <span className="cw-row-digest">{row.digest}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
