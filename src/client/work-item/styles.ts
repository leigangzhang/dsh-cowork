/**
 * Work-item stylesheet, mounted once as a `<style data-plugin-css>` tag beside
 * the panel sheet.
 *
 * Public theme tokens only, each with a literal fallback so a host without the
 * newer alias still renders: `--dsw-alias-bg-base|bg-layer-1|bg-layer-2|
 * border-l1|border-l2|brand-primary|label-primary|label-secondary|
 * state-error-primary|state-success-primary|state-warn-primary|radius-sm`.
 * The one internal alias is the panel's own `--cw-surface-muted`, which the
 * panel sheet defines; every use here also has a fallback color.
 *
 * Layout: the viewer fills the main slot; the comment rail is 320px beside the
 * content and becomes a drawer-free stacked block under 900px (the host main
 * slot is wide, so a media query is enough).
 */
export const WORK_ITEM_STYLE_ID = '@dsh-external/dsh-cowork/work-item'

/** The work-item stylesheet text. */
export const WORK_ITEM_CSS = `
.cwi-list { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; min-height: 0; overflow: auto; }
.cwi-filter-row { display: flex; flex-wrap: wrap; gap: 4px; }
.cwi-filter { border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); background: transparent; color: var(--dsw-alias-label-secondary, #5b6470); border-radius: 999px; padding: 2px 9px; font-size: 12px; cursor: pointer; }
.cwi-filter[data-active="true"] { border-color: var(--dsw-alias-brand-primary, #3457d5); color: var(--dsw-alias-brand-primary, #3457d5); }
.cwi-filter:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3457d5); outline-offset: 1px; }
.cwi-group-title { width: 100%; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #5b6470); text-align: left; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 6px; margin: 8px 0 2px; padding: 0; font: inherit; font-size: 12px; }
.cwi-group-title button { border: none; background: transparent; color: inherit; cursor: pointer; padding: 0; font: inherit; }
.cwi-card { display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: left; border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1f2329); padding: 8px 10px; cursor: pointer; }
.cwi-card:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f4f7); }
.cwi-card:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3457d5); outline-offset: 1px; }
.cwi-card[data-status="confirmed"] .cwi-card-title { color: var(--dsw-alias-label-secondary, #5b6470); }
.cwi-card-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cwi-card-meta { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 11px; color: var(--dsw-alias-label-secondary, #5b6470); }
.cwi-chip { border-radius: 4px; background: var(--cw-surface-muted, #f2f4f7); padding: 0 5px; line-height: 18px; }
.cwi-chip[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d93026); }
.cwi-chip[data-tone="done"] { color: var(--dsw-alias-state-success-primary, #1a7f37); }
.cwi-chip[data-tone="active"] { color: var(--dsw-alias-brand-primary, #3457d5); }
.cwi-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cwi-empty, .cwi-error, .cwi-loading { padding: 18px 12px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary, #5b6470); }
.cwi-error { color: var(--dsw-alias-state-error-primary, #d93026); }
.cwi-skeleton-card { border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.cwi-skeleton-title { height: 14px; width: 55%; }
.cwi-skeleton-line { height: 10px; width: 80%; }
.cwi-skeleton { height: 58px; border-radius: 8px; background: var(--cw-surface-muted, #f2f4f7); animation: cwi-pulse 1.2s ease-in-out infinite; }
@keyframes cwi-pulse { 50% { opacity: 0.55; } }
@media (prefers-reduced-motion: reduce) { .cwi-skeleton { animation: none; } }

.cwi-viewer { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1f2329); }
.cwi-viewer-header { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e3e6ea); }
.cwi-back { border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); background: transparent; color: inherit; border-radius: var(--dsw-radius-sm, 8px); padding: 3px 8px; cursor: pointer; font-size: 12px; }
.cwi-back:disabled { opacity: 0.5; cursor: default; }
.cwi-title { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.cwi-status { flex: none; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); padding: 1px 8px; font-size: 11px; color: var(--dsw-alias-label-secondary, #5b6470); }
.cwi-toolbar { flex: none; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 5px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e3e6ea); font-size: 11px; color: var(--dsw-alias-label-secondary, #5b6470); }
.cwi-toolbar .cwi-spacer { flex: 1; }
.cwi-view-tabs { flex: none; display: flex; align-items: center; gap: 6px; padding: 4px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e3e6ea); }
.cwi-view-tab { border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary, #5b6470); padding: 3px 6px; font-size: 12px; cursor: pointer; }
.cwi-view-tab[data-active="true"] { border-bottom-color: var(--dsw-alias-brand-primary, #3457d5); color: var(--dsw-alias-brand-primary, #3457d5); }
.cwi-body { flex: 1; display: flex; min-height: 0; }
.cwi-doc-view[hidden], .cwi-rail[hidden] { display: none; }
.cwi-doc-view[data-mode="read"] .cwi-line-number { opacity: 0.45; }
.cwi-panel { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.cwi-panel-title { font-size: 13px; font-weight: 600; }
.cwi-meta-list { display: grid; grid-template-columns: 110px 1fr; gap: 4px 10px; margin: 0; font-size: 12px; }
.cwi-meta-list dt { color: var(--dsw-alias-label-secondary, #5b6470); }
.cwi-meta-list dd { margin: 0; overflow-wrap: anywhere; }
.cwi-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.cwi-hint { font-size: 11px; color: var(--dsw-alias-label-secondary, #5b6470); margin: 0; }
.cwi-attachment-row { display: flex; align-items: center; gap: 10px; border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); border-radius: 8px; padding: 8px; }
.cwi-attachment-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12px; overflow-wrap: anywhere; }
.cwi-line-pin { flex: none; color: var(--dsw-alias-brand-primary, #3457d5); font-size: 9px; align-self: center; }
.cwi-content { flex: 1; min-width: 0; overflow: auto; padding: 6px 0 24px; }
.cwi-lines { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 20px; }
.cwi-line { display: flex; gap: 10px; padding: 0 12px; white-space: pre; cursor: text; }
.cwi-line:hover { background: var(--cw-surface-muted, #f2f4f7); }
.cwi-line[data-selected="true"] { background: var(--dsw-alias-state-business-tertiary, #eaf0ff); }
.cwi-line[data-anchored="true"] { box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary, #3457d5); }
.cwi-line-number { flex: none; width: 44px; text-align: right; color: var(--dsw-alias-label-secondary, #9aa3ad); user-select: none; }
.cwi-line-text { flex: 1; min-width: 0; }
.cwi-md-h1 { font-weight: 700; font-size: 15px; }
.cwi-md-h2 { font-weight: 650; font-size: 13px; }
.cwi-md-h3 { font-weight: 600; }
.cwi-md-list::before { content: '• '; color: var(--dsw-alias-label-secondary, #5b6470); }
.cwi-md-quote { border-left: 2px solid var(--dsw-alias-border-l2, #dfe3e8); padding-left: 6px; color: var(--dsw-alias-label-secondary, #5b6470); }
.cwi-selection-bar { position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; align-items: center; padding: 5px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, #e3e6ea); background: var(--dsw-alias-bg-base, #fff); font-size: 12px; }
.cwi-primary { border: 1px solid var(--dsw-alias-brand-primary, #3457d5); background: var(--dsw-alias-brand-primary, #3457d5); color: #fff; border-radius: var(--dsw-radius-sm, 8px); padding: 3px 10px; font-size: 12px; cursor: pointer; }
.cwi-primary:disabled { opacity: 0.55; cursor: default; }
.cwi-secondary { border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); background: transparent; color: inherit; border-radius: var(--dsw-radius-sm, 8px); padding: 3px 9px; font-size: 12px; cursor: pointer; }
.cwi-rail { flex: none; width: 340px; min-width: 0; border-left: 1px solid var(--dsw-alias-border-l1, #e3e6ea); display: flex; flex-direction: column; min-height: 0; }
.cwi-rail-header { flex: none; padding: 8px 12px; font-size: 12px; color: var(--dsw-alias-label-secondary, #5b6470); border-bottom: 1px solid var(--dsw-alias-border-l1, #e3e6ea); }
.cwi-threads { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.cwi-thread { border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); border-radius: var(--dsw-radius-sm, 8px); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.cwi-thread[data-resolved="true"] { opacity: 0.7; }
.cwi-thread-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px; color: var(--dsw-alias-label-secondary, #5b6470); }
.cwi-thread-body { font-size: 12px; white-space: pre-wrap; word-break: break-word; }
.cwi-thread-reply { border-left: 2px solid var(--dsw-alias-border-l2, #dfe3e8); padding-left: 7px; display: flex; flex-direction: column; gap: 2px; }
.cwi-quote { width: 100%; text-align: left; border: 0; background: transparent; cursor: pointer; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: pre-wrap; border-left: 2px solid var(--dsw-alias-border-l2, #dfe3e8); padding-left: 6px; color: var(--dsw-alias-label-secondary, #5b6470); }
.cwi-stale { color: var(--dsw-alias-state-warn-primary, #b26a00); }
.cwi-composer { flex: none; border-top: 1px solid var(--dsw-alias-border-l1, #e3e6ea); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.cwi-composer textarea { width: 100%; min-height: 58px; resize: vertical; border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; padding: 6px 8px; font: inherit; font-size: 12px; }
.cwi-composer textarea:focus-visible, .cwi-primary:focus-visible, .cwi-secondary:focus-visible, .cwi-back:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3457d5); outline-offset: 1px; }
.cwi-composer-row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.cwi-composer-hint { font-size: 11px; color: var(--dsw-alias-label-secondary, #5b6470); }
.cwi-receipt { font-size: 11px; color: var(--dsw-alias-state-error-primary, #d93026); }
.cwi-viewer-empty { padding: 30px 16px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary, #5b6470); }
.cwi-editor-host { min-height: 70vh; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 20px; }
.cwi-editor-host .cm-editor { min-height: 70vh; background: transparent; color: inherit; }
.cwi-editor-host .cm-editor.cm-focused { outline: 1px solid var(--dsw-alias-brand-primary, #3457d5); outline-offset: -1px; }
.cwi-editor-host .cm-scroller { font-family: inherit; font-size: 12px; line-height: 20px; }
.cwi-editor-host .cm-content { padding: 6px 12px 24px; }
.cwi-editor-host .cm-gutters { background: transparent; color: var(--dsw-alias-label-secondary, #9aa3ad); border-right: none; }
.cwi-editor-host .cm-lineNumbers .cm-gutterElement { padding: 0 8px 0 12px; }
.cwi-editor-host .cm-line.cwi-editor-anchored { background: var(--dsw-alias-state-business-tertiary, #eaf0ff); box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary, #3457d5); }
.cwi-conflict { border-bottom: 1px solid var(--dsw-alias-state-warn-primary, #b26a00); background: var(--cw-surface-muted, #f2f4f7); color: var(--dsw-alias-label-primary, #1f2329); padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.cwi-conflict-diff { display: flex; flex-direction: column; gap: 4px; }
.cwi-attachment-thumb { max-width: 220px; max-height: 160px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); display: block; }
.cwi-attachment-link { font-size: 11px; color: var(--dsw-alias-brand-primary, #3457d5); word-break: break-all; }
.cwi-conflict-latest { margin: 0; max-height: 180px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: pre-wrap; border-left: 2px solid var(--dsw-alias-border-l2, #dfe3e8); padding-left: 6px; }
@media (max-width: 900px) {
  .cwi-body { flex-direction: column; }
  .cwi-rail { width: auto; border-left: none; border-top: 1px solid var(--dsw-alias-border-l1, #e3e6ea); max-height: 45%; }
}
`

/**
 * Mount the work-item stylesheet once. Idempotent and document-injected so a
 * unit test can prove the deduplication without a browser.
 */
export function ensureWorkItemStyles(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): void {
  if (doc === undefined) return
  const selector = `style[data-plugin-css="${WORK_ITEM_STYLE_ID}"]`
  if (doc.head.querySelector(selector) !== null) return
  const tag = doc.createElement('style')
  tag.dataset.plugin = WORK_ITEM_STYLE_ID
  tag.dataset.pluginCss = WORK_ITEM_STYLE_ID
  tag.textContent = WORK_ITEM_CSS
  doc.head.appendChild(tag)
}
