/**
 * Stylesheet for the annotation user-node renderer, injected once as a
 * `<style data-plugin-css>` tag.
 *
 * Public theme tokens consumed directly: `--dsw-alias-label-primary`,
 * `--dsw-alias-label-secondary`, `--dsw-alias-label-tertiary`,
 * `--dsw-alias-interactive-bg-hover`, `--dsw-alias-bg-layer-2`,
 * `--dsw-alias-bg-layer-1`, `--dsw-alias-border-l1`, and
 * `--dsw-alias-brand-primary`; every one carries a light-theme fallback so a
 * host without the token still renders.
 *
 * The disclosure row follows the shared visual baseline: 32px row, 8px inline
 * padding, 14px icon, 12px/500 title, 11.5px summary with ellipsis. Body text
 * uses the primary label colour (contrast stays above 4.5:1 in both themes);
 * `prefers-reduced-motion: reduce` drops the chevron transition.
 */

/** Style-tag identity; also the `data-plugin-css` value looked up before mounting. */
const ANNOTATION_STYLE_ID = '@dsh-external/dsh-cowork/annotation'

const MONO_FONT = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"

/**
 * One delivered annotation batch: full-width, left-aligned disclosure row.
 * It is deliberately not a bubble, so a folded delivery reads as context
 * rather than as something the human typed in this turn.
 */
const ANNOTATION_NODE_CSS = `
.cw-annotation-row {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  margin: 2px 0;
}

.cw-annotation-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #5b6470);
  font: inherit;
  font-size: 12px;
  line-height: 32px;
  text-align: left;
  cursor: pointer;
}

.cw-annotation-trigger:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, 0.06));
  color: var(--dsw-alias-label-primary, #1f2329);
}

.cw-annotation-trigger:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #3457d5);
  outline-offset: -2px;
}

.cw-annotation-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: inherit;
}

.cw-annotation-title {
  flex: none;
  font-weight: 500;
}

.cw-annotation-sep {
  flex: none;
  opacity: 0.55;
}

.cw-annotation-summary {
  min-width: 0;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #7b8491);
}

.cw-annotation-chevron {
  flex: none;
  margin-left: 2px;
  transition: transform 120ms ease;
}

.cw-annotation-row[data-open="true"] .cw-annotation-chevron {
  transform: rotate(90deg);
}

.cw-annotation-body {
  max-height: 360px;
  margin: 0 8px 4px;
  padding: 8px 10px;
  overflow: auto;
  border-radius: 6px;
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2, #f2f4f7));
}

.cw-annotation-body[hidden] {
  display: none;
}

.cw-annotation-body:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #3457d5);
  outline-offset: -2px;
}

.cw-annotation-pre {
  margin: 0;
  font-family: ${MONO_FONT};
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-primary, #1f2329);
}

/* Ordinary user message: right-aligned column, host content factory inside. */
.cw-user-row {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  min-width: 0;
}

.cw-user-fallback {
  max-width: 75%;
  padding: 8px 12px;
  border-radius: 12px 2px 12px 12px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-interactive-bg-hover, #f2f4f7));
  color: var(--dsw-alias-label-primary, #1f2329);
  white-space: pre-wrap;
  word-break: break-word;
}

.cw-user-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--dsw-alias-label-tertiary, #7b8491);
  font-size: 10.5px;
  line-height: 1;
}

.cw-user-time {
  font-variant-numeric: tabular-nums;
}

.cw-user-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.cw-user-action:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(31, 35, 41, 0.06));
  color: var(--dsw-alias-label-primary, #1f2329);
}

.cw-user-action:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #3457d5);
  outline-offset: -2px;
}

@media (max-width: 640px) {
  .cw-annotation-summary {
    max-width: 140px;
  }

  .cw-annotation-body {
    max-height: min(50vh, 360px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .cw-annotation-chevron {
    transition: none;
  }
}
`

/**
 * Mount the annotation stylesheet once per document.
 *
 * @param doc - the document to mount into; absent during non-browser tests
 */
export function ensureAnnotationStyles(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): void {
  if (doc === undefined) return
  const selector = `style[data-plugin-css="${ANNOTATION_STYLE_ID}"]`
  if (doc.head.querySelector(selector) !== null) return
  const tag = doc.createElement('style')
  tag.dataset.plugin = ANNOTATION_STYLE_ID
  tag.dataset.pluginCss = ANNOTATION_STYLE_ID
  tag.textContent = ANNOTATION_NODE_CSS
  doc.head.appendChild(tag)
}
