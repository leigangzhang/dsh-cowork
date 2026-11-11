/**
 * Geometry of the topic-page / request-inbox layout.
 *
 * `src/client/styles.ts` interpolates these into `PANEL_CSS`, so the CSS the
 * browser gets and the numbers the panel reasons about are the same values.
 * They live in their own leaf module because both the stylesheet and the
 * view-model tests need them without importing each other.
 */

/** Below the wide threshold, this is the narrowest the inbox column may get. */
export const INBOX_COLUMN_MIN_PX = 280

/** Width of the fixed topic column inside the wide two-column layout. */
export const TOPIC_COLUMN_WIDTH_PX = 318

/** Gap between the topic column and the inbox column. */
export const INBOX_COLUMN_GAP_PX = 12
