/**
 * Attachment stylesheet: page rows, the model-source badge, and the preview
 * overlay.
 *
 * Concatenated into the main work-item sheet (after the shared panel rules) so the
 * main sheet stays under the single-file read budget. Every colour resolves
 * through the shared `--cwi-*` tokens, and the preview keeps the §9.2 viewport
 * sizing in one place.
 */
export const ATTACHMENT_CSS = `
/* ---------- attachments: page rows ---------- */
.cwi-attachment-row { display: flex; align-items: center; gap: 12px; border: 1px solid var(--cwi-border); border-radius: 10px; padding: 8px 10px; background: var(--cwi-surface); }
.cwi-attachment-open { flex: none; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 6px; background: transparent; cursor: zoom-in; }
.cwi-attachment-open:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 2px; }
.cwi-attachment-row .cwi-attachment-open { border: 1px solid var(--cwi-border-soft); background: var(--cwi-surface-muted); overflow: hidden; }
.cwi-attachment-row .cwi-attachment-thumb { width: 32px; height: 32px; max-width: none; max-height: none; border: 0; border-radius: 0; object-fit: cover; }
.cwi-attachment-file { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 6px; background: var(--cwi-accent-soft); color: var(--cwi-accent); font-size: 9px; font-weight: 700; }
.cwi-attachment-file[data-missing="true"] { background: var(--cwi-danger-soft); color: var(--cwi-danger); }
.cwi-attachment-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12px; overflow-wrap: anywhere; }
.cwi-attachment-name { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.cwi-attachment-model { flex: none; padding: 1px 6px; border: 1px solid var(--cwi-model-border); border-radius: 5px; background: var(--cwi-model-soft); color: var(--cwi-model); font-size: 8.5px; font-weight: 700; line-height: 16px; white-space: nowrap; }
.cwi-attachment-item { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.cwi-attachment-thumb { max-width: 220px; max-height: 160px; border-radius: var(--cwi-radius-sm); border: 1px solid var(--cwi-border-soft); display: block; }
.cwi-attachment-link { font-size: 11px; color: var(--cwi-accent); word-break: break-all; }

/* ---------- attachment preview overlay ---------- */
.cwi-preview-backdrop { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; padding: 12px; background: rgba(16,24,40,.72); }
.cwi-preview { display: flex; flex-direction: column; width: min(calc(100vw - 24px), 1600px); height: min(calc(100vh - 24px), 1100px); border-radius: 14px; background: var(--cwi-surface); box-shadow: 0 24px 80px rgba(16,24,40,.35); overflow: hidden; }
.cwi-preview-head, .cwi-preview-foot { flex: none; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 14px; }
.cwi-preview-head { border-bottom: 1px solid var(--cwi-border-soft); }
.cwi-preview-foot { flex-wrap: wrap; row-gap: 4px; border-top: 1px solid var(--cwi-border-soft); padding: 6px 14px; }
.cwi-preview-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 650; color: var(--cwi-ink); }
.cwi-preview-close { margin-left: auto; flex: none; width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--cwi-muted); font: inherit; font-size: 18px; line-height: 1; cursor: pointer; }
.cwi-preview-close:hover { background: var(--cwi-surface-muted); color: var(--cwi-ink); }
.cwi-preview-close:focus-visible, .cwi-preview-tool:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-preview-stage { flex: 1; min-height: 0; display: flex; align-items: flex-start; justify-content: flex-start; overflow: auto; padding: 12px 56px 52px; background: var(--cwi-surface-muted); }
.cwi-preview-stage[data-kind="text"] { display: block; padding: 12px 16px; }
.cwi-preview-stage[data-zoom="true"] { cursor: grab; }
.cwi-preview-stage[data-zoom="true"]:active { cursor: grabbing; }
.cwi-preview-image { display: block; flex: none; margin: auto; max-width: none; }
.cwi-preview-text { margin: 0; width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--cwi-mono); font-size: 12px; line-height: 1.6; color: var(--cwi-ink); }
.cwi-preview-unknown { margin: auto; color: var(--cwi-soft); font-size: 12px; text-align: center; }
.cwi-preview-missing { display: flex; flex-direction: column; align-items: center; gap: 8px; margin: auto; padding: 32px 16px; border: 1px dashed var(--cwi-border); border-radius: 10px; color: var(--cwi-muted); font-size: 12px; text-align: center; }
.cwi-preview-missing-mark { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 50%; background: var(--cwi-danger-soft); color: var(--cwi-danger); font-weight: 800; }
.cwi-preview-tool { height: 26px; min-width: 26px; padding: 0 8px; border: 1px solid var(--cwi-border); border-radius: 7px; background: var(--cwi-surface); color: var(--cwi-ink); font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; }
.cwi-preview-tool:hover { background: var(--cwi-surface-muted); }
.cwi-preview-tool:disabled { opacity: .5; cursor: default; }
.cwi-preview-zoom { min-width: 44px; text-align: center; color: var(--cwi-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.cwi-preview-hint { color: var(--cwi-soft); font-size: 10.5px; }
.cwi-preview-spacer { flex: 1; }
.cwi-preview-download { display: inline-flex; align-items: center; height: 26px; padding: 0 12px; text-decoration: none; }

@media (max-width: 639px) {
  .cwi-preview-backdrop { padding: 6px; }
  .cwi-preview { width: min(calc(100vw - 12px), 1600px); height: min(calc(100vh - 12px), 1100px); }
  .cwi-preview-head, .cwi-preview-foot { min-height: 0; padding: 6px 10px; flex-wrap: wrap; }
  .cwi-preview-stage { padding: 6px 6px 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .cwi-preview-tool, .cwi-preview-close, .cwi-attachment-open { transition: none; }
}
`
