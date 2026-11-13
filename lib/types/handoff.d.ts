/**
 * Handoff module: validate a topic's report and format the record it persists.
 *
 * M10 removed the legacy submit/replay path: the `cowork_handoff` tool writes
 * the file as an audit record, updates the canonical topic, and (for `blocked`)
 * delivers one bounded inbox item. The full handoff text is no longer prompted
 * into the master turn, and nothing rewrites an old handoff file.
 *
 * The module owns no I/O: validation and formatting are pure, and the tool
 * layer supplies the store. The accepted write statuses are `blocked` and
 * `done` only. Reading is deliberately wider — `handoffRecordProblems` in
 * `src/store-schema.ts` still accepts the historical `awaiting_review` value so
 * old files stay readable.
 */
import type { HandoffRecord, HandoffStatus, HandoffVerification } from './store.js';
/** The validated handoff a thread submits. */
export interface HandoffDraft {
    threadId: string;
    masterSessionId: string;
    subject: string;
    status: HandoffStatus;
    summary: string;
    decisions: string[];
    changedPaths: string[];
    artifacts: string[];
    verification: HandoffVerification[];
    openIssues: string[];
    nextStep: string | null;
}
/** One rejected field. */
export interface HandoffFieldError {
    field: string;
    message: string;
}
/** Result of validating untrusted handoff input. */
export type HandoffValidation = {
    ok: true;
    value: HandoffDraft;
} | {
    ok: false;
    errors: HandoffFieldError[];
};
/**
 * Validate untrusted handoff input, collecting every field problem at once.
 * Nothing is written here: a rejected handoff leaves no file and no index
 * change behind.
 */
export declare function validateHandoff(input: unknown): HandoffValidation;
/** Build the persisted record: version 1, `createdAt` from the caller's clock, undelivered. */
export declare function buildHandoffRecord(draft: HandoffDraft, createdAt: Date): HandoffRecord;
/**
 * The message the master receives: a readable summary of the handoff, not the
 * JSON document (the file path is the handle to the full record).
 */
export declare function formatMasterMessage(record: HandoffRecord, filePath: string): string;
