/**
 * Comment rail stylesheet.
 *
 * Concatenated into the main work-item sheet so it stays under the
 * single-file read budget; the rail, its composer, and the floating annotate
 * entry all live here.
 */
export const RAIL_CSS = `
/* ---------- comment rail ---------- */
.cwi-rail { position: relative; flex: none; min-height: 0; display: flex; flex-direction: column; background: var(--cwi-surface); border: 1px solid var(--cwi-border); border-radius: var(--cwi-radius); box-shadow: var(--cwi-shadow); overflow: hidden; }
.cwi-rail-grip { position: absolute; left: 0; top: 0; bottom: 0; z-index: 2; width: 6px; border-radius: var(--cwi-radius) 0 0 var(--cwi-radius); cursor: col-resize; touch-action: none; background: transparent; transition: background-color 120ms ease; }
.cwi-rail-grip:hover, .cwi-rail-grip:focus-visible, .cwi-rail-grip[data-dragging="true"] { background: var(--cwi-accent-soft); }
.cwi-rail-grip:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: -2px; }
.cwi-rail[hidden] { display: none; }
.cwi-rail-header { flex: none; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 8px; border-bottom: 1px solid var(--cwi-border-soft); }
.cwi-rail-head-row { display: flex; align-items: center; gap: 6px; }
.cwi-rail-spacer { flex: 1; }
.cwi-rail-title { font-size: 12px; font-weight: 700; color: var(--cwi-ink); }
.cwi-rail-sort { color: var(--cwi-soft); font-size: 9.5px; }
.cwi-count-pill { min-width: 20px; padding: 0 6px; border-radius: 999px; background: var(--cwi-surface-muted); color: var(--cwi-muted); font-size: 10px; font-weight: 700; line-height: 18px; text-align: center; }
.cwi-rail-tools { display: flex; align-items: center; gap: 8px; }
.cwi-switch { display: inline-flex; align-items: center; gap: 5px; color: var(--cwi-soft); font-size: 10px; cursor: pointer; user-select: none; }
.cwi-switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.cwi-switch-track { position: relative; width: 20px; height: 11px; border-radius: 999px; background: var(--cwi-border); transition: background-color 120ms ease; }
.cwi-switch-thumb { position: absolute; top: 2px; left: 2px; width: 7px; height: 7px; border-radius: 50%; background: #fff; transition: transform 120ms ease; }
.cwi-switch input:checked + .cwi-switch-track { background: var(--cwi-accent); }
.cwi-switch input:checked + .cwi-switch-track .cwi-switch-thumb { transform: translateX(9px); }
.cwi-switch input:focus-visible + .cwi-switch-track { outline: 2px solid var(--cwi-accent); outline-offset: 2px; }
.cwi-select { height: 20px; max-width: 108px; padding: 0 6px; border: 1px solid var(--cwi-border); border-radius: 6px; background: var(--cwi-surface); color: var(--cwi-muted); font: inherit; font-size: 10px; }
.cwi-select:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-resolved-line { display: flex; align-items: center; gap: 6px; width: 100%; margin-top: 2px; padding: 7px 9px; border: 1px dashed var(--cwi-border); border-radius: 9px; background: var(--cwi-surface); color: var(--cwi-muted); font: inherit; font-size: 10px; text-align: left; cursor: pointer; }
.cwi-resolved-line:hover { background: var(--cwi-surface-muted); }
.cwi-resolved-line:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-resolved-dot { flex: none; width: 15px; height: 15px; display: grid; place-items: center; border-radius: 50%; background: var(--cwi-success-soft); color: var(--cwi-success); font-size: 8px; font-weight: 800; }
.cwi-resolved-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cwi-resolved-arrow { flex: none; color: var(--cwi-soft); }
.cwi-rail-empty { margin: 12px; font-size: 12px; line-height: 1.6; color: var(--cwi-soft); }
.cwi-rail-list, .cwi-rail-session { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.cwi-rail-list > .cwi-rail-receipt { flex: none; margin: 0 10px 10px; }
.cwi-rail-session-head { gap: 6px; }
.cwi-rail-back { padding: 1px 0; border: 0; background: transparent; color: var(--cwi-accent); font: inherit; font-size: 11px; font-weight: 650; cursor: pointer; }
.cwi-rail-back:hover { text-decoration: underline; }
.cwi-rail-back:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 2px; }
.cwi-rail-session-anchor { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.cwi-rail-quote { color: var(--cwi-muted); font-size: 10px; line-height: 1.45; white-space: pre-wrap; }
.cwi-rail-selection { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--cwi-muted); font-size: 10.5px; line-height: 16px; }
.cwi-rail-session-log { flex: 1; min-height: 0; overflow: auto; }
.cwi-thread[data-summary="true"] { cursor: pointer; }
.cwi-activity { flex: none; display: flex; align-items: center; gap: 7px; margin: 8px 10px 0; padding: 6px 8px; border: 1px solid var(--cwi-warn-soft); border-radius: 7px; background: var(--cwi-warn-soft); color: var(--cwi-warn); font-size: 10px; line-height: 1.4; }
.cwi-activity[data-tone="error"] { background: var(--cwi-danger-soft); border-color: var(--cwi-danger-soft); color: var(--cwi-danger); }
.cwi-activity[data-tone="done"] { background: var(--cwi-success-soft); border-color: var(--cwi-success-soft); color: var(--cwi-success); }
.cwi-activity-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: cwi-pulse 1.2s ease-in-out infinite; }
.cwi-activity-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cwi-activity-age { flex: none; opacity: .7; font-size: 9.5px; }
.cwi-threads { flex: 1; min-height: 0; overflow: auto; padding: 9px 10px; display: flex; flex-direction: column; gap: 7px; }
.cwi-thread { display: flex; flex-direction: column; gap: 5px; border: 1px solid var(--cwi-border); border-radius: 9px; background: var(--cwi-surface); padding: 8px 9px 6px; transition: border-color 120ms ease, box-shadow 120ms ease; }
.cwi-thread:hover { border-color: var(--cwi-selected-border); }
.cwi-thread[data-selected="true"] { border-color: var(--cwi-selected-border); box-shadow: 0 0 0 2px var(--cwi-accent-soft); }
.cwi-thread:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 2px; }
.cwi-thread[data-resolved="true"] { opacity: .8; }
.cwi-thread-head { display: flex; align-items: center; gap: 5px; min-width: 0; }
.cwi-thread-author { color: var(--cwi-ink); font-size: 11px; font-weight: 650; }
.cwi-thread-anchor { color: var(--cwi-soft); font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cwi-anchor-chip { flex: none; margin-left: auto; padding: 1px 5px; border-radius: var(--cwi-radius-xs); background: var(--cwi-accent-soft); color: var(--cwi-accent); font-size: 9px; font-weight: 700; }
.cwi-anchor-chip[data-tone="warn"] { background: var(--cwi-warn-soft); color: var(--cwi-warn); }
.cwi-anchor-chip[data-tone="done"] { background: var(--cwi-success-soft); color: var(--cwi-success); }
.cwi-thread-meta { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 9.5px; color: var(--cwi-soft); }
.cwi-thread-time { color: var(--cwi-soft); }
.cwi-comment-author { color: var(--cwi-ink); font-size: 10px; font-weight: 650; }
.cwi-reply-mark { color: var(--cwi-success); font-size: 9px; font-weight: 650; }
.cwi-avatar { flex: none; width: 17px; height: 17px; display: grid; place-items: center; border-radius: 50%; background: var(--cwi-ink); color: var(--cwi-surface); font-size: 7.5px; font-weight: 800; }
.cwi-avatar[data-author="model"] { background: var(--cwi-model-soft); color: var(--cwi-model); }
.cwi-thread-body { font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: var(--cwi-ink); }
.cwi-thread-reply { display: flex; flex-direction: column; gap: 4px; margin-top: 1px; padding: 6px 7px 5px; border: 1px solid var(--cwi-model-border); border-radius: 7px; background: var(--cwi-model-soft); }
.cwi-quote { width: 100%; text-align: left; padding: 4px 7px; border: 0; border-left: 2px solid var(--cwi-quote-border); border-radius: 0 4px 4px 0; background: var(--cwi-quote-bg); color: var(--cwi-muted); font-family: inherit; font-size: 9.5px; line-height: 1.45; white-space: pre-wrap; cursor: pointer; }
.cwi-quote:hover { background: var(--cwi-accent-soft); color: var(--cwi-ink); }
.cwi-quote:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-stale { color: var(--cwi-warn); }
.cwi-thread-summary { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; color: var(--cwi-muted); font-size: 10.5px; }
.cwi-resolved-mark { color: var(--cwi-success); font-size: 9.5px; font-weight: 700; }
.cwi-tstate { display: flex; align-items: center; gap: 6px; padding: 5px 7px; border: 1px solid var(--cwi-warn-soft); border-radius: 7px; background: var(--cwi-warn-soft); color: var(--cwi-warn); font-size: 9.5px; line-height: 1.4; }
.cwi-tstate[data-tone="error"] { border-color: var(--cwi-danger-soft); background: var(--cwi-danger-soft); color: var(--cwi-danger); }
.cwi-tstate[data-tone="done"] { border-color: var(--cwi-success-soft); background: var(--cwi-success-soft); color: var(--cwi-success); }
.cwi-tstate-icon { flex: none; width: 9px; height: 9px; border: 1.5px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: cwi-spin 1.1s linear infinite; }
.cwi-tstate[data-tone="done"] .cwi-tstate-icon, .cwi-tstate-icon[data-state="stale"] { animation: none; border-color: currentColor; }
.cwi-tstate-retry { margin-left: 2px; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: 9.5px; font-weight: 700; text-decoration: underline; cursor: pointer; }
.cwi-tstate-retry:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.cwi-tstate-age { margin-left: auto; opacity: .7; white-space: nowrap; }
.cwi-thread-actions { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.cwi-thread-actions-spacer { flex: 1; }
.cwi-thread-action { padding: 1px 0; border: 0; background: transparent; color: var(--cwi-soft); font: inherit; font-size: 9.5px; font-weight: 600; cursor: pointer; }
.cwi-thread-action:hover { color: var(--cwi-ink); }
.cwi-thread-action:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 2px; }
.cwi-thread-action:disabled { opacity: .55; cursor: default; }
.cwi-attachments { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.cwi-composer { flex: none; display: flex; flex-direction: column; gap: 6px; margin: 0 10px 10px; padding: 8px 9px; border: 1px solid var(--cwi-border); border-radius: 9px; background: var(--cwi-surface); box-shadow: 0 3px 10px #1018280a; }
.cwi-composer:focus-within { border-color: var(--cwi-accent); box-shadow: 0 0 0 2px var(--cwi-accent-soft); }
.cwi-composer-lead { margin: 0; color: var(--cwi-soft); font-size: 9.5px; line-height: 1.4; }
.cwi-composer-selected { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--cwi-muted); font-size: 11px; line-height: 16px; }
.cwi-composer textarea { width: 100%; min-height: 56px; max-height: 200px; resize: vertical; border: 1px solid var(--cwi-border-soft); border-radius: var(--cwi-radius-sm); background: var(--cwi-surface); color: inherit; padding: 6px 8px; font: inherit; font-size: 11.5px; line-height: 1.6; }
.cwi-composer textarea:focus-visible { outline: none; border-color: var(--cwi-accent); }
.cwi-composer-row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.cwi-composer-hint { font-size: 9.5px; color: var(--cwi-soft); }
.cwi-composer .cwi-receipt { margin: 0; padding: 2px 0; border: 0; background: transparent; box-shadow: none; font-size: 9.5px; color: var(--cwi-muted); }
.cwi-annotate-pop { position: fixed; z-index: 10; display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 5px 0 2px; border: 1px solid var(--cwi-border); border-radius: 7px; background: var(--cwi-surface); box-shadow: 0 2px 8px #10182829; }
.cwi-annotate-range { padding: 0 3px; color: var(--cwi-soft); font-size: 10px; font-weight: 600; line-height: 16px; white-space: nowrap; }
.cwi-annotate-button { height: 22px; padding: 0 10px; border-radius: 6px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
.cwi-annotate-button:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-line-annotate { position: absolute; right: 28px; top: 1px; z-index: 1; padding: 1px 7px; border: 1px solid var(--cwi-accent); border-radius: 6px; background: var(--cwi-surface); color: var(--cwi-accent); font: inherit; font-size: 10px; font-weight: 600; line-height: 14px; cursor: pointer; }
.cwi-line-annotate:hover { background: var(--cwi-accent-soft); }
.cwi-line-annotate:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-line-annotate:disabled { opacity: .55; cursor: default; }
.cwi-attach-label { display: inline-flex; align-items: center; }
.cwi-attach-label:focus-within { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-file-input { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@keyframes cwi-spin { to { transform: rotate(360deg); } }
`
