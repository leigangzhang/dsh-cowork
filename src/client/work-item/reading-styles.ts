/**
 * Markdown reading surface styles.
 *
 * Kept beside the work-item sheet instead of inline: the shell sheet is a
 * budgeted file (50 KiB read limit), and the reading rhythm is a self-contained
 * block that only the flow renderer uses. `styles.ts` concatenates it into the
 * one mounted stylesheet.
 */
export const MARKDOWN_READ_CSS = `
/* ---------- Markdown reading surface ---------- */
/* Flow content replaces the numbered line list for Markdown in read mode; the
   source lines stay the annotation address space and appear as data-src-*
   attributes on each block. The paper body drops its own padding so the
   reading column owns the 28/40/40/24 rhythm from the design. */
.cwi-paper-body:has(> .cwi-md-read) { padding: 0; }
.cwi-md-read {
  width: 100%;
  padding: 28px 40px 40px 24px;
  color: var(--cwi-ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 15px;
  line-height: 26.25px;
  overflow-wrap: break-word;
}
.cwi-md-read ::selection { background: #b2ddff; color: inherit; }
body[data-ds-dark-theme] .cwi-md-read ::selection { background: color-mix(in srgb, var(--cwi-accent) 24%, transparent); }
.cwi-md-block { position: relative; max-width: 100%; }
.cwi-md-read h1 { margin: 0 0 .7em; color: var(--cwi-ink); font-size: 30px; line-height: 39px; font-weight: 700; letter-spacing: 0; }
.cwi-md-read h2 { margin: 1.6em 0 .6em; color: var(--cwi-ink); font-size: 21px; line-height: 1.35; font-weight: 600; }
.cwi-md-read h3 { margin: 1.4em 0 .5em; color: var(--cwi-ink); font-size: 17.25px; line-height: 1.4; font-weight: 600; }
.cwi-md-read h4, .cwi-md-read h5, .cwi-md-read h6 { margin: 21px 0 9px; color: var(--cwi-ink); font-size: 15px; line-height: 24px; font-weight: 600; }
.cwi-md-read p { margin: 0 0 .9em; }
.cwi-md-read strong { font-weight: 650; }
.cwi-md-read em { font-style: italic; }
.cwi-md-read del { color: var(--cwi-muted); text-decoration: line-through; }
.cwi-md-link { color: var(--cwi-accent); text-decoration: none; }
.cwi-md-link:hover { text-decoration: underline; }
.cwi-md-link-text { color: inherit; }
.cwi-md-read code { padding: 2px 6px; border-radius: 4px; background: var(--dsw-alias-markdown-inline-code, var(--cwi-surface-muted)); color: var(--cwi-ink); font-family: var(--cwi-mono); font-size: 12.9px; line-height: inherit; }
.cwi-md-pre { margin: 0 0 15px; padding: 14px 16px; overflow: auto; border-radius: 6px; background: var(--dsw-alias-markdown-code-block, var(--cwi-surface-muted)); color: var(--cwi-ink); font-family: var(--cwi-mono); font-size: 12.75px; line-height: 24px; white-space: pre; }
.cwi-md-pre code { padding: 0; border-radius: 0; background: none; font-size: inherit; line-height: inherit; }
.cwi-md-read ul, .cwi-md-read ol { margin: 0 0 .9em 1.6em; padding: 0; }
.cwi-md-read li { margin: 4px 0; }
.cwi-md-read li > ul, .cwi-md-read li > ol { margin-bottom: 0; }
.cwi-md-read li > p { margin: 0; }
.cwi-md-read blockquote { margin: 0 0 15px; padding: 2px 0 2px 15px; border-left: 3px solid var(--cwi-border); color: var(--cwi-muted); }
.cwi-md-read blockquote p { margin: 0; }
.cwi-md-hr { margin: 27px 0; }
.cwi-md-hr hr { margin: 0; border: 0; border-top: 1px solid var(--cwi-border-soft); }
.cwi-md-table-block { margin: 0 0 15px; }
.cwi-md-table-wrap { overflow-x: auto; border-radius: 6px; }
.cwi-md-table { width: 100%; border-collapse: collapse; font-size: 15px; line-height: 26.25px; }
.cwi-md-table th, .cwi-md-table td { padding: 6px 12px; border: 1px solid var(--cwi-border); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.cwi-md-table th { background: var(--dsw-alias-bg-layer-2, var(--cwi-surface-muted)); font-weight: 600; }
.cwi-md-figure { margin: 0 0 15px; }
.cwi-md-image { display: block; max-width: 100%; height: auto; border: 1px solid var(--cwi-border-soft); border-radius: 8px; }
.cwi-md-figcaption { margin-top: 6px; color: var(--cwi-soft); font-size: 11px; line-height: 18px; }
.cwi-md-image-fallback { display: flex; align-items: center; justify-content: center; min-height: 96px; padding: 12px; border: 1px dashed var(--cwi-border); border-radius: 8px; background: var(--cwi-surface-muted); color: var(--cwi-soft); font-size: 11px; line-height: 18px; }
.cwi-md-list:has(> .cwi-md-task) { margin-left: 0; padding-left: 0; list-style: none; }
.cwi-md-task { list-style: none; padding-left: 22px; }
.cwi-md-task-box { position: absolute; left: 0; top: 5px; width: 14px; height: 14px; margin: 0; border-radius: 3px; border: 1px solid var(--cwi-border); background: var(--cwi-surface); accent-color: var(--cwi-success); }
.cwi-md-frontmatter { margin: 0 0 20px; border: 1px solid var(--cwi-border); border-radius: 6px; background: var(--cwi-surface-muted); }
.cwi-md-frontmatter summary { padding: 6px 12px; color: var(--cwi-muted); font-size: 12px; line-height: 21px; cursor: pointer; user-select: none; }
.cwi-md-frontmatter summary:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: -2px; }
.cwi-md-frontmatter-body { margin: 0; padding: 10px 12px; border-top: 1px solid var(--cwi-border); border-radius: 0 0 6px 6px; background: var(--cwi-surface); color: var(--cwi-muted); font-family: var(--cwi-mono); font-size: 12px; line-height: 19.2px; white-space: pre-wrap; max-height: 240px; overflow: auto; }
.cwi-md-pin { position: absolute; right: -33px; top: 2px; z-index: 2; display: inline-grid; place-items: center; min-width: 17px; height: 17px; padding: 0 4px; border: 2px solid var(--cwi-surface); border-radius: 999px; background: var(--cwi-accent); color: #fff; font-family: inherit; font-size: 8px; font-weight: 800; line-height: 1; box-shadow: 0 1px 3px #1018282e; cursor: pointer; }
.cwi-md-pin[data-tone="resolved"] { background: var(--cwi-success); }
.cwi-md-pin[data-tone="stale"] { background: var(--cwi-warn); }
.cwi-md-pin:focus-visible { outline: 2px solid var(--cwi-ink); outline-offset: 1px; }
.cwi-md-pin-tip { display: none; position: absolute; right: 0; top: -23px; padding: 1px 5px; border-radius: 4px; background: var(--cwi-accent-soft); color: var(--cwi-accent); font-size: 9px; font-weight: 700; line-height: 16px; white-space: nowrap; }
.cwi-md-pin:hover .cwi-md-pin-tip, .cwi-md-pin:focus-visible .cwi-md-pin-tip { display: block; }
.cwi-md-thread-target { background: var(--cwi-accent-soft); box-shadow: inset 2px 0 0 var(--cwi-accent); }
.cwi-md-selection { position: fixed; z-index: 10; display: flex; align-items: center; gap: 6px; height: 36px; padding: 4px 8px; border: 1px solid var(--cwi-border); border-radius: 10px; background: var(--cwi-surface); box-shadow: 0 8px 24px #10182829; }
.cwi-md-selection-range { padding: 0 3px; color: var(--cwi-soft); font-size: 9px; font-weight: 600; line-height: 16px; white-space: nowrap; }
.cwi-md-selection-button { height: 26px; padding: 0 12px; border-radius: 7px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
.cwi-md-selection-button:focus-visible { outline: 2px solid var(--cwi-accent); outline-offset: 1px; }
.cwi-md-html-block { margin: 0 0 15px; white-space: pre-wrap; font-family: var(--cwi-mono); font-size: 12.75px; line-height: 20px; color: var(--cwi-muted); }
`
