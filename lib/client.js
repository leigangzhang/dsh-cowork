window.__ModuleLoader__.load({ id: "@dsh-external/dsh-cowork", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/inbox-layout.ts
var INBOX_COLUMN_MIN_PX = 280;
var TOPIC_COLUMN_WIDTH_PX = 318;
var INBOX_COLUMN_GAP_PX = 12;

// src/client/styles.ts
var PANEL_STYLE_ID = "@dsh-external/dsh-cowork/panel";
var MONO_FONT = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
var PANEL_CSS = `
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
`;
function ensurePanelStyles(doc = typeof document === "undefined" ? void 0 : document) {
  if (doc === void 0) return;
  const selector = `style[data-plugin-css="${PANEL_STYLE_ID}"]`;
  if (doc.head.querySelector(selector) !== null) return;
  const tag = doc.createElement("style");
  tag.dataset.plugin = PANEL_STYLE_ID;
  tag.dataset.pluginCss = PANEL_STYLE_ID;
  tag.textContent = PANEL_CSS;
  doc.head.appendChild(tag);
}

// src/client/panel.tsx
var import_react4 = require("react");

// src/notice-contract.ts
var NOTICE_KINDS = ["assignment", "report", "proposal", "authorization", "archive"];
function isNoticeKind(value) {
  return typeof value === "string" && NOTICE_KINDS.includes(value);
}

// src/inbox-contract.ts
var INBOX_PATH = "/api/cowork.inbox";
var INBOX_RESOLVE_PATH = "/api/cowork.inbox.resolve";
var INBOX_OPEN_PATH = "/api/cowork.inbox.open";
var REQUEST_KINDS = ["user-review", "authorization", "question", "plan"];
var REQUEST_STATUSES = [
  "pending",
  "passed",
  "returned",
  "allowed",
  "denied",
  "answered",
  "skipped",
  "approved",
  "revise",
  "void"
];
var REQUEST_ACTIONS = [
  "pass",
  "return",
  "allow",
  "deny",
  "submit",
  "skip",
  "approve",
  "revise"
];
var REQUEST_ACTIONS_BY_KIND = {
  "user-review": ["return", "pass"],
  authorization: ["deny", "allow"],
  question: ["skip", "submit"],
  plan: ["revise", "approve"]
};
var REQUEST_PENDING_LABELS = {
  "user-review": "等待审核",
  authorization: "等待审批",
  question: "问题",
  plan: "计划待审"
};
var REQUEST_STATUS_LABELS = {
  pending: "等待处理",
  passed: "已通过",
  returned: "已退回",
  allowed: "已允许",
  denied: "已拒绝",
  answered: "已回答",
  skipped: "已跳过",
  approved: "已同意",
  revise: "已要求修改",
  void: "已作废"
};
var REQUEST_COUNT_FIELD = {
  "user-review": "review",
  authorization: "authorization",
  question: "question",
  plan: "plan"
};
var INBOX_NOTICE_KINDS = NOTICE_KINDS.filter(
  (kind) => kind !== "authorization"
);
var INBOX_NOTIFICATION_KINDS = [...INBOX_NOTICE_KINDS, "review-verdict"];
var INBOX_ERROR_STATUS = {
  "inbox/request-not-found": 404,
  "inbox/request-resolved": 409,
  "inbox/action-not-allowed": 400,
  "inbox/invalid-answer": 400,
  "inbox/invalid-comment": 400,
  "inbox/path-missing": 404,
  "inbox/open-unsupported": 501,
  "inbox/not-member": 403
};
function emptyInboxCounts() {
  return { pending: 0, review: 0, authorization: 0, question: 0, plan: 0 };
}
function isRequestKind(value) {
  return typeof value === "string" && REQUEST_KINDS.includes(value);
}
function isRequestStatus(value) {
  return typeof value === "string" && REQUEST_STATUSES.includes(value);
}
function isRequestAction(value) {
  return typeof value === "string" && REQUEST_ACTIONS.includes(value);
}
function isInboxNotificationKind(value) {
  return typeof value === "string" && INBOX_NOTIFICATION_KINDS.includes(value);
}
function actionAllowed(kind, action) {
  return REQUEST_ACTIONS_BY_KIND[kind].some((candidate) => candidate === action);
}
function answerCoversQuestion(question, answer) {
  if (answer === void 0) return false;
  const selected = Array.isArray(answer.selected) ? answer.selected : [];
  const text2 = typeof answer.text === "string" ? answer.text.trim() : "";
  const textCovers = text2 !== "" && question.allowText === true;
  if (selected.length === 0) return textCovers;
  const optionIds = new Set((question.options ?? []).map((option) => option.id));
  if (selected.some((id) => !optionIds.has(id))) return false;
  return question.mode === "multi" || selected.length === 1;
}

// src/api-contract.ts
var OVERVIEW_PATH = "/api/cowork.overview";
var RESOLVE_PATH = "/api/cowork.topic.resolve";
var REOPEN_PATH = "/api/cowork.topic.reopen";
var PANEL_TOPIC_STATUS_ORDER = ["active", "idle", "resolved"];
var PANEL_REVIEW_STATUSES = [
  "pending",
  "pass",
  "needs_revision",
  "reject"
];
var PANEL_ERROR_STATUS = {
  "request/session-required": 400,
  "request/topic-required": 400,
  "request/invalid-query": 400,
  "request/invalid-body": 400,
  "request/body-too-large": 413,
  "request/content-type": 415,
  "request/origin": 403,
  "request/not-master": 403,
  "topic/not-found": 404,
  "topic/not-resolved": 409,
  "authorization/not-found": 404,
  "authorization/mismatch": 409,
  "authorization/not-allowed": 403,
  "route/move-invalid": 400,
  "session/unknown": 400,
  "session/cwd-unavailable": 400,
  "session/list-timeout": 504,
  "project/not-initialized": 404,
  "store/corrupt": 500,
  ...INBOX_ERROR_STATUS,
  internal: 500
};
function isPanelError(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  if (record.ok !== false) return false;
  const error = record.error;
  return typeof error === "object" && error !== null && typeof error.code === "string";
}
function isPanelTopicStatus(value) {
  return typeof value === "string" && PANEL_TOPIC_STATUS_ORDER.includes(value);
}
function isPanelReviewStatus(value) {
  return typeof value === "string" && PANEL_REVIEW_STATUSES.includes(value);
}

// src/client/api.ts
var PanelApiError = class extends Error {
  code;
  path;
  constructor(code, message, path) {
    super(message);
    this.name = "PanelApiError";
    this.code = code;
    if (path !== void 0) this.path = path;
  }
};
function isAbortError(reason) {
  return typeof reason === "object" && reason !== null && reason.name === "AbortError";
}
function toPanelError(reason) {
  if (reason instanceof PanelApiError) return reason;
  if (reason instanceof Error) return { code: "internal", message: reason.message };
  return { code: "internal", message: String(reason) };
}
function errorMessage(reason) {
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  return String(reason);
}
function panelApiPath(path, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.append(key, value);
  const search = query.toString();
  return search.length === 0 ? path : `${path}?${search}`;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function text(value) {
  return typeof value === "string" ? value : "";
}
function optionalText(value) {
  return nonEmptyString(value);
}
function count(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string");
}
function requiredArray(value, what) {
  if (!Array.isArray(value)) throw new PanelApiError("internal", `响应缺少 ${what} 数组`);
  return value;
}
var BLOCKED_REASONS = ["authorization", "handoff", "conflict"];
function blockedReason(value) {
  return BLOCKED_REASONS.find((reason) => reason === value) ?? null;
}
function parseProject(value) {
  if (!isRecord(value)) throw new PanelApiError("internal", "总览响应缺少 project");
  return {
    repoPath: text(value.repoPath),
    projectId: text(value.projectId),
    masterSessionId: text(value.masterSessionId),
    createdAt: text(value.createdAt)
  };
}
function parseCounts(value) {
  const record = isRecord(value) ? value : {};
  return {
    active: count(record.active),
    idle: count(record.idle),
    resolved: count(record.resolved),
    blocked: count(record.blocked),
    awaitingReview: count(record.awaitingReview),
    pendingReview: count(record.pendingReview),
    workItemActive: count(record.workItemActive),
    workItemReviewing: count(record.workItemReviewing),
    workItemMerged: count(record.workItemMerged),
    workItemAbandoned: count(record.workItemAbandoned)
  };
}
function parseTopicRow(value) {
  if (!isRecord(value)) return null;
  const topicId = nonEmptyString(value.topicId);
  if (topicId === null) return null;
  if (!isPanelTopicStatus(value.status)) return null;
  const resolvedBy = value.resolvedBy === "user" || value.resolvedBy === "master" ? value.resolvedBy : null;
  const row = {
    topicId,
    title: text(value.title),
    status: value.status,
    blocked: value.blocked === true,
    awaitingReview: value.awaitingReview === true,
    reviewStatus: isPanelReviewStatus(value.reviewStatus) ? value.reviewStatus : null,
    latestReviewRequestId: optionalText(value.latestReviewRequestId),
    digest: text(value.digest),
    scope: text(value.scope),
    ownedPaths: stringArray(value.ownedPaths),
    lastActiveAt: text(value.lastActiveAt),
    updatedAt: text(value.updatedAt),
    lastDeliveryConfirmedAt: optionalText(value.lastDeliveryConfirmedAt),
    resolvedAt: optionalText(value.resolvedAt),
    resolvedBy,
    activeWorkItems: count(value.activeWorkItems),
    awaitingAuthorization: value.awaitingAuthorization === true,
    blockedReason: blockedReason(value.blockedReason)
  };
  return row;
}
function parseInboxItem(value) {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  if (id === null) return null;
  return {
    id,
    time: text(value.time),
    topicId: text(value.topicId),
    kind: text(value.kind),
    summary: text(value.summary),
    deliveredAt: optionalText(value.deliveredAt)
  };
}
function parseOverview(body) {
  if (!isRecord(body)) throw new PanelApiError("internal", "总览响应不是对象");
  if (body.ok !== true) throw new PanelApiError("internal", "总览响应缺少 ok: true");
  const project = parseProject(body.project);
  const counts = parseCounts(body.counts);
  const topics = requiredArray(body.topics, "topics").map(parseTopicRow).filter((topic) => topic !== null);
  const inbox = requiredArray(body.inbox, "inbox").map(parseInboxItem).filter((item) => item !== null);
  return { ok: true, project, counts, topics, inbox };
}
function parseResolve(body) {
  if (!isRecord(body)) throw new PanelApiError("internal", "解决响应不是对象");
  if (body.ok !== true) throw new PanelApiError("internal", "解决响应缺少 ok: true");
  const topic = parseTopicRow(body.topic);
  if (topic === null) throw new PanelApiError("internal", "解决响应里的主题行不可用");
  return { ok: true, topic, alreadyResolved: body.alreadyResolved === true };
}
function parseReopen(body) {
  if (!isRecord(body)) throw new PanelApiError("internal", "重开响应不是对象");
  if (body.ok !== true) throw new PanelApiError("internal", "重开响应缺少 ok: true");
  const topic = parseTopicRow(body.topic);
  if (topic === null) throw new PanelApiError("internal", "重开响应里的主题行不可用");
  return { ok: true, topic };
}
function parseVerification(value) {
  if (!isRecord(value)) return null;
  const command = text(value.command);
  if (command.trim() === "") return null;
  const exitCode = value.exitCode;
  return {
    command,
    exitCode: typeof exitCode === "number" && Number.isFinite(exitCode) ? Math.trunc(exitCode) : 0,
    evidence: text(value.evidence)
  };
}
function parseReviewPayload(value) {
  const record = isRecord(value) ? value : {};
  const reviewRequestId = optionalText(record.reviewRequestId);
  const payload = {
    purpose: text(record.purpose),
    changedPaths: stringArray(record.changedPaths),
    verification: Array.isArray(record.verification) ? record.verification.map(parseVerification).filter((row) => row !== null) : []
  };
  return reviewRequestId === null ? payload : { ...payload, reviewRequestId };
}
function parseAuthorizationPayload(value) {
  const record = isRecord(value) ? value : {};
  const command = optionalText(record.command);
  const summary = text(record.summary);
  return command === null ? { summary } : { summary, command };
}
function parseQuestionOption(value) {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  if (id === null) return null;
  const description = optionalText(value.description);
  const option = {
    id,
    label: text(value.label),
    recommended: value.recommended === true
  };
  return description === null ? option : { ...option, description };
}
function parseQuestion(value) {
  if (!isRecord(value)) return null;
  const id = nonEmptyString(value.id);
  if (id === null) return null;
  const options = Array.isArray(value.options) ? value.options.map(parseQuestionOption).filter((option) => option !== null) : void 0;
  const question = {
    id,
    prompt: text(value.prompt),
    mode: value.mode === "multi" ? "multi" : "single",
    allowText: value.allowText === true
  };
  return options === void 0 ? question : { ...question, options };
}
function parseQuestionPayload(value) {
  const record = isRecord(value) ? value : {};
  return {
    questions: Array.isArray(record.questions) ? record.questions.map(parseQuestion).filter((question) => question !== null) : []
  };
}
function parsePlanPayload(value) {
  const record = isRecord(value) ? value : {};
  const planTitle = optionalText(record.planTitle);
  const planPath = text(record.planPath);
  return planTitle === null ? { planPath } : { planPath, planTitle };
}
function parseInboxRequestItem(value) {
  if (!isRecord(value) || value.kind !== "request") return null;
  const requestId = nonEmptyString(value.requestId);
  if (requestId === null) return null;
  if (!isRequestKind(value.requestKind)) return null;
  if (!isRequestStatus(value.status)) return null;
  const topicId = nonEmptyString(value.topicId);
  if (topicId === null) return null;
  const requestKind = value.requestKind;
  const actions = Array.isArray(value.actions) ? value.actions.filter((action) => isRequestAction(action) && actionAllowed(requestKind, action)) : [];
  const base = {
    kind: "request",
    requestId,
    topicId,
    topicTitle: optionalText(value.topicTitle) ?? "已归档主题",
    status: value.status,
    title: text(value.title),
    summary: text(value.summary),
    requestMessage: text(value.requestMessage),
    resolutionMessage: optionalText(value.resolutionMessage),
    actions: value.status === "pending" ? actions : [],
    createdAt: text(value.createdAt),
    updatedAt: text(value.updatedAt)
  };
  switch (requestKind) {
    case "user-review":
      return { ...base, requestKind: "user-review", payload: parseReviewPayload(value.payload) };
    case "authorization":
      return { ...base, requestKind: "authorization", payload: parseAuthorizationPayload(value.payload) };
    case "question":
      return { ...base, requestKind: "question", payload: parseQuestionPayload(value.payload) };
    case "plan":
      return { ...base, requestKind: "plan", payload: parsePlanPayload(value.payload) };
  }
}
function parseInboxNotificationItem(value) {
  if (!isRecord(value) || value.kind !== "notification") return null;
  const noticeId = nonEmptyString(value.noticeId);
  if (noticeId === null) return null;
  if (!isInboxNotificationKind(value.noticeKind)) return null;
  const proposalPath = optionalText(value.proposalPath);
  const canOpen = value.noticeKind !== "review-verdict" && value.canOpen === true;
  const item = {
    kind: "notification",
    noticeId,
    noticeKind: value.noticeKind,
    topicId: text(value.topicId),
    topicTitle: optionalText(value.topicTitle) ?? "已归档主题",
    summary: text(value.summary),
    createdAt: text(value.createdAt),
    updatedAt: text(value.updatedAt),
    canOpen
  };
  return proposalPath === null ? item : { ...item, proposalPath };
}
function parseInboxRow(value) {
  if (!isRecord(value)) return null;
  if (value.kind === "request") return parseInboxRequestItem(value);
  if (value.kind === "notification") return parseInboxNotificationItem(value);
  return null;
}
function parseInboxCounts(value) {
  if (!isRecord(value)) return emptyInboxCounts();
  return {
    pending: count(value.pending),
    review: count(value.review),
    authorization: count(value.authorization),
    question: count(value.question),
    plan: count(value.plan)
  };
}
function parseInboxResponse(body) {
  if (!isRecord(body)) throw new PanelApiError("internal", "收件箱响应不是对象");
  if (body.ok !== true) throw new PanelApiError("internal", "收件箱响应缺少 ok: true");
  const items = requiredArray(body.items, "items").map(parseInboxRow).filter((item) => item !== null);
  return {
    ok: true,
    items,
    counts: parseInboxCounts(body.counts),
    truncated: body.truncated === true
  };
}
function parseInboxResolveResponse(body) {
  if (!isRecord(body)) throw new PanelApiError("internal", "解决响应不是对象");
  if (body.ok !== true) throw new PanelApiError("internal", "解决响应缺少 ok: true");
  const item = parseInboxRequestItem(body.item);
  if (item === null) throw new PanelApiError("internal", "解决响应里的收件箱项不可用");
  return {
    ok: true,
    item,
    changed: body.changed === true,
    prompted: body.prompted === true,
    promptError: optionalText(body.promptError)
  };
}
function parseInboxOpenResponse(body) {
  if (!isRecord(body) || body.ok !== true || body.opened !== true) {
    throw new PanelApiError("internal", "打开响应缺少 ok: true 与 opened: true");
  }
  return { ok: true, opened: true };
}
async function readPanelBody(response) {
  let body;
  try {
    body = await response.json();
  } catch (reason) {
    if (isAbortError(reason)) throw reason;
    throw new PanelApiError("internal", `响应不是 JSON（HTTP ${response.status}）`);
  }
  if (isPanelError(body)) {
    throw new PanelApiError(body.error.code, body.error.message, body.error.path);
  }
  if (!response.ok) {
    throw new PanelApiError("internal", `请求失败（HTTP ${response.status}）`);
  }
  return body;
}
async function fetchPanelJson(path, params, signal) {
  let response;
  try {
    response = await fetch(panelApiPath(path, params), {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal
    });
  } catch (reason) {
    if (isAbortError(reason)) throw reason;
    throw new PanelApiError("internal", `请求失败：${errorMessage(reason)}`);
  }
  return readPanelBody(response);
}
async function postPanelJson(path, payload, signal) {
  let response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal
    });
  } catch (reason) {
    if (isAbortError(reason)) throw reason;
    throw new PanelApiError("internal", `请求失败：${errorMessage(reason)}`);
  }
  return readPanelBody(response);
}
async function loadOverview(sessionId, signal) {
  return parseOverview(await fetchPanelJson(OVERVIEW_PATH, { sessionId }, signal));
}
async function resolveTopic(sessionId, topicId, signal) {
  return parseResolve(await postPanelJson(RESOLVE_PATH, { sessionId, topicId }, signal));
}
async function reopenTopic(sessionId, topicId, signal) {
  return parseReopen(await postPanelJson(REOPEN_PATH, { sessionId, topicId }, signal));
}
async function loadInbox(sessionId, topicId, signal) {
  const params = { sessionId };
  if (topicId !== void 0 && topicId !== null && topicId.trim() !== "") params.topicId = topicId;
  return parseInboxResponse(await fetchPanelJson(INBOX_PATH, params, signal));
}
async function resolveInboxRequest(payload, signal) {
  const comment = payload.comment === void 0 ? null : payload.comment.trim();
  const body = {
    sessionId: payload.sessionId,
    requestId: payload.requestId,
    action: payload.action
  };
  if (comment !== null && comment !== "") body.comment = comment;
  if (payload.answers !== void 0 && payload.answers.length > 0) body.answers = payload.answers;
  return parseInboxResolveResponse(await postPanelJson(INBOX_RESOLVE_PATH, body, signal));
}
async function openInboxTarget(payload, signal) {
  const requestId = payload.requestId === void 0 ? null : payload.requestId.trim();
  const noticeId = payload.noticeId === void 0 ? null : payload.noticeId.trim();
  if ((requestId === null || requestId === "") && (noticeId === null || noticeId === "")) {
    throw new PanelApiError("inbox/path-missing", "打开目标缺少 requestId 或 noticeId");
  }
  const body = { sessionId: payload.sessionId };
  if (requestId !== null && requestId !== "") body.requestId = requestId;
  if (noticeId !== null && noticeId !== "") body.noticeId = noticeId;
  return parseInboxOpenResponse(await postPanelJson(INBOX_OPEN_PATH, body, signal));
}

// src/client/model.ts
var CLOCK_TICK_MS = 6e4;
var PROJECT_PATH_MAX_CHARS = 44;
var TOPIC_ID_MAX_CHARS = 8;
var FEEDBACK_TTL_MS = 5e3;
var TOPIC_GROUP_ORDER = ["blocked", "running", "idle", "resolved"];
var TOPIC_GROUP_LABELS = {
  blocked: "阻塞",
  running: "运行中",
  idle: "空闲",
  resolved: "已解决"
};
function topicGroupLabel(key) {
  return TOPIC_GROUP_LABELS[key] ?? key;
}
var TOPIC_MARKER_LABELS = {
  authorization: "待授权",
  "waiting-master": "等待主会话"
};
function topicMarkerLabel(marker) {
  return TOPIC_MARKER_LABELS[marker] ?? String(marker);
}
function groupOf(topic) {
  if (topic.status === "resolved") return "resolved";
  if (topic.blocked === true || topic.awaitingAuthorization === true) return "blocked";
  if (topic.status === "idle") return "idle";
  return "running";
}
function markerOf(topic) {
  if (topic.status === "resolved") return null;
  if (topic.awaitingAuthorization === true) return "authorization";
  if (topic.blocked !== true) return null;
  const reason = topic.blockedReason;
  if (typeof reason !== "string" || reason.trim() === "") return null;
  return reason === "authorization" ? null : "waiting-master";
}
function cardOf(topic) {
  const resolved = topic.status === "resolved";
  return {
    topicId: topic.topicId,
    title: topic.title,
    digest: topic.digest,
    updatedAt: topic.updatedAt,
    marker: markerOf(topic),
    canArchive: !resolved,
    canRestore: resolved
  };
}
function compareCards(left, right) {
  const leftMs = Date.parse(left.updatedAt);
  const rightMs = Date.parse(right.updatedAt);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return rightMs - leftMs;
  }
  return left.topicId.localeCompare(right.topicId);
}
function buildTopicViewModel(overview) {
  const buckets = {
    blocked: [],
    running: [],
    idle: [],
    resolved: []
  };
  for (const topic of overview.topics) {
    buckets[groupOf(topic)].push(cardOf(topic));
  }
  const groups = TOPIC_GROUP_ORDER.map((key) => {
    const cards = buckets[key].sort(compareCards);
    return {
      key,
      label: topicGroupLabel(key),
      count: cards.length,
      cards,
      collapsedByDefault: key === "resolved"
    };
  });
  const blocked = buckets.blocked;
  const authorizationCards = blocked.filter((card) => card.marker === "authorization");
  return {
    groups,
    needsYou: {
      count: authorizationCards.length,
      topicId: authorizationCards[0]?.topicId ?? null
    },
    total: overview.topics.length
  };
}
function surfaceState(input) {
  if (input.loading) return "loading";
  if (input.error !== null) return input.error.code === "project/not-initialized" ? "empty" : "error";
  return input.topicCount === 0 ? "empty" : "default";
}
function middleEllipsis(text2, maxChars) {
  const budget = Math.max(3, Math.floor(maxChars));
  if (text2.length <= budget) return text2;
  const head = Math.ceil((budget - 1) / 2);
  const tail = budget - 1 - head;
  if (tail <= 0) return `${text2.slice(0, budget - 1)}…`;
  return `${text2.slice(0, head)}…${text2.slice(-tail)}`;
}
function shortTopicId(topicId) {
  return topicId.length <= TOPIC_ID_MAX_CHARS ? topicId : topicId.slice(0, TOPIC_ID_MAX_CHARS);
}
function emptyNotice() {
  return {
    kind: "empty",
    title: "这个项目还没有主题",
    detail: "",
    code: null,
    path: null,
    retry: false,
    hint: null
  };
}
function errorPresentation(error) {
  if (error === null) {
    return {
      kind: "error",
      title: "读取 Cowork 项目失败",
      detail: "没有拿到错误详情，请重试。",
      code: null,
      path: null,
      retry: true,
      hint: null
    };
  }
  if (error.code === "project/not-initialized") {
    return {
      kind: "empty",
      title: "这个仓库还没有 Cowork 项目",
      detail: "在 cowork-master 会话中调用 cowork_project_init 初始化当前仓库，然后刷新面板。",
      code: error.code,
      path: error.path ?? null,
      retry: false,
      hint: "cowork_project_init"
    };
  }
  if (error.code === "topic/not-found") {
    return {
      kind: "empty",
      title: "这个主题不在项目索引里",
      detail: "它可能已被移出或索引已重建；刷新后会重新读取。",
      code: error.code,
      path: error.path ?? null,
      retry: true,
      hint: null
    };
  }
  if (error.code === "store/corrupt") {
    return {
      kind: "error",
      title: "项目记录已损坏",
      detail: error.message,
      code: error.code,
      path: error.path ?? null,
      retry: true,
      hint: null
    };
  }
  if (error.code === "request/not-master") {
    return {
      kind: "error",
      title: "只有主会话可以操作主题",
      detail: "请在 cowork-master 会话中操作，或让主会话代你执行。",
      code: error.code,
      path: error.path ?? null,
      retry: false,
      hint: null
    };
  }
  if (error.code === "request/origin") {
    return {
      kind: "error",
      title: "请求来源不被接受",
      detail: "面板请求必须与宿主同源；请从 Cowork 面板内操作，或刷新后重试。",
      code: error.code,
      path: error.path ?? null,
      retry: false,
      hint: null
    };
  }
  return {
    kind: "error",
    title: "读取 Cowork 项目失败",
    detail: error.message,
    code: error.code,
    path: error.path ?? null,
    retry: true,
    hint: null
  };
}
var NOT_MASTER_MESSAGE = "只有主会话可以操作";
var TOPIC_ACTION_LABELS = {
  archive: "归档",
  restore: "恢复"
};
function topicCardAction(card) {
  return card.canRestore ? "restore" : "archive";
}
function archiveSuccessMessage(title) {
  return `已归档「${title}」，可在已解决中恢复`;
}
function restoreSuccessMessage(title) {
  return `已恢复「${title}」`;
}
function writeFailureMessage(actionLabel, error) {
  if (error !== null && error.code === "request/not-master") return NOT_MASTER_MESSAGE;
  const reason = error === null ? "" : error.message.trim();
  const suffix = reason.length === 0 ? "" : `（${reason}）`;
  return `${actionLabel}失败${suffix}`;
}
function openSessionUnavailableMessage() {
  return "当前宿主没有提供会话导航服务，无法打开主题。";
}
function openSessionMessage(topicId) {
  return `已切换到主题 ${shortTopicId(topicId)}`;
}
function openSessionFailureMessage(reason) {
  const suffix = reason.trim().length === 0 ? "" : `（${reason.trim()}）`;
  return `打开主题失败${suffix}`;
}
function openTopicSteps() {
  return ["unarchive", "open"];
}
function masterBreadcrumbLabel() {
  return "返回 master";
}
function masterBreadcrumbTarget(input) {
  const currentIsTopic = input.topics.some((topic) => topic.topicId === input.currentSessionId);
  if (!currentIsTopic) return null;
  const target = input.masterSessionId.trim();
  return target.length > 0 && target !== input.currentSessionId ? target : null;
}
function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}
function formatLocalTimestamp(iso) {
  const date = new Date(iso);
  const time = date.getTime();
  if (!Number.isFinite(time)) return "时间未知";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}
function formatRelativeTime(iso, nowMs) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "时间未知";
  const delta = Math.max(0, nowMs - then);
  const minute = 6e4;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "刚刚";
  if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
  if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
  if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`;
  return formatLocalTimestamp(iso);
}
var CARD_MENU_WIDTH = 104;
var CARD_MENU_HEIGHT = 36;
var CARD_MENU_GAP = 4;
var VIEWPORT_MARGIN = 8;
function placeCardMenu(anchor, viewport) {
  const below = anchor.bottom + CARD_MENU_GAP;
  const flipped = below + CARD_MENU_HEIGHT > viewport.height - VIEWPORT_MARGIN;
  const top = flipped ? Math.max(VIEWPORT_MARGIN, anchor.top - CARD_MENU_GAP - CARD_MENU_HEIGHT) : below;
  const rightAligned = anchor.right - CARD_MENU_WIDTH;
  const maxLeft = viewport.width - CARD_MENU_WIDTH - VIEWPORT_MARGIN;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(rightAligned, maxLeft));
  return { top, left, flipped };
}

// src/client/contracts.ts
var import_react = require("react");
var COWORK_TAB_ID = "@dsh-external/dsh-cowork/panel";
var COWORK_TAB_KIND = "cowork";
var COWORK_TAB_TITLE = "Cowork";
var currentServices = {};
var listeners = /* @__PURE__ */ new Set();
function setClientService(name, service) {
  if (currentServices[name] === service) return;
  currentServices = { ...currentServices, [name]: service };
  for (const listener of listeners) listener();
}
function getClientServices() {
  return currentServices;
}
function subscribeClientServices(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function useClientServices() {
  return (0, import_react.useSyncExternalStore)(subscribeClientServices, getClientServices, getClientServices);
}

// src/client/list.tsx
var import_react2 = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
function TopicStates({ state, notice, onRefresh }) {
  if (state === "default") return null;
  if (state === "loading") {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cw-skeleton", role: "status", "aria-busy": "true", "aria-label": "正在读取 Cowork 项目", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "cw-skeleton-label", children: "正在读取 Cowork 项目…" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cw-skeleton-bar" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cw-skeleton-bar" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cw-skeleton-bar" })
    ] });
  }
  if (state === "empty") {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cw-notice", "data-notice": notice.code ?? "no-topics", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "cw-notice-title", children: notice.title }),
      notice.detail.trim() === "" ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "cw-notice-detail", children: notice.detail }),
      notice.hint === null ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { className: "cw-notice-hint", children: notice.hint }),
      notice.retry ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "cw-button", onClick: onRefresh, children: "刷新" }) : null
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cw-notice", role: "alert", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "cw-notice-title", children: notice.title }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "cw-notice-detail", children: notice.detail }),
    notice.code === null ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "cw-notice-code", children: [
      "错误码 ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { className: "cw-code", children: notice.code })
    ] }),
    notice.path === null ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "cw-notice-path", children: [
      "路径 ",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { className: "cw-filepath", children: notice.path })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "cw-button", onClick: onRefresh, children: "重试" })
  ] });
}
function TopicList({
  groups,
  nowMs,
  pendingTopicIds,
  revealTopicId,
  revealNonce,
  onOpenTopic,
  onArchive,
  onRestore,
  selectedFilterTopicId,
  onToggleFilter
}) {
  const [resolvedOpen, setResolvedOpen] = (0, import_react2.useState)(false);
  const resolvedToggleRef = (0, import_react2.useRef)(null);
  (0, import_react2.useEffect)(() => {
    if (revealTopicId === null) return;
    setResolvedOpen(true);
    resolvedToggleRef.current?.focus();
  }, [revealTopicId, revealNonce]);
  const visible = groups.filter((group) => group.count > 0);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cw-list", "aria-label": "Cowork 主题列表", children: visible.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    TopicGroup,
    {
      group,
      nowMs,
      collapsed: group.key === "resolved" && !resolvedOpen,
      toggleRef: group.key === "resolved" ? resolvedToggleRef : null,
      pendingTopicIds,
      onToggle: () => {
        setResolvedOpen((open) => !open);
      },
      onOpenTopic,
      onArchive,
      onRestore,
      selectedFilterTopicId,
      onToggleFilter
    },
    group.key
  )) });
}
function TopicGroup({
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
  onToggleFilter
}) {
  const headingId = (0, import_react2.useId)();
  const cardsId = (0, import_react2.useId)();
  const collapsible = group.key === "resolved";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "cw-group", "data-group": group.key, "aria-labelledby": headingId, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "cw-group-head", id: headingId, children: collapsible ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        ref: toggleRef,
        type: "button",
        className: "cw-group-toggle",
        "aria-expanded": !collapsed,
        "aria-controls": cardsId,
        onClick: onToggle,
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "cw-group-label", children: group.label }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "cw-group-count", children: group.count })
        ]
      }
    ) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "cw-group-title", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "cw-group-label", children: group.label }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "cw-group-count", children: group.count })
    ] }) }),
    collapsed ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cw-group-cards", id: cardsId, children: group.cards.map((card) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      TopicCard,
      {
        card,
        group: group.key,
        nowMs,
        pending: pendingTopicIds.has(card.topicId),
        filterActive: selectedFilterTopicId === card.topicId,
        onOpenTopic,
        onArchive,
        onRestore,
        onToggleFilter
      },
      card.topicId
    )) })
  ] });
}
function TopicCard({
  card,
  group,
  nowMs,
  pending,
  filterActive,
  onOpenTopic,
  onArchive,
  onRestore,
  onToggleFilter
}) {
  const [menuOpen, setMenuOpen] = (0, import_react2.useState)(false);
  const [placement, setPlacement] = (0, import_react2.useState)(null);
  const moreRef = (0, import_react2.useRef)(null);
  const menuRef = (0, import_react2.useRef)(null);
  const menuId = (0, import_react2.useId)();
  const action = topicCardAction(card);
  const place = (0, import_react2.useCallback)(() => {
    const node = moreRef.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    setPlacement(placeCardMenu(
      { top: rect.top, bottom: rect.bottom, right: rect.right },
      { width: window.innerWidth, height: window.innerHeight }
    ));
  }, []);
  const closeMenu = (0, import_react2.useCallback)((restoreFocus) => {
    setMenuOpen(false);
    setPlacement(null);
    if (restoreFocus) moreRef.current?.focus();
  }, []);
  const openMenu = () => {
    if (pending) return;
    place();
    setMenuOpen(true);
  };
  (0, import_react2.useEffect)(() => {
    if (!menuOpen) return;
    const onPointerDown = (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) === true) return;
      if (moreRef.current?.contains(target) === true) return;
      closeMenu(false);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    const onViewportChange = () => {
      place();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [menuOpen, closeMenu, place]);
  (0, import_react2.useEffect)(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector('[role="menuitem"]')?.focus();
  }, [menuOpen]);
  const runAction = () => {
    if (pending) return;
    closeMenu(false);
    if (action === "archive") onArchive(card.topicId, card.title);
    else onRestore(card.topicId, card.title);
  };
  const onMenuKeyDown = (event) => {
    if (event.key === "Tab") {
      closeMenu(false);
      return;
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll('[role="menuitem"]:not([disabled])')
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(current + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(current - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };
  const title = card.title.trim().length === 0 ? "（无标题）" : card.title;
  const digest = card.digest.trim().length === 0 ? "（无摘要）" : card.digest;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "article",
    {
      className: "cw-card",
      "data-group": group,
      "data-topic-id": card.topicId,
      "data-marker": card.marker ?? "none",
      "data-pending": pending ? "true" : "false",
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "button",
          {
            type: "button",
            className: "cw-card-open",
            title,
            onClick: () => {
              onOpenTopic(card.topicId);
            },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "cw-card-line", children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "cw-card-title", children: title }),
                card.marker === null ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "cw-card-marker", "data-marker": card.marker, children: topicMarkerLabel(card.marker) })
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "cw-card-line", children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "cw-card-digest", children: digest }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "cw-card-time", title: formatLocalTimestamp(card.updatedAt), children: formatRelativeTime(card.updatedAt, nowMs) })
              ] })
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            className: "cw-card-filter",
            "data-testid": "cw-topic-filter",
            "data-topic-id": card.topicId,
            "data-active": filterActive ? "true" : "false",
            "aria-pressed": filterActive,
            title: "只看此主题的收件箱请求",
            "aria-label": `只看主题「${title}」的收件箱请求`,
            onClick: () => {
              onToggleFilter(card.topicId);
            },
            children: "筛选"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            ref: moreRef,
            type: "button",
            className: "cw-card-more",
            "aria-haspopup": "menu",
            "aria-expanded": menuOpen,
            "aria-controls": menuOpen ? menuId : void 0,
            "aria-label": `主题「${title}」的更多操作`,
            disabled: pending,
            onClick: openMenu,
            children: "⋯"
          }
        ),
        menuOpen && placement !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "div",
          {
            ref: menuRef,
            id: menuId,
            className: "cw-card-menu",
            role: "menu",
            "aria-label": "主题操作",
            "data-flipped": placement.flipped ? "true" : "false",
            style: { top: placement.top, left: placement.left },
            onKeyDown: onMenuKeyDown,
            children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                role: "menuitem",
                className: "cw-card-menu-item",
                "data-action": action,
                disabled: pending,
                onClick: runAction,
                children: pending ? "处理中…" : TOPIC_ACTION_LABELS[action]
              }
            )
          }
        ) : null
      ]
    }
  );
}

// src/client/inbox.tsx
var import_react3 = require("react");

// src/client/inbox-model.ts
var WIDE_PANEL_MIN_PX = 620;
var INBOX_TITLE = "收件箱";
var INBOX_ALL_TOPICS_LABEL = "全部类型";
var INBOX_ARCHIVED_TOPIC_LABEL = "已归档主题";
var INBOX_EMPTY_LABEL = "收件箱为空";
var INBOX_LOADING_LABEL = "正在读取收件箱…";
function inboxNeedsYouTitle(count2) {
  return `需要你处理 ${count2} 项`;
}
var NEEDS_YOU_DETAIL_LABELS = {
  authorization: "待授权",
  review: "待审核",
  question: "待回答",
  plan: "待确认"
};
var NEEDS_YOU_DETAIL_ORDER = ["authorization", "review", "question", "plan"];
var REQUEST_ACTION_LABELS = {
  pass: "通过",
  return: "退回",
  allow: "允许一次",
  deny: "拒绝",
  submit: "提交",
  skip: "跳过",
  approve: "同意执行",
  revise: "要求修改"
};
var INBOX_NOTE_LABELS = {
  assignment: "分配",
  report: "上报",
  proposal: "提案",
  "review-verdict": "自动评审",
  archive: "归档"
};
function textOf(value) {
  return typeof value === "string" ? value : "";
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function unansweredQuestionCount(questions, answers) {
  let missing = 0;
  for (const question of questions) {
    if (!answerCoversQuestion(question, answers[question.id])) missing += 1;
  }
  return missing;
}
function answersComplete(questions, answers) {
  return questions.length > 0 && unansweredQuestionCount(questions, answers) === 0;
}
function unansweredAnswerHint(count2) {
  return count2 === 1 ? "还有 1 题未回答" : `还有 ${count2} 题未回答`;
}
function shouldShowUnansweredHint(actionCount, pending, unanswered) {
  return actionCount > 0 && !pending && unanswered > 0;
}
var INBOX_FILTER_STORAGE_PREFIX = "cw.inbox.filter.";
function inboxFilterStorageKey(sessionId) {
  return `${INBOX_FILTER_STORAGE_PREFIX}${sessionId}`;
}
function readStoredFilter(storage, sessionId) {
  if (storage === null || storage === void 0) return null;
  try {
    const raw = storage.getItem(inboxFilterStorageKey(sessionId));
    if (typeof raw !== "string" || raw.trim() === "") return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" && parsed.trim() !== "" ? parsed : null;
  } catch {
    return null;
  }
}
function writeStoredFilter(storage, sessionId, topicId) {
  if (storage === null || storage === void 0) return;
  try {
    storage.setItem(inboxFilterStorageKey(sessionId), JSON.stringify(topicId));
  } catch {
  }
}
function clearStoredFilter(storage, sessionId) {
  if (storage === null || storage === void 0) return;
  try {
    storage.removeItem(inboxFilterStorageKey(sessionId));
  } catch {
  }
}
function availableActions(item) {
  if (item.status !== "pending") return [];
  const legal = REQUEST_ACTIONS_BY_KIND[item.requestKind];
  const offered = Array.isArray(item.actions) ? item.actions.filter((action) => isRequestAction(action) && legal.includes(action)) : [];
  return offered.length === 0 ? legal : legal.filter((action) => offered.includes(action));
}
function statusTextOf(item) {
  if (item.status === "pending") return REQUEST_PENDING_LABELS[item.requestKind];
  return REQUEST_STATUS_LABELS[item.status];
}
function requestViewOf(item, nowMs) {
  const resolutionMessage = nonEmpty(item.resolutionMessage);
  const base = {
    kind: "request",
    requestId: item.requestId,
    topicId: item.topicId,
    topicTitle: nonEmpty(item.topicTitle) ?? INBOX_ARCHIVED_TOPIC_LABEL,
    status: item.status,
    pending: item.status === "pending",
    statusText: statusTextOf(item),
    title: textOf(item.title),
    summary: textOf(item.summary),
    requestMessage: textOf(item.requestMessage),
    resolutionMessage,
    showsResolution: resolutionMessage !== null,
    actions: availableActions(item),
    createdAt: textOf(item.createdAt),
    updatedAt: textOf(item.updatedAt),
    timeLabel: formatRelativeTime(item.updatedAt, nowMs)
  };
  switch (item.requestKind) {
    case "user-review":
      return { ...base, requestKind: "user-review", payload: item.payload };
    case "authorization":
      return { ...base, requestKind: "authorization", payload: item.payload };
    case "question":
      return { ...base, requestKind: "question", payload: item.payload };
    case "plan":
      return { ...base, requestKind: "plan", payload: item.payload };
  }
}
function noteViewOf(item, nowMs) {
  const proposalPath = nonEmpty(item.proposalPath);
  const canOpen = item.noticeKind !== "review-verdict" && item.canOpen === true;
  return {
    kind: "notification",
    noticeId: item.noticeId,
    noticeKind: item.noticeKind,
    topicId: textOf(item.topicId),
    topicTitle: nonEmpty(item.topicTitle) ?? INBOX_ARCHIVED_TOPIC_LABEL,
    summary: textOf(item.summary),
    noteLabel: INBOX_NOTE_LABELS[item.noticeKind] ?? item.noticeKind,
    proposalPath,
    canOpen,
    createdAt: textOf(item.createdAt),
    updatedAt: textOf(item.updatedAt),
    timeLabel: formatRelativeTime(item.updatedAt, nowMs)
  };
}
function viewIdOf(item) {
  return item.kind === "request" ? `request:${item.requestId}` : `notification:${item.noticeId}`;
}
function timestampOf(item) {
  const parsed = Date.parse(item.updatedAt);
  return Number.isFinite(parsed) ? parsed : null;
}
function compareItems(left, right) {
  const leftPending = left.kind === "request" && left.pending;
  const rightPending = right.kind === "request" && right.pending;
  if (leftPending !== rightPending) return leftPending ? -1 : 1;
  const leftTime = timestampOf(left);
  const rightTime = timestampOf(right);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return rightTime - leftTime;
  if (leftTime !== null && rightTime === null) return -1;
  if (leftTime === null && rightTime !== null) return 1;
  return viewIdOf(left).localeCompare(viewIdOf(right));
}
function needsYouDetailOf(counts) {
  return NEEDS_YOU_DETAIL_ORDER.filter((field) => counts[field] > 0).map((field) => `${NEEDS_YOU_DETAIL_LABELS[field]} ${counts[field]}`).join(" · ");
}
function filterTitleOf(selectedTopicId, topics, items) {
  const known = topics.find((topic) => topic.topicId === selectedTopicId);
  const fromTopic = known === void 0 ? null : nonEmpty(known.title);
  if (fromTopic !== null) return fromTopic;
  const fromRow = items.find((item) => item.topicId === selectedTopicId);
  const rowTitle = fromRow === void 0 ? null : nonEmpty(fromRow.topicTitle);
  return rowTitle ?? INBOX_ARCHIVED_TOPIC_LABEL;
}
function buildInboxViewModel(input) {
  const nowMs = input.nowMs ?? Date.now();
  const selectedTopicId = input.selectedTopicId ?? null;
  const allItems = input.inbox.items.map((item) => item.kind === "request" ? requestViewOf(item, nowMs) : noteViewOf(item, nowMs)).sort(compareItems);
  const items = selectedTopicId === null ? allItems : allItems.filter((item) => item.topicId === selectedTopicId);
  const topics = input.topics ?? [];
  return {
    items,
    counts: input.inbox.counts,
    selectedTopicId,
    filterTopicTitle: selectedTopicId === null ? null : filterTitleOf(selectedTopicId, topics, items),
    titleCount: items.length,
    totalCount: allItems.length,
    needsYou: {
      count: input.inbox.counts.pending,
      detail: needsYouDetailOf(input.inbox.counts)
    },
    empty: items.length === 0,
    truncated: input.inbox.truncated === true
  };
}
function countResolvedRequest(counts, kind) {
  const field = REQUEST_COUNT_FIELD[kind];
  return {
    pending: Math.max(0, counts.pending - 1),
    review: field === "review" ? Math.max(0, counts.review - 1) : counts.review,
    authorization: field === "authorization" ? Math.max(0, counts.authorization - 1) : counts.authorization,
    question: field === "question" ? Math.max(0, counts.question - 1) : counts.question,
    plan: field === "plan" ? Math.max(0, counts.plan - 1) : counts.plan
  };
}
function applyInboxItemUpdate(snapshot, next) {
  const previous = snapshot.items.find(
    (item) => item.kind === "request" && item.requestId === next.requestId
  );
  const items = snapshot.items.map(
    (item) => item.kind === "request" && item.requestId === next.requestId ? next : item
  );
  const counts = previous !== void 0 && previous.status === "pending" && next.status !== "pending" ? countResolvedRequest(snapshot.counts, previous.requestKind) : snapshot.counts;
  return { items, counts };
}

// src/client/inbox.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
function InboxPanel({
  view,
  phase,
  error,
  pendingRequestIds,
  receipts,
  onResolve,
  onOpen,
  onClearFilter,
  onRetry
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "cw-inbox", "data-testid": "cw-inbox", "aria-label": "收件箱", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("header", { className: "cw-inbox-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "cw-inbox-heading", children: [
        INBOX_TITLE,
        " · ",
        view?.filterTopicTitle ?? INBOX_ALL_TOPICS_LABEL,
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-inbox-count", "data-testid": "cw-inbox-title-count", children: view === null ? 0 : view.titleCount })
      ] }),
      view !== null && view.filterTopicTitle !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
        "button",
        {
          type: "button",
          className: "cw-inbox-filter-clear",
          "data-testid": "cw-inbox-filter-clear",
          onClick: onClearFilter,
          title: "清除主题筛选",
          "aria-label": "清除主题筛选",
          children: [
            "只看「",
            view.filterTopicTitle,
            "」×"
          ]
        }
      ) : null,
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-inbox-hint", children: "按时间从新到旧" })
    ] }),
    error === null ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-inbox-error", "data-testid": "cw-inbox-error", role: "status", "aria-live": "polite", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("p", { className: "cw-inbox-error-text", children: [
        "读取收件箱失败：",
        error.message
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", className: "cw-button", onClick: onRetry, children: "重试" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-inbox-list", children: [
      view === null && phase === "loading" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "cw-inbox-loading", role: "status", children: INBOX_LOADING_LABEL }) : null,
      view !== null && view.items.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "cw-inbox-empty", "data-testid": "cw-inbox-empty", children: INBOX_EMPTY_LABEL }) : null,
      view === null ? null : view.items.map((item) => item.kind === "request" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        RequestThread,
        {
          item,
          pending: pendingRequestIds.has(item.requestId),
          receipt: receipts.get(item.requestId) ?? null,
          onResolve,
          onOpen
        },
        `request:${item.requestId}`
      ) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        InboxNote,
        {
          item,
          pending: pendingRequestIds.has(item.noticeId),
          receipt: receipts.get(item.noticeId) ?? null,
          onOpen
        },
        `notification:${item.noticeId}`
      )),
      view !== null && view.truncated ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "cw-inbox-truncated", children: "只显示最近的收件箱记录，更早的已折叠。" }) : null
    ] })
  ] });
}
function RequestThread({
  item,
  pending,
  receipt,
  onResolve,
  onOpen
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
    "article",
    {
      className: "cw-thread",
      "data-testid": "cw-inbox-item",
      "data-item-kind": "request",
      "data-request-id": item.requestId,
      "data-request-kind": item.requestKind,
      "data-status": item.status,
      "data-pending": item.pending ? "true" : "false",
      "data-topic-id": item.topicId,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-thread-msg cw-thread-msg-in", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-thread-avatar", "aria-hidden": "true", children: "题" }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "cw-thread-bubble", "data-testid": "cw-inbox-request-message", children: item.requestMessage })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
          "div",
          {
            className: "cw-req-card",
            "data-testid": "cw-inbox-request-card",
            "data-request-kind": item.requestKind,
            "data-status": item.status,
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                RequestCard,
                {
                  item,
                  pending,
                  onResolve,
                  onOpen
                }
              ),
              receipt === null ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "p",
                {
                  className: "cw-inbox-receipt",
                  "data-testid": "cw-inbox-receipt",
                  "data-kind": receipt.kind,
                  role: "status",
                  "aria-live": "polite",
                  children: receipt.text
                }
              )
            ]
          }
        ),
        item.showsResolution ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-thread-msg cw-thread-msg-out", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "cw-thread-bubble", "data-testid": "cw-inbox-resolution", children: item.resolutionMessage }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-thread-avatar cw-thread-avatar-user", "aria-hidden": "true", children: "你" })
        ] }) : null
      ]
    }
  );
}
function RequestCard({ item, pending, onResolve, onOpen }) {
  switch (item.requestKind) {
    case "user-review":
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(UserReviewCard, { item, pending, onResolve });
    case "authorization":
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AuthorizationCard, { item, pending, onResolve });
    case "question":
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(QuestionCard, { item, pending, onResolve });
    case "plan":
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(PlanCard, { item, pending, onResolve, onOpen });
  }
}
function CardHead({ statusText, tone, children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-req-head", "data-tone": tone, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-req-status", children: statusText }),
    children
  ] });
}
function ActionButtons({ actions, pending, isDisabled, onAction }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "cw-req-actions", children: actions.map((action) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    "button",
    {
      type: "button",
      className: "cw-req-action",
      "data-testid": "cw-inbox-action",
      "data-action": action,
      disabled: pending || (isDisabled?.(action) ?? false),
      onClick: () => {
        onAction(action);
      },
      children: REQUEST_ACTION_LABELS[action]
    },
    action
  )) });
}
function UserReviewCard({ item, pending, onResolve }) {
  const [comment, setComment] = (0, import_react3.useState)("");
  const commentId = (0, import_react3.useId)();
  const changedPaths = item.payload.changedPaths ?? [];
  const verification = item.payload.verification ?? [];
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CardHead, { statusText: item.statusText, tone: item.pending ? "warn" : "done" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-req-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "cw-req-text", children: item.payload.purpose }),
      changedPaths.length === 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-req-section", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "cw-req-label", children: [
          "改动文件（",
          changedPaths.length,
          "）"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: "cw-req-paths", children: changedPaths.map((path) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: path }) }, path)) })
      ] }),
      verification.length === 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-req-section", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-req-label", children: "验证" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: "cw-req-verify", children: verification.map((row) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { children: row.command }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "cw-req-exit", "data-exit": row.exitCode === 0 ? "ok" : "failed", children: [
            "exit ",
            row.exitCode
          ] }),
          row.evidence.trim() === "" ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-req-evidence", children: row.evidence })
        ] }, `${row.command}:${row.exitCode}`)) })
      ] })
    ] }),
    item.actions.length === 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-req-actions-block", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "cw-req-field", htmlFor: commentId, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-req-label", children: "退回评论（可选）" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "textarea",
          {
            id: commentId,
            className: "cw-req-input",
            "data-testid": "cw-inbox-comment",
            rows: 2,
            value: comment,
            disabled: pending,
            onChange: (event) => {
              setComment(event.target.value);
            }
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        ActionButtons,
        {
          actions: item.actions,
          pending,
          onAction: (action) => {
            onResolve(item, action, comment.trim() === "" ? {} : { comment });
          }
        }
      )
    ] })
  ] });
}
function AuthorizationCard({ item, pending, onResolve }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CardHead, { statusText: item.statusText, tone: item.pending ? "warn" : "done" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-req-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "cw-req-text", children: item.payload.summary }),
      item.payload.command === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("code", { className: "cw-req-command", children: item.payload.command })
    ] }),
    item.actions.length === 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      ActionButtons,
      {
        actions: item.actions,
        pending,
        onAction: (action) => {
          onResolve(item, action, {});
        }
      }
    )
  ] });
}
function QuestionCard({ item, pending, onResolve }) {
  const [page, setPage] = (0, import_react3.useState)(0);
  const [answers, setAnswers] = (0, import_react3.useState)({});
  const answerId = (0, import_react3.useId)();
  const questions = item.payload.questions;
  const index = questions.length === 0 ? 0 : Math.min(page, questions.length - 1);
  const current = questions[index];
  const answerOf = (questionId) => answers[questionId] ?? { selected: [], text: "" };
  const updateAnswer = (questionId, patch) => {
    setAnswers((previous) => {
      const base = previous[questionId] ?? { selected: [], text: "" };
      return { ...previous, [questionId]: { ...base, ...patch } };
    });
  };
  const unanswered = unansweredQuestionCount(questions, answers);
  const allAnswered = answersComplete(questions, answers);
  const submit = () => {
    const payload = [];
    for (const question of questions) {
      const answer = answers[question.id];
      if (answer === void 0) continue;
      const text2 = answer.text.trim();
      if (answer.selected.length === 0 && text2 === "") continue;
      payload.push({
        questionId: question.id,
        ...answer.selected.length === 0 ? {} : { selected: answer.selected },
        ...text2 === "" ? {} : { text: text2 }
      });
    }
    onResolve(item, "submit", { answers: payload });
  };
  const groupName = `cw-answer-${item.requestId}`;
  const selected = current === void 0 ? [] : answerOf(current.id).selected;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CardHead, { statusText: item.statusText, tone: item.pending ? "warn" : "neutral" }),
    current === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "cw-req-body", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "cw-req-text", children: "这个问题没有题目内容。" }) }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-req-body", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "cw-req-question", children: current.prompt }),
      current.options === void 0 || current.options.length === 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: current.mode === "multi" ? "cw-inbox-options cw-inbox-options-multi" : "cw-inbox-options", children: current.options.map((option) => {
        const checked = selected.includes(option.id);
        const toggle = () => {
          if (pending) return;
          if (current.mode === "multi") {
            const next = checked ? selected.filter((id) => id !== option.id) : [...selected, option.id];
            updateAnswer(current.id, { selected: next });
          } else {
            updateAnswer(current.id, { selected: [option.id] });
          }
        };
        return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
          "label",
          {
            className: "cw-inbox-option",
            "data-testid": "cw-inbox-option",
            "data-option-id": option.id,
            "data-selected": checked ? "true" : "false",
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
                "input",
                {
                  type: current.mode === "multi" ? "checkbox" : "radio",
                  name: current.mode === "multi" ? void 0 : groupName,
                  checked,
                  disabled: pending,
                  onChange: toggle
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "cw-inbox-option-body", children: [
                /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-inbox-option-label", children: option.label }),
                option.recommended === true ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-inbox-option-tag", children: "推荐" }) : null,
                option.description === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-inbox-option-desc", children: option.description })
              ] })
            ]
          },
          option.id
        );
      }) }),
      current.allowText === true ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "cw-req-field", htmlFor: answerId, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-req-label", children: "输入你的答案" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "input",
          {
            id: answerId,
            type: "text",
            className: "cw-req-input",
            "data-testid": "cw-inbox-answer",
            value: answerOf(current.id).text,
            disabled: pending,
            onChange: (event) => {
              updateAnswer(current.id, { text: event.target.value });
            }
          }
        )
      ] }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-inbox-pager", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            className: "cw-inbox-pager-button",
            "aria-label": "上一题",
            disabled: index === 0 || pending,
            onClick: () => {
              setPage(Math.max(0, index - 1));
            },
            children: "‹"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "cw-inbox-pager-label", children: [
          questions.length === 0 ? 0 : index + 1,
          "/",
          questions.length
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            className: "cw-inbox-pager-button",
            "aria-label": "下一题",
            disabled: index >= questions.length - 1 || pending,
            onClick: () => {
              setPage(Math.min(questions.length - 1, index + 1));
            },
            children: "›"
          }
        )
      ] })
    ] }),
    shouldShowUnansweredHint(item.actions.length, pending, unanswered) ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "p",
      {
        className: "cw-inbox-hint",
        "data-testid": "cw-inbox-answer-hint",
        role: "status",
        "aria-live": "polite",
        children: unansweredAnswerHint(unanswered)
      }
    ) : null,
    item.actions.length === 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      ActionButtons,
      {
        actions: item.actions,
        pending,
        isDisabled: (action) => action === "submit" && !allAnswered,
        onAction: (action) => {
          if (action === "submit") submit();
          else onResolve(item, action, {});
        }
      }
    )
  ] });
}
function PlanCard({ item, pending, onResolve, onOpen }) {
  const [revising, setRevising] = (0, import_react3.useState)(false);
  const [comment, setComment] = (0, import_react3.useState)("");
  const commentId = (0, import_react3.useId)();
  const canOpen = item.payload.planPath.trim() !== "";
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CardHead, { statusText: item.statusText, tone: item.pending ? "warn" : "done", children: canOpen ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "button",
      {
        type: "button",
        className: "cw-req-open",
        "data-testid": "cw-inbox-open",
        onClick: () => {
          onOpen(item);
        },
        children: "查看全文 ›"
      }
    ) : null }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-req-body", children: [
      item.payload.planTitle === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "cw-req-plan-title", children: item.payload.planTitle }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "cw-req-text", children: item.summary })
    ] }),
    revising && item.pending ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-req-revise", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("label", { className: "cw-req-field", htmlFor: commentId, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-req-label", children: "修改要求" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "input",
          {
            id: commentId,
            type: "text",
            className: "cw-req-input",
            "data-testid": "cw-inbox-comment",
            value: comment,
            disabled: pending,
            onChange: (event) => {
              setComment(event.target.value);
            }
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-req-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            className: "cw-req-action",
            "data-testid": "cw-inbox-action",
            "data-action": "cancel-revise",
            disabled: pending,
            onClick: () => {
              setRevising(false);
              setComment("");
            },
            children: "取消"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            className: "cw-req-action",
            "data-testid": "cw-inbox-action",
            "data-action": "revise",
            disabled: pending || comment.trim() === "",
            onClick: () => {
              onResolve(item, "revise", { comment });
            },
            children: "提交"
          }
        )
      ] })
    ] }) : item.actions.length === 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      ActionButtons,
      {
        actions: item.actions,
        pending,
        onAction: (action) => {
          if (action === "revise") {
            setRevising(true);
            return;
          }
          onResolve(item, action, {});
        }
      }
    )
  ] });
}
function InboxNote({ item, pending, receipt, onOpen }) {
  const showOpen = item.canOpen && item.proposalPath !== null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
    "div",
    {
      className: "cw-inbox-item-note",
      "data-testid": "cw-inbox-item",
      "data-item-kind": "notification",
      "data-notice-id": item.noticeId,
      "data-topic-id": item.topicId,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "cw-inbox-note", "data-testid": "cw-inbox-note", "data-notice-kind": item.noticeKind, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "cw-inbox-note-label", children: [
            item.noteLabel,
            " · ",
            item.topicTitle
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-inbox-note-summary", children: item.summary }),
          showOpen ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "button",
            {
              type: "button",
              className: "cw-inbox-note-link",
              "data-testid": "cw-inbox-open",
              disabled: pending,
              onClick: () => {
                onOpen(item);
              },
              children: "查看提案"
            }
          ) : null,
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "cw-inbox-note-time", children: item.timeLabel })
        ] }),
        receipt === null ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "p",
          {
            className: "cw-inbox-receipt",
            "data-testid": "cw-inbox-receipt",
            "data-kind": receipt.kind,
            role: "status",
            "aria-live": "polite",
            children: receipt.text
          }
        )
      ]
    }
  );
}

// src/client/panel.tsx
var import_jsx_runtime3 = require("react/jsx-runtime");
function archived(topic) {
  return {
    ...topic,
    status: "resolved",
    blocked: false,
    awaitingAuthorization: false,
    blockedReason: null,
    resolvedAt: (/* @__PURE__ */ new Date()).toISOString(),
    resolvedBy: "user"
  };
}
function restored(topic) {
  return {
    ...topic,
    status: "active",
    blocked: false,
    awaitingAuthorization: false,
    blockedReason: null,
    resolvedAt: null,
    resolvedBy: null
  };
}
function replaceTopic(overview, topicId, next) {
  if (overview === null) return null;
  return {
    ...overview,
    topics: overview.topics.map((topic) => topic.topicId === topicId ? next : topic)
  };
}
function rollbackTopic(overview, topicId, previous) {
  if (overview === null || previous === null) return overview;
  return replaceTopic(overview, topicId, previous);
}
function browserFilterStorage() {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}
function CoworkPanel({ sessionId }) {
  ensurePanelStyles();
  const services = useClientServices();
  const [phase, setPhase] = (0, import_react4.useState)("loading");
  const [overview, setOverview] = (0, import_react4.useState)(null);
  const [error, setError] = (0, import_react4.useState)(null);
  const [refreshToken, setRefreshToken] = (0, import_react4.useState)(0);
  const [feedback, setFeedback] = (0, import_react4.useState)(null);
  const [pendingTopicIds, setPendingTopicIds] = (0, import_react4.useState)(() => /* @__PURE__ */ new Set());
  const [reveal, setReveal] = (0, import_react4.useState)(null);
  const [nowMs, setNowMs] = (0, import_react4.useState)(() => Date.now());
  const [inbox, setInbox] = (0, import_react4.useState)(null);
  const [inboxPhase, setInboxPhase] = (0, import_react4.useState)("loading");
  const [inboxError, setInboxError] = (0, import_react4.useState)(null);
  const [selectedInboxTopicId, setSelectedInboxTopicId] = (0, import_react4.useState)(
    () => readStoredFilter(browserFilterStorage(), sessionId)
  );
  const [inboxFocus, setInboxFocus] = (0, import_react4.useState)(false);
  const [pendingRequestIds, setPendingRequestIds] = (0, import_react4.useState)(() => /* @__PURE__ */ new Set());
  const [inboxReceipts, setInboxReceipts] = (0, import_react4.useState)(() => /* @__PURE__ */ new Map());
  const [widthMode, setWidthMode] = (0, import_react4.useState)("wide");
  const rootRef = (0, import_react4.useRef)(null);
  const feedbackTimer = (0, import_react4.useRef)(null);
  const pendingRef = (0, import_react4.useRef)(/* @__PURE__ */ new Set());
  const pendingRequestRef = (0, import_react4.useRef)(/* @__PURE__ */ new Set());
  const overviewRef = (0, import_react4.useRef)(null);
  const lastSessionId = (0, import_react4.useRef)(sessionId);
  const lastInboxSessionId = (0, import_react4.useRef)(sessionId);
  (0, import_react4.useEffect)(() => {
    overviewRef.current = overview;
  }, [overview]);
  const measureWidth = (0, import_react4.useCallback)(() => {
    const node = rootRef.current;
    if (node === null) return;
    const width = node.getBoundingClientRect().width;
    if (width <= 0) return;
    setWidthMode(width < WIDE_PANEL_MIN_PX ? "narrow" : "wide");
    if (width >= WIDE_PANEL_MIN_PX) setInboxFocus(false);
  }, []);
  (0, import_react4.useEffect)(() => {
    measureWidth();
    if (typeof ResizeObserver === "undefined") return;
    const node = rootRef.current;
    if (node === null) return;
    const observer = new ResizeObserver(() => {
      measureWidth();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [measureWidth]);
  (0, import_react4.useEffect)(() => {
    const controller = new AbortController();
    let active = true;
    if (lastSessionId.current !== sessionId) {
      lastSessionId.current = sessionId;
      setOverview(null);
      setPhase("loading");
    }
    setError(null);
    setPhase((current) => current === "ready" ? "ready" : "loading");
    loadOverview(sessionId, controller.signal).then((result) => {
      if (!active) return;
      setSelectedInboxTopicId((current) => {
        if (current === null) return current;
        if (result.topics.some((topic) => topic.topicId === current)) return current;
        clearStoredFilter(browserFilterStorage(), sessionId);
        return null;
      });
      setOverview(result);
      setPhase("ready");
      setNowMs(Date.now());
    }).catch((reason) => {
      if (!active || controller.signal.aborted) return;
      setOverview(null);
      setError(toPanelError(reason));
      setPhase("error");
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [sessionId, refreshToken]);
  (0, import_react4.useEffect)(() => {
    const controller = new AbortController();
    let active = true;
    if (lastInboxSessionId.current !== sessionId) {
      lastInboxSessionId.current = sessionId;
      setInbox(null);
      setInboxPhase("loading");
      setSelectedInboxTopicId(readStoredFilter(browserFilterStorage(), sessionId));
      setInboxReceipts(/* @__PURE__ */ new Map());
    }
    setInboxError(null);
    setInboxPhase((current) => current === "ready" ? "ready" : "loading");
    loadInbox(sessionId, selectedInboxTopicId, controller.signal).then((result) => {
      if (!active) return;
      setInbox(result);
      setInboxPhase("ready");
    }).catch((reason) => {
      if (!active || controller.signal.aborted) return;
      setInboxError(toPanelError(reason));
      setInboxPhase("error");
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [sessionId, refreshToken, selectedInboxTopicId]);
  (0, import_react4.useEffect)(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, CLOCK_TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  (0, import_react4.useEffect)(() => {
    return () => {
      if (feedbackTimer.current !== null) {
        window.clearTimeout(feedbackTimer.current);
        feedbackTimer.current = null;
      }
    };
  }, []);
  const showFeedback = (0, import_react4.useCallback)((next) => {
    setFeedback(next);
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => {
      feedbackTimer.current = null;
      setFeedback(null);
    }, FEEDBACK_TTL_MS);
  }, []);
  const refresh = (0, import_react4.useCallback)(() => {
    setRefreshToken((token) => token + 1);
  }, []);
  const markPending = (0, import_react4.useCallback)((topicId, pending) => {
    if (pending) pendingRef.current.add(topicId);
    else pendingRef.current.delete(topicId);
    setPendingTopicIds(new Set(pendingRef.current));
  }, []);
  const canOpenSession = services.uiWorkspace !== void 0 && typeof services.uiWorkspace.openSession === "function";
  const openTopic = (0, import_react4.useCallback)(async (topicId) => {
    const workspace = services.uiWorkspace;
    if (workspace === void 0 || typeof workspace.openSession !== "function") {
      showFeedback({ kind: "failed", text: openSessionUnavailableMessage() });
      return;
    }
    const steps = openTopicSteps();
    try {
      if (steps.includes("unarchive") && typeof workspace.unarchiveSession === "function") {
        try {
          await workspace.unarchiveSession(topicId);
        } catch {
        }
      }
      if (steps.includes("open")) workspace.openSession(topicId);
      showFeedback({ kind: "ok", text: openSessionMessage(topicId) });
    } catch (reason) {
      showFeedback({ kind: "failed", text: openSessionFailureMessage(errorMessage(reason)) });
    }
  }, [services.uiWorkspace, showFeedback]);
  const archiveTopic = (0, import_react4.useCallback)(async (topicId, title) => {
    if (pendingRef.current.has(topicId)) return;
    const previous = overviewRef.current?.topics.find((topic) => topic.topicId === topicId) ?? null;
    markPending(topicId, true);
    setOverview((current) => {
      if (current === null) return current;
      const topic = current.topics.find((entry) => entry.topicId === topicId);
      return topic === void 0 ? current : replaceTopic(current, topicId, archived(topic));
    });
    setReveal((current) => ({ topicId, nonce: (current?.nonce ?? 0) + 1 }));
    try {
      const result = await resolveTopic(sessionId, topicId);
      setOverview((current) => replaceTopic(current, topicId, result.topic));
      showFeedback({ kind: "ok", text: archiveSuccessMessage(title) });
    } catch (reason) {
      setOverview((current) => rollbackTopic(current, topicId, previous));
      showFeedback({ kind: "failed", text: writeFailureMessage("归档", toPanelError(reason)) });
    } finally {
      markPending(topicId, false);
    }
  }, [markPending, sessionId, showFeedback]);
  const restoreTopic = (0, import_react4.useCallback)(async (topicId, title) => {
    if (pendingRef.current.has(topicId)) return;
    const previous = overviewRef.current?.topics.find((topic) => topic.topicId === topicId) ?? null;
    markPending(topicId, true);
    setOverview((current) => {
      if (current === null) return current;
      const topic = current.topics.find((entry) => entry.topicId === topicId);
      return topic === void 0 ? current : replaceTopic(current, topicId, restored(topic));
    });
    try {
      const result = await reopenTopic(sessionId, topicId);
      setOverview((current) => replaceTopic(current, topicId, result.topic));
      showFeedback({ kind: "ok", text: restoreSuccessMessage(title) });
    } catch (reason) {
      setOverview((current) => rollbackTopic(current, topicId, previous));
      showFeedback({ kind: "failed", text: writeFailureMessage("恢复", toPanelError(reason)) });
    } finally {
      markPending(topicId, false);
    }
  }, [markPending, sessionId, showFeedback]);
  const putReceipt = (0, import_react4.useCallback)((id, receipt) => {
    setInboxReceipts((previous) => {
      const next = new Map(previous);
      next.set(id, receipt);
      return next;
    });
  }, []);
  const toggleInboxFilter = (0, import_react4.useCallback)((topicId) => {
    setSelectedInboxTopicId((current) => {
      if (current === topicId) {
        clearStoredFilter(browserFilterStorage(), sessionId);
        return null;
      }
      writeStoredFilter(browserFilterStorage(), sessionId, topicId);
      return topicId;
    });
  }, [sessionId]);
  const clearInboxFilter = (0, import_react4.useCallback)(() => {
    clearStoredFilter(browserFilterStorage(), sessionId);
    setSelectedInboxTopicId(null);
  }, [sessionId]);
  const resolveRequest = (0, import_react4.useCallback)(async (item, action, input) => {
    if (pendingRequestRef.current.has(item.requestId)) return;
    if (!item.actions.includes(action) || !actionAllowed(item.requestKind, action)) {
      putReceipt(item.requestId, { kind: "error", text: "这个动作已不可用，请刷新后重试。" });
      return;
    }
    pendingRequestRef.current.add(item.requestId);
    setPendingRequestIds(new Set(pendingRequestRef.current));
    try {
      const result = await resolveInboxRequest({
        sessionId,
        requestId: item.requestId,
        action,
        comment: input.comment,
        answers: input.answers
      });
      setInbox((current) => current === null ? current : { ...current, ...applyInboxItemUpdate(current, result.item) });
      if (result.promptError !== null) {
        putReceipt(item.requestId, {
          kind: "warn",
          text: `已记录，但主题会话未唤醒（${result.promptError}）`
        });
      } else {
        putReceipt(item.requestId, { kind: "ok", text: "已提交" });
      }
      refresh();
    } catch (reason) {
      const info = toPanelError(reason);
      putReceipt(item.requestId, { kind: "error", text: `提交失败：${info.message}` });
    } finally {
      pendingRequestRef.current.delete(item.requestId);
      setPendingRequestIds(new Set(pendingRequestRef.current));
    }
  }, [putReceipt, refresh, sessionId]);
  const openInboxItem = (0, import_react4.useCallback)(async (item) => {
    const id = item.kind === "request" ? item.requestId : item.noticeId;
    if (pendingRequestRef.current.has(id)) return;
    pendingRequestRef.current.add(id);
    setPendingRequestIds(new Set(pendingRequestRef.current));
    try {
      if (item.kind === "request") await openInboxTarget({ sessionId, requestId: item.requestId });
      else await openInboxTarget({ sessionId, noticeId: item.noticeId });
      putReceipt(id, { kind: "ok", text: "已在文件浏览器中打开" });
    } catch (reason) {
      const info = toPanelError(reason);
      putReceipt(id, { kind: "error", text: `打开失败：${info.message}` });
    } finally {
      pendingRequestRef.current.delete(id);
      setPendingRequestIds(new Set(pendingRequestRef.current));
    }
  }, [putReceipt, sessionId]);
  const masterTarget = overview === null ? null : masterBreadcrumbTarget({
    currentSessionId: sessionId,
    masterSessionId: overview.project.masterSessionId,
    topics: overview.topics
  });
  const backToMaster = (0, import_react4.useCallback)(() => {
    if (masterTarget === null) return;
    const workspace = services.uiWorkspace;
    if (workspace === void 0 || typeof workspace.openSession !== "function") {
      showFeedback({ kind: "failed", text: openSessionUnavailableMessage() });
      return;
    }
    try {
      workspace.openSession(masterTarget);
      showFeedback({ kind: "ok", text: "已返回主会话" });
    } catch (reason) {
      showFeedback({ kind: "failed", text: openSessionFailureMessage(errorMessage(reason)) });
    }
  }, [masterTarget, services.uiWorkspace, showFeedback]);
  const view = overview === null ? null : buildTopicViewModel(overview);
  const surface = surfaceState({
    loading: phase === "loading",
    error,
    topicCount: overview?.topics.length ?? 0
  });
  const stateNotice = error === null ? emptyNotice() : errorPresentation(error);
  const inboxView = inbox === null ? null : buildInboxViewModel({
    inbox,
    topics: overview?.topics ?? [],
    selectedTopicId: selectedInboxTopicId,
    nowMs
  });
  const needsYou = inboxView?.needsYou ?? { count: 0, detail: "" };
  const topicStates = /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(TopicStates, { state: surface, notice: stateNotice, onRefresh: refresh });
  const topicList = surface === "default" && view !== null ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
    TopicList,
    {
      groups: view.groups,
      nowMs,
      pendingTopicIds,
      revealTopicId: reveal === null ? null : reveal.topicId,
      revealNonce: reveal === null ? 0 : reveal.nonce,
      onOpenTopic: (topicId) => {
        void openTopic(topicId);
      },
      onArchive: (topicId, title) => {
        void archiveTopic(topicId, title);
      },
      onRestore: (topicId, title) => {
        void restoreTopic(topicId, title);
      },
      selectedFilterTopicId: selectedInboxTopicId,
      onToggleFilter: toggleInboxFilter
    }
  ) : null;
  const inboxPanel = /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
    InboxPanel,
    {
      view: inboxView,
      phase: inboxPhase,
      error: inboxError,
      pendingRequestIds,
      receipts: inboxReceipts,
      onResolve: (item, action, input) => {
        void resolveRequest(item, action, input);
      },
      onOpen: (item) => {
        void openInboxItem(item);
      },
      onClearFilter: clearInboxFilter,
      onRetry: refresh
    }
  );
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "cw-root", "data-surface": surface, "data-width-mode": widthMode, ref: rootRef, children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("header", { className: "cw-header", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        "span",
        {
          className: "cw-project",
          title: overview === null ? void 0 : overview.project.repoPath,
          children: overview === null ? COWORK_TAB_TITLE : middleEllipsis(overview.project.repoPath, PROJECT_PATH_MAX_CHARS)
        }
      ),
      masterTarget === null ? null : /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
        "button",
        {
          type: "button",
          className: "cw-breadcrumb",
          onClick: backToMaster,
          disabled: !canOpenSession,
          title: "返回主会话",
          children: [
            "← ",
            masterBreadcrumbLabel()
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        "button",
        {
          type: "button",
          className: "cw-icon-button",
          onClick: refresh,
          disabled: phase === "loading",
          "aria-label": "刷新 Cowork 项目",
          children: "刷新"
        }
      )
    ] }),
    feedback === null ? null : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "cw-receipt", role: "status", "data-kind": feedback.kind, children: feedback.text }),
    widthMode === "narrow" && inboxFocus ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "cw-inbox-focus", "data-testid": "cw-inbox-focus", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "cw-inbox-focus-bar", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        "button",
        {
          type: "button",
          className: "cw-breadcrumb",
          "data-testid": "cw-inbox-back",
          onClick: () => {
            setInboxFocus(false);
          },
          children: "← 返回主题列表"
        }
      ) }),
      inboxPanel
    ] }) : widthMode === "narrow" ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
        "button",
        {
          type: "button",
          className: "cw-needs-you",
          "data-testid": "cw-needs-you-banner",
          onClick: () => {
            setInboxFocus(true);
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "cw-needs-you-title", children: inboxNeedsYouTitle(needsYou.count) }),
            needsYou.detail === "" ? null : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "cw-needs-you-hint", children: needsYou.detail })
          ]
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "cw-body", children: [
        topicStates,
        topicList
      ] })
    ] }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "cw-body cw-columns", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "cw-topic-column", children: [
        topicStates,
        topicList
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "cw-inbox-column", children: inboxPanel })
    ] })
  ] });
}
function CoworkPanelTitle() {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "cw-tab-title", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(CoworkColorGlyph, { size: 16 }),
    COWORK_TAB_TITLE
  ] });
}
var COWORK_GLYPH_PATHS = [
  "M 245.762 819.2 L 573.441 819.2 C 737.281 819.2 819.199 737.278 819.199 573.438 L 819.199 245.759 C 819.199 81.919 737.281 0.001 573.441 0.001 L 245.762 0.001 C 81.922 0.001 0 81.919 0 245.759 L 0 573.438 C 0 737.278 81.922 819.2 245.762 819.2 Z",
  "M 245.762 532.481 C 245.926 486.204 273.988 444.595 316.828 427.098 C 359.672 409.602 408.836 419.669 441.352 452.598 C 473.867 485.524 483.316 534.813 465.281 577.43 C 447.246 620.048 405.289 647.583 359.016 647.169 C 296.141 646.606 245.531 595.356 245.762 532.481 Z",
  "M 600.68 527.973 C 600.68 589.415 540.262 632.423 474.93 624.231 C 497.914 600.235 509.734 567.677 507.496 534.528 C 507.496 485.579 483.125 457.727 450.355 428.442 C 527.789 388.364 584.312 317.001 605.594 232.446 L 670.719 232.446 L 670.719 256.204 C 670.969 292.751 662.324 328.809 645.531 361.266 C 628.188 396.993 599.336 425.848 563.609 443.188 C 587.617 464.833 601.312 495.649 601.293 527.973 Z",
  "M 571.188 172.032 C 572.805 181.227 573.559 190.552 573.441 199.884 C 573.441 317.063 478.445 412.059 361.266 412.059 C 244.086 412.059 149.094 317.063 149.094 199.884 C 149.027 190.544 149.848 181.216 151.551 172.032"
];
function CoworkGlyph({ size, className = "cw-footer-glyph" }) {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
    "svg",
    {
      className,
      viewBox: "0 0 820 820",
      width: size,
      height: size,
      style: size === void 0 ? void 0 : { width: size, height: size },
      "aria-hidden": "true",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 72,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("g", { transform: "translate(0 820) scale(1 -1)", children: COWORK_GLYPH_PATHS.map((path) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("path", { d: path }, path)) })
    }
  );
}
var COWORK_COLOR_GLYPH_PATHS = [
  { fill: "#1389ff", d: "M 245.762 819.2 L 573.441 819.2 C 737.281 819.2 819.199 737.278 819.199 573.438 L 819.199 245.759 C 819.199 81.919 737.281 0.001 573.441 0.001 L 245.762 0.001 C 81.922 0.001 0 81.919 0 245.759 L 0 573.438 C 0 737.278 81.922 819.2 245.762 819.2 Z" },
  { fill: "#2993ff", d: "M 573.441 646.962 L 245.762 646.962 C 110.031 646.962 0 536.934 0 401.204 L 0 239.821 C 0 375.552 110.031 485.579 245.762 485.579 L 573.441 485.579 C 709.168 485.579 819.199 375.552 819.199 239.821 L 819.199 401.204 C 819.199 536.934 709.168 646.962 573.441 646.962 Z" },
  { fill: "#42a1ff", d: "M 573.441 485.579 L 245.762 485.579 C 111.223 485.591 1.684 377.423 0 242.891 C 0.227 215.348 5.219 188.048 14.746 162.2 C 49.996 259.43 142.34 324.184 245.762 324.2 L 573.441 324.2 C 676.785 324.098 769.027 259.36 804.25 162.2 C 813.848 188.036 818.906 215.337 819.199 242.891 C 817.52 377.423 707.98 485.591 573.441 485.579 Z" },
  { fill: "#5aacff", d: "M 805.684 161.794 C 770.527 259.028 678.27 323.864 574.875 323.993 L 247.195 323.993 C 138.035 323.993 45.465 263.989 13.516 169.778 C 22.988 140.477 37.93 113.235 57.547 89.497 C 103.898 146.677 173.59 179.864 247.195 179.813 L 574.875 179.813 C 648.531 179.837 718.273 146.661 764.723 89.497 C 782.324 111.134 796.172 135.571 805.684 161.794 Z" },
  { fill: "#76bbff", d: "M 573.441 179.813 L 245.762 179.813 C 172.156 179.864 102.465 146.677 56.113 89.497 C 102.789 32.841 172.352 0.013 245.762 0.001 L 573.441 0.001 C 646.848 0.013 716.41 32.841 763.086 89.497 C 716.734 146.677 647.043 179.864 573.441 179.813 Z" },
  { fill: "#ffffff", d: "M 245.762 532.481 C 245.926 486.204 273.988 444.595 316.828 427.098 C 359.672 409.602 408.836 419.669 441.352 452.598 C 473.867 485.524 483.316 534.813 465.281 577.43 C 447.246 620.048 405.289 647.583 359.016 647.169 C 296.141 646.606 245.531 595.356 245.762 532.481 Z" },
  { fill: "#ffffff", d: "M 600.68 527.973 C 600.68 589.415 540.262 632.423 474.93 624.231 C 497.914 600.235 509.734 567.677 507.496 534.528 C 507.496 485.579 483.125 457.727 450.355 428.442 C 527.789 388.364 584.312 317.001 605.594 232.446 L 670.719 232.446 L 670.719 256.204 C 670.969 292.751 662.324 328.809 645.531 361.266 C 628.188 396.993 599.336 425.848 563.609 443.188 C 587.617 464.833 601.312 495.649 601.293 527.973 Z" },
  { fill: "#ffffff", d: "M 571.188 172.032 C 572.805 181.227 573.559 190.552 573.441 199.884 C 573.441 317.063 478.445 412.059 361.266 412.059 C 244.086 412.059 149.094 317.063 149.094 199.884 C 149.027 190.544 149.848 181.216 151.551 172.032" }
];
function CoworkColorGlyph({ size = 26, className }) {
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
    "svg",
    {
      className,
      viewBox: "0 0 820 820",
      width: size,
      height: size,
      style: { width: size, height: size },
      "aria-hidden": "true",
      children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("g", { transform: "translate(0 820) scale(1 -1)", children: COWORK_COLOR_GLYPH_PATHS.map(({ fill, d }) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("path", { d, fill, fillRule: "evenodd" }, d)) })
    }
  );
}
function CoworkFooterAction({ wide }) {
  ensurePanelStyles();
  const services = useClientServices();
  const canOpen = services.sidebarRight !== void 0 && typeof services.sidebarRight.openTab === "function";
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "cw-footer-slot", "data-wide": wide ? "true" : "false", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
    "button",
    {
      type: "button",
      className: "cw-footer-button",
      "data-wide": wide ? "true" : "false",
      "aria-label": "打开 Cowork 面板",
      title: canOpen ? "打开 Cowork 面板" : "当前宿主没有提供右侧栏导航服务，无法打开 Cowork 面板。",
      disabled: !canOpen,
      onClick: () => {
        if (!canOpen || services.sidebarRight === void 0) return;
        services.sidebarRight.openTab(COWORK_TAB_KIND);
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(CoworkGlyph, {}),
        wide ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "cw-footer-label", children: COWORK_TAB_TITLE }) : null
      ]
    }
  ) });
}

// src/client/notice-model.ts
var NOTICE_STATUSES = ["pending", "allowed", "denied", "void"];
var NOTICE_ACTION_TYPES = ["allow", "deny", "open-topic", "open-work-item"];
var NOTICE_KIND_LABELS = {
  assignment: "分配",
  report: "上报",
  proposal: "决策提案",
  authorization: "待授权",
  archive: "归档"
};
var NOTICE_STATUS_LABELS = {
  pending: "待处理",
  allowed: "已允许",
  denied: "已拒绝",
  void: "已失效"
};
var NOTICE_ACTION_LABELS = {
  allow: "允许",
  deny: "拒绝",
  "open-topic": "去主题会话处理",
  "open-work-item": "去工作项查看"
};
var NOTICE_ACTION_TONES = {
  allow: "success",
  deny: "error",
  "open-topic": "neutral",
  "open-work-item": "neutral"
};
var NOTICE_TITLE_MAX_CHARS = 120;
var NOTICE_SUMMARY_MAX_CHARS = 200;
var NOTICE_SEAT = "conversation.chat.node";
var NOTICE_NODE_KIND = "notice";
function isNoticeStatus(value) {
  return NOTICE_STATUSES.some((status) => status === value);
}
function isNoticeActionType(value) {
  return NOTICE_ACTION_TYPES.some((type) => type === value);
}
function bound(text2, maxChars) {
  const trimmed = text2.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, Math.max(1, maxChars - 1))}…`;
}
function noticeKindLabel(kind) {
  return NOTICE_KIND_LABELS[kind] ?? String(kind);
}
function noticeStatusLabel(status) {
  return NOTICE_STATUS_LABELS[status] ?? String(status);
}
function noticeActionLabel(type) {
  return NOTICE_ACTION_LABELS[type] ?? String(type);
}
function noticeActionInputs(notice) {
  const raw = notice.actions ?? [];
  const actions = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (isNoticeActionType(entry)) actions.push({ type: entry, target: null });
      continue;
    }
    if (!isRecord2(entry)) continue;
    if (!isNoticeActionType(entry.type)) continue;
    const target = typeof entry.target === "string" && entry.target.trim() !== "" ? entry.target.trim() : null;
    actions.push({ type: entry.type, target });
  }
  return actions;
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNoticeVisible(notice, audience) {
  if (notice.kind === "archive") return audience === "master";
  return true;
}
function noticeActions(notice, context) {
  if (notice.kind === "assignment" || notice.kind === "report" || notice.kind === "archive") return [];
  const requested = noticeActionInputs(notice);
  const views = [];
  for (const action of requested) {
    if (notice.kind === "proposal") {
      if (action.type !== "open-work-item") continue;
      if (context.workItemPageAvailable !== true) continue;
      const target = action.target ?? context.workItemId ?? null;
      if (target === null || target.trim() === "") continue;
      views.push(actionView(action.type, target, false));
      continue;
    }
    if (notice.status !== "pending") continue;
    if (context.audience === "master") {
      if (action.type !== "open-topic") continue;
      const target = notice.topicId.trim();
      if (target === "") continue;
      views.push(actionView(action.type, target, false));
      continue;
    }
    if (action.type !== "allow" && action.type !== "deny") continue;
    views.push(actionView(action.type, null, false));
  }
  return views;
}
function actionView(type, target, disabled) {
  return {
    type,
    label: noticeActionLabel(type),
    tone: NOTICE_ACTION_TONES[type],
    target,
    disabled
  };
}
function noticeCard(notice, context) {
  if (typeof notice.noticeId !== "string" || notice.noticeId.trim() === "") return null;
  if (!isNoticeKind(notice.kind) || !isNoticeStatus(notice.status)) return null;
  if (!isNoticeVisible(notice, context.audience)) return null;
  const title = bound(typeof notice.title === "string" ? notice.title : "", NOTICE_TITLE_MAX_CHARS);
  return {
    noticeId: notice.noticeId,
    kind: notice.kind,
    kindLabel: noticeKindLabel(notice.kind),
    title: title.length === 0 ? noticeKindLabel(notice.kind) : title,
    summary: bound(typeof notice.summary === "string" ? notice.summary : "", NOTICE_SUMMARY_MAX_CHARS),
    status: notice.status,
    statusLabel: noticeStatusLabel(notice.status),
    audience: context.audience,
    actions: noticeActions(notice, context)
  };
}
function canRegisterNoticeRenderer(input) {
  return input.sessionNotices !== void 0;
}

// src/client/notice.tsx
var import_jsx_runtime4 = require("react/jsx-runtime");
function NoticeCard({ card, onAction }) {
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(
    "article",
    {
      className: "cw-notice-card",
      "data-notice-kind": card.kind,
      "data-notice-status": card.status,
      "data-audience": card.audience,
      "aria-label": `${card.kindLabel}：${card.title}`,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("header", { className: "cw-notice-card-head", children: [
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "cw-notice-card-kind", children: card.kindLabel }),
          /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { className: "cw-notice-card-status", "data-status": card.status, children: card.statusLabel })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("h3", { className: "cw-notice-card-title", children: card.title }),
        card.summary.length === 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("p", { className: "cw-notice-card-summary", children: card.summary }),
        card.actions.length === 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { className: "cw-notice-card-actions", children: card.actions.map((action) => /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
          "button",
          {
            type: "button",
            className: "cw-button",
            "data-action": action.type,
            "data-tone": action.tone,
            disabled: action.disabled,
            onClick: () => {
              onAction?.(action);
            },
            children: action.label
          },
          action.type
        )) })
      ]
    }
  );
}
function NoticeNode({ notice, context, onAction }) {
  const card = noticeCard(notice, context);
  if (card === null) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(NoticeCard, { card, onAction });
}
function registerNoticeRenderer(ctx) {
  if (!canRegisterNoticeRenderer({ sessionNotices: ctx.sessionNotices })) return null;
  return ctx.slots.inject(NOTICE_SEAT, () => ctx.slots.register({
    name: NOTICE_SEAT,
    key: NOTICE_NODE_KIND,
    kind: NOTICE_NODE_KIND
  }, NoticeNode));
}

// src/client/index.tsx
var inject = ["slots"];
function apply(ctx) {
  ensurePanelStyles();
  ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: COWORK_TAB_ID
  }, CoworkPanel));
  ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
    name: "sidebar.right.pane.tab.title",
    key: COWORK_TAB_ID
  }, CoworkPanelTitle));
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "cowork-open",
    order: 5
  }, CoworkFooterAction));
  ctx.inject(["sidebarRightTabs"], (scope) => {
    const tabs = scope.sidebarRightTabs;
    if (tabs === void 0) return;
    return tabs.register({
      id: COWORK_TAB_ID,
      kind: COWORK_TAB_KIND,
      title: () => COWORK_TAB_TITLE,
      guide: [{
        id: "cowork-guide",
        order: 35,
        title: () => COWORK_TAB_TITLE,
        description: () => "查看主题列表、分组与待处理事项。",
        icon: CoworkColorGlyph
      }]
    });
  });
  ctx.inject(["sidebarRight"], (scope) => {
    setClientService("sidebarRight", scope.sidebarRight);
    return () => {
      setClientService("sidebarRight", void 0);
    };
  });
  ctx.inject(["uiWorkspace"], (scope) => {
    setClientService("uiWorkspace", scope.uiWorkspace);
    return () => {
      setClientService("uiWorkspace", void 0);
    };
  });
  ctx.inject(["sessionNotices"], (scope) => registerNoticeRenderer(scope) ?? void 0);
}

    return module.exports;
  }
});
//# sourceMappingURL=client.js.map
