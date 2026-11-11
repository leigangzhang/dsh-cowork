/**
 * Request-record model of the Cowork request inbox (topic inbox, 2026-11-10).
 *
 * One `RequestRecordV1` is one pending user action — a user review, an
 * authorization, a question set or a plan confirmation — persisted at
 * `<repo>/.dsh-cowork/requests/<requestId>.json`. This module owns the shape,
 * the kind/status/payload combinations, the length caps and the two persisted
 * conversation messages ("左侧主题消息 + 右侧用户回复"), so the store only
 * moves bytes, the service only decides state, and the browser never rebuilds
 * a message on its own.
 *
 * Every cap and every enumeration comes from `src/inbox-contract.ts`; this
 * module restates none of them, because the browser half is compiled against
 * the same frozen vocabulary.
 */
import {
  AUTHORIZATION_COMMAND_MAX_CHARS,
  PLAN_PATH_MAX_CHARS,
  PLAN_TITLE_MAX_CHARS,
  QUESTION_MAX_OPTIONS,
  QUESTION_MAX_QUESTIONS,
  QUESTION_OPTION_DESCRIPTION_MAX_CHARS,
  QUESTION_OPTION_LABEL_MAX_CHARS,
  QUESTION_PROMPT_MAX_CHARS,
  QUESTION_TEXT_MAX_CHARS,
  REQUEST_ACTION_STATUS,
  REQUEST_COMMENT_MAX_CHARS,
  REQUEST_MESSAGE_MAX_CHARS,
  REQUEST_PAYLOAD_MAX_BYTES,
  REQUEST_RECORD_VERSION,
  REQUEST_SUMMARY_MAX_CHARS,
  REQUEST_TITLE_MAX_CHARS,
  RESOLUTION_MESSAGE_MAX_CHARS,
  REVIEW_MAX_CHANGED_PATHS,
  REVIEW_MAX_VERIFICATION,
  REVIEW_PURPOSE_MAX_CHARS,
  REVIEW_TEXT_MAX_CHARS,
  REQUEST_ACTIONS_BY_KIND,
  actionAllowed,
  actionForStatus,
  answerCoversQuestion,
  isRequestAction,
  isRequestKind,
  isRequestStatus,
  isTerminalStatus,
} from './inbox-contract.js'
import { truncateSummary } from './api-contract.js'
import type {
  AuthorizationPayload,
  InboxAnswerInput,
  PlanPayload,
  QuestionOption,
  QuestionPayload,
  QuestionSpec,
  RequestDelivery,
  RequestKind,
  RequestPayload,
  RequestRecordV1,
  RequestResolution,
  RequestStatus,
  ReviewPayload,
  ReviewVerification,
} from './inbox-contract.js'

/** Directory holding one file per request, below `<repo>/.dsh-cowork`. */
export const REQUEST_DIR_NAME = 'requests'

/** Suffix of every request file; the file name is the bare request id. */
export const REQUEST_FILE_SUFFIX = '.json'

/** Longest request id this module accepts (a UUID in production). */
export const REQUEST_ID_MAX_CHARS = 64

/** Longest prompt failure kept in `delivery.lastError`. */
export const REQUEST_DELIVERY_ERROR_MAX_CHARS = 300

/**
 * Longest wake-up prompt rebuilt from a resolution. The comment alone can reach
 * 2000 characters, so the prompt needs more room than the 200-character reply
 * while still staying a bounded host queue message.
 */
export const RESOLUTION_PROMPT_MAX_CHARS = 4000

/** Why one request document was refused. */
export class RequestSchemaError extends Error {
  readonly problems: string[]

  constructor(message: string, problems: string[]) {
    super(`${message}: ${problems.join('; ')}`)
    this.name = 'RequestSchemaError'
    this.problems = problems
  }
}

/** Whether a value is a safe request id: file-name characters only, no dot. */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= REQUEST_ID_MAX_CHARS
    && /^[A-Za-z0-9_-]+$/.test(value)
}

/** The file name of one request; the id can never carry a path separator. */
export function requestFileName(requestId: string): string {
  if (!isRequestId(requestId)) {
    throw new RequestSchemaError('requestId is not a file-name safe id', [`requestId: ${String(requestId)}`])
  }
  return `${requestId}${REQUEST_FILE_SUFFIX}`
}

/** Delivery state of a request that has never been prompted. */
export function emptyDelivery(): RequestDelivery {
  return { promptedAt: null, lastError: null }
}

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is a string `Date.parse` accepts. */
function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/** Code points of a string, its schema length. */
function lengthOf(value: string): number {
  return Array.from(value).length
}

/** Cut text to at most `limit` code points, marking the cut. */
function clipCodePoints(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length <= limit ? text : `${points.slice(0, limit - 1).join('')}…`
}

/** Whether a value is a non-empty string within `limit` code points. */
function isBoundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && lengthOf(value) <= limit
}

/** Problems of one optional bounded text field. */
function optionalTextProblems(value: unknown, field: string, limit: number): string[] {
  if (value === undefined) return []
  if (!isBoundedText(value, limit)) {
    return [`${field} must be a non-empty string of at most ${limit} characters`]
  }
  return []
}

/** Whether a repo-relative POSIX path stays inside the repository. */
export function isRepoRelativePosixPath(value: unknown, limit: number): value is string {
  if (!isBoundedText(value, limit)) return false
  if (value.startsWith('/') || value.includes('\\')) return false
  if (/^[A-Za-z]:/.test(value)) return false
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** Problems of the review payload, in contract order. */
function reviewPayloadProblems(payload: Record<string, unknown>): string[] {
  const problems: string[] = []
  if (!isBoundedText(payload.purpose, REVIEW_PURPOSE_MAX_CHARS)) {
    problems.push(`payload.purpose must be a non-empty string of at most ${REVIEW_PURPOSE_MAX_CHARS} characters`)
  }
  if (payload.changedPaths !== undefined) {
    if (!Array.isArray(payload.changedPaths)) {
      problems.push('payload.changedPaths must be an array of strings')
    } else if (payload.changedPaths.length > REVIEW_MAX_CHANGED_PATHS) {
      problems.push(`payload.changedPaths must not exceed ${REVIEW_MAX_CHANGED_PATHS} entries`)
    } else {
      payload.changedPaths.forEach((path, index) => {
        if (!isBoundedText(path, REVIEW_TEXT_MAX_CHARS)) {
          problems.push(`payload.changedPaths[${index}] must be a non-empty string of at most ${REVIEW_TEXT_MAX_CHARS} characters`)
        }
      })
    }
  }
  if (payload.verification !== undefined) {
    if (!Array.isArray(payload.verification)) {
      problems.push('payload.verification must be an array of verification rows')
    } else if (payload.verification.length > REVIEW_MAX_VERIFICATION) {
      problems.push(`payload.verification must not exceed ${REVIEW_MAX_VERIFICATION} rows`)
    } else {
      payload.verification.forEach((row, index) => {
        problems.push(...verificationRowProblems(row, `payload.verification[${index}]`))
      })
    }
  }
  problems.push(...optionalTextProblems(payload.reviewRequestId, 'payload.reviewRequestId', REVIEW_TEXT_MAX_CHARS))
  return problems
}

/** Problems of one verification row of a user review. */
function verificationRowProblems(row: unknown, where: string): string[] {
  if (!isRecord(row)) return [`${where} must be an object`]
  const problems: string[] = []
  if (!isBoundedText(row.command, REVIEW_TEXT_MAX_CHARS)) {
    problems.push(`${where}.command must be a non-empty string of at most ${REVIEW_TEXT_MAX_CHARS} characters`)
  }
  if (typeof row.exitCode !== 'number' || !Number.isInteger(row.exitCode)) {
    problems.push(`${where}.exitCode must be an integer`)
  }
  if (!isBoundedText(row.evidence, REVIEW_TEXT_MAX_CHARS)) {
    problems.push(`${where}.evidence must be a non-empty string of at most ${REVIEW_TEXT_MAX_CHARS} characters`)
  }
  return problems
}

/** Problems of the authorization payload. */
function authorizationPayloadProblems(payload: Record<string, unknown>): string[] {
  const problems: string[] = []
  if (!isBoundedText(payload.summary, REQUEST_SUMMARY_MAX_CHARS)) {
    problems.push(`payload.summary must be a non-empty string of at most ${REQUEST_SUMMARY_MAX_CHARS} characters`)
  }
  problems.push(...optionalTextProblems(payload.command, 'payload.command', AUTHORIZATION_COMMAND_MAX_CHARS))
  return problems
}

/** Problems of one question option. */
function optionProblems(option: unknown, where: string): string[] {
  if (!isRecord(option)) return [`${where} must be an object`]
  const problems: string[] = []
  if (!isBoundedText(option.id, QUESTION_OPTION_LABEL_MAX_CHARS)) {
    problems.push(`${where}.id must be a non-empty string`)
  }
  if (!isBoundedText(option.label, QUESTION_OPTION_LABEL_MAX_CHARS)) {
    problems.push(`${where}.label must be a non-empty string of at most ${QUESTION_OPTION_LABEL_MAX_CHARS} characters`)
  }
  problems.push(...optionalTextProblems(
    option.description,
    `${where}.description`,
    QUESTION_OPTION_DESCRIPTION_MAX_CHARS,
  ))
  if (option.recommended !== undefined && typeof option.recommended !== 'boolean') {
    problems.push(`${where}.recommended must be a boolean`)
  }
  return problems
}

/** Problems of one question spec. */
function questionProblems(question: unknown, where: string): string[] {
  if (!isRecord(question)) return [`${where} must be an object`]
  const problems: string[] = []
  if (!isBoundedText(question.id, QUESTION_PROMPT_MAX_CHARS)) problems.push(`${where}.id must be a non-empty string`)
  if (!isBoundedText(question.prompt, QUESTION_PROMPT_MAX_CHARS)) {
    problems.push(`${where}.prompt must be a non-empty string of at most ${QUESTION_PROMPT_MAX_CHARS} characters`)
  }
  if (question.mode !== 'single' && question.mode !== 'multi') {
    problems.push(`${where}.mode must be 'single' or 'multi'`)
  }
  if (question.options !== undefined) {
    if (!Array.isArray(question.options)) {
      problems.push(`${where}.options must be an array of options`)
    } else if (question.options.length > QUESTION_MAX_OPTIONS) {
      problems.push(`${where}.options must not exceed ${QUESTION_MAX_OPTIONS} entries`)
    } else {
      question.options.forEach((option, index) => {
        problems.push(...optionProblems(option, `${where}.options[${index}]`))
      })
    }
  }
  if (question.allowText !== undefined && typeof question.allowText !== 'boolean') {
    problems.push(`${where}.allowText must be a boolean`)
  }
  return problems
}

/** Problems of the question payload. */
function questionPayloadProblems(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.questions)) return ['payload.questions must be an array']
  if (payload.questions.length === 0 || payload.questions.length > QUESTION_MAX_QUESTIONS) {
    return [`payload.questions must hold between 1 and ${QUESTION_MAX_QUESTIONS} entries`]
  }
  const problems: string[] = []
  const seen = new Set<string>()
  payload.questions.forEach((question, index) => {
    problems.push(...questionProblems(question, `payload.questions[${index}]`))
    if (isRecord(question) && typeof question.id === 'string') {
      if (seen.has(question.id)) problems.push(`payload.questions[${index}].id is duplicated: ${question.id}`)
      seen.add(question.id)
    }
  })
  return problems
}

/** Problems of the plan payload. */
function planPayloadProblems(payload: Record<string, unknown>): string[] {
  const problems: string[] = []
  if (!isRepoRelativePosixPath(payload.planPath, PLAN_PATH_MAX_CHARS)) {
    problems.push(`payload.planPath must be a repo-relative POSIX path of at most ${PLAN_PATH_MAX_CHARS} characters`)
  }
  problems.push(...optionalTextProblems(payload.planTitle, 'payload.planTitle', PLAN_TITLE_MAX_CHARS))
  return problems
}

/** Problems of the payload matching `kind`; `[]` means it is valid. */
export function payloadProblems(kind: RequestKind, payload: unknown): string[] {
  if (!isRecord(payload)) return ['payload must be a JSON object']
  const problems = kind === 'user-review'
    ? reviewPayloadProblems(payload)
    : kind === 'authorization'
      ? authorizationPayloadProblems(payload)
      : kind === 'question'
        ? questionPayloadProblems(payload)
        : planPayloadProblems(payload)
  if (problems.length > 0) return problems
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  if (bytes > REQUEST_PAYLOAD_MAX_BYTES) {
    return [`payload is ${bytes} bytes; the limit is ${REQUEST_PAYLOAD_MAX_BYTES}`]
  }
  return []
}

/**
 * Validate the answers of one `question` submit. Every question must be
 * answered by at least one selected option or a text answer; an unknown
 * question, an unknown option, more than one selection in `single` mode and a
 * text over its cap are each their own problem. The caller maps all of them to
 * `inbox/invalid-answer`.
 */
export function answerProblems(
  payload: QuestionPayload,
  answers: readonly InboxAnswerInput[] | undefined,
): string[] {
  if (!Array.isArray(answers)) return ['answers must be an array of answers']
  const problems: string[] = []
  const byQuestion = new Map<string, InboxAnswerInput>()
  for (const answer of answers) {
    if (!isRecord(answer) || typeof answer.questionId !== 'string' || answer.questionId.trim() === '') {
      problems.push('every answer must carry a non-empty questionId')
      continue
    }
    const row = answer as unknown as InboxAnswerInput
    if (byQuestion.has(row.questionId)) {
      problems.push(`question ${answer.questionId} was answered twice`)
      continue
    }
    byQuestion.set(row.questionId, row)
  }
  const known = new Set(payload.questions.map((question) => question.id))
  for (const questionId of byQuestion.keys()) {
    if (!known.has(questionId)) problems.push(`answer names an unknown question: ${questionId}`)
  }
  for (const question of payload.questions) {
    const answer = byQuestion.get(question.id)
    if (answer === undefined) {
      problems.push(`question ${question.id} was not answered`)
      continue
    }
    const selected = answer.selected
    if (selected !== undefined) {
      if (!Array.isArray(selected) || selected.some((id) => typeof id !== 'string')) {
        problems.push(`answer.selected for ${question.id} must be an array of option ids`)
      } else {
        const optionIds = new Set((question.options ?? []).map((option) => option.id))
        for (const id of selected) {
          if (!optionIds.has(id)) problems.push(`answer.selected for ${question.id} names an unknown option: ${id}`)
        }
        if (question.mode === 'single' && selected.length > 1) {
          problems.push(`question ${question.id} accepts one selection, got ${selected.length}`)
        }
      }
    }
    const text = answer.text
    if (text !== undefined) {
      if (typeof text !== 'string') {
        problems.push(`answer.text for ${question.id} must be a string`)
      } else if (lengthOf(text) > QUESTION_TEXT_MAX_CHARS) {
        problems.push(`answer.text for ${question.id} must be at most ${QUESTION_TEXT_MAX_CHARS} characters`)
      } else if (text.trim() !== '' && question.allowText !== true) {
        problems.push(`question ${question.id} does not accept a free-text answer`)
      }
    }
    // The shared rule decides whether the question counts as answered; the
    // checks above only explain why it does not. Keeping the gate here in one
    // place is what stops the card and the host from drifting.
    if (!answerCoversQuestion(question, answer)) {
      const selectedCount = Array.isArray(selected) ? selected.length : 0
      const hasText = typeof text === 'string' && text.trim() !== ''
      if (selectedCount === 0 && !hasText) problems.push(`question ${question.id} has no answer`)
    }
  }
  return problems
}

/** Problems of one persisted request record; `[]` means it is valid. */
export function requestRecordProblems(record: unknown): string[] {
  if (!isRecord(record)) return ['request must be a JSON object']
  const problems: string[] = []
  if (record.version !== REQUEST_RECORD_VERSION) problems.push(`request.version must be ${REQUEST_RECORD_VERSION}`)
  if (!isRequestId(record.requestId)) problems.push('request.requestId must be a file-name safe id')
  if (!isBoundedText(record.projectId, REQUEST_TITLE_MAX_CHARS)) problems.push('request.projectId must be a non-empty string')
  if (!isBoundedText(record.topicId, REQUEST_TITLE_MAX_CHARS)) problems.push('request.topicId must be a non-empty string')
  if (!isRequestKind(record.kind)) problems.push('request.kind must be one of user-review|authorization|question|plan')
  if (!isRequestStatus(record.status)) problems.push('request.status must be a known request status')
  if (!isBoundedText(record.title, REQUEST_TITLE_MAX_CHARS)) {
    problems.push(`request.title must be a non-empty string of at most ${REQUEST_TITLE_MAX_CHARS} characters`)
  }
  if (!isBoundedText(record.summary, REQUEST_SUMMARY_MAX_CHARS)) {
    problems.push(`request.summary must be a non-empty string of at most ${REQUEST_SUMMARY_MAX_CHARS} characters`)
  }
  if (!isBoundedText(record.requestMessage, REQUEST_MESSAGE_MAX_CHARS)) {
    problems.push(`request.requestMessage must be a non-empty string of at most ${REQUEST_MESSAGE_MAX_CHARS} characters`)
  }
  if (isRequestKind(record.kind)) {
    problems.push(...payloadProblems(record.kind, record.payload))
    if (isRequestStatus(record.status)) {
      const action = actionForStatus(record.status)
      if (action !== null && !actionAllowed(record.kind, action)) {
        problems.push(`request.status ${record.status} is not a terminal state of kind ${record.kind}`)
      }
    }
  }
  if (!isIsoDate(record.createdAt)) problems.push('request.createdAt must be an ISO 8601 timestamp')
  if (!isIsoDate(record.updatedAt)) problems.push('request.updatedAt must be an ISO 8601 timestamp')
  if (record.resolvedAt !== null && !isIsoDate(record.resolvedAt)) {
    problems.push('request.resolvedAt must be an ISO 8601 timestamp or null')
  }
  if (record.resolvedBy !== null && record.resolvedBy !== 'user' && record.resolvedBy !== 'master') {
    problems.push("request.resolvedBy must be 'user', 'master' or null")
  }
  problems.push(...deliveryProblems(record.delivery))
  if (isRequestStatus(record.status)) {
    problems.push(...resolutionPairProblems(record))
    problems.push(...resolutionProblems(record))
  }
  return problems
}

/**
 * Problems of the durable resolution block. It is additive and optional, so a
 * record written before it existed still parses; when present it must agree
 * with the status and, for a question, with the payload's own answer rule.
 */
function resolutionProblems(record: Record<string, unknown>): string[] {
  const resolution = record.resolution
  if (resolution === undefined) return []
  if (!isRecord(resolution)) return ['request.resolution must be an object']
  const problems: string[] = []
  if (!isTerminalStatus(record.status as RequestStatus)) {
    problems.push('request.resolution is only allowed once the request is resolved')
  }
  const comment = resolution.comment
  if (comment !== undefined && !isBoundedText(comment, REQUEST_COMMENT_MAX_CHARS)) {
    problems.push(`request.resolution.comment must be a non-empty string of at most ${REQUEST_COMMENT_MAX_CHARS} characters`)
  }
  const answers = resolution.answers
  if (comment === undefined && answers === undefined) {
    problems.push('request.resolution must carry a comment or answers')
  }
  if (answers !== undefined) {
    if (record.kind !== 'question') {
      problems.push('request.resolution.answers is only allowed on a question request')
    } else if (!Array.isArray(answers)) {
      problems.push('request.resolution.answers must be an array of answers')
    } else if (payloadProblems('question', record.payload).length === 0) {
      problems.push(...answerProblems(record.payload as unknown as QuestionPayload, answers)
        .map((problem) => `request.resolution ${problem}`))
    }
  }
  return problems
}

/** Problems of the persisted conversation pair, which must agree with status. */
function resolutionPairProblems(record: Record<string, unknown>): string[] {
  const problems: string[] = []
  const terminal = isTerminalStatus(record.status as RequestStatus)
  const message = record.resolutionMessage
  if (terminal) {
    if (!isBoundedText(message, RESOLUTION_MESSAGE_MAX_CHARS)) {
      problems.push(`request.resolutionMessage must be a non-empty string of at most ${RESOLUTION_MESSAGE_MAX_CHARS} characters once resolved`)
    }
    if (record.resolvedAt === null) problems.push('request.resolvedAt is required once resolved')
    if (record.resolvedBy === null) problems.push('request.resolvedBy is required once resolved')
    return problems
  }
  if (message !== null) problems.push('request.resolutionMessage must be null while the request is pending')
  if (record.resolvedAt !== null) problems.push('request.resolvedAt must be null while the request is pending')
  if (record.resolvedBy !== null) problems.push('request.resolvedBy must be null while the request is pending')
  return problems
}

/** Problems of the delivery block. */
function deliveryProblems(delivery: unknown): string[] {
  if (!isRecord(delivery)) return ['request.delivery must be an object']
  const problems: string[] = []
  if (delivery.promptedAt !== null && !isIsoDate(delivery.promptedAt)) {
    problems.push('request.delivery.promptedAt must be an ISO 8601 timestamp or null')
  }
  if (delivery.lastError !== null && !isBoundedText(delivery.lastError, REQUEST_DELIVERY_ERROR_MAX_CHARS)) {
    problems.push(`request.delivery.lastError must be a string of at most ${REQUEST_DELIVERY_ERROR_MAX_CHARS} characters or null`)
  }
  return problems
}

/** One parse of a request file: the record, or the problems it carries. */
export type ParsedRequestRecord =
  | { readonly ok: true; readonly record: RequestRecordV1 }
  | { readonly ok: false; readonly problems: string[] }

/** Parse one request document without touching the file system. */
export function parseRequestRecordText(text: string): ParsedRequestRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, problems: [`invalid JSON (${error instanceof Error ? error.message : String(error)})`] }
  }
  const problems = requestRecordProblems(parsed)
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, record: parsed as RequestRecordV1 }
}

/** The short summary line the list row carries, derived from the payload. */
export function defaultSummary(kind: RequestKind, payload: RequestPayload): string {
  const text = kind === 'user-review'
    ? (payload as ReviewPayload).purpose
    : kind === 'authorization'
      ? (payload as AuthorizationPayload).summary
      : kind === 'question'
        ? (payload as QuestionPayload).questions[0]?.prompt ?? ''
        : (payload as PlanPayload).planTitle ?? (payload as PlanPayload).planPath
  return truncateSummary(text, REQUEST_SUMMARY_MAX_CHARS)
}

/** The persisted left-hand message: the topic speaks, then states the ask. */
export function requestMessage(kind: RequestKind, topicTitle: string, payload: RequestPayload): string {
  const subject = `主题「${truncateSummary(topicTitle, REQUEST_TITLE_MAX_CHARS)}」`
  const body = kind === 'user-review'
    ? `请你审核：${(payload as ReviewPayload).purpose}`
    : kind === 'authorization'
      ? `等待你的授权：${(payload as AuthorizationPayload).summary}`
      : kind === 'question'
        ? `请你回答：${questionMessageBody(payload as QuestionPayload)}`
        : `请你确认计划${planMessageBody(payload as PlanPayload)}`
  return truncateSummary(`${subject}${body}`, REQUEST_MESSAGE_MAX_CHARS)
}

/** The question part of a left-hand message: first prompt plus a count. */
function questionMessageBody(payload: QuestionPayload): string {
  const first = payload.questions[0]
  if (first === undefined) return ''
  return payload.questions.length === 1
    ? first.prompt
    : `${first.prompt}（共 ${payload.questions.length} 个问题）`
}

/** The plan part of a left-hand message: the title when it has one. */
function planMessageBody(payload: PlanPayload): string {
  const title = payload.planTitle
  return title === undefined || title.trim() === '' ? `：${payload.planPath}` : `《${title}》`
}

/** Sentence the right-hand reply starts with, per terminal status. */
const RESOLUTION_HEADLINE: Readonly<Record<RequestStatus, string>> = {
  pending: '',
  passed: '已通过评审。',
  returned: '已退回评审。',
  allowed: '已允许该授权。',
  denied: '已拒绝该授权。',
  answered: '已回答全部问题。',
  skipped: '已跳过这些问题。',
  approved: '已同意该计划。',
  revise: '已要求修改计划。',
  void: '该请求已随主题归档作废。',
}

/** One answered question as the reply and the prompt spell it out. */
function answerSummaryOf(payload: QuestionPayload, answers: readonly InboxAnswerInput[]): string {
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]))
  const parts: string[] = []
  payload.questions.forEach((question, index) => {
    const answer = byQuestion.get(question.id)
    if (answer === undefined) return
    const labels = (answer.selected ?? []).map(
      (id) => question.options?.find((option) => option.id === id)?.label ?? id,
    )
    const text = typeof answer.text === 'string' ? answer.text.trim() : ''
    const pieces = labels.length === 0 ? [] : [labels.join('、')]
    if (text !== '') pieces.push(text)
    if (pieces.length > 0) parts.push(`第${index + 1}题：${pieces.join('、')}`)
  })
  return parts.join('；')
}

/**
 * The right-hand user reply persisted when a request is resolved. The browser
 * shows exactly this text; the answers summary and the optional comment are
 * folded into it and the whole reply is bounded to
 * {@link RESOLUTION_MESSAGE_MAX_CHARS}. The full comment and every answer stay
 * in {@link RequestRecordV1.resolution}, so nothing important survives only as
 * this truncated display string.
 */
export function resolutionMessage(
  status: RequestStatus,
  comment?: string,
  answersSummary?: string,
): string {
  if (!isTerminalStatus(status)) {
    throw new RequestSchemaError('a pending request has no resolution message', [`status: ${status}`])
  }
  const headline = RESOLUTION_HEADLINE[status]
  const extras: string[] = []
  const summary = typeof answersSummary === 'string' ? answersSummary.trim() : ''
  if (summary !== '') extras.push(`答案：${summary}`)
  const extra = typeof comment === 'string' ? comment.trim() : ''
  if (extra !== '') extras.push(extra)
  return truncateSummary(extras.length === 0 ? headline : `${headline}${extras.join('；')}`, RESOLUTION_MESSAGE_MAX_CHARS)
}

/**
 * The full wake-up prompt of one terminal request: every question with its
 * selected option labels and free text, then the complete comment. A record
 * without a `resolution` block falls back to its stored reply, and a record
 * without either still yields the status headline.
 */
export function resolutionPrompt(record: RequestRecordV1): string {
  const resolution = record.resolution
  if (resolution === undefined) {
    return record.resolutionMessage ?? resolutionMessage(record.status)
  }
  const lines = [`主题「${record.title}」${RESOLUTION_HEADLINE[record.status]}`]
  if (record.kind === 'question' && resolution.answers !== undefined) {
    const payload = record.payload as QuestionPayload
    const byQuestion = new Map(resolution.answers.map((answer) => [answer.questionId, answer]))
    payload.questions.forEach((question, index) => {
      const answer = byQuestion.get(question.id)
      if (answer === undefined) return
      const labels = (answer.selected ?? []).map(
        (id) => question.options?.find((option) => option.id === id)?.label ?? id,
      )
      const text = typeof answer.text === 'string' ? answer.text.trim() : ''
      lines.push(`第${index + 1}题：${question.prompt}`)
      lines.push(`答：${[...labels, ...(text === '' ? [] : [text])].join('、')}`)
    })
  }
  if (resolution.comment !== undefined) lines.push(`备注：${resolution.comment}`)
  return clipCodePoints(lines.join('\n'), RESOLUTION_PROMPT_MAX_CHARS)
}

/** The durable resolution block of one terminal write, or undefined when empty. */
function persistedResolution(
  comment: string | undefined,
  answers: readonly InboxAnswerInput[] | undefined,
): RequestResolution | undefined {
  const trimmed = typeof comment === 'string' ? comment.trim() : ''
  const hasAnswers = answers !== undefined && answers.length > 0
  if (trimmed === '' && !hasAnswers) return undefined
  const resolution: { comment?: string; answers?: readonly InboxAnswerInput[] } = {}
  if (trimmed !== '') resolution.comment = trimmed
  if (hasAnswers) resolution.answers = answers
  return resolution
}

/** Trimmed comment as the record persists it, or null when absent/blank. */
export function normalizeComment(comment: unknown): string | null | 'invalid' {
  if (comment === undefined || comment === null) return null
  if (typeof comment !== 'string') return 'invalid'
  if (Array.from(comment).length > REQUEST_COMMENT_MAX_CHARS) return 'invalid'
  const trimmed = comment.trim()
  return trimmed === '' ? null : trimmed
}

/** One request record to persist. */
export interface NewRequestInput {
  readonly requestId: string
  readonly projectId: string
  readonly topicId: string
  readonly kind: RequestKind
  readonly title: string
  readonly summary?: string
  readonly payload: RequestPayload
  readonly now: Date
}

/**
 * Build one pending record from validated input, including both persisted
 * messages. Throws {@link RequestSchemaError} when the input does not satisfy
 * the schema, so a caller can never persist a half-valid request.
 */
export function buildRequestRecord(input: NewRequestInput): RequestRecordV1 {
  const stamp = input.now.toISOString()
  const summary = truncateSummary(
    input.summary === undefined || input.summary.trim() === ''
      ? defaultSummary(input.kind, input.payload)
      : input.summary,
    REQUEST_SUMMARY_MAX_CHARS,
  )
  const record: RequestRecordV1 = {
    version: REQUEST_RECORD_VERSION,
    requestId: input.requestId,
    projectId: input.projectId,
    topicId: input.topicId,
    kind: input.kind,
    status: 'pending',
    title: truncateSummary(input.title, REQUEST_TITLE_MAX_CHARS),
    summary,
    requestMessage: requestMessage(input.kind, input.title, input.payload),
    resolutionMessage: null,
    payload: input.payload,
    createdAt: stamp,
    updatedAt: stamp,
    resolvedAt: null,
    resolvedBy: null,
    delivery: emptyDelivery(),
  }
  const problems = requestRecordProblems(record)
  if (problems.length > 0) throw new RequestSchemaError('request record is invalid', problems)
  return record
}

/** One terminal transition to persist. */
export interface ResolutionPatchInput {
  readonly status: RequestStatus
  readonly comment?: string
  /** The validated answers of a `question` submit; other kinds carry none. */
  readonly answers?: readonly InboxAnswerInput[]
  readonly resolvedBy: 'user' | 'master'
  readonly now: Date
}

/** Apply one terminal transition to a pending record; the caller validates status. */
export function applyResolution(record: RequestRecordV1, input: ResolutionPatchInput): RequestRecordV1 {
  if (isTerminalStatus(record.status)) {
    throw new RequestSchemaError('only a pending request can be resolved', [`status: ${record.status}`])
  }
  const answersSummary = record.kind === 'question' && input.answers !== undefined
    ? answerSummaryOf(record.payload as QuestionPayload, input.answers)
    : undefined
  const resolution = persistedResolution(input.comment, input.answers)
  const next: RequestRecordV1 = {
    ...record,
    status: input.status,
    resolutionMessage: resolutionMessage(input.status, input.comment, answersSummary),
    ...(resolution === undefined ? {} : { resolution }),
    resolvedAt: input.now.toISOString(),
    resolvedBy: input.resolvedBy,
    updatedAt: input.now.toISOString(),
  }
  const problems = requestRecordProblems(next)
  if (problems.length > 0) throw new RequestSchemaError('resolved request record is invalid', problems)
  return next
}

/** The action that produced one stored status, or null when it has none. */
export function actionOfStatus(status: RequestStatus): keyof typeof REQUEST_ACTION_STATUS | null {
  return actionForStatus(status)
}

/** Whether one action is offered by one kind (kind only, not status). */
export function kindOffersAction(kind: RequestKind, action: unknown): boolean {
  return isRequestAction(action) && actionAllowed(kind, action)
}

/** Every action a kind offers, in card order. */
export function actionsOfKind(kind: RequestKind): readonly string[] {
  return REQUEST_ACTIONS_BY_KIND[kind]
}

/** Trimmed option rows for a question payload, ids minted as o1..on. */
export function normalizeOptions(options: readonly unknown[] | undefined): QuestionOption[] {
  if (!Array.isArray(options)) return []
  return options.map((option, index) => {
    const row = isRecord(option) ? option : {}
    const description = typeof row.description === 'string' ? row.description.trim() : ''
    const normalized: {
      id: string
      label: string
      description?: string
      recommended?: boolean
    } = {
      id: `o${index + 1}`,
      label: typeof row.label === 'string' ? row.label.trim() : '',
    }
    if (description !== '') normalized.description = description
    if (row.recommended === true) normalized.recommended = true
    return normalized
  })
}

/** One question row with ids minted as q1..qn / o1..on. */
export function normalizeQuestion(question: unknown, index: number): QuestionSpec {
  const row = isRecord(question) ? question : {}
  const options = normalizeOptions(row.options as readonly unknown[] | undefined)
  const spec: {
    id: string
    prompt: string
    mode: 'single' | 'multi'
    options?: readonly QuestionOption[]
    allowText?: boolean
  } = {
    id: `q${index + 1}`,
    prompt: typeof row.prompt === 'string' ? row.prompt.trim() : '',
    mode: row.mode === 'multi' ? 'multi' : 'single',
  }
  if (options.length > 0) spec.options = options
  if (row.allowText === true) spec.allowText = true
  return spec
}

/** A verification row as the record persists it. */
export function normalizeVerification(row: unknown): ReviewVerification {
  const record = isRecord(row) ? row : {}
  return {
    command: typeof record.command === 'string' ? record.command.trim() : '',
    exitCode: typeof record.exitCode === 'number' && Number.isInteger(record.exitCode) ? record.exitCode : Number.NaN,
    evidence: typeof record.evidence === 'string' ? record.evidence.trim() : '',
  }
}
