/**
 * Shared types, constants, prompt builders, and pure helpers for the M3 real-host
 * E2E driver. Like `m2-e2e-support.ts`, this module depends on Node built-ins
 * plus the plugin's pure store modules (`store-schema.js`, `store-migration.js`)
 * and nothing else: the index format is owned by the store layer, so `parseIndex`
 * reads it through that same pure implementation (schema validation + the
 * compatibility view) instead of keeping a second status mapping. It never
 * imports the runner or the host, so the step list, prompt text, review-state
 * helpers, and steer plan are testable under plain `node --test` without
 * mounting a host (tests that load this file install the usual `.js`→`.ts`
 * hook). The runner lives in `src/m3-e2e.ts` and imports this module.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { INDEX_VERSION_V2, normalizeProjectIndexV2, projectIndexV2Problems } from './store-schema.js';
import { legacyViewOf } from './store-migration.js';
export const M3_E2E_EVIDENCE_RELATIVE = '.dsh-cowork/e2e/M3_E2E.json';
export const M3_E2E_FIXTURE_RELATIVE = '.dsh-cowork/e2e/m3-repo';
export const M3_E2E_STEP_TIMEOUT_MS = 180_000;
export const M3_E2E_POLL_MS = 500;
export const M3_E2E_RUN_PATH = '/dsh-cowork/e2e/m3/run';
export const M3_E2E_STATUS_PATH = '/dsh-cowork/e2e/m3/status';
export const MAX_EVENTS = 4000;
export const MAX_ASSISTANT_TEXT = 1000;
export const MAX_FILE_TEXT = 2000;
export const MAX_GIT_TEXT = 2000;
export const GIT_TIMEOUT_MS = 30_000;
export const GIT_MAX_BUFFER = 8 * 1024 * 1024;
export const REVIEW_REQUEST_TOOL = 'cowork_review_request';
export const REVIEW_VERDICT_TOOL = 'cowork_review_verdict';
export const MERGE_TOOL = 'cowork_checkout_merge';
export const REVIEWER_PRESET_ID = 'cowork-reviewer';
export const MASTER_DONE = 'Reply DONE.';
export const THREAD_A_SUBJECT = 'M3 E2E review pass';
export const THREAD_B_SUBJECT = 'M3 E2E review repair';
export const FILE_A = 'e2e-a.txt';
export const CONTENT_A = 'M3-E2E-PASS';
export const FILE_B = 'e2e-b.txt';
export const CONTENT_B_INITIAL = 'M3-E2E-NEEDS-REPAIR';
export const CONTENT_B_FIXED = 'M3-E2E-FIXED';
export const FINDING_ID = 'M3-E2E-1';
export const M3_STEP_IDS = [
    'setup',
    'thread-a-create',
    'thread-a-work',
    'review-a-request',
    'review-a-pass',
    'merge-a',
    'thread-b-create',
    'thread-b-work',
    'review-b-request',
    'review-b-needs-revision',
    'thread-b-repair',
    'review-b-request-2',
    'review-b-pass',
    'merge-b',
    'cleanup',
];
export const REVIEW_FINDING = {
    id: FINDING_ID,
    severity: 'high',
    problem: `${FILE_B} still contains ${CONTENT_B_INITIAL}`,
    requiredFix: `rewrite ${FILE_B} to content ${CONTENT_B_FIXED}`,
};
export function stepFailureState(stepId, error) {
    return { state: 'failed', error: `step ${stepId}: ${messageOf(error)}` };
}
/**
 * Whether the run-end `finally` must delete the fixture directory. A run that
 * is still `running` keeps its fixture; `done` and `failed` both drop it, so a
 * failed run cannot leave `.dsh-cowork/e2e/m3-repo/README.md` behind for
 * `npm run check` to scan (KI-13). Pure by design so the three states stay
 * testable without a host and the policy lives in one place.
 */
export function shouldRemoveFixture(state) {
    return state === 'done' || state === 'failed';
}
export function reviewPreamble(input, command) {
    return [
        'This is the M3 E2E fixture run. Act as the independent reviewer; never modify an implementation file.',
        `Thread ${input.threadId} ("${input.subject}"). Main repo ${input.repoPath}; checkout ${input.checkoutPath} (branch cowork/${input.threadId}); read it with bash.`,
        `Step 1 — use the bash tool to run the recorded verification command from the checkout: cd ${input.checkoutPath} && ${input.verificationCommand}. Keep its real exit code and output.`,
        `Step 2 — ${command}`,
    ];
}
export function buildReviewerPassPrompt(input) {
    const args = {
        threadId: input.threadId,
        verdict: 'pass',
        summary: `Independent review of ${input.threadId}: the handoff change is present and the recorded verification command passed.`,
        findings: [],
        verification: [{ command: input.verificationCommand, exitCode: 0, evidence: '<copy the real command output here>' }],
    };
    return [
        ...reviewPreamble(input, 'call cowork_review_verdict exactly once with these arguments (replace only the placeholder evidence with the real command output):'),
        JSON.stringify(args, null, 2),
        `Use verdict "pass" only if the command exited 0 and the change matches the handoff. ${MASTER_DONE}`,
    ].join('\n\n');
}
export function buildReviewerNeedsRevisionPrompt(input) {
    const args = {
        threadId: input.threadId,
        verdict: 'needs_revision',
        summary: `Independent review of ${input.threadId}: the fixture requires exactly one blocking correction before this thread can be merged.`,
        findings: [input.finding],
        verification: [{ command: input.verificationCommand, exitCode: 0, evidence: '<copy the real command output here>' }],
    };
    return [
        ...reviewPreamble(input, 'the fixture must be sent back: call cowork_review_verdict exactly once with these arguments (keep the finding as written):'),
        JSON.stringify(args, null, 2),
        `The verdict must be "needs_revision" and the finding verbatim. ${MASTER_DONE}`,
    ].join('\n\n');
}
export function buildRepairPrompt(input) {
    const { finding } = input;
    return [
        `The independent review returned needs_revision for thread ${input.threadId}.`,
        `Finding ${finding.id} (${finding.severity}): ${finding.problem} Required fix: ${finding.requiredFix}.`,
        `Use bash to run exactly: printf '${input.fixedContent}\\n' > ${input.fileName} && git add ${input.fileName} && git commit -m "fix: apply review finding ${finding.id}".`,
        `Then call cowork_handoff again with status "awaiting_review", summary "M3 E2E repair: ${input.fileName} now contains ${input.fixedContent}", verification [{command: "test -f ${input.fileName}", exitCode: 0, evidence: "${input.fileName} exists"}], changedPaths ["${input.fileName}"].`,
        `Change nothing else. ${MASTER_DONE}`,
    ].join('\n\n');
}
export function reviewStateOf(index, threadId) {
    if (index === undefined || index === null)
        return null;
    const thread = index.threads.find((entry) => entry.threadId === threadId);
    if (thread === undefined)
        return null;
    return {
        threadId,
        status: thread.status,
        checkoutPath: typeof thread.checkoutPath === 'string' ? thread.checkoutPath : null,
        reviewStatus: stringOrNull(thread.reviewStatus),
        reviewerSessionId: stringOrNull(thread.reviewerSessionId),
        reviewedAt: stringOrNull(thread.reviewedAt),
        latestReviewPath: stringOrNull(thread.latestReviewPath),
    };
}
const TERMINAL_REVIEW_STATUSES = ['pass', 'needs_revision', 'reject'];
/**
 * Decide the verdict delivery mode from the index alone: skip when the reviewer
 * already produced the expected verdict, fail when it produced another terminal
 * verdict (or the thread left awaiting_review), else steer the instruction now.
 */
export function planReviewVerdict(state, verdict, expectedStatus) {
    if (state === null)
        return { action: 'steer', mode: 'steer', reason: 'the thread is not in the index yet' };
    if (state.reviewStatus === verdict && state.status === expectedStatus) {
        return { action: 'skip', mode: null, reason: 'reviewer already produced the expected verdict' };
    }
    const terminal = state.reviewStatus !== null && TERMINAL_REVIEW_STATUSES.includes(state.reviewStatus);
    if (terminal || state.status !== 'awaiting_review') {
        return {
            action: 'fail',
            mode: null,
            reason: `reviewer already produced ${String(state.reviewStatus)} while the thread is ${state.status}`,
        };
    }
    return { action: 'steer', mode: 'steer', reason: 'reviewer has not produced a verdict yet' };
}
export function assertionForReview(check, expected, actual) {
    const e = stableJson(expected);
    const a = stableJson(actual);
    return { name: check, ok: e === a, evidence: clip(`expected=${e} actual=${a}`, 3000) };
}
/**
 * Decide how to request a review. A handoff wakes the master, and that reaction
 * turn can run far longer than a step timeout, so the runner never waits for the
 * master to go idle: it adopts a review the master already requested when the
 * index shows a pending one with a fresh reviewer, and otherwise steers the
 * instruction into the master's current turn.
 */
export function planReviewRequest(input) {
    const reviewer = input.state?.reviewerSessionId ?? null;
    const fresh = reviewer !== null &&
        reviewer !== input.threadId &&
        reviewer !== input.masterSessionId &&
        (input.previousReviewerSessionId === null || reviewer !== input.previousReviewerSessionId);
    if (input.state?.reviewStatus === 'pending' && fresh) {
        return { action: 'already-pending', reason: `the master already requested this review in session ${reviewer}` };
    }
    return { action: 'steer', reason: 'the review request is steered into the master turn' };
}
/**
 * Merge is never gated on a long master-idle wait: when the target state is
 * already reached the step passes idempotently, otherwise the merge
 * instruction is steered into whatever turn the master is in.
 */
export function planMergePrompt(alreadyDone) {
    return alreadyDone
        ? { action: 'skip', reason: 'merge target state was already reached; passed idempotently' }
        : { action: 'steer', reason: 'the merge instruction is steered into the master turn' };
}
export function clip(text, limit) {
    return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
export function isoNow() {
    return new Date().toISOString();
}
export function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
export function sleep(ms) {
    return new Promise((settle) => setTimeout(settle, ms));
}
export function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}
export function stringOrNull(value) {
    return typeof value === 'string' ? value : null;
}
export function stableJson(value) {
    try {
        const text = JSON.stringify(value);
        return text === undefined ? String(value) : text;
    }
    catch {
        return String(value);
    }
}
export function obs(step, patch) {
    Object.assign(step.evidence.observations, patch);
}
export async function readTextIfPresent(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return undefined;
        throw error;
    }
}
/**
 * Parse the project index; a half-written file during a poll reports absence.
 *
 * v1 (`threads[]`) is returned unchanged; v2 (`topics[]`) is validated with the
 * store schema and projected through `legacyViewOf`, so the E2E assertions read
 * the same compatibility view the tools do. An invalid or unknown-state
 * document is absent.
 */
export function parseIndex(text) {
    try {
        const parsed = asRecord(JSON.parse(text));
        if (parsed === undefined)
            return undefined;
        if (typeof parsed.masterSessionId === 'string' && Array.isArray(parsed.threads)) {
            return parsed;
        }
        if (parsed.version === INDEX_VERSION_V2 && Array.isArray(parsed.topics)) {
            const document = normalizeProjectIndexV2(parsed);
            if (projectIndexV2Problems(document).length > 0)
                return undefined;
            return legacyViewOf(document);
        }
    }
    catch {
        // A half-written file during a poll is transient; report absence.
    }
    return undefined;
}
export async function readHandoffs(fixturePath) {
    const directory = join(fixturePath, '.dsh-cowork', 'handoffs');
    let names;
    try {
        names = await readdir(directory);
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return [];
        throw error;
    }
    const files = [];
    for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
        const filePath = join(directory, name);
        try {
            const record = asRecord(JSON.parse(await readFile(filePath, 'utf8')));
            if (record === undefined || typeof record.threadId !== 'string' || typeof record.status !== 'string')
                continue;
            if (typeof record.summary !== 'string' || typeof record.createdAt !== 'string')
                continue;
            files.push({ filePath, record: record });
        }
        catch {
        }
    }
    return files;
}
export function contentText(message) {
    const content = asRecord(message)?.content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const part of content) {
        const block = asRecord(part);
        if (block === undefined)
            continue;
        if (block.type === 'text' && typeof block.text === 'string')
            parts.push(block.text);
        else {
            try {
                parts.push(JSON.stringify(block));
            }
            catch {
                parts.push('[unserializable block]');
            }
        }
    }
    return parts.join('\n');
}
export function lastSeq(events) {
    return events.at(-1)?.seq ?? 0;
}
export function assistantTextSince(events, fromSeq) {
    const parts = [];
    for (const event of events) {
        if (event.seq <= fromSeq || event.type !== 'assistant/message')
            continue;
        const text = contentText(asRecord(event.data.message));
        if (text !== '')
            parts.push(text);
    }
    return clip(parts.join('\n'), MAX_ASSISTANT_TEXT);
}
export function toolCallsSince(events, fromSeq, name) {
    const calls = [];
    for (const event of events) {
        if (event.seq <= fromSeq || event.type !== 'tool/call')
            continue;
        const callName = typeof event.data.name === 'string' ? event.data.name : '';
        if (name !== undefined && callName !== name)
            continue;
        calls.push({ name: callName, callId: String(event.data.callId ?? `seq-${event.seq}`), arguments: clip(String(event.data.arguments ?? ''), 4000) });
    }
    return calls;
}
export function runGit(args, cwd) {
    return new Promise((settle) => {
        execFile('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error === null) {
                settle({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
                return;
            }
            const exit = error.code;
            settle({ code: typeof exit === 'number' ? exit : 1, stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' && stderr.length > 0 ? stderr : error.message });
        });
    });
}
export async function writeEvidenceAtomic(file, content) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, file);
}
export function isStrictlyInside(parent, child) {
    const base = resolve(parent);
    return resolve(child).startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}
export function recordCheck(step, name, ok, evidence) {
    const text = typeof evidence === 'string' ? evidence : stableJson(evidence);
    step.evidence.assertions.push({ name, ok, evidence: clip(text, 3000) });
    if (!ok)
        throw new Error(`assertion failed [${step.id}] ${name}: ${clip(text, 500)}`);
}
export function runView(run, evidenceFile) {
    return JSON.parse(JSON.stringify({
        runId: run.runId,
        state: run.state,
        startedAt: run.startedAt,
        ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
        steps: run.steps,
        evidenceFile,
        ...(run.error === undefined ? {} : { error: run.error }),
    }));
}
//# sourceMappingURL=m3-e2e-support.js.map