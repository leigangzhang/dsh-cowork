/**
 * The topic page list: four groups (blocked / running / idle / resolved),
 * two-line cards and a one-action ⋯ menu.
 *
 * A card is an `<article>` with one primary button (title + summary, opens the
 * topic session) and a sibling ⋯ button (its own button, never nested). The
 * menu is fixed-positioned in viewport coordinates so the sidebar's scroll
 * container cannot clip it; it flips above the ⋯ button near the bottom of the
 * window. Escape and a pointer outside close it; the item is the only action
 * its state has (archive, or restore for a resolved card).
 *
 * Archive / restore run immediately (no confirmation): the panel owns the
 * optimistic update, rollback and receipt; the card only guards against a
 * second submit while the topic is pending.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement, RefObject } from 'react'
import {
  TOPIC_ACTION_LABELS,
  formatLocalTimestamp,
  formatRelativeTime,
  placeCardMenu,
  topicCardAction,
  topicMarkerLabel,
  type MenuPlacement,
  type NoticePresentation,
  type TopicCardView,
  type TopicGroupView,
} from './model.ts'

export interface TopicStatesProps {
  readonly state: 'loading' | 'empty' | 'error' | 'default'
  readonly notice: NoticePresentation
  readonly onRefresh: () => void
}

/** Loading / empty / error surface; the list renders when state is default. */
export function TopicStates({ state, notice, onRefresh }: TopicStatesProps): ReactElement | null {
  if (state === 'default') return null
  if (state === 'loading') {
    return (
      <div className="cw-skeleton" role="status" aria-busy="true" aria-label="正在读取 Cowork 项目">
        <p className="cw-skeleton-label">正在读取 Cowork 项目…</p>
        <div className="cw-skeleton-bar" />
        <div className="cw-skeleton-bar" />
        <div className="cw-skeleton-bar" />
      </div>
    )
  }
  if (state === 'empty') {
    return (
      <div className="cw-notice" data-notice={notice.code ?? 'no-topics'}>
        <h2 className="cw-notice-title">{notice.title}</h2>
        {notice.detail.trim() === '' ? null : <p className="cw-notice-detail">{notice.detail}</p>}
        {notice.hint === null ? null : <code className="cw-notice-hint">{notice.hint}</code>}
        {notice.retry ? <button type="button" className="cw-button" onClick={onRefresh}>刷新</button> : null}
      </div>
    )
  }
  return (
    <div className="cw-notice" role="alert">
      <h2 className="cw-notice-title">{notice.title}</h2>
      <p className="cw-notice-detail">{notice.detail}</p>
      {notice.code === null ? null : (
        <p className="cw-notice-code">错误码 <code className="cw-code">{notice.code}</code></p>
      )}
      {notice.path === null ? null : (
        <p className="cw-notice-path">路径 <code className="cw-filepath">{notice.path}</code></p>
      )}
      <button type="button" className="cw-button" onClick={onRefresh}>重试</button>
    </div>
  )
}

export interface TopicListProps {
  readonly groups: readonly TopicGroupView[]
  readonly nowMs: number
  /** Topics with an archive/restore request in flight; their menu item is disabled. */
  readonly pendingTopicIds: ReadonlySet<string>
  /** Topic just archived by this panel; the resolved group opens and takes focus. */
  readonly revealTopicId: string | null
  /** Bumped on every archive so archiving the same topic again re-opens the group. */
  readonly revealNonce: number
  readonly onOpenTopic: (topicId: string) => void
  readonly onArchive: (topicId: string, title: string) => void
  readonly onRestore: (topicId: string, title: string) => void
  /** Topic whose inbox filter is active, or null when the inbox shows all. */
  readonly selectedFilterTopicId: string | null
  /** Toggle the inbox topic filter; never opens the topic session. */
  readonly onToggleFilter: (topicId: string) => void
}

/**
 * The four groups, in fixed order, empty ones omitted. The resolved group starts
 * collapsed; archiving a topic opens it and moves focus to its toggle so a
 * keyboard user does not lose the card.
 */
export function TopicList({
  groups,
  nowMs,
  pendingTopicIds,
  revealTopicId,
  revealNonce,
  onOpenTopic,
  onArchive,
  onRestore,
  selectedFilterTopicId,
  onToggleFilter,
}: TopicListProps): ReactElement {
  const [resolvedOpen, setResolvedOpen] = useState(false)
  const resolvedToggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (revealTopicId === null) return
    setResolvedOpen(true)
    resolvedToggleRef.current?.focus()
  }, [revealTopicId, revealNonce])

  const visible = groups.filter(group => group.count > 0)

  return (
    <div className="cw-list" aria-label="Cowork 主题列表">
      {visible.map(group => (
        <TopicGroup
          key={group.key}
          group={group}
          nowMs={nowMs}
          collapsed={group.key === 'resolved' && !resolvedOpen}
          toggleRef={group.key === 'resolved' ? resolvedToggleRef : null}
          pendingTopicIds={pendingTopicIds}
          onToggle={() => { setResolvedOpen(open => !open) }}
          onOpenTopic={onOpenTopic}
          onArchive={onArchive}
          onRestore={onRestore}
          selectedFilterTopicId={selectedFilterTopicId}
          onToggleFilter={onToggleFilter}
        />
      ))}
    </div>
  )
}

interface TopicGroupProps {
  readonly group: TopicGroupView
  readonly nowMs: number
  readonly collapsed: boolean
  readonly toggleRef: RefObject<HTMLButtonElement> | null
  readonly pendingTopicIds: ReadonlySet<string>
  readonly onToggle: () => void
  readonly onOpenTopic: (topicId: string) => void
  readonly onArchive: (topicId: string, title: string) => void
  readonly onRestore: (topicId: string, title: string) => void
  readonly selectedFilterTopicId: string | null
  readonly onToggleFilter: (topicId: string) => void
}

/** One group: a titled header with its count, then its cards. */
export function TopicGroup({
  group,
  nowMs,
  collapsed,
  toggleRef,
  pendingTopicIds,
  onToggle,
  onOpenTopic,
  onArchive,
  onRestore,
  selectedFilterTopicId,
  onToggleFilter,
}: TopicGroupProps): ReactElement {
  const headingId = useId()
  const cardsId = useId()
  const collapsible = group.key === 'resolved'
  return (
    <section className="cw-group" data-group={group.key} aria-labelledby={headingId}>
      <h2 className="cw-group-head" id={headingId}>
        {collapsible ? (
          <button
            ref={toggleRef}
            type="button"
            className="cw-group-toggle"
            aria-expanded={!collapsed}
            aria-controls={cardsId}
            onClick={onToggle}
          >
            <span className="cw-group-label">{group.label}</span>
            <span className="cw-group-count">{group.count}</span>
          </button>
        ) : (
          <span className="cw-group-title">
            <span className="cw-group-label">{group.label}</span>
            <span className="cw-group-count">{group.count}</span>
          </span>
        )}
      </h2>
      {collapsed ? null : (
        <div className="cw-group-cards" id={cardsId}>
          {group.cards.map(card => (
            <TopicCard
              key={card.topicId}
              card={card}
              group={group.key}
              nowMs={nowMs}
              pending={pendingTopicIds.has(card.topicId)}
              filterActive={selectedFilterTopicId === card.topicId}
              onOpenTopic={onOpenTopic}
              onArchive={onArchive}
              onRestore={onRestore}
              onToggleFilter={onToggleFilter}
            />
          ))}
        </div>
      )}
    </section>
  )
}

interface TopicCardProps {
  readonly card: TopicCardView
  readonly group: string
  readonly nowMs: number
  readonly pending: boolean
  readonly filterActive: boolean
  readonly onOpenTopic: (topicId: string) => void
  readonly onArchive: (topicId: string, title: string) => void
  readonly onRestore: (topicId: string, title: string) => void
  readonly onToggleFilter: (topicId: string) => void
}

/** One two-line card: title + summary, marker and time right-aligned. */
export function TopicCard({
  card,
  group,
  nowMs,
  pending,
  filterActive,
  onOpenTopic,
  onArchive,
  onRestore,
  onToggleFilter,
}: TopicCardProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()
  const action = topicCardAction(card)

  const place = useCallback((): void => {
    const node = moreRef.current
    if (node === null) return
    const rect = node.getBoundingClientRect()
    setPlacement(placeCardMenu(
      { top: rect.top, bottom: rect.bottom, right: rect.right },
      { width: window.innerWidth, height: window.innerHeight },
    ))
  }, [])

  const closeMenu = useCallback((restoreFocus: boolean): void => {
    setMenuOpen(false)
    setPlacement(null)
    if (restoreFocus) moreRef.current?.focus()
  }, [])

  const openMenu = (): void => {
    if (pending) return
    place()
    setMenuOpen(true)
  }

  // Escape closes and returns focus; a pointer outside closes; a resize or a
  // scroll of any ancestor re-places the fixed menu instead of letting it drift.
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) === true) return
      if (moreRef.current?.contains(target) === true) return
      closeMenu(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeMenu(true)
    }
    const onViewportChange = (): void => { place() }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [menuOpen, closeMenu, place])

  // The single menu item takes focus once the menu is painted.
  useEffect(() => {
    if (!menuOpen) return
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [menuOpen])

  const runAction = (): void => {
    if (pending) return
    closeMenu(false)
    if (action === 'archive') onArchive(card.topicId, card.title)
    else onRestore(card.topicId, card.title)
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      closeMenu(false)
      return
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
    )
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(current + 1) % items.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(current - 1 + items.length) % items.length]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      items[items.length - 1]?.focus()
    }
  }

  const title = card.title.trim().length === 0 ? '（无标题）' : card.title
  const digest = card.digest.trim().length === 0 ? '（无摘要）' : card.digest

  return (
    <article
      className="cw-card"
      data-group={group}
      data-topic-id={card.topicId}
      data-marker={card.marker ?? 'none'}
      data-pending={pending ? 'true' : 'false'}
    >
      <button
        type="button"
        className="cw-card-open"
        title={title}
        onClick={() => { onOpenTopic(card.topicId) }}
      >
        <span className="cw-card-line">
          <span className="cw-card-title">{title}</span>
          {card.marker === null ? null : (
            <span className="cw-card-marker" data-marker={card.marker}>{topicMarkerLabel(card.marker)}</span>
          )}
        </span>
        <span className="cw-card-line">
          <span className="cw-card-digest">{digest}</span>
          <span className="cw-card-time" title={formatLocalTimestamp(card.updatedAt)}>
            {formatRelativeTime(card.updatedAt, nowMs)}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="cw-card-filter"
        data-testid="cw-topic-filter"
        data-topic-id={card.topicId}
        data-active={filterActive ? 'true' : 'false'}
        aria-pressed={filterActive}
        title="只看此主题的收件箱请求"
        aria-label={`只看主题「${title}」的收件箱请求`}
        onClick={() => { onToggleFilter(card.topicId) }}
      >
        筛选
      </button>
      <button
        ref={moreRef}
        type="button"
        className="cw-card-more"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        aria-label={`主题「${title}」的更多操作`}
        disabled={pending}
        onClick={openMenu}
      >
        ⋯
      </button>
      {menuOpen && placement !== null ? (
        <div
          ref={menuRef}
          id={menuId}
          className="cw-card-menu"
          role="menu"
          aria-label="主题操作"
          data-flipped={placement.flipped ? 'true' : 'false'}
          style={{ top: placement.top, left: placement.left }}
          onKeyDown={onMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            className="cw-card-menu-item"
            data-action={action}
            disabled={pending}
            onClick={runAction}
          >
            {pending ? '处理中…' : TOPIC_ACTION_LABELS[action]}
          </button>
        </div>
      ) : null}
    </article>
  )
}
