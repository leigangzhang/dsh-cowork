/**
 * The two `cowork_review_*` tools and the review-request lifecycle (M10.3).
 *
 * This module owns the flow that used to live in `src/review.ts` plus the tool
 * orchestration: deterministic request pre-checks, the request file (write
 * pending, replace with the verdict), the canonical index updates, the reviewer
 * brief, the verdict notifications, and the reviewer archive. The pure request
 * model (validation, records, brief, gates) lives in `src/review-request.ts`;
 * the reviewer lifecycle lives in `src/session-visibility.ts`.
 *
 * File I/O uses the store's text port and the project lock, so `src/store.ts`
 * grows no business code. Request files are read through the same directory the
 * legacy verdict files live in; only files that parse as the request model take
 * part in de-duplication, so an old verdict-only file is never mistaken for a
 * pending request.
 */
import { randomUUID } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildActivityEvent } from './activity.js';
import { describeError } from './checkout-teardown.js';
import { Inbox, InboxMarkError } from './inbox.js';
import { buildRejectMessage, buildReviewBrief, buildRevisionMessage, buildReviewRequestRecord, checkPreviousRequest, deriveReviewOutcome, parseReviewRequestRecord, reviewRequestFileName, reviewRequestFilePath, reviewRequestRecordProblems, serializeReviewRequestRecord, validateReviewRequestInput, validateReviewVerdictInput, } from './review-request.js';
import { archiveReviewerAfterVerdict, createReviewerSession } from './session-visibility.js';
import { ERROR_CODES, M10_ERROR_CODES, REVIEW_FINDING_PARAMETER, REVIEW_VERIFICATION_PARAMETER, failure, success, } from './tool-model.js';
import { runGit } from './tool-runtime.js';
import { ACTIVE_WORK_ITEM_STATUSES, markWorkItem } from './work-item.js';
/** A git invocation failure the tool returns instead of throwing. */
function gitFailure(args, cwd, result) {
    const detail = result.stderr.trim() === '' ? `exit ${result.code}` : result.stderr.trim();
    return failure(ERROR_CODES.checkoutGitFailed, `git ${args.join(' ')} failed in ${cwd}: ${detail}`, {
        args: [...args],
        cwd,
        exitCode: result.code,
    });
}
/** Resolve a ref to a full commit id, or null when this path does not know it. */
async function commitAt(git, cwd, ref) {
    const result = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    if (result.code !== 0)
        return null;
    const sha = result.stdout.trim();
    return sha === '' ? null : sha;
}
/**
 * The deterministic request checks that need git, run before any session or
 * file exists: the two commits resolve, they differ, base is head's ancestor,
 * the reviewed path is clean, the range has a diff, and a caller-supplied
 * changedPaths agrees with what git derives.
 */
async function checkRequestRange(git, path, baseInput, headInput, givenChangedPaths) {
    const baseCommit = await commitAt(git, path, baseInput);
    const headCommit = await commitAt(git, path, headInput);
    if (baseCommit === null || headCommit === null) {
        return {
            ok: false,
            failure: failure(M10_ERROR_CODES.reviewRequestInvalid, 'baseCommit and headCommit must name commits of the reviewed path', { baseCommit: baseInput, headCommit: headInput, baseFound: baseCommit !== null, headFound: headCommit !== null }),
        };
    }
    if (baseCommit === headCommit) {
        return {
            ok: false,
            failure: failure(M10_ERROR_CODES.reviewBaseEqualsHead, 'baseCommit and headCommit must differ', {
                baseCommit,
                headCommit,
            }),
        };
    }
    const ancestryArgs = ['merge-base', '--is-ancestor', baseCommit, headCommit];
    const ancestry = await git(ancestryArgs, path);
    if (ancestry.code === 1) {
        return {
            ok: false,
            failure: failure(M10_ERROR_CODES.reviewBaseNotAncestor, `baseCommit ${baseCommit} is not an ancestor of headCommit ${headCommit}`, { baseCommit, headCommit }),
        };
    }
    if (ancestry.code !== 0)
        return { ok: false, failure: gitFailure(ancestryArgs, path, ancestry) };
    const statusArgs = ['status', '--porcelain'];
    const status = await git(statusArgs, path);
    if (status.code !== 0)
        return { ok: false, failure: gitFailure(statusArgs, path, status) };
    const dirty = status.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '');
    if (dirty.length > 0) {
        return {
            ok: false,
            failure: failure(M10_ERROR_CODES.reviewDirtyWorktree, `the reviewed path has uncommitted changes; commit or discard them before requesting a review`, { path, entries: dirty.slice(0, 20) }),
        };
    }
    const diffArgs = ['diff', '--name-only', `${baseCommit}..${headCommit}`];
    const diff = await git(diffArgs, path);
    if (diff.code !== 0)
        return { ok: false, failure: gitFailure(diffArgs, path, diff) };
    const changedPaths = diff.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .sort();
    if (changedPaths.length === 0) {
        return {
            ok: false,
            failure: failure(M10_ERROR_CODES.reviewEmptyDiff, `baseCommit..headCommit has no changed file; there is nothing to review`, { baseCommit, headCommit }),
        };
    }
    if (givenChangedPaths !== undefined) {
        const given = Array.isArray(givenChangedPaths)
            ? [...new Set(givenChangedPaths.map((entry) => String(entry)))].sort()
            : null;
        const mismatch = given === null
            || given.length !== changedPaths.length
            || given.some((entry, index) => entry !== changedPaths[index]);
        if (mismatch) {
            return {
                ok: false,
                failure: failure(M10_ERROR_CODES.reviewChangedPathsMismatch, 'changedPaths does not match git diff --name-only baseCommit..headCommit; the review range is derived, not declared', { expected: changedPaths.slice(0, 100), given: (given ?? []).slice(0, 100) }),
            };
        }
    }
    const branchArgs = ['rev-parse', '--abbrev-ref', 'HEAD'];
    const branchResult = await git(branchArgs, path);
    const rawBranch = branchResult.code === 0 ? branchResult.stdout.trim() : '';
    const branch = rawBranch === '' || rawBranch === 'HEAD' ? null : rawBranch;
    return { ok: true, baseCommit, headCommit, branch, changedPaths };
}
// ---------------------------------------------------------------------------
// review request files
// ---------------------------------------------------------------------------
/** Directory of the review files, relative to the project root. */
const REVIEWS_RELATIVE_DIR = join('.dsh-cowork', 'reviews');
/** Most changed paths the request result lists; the file keeps them all. */
const REVIEW_RESULT_PATHS_SHOWN = 100;
/** Most skipped legacy/damaged file names the request result lists. */
const REVIEW_RESULT_SKIPPED_FILES_SHOWN = 10;
/** A request file operation that must reach the caller as a failure. */
class RequestFileError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'RequestFileError';
        this.code = code;
    }
}
/** Build the request-file ports for one project; I/O stays out of the store. */
function requestFilesFor(opened) {
    const dir = join(opened.repoPath, REVIEWS_RELATIVE_DIR);
    return {
        dir,
        readText: (absPath) => opened.store.readText(absPath),
        writeTextAtomic: (absPath, content) => opened.store.writeTextAtomic(absPath, content),
        removeText: async (absPath) => {
            try {
                await unlink(absPath);
            }
            catch (error) {
                const code = error.code;
                if (code !== 'ENOENT')
                    throw error;
            }
        },
        withWriteLock: (operation) => opened.store.withWriteLock(operation),
        listNames: async () => {
            try {
                return await readdir(dir);
            }
            catch (error) {
                const code = error.code;
                if (code === 'ENOENT' || code === 'ENOTDIR')
                    return [];
                throw error;
            }
        },
    };
}
/**
 * Read every `.json` file under `reviews/` and keep only the request model.
 * Legacy verdict-only files predate `requestId`/`status` and are reported as
 * skipped, never treated as pending; a file whose name disagrees with its own
 * identity is skipped so a renamed file cannot impersonate a request.
 */
async function listRequestFiles(files) {
    const names = [...(await files.listNames())]
        .filter((name) => name.endsWith('.json'))
        .sort();
    const requests = [];
    const skipped = [];
    for (const fileName of names) {
        const text = await files.readText(join(files.dir, fileName));
        if (text === null)
            continue;
        const parsed = parseReviewRequestRecord(text);
        if (!parsed.ok) {
            skipped.push({ fileName, problems: parsed.problems });
            continue;
        }
        if (reviewRequestFileName(parsed.record.topicId, parsed.record.requestId) !== fileName) {
            skipped.push({ fileName, problems: ['review file name does not match the record identity'] });
            continue;
        }
        requests.push(parsed.record);
    }
    requests.sort((left, right) => Date.parse(left.requestedAt) - Date.parse(right.requestedAt)
        || left.requestId.localeCompare(right.requestId));
    return { requests, skipped };
}
/** Validate and write one request file under the project lock. */
async function writeRequestFile(files, record, options = {}) {
    const problems = reviewRequestRecordProblems(record);
    if (problems.length > 0) {
        throw new RequestFileError('review/request-file-invalid', `refusing to write an invalid review request: ${problems.join('; ')}`);
    }
    const filePath = reviewRequestFilePath(files.dir, record.topicId, record.requestId);
    if (filePath === null) {
        throw new RequestFileError('review/request-file-invalid', 'topicId/requestId cannot form a review file name');
    }
    return files.withWriteLock(async () => {
        if (options.replace !== true && (await files.readText(filePath)) !== null) {
            throw new RequestFileError('review/request-exists', `review request file already exists: ${filePath}`);
        }
        await files.writeTextAtomic(filePath, serializeReviewRequestRecord(record));
        return filePath;
    });
}
/** Delete one request file; a missing file is fine (rollback is idempotent). */
async function removeRequestFile(files, topicId, requestId) {
    const filePath = reviewRequestFilePath(files.dir, topicId, requestId);
    if (filePath === null)
        return;
    await files.withWriteLock(() => files.removeText(filePath));
}
// ---------------------------------------------------------------------------
// reviewer and inbox ports
// ---------------------------------------------------------------------------
/** The reviewer lifecycle ports over the injected session slice. */
function reviewerPorts(slice) {
    return {
        createReviewSession: (options) => slice.createReviewSession(options),
        archiveSession: (sessionId, options) => slice.archiveSession(sessionId, options),
    };
}
/**
 * Enqueue one master inbox event and flush it. A delivery failure leaves the
 * item undelivered (project_status replays it) and is reported, never thrown.
 */
async function deliverInboxEvent(opened, masterSessionId, now, event) {
    const inbox = new Inbox({
        store: {
            readInbox: () => opened.store.readInbox(),
            writeInbox: (items) => opened.store.writeInbox(items),
        },
        deliver: async (summary) => {
            const prompted = await opened.slice.promptSession(masterSessionId, summary);
            if (!prompted.accepted)
                throw new Error('the master session did not accept the inbox message');
        },
        clock: () => now,
    });
    try {
        await inbox.enqueue([event]);
    }
    catch (error) {
        return { kind: event.kind, delivered: 0, failed: 1, error: `enqueue: ${describeError(error)}` };
    }
    try {
        const flushed = await inbox.flush();
        return {
            kind: event.kind,
            delivered: flushed.delivered,
            failed: flushed.failed,
            error: flushed.failed > 0 ? `${flushed.failed} inbox item(s) could not be delivered and stay for replay` : null,
        };
    }
    catch (error) {
        if (error instanceof InboxMarkError) {
            return { kind: event.kind, delivered: error.delivered, failed: error.pendingIds.length, error: error.message };
        }
        return { kind: event.kind, delivered: 0, failed: 1, error: describeError(error) };
    }
}
/** Record one error activity, never letting an activity failure mask the cause. */
async function recordErrorActivity(opened, topicId, summary, now, details) {
    try {
        await opened.store.appendActivity(buildActivityEvent({ type: 'error', topicId, summary, details }, now));
        return null;
    }
    catch (error) {
        return describeError(error);
    }
}
/** The canonical topic of one topic id, or null. */
function topicOf(document, topicId) {
    return document.topics.find((entry) => entry.topicId === topicId) ?? null;
}
/**
 * The role gate of `cowork_review_request`: only a topic session may request a
 * review. The master is refused explicitly — it routes and decides, it does not
 * create reviewers.
 */
function checkReviewRequester(caller, document) {
    if (document.topics.some((topic) => topic.topicId === caller.sessionId))
        return null;
    const master = caller.sessionId === document.masterSessionId;
    return failure(ERROR_CODES.roleForbidden, `cowork_review_request is restricted to a topic session; session ${caller.sessionId} is `
        + `${master ? 'the master, which may not request reviews' : 'not a topic of this project'}`, { role: 'topic', sessionId: caller.sessionId, masterSessionId: document.masterSessionId });
}
/**
 * Undo a request that could not be finished. Order matters and each step is
 * caught on its own: the file, then the index markers, then the reviewer. A
 * partial rollback is reported in `cleanupErrors`, never silently dropped.
 */
async function rollbackRequest(context) {
    const { opened, files, record, previousTopic, previousWorkItem, now } = context;
    const cleanupErrors = [];
    try {
        await removeRequestFile(files, record.topicId, record.requestId);
    }
    catch (error) {
        cleanupErrors.push(`request file: ${describeError(error)}`);
    }
    try {
        await opened.store.mutateIndexDocument((document) => ({
            ...document,
            topics: document.topics.map((topic) => topic.topicId === record.topicId ? { ...topic, ...previousTopic } : topic),
            workItems: previousWorkItem === null
                ? document.workItems
                : document.workItems.map((workItem) => workItem.workItemId === previousWorkItem.workItemId
                    ? { ...workItem, status: previousWorkItem.status, headCommit: previousWorkItem.headCommit, updatedAt: now.toISOString() }
                    : workItem),
        }));
    }
    catch (error) {
        cleanupErrors.push(`index: ${describeError(error)}`);
    }
    const archived = await archiveReviewerAfterVerdict(reviewerPorts(opened.slice), record.reviewerSessionId ?? '');
    if (!archived.archived && archived.error !== null)
        cleanupErrors.push(`reviewer archive: ${archived.error}`);
    return cleanupErrors;
}
/**
 * Register the two review tools and return their disposers. The caller owns the
 * effect scope; this function only registers.
 */
export function registerReviewTools(ctx, deps) {
    const host = ctx;
    const disposers = [];
    const { callerOf, openProject, mapError, toJson, renderJson, nowOf, isFailure } = deps;
    const git = deps.git ?? runGit;
    // 10) cowork_review_request — one request defines one review range.
    disposers.push(host.tools.register(defineTool({
        name: 'cowork_review_request',
        description: 'Request one independent review of a commit range (topic session only): validate the range, create a fresh reviewer session, write a pending request file under .dsh-cowork/reviews/, and brief the reviewer with the request scope. Pass previousRequestId when re-requesting after a needs_revision verdict.',
        parameters: {
            purpose: { type: 'string', required: true, description: 'What this review should establish, in one or two sentences.' },
            baseCommit: { type: 'string', required: true, description: 'Commit the review range starts from (must be an ancestor of headCommit).' },
            headCommit: { type: 'string', required: true, description: 'Commit the review range ends at.' },
            path: { type: 'string', required: true, description: 'Absolute path under review: the repository root for a shared-tree request, or the work-item checkout.' },
            verification: {
                type: 'array',
                required: true,
                description: 'One row per check the requester actually ran; the reviewer re-runs them.',
                items: REVIEW_VERIFICATION_PARAMETER,
            },
            workItemId: { type: 'string', description: 'Work item under review. Omit for a shared working-tree review.' },
            changedPaths: {
                type: 'array',
                description: 'Optional declaration of the reviewed files; if given it must equal git diff --name-only baseCommit..headCommit.',
                items: { type: 'string' },
            },
            previousRequestId: { type: 'string', description: 'The answered request this one follows (re-review after needs_revision).' },
            notes: { type: 'string', description: 'Context the reviewer needs that the range does not show.' },
            extra: { type: 'json', description: 'Optional extra fields (at most 20 keys of bounded JSON).' },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        execute: async (args, exec) => {
            const caller = callerOf(exec);
            if (isFailure(caller))
                return toJson(caller);
            try {
                const opened = await openProject(caller);
                if (isFailure(opened))
                    return toJson(opened);
                const document = await opened.store.readIndexDocument();
                const denied = checkReviewRequester(caller, document);
                if (denied !== null)
                    return toJson(denied);
                const topic = topicOf(document, caller.sessionId);
                if (topic === null)
                    return toJson(denied ?? failure(ERROR_CODES.roleForbidden, 'no topic session'));
                // Resolve the optional work item before trusting the path.
                const rawWorkItemId = typeof args.workItemId === 'string' && args.workItemId.trim() !== ''
                    ? args.workItemId.trim()
                    : null;
                let workItem = null;
                if (rawWorkItemId !== null) {
                    workItem = document.workItems.find((entry) => entry.workItemId === rawWorkItemId) ?? null;
                    if (workItem === null || workItem.topicId !== topic.topicId) {
                        return toJson(failure(M10_ERROR_CODES.workItemNotFound, `work item ${rawWorkItemId} does not belong to topic ${topic.topicId}`, { workItemId: rawWorkItemId, topicId: topic.topicId }));
                    }
                    if (!ACTIVE_WORK_ITEM_STATUSES.includes(workItem.status)) {
                        return toJson(failure(M10_ERROR_CODES.workItemNotReady, `work item ${rawWorkItemId} is ${workItem.status}; only an active or reviewing work item can be reviewed`, { workItemId: rawWorkItemId, status: workItem.status }));
                    }
                }
                const input = {
                    purpose: args.purpose,
                    baseCommit: args.baseCommit,
                    headCommit: args.headCommit,
                    path: args.path,
                    verification: args.verification,
                    notes: args.notes,
                    extra: args.extra,
                    previousRequestId: args.previousRequestId,
                };
                const scope = {
                    topicId: topic.topicId,
                    workItemId: rawWorkItemId,
                    repoPath: opened.repoPath,
                    workItemPath: workItem === null ? null : workItem.path,
                };
                const shaped = validateReviewRequestInput(input, scope);
                if (!shaped.ok)
                    return toJson(failure(shaped.code, shaped.message, { topicId: topic.topicId, errors: shaped.errors }));
                // The path is exact here: the repository root for a shared-tree request,
                // the work-item checkout otherwise (no "inside" approximation).
                const expectedPath = normalize(workItem === null ? opened.repoPath : workItem.path);
                if (shaped.value.path !== expectedPath) {
                    return toJson(failure(M10_ERROR_CODES.reviewPathOutside, workItem === null
                        ? 'a shared-work-tree review must use the repository root as path'
                        : `the review path must be the work item checkout ${workItem.path}`, { path: shaped.value.path, expected: expectedPath }));
                }
                const range = await checkRequestRange(git, shaped.value.path, shaped.value.baseCommit, shaped.value.headCommit, args.changedPaths);
                if (!range.ok)
                    return toJson(range.failure);
                // Re-validate with the git-derived scope: bound the changed paths and
                // bind the resolved commits and branch into the record.
                const validated = validateReviewRequestInput(input, {
                    ...scope,
                    branch: range.branch,
                    changedPaths: range.changedPaths,
                });
                if (!validated.ok)
                    return toJson(failure(validated.code, validated.message, { topicId: topic.topicId, errors: validated.errors }));
                const draft = {
                    ...validated.value,
                    baseCommit: range.baseCommit,
                    headCommit: range.headCommit,
                };
                // One pending request per topic/work-item pair; old verdict files are
                // skipped by the listing and cannot block a new request.
                const files = requestFilesFor(opened);
                const listing = await listRequestFiles(files);
                const duplicate = listing.requests.find((request) => request.status === 'pending'
                    && request.topicId === draft.topicId
                    && request.workItemId === draft.workItemId) ?? null;
                if (duplicate !== null) {
                    return toJson(failure(ERROR_CODES.reviewAlreadyPending, `topic ${draft.topicId} already has a pending review request for `
                        + `${draft.workItemId === null ? 'the shared work tree' : `work item ${draft.workItemId}`}`, { requestId: duplicate.requestId, reviewerSessionId: duplicate.reviewerSessionId }));
                }
                let previous = null;
                if (draft.previousRequestId !== null) {
                    previous = listing.requests.find((request) => request.requestId === draft.previousRequestId) ?? null;
                    const chainProblem = checkPreviousRequest({
                        previousRequestId: draft.previousRequestId,
                        previous,
                        topicId: draft.topicId,
                        workItemId: draft.workItemId,
                    });
                    if (chainProblem !== null)
                        return toJson(chainProblem);
                }
                // Every check passed: now the first write happens.
                const requestId = randomUUID();
                let reviewer;
                try {
                    reviewer = await createReviewerSession(reviewerPorts(opened.slice), {
                        repoPath: opened.repoPath,
                        subject: `${topic.title} — ${draft.purpose}`.slice(0, 80),
                    });
                }
                catch (error) {
                    return toJson(failure(ERROR_CODES.reviewSessionFailed, describeError(error), { topicId: topic.topicId }));
                }
                const now = nowOf();
                const record = buildReviewRequestRecord(draft, {
                    requestId,
                    reviewerSessionId: reviewer.sessionId,
                    requestedAt: now,
                });
                const requestPath = reviewRequestFilePath(files.dir, record.topicId, record.requestId);
                try {
                    await writeRequestFile(files, record);
                }
                catch (error) {
                    const archive = await archiveReviewerAfterVerdict(reviewerPorts(opened.slice), reviewer.sessionId);
                    return toJson(failure(ERROR_CODES.reviewWriteFailed, describeError(error), {
                        topicId: topic.topicId,
                        requestId,
                        reviewerSessionId: reviewer.sessionId,
                        archive,
                    }));
                }
                const previousTopic = {
                    awaitingReview: topic.awaitingReview,
                    reviewStatus: topic.reviewStatus,
                    latestReviewRequestId: topic.latestReviewRequestId,
                    reviewerSessionId: topic.reviewerSessionId,
                };
                const previousWorkItem = workItem === null
                    ? null
                    : { workItemId: workItem.workItemId, status: workItem.status, headCommit: workItem.headCommit };
                try {
                    await opened.store.mutateIndexDocument((current) => ({
                        ...current,
                        topics: current.topics.map((entry) => entry.topicId === topic.topicId
                            ? {
                                ...entry,
                                awaitingReview: true,
                                reviewStatus: 'pending',
                                latestReviewRequestId: requestId,
                                reviewerSessionId: reviewer.sessionId,
                                updatedAt: now.toISOString(),
                            }
                            : entry),
                        workItems: workItem === null
                            ? current.workItems
                            : current.workItems.map((entry) => entry.workItemId === workItem.workItemId
                                ? markWorkItem(entry, { status: 'reviewing', headCommit: record.headCommit }, now)
                                : entry),
                    }));
                }
                catch (error) {
                    const cleanupErrors = await rollbackRequest({
                        opened,
                        files,
                        record,
                        previousTopic,
                        previousWorkItem,
                        now,
                    });
                    const mapped = mapError(error);
                    return toJson(failure(mapped.error.code, `the review request could not be recorded in the index: ${mapped.error.message}`, {
                        topicId: topic.topicId,
                        requestId,
                        reviewerSessionId: reviewer.sessionId,
                        cleanupErrors,
                    }));
                }
                // The request is recorded; the brief is the last step that can roll back.
                const brief = buildReviewBrief({ request: record, previous });
                let accepted = false;
                let promptError = null;
                try {
                    const prompted = await opened.slice.promptSession(reviewer.sessionId, brief);
                    accepted = prompted.accepted;
                    if (!accepted)
                        promptError = 'the host did not accept the brief';
                }
                catch (error) {
                    promptError = describeError(error);
                }
                if (!accepted) {
                    const cleanupErrors = await rollbackRequest({
                        opened,
                        files,
                        record,
                        previousTopic,
                        previousWorkItem,
                        now,
                    });
                    const activityError = await recordErrorActivity(opened, topic.topicId, `review request ${requestId} was rolled back: the reviewer could not be briefed`, now, { requestId, reviewerSessionId: reviewer.sessionId, promptError, cleanupErrors });
                    return toJson(failure(ERROR_CODES.reviewPromptFailed, `the reviewer session was created but not briefed (${promptError}); the review request was rolled back`, { topicId: topic.topicId, requestId, reviewerSessionId: reviewer.sessionId, cleanupErrors, activityError }));
                }
                let activityError = null;
                try {
                    await opened.store.appendActivity(buildActivityEvent({
                        type: 'review-requested',
                        topicId: topic.topicId,
                        summary: `requested review ${requestId}`,
                        details: {
                            requestId,
                            topicId: topic.topicId,
                            workItemId: draft.workItemId,
                            baseCommit: record.baseCommit,
                            headCommit: record.headCommit,
                            path: record.path,
                            reviewerSessionId: reviewer.sessionId,
                        },
                    }, now));
                }
                catch (error) {
                    activityError = describeError(error);
                }
                return toJson(success({
                    requestId,
                    status: 'pending',
                    topicId: topic.topicId,
                    workItemId: draft.workItemId,
                    path: record.path,
                    baseCommit: record.baseCommit,
                    headCommit: record.headCommit,
                    // Bounded view of the scope; the request file keeps the full lists.
                    changedPaths: record.changedPaths.slice(0, REVIEW_RESULT_PATHS_SHOWN),
                    changedPathsTotal: record.changedPaths.length,
                    filePath: requestPath,
                    reviewerSessionId: reviewer.sessionId,
                    reviewerTitle: reviewer.title,
                    prompted: true,
                    skippedFiles: listing.skipped.slice(0, REVIEW_RESULT_SKIPPED_FILES_SHOWN),
                    skippedFilesTotal: listing.skipped.length,
                    activityError,
                }));
            }
            catch (error) {
                return toJson(mapError(error));
            }
        },
    })));
    // 11) cowork_review_verdict — the one decision bound to one request.
    disposers.push(host.tools.register(defineTool({
        name: 'cowork_review_verdict',
        description: 'Record the verdict of one review request (reviewer session only): write it to the request file first, then update the topic and work item. needs_revision goes back to the topic only; pass with a work item writes the merge-needed inbox; reject blocks the topic and writes the review-reject inbox. The reviewer session is archived afterwards.',
        parameters: {
            requestId: { type: 'string', required: true, description: 'Request being answered (the one the reviewer was briefed with).' },
            verdict: { type: 'string', required: true, enum: ['pass', 'needs_revision', 'reject'], description: 'pass accepts; needs_revision reopens the topic with findings; reject blocks it.' },
            summary: { type: 'string', required: true, description: 'One-paragraph review summary.' },
            findings: {
                type: 'array',
                description: 'Required for needs_revision and reject; a pass may carry none.',
                items: REVIEW_FINDING_PARAMETER,
            },
            verification: {
                type: 'array',
                description: 'One row per check the reviewer actually ran.',
                items: REVIEW_VERIFICATION_PARAMETER,
            },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        execute: async (args, exec) => {
            const caller = callerOf(exec);
            if (isFailure(caller))
                return toJson(caller);
            try {
                const opened = await openProject(caller);
                if (isFailure(opened))
                    return toJson(opened);
                const validated = validateReviewVerdictInput({
                    requestId: args.requestId,
                    verdict: args.verdict,
                    summary: args.summary,
                    findings: args.findings,
                    verification: args.verification,
                });
                if (!validated.ok)
                    return toJson(failure(validated.code, validated.message, { errors: validated.errors }));
                const draft = validated.value;
                const files = requestFilesFor(opened);
                const listing = await listRequestFiles(files);
                const request = listing.requests.find((entry) => entry.requestId === draft.requestId) ?? null;
                if (request === null) {
                    return toJson(failure(M10_ERROR_CODES.reviewRequestNotFound, `no stored review request ${draft.requestId} in this project`, { requestId: draft.requestId }));
                }
                if (request.status !== 'pending') {
                    return toJson(failure(M10_ERROR_CODES.reviewAlreadyReviewed, `review request ${request.requestId} already has the verdict ${request.status}; one request accepts one verdict`, { requestId: request.requestId, status: request.status }));
                }
                if (request.reviewerSessionId === null || caller.sessionId !== request.reviewerSessionId) {
                    return toJson(failure(ERROR_CODES.reviewNotReviewer, `session ${caller.sessionId} is not the reviewer of request ${request.requestId} (reviewer is ${String(request.reviewerSessionId)})`, { requestId: request.requestId, sessionId: caller.sessionId, reviewerSessionId: request.reviewerSessionId }));
                }
                const document = await opened.store.readIndexDocument();
                if (topicOf(document, request.topicId) === null) {
                    return toJson(failure(M10_ERROR_CODES.reviewRequestNotFound, `topic ${request.topicId} of review request ${request.requestId} is not in the project index`, { requestId: request.requestId, topicId: request.topicId }));
                }
                const now = nowOf();
                const terminal = {
                    ...request,
                    status: draft.verdict,
                    reviewedAt: now.toISOString(),
                    summary: draft.summary,
                    findings: draft.findings,
                    reviewVerification: draft.verification,
                };
                const problems = reviewRequestRecordProblems(terminal);
                if (problems.length > 0) {
                    return toJson(failure(ERROR_CODES.reviewVerdictInvalid, 'the verdict record is invalid', { problems }));
                }
                // File first: the verdict is the record; the index follows it.
                const filePath = reviewRequestFilePath(files.dir, terminal.topicId, terminal.requestId) ?? '';
                try {
                    await writeRequestFile(files, terminal, { replace: true });
                }
                catch (error) {
                    return toJson(failure(ERROR_CODES.reviewWriteFailed, describeError(error), {
                        requestId: terminal.requestId,
                        topicId: terminal.topicId,
                    }));
                }
                const outcome = deriveReviewOutcome(draft.verdict, terminal.workItemId);
                const nextWorkItemStatus = draft.verdict === 'pass' ? 'reviewing' : 'active';
                let indexError = null;
                try {
                    await opened.store.mutateIndexDocument((current) => ({
                        ...current,
                        topics: current.topics.map((topic) => topic.topicId === terminal.topicId
                            ? {
                                ...topic,
                                awaitingReview: outcome.awaitingReview,
                                reviewStatus: outcome.reviewStatus,
                                reviewerSessionId: null,
                                blocked: outcome.blocked,
                                updatedAt: now.toISOString(),
                            }
                            : topic),
                        workItems: terminal.workItemId === null
                            ? current.workItems
                            : current.workItems.map((workItem) => workItem.workItemId === terminal.workItemId
                                ? markWorkItem(workItem, { status: nextWorkItemStatus }, now)
                                : workItem),
                    }));
                }
                catch (error) {
                    // The verdict is already stored; a stale index is reported, not hidden.
                    indexError = describeError(error);
                    await recordErrorActivity(opened, terminal.topicId, `verdict for ${terminal.requestId} was stored but the index could not be updated`, now, {
                        requestId: terminal.requestId,
                        indexError,
                    });
                }
                // The topic hears about its own findings; the master only about events
                // it must decide (a merge is needed, or the topic was rejected).
                let topicDelivered = null;
                let topicDeliveryError = null;
                if (outcome.deliverToTopic) {
                    const message = draft.verdict === 'reject'
                        ? buildRejectMessage(terminal)
                        : buildRevisionMessage(terminal);
                    try {
                        const prompted = await opened.slice.promptSession(terminal.topicId, message);
                        topicDelivered = prompted.accepted;
                        if (!prompted.accepted)
                            topicDeliveryError = 'the host did not accept the review message';
                    }
                    catch (error) {
                        topicDeliveryError = describeError(error);
                    }
                }
                let inbox = null;
                if (outcome.inboxKind !== null) {
                    const summary = outcome.inboxKind === 'merge-needed'
                        ? `review ${terminal.requestId} passed: merge work item ${String(terminal.workItemId)} of topic ${terminal.topicId}`
                        : `review ${terminal.requestId} rejected topic ${terminal.topicId}: decide whether to replan`;
                    const kind = outcome.inboxKind === 'merge-needed' ? 'merge-needed' : 'review-reject';
                    inbox = await deliverInboxEvent(opened, document.masterSessionId, now, {
                        topicId: terminal.topicId,
                        kind,
                        summary,
                    });
                }
                const archive = request.reviewerSessionId === null
                    ? { archived: true, error: null }
                    : await archiveReviewerAfterVerdict(reviewerPorts(opened.slice), request.reviewerSessionId);
                let activityError = null;
                try {
                    await opened.store.appendActivity(buildActivityEvent({
                        type: 'review-verdict',
                        topicId: terminal.topicId,
                        summary: `review ${terminal.requestId} returned ${terminal.status}`,
                        details: {
                            requestId: terminal.requestId,
                            topicId: terminal.topicId,
                            workItemId: terminal.workItemId,
                            verdict: terminal.status,
                            reviewerSessionId: request.reviewerSessionId,
                            archived: archive.archived,
                        },
                    }, now));
                }
                catch (error) {
                    activityError = describeError(error);
                }
                return toJson(success({
                    requestId: terminal.requestId,
                    verdict: terminal.status,
                    status: terminal.status,
                    topicId: terminal.topicId,
                    workItemId: terminal.workItemId,
                    reviewFilePath: filePath,
                    reviewedAt: terminal.reviewedAt,
                    topicDelivered,
                    topicDeliveryError,
                    inbox,
                    archived: archive.archived,
                    archiveError: archive.error,
                    indexError,
                    activityError,
                }));
            }
            catch (error) {
                return toJson(mapError(error));
            }
        },
    })));
    return disposers;
}
//# sourceMappingURL=review-tools.js.map