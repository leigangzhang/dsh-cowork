/**
 * Shared execution layer for the `cowork_*` tools (M9.3a).
 *
 * `src/tools.ts` used to hold every helper and every tool in one file. The
 * business boundary stays the same; this module owns the pieces every tool
 * needs — the dependency bag, caller/project resolution, the store and session
 * adapters, the git runner, thread views, and the isolated-thread creation /
 * cleanup flow — so the per-domain tool modules can register their tools
 * without importing each other.
 *
 * It also owns the M9 read-point rule: {@link evaluateProjectLifecycle} runs
 * `evaluateTopicLifecycle` against every topic inside the project lock and
 * writes only when something changed. Reading a status must not write, so a
 * no-change pass returns `null` from the mutator and the store skips the write.
 *
 * Nothing here assembles a host: the caller injects {@link CoworkToolDeps}, and
 * a test can register the tools against recording fakes.
 */
import { execFile } from 'node:child_process';
import { requestResolvedActivity, statusChangedActivity, topicArchivedActivity } from './activity.js';
import { CLONE_ISOLATION_PROVIDER } from './checkout.js';
import { describeError } from './checkout-teardown.js';
import { Inbox, InboxMarkError } from './inbox.js';
import { RequestStore } from './request-store.js';
import { findAuthorizationNoticeId, recordNoticesForEvent, voidAuthorizationNotice } from './notices.js';
import { SessionSlice } from './session-slice.js';
import { ProjectStore, StoreError, findProjectRoot } from './store.js';
import { archiveTopicRecord } from './topic.js';
import { evaluateTopicLifecycle } from './topic.js';
import { ERROR_CODES, failure, readCaller } from './tool-model.js';
/**
 * Isolation provider used to create an isolated work item (PLAN-V0.2 §4.5).
 * Derived from the checkout module so the wire value has one home; M10
 * implements `clone` only, and a different configured value fails the
 * work-item tool with `workitem/provider-unsupported` instead of silently
 * falling back.
 */
export const DEFAULT_ISOLATION_PROVIDER = CLONE_ISOLATION_PROVIDER;
/**
 * When a reviewer session is reclaimed (PLAN-V0.2 §5.4). M10 supports only
 * `after-verdict` — reclaiming a reviewer any earlier blocks its turn before a
 * verdict exists — and startup rejects every other value.
 */
export const DEFAULT_REVIEWER_RECLAIM = 'after-verdict';
/** Longest `brief` a tool may carry into a new topic or route prompt. */
export const BRIEF_MAX_CHARS = 2000;
/** Cut text to at most `limit` Unicode code points without splitting a pair. */
export function truncateText(text, limit) {
    if (limit <= 0)
        return '';
    const points = Array.from(text);
    return points.length <= limit ? text : points.slice(0, limit).join('');
}
/** Convert any payload to the lossless JSON value the tool boundary accepts. */
export function toJson(value) {
    return JSON.parse(JSON.stringify(value));
}
/** Render one JSON result as model-facing text. */
export function renderJson(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value) }];
}
/**
 * The one place a production {@link ProjectStore} is constructed. The store's
 * v1→v2 migration entry archives the reviewer of an in-flight review through
 * `ProjectStoreOptions.archiveSession`; wiring the host port here is what makes
 * that a real archive instead of a recorded failure.
 */
export function projectStoreFor(repoPath, deps) {
    return new ProjectStore({
        repoPath,
        clock: deps.clock,
        archiveSession: (sessionId, options) => deps.workspaceRegistry.archiveSession(sessionId, options),
    });
}
/** The clock every write uses. */
export function nowOf(deps) {
    return deps.clock === undefined ? new Date() : deps.clock();
}
export async function deliverInbox(options) {
    const inbox = new Inbox({ store: options.store, deliver: options.deliver, clock: options.clock });
    const events = options.events ?? [];
    try {
        await inbox.enqueue(events);
    }
    catch (error) {
        return { delivered: 0, failed: events.length, error: describeError(error) };
    }
    try {
        const flushed = await inbox.flush();
        if (flushed.failed === 0)
            return { delivered: flushed.delivered, failed: 0 };
        return {
            delivered: flushed.delivered,
            failed: flushed.failed,
            error: 'master did not accept the inbox batch',
        };
    }
    catch (error) {
        if (error instanceof InboxMarkError) {
            return { delivered: error.delivered, failed: error.pendingIds.length, error: error.message };
        }
        // An unexpected throw (not a delivery rejection) leaves the counts unknown;
        // the items stay in the file for the next pass either way.
        return { delivered: 0, failed: 0, error: describeError(error) };
    }
}
/**
 * Append one notice-carrying activity row, write its ledger rows, and kick the
 * dispatcher. The activity row is the body the ledger points at, so a failed
 * append writes no ledger row (there would be nothing to deliver); the caller
 * still gets `false` and keeps its committed topic state.
 */
export async function recordNoticeEvent(store, event, now, runtime, repoPath) {
    try {
        await store.appendActivity(event);
    }
    catch {
        return false;
    }
    if (store.writeNotices !== undefined && store.readNotices !== undefined) {
        try {
            await recordNoticesForEvent(store, event, now);
        }
        catch {
            // The ledger is delivery evidence, not topic state: a failed write leaves
            // the event readable and must not fail the tool or roll the index back.
        }
    }
    runtime?.kick(repoPath);
    return true;
}
/**
 * The shared archive core of the resolve route and `cowork_topic_resolve`:
 * clear the block and any pending authorization, mark the topic resolved by the
 * user, then record the `topic-archived` activity and its master-only notice.
 * Idempotent: an already resolved topic writes nothing and returns `changed:
 * false`. Neither the activity nor the ledger can roll the committed state back.
 */
export async function archiveTopic(store, topicId, options) {
    let changed = false;
    let updated = null;
    let pendingRequest = null;
    const document = await store.mutateIndexDocument((base) => {
        options.assertAllowed?.(base);
        const topic = base.topics.find((entry) => entry.topicId === topicId);
        if (topic === undefined || topic.status === 'resolved')
            return null;
        pendingRequest = topic.authorization?.requestId ?? null;
        const archived = archiveTopicRecord(topic, options.now.getTime(), options.by ?? 'user');
        changed = true;
        updated = archived;
        return {
            ...base,
            topics: base.topics.map((entry) => (entry.topicId === topicId ? archived : entry)),
        };
    });
    if (!changed || updated === null) {
        return { changed: false, topic: document.topics.find((entry) => entry.topicId === topicId) ?? null, event: null, noticeRows: 0 };
    }
    // Find the notice the archive withdraws before writing its own event, so the
    // event can name it (a delivered card keeps its delivery row, only the event
    // records that the request is no longer decidable).
    const voidedNoticeId = pendingRequest === null
        ? null
        : await findAuthorizationNoticeId(store, topicId, pendingRequest).catch(() => null);
    const event = topicArchivedActivity(updated, { by: options.by ?? 'user', voidedAuthorizationNoticeId: voidedNoticeId }, options.now);
    let noticeRows = 0;
    try {
        await store.appendActivity(event);
        if (store.writeNotices !== undefined && store.readNotices !== undefined) {
            noticeRows = (await recordNoticesForEvent(store, event, options.now)).length;
        }
    }
    catch (error) {
        // Committed state stands; a lost event/ledger row is a logged evidence gap.
        options.log?.(`topic archive event was not recorded: ${describeError(error)}`);
        return { changed: true, topic: updated, event: null, noticeRows: 0 };
    }
    if (pendingRequest !== null && store.readNotices !== undefined) {
        // Archiving invalidates the pending authorization: the user can no longer
        // decide it, so its notice is withdrawn instead of lingering as pending.
        try {
            await voidAuthorizationNotice({
                store: store,
                document,
                topicId,
                requestId: pendingRequest,
                now: options.now,
                port: options.runtime?.port,
                noticeId: voidedNoticeId,
            });
        }
        catch (error) {
            options.log?.(`authorization notice was not voided: ${describeError(error)}`);
        }
    }
    // Archiving invalidates every pending request of this topic: they can no
    // longer be decided, so each becomes `void` and records its own resolved row.
    // The index is already committed, so a failure here is a log line only, and
    // the archived topic is never prompted.
    await voidTopicRequests(store, topicId, options.now, options.log);
    options.runtime?.kick(options.repoPath);
    return { changed: true, topic: updated, event, noticeRows };
}
/**
 * Withdraw every pending request of one archived topic and append one
 * `request-resolved` activity per withdrawn record. Best-effort by design: the
 * archive is already durable and must not be rolled back by a storage failure.
 */
async function voidTopicRequests(store, topicId, now, log) {
    const repoPath = repoPathOf(store);
    if (repoPath === null)
        return;
    let voided;
    try {
        voided = await new RequestStore({ repoPath, log }).voidPendingForTopic(topicId, now);
    }
    catch (error) {
        log?.(`pending requests of archived topic ${topicId} were not voided: ${describeError(error)}`);
        return;
    }
    for (const record of voided) {
        try {
            await store.appendActivity(requestResolvedActivity(record, { action: null }, now));
        }
        catch (error) {
            log?.(`request ${record.requestId} voided, activity not recorded: ${describeError(error)}`);
        }
    }
}
/**
 * The repository root of a store. `ProjectStore` carries it; a hand-built fake
 * without one cannot own a request directory, so the void pass is skipped
 * rather than guessed at a relative path.
 */
function repoPathOf(store) {
    const candidate = store.repoPath;
    return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : null;
}
/** Build the session adapter over the injected host services. */
export function makeSlice(deps) {
    return new SessionSlice({ sessions: deps.sessionController, workspaces: deps.workspaceRegistry });
}
/** Timeout for one git invocation; no git call is retried automatically. */
export const GIT_TIMEOUT_MS = 30_000;
/** Upper bound on captured git output; a runaway diff should fail, not OOM. */
export const GIT_MAX_BUFFER = 8 * 1024 * 1024;
/** One non-zero exit code returned by a failed spawn (git never ran). */
export const SPAWN_FAILED_EXIT = 1;
/**
 * Git runner for the checkout module: argument array, explicit cwd, a
 * 30-second timeout, and no shell, so a thread id or repository path can never
 * become part of a command. A non-zero exit is a value, never an exception.
 */
export const runGit = (args, cwd) => new Promise((settle) => {
    execFile('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error === null) {
            settle({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
            return;
        }
        const exit = error.code;
        settle({
            code: typeof exit === 'number' ? exit : SPAWN_FAILED_EXIT,
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' && stderr.length > 0 ? stderr : error.message,
        });
    });
});
/** The checkout module's only dependency is the git runner. */
export const checkoutDeps = { runGit };
/** The memory module's IO port, backed by the project store's lock and atomic write. */
export function memoryIo(store) {
    return {
        readText: (path) => store.readText(path),
        writeText: (path, content) => store.writeTextAtomic(path, content),
        withLock: (operation) => store.withWriteLock(operation),
    };
}
/** Whether a value is one of the shared failure envelopes. */
export function isFailure(value) {
    return typeof value === 'object' && value !== null && value.ok === false;
}
/** Map a thrown error onto the model-facing failure envelope. */
export function mapError(error) {
    if (error instanceof StoreError) {
        if (error.code === 'store/corrupt') {
            return failure(ERROR_CODES.storeCorrupt, error.message, { filePath: error.filePath });
        }
        if (error.code === 'store/not-found') {
            return failure(ERROR_CODES.projectNotInitialized, error.message, { filePath: error.filePath });
        }
        return failure('tool/internal', error.message);
    }
    return failure('tool/internal', error instanceof Error ? error.message : String(error));
}
/** Read the caller or produce the `exec/agent-unavailable` failure. */
export function callerOf(exec) {
    const caller = readCaller(exec);
    if (caller !== null)
        return caller;
    return failure(ERROR_CODES.agentUnavailable, 'no caller identity on exec.agent (needs exec.agent.id and exec.agent.session.header.cwd); refusing to guess the project');
}
/** Resolve the project that owns the caller's cwd. */
export async function openProject(caller, deps) {
    const repoPath = await findProjectRoot(caller.cwd);
    if (repoPath === null) {
        const hint = deps.resolveRepoPath === undefined ? '' : ` (plugin default repo: ${deps.resolveRepoPath()})`;
        return failure(ERROR_CODES.projectNotInitialized, `no .dsh-cowork/index.json at or above ${caller.cwd}; run cowork_project_init first${hint}`);
    }
    const store = projectStoreFor(repoPath, deps);
    const index = await store.readIndex();
    return { repoPath, store, slice: makeSlice(deps), index };
}
/** The thread fields the tools expose. */
export function threadView(thread) {
    return {
        threadId: thread.threadId,
        subject: thread.subject,
        status: thread.status,
        cwd: thread.cwd,
        checkoutPath: thread.checkoutPath,
        updatedAt: thread.updatedAt,
        lastHandoffAt: thread.lastHandoffAt,
        reviewStatus: thread.reviewStatus,
        reviewedAt: thread.reviewedAt,
        reviewerSessionId: thread.reviewerSessionId,
        latestReviewPath: thread.latestReviewPath,
    };
}
/** Most characters of a topic digest a bounded tool view carries. */
export const TOPIC_VIEW_DIGEST_MAX_CHARS = 200;
/** Project one v2 topic onto the bounded tool view (digest cut to 200 points). */
export function topicView(topic) {
    return {
        topicId: topic.topicId,
        title: topic.title,
        status: topic.status,
        blocked: topic.blocked,
        awaitingReview: topic.awaitingReview,
        scope: topic.scope,
        ownedPaths: topic.ownedPaths,
        digest: truncateText(topic.digest, TOPIC_VIEW_DIGEST_MAX_CHARS),
        lastActiveAt: topic.lastActiveAt,
        updatedAt: topic.updatedAt,
        resolvedAt: topic.resolvedAt,
        resolvedBy: topic.resolvedBy,
    };
}
/**
 * Evaluate every topic's lifecycle inside the project lock (M9 read point).
 *
 * The mutator re-reads the document under the lock, so a concurrent write is
 * never overwritten by a stale snapshot; when no topic changed it returns
 * `null` and the store performs no write at all. A transition that lands is
 * committed atomically first, then its `status-changed` activity is appended
 * outside the lock: an activity failure is collected in `activityErrors` and
 * never rolls the index back (the M8 listener follows the same rule).
 */
export async function evaluateProjectLifecycle(store, options) {
    const nowMs = options.now.getTime();
    const activeWorkItemsOf = options.activeWorkItemsOf ?? (() => 0);
    const changes = [];
    let evaluated = 0;
    const next = await store.mutateIndexDocument((document) => {
        changes.length = 0;
        evaluated = document.topics.length;
        const topics = [];
        let changed = false;
        for (const topic of document.topics) {
            const transition = evaluateTopicLifecycle(topic, {
                nowMs,
                idleAfterMs: options.idleAfterMs,
                resolveAfterMs: options.resolveAfterMs,
                activeWorkItems: activeWorkItemsOf(topic.topicId, document),
            });
            if (transition.kind === 'none') {
                topics.push(topic);
                continue;
            }
            changed = true;
            topics.push(transition.topic);
            changes.push({ topicId: topic.topicId, from: topic.status, to: transition.kind });
        }
        return changed ? { ...document, topics } : null;
    });
    const activityErrors = [];
    for (const change of changes) {
        const topic = next.topics.find((entry) => entry.topicId === change.topicId);
        if (topic === undefined)
            continue;
        try {
            await store.appendActivity(statusChangedActivity(topic, { from: change.from, to: change.to }, options.now));
        }
        catch (error) {
            activityErrors.push(`${change.topicId}: ${describeError(error)}`);
        }
    }
    return { evaluated, changes, activityErrors };
}
//# sourceMappingURL=tool-runtime.js.map