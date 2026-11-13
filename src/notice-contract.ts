/**
 * Pure notice vocabulary shared by the host and the browser.
 *
 * The notice kinds are one frozen list: the host notice ledger
 * (`src/notices.ts`), the client notice cards (`src/client/notice-model.ts`)
 * and the request inbox (`src/inbox-contract.ts`, which appends the read-only
 * `review-verdict` row) all import this module instead of restating the list.
 * It carries names only — no I/O, no clock, no other imports — so both halves
 * of the feature compile against the same vocabulary.
 */

/** The five notice kinds the contract defines. */
export const NOTICE_KINDS = ['assignment', 'report', 'proposal', 'authorization', 'archive'] as const

/** One notice kind. */
export type NoticeKind = (typeof NOTICE_KINDS)[number]

/** Whether a value is one of the five notice kinds. */
export function isNoticeKind(value: unknown): value is NoticeKind {
  return typeof value === 'string' && (NOTICE_KINDS as readonly string[]).includes(value)
}
