/**
 * Request tools of the Cowork request inbox (topic inbox, 2026-11-10).
 *
 * Three new topic tools — `cowork_user_review_request`, `cowork_request_question`
 * and `cowork_request_plan` — plus the extended `cowork_authorization_request`
 * in `src/topic-tools.ts`. Each one validates the caller, the topic, every
 * field and the payload before it writes anything: a refused call leaves no
 * request file and no activity row behind.
 *
 * A "user review request" is the user's own pass/return decision. It is not
 * the automatic reviewer: `cowork_review_request` / `cowork_review_verdict` are
 * untouched, and a reviewer verdict stays a read-only inbox note.
 *
 * The tools never wake a model and never open a host dialog; they persist the
 * request and its `request-created` activity and return the id the inbox acts
 * on.
 */
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { PLAN_PATH_MAX_CHARS, PLAN_TITLE_MAX_CHARS, QUESTION_MAX_QUESTIONS, QUESTION_PROMPT_MAX_CHARS, REQUEST_SUMMARY_MAX_CHARS, REVIEW_MAX_CHANGED_PATHS, REVIEW_MAX_VERIFICATION, REVIEW_PURPOSE_MAX_CHARS, REVIEW_TEXT_MAX_CHARS, } from './inbox-contract.js';
import { PanelServiceError, createRequest } from './request-service.js';
import { isRepoRelativePosixPath, normalizeQuestion, normalizeVerification, payloadProblems, } from './request-schema.js';
import { callerOf, isFailure, mapError, nowOf, openProject, renderJson, toJson, topicView, } from './tool-runtime.js';
import { TOPIC_ERROR_CODES, checkRole, failure, success } from './tool-model.js';
/** Wire codes owned by the request tools. */
export const REQUEST_TOOL_ERROR_CODES = {
    /** A payload field is missing, malformed, or over its contract cap. */
    payloadInvalid: 'request/payload-invalid',
    /** The plan path is not a repo-relative POSIX path. */
    planPathInvalid: 'request/plan-path-invalid',
    /** The topic is archived, so it may not ask the user for anything. */
    topicArchived: 'request/topic-archived',
};
/** A non-empty trimmed string within `limit` code points, or null. */
function boundedText(value, limit) {
    if (typeof value !== 'string')
        return null;
    const text = value.trim();
    if (text === '' || Array.from(text).length > limit)
        return null;
    return text;
}
/** Resolve the calling session's topic; a master or a stranger is refused. */
async function callerTopic(caller, deps) {
    const opened = await openProject(caller, deps);
    if (isFailure(opened))
        return { ok: false, failure: toJson(opened) };
    const denied = checkRole('thread', caller, opened.index);
    if (denied !== null)
        return { ok: false, failure: toJson(denied) };
    const document = await opened.store.readIndexDocument();
    const topic = document.topics.find((entry) => entry.topicId === caller.sessionId);
    if (topic === undefined) {
        return {
            ok: false,
            failure: toJson(failure(TOPIC_ERROR_CODES.topicNotFound, `topic ${caller.sessionId} is not in the project index`)),
        };
    }
    if (topic.status === 'resolved') {
        return {
            ok: false,
            failure: toJson(failure(REQUEST_TOOL_ERROR_CODES.topicArchived, `topic ${caller.sessionId} is archived, so it cannot request a user action`)),
        };
    }
    return { ok: true, opened, topic };
}
/** The model-facing success payload of one created request. */
function createdPayload(record, topic) {
    return toJson(success({
        requestId: record.requestId,
        kind: record.kind,
        status: record.status,
        summary: record.summary,
        requestMessage: record.requestMessage,
        topic: topicView(topic),
    }));
}
/** Map a refused creation onto a tool failure instead of throwing. */
function creationFailure(error) {
    if (error instanceof PanelServiceError)
        return toJson(failure(error.code, error.message));
    return toJson(mapError(error));
}
/** Validate a payload and return its problems as one tool failure, or null. */
function payloadFailure(kind, payload) {
    const problems = payloadProblems(kind, payload);
    if (problems.length === 0)
        return null;
    return toJson(failure(REQUEST_TOOL_ERROR_CODES.payloadInvalid, problems.join('; ')));
}
/** Persist one validated request for the caller's topic. */
async function persist(resolved, kind, payload, summary, deps) {
    const document = await resolved.opened.store.readIndexDocument();
    const record = await createRequest({
        store: resolved.opened.store,
        repoPath: resolved.opened.repoPath,
        projectId: document.projectId,
        topic: resolved.topic,
        kind,
        payload,
        summary,
        requestId: randomUUID(),
        now: nowOf(deps),
        log: deps.log,
    });
    return createdPayload(record, resolved.topic);
}
/**
 * `cowork_user_review_request`: ask the user to pass or return this topic's
 * work, optionally pointing at an automatic review request for context.
 */
async function requestUserReview(args, exec, deps) {
    const caller = callerOf(exec);
    if (isFailure(caller))
        return toJson(caller);
    const purpose = boundedText(args.purpose, REVIEW_PURPOSE_MAX_CHARS);
    if (purpose === null) {
        return toJson(failure(REQUEST_TOOL_ERROR_CODES.payloadInvalid, `purpose must be a non-empty string of at most ${REVIEW_PURPOSE_MAX_CHARS} characters`));
    }
    const changedPaths = [];
    if (args.changedPaths !== undefined) {
        if (!Array.isArray(args.changedPaths) || args.changedPaths.length > REVIEW_MAX_CHANGED_PATHS) {
            return toJson(failure(REQUEST_TOOL_ERROR_CODES.payloadInvalid, `changedPaths must be an array of at most ${REVIEW_MAX_CHANGED_PATHS} strings`));
        }
        for (const path of args.changedPaths) {
            const text = boundedText(path, REVIEW_TEXT_MAX_CHARS);
            if (text === null) {
                return toJson(failure(REQUEST_TOOL_ERROR_CODES.payloadInvalid, `every changed path must be a non-empty string of at most ${REVIEW_TEXT_MAX_CHARS} characters`));
            }
            changedPaths.push(text);
        }
    }
    const verification = [];
    if (args.verification !== undefined) {
        if (!Array.isArray(args.verification) || args.verification.length > REVIEW_MAX_VERIFICATION) {
            return toJson(failure(REQUEST_TOOL_ERROR_CODES.payloadInvalid, `verification must be an array of at most ${REVIEW_MAX_VERIFICATION} rows`));
        }
        for (const row of args.verification)
            verification.push(normalizeVerification(row));
    }
    const payload = { purpose };
    if (changedPaths.length > 0)
        payload.changedPaths = changedPaths;
    if (verification.length > 0)
        payload.verification = verification;
    if (args.reviewRequestId !== undefined) {
        const reviewRequestId = boundedText(args.reviewRequestId, REVIEW_TEXT_MAX_CHARS);
        if (reviewRequestId === null) {
            return toJson(failure(REQUEST_TOOL_ERROR_CODES.payloadInvalid, `reviewRequestId must be a non-empty string of at most ${REVIEW_TEXT_MAX_CHARS} characters`));
        }
        payload.reviewRequestId = reviewRequestId;
    }
    const refused = payloadFailure('user-review', payload);
    if (refused !== null)
        return refused;
    try {
        const resolved = await callerTopic(caller, deps);
        if (!resolved.ok)
            return resolved.failure;
        return await persist(resolved, 'user-review', payload, undefined, deps);
    }
    catch (error) {
        return creationFailure(error);
    }
}
/**
 * `cowork_request_question`: ask the user one to five single/multi choice
 * questions (optionally with a free-text answer). The server mints the
 * question and option ids the resolve route validates against.
 */
async function requestQuestion(args, exec, deps) {
    const caller = callerOf(exec);
    if (isFailure(caller))
        return toJson(caller);
    if (!Array.isArray(args.questions) || args.questions.length === 0
        || args.questions.length > QUESTION_MAX_QUESTIONS) {
        return toJson(failure(REQUEST_TOOL_ERROR_CODES.payloadInvalid, `questions must carry between 1 and ${QUESTION_MAX_QUESTIONS} entries`));
    }
    const payload = {
        questions: args.questions.map((question, index) => normalizeQuestion(question, index)),
    };
    const refused = payloadFailure('question', payload);
    if (refused !== null)
        return refused;
    try {
        const resolved = await callerTopic(caller, deps);
        if (!resolved.ok)
            return resolved.failure;
        return await persist(resolved, 'question', payload, undefined, deps);
    }
    catch (error) {
        return creationFailure(error);
    }
}
/**
 * `cowork_request_plan`: register a plan file inside this repository and ask
 * the user to approve it or ask for changes. The file itself is opened by the
 * host file browser through the inbox; the browser never sends a path.
 */
async function requestPlan(args, exec, deps) {
    const caller = callerOf(exec);
    if (isFailure(caller))
        return toJson(caller);
    const planPath = args.planPath;
    if (!isRepoRelativePosixPath(planPath, PLAN_PATH_MAX_CHARS)) {
        return toJson(failure(REQUEST_TOOL_ERROR_CODES.planPathInvalid, `planPath must be a repo-relative POSIX path of at most ${PLAN_PATH_MAX_CHARS} characters`));
    }
    const summary = boundedText(args.summary, REQUEST_SUMMARY_MAX_CHARS);
    if (summary === null) {
        return toJson(failure(REQUEST_TOOL_ERROR_CODES.payloadInvalid, `summary must be a non-empty string of at most ${REQUEST_SUMMARY_MAX_CHARS} characters`));
    }
    const payload = { planPath };
    if (args.planTitle !== undefined) {
        const planTitle = boundedText(args.planTitle, PLAN_TITLE_MAX_CHARS);
        if (planTitle === null) {
            return toJson(failure(REQUEST_TOOL_ERROR_CODES.payloadInvalid, `planTitle must be a non-empty string of at most ${PLAN_TITLE_MAX_CHARS} characters`));
        }
        payload.planTitle = planTitle;
    }
    const refused = payloadFailure('plan', payload);
    if (refused !== null)
        return refused;
    try {
        const resolved = await callerTopic(caller, deps);
        if (!resolved.ok)
            return resolved.failure;
        return await persist(resolved, 'plan', payload, summary, deps);
    }
    catch (error) {
        return creationFailure(error);
    }
}
/** The shared user-review parameter schema, kept next to its tool. */
const USER_REVIEW_PARAMETERS = {
    purpose: {
        type: 'string',
        required: true,
        description: `What the user should review and why (max ${REVIEW_PURPOSE_MAX_CHARS} characters).`,
    },
    changedPaths: {
        type: 'array',
        items: { type: 'string' },
        description: `Repository-relative paths this review covers (at most ${REVIEW_MAX_CHANGED_PATHS}).`,
    },
    verification: {
        type: 'array',
        description: `Checks you actually ran (at most ${REVIEW_MAX_VERIFICATION} rows).`,
        items: {
            type: 'object',
            additionalProperties: false,
            properties: {
                command: { type: 'string', required: true, description: 'Exact command that was run.' },
                exitCode: { type: 'integer', required: true, description: 'Exit code the command returned.' },
                evidence: { type: 'string', required: true, description: 'Short output that proves it.' },
            },
        },
    },
    reviewRequestId: {
        type: 'string',
        description: 'Optional automatic-review request id this user review refers to (context only).',
    },
};
/** The shared question parameter schema, kept next to its tool. */
const QUESTION_PARAMETERS = {
    questions: {
        type: 'array',
        required: true,
        description: `One to ${QUESTION_MAX_QUESTIONS} questions; the server mints the ids.`,
        items: {
            type: 'object',
            additionalProperties: false,
            properties: {
                prompt: {
                    type: 'string',
                    required: true,
                    description: `Question text (max ${QUESTION_PROMPT_MAX_CHARS} characters).`,
                },
                mode: {
                    type: 'string',
                    enum: ['single', 'multi'],
                    description: "'single' picks one option, 'multi' picks any number.",
                },
                options: {
                    type: 'array',
                    description: 'Options the user may pick; ids are minted as o1..on.',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            label: { type: 'string', required: true, description: 'Option label.' },
                            description: { type: 'string', description: 'Optional secondary line.' },
                            recommended: { type: 'boolean', description: 'Marks the suggested option.' },
                        },
                    },
                },
                allowText: { type: 'boolean', description: 'Offer a free-text answer input too.' },
            },
        },
    },
};
/**
 * Register the three request tools and return their disposers, in the
 * documented registration order (after the topic tools).
 */
export function registerRequestTools(ctx, deps) {
    const host = ctx;
    const disposers = [];
    const reviewExecute = (args, exec) => requestUserReview(args, exec, deps);
    const questionExecute = (args, exec) => requestQuestion(args, exec, deps);
    const planExecute = (args, exec) => requestPlan(args, exec, deps);
    disposers.push(host.tools.register(defineTool({
        name: 'cowork_user_review_request',
        description: "Ask the user to pass or return this topic's work: writes one user review request the Cowork inbox shows as a card. This is the user's decision, not the automatic reviewer (use cowork_review_request for that). Topic only.",
        parameters: USER_REVIEW_PARAMETERS,
        output: { schema: { type: 'json' }, render: renderJson },
        execute: reviewExecute,
    })));
    disposers.push(host.tools.register(defineTool({
        name: 'cowork_request_question',
        description: 'Ask the user up to five single/multi choice questions; the Cowork inbox shows one card with the questions and the answers arrive through the inbox resolve route. Topic only.',
        parameters: QUESTION_PARAMETERS,
        output: { schema: { type: 'json' }, render: renderJson },
        execute: questionExecute,
    })));
    disposers.push(host.tools.register(defineTool({
        name: 'cowork_request_plan',
        description: 'Register a plan file inside this repository and ask the user to approve it or request changes. The inbox opens the file through the host file browser; the browser never receives a path. Topic only.',
        parameters: {
            planPath: {
                type: 'string',
                required: true,
                description: `Repository-relative POSIX path of the plan file (max ${PLAN_PATH_MAX_CHARS} characters).`,
            },
            planTitle: { type: 'string', description: `Short plan title (max ${PLAN_TITLE_MAX_CHARS} characters).` },
            summary: {
                type: 'string',
                required: true,
                description: `What the user is confirming (max ${REQUEST_SUMMARY_MAX_CHARS} characters).`,
            },
        },
        output: { schema: { type: 'json' }, render: renderJson },
        execute: planExecute,
    })));
    return disposers;
}
//# sourceMappingURL=request-tools.js.map