/**
 * Topic-page stylesheet, injected once as a `<style data-plugin-css>` tag.
 *
 * Only the public theme tokens are consumed directly
 * (`--dsw-alias-bg-base|bg-layer-1|bg-layer-2|border-l1|border-l2|
 * brand-primary|label-primary|label-secondary|state-error-primary|
 * state-idle-primary|state-success-primary|state-warn-primary` and
 * `--dsw-specific-sidebar-fill`). The design demo's hex values are fallbacks, so
 * a host without the newer tokens still gets the red / green / black / gray
 * group borders instead of an unstyled list.
 *
 * Two-line cards, one fixed-position ⋯ menu (the sidebar scroll container must
 * not clip it), and single-line ellipsis for both lines at 378px. The list has
 * no detail pane, no review badges and no work-item counters by design.
 */
export const PANEL_STYLE_ID = '@dsh-external/dsh-cowork/panel'

const MONO_FONT = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"

import { INBOX_COLUMN_GAP_PX, INBOX_COLUMN_MIN_PX, TOPIC_COLUMN_WIDTH_PX } from './inbox-layout.ts'

export const PANEL_CSS = `
.cw-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1.5;
}

.cw-root * { box-sizing: border-box; }

.cw-header {
  flex: none;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 6px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  background: var(--dsw-specific-sidebar-fill);
}

.cw-project {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: ${MONO_FONT};
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}

.cw-breadcrumb {
  flex: none;
  padding: 2px 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
}

.cw-breadcrumb:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
}

.cw-breadcrumb:disabled { opacity: 0.5; cursor: not-allowed; }

.cw-icon-button,
.cw-button,
.cw-button-primary {
  font: inherit;
  font-size: 12px;
  border-radius: var(--dsw-radius-sm, 8px);
  padding: 3px 9px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}

.cw-icon-button,
.cw-button {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l2);
}

/* The refresh control must never shrink or wrap in the 381px sidebar. */
.cw-icon-button {
  flex: none;
  white-space: nowrap;
}

.cw-icon-button:hover,
.cw-button:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}

.cw-button-primary {
  color: var(--dsw-alias-bg-base);
  background: var(--dsw-alias-brand-primary);
  border: 0.5px solid var(--dsw-alias-brand-primary);
}

.cw-button-primary:hover {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 88%, var(--dsw-alias-bg-base));
}

.cw-icon-button:disabled,
.cw-button:disabled,
.cw-button-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cw-root :focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}

/* "需要你处理": the only needs-you entry; it opens the first waiting topic. */
.cw-needs-you {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin: 6px 8px 2px;
  padding: 8px 11px;
  border: 1px solid var(--dsw-alias-state-error-primary, #fecdca);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #fef3f2);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.cw-needs-you:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}

.cw-needs-you-title {
  font-size: 12px;
  font-weight: 650;
  color: var(--dsw-alias-state-error-primary, #912018);
}

.cw-needs-you-hint {
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

/* Archive / restore receipts: visible, short-lived and never a confirmation. */
.cw-receipt {
  flex: none;
  margin: 4px 8px;
  padding: 5px 9px;
  border-radius: var(--dsw-radius-sm, 8px);
  border: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
}

.cw-receipt[data-kind="ok"] { color: var(--dsw-alias-state-success-primary, #067647); }
.cw-receipt[data-kind="failed"] { color: var(--dsw-alias-state-error-primary, #b42318); }

.cw-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.cw-list {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 6px 12px;
}

.cw-group { margin: 0 0 10px; }

.cw-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 6px;
  padding: 0 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}

.cw-group-title,
.cw-group-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}

.cw-group-toggle { cursor: pointer; }

.cw-group-count {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}

.cw-group-cards {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* A card is two lines of text plus a sibling ⋯ button; nothing else. */
.cw-card {
  display: flex;
  align-items: flex-start;
  gap: 2px;
  margin: 0;
  padding: 8px 8px 7px 11px;
  border: 1px solid var(--dsw-alias-border-l2, #e4e7ec);
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
}

.cw-card[data-group="blocked"] {
  border-color: var(--dsw-alias-state-error-primary, #fecdca);
  background: var(--dsw-alias-bg-layer-1, #fffbfa);
  color: var(--dsw-alias-label-primary);
}

.cw-card[data-group="running"] {
  border-color: var(--dsw-alias-state-success-primary, #75e0a7);
}

.cw-card[data-group="idle"] {
  border-color: var(--dsw-alias-label-primary, #101828);
  background: var(--dsw-alias-bg-base, #fcfcfd);
}

.cw-card[data-group="resolved"] {
  border-color: var(--dsw-alias-border-l2, #c3c9d4);
  background: var(--dsw-alias-bg-base, #fcfcfd);
}

.cw-card[data-pending="true"] { opacity: 0.7; }

.cw-card-open {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.cw-card-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  width: 100%;
}

.cw-card-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12.5px;
  font-weight: 650;
  line-height: 1.5;
}

.cw-card[data-group="blocked"] .cw-card-title {
  color: var(--dsw-alias-state-error-primary, #7a271a);
}

.cw-card-marker {
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 1.7;
  white-space: nowrap;
  border: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}

.cw-card-marker[data-marker="authorization"] {
  border-color: var(--dsw-alias-state-warn-primary, #fedf89);
  background: var(--dsw-alias-bg-layer-2, #fffaeb);
  color: var(--dsw-alias-label-primary);
}

.cw-card-marker[data-marker="waiting-master"] {
  border-color: var(--dsw-alias-state-error-primary, #fecdca);
  color: var(--dsw-alias-state-error-primary, #7a271a);
}

.cw-card-digest {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
  line-height: 1.55;
  color: var(--dsw-alias-label-secondary);
}

.cw-card-time {
  flex: none;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}

.cw-card-more {
  flex: none;
  width: 20px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 14px;
  line-height: 1;
  letter-spacing: 1px;
  cursor: pointer;
}

.cw-card-more:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }

.cw-card-more:disabled { opacity: 0.5; cursor: not-allowed; }

/* Fixed coordinates: the menu is never clipped by the sidebar scroller. */
.cw-card-menu {
  position: fixed;
  z-index: 50;
  display: flex;
  flex-direction: column;
  min-width: 104px;
  padding: 3px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, #ffffff);
  box-shadow: 0 10px 26px rgba(16, 24, 40, 0.15);
}

.cw-card-menu-item {
  display: block;
  width: 100%;
  height: 28px;
  padding: 0 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.cw-card-menu-item:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}

.cw-card-menu-item[data-action="archive"] {
  color: var(--dsw-alias-state-error-primary, #b42318);
}

.cw-card-menu-item[data-action="restore"] {
  color: var(--dsw-alias-state-success-primary, #067647);
}

.cw-card-menu-item:disabled { opacity: 0.5; cursor: not-allowed; }

.cw-notice {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 14px 12px;
  width: 100%;
}

.cw-notice-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.cw-notice-detail {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
}

.cw-notice-code,
.cw-notice-path {
  display: flex;
  gap: 6px;
  margin: 0;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
  max-width: 100%;
}

.cw-notice-hint {
  margin: 0;
  padding: 2px 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  font-family: ${MONO_FONT};
  font-size: 11.5px;
}

.cw-code,
.cw-filepath {
  font-family: ${MONO_FONT};
  font-size: 11px;
  word-break: break-all;
}

.cw-code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}

/* Session notice card: same tokens as the list, no nested interactive elements. */
.cw-notice-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 11px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  min-width: 0;
}

.cw-notice-card[data-notice-kind="authorization"] {
  border-color: var(--dsw-alias-state-warn-primary, #fedf89);
}

.cw-notice-card[data-notice-kind="archive"] {
  border-color: var(--dsw-alias-state-success-primary, #abefc6);
}

.cw-notice-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
}

.cw-notice-card-status[data-status="allowed"] { color: var(--dsw-alias-state-success-primary, #067647); }
.cw-notice-card-status[data-status="denied"] { color: var(--dsw-alias-state-error-primary, #b42318); }

.cw-notice-card-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 650;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.cw-notice-card-summary {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.cw-notice-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cw-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  padding: 12px;
}

.cw-skeleton-label {
  margin: 0 0 2px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
}

.cw-skeleton-bar {
  height: 12px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  animation: cw-pulse 1200ms ease-in-out infinite;
}

.cw-skeleton-bar:nth-child(3) { width: 82%; }
.cw-skeleton-bar:nth-child(4) { width: 64%; }

@keyframes cw-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.cw-footer-slot {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  width: calc(100% + 4px);
  height: 42px;
  margin: 4px -2px;
}

.cw-footer-slot[data-wide='false'] {
  width: 36px;
  height: 36px;
  margin: 0;
}

.cw-footer-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 42px;
  padding: 0 10px 0 8px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
}

.cw-footer-button:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
}

.cw-footer-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cw-footer-glyph {
  flex: none;
  display: block;
  width: 16px;
  height: 16px;
}

.cw-footer-button[data-wide='false'] {
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
  justify-content: center;
  gap: 0;
}

.cw-footer-button[data-wide='false'] .cw-footer-glyph {
  width: 18px;
  height: 18px;
}

.cw-footer-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 20px;
}

.cw-tab-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.cw-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}


/* ---- Request inbox (topic inbox, 2026-11-10) ---------------------------- */

/*
 * Wide layout: a fixed topic column and an independently scrolling inbox
 * column. The host right bar owns its own width; the panel only chooses which
 * of the two layouts fits, so nothing here touches host DOM or forces a width.
 */
.cw-root { overflow: hidden; }

.cw-columns {
  display: grid;
  grid-template-columns: ${TOPIC_COLUMN_WIDTH_PX}px minmax(${INBOX_COLUMN_MIN_PX}px, 1fr);
  gap: ${INBOX_COLUMN_GAP_PX}px;
  min-height: 0;
  min-width: 0;
  padding: 6px 4px 8px;
  overflow: hidden;
}

.cw-topic-column,
.cw-inbox-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.cw-topic-column {
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* The topic list itself must not become a second scroller inside its column. */
.cw-topic-column .cw-list {
  flex: 0 0 auto;
  overflow: visible;
  padding: 4px 2px 8px;
}

.cw-inbox-column { overflow: hidden; }
.cw-inbox-column .cw-inbox { flex: 1 1 auto; }

.cw-inbox {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--dsw-alias-border-l2, #e4e7ec);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base, #ffffff);
  overflow: hidden;
}

.cw-inbox-head {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 7px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e4e7ec);
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1));
}

.cw-inbox-heading {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11.5px;
  font-weight: 650;
  color: var(--dsw-alias-label-secondary);
}

.cw-inbox-count {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.cw-inbox-filter-clear {
  max-width: 100%;
  padding: 1px 7px;
  border: 0.5px solid var(--dsw-alias-border-l2, #e4e7ec);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, #f2f4f7);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10px;
  line-height: 1.7;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.cw-inbox-hint {
  margin-left: auto;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
}

.cw-inbox-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 8px 12px;
}

.cw-inbox-loading,
.cw-inbox-empty,
.cw-inbox-truncated {
  margin: 0;
  padding: 14px 6px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
}

.cw-inbox-error {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 6px 8px;
  padding: 6px 9px;
  border: 1px solid var(--dsw-alias-state-error-primary, #fecdca);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #fffbfa);
}

.cw-inbox-error-text {
  margin: 0;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

/* One request thread: left message, the card, then the resolved right reply. */
.cw-thread {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 2px 0 10px;
}

.cw-thread-msg {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.cw-thread-msg-out { justify-content: flex-end; }

.cw-thread-avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2, #e9f1ff);
  color: var(--dsw-alias-brand-primary, #175cd3);
  font-size: 10px;
  font-weight: 700;
}

.cw-thread-avatar-user {
  background: var(--dsw-alias-label-primary, #101828);
  color: var(--dsw-alias-bg-base, #ffffff);
}

.cw-thread-bubble {
  max-width: 84%;
  margin: 0;
  padding: 7px 10px;
  border-radius: 11px;
  background: var(--dsw-alias-bg-layer-2, #f2f4f7);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.cw-thread-msg-in .cw-thread-bubble { border-bottom-left-radius: 3px; }

.cw-thread-msg-out .cw-thread-bubble {
  border-bottom-right-radius: 3px;
  border: 0.5px solid var(--dsw-alias-border-l2, #d1e9ff);
  background: var(--dsw-alias-bg-layer-1, #eff8ff);
}

/*
 * Request cards use their own cw-req-* names on purpose: the topic card rules
 * (.cw-card) must never leak into the inbox stream.
 */
.cw-req-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l2, #e4e7ec);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  overflow: hidden;
}

.cw-req-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e4e7ec);
  background: var(--dsw-alias-bg-layer-2, #f9fafb);
  color: var(--dsw-alias-label-primary);
  font-size: 11.5px;
  font-weight: 600;
}

.cw-req-head[data-tone="warn"] {
  border-bottom-color: var(--dsw-alias-state-warn-primary, #fedf89);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #fedf89) 18%, var(--dsw-alias-bg-layer-1, #ffffff));
}

.cw-req-head[data-tone="warn"] .cw-req-status::before {
  content: '';
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary, #f79009);
  vertical-align: 1px;
}

.cw-req-head[data-tone="done"] {
  color: var(--dsw-alias-label-secondary);
}

.cw-req-status { min-width: 0; }

.cw-req-open {
  flex: none;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10.5px;
  white-space: nowrap;
  cursor: pointer;
}

.cw-req-open:hover { color: var(--dsw-alias-brand-primary, #b54708); }

.cw-req-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
}

.cw-req-text,
.cw-req-question,
.cw-req-plan-title {
  margin: 0;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

.cw-req-text { font-size: 12px; line-height: 1.6; }
.cw-req-question { font-size: 13px; font-weight: 600; line-height: 1.55; }
.cw-req-plan-title { font-size: 13px; font-weight: 650; line-height: 1.5; }

.cw-req-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.cw-req-label {
  display: block;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 10.5px;
  line-height: 1.5;
}

.cw-req-paths,
.cw-req-verify {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
  min-width: 0;
}

.cw-req-paths code,
.cw-req-verify code {
  font-family: ${MONO_FONT};
  font-size: 10.5px;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}

.cw-req-verify li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.cw-req-exit {
  flex: none;
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}

.cw-req-exit[data-exit="ok"] { color: var(--dsw-alias-state-success-primary, #067647); }
.cw-req-exit[data-exit="failed"] { color: var(--dsw-alias-state-error-primary, #b42318); }

.cw-req-evidence {
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 10.5px;
  overflow-wrap: anywhere;
}

.cw-req-command {
  display: block;
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, #f2f4f7);
  color: var(--dsw-alias-label-secondary);
  font-family: ${MONO_FONT};
  font-size: 10.5px;
  line-height: 1.5;
  word-break: break-all;
  overflow-wrap: anywhere;
}

.cw-req-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 12px 12px;
}

.cw-req-actions-block { padding: 0 12px 12px; }

.cw-req-actions-block .cw-req-actions {
  padding: 0;
  margin-top: 8px;
}

.cw-req-action {
  min-height: 30px;
  padding: 0 13px;
  border: 1px solid var(--dsw-alias-border-l2, #e4e7ec);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}

.cw-req-action:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }

.cw-req-action:disabled { opacity: 0.5; cursor: not-allowed; }

.cw-req-action[data-action="allow"],
.cw-req-action[data-action="pass"],
.cw-req-action[data-action="approve"],
.cw-req-action[data-action="submit"] {
  border-color: var(--dsw-alias-brand-primary, #101828);
  background: var(--dsw-alias-brand-primary, #101828);
  color: var(--dsw-alias-bg-base, #ffffff);
}

.cw-req-action[data-action="deny"],
.cw-req-action[data-action="return"] {
  border-color: var(--dsw-alias-state-error-primary, #fda29b);
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-state-error-primary, #b42318);
}

.cw-req-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.cw-req-input {
  width: 100%;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l2, #d0d5dd);
  border-radius: 7px;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
}

textarea.cw-req-input { resize: vertical; min-height: 42px; }

.cw-inbox-options {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.cw-inbox-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--dsw-alias-border-l2, #e4e7ec);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.cw-inbox-option:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }

.cw-inbox-option[data-selected="true"] {
  border-color: var(--dsw-alias-brand-primary, #84adff);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #84adff) 10%, var(--dsw-alias-bg-base, #ffffff));
}

.cw-inbox-option input {
  flex: none;
  margin: 3px 0 0;
  accent-color: var(--dsw-alias-brand-primary, #175cd3);
}

.cw-inbox-option-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.cw-inbox-option-label {
  min-width: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.cw-inbox-option-tag {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, #eff8ff);
  color: var(--dsw-alias-label-secondary);
  font-size: 9px;
  font-weight: 600;
}

.cw-inbox-option-desc {
  flex-basis: 100%;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.cw-inbox-pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.cw-inbox-pager-button {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l2, #e4e7ec);
  border-radius: 6px;
  background: var(--dsw-alias-bg-base, #ffffff);
  color: inherit;
  font: inherit;
  line-height: 1;
  cursor: pointer;
}

.cw-inbox-pager-button:disabled { opacity: 0.4; cursor: not-allowed; }

.cw-req-revise {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 12px 12px;
}

.cw-inbox-receipt {
  margin: 0 12px 10px;
  padding: 5px 8px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2, #f2f4f7);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.cw-inbox-receipt[data-kind="ok"] { color: var(--dsw-alias-state-success-primary, #067647); }
.cw-inbox-receipt[data-kind="error"] { color: var(--dsw-alias-state-error-primary, #b42318); }
.cw-inbox-receipt[data-kind="warn"] { color: var(--dsw-alias-label-primary); }

/* Notification notes: centered gray text, no card, no action. */
.cw-inbox-item-note {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 4px 0 10px;
}

.cw-inbox-item-note .cw-inbox-receipt { margin: 0 8px; }

.cw-inbox-note {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: center;
  gap: 2px 6px;
  min-width: 0;
  padding: 4px 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 10.5px;
  line-height: 1.6;
  text-align: center;
  overflow-wrap: anywhere;
}

.cw-inbox-note-label { font-weight: 600; }
.cw-inbox-note-summary { min-width: 0; }
.cw-inbox-note-time { opacity: 0.8; font-variant-numeric: tabular-nums; }

.cw-inbox-note-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-brand-primary, #175cd3);
  font: inherit;
  font-size: 10.5px;
  text-decoration: underline;
  cursor: pointer;
}

.cw-inbox-note-link:disabled { opacity: 0.5; cursor: not-allowed; }

/* Narrow-panel full-width inbox: an in-panel fallback, never host DOM work. */
.cw-inbox-focus {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 4px 8px 8px;
}

.cw-inbox-focus-bar {
  flex: none;
  display: flex;
  align-items: center;
  padding: 2px 0 6px;
}

.cw-inbox-focus .cw-inbox { flex: 1 1 auto; min-height: 0; }

/* Topic-card filter button: a sibling of the open button, never nested. */
.cw-card-filter {
  flex: none;
  align-self: flex-start;
  padding: 1px 7px;
  border: 0.5px solid var(--dsw-alias-border-l2, #e4e7ec);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 10px;
  line-height: 1.7;
  white-space: nowrap;
  cursor: pointer;
}

.cw-card-filter:hover {
  border-color: var(--dsw-alias-brand-primary, #84adff);
  color: var(--dsw-alias-brand-primary, #175cd3);
}

.cw-card-filter[data-active="true"] {
  border-color: var(--dsw-alias-brand-primary, #84adff);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #84adff) 14%, transparent);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}

@media (prefers-reduced-motion: reduce) {
  .cw-skeleton-bar { animation: none; }
  .cw-root * { transition: none; }
}
`

/**
 * Mount the panel stylesheet once, keyed by `data-plugin-css` so re-applies are
 * idempotent. Safe to call from every component render.
 */
export function ensurePanelStyles(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (doc === undefined) return
  const selector = `style[data-plugin-css="${PANEL_STYLE_ID}"]`
  if (doc.head.querySelector(selector) !== null) return
  const tag = doc.createElement('style')
  tag.dataset.plugin = PANEL_STYLE_ID
  tag.dataset.pluginCss = PANEL_STYLE_ID
  tag.textContent = PANEL_CSS
  doc.head.appendChild(tag)
}
