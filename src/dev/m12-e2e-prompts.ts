/**
 * M12 real-host E2E prompts: the deterministic instruction text the chain sends
 * to the master, topic and reviewer sessions. Every argument object is
 * serialised verbatim, so this text is part of the run contract.
 */
import {
  HANDOFF_TOOL,
  M12_E2E_DONE,
  M12_E2E_HANDOFF_SUMMARY,
  M12_E2E_REVIEW_SUMMARY,
  M12_E2E_TOPIC_INTENT,
  M12_E2E_WAIT_BRIEF,
  MERGE_TOOL,
  PROJECT_INIT_TOOL,
  REVIEW_REQUEST_TOOL,
  REVIEW_VERDICT_TOOL,
  ROUTE_TOOL,
  WORK_ITEM_TOOL,
} from './m12-e2e-contract.js'

export function buildProjectInitPrompt(): string {
  return `Call ${PROJECT_INIT_TOOL} exactly once with no arguments. ${M12_E2E_DONE}`
}

export function buildRoutePrompt(): string {
  return [
    `Call ${ROUTE_TOOL} exactly once with these arguments (JSON):`,
    JSON.stringify({ intent: M12_E2E_TOPIC_INTENT, brief: M12_E2E_WAIT_BRIEF }, null, 2),
    M12_E2E_DONE,
  ].join('\n\n')
}

export function buildResolvedRoutePrompt(resolvedTopicId: string): string {
  return [
    `Call ${ROUTE_TOOL} exactly once with these arguments (JSON):`,
    JSON.stringify({ intent: `${M12_E2E_TOPIC_INTENT} follow-up`, brief: M12_E2E_WAIT_BRIEF, topicId: resolvedTopicId }, null, 2),
    `The topic is resolved; follow the tool result exactly and do not message it. ${M12_E2E_DONE}`,
  ].join('\n\n')
}

export function buildWorkItemPrompt(): string {
  return `Call ${WORK_ITEM_TOOL} exactly once with no arguments: it clones this repository for the topic. Do not edit files yet. ${M12_E2E_DONE}`
}

export function buildCommitPrompt(input: { checkoutPath: string; fileName: string; content: string; message: string }): string {
  return [
    'Use the bash tool to run exactly this one command and keep its real exit code:',
    `cd ${input.checkoutPath} && printf '${input.content}\\n' > ${input.fileName} && git add ${input.fileName} && git commit -m "${input.message}"`,
    `Change nothing else. ${M12_E2E_DONE}`,
  ].join('\n\n')
}

export interface ReviewRequestPromptInput {
  readonly workItemId: string
  readonly checkoutPath: string
  readonly baseCommit: string
  readonly headCommit: string
  readonly fileName: string
  readonly purpose: string
}

export function buildReviewRequestPrompt(input: ReviewRequestPromptInput): string {
  const args = {
    purpose: input.purpose,
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
    path: input.checkoutPath,
    workItemId: input.workItemId,
    verification: [{ command: `test -f ${input.fileName}`, exitCode: 0, evidence: `${input.fileName} exists in the reviewed clone` }],
    changedPaths: [input.fileName],
  }
  return [
    `Call ${REVIEW_REQUEST_TOOL} exactly once with these arguments (JSON):`,
    JSON.stringify(args, null, 2),
    `Do not change the arguments and do not commit anything else. ${M12_E2E_DONE}`,
  ].join('\n\n')
}

export interface ReviewerVerdictPromptInput {
  readonly requestId: string
  readonly workItemId: string
  readonly checkoutPath: string
  readonly branch: string
  readonly fileName: string
}

export function buildReviewerVerdictPrompt(input: ReviewerVerdictPromptInput): string {
  const args = {
    requestId: input.requestId,
    verdict: 'pass',
    summary: M12_E2E_REVIEW_SUMMARY,
    findings: [],
    verification: [{ command: `test -f ${input.fileName}`, exitCode: 0, evidence: '<copy what you observed here>' }],
  }
  return [
    'This is the M12 E2E review request. Act as the independent reviewer; never modify an implementation file.',
    `The reviewed work item ${input.workItemId} is the isolated clone ${input.checkoutPath} on branch ${input.branch}; read it with bash.`,
    `First run the recorded verification yourself: cd ${input.checkoutPath} && test -f ${input.fileName}. Keep its real exit code.`,
    'Before calling the verdict tool, follow this instruction; if you already planned a different verdict, replace it with the one below.',
    `Call ${REVIEW_VERDICT_TOOL} exactly once with these arguments (replace only the placeholder evidence with what you observed):`,
    JSON.stringify(args, null, 2),
    `Use verdict "pass" only if the file exists and the change matches the request. ${M12_E2E_DONE}`,
  ].join('\n\n')
}

export interface HandoffPromptInput {
  readonly fileName: string
}

export function buildHandoffPrompt(input: HandoffPromptInput): string {
  const args = {
    status: 'done',
    summary: M12_E2E_HANDOFF_SUMMARY,
    verification: [{ command: `test -f ${input.fileName}`, exitCode: 0, evidence: `${input.fileName} exists in the work item clone` }],
    changedPaths: [input.fileName],
  }
  return [
    `Call ${HANDOFF_TOOL} exactly once with these arguments (JSON):`,
    JSON.stringify(args, null, 2),
    M12_E2E_DONE,
  ].join('\n\n')
}

export function buildMergePrompt(workItemId: string): string {
  return [
    `Call ${MERGE_TOOL} exactly once with these arguments (JSON):`,
    JSON.stringify({ workItemId }, null, 2),
    `Do not touch main. ${M12_E2E_DONE}`,
  ].join('\n\n')
}
