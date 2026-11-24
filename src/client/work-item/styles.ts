/**
 * Work-item stylesheet, mounted once as a `<style data-plugin-css>` tag beside
 * the panel sheet.
 *
 * The sheet follows the artifact demo's document layout: a paper card on a
 * muted workspace, a file strip, a comment rail card, and a status/activity
 * system that reads as part of the host. Every colour and size resolves through
 * a public host token with a literal fallback, so a host without the newer
 * aliases still renders and the dark theme keeps working. The one local alias is
 * `--cw-surface-muted` on the Cowork panel; this sheet does not inherit it (the
 * viewer renders in the conversation area, not inside the panel), so it defines
 * its own `--cwi-*` scale.
 *
 * Layout: the viewer is the body of the session-scoped Cowork conversation
 * view, so it fills the host's view area and owns its scrolling; the comment
 * rail starts collapsed, is 336px beside the content when opened, and becomes a
 * drawer under 900px. Text-based families render on a centred paper card; HTML
 * and canvas fill the remaining height inside their own card. While the viewer
 * is mounted, the host conversation composer is hidden (see the rule below the
 * root block) because the document — not the chat — owns this area.
 *
 * The Markdown reading rhythm lives in `reading-styles.ts` and is concatenated
 * into this one mounted sheet; keeping it separate holds both files under the
 * single-file read budget.
 */
import { MARKDOWN_READ_CSS } from './reading-styles.ts'
import { RAIL_CSS } from './rail-styles.ts'
import { ATTACHMENT_CSS } from './attachment-styles.ts'

export const WORK_ITEM_STYLE_ID = '@dsh-external/dsh-cowork/work-item'

/** The work-item stylesheet text. */
export const WORK_ITEM_CSS = `
.cwi-viewer,
.cwi-list {
  /* Light theme follows the interaction reference's palette. The dark theme
     overrides the whole group with host alias tokens below. */
  --cwi-ink: #101828;
  --cwi-muted: #475467;
  --cwi-soft: #98a2b3;
  --cwi-border: #e4e7ec;
  --cwi-border-soft: #eef0f3;
  --cwi-surface: #fff;
  --cwi-surface-muted: #f2f4f7;
  --cwi-page: #eef1f5;
  --cwi-accent: #175cd3;
  --cwi-accent-soft: #eff8ff;
  --cwi-success: #067647;
  --cwi-success-soft: #ecfdf3;
  --cwi-warn: #b54708;
  --cwi-warn-soft: #fffaeb;
  --cwi-danger: #b42318;
  --cwi-danger-soft: #fef3f2;
  --cwi-model: #6941c6;
  --cwi-model-soft: #f4f3ff;
  --cwi-model-border: #e9e4ff;
  --cwi-gutter: #fbfcfd;
  --cwi-gutter-line: #f1f3f6;
  --cwi-selected-border: #b2ddff;
  --cwi-quote-bg: #f9fbfe;
  --cwi-quote-border: #d1e9ff;
  --cwi-radius: 12px;
  --cwi-radius-sm: 8px;
  --cwi-radius-xs: 4px;
  --cwi-shadow: 0 1px 2px #10182808, 0 1px 1px #10182805;
  --cwi-mono: var(--ds-font-family-code, ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace);
  --cwi-leading: 24px;
  color: var(--cwi-ink);
  font-family: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1.5;
}
body[data-ds-dark-theme] .cwi-viewer,
body[data-ds-dark-theme] .cwi-list {
  --cwi-ink: var(--dsw-alias-label-primary, #e8eaed);
  --cwi-muted: var(--dsw-alias-label-secondary, #b6bcc6);
  --cwi-soft: var(--dsw-alias-label-tertiary, #8b93a1);
  --cwi-border: var(--dsw-alias-border-l2, #2a2f39);
  --cwi-border-soft: var(--dsw-alias-border-l1, #22262e);
  --cwi-surface: var(--dsw-alias-bg-layer-1, #171a20);
  --cwi-surface-muted: var(--dsw-alias-interactive-bg-hover, #1e222a);
  --cwi-page: var(--dsw-alias-bg-document-preview, #12151a);
  --cwi-accent: var(--dsw-alias-state-business-primary, #7aaaff);
  --cwi-accent-soft: var(--dsw-alias-state-business-tertiary, #1b2a44);
  --cwi-success: var(--dsw-alias-state-success-primary, #4ade80);
  --cwi-success-soft: var(--dsw-alias-state-success-tertiary, #14261b);
  --cwi-warn: var(--dsw-alias-state-warn-primary, #fbbf24);
  --cwi-warn-soft: var(--dsw-alias-state-warn-tertiary, #2a2110);
  --cwi-danger: var(--dsw-alias-state-error-primary, #f87171);
  --cwi-danger-soft: var(--dsw-alias-state-error-tertiary, #2a1618);
  --cwi-model: var(--dsw-alias-state-business-primary, #7aaaff);
  --cwi-model-soft: var(--dsw-alias-state-business-tertiary, #1b2a44);
  --cwi-model-border: var(--dsw-alias-border-l2, #2a2f39);
  --cwi-gutter: var(--dsw-alias-bg-layer-1, #171a20);
  --cwi-gutter-line: var(--dsw-alias-border-l1, #22262e);
  --cwi-selected-border: var(--dsw-alias-state-business-primary, #7aaaff);
  --cwi-quote-bg: var(--dsw-alias-bg-layer-2, #1b1f26);
  --cwi-quote-border: var(--dsw-alias-border-l2, #2a2f39);
  --cwi-shadow: 0 1px 2px #00000040, 0 1px 1px #00000026;
}
.cwi-viewer *, .cwi-list * { box-sizing: border-box; }

/* ---------- right-rail work-item list ---------- */
.cwi-list { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 18px; min-height: 0; overflow: auto; }
.cwi-list-toolbar { position: sticky; top: 0; z-index: 2; display: flex; flex-direction: column; gap: 4px; padding: 2px 0 6px; background: var(--dsw-alias-bg-base, #fff); }
.cwi-filter-row { display: flex; flex-wrap: wrap; gap: 6px; }
.cwi-list-tools { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-height: 26px; }
.cwi-search-toggle, .cwi-search-input { height: 26px; border: 1px solid var(--cwi-border); border-radius: 7px; background: var(--cwi-surface); color: var(--cwi-ink); font: inherit; font-size: 11.5px; }
.cwi-search-toggle { padding: 0 10px; font-weight: 600; cursor: pointer; }
.cwi-search-input { width: 168px; padding: 3px 8px; }
.cwi-search-input:focus-visible { outline: none; border-color: var(--cwi-accent); box-shadow: 0 0 0 2px var(--cwi-accent-soft); }
.cwi-search { display: flex; align-items: center; gap: 4px; }
.cwi-search-clear { flex: none; width: 24px; height: 24px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--cwi-muted); font: inherit; font-size: 15px; line-height: 1; cursor: pointer; }
.cwi-search-toggle:hover, .cwi-search-clear:hover, .cwi-group-summary:hover { background: var(--cwi-surface-muted); color: var(--cwi-ink); }
.cwi-search-toggle:focus-visible, .cwi-search-clear:focus-visible, .cwi-group-summary:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-search-loading { color: var(--cwi-soft); font-size: 10.5px; }
.cwi-filter { border: 1px solid var(--cwi-border); background: transparent; color: var(--cwi-muted); border-radius: 999px; padding: 2px 10px; font: inherit; font-size: 11.5px; cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease; }
.cwi-filter:hover { background: var(--cwi-surface-muted); color: var(--cwi-ink); }
.cwi-filter[data-active="true"] { border-color: transparent; background: var(--cwi-accent-soft); color: var(--cwi-accent); font-weight: 600; }
.cwi-filter:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-group { display: flex; flex-direction: column; gap: 6px; }
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
/* 待查看 is shown as 待确认: both stored statuses take the same chip. */
.cwi-card-status[data-status="pending-view"], .cwi-card-status[data-status="pending-confirm"] { background: var(--cwi-accent-soft); color: var(--cwi-accent); }
.cwi-card-status[data-status="needs-feedback"] { background: var(--cwi-danger-soft); color: var(--cwi-danger); }
.cwi-card-status[data-status="in-progress"] { background: var(--cwi-accent-soft); color: var(--cwi-accent); }
.cwi-card-status[data-status="confirmed"] { background: var(--cwi-success-soft); color: var(--cwi-success); }
.cwi-card-title { font-size: 13px; font-weight: 650; line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.cwi-card-meta { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 11px; color: var(--cwi-muted); }
.cwi-card-meta .cwi-chip { padding: 0 6px; line-height: 17px; font-size: 10.5px; font-weight: 500; }
.cwi-card-time { margin-left: auto; color: var(--cwi-soft); font-size: 10.5px; white-space: nowrap; }
.cwi-card-source { color: var(--cwi-soft); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cwi-group-summary { width: 100%; min-height: 34px; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px dashed var(--cwi-border); border-radius: 10px; background: var(--cwi-surface); color: var(--cwi-muted); font: inherit; font-size: 11px; font-weight: 600; text-align: left; cursor: pointer; }
.cwi-group-check { flex: none; width: 15px; height: 15px; display: grid; place-items: center; border-radius: 50%; background: var(--cwi-success-soft); color: var(--cwi-success); font-size: 8px; font-weight: 800; }
.cwi-group-summary-text { flex: 1; }
.cwi-empty, .cwi-error, .cwi-loading { padding: 22px 14px; text-align: center; font-size: 12px; color: var(--cwi-soft); }
.cwi-error { color: var(--cwi-danger); }
.cwi-skeleton-card { border: 1px solid var(--cwi-border); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; background: var(--cwi-surface); }
.cwi-skeleton { height: 62px; border-radius: 10px; background: var(--cwi-surface-muted); animation: cwi-pulse 1.2s ease-in-out infinite; }
.cwi-skeleton-title { height: 13px; width: 55%; }
.cwi-skeleton-line { height: 9px; width: 80%; }
@keyframes cwi-pulse { 50% { opacity: .55; } }

/* ---------- viewer shell ---------- */
.cwi-viewer { isolation: isolate; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: var(--cwi-page); }
/* The Cowork view occupies the conversation area while it is mounted. The host
   composer seat stays in the DOM (its overlay slot cannot be unregistered), so
   it is hidden only while this view is present; Chat restores it with its
   draft and input state untouched. */
[data-conversation-scroll]:has(.cwi-viewer) > [data-composer-seat] { display: none; }
.cwi-viewer-header { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 10px 20px 12px; background: var(--cwi-surface); border-bottom: 1px solid var(--cwi-border-soft); }
.cwi-header-bar { display: flex; align-items: center; gap: 8px; min-height: 22px; }
.cwi-back { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px 2px 5px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--cwi-muted); font: inherit; font-size: 12px; cursor: pointer; transition: background-color 120ms ease, color 120ms ease; }
.cwi-back:hover { background: var(--cwi-surface-muted); color: var(--cwi-ink); }
.cwi-back:disabled { opacity: .5; cursor: default; }
.cwi-back-icon { font-size: 13px; line-height: 1; }
.cwi-cross { flex: none; display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 6px 16px; border-bottom: 1px solid var(--cwi-border); background: var(--cwi-danger-soft); color: var(--cwi-danger); font-size: 12px; }
.cwi-cross-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cwi-cross .cwi-secondary, .cwi-cross-error .cwi-secondary { flex: none; border-color: currentColor; color: inherit; background: var(--cwi-surface); font-size: 11.5px; }
.cwi-cross-error { flex: none; display: flex; align-items: center; gap: 10px; padding: 6px 16px; border-bottom: 1px solid var(--cwi-border); background: var(--cwi-danger-soft); color: var(--cwi-danger); font-size: 12px; }
.cwi-cross-error > span { flex: 1; min-width: 0; }
.cwi-more-wrap { position: relative; flex: none; }
.cwi-more-button { min-width: 28px; padding: 4px 8px; font-weight: 700; }
.cwi-menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 132px; padding: 4px; border: 1px solid var(--cwi-border); border-radius: var(--cwi-radius-sm); background: var(--cwi-surface); box-shadow: 0 8px 24px #1018281f; display: flex; flex-direction: column; }
.cwi-menu-item { text-align: left; padding: 6px 8px; border: 0; border-radius: 5px; background: transparent; color: var(--cwi-ink); font: inherit; font-size: 11px; cursor: pointer; }
.cwi-menu-item:hover { background: var(--cwi-surface-muted); }
.cwi-menu-item:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: -2px; }
.cwi-title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
.cwi-title { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 18px; line-height: 26px; font-weight: 700; letter-spacing: -.015em; color: var(--cwi-ink); }
.cwi-title-spacer { flex: 1; min-width: 8px; }
.cwi-sub { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; min-width: 0; font-size: 11px; color: var(--cwi-soft); }
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
.cwi-type-chip { padding: 1px 6px; border-radius: var(--cwi-radius-xs); background: var(--cwi-accent-soft); color: var(--cwi-accent); font-size: 10px; font-weight: 750; letter-spacing: .03em; }
.cwi-chip[data-tone="error"] { background: var(--cwi-danger-soft); color: var(--cwi-danger); }
.cwi-chip[data-tone="done"] { background: var(--cwi-success-soft); color: var(--cwi-success); }
.cwi-chip[data-tone="pending"] { background: var(--cwi-warn-soft); color: var(--cwi-warn); }
.cwi-chip[data-tone="active"] { background: var(--cwi-accent-soft); color: var(--cwi-accent); }
.cwi-status { flex: none; padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; background: var(--cwi-surface-muted); color: var(--cwi-muted); }
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
.cwi-attach-chips { display: inline-flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; }
.cwi-attach-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 120px; padding: 1px 6px; border: 1px solid var(--cwi-border); border-radius: 5px; background: var(--cwi-surface); color: var(--cwi-muted); font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cwi-attach-dot { flex: none; width: 8px; height: 8px; border-radius: 2px; background: var(--cwi-accent-soft); border: 1px solid var(--cwi-quote-border); }
.cwi-attach-dot[data-type="file"] { background: var(--cwi-surface-muted); border-color: var(--cwi-border); }
.cwi-lines { position: relative; font-family: inherit; font-size: var(--dsh-content-font-size, 14px); line-height: var(--cwi-leading); color: var(--cwi-ink); background: linear-gradient(90deg, var(--cwi-gutter) 0 48px, var(--cwi-gutter-line) 48px 49px, transparent 49px); }
.cwi-lines:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: -2px; }
.cwi-lines:focus-within .cwi-line[data-active="true"] { box-shadow: inset 0 0 0 2px var(--cwi-accent); }
.cwi-line { position: relative; display: flex; align-items: flex-start; gap: 8px; padding: 1px 40px 1px 60px; white-space: pre-wrap; overflow-wrap: anywhere; border-left: 2px solid transparent; cursor: text; }
.cwi-line:hover { background: var(--cwi-surface-muted); }
.cwi-line[data-selected="true"] { background: var(--cwi-accent-soft); border-left-color: var(--cwi-accent); }
.cwi-line[data-anchored="true"] { border-left-color: var(--cwi-accent); }
.cwi-line-number { position: absolute; left: 12px; top: 0; width: 36px; text-align: right; color: var(--cwi-soft); font-family: var(--cwi-mono); font-size: 10.5px; line-height: var(--cwi-leading); user-select: none; }
.cwi-line-pin { position: absolute; right: 6px; top: 2px; z-index: 1; min-width: 17px; height: 17px; padding: 0 4px; display: inline-grid; place-items: center; border: 2px solid var(--cwi-surface); border-radius: 999px; background: var(--cwi-accent); color: #fff; font-family: inherit; font-size: 8px; font-weight: 800; line-height: 1; box-shadow: 0 1px 3px #1018282e; cursor: pointer; }
.cwi-line-pin:focus-visible { outline: 2px solid var(--cwi-ink); outline-offset: 1px; }
.cwi-line-pin[data-tone="resolved"] { background: var(--cwi-success); }
.cwi-line-pin[data-tone="stale"] { background: var(--cwi-warn); }
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
.cwi-md-code { font-family: var(--cwi-mono); font-size: 12px; line-height: 20px; background: var(--dsw-alias-markdown-code-block, var(--cwi-surface-muted)); padding: 1px 10px; white-space: pre-wrap; }
.cwi-md-fence { display: block; height: 4px; }
.cwi-line[data-stale="true"] { background: var(--cwi-warn-soft); }
.cwi-line[data-stale="true"] .cwi-line-text { color: var(--cwi-warn); }
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

${MARKDOWN_READ_CSS}

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
${ATTACHMENT_CSS}
.cwi-receipt { margin: 0 0 8px; padding: 7px 12px; border: 1px solid var(--cwi-border); border-radius: var(--cwi-radius-sm); background: var(--cwi-surface); font-size: 12px; color: var(--cwi-muted); box-shadow: var(--cwi-shadow); }
.cwi-receipt[data-tone="error"] { border-color: var(--cwi-danger); background: var(--cwi-danger-soft); color: var(--cwi-danger); }
.cwi-conflict { display: flex; flex-direction: column; gap: 8px; margin: 0 0 8px; padding: 10px 12px; border: 1px solid var(--cwi-danger); border-radius: var(--cwi-radius-sm); background: var(--cwi-danger-soft); color: var(--cwi-ink); font-size: 12px; }
.cwi-conflict-diff { display: flex; flex-direction: column; gap: 4px; }
.cwi-conflict-latest { margin: 0; max-height: 180px; overflow: auto; font-family: var(--cwi-mono); font-size: 11px; white-space: pre-wrap; border-left: 2px solid var(--cwi-border); padding-left: 8px; }

${RAIL_CSS}

/* ---------- missing file: rebind entry ---------- */
.cwi-rebind { flex: none; display: flex; flex-direction: column; gap: 6px; margin: 10px 14px 0; padding: 10px 12px; border: 1px solid var(--cwi-warn); border-radius: var(--cwi-radius-sm); background: var(--cwi-warn-soft); color: var(--cwi-ink); font-size: 12px; }
.cwi-rebind-title { font-weight: 650; }
.cwi-rebind-hint { margin: 0; color: var(--cwi-muted); font-size: 11px; line-height: 1.5; }
.cwi-rebind-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.cwi-rebind-input { flex: 1 1 220px; min-width: 0; padding: 4px 8px; border: 1px solid var(--cwi-border); border-radius: 7px; background: var(--cwi-surface); color: var(--cwi-ink); font: inherit; font-size: 12px; }
.cwi-rebind-input:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-rebind-error { color: var(--cwi-danger); font-size: 11px; font-weight: 600; }

/* ---------- load older comments ---------- */
.cwi-older { align-self: stretch; padding: 5px 9px; border: 1px dashed var(--cwi-border); border-radius: 9px; background: var(--cwi-surface); color: var(--cwi-muted); font: inherit; font-size: 10.5px; font-weight: 600; cursor: pointer; }
.cwi-older:hover { background: var(--cwi-surface-muted); }
.cwi-older:disabled { opacity: .6; cursor: default; }
.cwi-older:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-rail-close { margin-left: 4px; padding: 1px 8px; border: 1px solid var(--cwi-border); border-radius: 6px; background: var(--cwi-surface); color: var(--cwi-ink); font: inherit; font-size: 10px; font-weight: 600; cursor: pointer; }
.cwi-rail-close:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }

/* ---------- viewer footer ---------- */
.cwi-viewer-foot { flex: none; display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 0 16px; border-top: 1px solid var(--cwi-border); background: var(--cwi-surface); color: var(--cwi-soft); font-size: 10px; }
.cwi-foot-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cwi-foot-spacer { flex: 1; }
.cwi-foot-meta { white-space: nowrap; }
.cwi-foot-dot { width: 3px; height: 3px; border-radius: 50%; background: var(--cwi-border); }

/* ---------- empty / loading viewer ---------- */
.cwi-viewer-empty { margin: auto; padding: 40px 24px; text-align: center; font-size: 13px; color: var(--cwi-soft); }
.cwi-viewer[data-phase="loading"] .cwi-viewer-empty { animation: cwi-pulse 1.2s ease-in-out infinite; }

/* ---------- scrollbars ---------- */
.cwi-threads, .cwi-content { scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l1, #d0d5dd) transparent; }

@media (max-width: 1180px) {
  .cwi-rail { width: 300px; }
}
@media (max-width: 900px) {
  .cwi-body { position: relative; flex-direction: column; }
  .cwi-toolbar { flex-wrap: wrap; row-gap: 4px; }
  .cwi-rail { position: absolute; left: 0; right: 0; bottom: 0; top: auto; z-index: 31; width: auto; max-height: min(72%, 560px); border-radius: 14px 14px 0 0; box-shadow: 0 -12px 32px #1018282e; }
  .cwi-rail[hidden] { display: none; }
  .cwi-rail-backdrop { position: absolute; inset: 0; z-index: 30; background: #10182866; }
  .cwi-paper { max-width: none; }
  .cwi-path { max-width: 40%; }
}
@media (max-width: 1023px) {
  .cwi-md-read { padding: 24px 32px 40px 20px; }
  .cwi-md-pin { right: -25px; }
}
@media (max-width: 899px) {
  .cwi-md-read { padding: 24px 28px 40px 20px; }
  .cwi-md-read h1 { font-size: 28px; line-height: 36px; }
  .cwi-md-read h2 { font-size: 20px; line-height: 27px; }
  .cwi-md-read h3 { font-size: 16px; line-height: 22px; }
  .cwi-md-pin { right: -21px; }
}
@media (max-width: 639px) {
  .cwi-md-read { padding: 20px 24px 32px 16px; font-size: 15px; line-height: 25px; }
  .cwi-md-read h1 { font-size: 26px; line-height: 34px; }
  .cwi-md-read h2 { font-size: 19px; line-height: 26px; }
  .cwi-md-read h3 { font-size: 16px; line-height: 22px; }
  .cwi-md-pin { right: -17px; }
}
@media (prefers-reduced-motion: reduce) {
  .cwi-skeleton, .cwi-live-dot, .cwi-activity-dot, .cwi-save-dot, .cwi-tstate-icon, .cwi-viewer[data-phase="loading"] .cwi-viewer-empty { animation: none; }
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
