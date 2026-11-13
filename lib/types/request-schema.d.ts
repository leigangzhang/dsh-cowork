import type { InboxAnswerInput, QuestionPayload, QuestionSpec, RequestDelivery, RequestKind, RequestPayload, RequestRecordV1, RequestStatus, ReviewVerification } from './inbox-contract.js';
/** Directory holding one file per request, below `<repo>/.dsh-cowork`. */
export declare const REQUEST_DIR_NAME = "requests";
/** Suffix of every request file; the file name is the bare request id. */
export declare const REQUEST_FILE_SUFFIX = ".json";
/** Longest request id this module accepts (a UUID in production). */
export declare const REQUEST_ID_MAX_CHARS = 64;
/** Longest prompt failure kept in `delivery.lastError`. */
export declare const REQUEST_DELIVERY_ERROR_MAX_CHARS = 300;
/**
 * Longest wake-up prompt rebuilt from a resolution. The comment alone can reach
 * 2000 characters, so the prompt needs more room than the 200-character reply
 * while still staying a bounded host queue message.
 */
export declare const RESOLUTION_PROMPT_MAX_CHARS = 4000;
/** Why one request document was refused. */
export declare class RequestSchemaError extends Error {
    readonly problems: string[];
    constructor(message: string, problems: string[]);
}
/** Whether a value is a safe request id: file-name characters only, no dot. */
export declare function isRequestId(value: unknown): value is string;
/** The file name of one request; the id can never carry a path separator. */
export declare function requestFileName(requestId: string): string;
/** Delivery state of a request that has never been prompted. */
export declare function emptyDelivery(): RequestDelivery;
/** Whether a repo-relative POSIX path stays inside the repository. */
export declare function isRepoRelativePosixPath(value: unknown, limit: number): value is string;
/** Problems of the payload matching `kind`; `[]` means it is valid. */
export declare function payloadProblems(kind: RequestKind, payload: unknown): string[];
/**
 * Validate the answers of one `question` submit. Every question must be
 * answered by at least one selected option or a text answer; an unknown
 * question, an unknown option, more than one selection in `single` mode and a
 * text over its cap are each their own problem. The caller maps all of them to
 * `inbox/invalid-answer`.
 */
export declare function answerProblems(payload: QuestionPayload, answers: readonly InboxAnswerInput[] | undefined): string[];
/** Problems of one persisted request record; `[]` means it is valid. */
export declare function requestRecordProblems(record: unknown): string[];
/** One parse of a request file: the record, or the problems it carries. */
export type ParsedRequestRecord = {
    readonly ok: true;
    readonly record: RequestRecordV1;
} | {
    readonly ok: false;
    readonly problems: string[];
};
/** Parse one request document without touching the file system. */
export declare function parseRequestRecordText(text: string): ParsedRequestRecord;
/** The short summary line the list row carries, derived from the payload. */
export declare function defaultSummary(kind: RequestKind, payload: RequestPayload): string;
/** The persisted left-hand message: the topic speaks, then states the ask. */
export declare function requestMessage(kind: RequestKind, topicTitle: string, payload: RequestPayload): string;
/**
 * The right-hand user reply persisted when a request is resolved. The browser
 * shows exactly this text; the answers summary and the optional comment are
 * folded into it and the whole reply is bounded to
 * {@link RESOLUTION_MESSAGE_MAX_CHARS}. The full comment and every answer stay
 * in {@link RequestRecordV1.resolution}, so nothing important survives only as
 * this truncated display string.
 */
export declare function resolutionMessage(status: RequestStatus, comment?: string, answersSummary?: string): string;
/**
 * The full wake-up prompt of one terminal request: every question with its
 * selected option labels and free text, then the complete comment. A record
 * without a `resolution` block falls back to its stored reply, and a record
 * without either still yields the status headline.
 */
export declare function resolutionPrompt(record: RequestRecordV1): string;
/** Trimmed comment as the record persists it, or null when absent/blank. */
export declare function normalizeComment(comment: unknown): string | null | 'invalid';
/** One request record to persist. */
export interface NewRequestInput {
    readonly requestId: string;
    readonly projectId: string;
    readonly topicId: string;
    readonly kind: RequestKind;
    readonly title: string;
    readonly summary?: string;
    readonly payload: RequestPayload;
    readonly now: Date;
}
/**
 * Build one pending record from validated input, including both persisted
 * messages. Throws {@link RequestSchemaError} when the input does not satisfy
 * the schema, so a caller can never persist a half-valid request.
 */
export declare function buildRequestRecord(input: NewRequestInput): RequestRecordV1;
/** One terminal transition to persist. */
export interface ResolutionPatchInput {
    readonly status: RequestStatus;
    readonly comment?: string;
    /** The validated answers of a `question` submit; other kinds carry none. */
    readonly answers?: readonly InboxAnswerInput[];
    readonly resolvedBy: 'user' | 'master';
    readonly now: Date;
}
/** Apply one terminal transition to a pending record; the caller validates status. */
export declare function applyResolution(record: RequestRecordV1, input: ResolutionPatchInput): RequestRecordV1;
/** Whether one action is offered by one kind (kind only, not status). */
export declare function kindOffersAction(kind: RequestKind, action: unknown): boolean;
/** One question row with ids minted as q1..qn / o1..on. */
export declare function normalizeQuestion(question: unknown, index: number): QuestionSpec;
/** A verification row as the record persists it. */
export declare function normalizeVerification(row: unknown): ReviewVerification;
