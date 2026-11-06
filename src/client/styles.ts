/**
 * Panel stylesheet, injected once as a `<style data-plugin>` tag.
 *
 * Only the 14 public theme tokens are consumed directly
 * (`--dsw-alias-bg-base|bg-layer-1|bg-layer-2|bg-overlay|border-l1|border-l2|
 * brand-primary|label-primary|label-secondary|state-error-primary|
 * state-idle-primary|state-success-primary|state-warn-primary` and
 * `--dsw-specific-sidebar-fill`). Internal DSH aliases that are not part of that
 * published set (`border-l3`, `interactive-bg-hover`, `radius-sm/md`,
 * `dsh-content-font-size-secondary`) are always written with a fallback.
 *
 * `brand-primary` is near-black in the light theme and near-white in the dark
 * one, so the primary button is monochrome with the inverse of that token
 * (`bg-base`) as its text color — never an accent color.
 */
import { LIST_COLUMN_WIDTH } from './model.ts'

export const PANEL_STYLE_ID = '@dsh-external/dsh-cowork/panel'

const MONO_FONT = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"

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
  font-family: ${MONO_FONT};
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}

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

.cw-chips {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.cw-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  white-space: nowrap;
}

.cw-chip[data-zero="true"] { opacity: 0.6; }

.cw-chip-count {
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}

.cw-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
}

.cw-dot[data-tone="success"] { background: var(--dsw-alias-state-success-primary); }
.cw-dot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.cw-dot[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.cw-dot[data-tone="idle"] { background: var(--dsw-alias-state-idle-primary); }

.cw-body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
  min-width: 0;
}

.cw-list {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 4px;
}

.cw-root[data-layout="split"] .cw-list {
  flex: none;
  width: ${LIST_COLUMN_WIDTH}px;
  border-right: 0.5px solid var(--dsw-alias-border-l2);
}

.cw-list[data-list-state="long-list"] {
  overflow-y: auto;
  overscroll-behavior: contain;
}

.cw-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  margin: 0;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.cw-row:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}

.cw-row[aria-selected="true"] {
  background: var(--dsw-alias-bg-layer-2);
}

.cw-row-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

.cw-row-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.cw-row-time {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cw-row-body {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.cw-row-subject {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-primary);
}

.cw-row[data-subject-state="long-subject"] .cw-row-subject {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.cw-handoff-mark {
  flex: none;
  padding: 0 5px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  line-height: 1.5;
}

.cw-detail-empty {
  padding: 12px;
}

.cw-detail-pane {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}

.cw-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px 16px;
  min-height: 100%;
}

.cw-detail[data-handoff-state="no-handoff"] { gap: 8px; }

.cw-back {
  align-self: flex-start;
  padding: 2px 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.cw-back:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}

.cw-detail-subject {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.cw-detail-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

.cw-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 11px;
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

.cw-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.cw-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cw-section-title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}

.cw-muted {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
}

.cw-summary {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
}

.cw-verify-list,
.cw-path-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.cw-verify {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1);
}

.cw-verify-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.cw-verify-command {
  flex: 1 1 auto;
  min-width: 0;
  font-family: ${MONO_FONT};
  font-size: 11px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
}

.cw-verify-evidence {
  margin: 0;
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary);
}

.cw-exit {
  flex: none;
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  font-family: ${MONO_FONT};
  font-size: 10px;
  color: var(--dsw-alias-label-secondary);
}

.cw-exit[data-tone="success"] {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}

.cw-exit[data-tone="error"] {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}

.cw-path-list {
  flex-direction: row;
  flex-wrap: wrap;
}

.cw-path {
  padding: 0 6px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-family: ${MONO_FONT};
  font-size: 10.5px;
  overflow-wrap: anywhere;
}

.cw-file-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.cw-filepath {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
}

.cw-feedback {
  margin: 0;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary);
}

.cw-feedback[data-kind="ok"] { color: var(--dsw-alias-state-success-primary); }
.cw-feedback[data-kind="failed"] { color: var(--dsw-alias-state-error-primary); }

.cw-master-details {
  padding: 6px 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1);
}

.cw-master-summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
}

.cw-master {
  margin: 6px 0 0;
  padding: 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: ${MONO_FONT};
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre;
  overflow: auto;
  overscroll-behavior: contain;
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

.cw-footer-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
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
  font-size: 14px;
  line-height: 1;
}

.cw-footer-label { min-width: 0; white-space: nowrap; }

.cw-tab-title {
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
