/**
 * Statuses a handoff may be *written* with (M10). The read-side vocabulary in
 * `src/store-schema.ts` keeps `awaiting_review` so old files stay readable.
 */
const HANDOFF_STATUSES = ['blocked', 'done'];
/** Optional string-array fields, normalized to `[]` when the caller omits them. */
const STRING_ARRAY_FIELDS = ['decisions', 'changedPaths', 'artifacts', 'openIssues'];
/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Whether a value is a string that `Date.parse` accepts. */
function isIsoDate(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
/**
 * Read one optional string-array field.
 *
 * `undefined` and `null` both mean "the caller did not state it": tool
 * arguments travel as JSON, where an absent optional field and an explicit
 * `null` are indistinguishable in intent, and rejecting `null` would fail
 * honest handoffs on a formatting detail.
 */
function readStringArray(input, field, errors) {
    const value = input[field];
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        errors.push({ field, message: `${field} must be an array of strings` });
        return [];
    }
    return [...value];
}
/** Collect the problems of one verification row. */
function readVerification(input, errors) {
    const value = input.verification;
    if (value === undefined || value === null) {
        errors.push({ field: 'verification', message: 'verification is required' });
        return [];
    }
    if (!Array.isArray(value)) {
        errors.push({ field: 'verification', message: 'verification must be an array' });
        return [];
    }
    if (value.length === 0) {
        errors.push({ field: 'verification', message: 'verification must not be empty' });
        return [];
    }
    const rows = [];
    value.forEach((row, position) => {
        const field = `verification[${position}]`;
        if (!isRecord(row)) {
            errors.push({ field, message: `${field} must be an object` });
            return;
        }
        let wellFormed = true;
        if (typeof row.command !== 'string' || row.command.trim() === '') {
            errors.push({ field: `${field}.command`, message: 'command must be a non-empty string' });
            wellFormed = false;
        }
        if (!Number.isInteger(row.exitCode)) {
            errors.push({ field: `${field}.exitCode`, message: 'exitCode must be an integer' });
            wellFormed = false;
        }
        if (typeof row.evidence !== 'string') {
            errors.push({ field: `${field}.evidence`, message: 'evidence must be a string' });
            wellFormed = false;
        }
        if (wellFormed) {
            rows.push({
                command: row.command,
                exitCode: row.exitCode,
                evidence: row.evidence,
            });
        }
    });
    return rows;
}
/** Read one required non-empty string field. */
function readRequiredString(input, field, errors) {
    const value = input[field];
    if (typeof value !== 'string' || value.trim() === '') {
        errors.push({ field, message: `${field} must be a non-empty string` });
        return '';
    }
    return value;
}
/**
 * Validate untrusted handoff input, collecting every field problem at once.
 * Nothing is written here: a rejected handoff leaves no file and no index
 * change behind.
 */
export function validateHandoff(input) {
    if (!isRecord(input)) {
        return { ok: false, errors: [{ field: 'input', message: 'handoff must be an object' }] };
    }
    const errors = [];
    const threadId = readRequiredString(input, 'threadId', errors);
    const masterSessionId = readRequiredString(input, 'masterSessionId', errors);
    const subject = readRequiredString(input, 'subject', errors);
    let status = 'blocked';
    const rawStatus = input.status;
    if (rawStatus === undefined || rawStatus === null) {
        errors.push({ field: 'status', message: 'status is required' });
    }
    else if (typeof rawStatus !== 'string' || !HANDOFF_STATUSES.includes(rawStatus)) {
        errors.push({
            field: 'status',
            message: `status must be one of ${HANDOFF_STATUSES.join('|')} (new/active are thread states, not handoff states)`,
        });
    }
    else {
        status = rawStatus;
    }
    const summary = readRequiredString(input, 'summary', errors);
    const verification = readVerification(input, errors);
    const optional = {};
    for (const field of STRING_ARRAY_FIELDS)
        optional[field] = readStringArray(input, field, errors);
    let nextStep = null;
    const rawNextStep = input.nextStep;
    if (rawNextStep !== undefined && rawNextStep !== null) {
        if (typeof rawNextStep !== 'string') {
            errors.push({ field: 'nextStep', message: 'nextStep must be a string' });
        }
        else {
            nextStep = rawNextStep;
        }
    }
    if (errors.length > 0)
        return { ok: false, errors };
    return {
        ok: true,
        value: {
            threadId,
            masterSessionId,
            subject,
            status,
            summary,
            decisions: optional.decisions,
            changedPaths: optional.changedPaths,
            artifacts: optional.artifacts,
            verification,
            openIssues: optional.openIssues,
            nextStep,
        },
    };
}
/** Build the persisted record: version 1, `createdAt` from the caller's clock, undelivered. */
export function buildHandoffRecord(draft, createdAt) {
    return {
        version: 1,
        threadId: draft.threadId,
        masterSessionId: draft.masterSessionId,
        status: draft.status,
        subject: draft.subject,
        summary: draft.summary,
        decisions: [...(draft.decisions ?? [])],
        changedPaths: [...(draft.changedPaths ?? [])],
        artifacts: [...(draft.artifacts ?? [])],
        verification: (draft.verification ?? []).map((row) => ({
            command: row.command,
            exitCode: row.exitCode,
            evidence: row.evidence,
        })),
        openIssues: [...(draft.openIssues ?? [])],
        nextStep: draft.nextStep ?? null,
        createdAt: createdAt.toISOString(),
        deliveredAt: null,
    };
}
/**
 * The message the master receives: a readable summary of the handoff, not the
 * JSON document (the file path is the handle to the full record).
 */
export function formatMasterMessage(record, filePath) {
    const lines = [
        `handoff from thread ${record.threadId}`,
        `status: ${record.status}`,
        `subject: ${record.subject}`,
        'summary:',
        ...record.summary.split('\n').map((line) => `  ${line}`),
    ];
    lines.push('verification:');
    for (const row of record.verification) {
        lines.push(`  - ${row.command} (exit ${row.exitCode})`);
        if (row.evidence !== '') {
            for (const line of row.evidence.split('\n'))
                lines.push(`    ${line}`);
        }
    }
    if (record.changedPaths.length > 0) {
        lines.push('changed paths:');
        for (const changedPath of record.changedPaths)
            lines.push(`  - ${changedPath}`);
    }
    if (record.openIssues.length > 0) {
        lines.push('open issues:');
        for (const issue of record.openIssues)
            lines.push(`  - ${issue}`);
    }
    lines.push(`file: ${filePath}`);
    return lines.join('\n');
}
//# sourceMappingURL=handoff.js.map