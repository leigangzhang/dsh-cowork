/**
 * Work-item stylesheet, mounted once as a `<style data-plugin-css>` tag beside
 * the panel sheet.
 *
 * The sheet follows the artifact demo's document layout: a paper card on a
 * muted workspace, a file strip, a comment rail card, and a status/activity
 * system that reads as part of the host. Every colour and size resolves through
 * a public host token with a literal fallback, so a host without the newer
 * aliases still renders and the dark theme keeps working. The one local alias is
 * `--cw-surface-muted` on the Cowork panel; this sheet does not inherit it
 * (the viewer is a root main panel), so it defines its own `--cwi-*` scale.
 *
 * Layout: the viewer fills the main slot; the comment rail is 336px beside the
 * content and becomes a stacked block under 900px. Text-based families render
 * on a centred paper card; HTML and canvas fill the remaining height inside
 * their own card.
 */
export const WORK_ITEM_STYLE_ID = '@dsh-external/dsh-cowork/work-item'

/** The work-item stylesheet text. */
export const WORK_ITEM_CSS = `
.cwi-viewer,
.cwi-list {
  --cwi-ink: var(--dsw-alias-label-primary, #101828);
  --cwi-muted: var(--dsw-alias-label-secondary, #475467);
  --cwi-soft: var(--dsw-alias-label-tertiary, #98a2b3);
  --cwi-border: var(--dsw-alias-border-l2, #d0d5dd);
  --cwi-border-soft: var(--dsw-alias-border-l1, #e4e7ec);
  --cwi-surface: var(--dsw-alias-bg-layer-1, #fff);
  --cwi-surface-muted: var(--dsw-alias-interactive-bg-hover, #f2f4f7);
  --cwi-page: var(--dsw-alias-bg-document-preview, #eef1f5);
  --cwi-accent: var(--dsw-alias-state-business-primary, #4176e6);
  --cwi-accent-soft: var(--dsw-alias-state-business-tertiary, #e4edfd);
  --cwi-success: var(--dsw-alias-state-success-primary, #067647);
  --cwi-success-soft: var(--dsw-alias-state-success-tertiary, #ecfdf3);
  --cwi-warn: var(--dsw-alias-state-warn-primary, #b54708);
  --cwi-warn-soft: var(--dsw-alias-state-warn-tertiary, #fffaeb);
  --cwi-danger: var(--dsw-alias-state-error-primary, #b42318);
  --cwi-danger-soft: var(--dsw-alias-state-error-tertiary, #fef3f2);
  --cwi-radius: var(--dsw-radius-md, 12px);
  --cwi-radius-sm: var(--dsw-radius-sm, 8px);
  --cwi-radius-xs: var(--dsw-radius-xs, 4px);
  --cwi-shadow: 0 1px 2px #0000000a, 0 2px 6px #00000005;
  --cwi-mono: var(--ds-font-family-code, ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace);
  --cwi-leading: 24px;
  color: var(--cwi-ink);
  font-family: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1.5;
}
.cwi-viewer *, .cwi-list * { box-sizing: border-box; }

/* ---------- right-rail work-item list ---------- */
.cwi-list { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 18px; min-height: 0; overflow: auto; }
.cwi-filter-row { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 0 6px; background: var(--dsw-alias-bg-base, #fff); }
.cwi-filter { border: 1px solid var(--cwi-border); background: transparent; color: var(--cwi-muted); border-radius: 999px; padding: 2px 10px; font: inherit; font-size: 11.5px; cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease; }
.cwi-filter:hover { background: var(--cwi-surface-muted); color: var(--cwi-ink); }
.cwi-filter[data-active="true"] { border-color: transparent; background: var(--cwi-accent-soft); color: var(--cwi-accent); font-weight: 600; }
.cwi-filter:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-group-title { width: 100%; border: 0; background: transparent; color: var(--cwi-soft); text-align: left; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 6px; margin: 10px 0 4px; padding: 0 2px; font: inherit; font-size: 11px; font-weight: 650; letter-spacing: .03em; }
.cwi-group-title:hover { color: var(--cwi-muted); }
.cwi-group-title > span:last-child { min-width: 20px; padding: 0 6px; border-radius: 999px; background: var(--cwi-surface-muted); color: var(--cwi-muted); font-size: 10px; font-weight: 600; line-height: 18px; text-align: center; }
.cwi-group-title:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-card { display: flex; flex-direction: column; gap: 6px; width: 100%; text-align: left; border: 1px solid var(--cwi-border); border-radius: 10px; background: var(--cwi-surface); color: var(--cwi-ink); padding: 10px 12px; cursor: pointer; box-shadow: var(--cwi-shadow); transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease; }
.cwi-card:hover { border-color: var(--cwi-accent); background: var(--cwi-surface); }
.cwi-card:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-card[data-status="confirmed"] .cwi-card-title { color: var(--cwi-muted); }
.cwi-card-top { display: flex; align-items: center; gap: 6px; }
.cwi-kind { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: var(--cwi-radius-xs); background: var(--cwi-accent-soft); color: var(--cwi-accent); font-size: 10px; font-weight: 750; letter-spacing: .03em; }
.cwi-kind[data-type="canvas"] { background: var(--cwi-warn-soft); color: var(--cwi-warn); }
.cwi-kind[data-type="diagram"] { background: var(--cwi-success-soft); color: var(--cwi-success); }
.cwi-kind[data-type="html"] { background: var(--cwi-surface-muted); color: var(--cwi-muted); }
.cwi-card-status { margin-left: auto; padding: 1px 7px; border-radius: 999px; background: var(--cwi-surface-muted); color: var(--cwi-muted); font-size: 10px; font-weight: 650; }
.cwi-card-status[data-status="pending-view"] { background: var(--cwi-warn-soft); color: var(--cwi-warn); }
.cwi-card-status[data-status="pending-confirm"] { background: var(--cwi-accent-soft); color: var(--cwi-accent); }
.cwi-card-status[data-status="needs-feedback"] { background: var(--cwi-danger-soft); color: var(--cwi-danger); }
.cwi-card-status[data-status="in-progress"] { background: var(--cwi-accent-soft); color: var(--cwi-accent); }
.cwi-card-status[data-status="confirmed"] { background: var(--cwi-success-soft); color: var(--cwi-success); }
.cwi-card-title { font-size: 13px; font-weight: 650; line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.cwi-card-meta { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 11px; color: var(--cwi-muted); }
.cwi-card-meta .cwi-chip { padding: 0 6px; line-height: 17px; font-size: 10.5px; font-weight: 500; }
.cwi-card-time { margin-left: auto; color: var(--cwi-soft); font-size: 10.5px; white-space: nowrap; }
.cwi-card .cwi-path { color: var(--cwi-soft); font-size: 10.5px; }
.cwi-card-source { color: var(--cwi-soft); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cwi-empty, .cwi-error, .cwi-loading { padding: 22px 14px; text-align: center; font-size: 12px; color: var(--cwi-soft); }
.cwi-error { color: var(--cwi-danger); }
.cwi-skeleton-card { border: 1px solid var(--cwi-border); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; background: var(--cwi-surface); }
.cwi-skeleton { height: 62px; border-radius: 10px; background: var(--cwi-surface-muted); animation: cwi-pulse 1.2s ease-in-out infinite; }
.cwi-skeleton-title { height: 13px; width: 55%; }
.cwi-skeleton-line { height: 9px; width: 80%; }
@keyframes cwi-pulse { 50% { opacity: .55; } }

/* ---------- viewer shell ---------- */
.cwi-viewer { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--cwi-page); }
.cwi-viewer-header { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 10px 20px 12px; background: var(--cwi-surface); border-bottom: 1px solid var(--cwi-border-soft); }
.cwi-header-bar { display: flex; align-items: center; gap: 8px; min-height: 22px; }
.cwi-back { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px 2px 5px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--cwi-muted); font: inherit; font-size: 12px; cursor: pointer; transition: background-color 120ms ease, color 120ms ease; }
.cwi-back:hover { background: var(--cwi-surface-muted); color: var(--cwi-ink); }
.cwi-back:disabled { opacity: .5; cursor: default; }
.cwi-back-icon { font-size: 13px; line-height: 1; }
.cwi-title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
.cwi-title { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 18px; line-height: 26px; font-weight: 650; letter-spacing: -.01em; color: var(--cwi-ink); }
.cwi-title-spacer { flex: 1; min-width: 8px; }
.cwi-sub { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-width: 0; font-size: 11.5px; color: var(--cwi-soft); }
.cwi-path { font-family: var(--cwi-mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--cwi-muted); max-width: 48%; }
.cwi-dot { flex: none; width: 3px; height: 3px; border-radius: 50%; background: var(--cwi-border); }
.cwi-sub-fact { white-space: nowrap; }
.cwi-live { display: inline-flex; align-items: center; gap: 5px; margin-left: 2px; padding: 1px 8px; border: 1px solid transparent; border-radius: 999px; background: var(--cwi-accent-soft); color: var(--cwi-accent); font-size: 11px; font-weight: 600; }
.cwi-live[data-tone="pending"] { background: var(--cwi-warn-soft); color: var(--cwi-warn); }
.cwi-live[data-tone="done"] { background: var(--cwi-success-soft); color: var(--cwi-success); }
.cwi-live[data-tone="error"] { background: var(--cwi-danger-soft); color: var(--cwi-danger); }
.cwi-live-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.cwi-live[data-tone="active"] .cwi-live-dot { animation: cwi-pulse 1.2s ease-in-out infinite; }
.cwi-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; background: var(--cwi-surface-muted); color: var(--cwi-muted); font-size: 11px; line-height: 18px; font-weight: 600; white-space: nowrap; }
.cwi-type-chip { background: var(--cwi-accent-soft); color: var(--cwi-accent); font-weight: 650; }
.cwi-chip[data-tone="error"] { background: var(--cwi-danger-soft); color: var(--cwi-danger); }
.cwi-chip[data-tone="done"] { background: var(--cwi-success-soft); color: var(--cwi-success); }
.cwi-chip[data-tone="pending"] { background: var(--cwi-warn-soft); color: var(--cwi-warn); }
.cwi-chip[data-tone="active"] { background: var(--cwi-accent-soft); color: var(--cwi-accent); }
.cwi-status { flex: none; padding: 1px 9px; border-radius: 999px; font-size: 11px; font-weight: 650; background: var(--cwi-surface-muted); color: var(--cwi-muted); }
.cwi-status[data-status="pending-view"] { background: var(--cwi-warn-soft); color: var(--cwi-warn); }
.cwi-status[data-status="pending-confirm"] { background: var(--cwi-accent-soft); color: var(--cwi-accent); }
.cwi-status[data-status="needs-feedback"] { background: var(--cwi-danger-soft); color: var(--cwi-danger); }
.cwi-status[data-status="in-progress"] { background: var(--cwi-accent-soft); color: var(--cwi-accent); }
.cwi-status[data-status="confirmed"] { background: var(--cwi-success-soft); color: var(--cwi-success); }

/* ---------- toolbar ---------- */
.cwi-toolbar { flex: none; display: flex; align-items: center; gap: 10px; min-height: 42px; padding: 0 16px; background: var(--cwi-surface); border-bottom: 1px solid var(--cwi-border-soft); }
.cwi-view-tabs { display: flex; align-items: stretch; gap: 16px; height: 42px; }
.cwi-view-tab { position: relative; display: inline-flex; align-items: center; gap: 5px; padding: 0; border: 0; background: transparent; color: var(--cwi-muted); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.cwi-view-tab:hover { color: var(--cwi-ink); }
.cwi-view-tab[data-active="true"] { color: var(--cwi-accent); }
.cwi-view-tab[data-active="true"]::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--cwi-accent); }
.cwi-view-tab:focus-visible, .cwi-mode:focus-visible, .cwi-rail-toggle:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 2px; }
.cwi-spacer, .cwi-toolbar-spacer { flex: 1; }
.cwi-mode { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid var(--cwi-border); border-radius: 7px; background: var(--cwi-surface-muted); color: var(--cwi-muted); font: inherit; cursor: pointer; }
.cwi-mode-option { padding: 1px 8px; border-radius: 5px; font-size: 11px; font-weight: 600; color: var(--cwi-muted); }
.cwi-mode-option[data-active="true"] { background: var(--cwi-surface); color: var(--cwi-ink); box-shadow: 0 1px 2px #00000014; }
.cwi-mode:hover .cwi-mode-option[data-active="false"] { color: var(--cwi-ink); }
.cwi-save { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--cwi-muted); white-space: nowrap; }
.cwi-save-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--cwi-success); }
.cwi-save[data-phase="readonly"] .cwi-save-dot { background: var(--cwi-soft); }
.cwi-save[data-phase="saving"] .cwi-save-dot { background: var(--cwi-accent); animation: cwi-pulse 1.2s ease-in-out infinite; }
.cwi-save[data-phase="conflict"] .cwi-save-dot, .cwi-save[data-phase="failed"] .cwi-save-dot { background: var(--cwi-danger); }
.cwi-rail-toggle { padding: 3px 10px; border: 1px solid var(--cwi-border); border-radius: 7px; background: var(--cwi-surface); color: var(--cwi-ink); font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; }
.cwi-rail-toggle:hover { background: var(--cwi-surface-muted); }
.cwi-rail-toggle[data-visible="true"] { border-color: transparent; background: var(--cwi-accent-soft); color: var(--cwi-accent); }

/* ---------- body ---------- */
.cwi-body { flex: 1; min-height: 0; display: flex; gap: 12px; padding: 12px 14px 14px; }
.cwi-content { flex: 1; min-width: 0; min-height: 0; overflow: auto; display: flex; flex-direction: column; }
.cwi-content[data-kind="html"][data-editing="false"], .cwi-content[data-kind="canvas"] { overflow: hidden; }
.cwi-doc-view { flex: 1 0 auto; min-width: 0; display: flex; flex-direction: column; }
.cwi-doc-view[hidden] { display: none; }
.cwi-content[data-kind="html"][data-editing="false"] .cwi-doc-view,
.cwi-content[data-kind="canvas"] .cwi-doc-view { flex: 1; min-height: 0; }
.cwi-selection-bar { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 8px; margin: 0 12px 8px; padding: 6px 10px; border: 1px solid var(--cwi-border); border-radius: var(--cwi-radius-sm); background: var(--cwi-surface); box-shadow: var(--cwi-shadow); font-size: 12px; color: var(--cwi-muted); }
.cwi-primary, .cwi-secondary { font: inherit; font-size: 11.5px; font-weight: 600; border-radius: 7px; padding: 3px 10px; cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease; }
.cwi-primary { border: 1px solid transparent; background: var(--dsw-alias-button-primary-fill, var(--cwi-ink)); color: var(--dsw-alias-label-primary-inverted, #fff); }
.cwi-primary:hover { opacity: .9; }
.cwi-primary:disabled { opacity: .45; cursor: default; }
.cwi-secondary { border: 1px solid var(--cwi-border); background: var(--cwi-surface); color: var(--cwi-ink); }
.cwi-secondary:hover { background: var(--cwi-surface-muted); }
.cwi-primary:disabled, .cwi-secondary:disabled { cursor: default; }
.cwi-secondary:disabled { opacity: .55; }
.cwi-composer textarea:focus-visible, .cwi-primary:focus-visible, .cwi-secondary:focus-visible, .cwi-back:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }

/* ---------- paper: text, diagram, source ---------- */
.cwi-paper { flex: 1 0 auto; display: flex; flex-direction: column; width: 100%; max-width: 920px; margin: 0 auto; background: var(--cwi-surface); border: 1px solid var(--cwi-border); border-radius: var(--cwi-radius); box-shadow: var(--cwi-shadow); overflow: hidden; overflow: clip; }
.cwi-paper-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--cwi-border-soft); background: var(--cwi-surface-muted); }
.cwi-file-icon { flex: none; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 6px; background: var(--cwi-accent-soft); color: var(--cwi-accent); font-size: 9px; font-weight: 800; letter-spacing: .02em; }
.cwi-file-icon[data-kind="canvas"] { background: var(--cwi-warn-soft); color: var(--cwi-warn); }
.cwi-file-icon[data-kind="diagram"] { background: var(--cwi-success-soft); color: var(--cwi-success); }
.cwi-file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--cwi-mono); font-size: 12px; color: var(--cwi-ink); }
.cwi-file-meta { font-size: 11px; color: var(--cwi-soft); white-space: nowrap; }
.cwi-paper-spacer { flex: 1; }
.cwi-paper-body { flex: 1 0 auto; display: flex; flex-direction: column; padding: 12px 0 18px; min-width: 0; }
.cwi-paper-foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 7px 14px; border-top: 1px solid var(--cwi-border-soft); color: var(--cwi-soft); font-size: 10.5px; }
.cwi-paper-hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cwi-lines { position: relative; font-family: inherit; font-size: var(--dsh-content-font-size, 14px); line-height: var(--cwi-leading); color: var(--cwi-ink); }
.cwi-lines::before { content: ""; position: absolute; left: 49px; top: 0; bottom: 0; width: 1px; background: var(--cwi-border-soft); pointer-events: none; }
.cwi-line { position: relative; display: flex; align-items: flex-start; gap: 8px; padding: 1px 26px 1px 60px; white-space: pre-wrap; overflow-wrap: anywhere; border-left: 2px solid transparent; cursor: text; }
.cwi-line:hover { background: var(--cwi-surface-muted); }
.cwi-line[data-selected="true"] { background: var(--cwi-accent-soft); border-left-color: var(--cwi-accent); }
.cwi-line[data-anchored="true"] { border-left-color: var(--cwi-accent); }
.cwi-line-number { position: absolute; left: 12px; top: 0; width: 36px; text-align: right; color: var(--cwi-soft); font-family: var(--cwi-mono); font-size: 10.5px; line-height: var(--cwi-leading); user-select: none; }
.cwi-line-pin { position: absolute; left: 52px; top: 0; width: 4px; height: var(--cwi-leading); font-size: 0; color: transparent; }
.cwi-line-pin::before { content: ""; position: absolute; left: -4px; top: calc(var(--cwi-leading) / 2 - 3.5px); width: 7px; height: 7px; border-radius: 50%; background: var(--cwi-accent); box-shadow: 0 0 0 3px var(--cwi-accent-soft); }
.cwi-line-text { flex: 1; min-width: 0; }
.cwi-md-h1 { font-size: var(--dsw-font-markdown-h1-font-size, 21px); line-height: var(--dsw-font-markdown-h1-line-height, 30px); font-weight: var(--dsw-font-markdown-h1-font-weight, 700); letter-spacing: -.01em; }
.cwi-md-h2 { font-size: var(--dsw-font-markdown-h2-font-size, 19px); line-height: var(--dsw-font-markdown-h2-line-height, 28px); font-weight: var(--dsw-font-markdown-h2-font-weight, 700); }
.cwi-md-h3 { font-size: var(--dsw-font-markdown-h3-font-size, 18px); line-height: var(--dsw-font-markdown-h3-line-height, 26px); font-weight: var(--dsw-font-markdown-h3-font-weight, 700); }
.cwi-line[data-kind="h1"] { padding-top: 12px; }
.cwi-line[data-kind="h2"] { padding-top: 10px; }
.cwi-line[data-kind="h3"] { padding-top: 8px; }
.cwi-line[data-kind="h1"]:first-child, .cwi-line[data-kind="h2"]:first-child, .cwi-line[data-kind="h3"]:first-child { padding-top: 2px; }
.cwi-md-list { position: relative; padding-left: 16px; }
.cwi-md-list::before { content: "•"; position: absolute; left: 2px; color: var(--cwi-soft); }
.cwi-md-quote { color: var(--cwi-muted); border-left: 2px solid var(--cwi-border); padding-left: 10px; }
.cwi-inline-strong { font-weight: 650; }
.cwi-inline-em { font-style: italic; }
.cwi-inline-code { font-family: var(--cwi-mono); font-size: .88em; padding: 1px 4px; border-radius: var(--cwi-radius-xs); background: var(--dsw-alias-markdown-inline-code, var(--cwi-surface-muted)); }
.cwi-doc-view[data-mode="source"] .cwi-lines,
.cwi-doc-view[data-kind="source"] .cwi-lines { --cwi-leading: 20px; font-family: var(--cwi-mono); font-size: 12.5px; }
.cwi-doc-view[data-mode="source"] .cwi-line-number,
.cwi-doc-view[data-kind="source"] .cwi-line-number { opacity: .7; }
.cwi-title-row .cwi-primary,
.cwi-title-row .cwi-secondary { padding: 4px 12px; font-size: 12px; }
.cwi-editor-paper { flex: 1; min-height: 56vh; display: flex; flex-direction: column; }
.cwi-editor-host { min-height: 56vh; font-family: var(--cwi-mono); font-size: 13px; line-height: 22px; }
.cwi-editor-host .cm-editor { min-height: 56vh; background: transparent; color: var(--cwi-ink); }
.cwi-editor-host .cm-editor.cm-focused { outline: 1px solid var(--cwi-accent); outline-offset: -1px; }
.cwi-editor-host .cm-scroller { font-family: inherit; font-size: 13px; line-height: 22px; }
.cwi-editor-host .cm-content { padding: 8px 20px 32px; }
.cwi-editor-host .cm-gutters { background: transparent; color: var(--cwi-soft); border-right: none; }
.cwi-editor-host .cm-lineNumbers .cm-gutterElement { padding: 0 8px 0 14px; font-size: 10.5px; }
.cwi-editor-host .cm-line.cwi-editor-anchored { background: var(--cwi-accent-soft); box-shadow: inset 2px 0 0 var(--cwi-accent); }

/* ---------- diagram ---------- */
.cwi-figure { flex: 1; display: flex; align-items: center; justify-content: center; padding: 22px 20px; overflow: auto; }
.cwi-diagram { --pele-bg: transparent; --pele-fg: var(--cwi-ink); --pele-muted: var(--cwi-muted); --pele-surface: var(--cwi-surface); --pele-surface-alt: var(--cwi-surface-muted); --pele-line: var(--cwi-muted); --pele-border: var(--cwi-border); --pele-accent: var(--cwi-accent); --pele-font: var(--dsw-font-family, sans-serif); --pele-radius: 6px; max-width: 100%; }
.cwi-diagram svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.cwi-diagram-error { display: flex; flex-direction: column; gap: 8px; width: 100%; padding: 8px 4px; }
.cwi-diagram-error-title { font-size: 13px; font-weight: 650; color: var(--cwi-danger); }
.cwi-diagram-error-message { font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--cwi-muted); }
.cwi-diagram-error-snippet { margin: 0; padding: 8px 10px; border-left: 2px solid var(--cwi-border); border-radius: 0 var(--cwi-radius-xs) var(--cwi-radius-xs) 0; background: var(--cwi-surface-muted); font-family: var(--cwi-mono); font-size: 11px; white-space: pre-wrap; overflow: auto; }
.cwi-diagram-error-snippet:empty { display: none; }

/* ---------- HTML preview ---------- */
.cwi-html { flex: 1; min-height: 0; display: flex; flex-direction: column; width: 100%; background: var(--cwi-surface); border: 1px solid var(--cwi-border); border-radius: var(--cwi-radius); box-shadow: var(--cwi-shadow); overflow: hidden; }
.cwi-html-bar { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 12px; border-bottom: 1px solid var(--cwi-border-soft); background: var(--cwi-surface-muted); }
.cwi-html-frame { flex: 1; width: 100%; min-height: 0; border: 0; background: #fff; }
.cwi-hint { margin: 0; font-size: 11px; color: var(--cwi-soft); }

/* ---------- canvas ---------- */
.cwi-canvas { flex: 1; width: 100%; min-height: 380px; border: 1px solid var(--cwi-border); border-radius: var(--cwi-radius); box-shadow: var(--cwi-shadow); overflow: hidden; background: var(--cwi-surface); }
.cwi-canvas .excalidraw { height: 100%; }
.cwi-canvas-error { padding: 18px; display: flex; flex-direction: column; gap: 8px; background: var(--cwi-surface); border: 1px solid var(--cwi-border); border-radius: var(--cwi-radius); }

/* ---------- tabs: versions, attachments, notices ---------- */
.cwi-panel { width: 100%; max-width: 920px; margin: 0 auto; padding: 18px; display: flex; flex-direction: column; gap: 12px; background: var(--cwi-surface); border: 1px solid var(--cwi-border); border-radius: var(--cwi-radius); box-shadow: var(--cwi-shadow); }
.cwi-panel-title { font-size: 14px; font-weight: 650; }
.cwi-meta-list { display: grid; grid-template-columns: 120px 1fr; gap: 8px 14px; margin: 0; font-size: 12px; }
.cwi-meta-list dt { color: var(--cwi-soft); }
.cwi-meta-list dd { margin: 0; overflow-wrap: anywhere; }
.cwi-mono { font-family: var(--cwi-mono); font-size: 11px; }
.cwi-attachment-row { display: flex; align-items: center; gap: 12px; border: 1px solid var(--cwi-border); border-radius: 10px; padding: 10px; background: var(--cwi-surface); }
.cwi-attachment-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12px; overflow-wrap: anywhere; }
.cwi-attachment-thumb { max-width: 220px; max-height: 160px; border-radius: var(--cwi-radius-sm); border: 1px solid var(--cwi-border-soft); display: block; }
.cwi-attachment-link { font-size: 11px; color: var(--cwi-accent); word-break: break-all; }
.cwi-receipt { margin: 0 0 8px; padding: 7px 12px; border: 1px solid var(--cwi-border); border-radius: var(--cwi-radius-sm); background: var(--cwi-surface); font-size: 12px; color: var(--cwi-muted); box-shadow: var(--cwi-shadow); }
.cwi-receipt[data-tone="error"] { border-color: var(--cwi-danger); background: var(--cwi-danger-soft); color: var(--cwi-danger); }
.cwi-conflict { display: flex; flex-direction: column; gap: 8px; margin: 0 0 8px; padding: 10px 12px; border: 1px solid var(--cwi-danger); border-radius: var(--cwi-radius-sm); background: var(--cwi-danger-soft); color: var(--cwi-ink); font-size: 12px; }
.cwi-conflict-diff { display: flex; flex-direction: column; gap: 4px; }
.cwi-conflict-latest { margin: 0; max-height: 180px; overflow: auto; font-family: var(--cwi-mono); font-size: 11px; white-space: pre-wrap; border-left: 2px solid var(--cwi-border); padding-left: 8px; }

/* ---------- comment rail ---------- */
.cwi-rail { flex: none; width: 336px; min-height: 0; display: flex; flex-direction: column; background: var(--cwi-surface); border: 1px solid var(--cwi-border); border-radius: var(--cwi-radius); box-shadow: var(--cwi-shadow); overflow: hidden; }
.cwi-rail[hidden] { display: none; }
.cwi-rail-header { flex: none; display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--cwi-border-soft); }
.cwi-rail-title { font-size: 12px; font-weight: 700; color: var(--cwi-ink); }
.cwi-count-pill { min-width: 20px; padding: 0 6px; border-radius: 999px; background: var(--cwi-surface-muted); color: var(--cwi-muted); font-size: 10.5px; font-weight: 700; line-height: 18px; text-align: center; }
.cwi-rail-empty { margin: 12px; font-size: 12px; line-height: 1.6; color: var(--cwi-soft); }
.cwi-activity { flex: none; display: flex; align-items: center; gap: 7px; margin: 8px 10px 0; padding: 7px 9px; border: 1px solid var(--cwi-warn-soft); border-radius: var(--cwi-radius-sm); background: var(--cwi-warn-soft); color: var(--cwi-warn); font-size: 11px; }
.cwi-activity[data-tone="error"] { background: var(--cwi-danger-soft); border-color: var(--cwi-danger-soft); color: var(--cwi-danger); }
.cwi-activity[data-tone="done"] { background: var(--cwi-success-soft); border-color: var(--cwi-success-soft); color: var(--cwi-success); }
.cwi-activity-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: cwi-pulse 1.2s ease-in-out infinite; }
.cwi-activity-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cwi-activity-hint { opacity: .7; }
.cwi-threads { flex: 1; min-height: 0; overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.cwi-thread { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--cwi-border); border-radius: 10px; background: var(--cwi-surface); padding: 9px 10px; transition: border-color 120ms ease, box-shadow 120ms ease; }
.cwi-thread:hover { border-color: var(--cwi-border); }
.cwi-thread:focus-within { border-color: var(--cwi-accent); box-shadow: 0 0 0 2px var(--cwi-accent-soft); }
.cwi-thread[data-resolved="true"] { opacity: .68; background: transparent; }
.cwi-thread-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 10.5px; color: var(--cwi-soft); }
.cwi-thread .cwi-secondary, .cwi-thread .cwi-primary { padding: 1px 7px; font-size: 10.5px; }
.cwi-comment-author { color: var(--cwi-ink); font-size: 11px; font-weight: 600; }
.cwi-avatar { flex: none; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; background: var(--cwi-ink); color: var(--cwi-surface); font-size: 8.5px; font-weight: 800; }
.cwi-avatar[data-author="model"] { background: var(--cwi-accent-soft); color: var(--cwi-accent); }
.cwi-thread-body { font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: var(--cwi-ink); }
.cwi-thread-reply { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; padding: 7px 8px; border: 1px solid var(--cwi-border-soft); border-radius: var(--cwi-radius-sm); background: var(--cwi-surface-muted); }
.cwi-quote { width: 100%; text-align: left; padding: 5px 8px; border: 0; border-left: 2px solid var(--cwi-accent); border-radius: 0 var(--cwi-radius-xs) var(--cwi-radius-xs) 0; background: var(--cwi-surface-muted); color: var(--cwi-muted); font-family: var(--cwi-mono); font-size: 10.5px; line-height: 1.5; white-space: pre-wrap; cursor: pointer; }
.cwi-quote:hover { background: var(--cwi-accent-soft); color: var(--cwi-ink); }
.cwi-stale { color: var(--cwi-warn); }
.cwi-composer { flex: none; display: flex; flex-direction: column; gap: 7px; margin: 0 10px 10px; padding: 9px; border: 1px solid var(--cwi-border); border-radius: 10px; background: var(--cwi-surface); box-shadow: var(--cwi-shadow); }
.cwi-composer:focus-within { border-color: var(--cwi-accent); box-shadow: 0 0 0 2px var(--cwi-accent-soft); }
.cwi-composer textarea { width: 100%; min-height: 62px; max-height: 200px; resize: vertical; border: 1px solid var(--cwi-border); border-radius: var(--cwi-radius-sm); background: var(--cwi-surface); color: inherit; padding: 7px 9px; font: inherit; font-size: 12px; line-height: 1.6; }
.cwi-composer textarea:focus-visible { outline: none; border-color: var(--cwi-accent); }
.cwi-composer-row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.cwi-composer-hint { font-size: 10.5px; color: var(--cwi-soft); }
.cwi-composer .cwi-receipt { margin: 0; padding: 2px 0; border: 0; background: transparent; box-shadow: none; font-size: 10.5px; color: var(--cwi-muted); }

/* ---------- empty / loading viewer ---------- */
.cwi-viewer-empty { margin: auto; padding: 40px 24px; text-align: center; font-size: 13px; color: var(--cwi-soft); }
.cwi-viewer[data-phase="loading"] .cwi-viewer-empty { animation: cwi-pulse 1.2s ease-in-out infinite; }

/* ---------- scrollbars ---------- */
.cwi-threads, .cwi-content { scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l1, #d0d5dd) transparent; }

@media (max-width: 1180px) {
  .cwi-rail { width: 300px; }
}
@media (max-width: 900px) {
  .cwi-body { flex-direction: column; }
  .cwi-rail { width: auto; max-height: 45%; }
  .cwi-paper { max-width: none; }
  .cwi-path { max-width: 40%; }
}
@media (prefers-reduced-motion: reduce) {
  .cwi-skeleton, .cwi-live-dot, .cwi-activity-dot, .cwi-save-dot, .cwi-viewer[data-phase="loading"] .cwi-viewer-empty { animation: none; }
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
