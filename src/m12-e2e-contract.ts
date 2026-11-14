/**
 * M12 real-host E2E contract: the frozen project path, threshold, tool-name and
 * step-id vocabularies, and every evidence, host-port and plan type the driver
 * and its support modules share. Values only: no I/O and no host import.
 */
export type { ActivityEvent, InboxItem, ProjectIndexV2, TopicRecordV2, WorkItemRecordV2 } from './store/schema.js'
export { MASTER_PRESET_ID, REVIEWER_PRESET_ID, TOPIC_PRESET_ID } from './platform/presets.js'

export const M12_E2E_EVIDENCE_RELATIVE = '.dsh-cowork/e2e/M12_E2E.json'

export const M12_E2E_RUN_PATH = '/dsh-cowork/e2e/m12/run'

export const M12_E2E_STATUS_PATH = '/dsh-cowork/e2e/m12/status'

export const M12_E2E_STEP_TIMEOUT_MS = 180_000

export const M12_E2E_POLL_MS = 500

export const M12_E2E_SHORT_IDLE_MS = 500

export const M12_E2E_SHORT_RESOLVE_MS = 1_000

export const M12_E2E_FIXTURE_PREFIX = 'dsh-cowork-m12-'

export const M12_E2E_WORK_FILE = 'm12-e2e.txt'

export const M12_E2E_WORK_CONTENT = 'M12-E2E-WORK'

export const M12_E2E_TOPIC_INTENT = 'M12 E2E billing retry backoff'

export const M12_E2E_WAIT_BRIEF = 'M12 E2E control: do not start any work and do not create or edit files yet; reply DONE.'

export const M12_E2E_REVIEW_SUMMARY = 'M12 E2E review: the isolated work item adds m12-e2e.txt and the recorded verification passed.'

export const M12_E2E_HANDOFF_SUMMARY = 'M12 E2E topic: the isolated work item added m12-e2e.txt, the work item commit was reviewed, and the merge is the master decision.'

export const M12_E2E_DONE = 'Reply DONE.'

export const MAX_EVENTS = 4_000
export const MAX_ASSISTANT_TEXT = 1_000
export const MAX_GIT_TEXT = 2_000
export const MAX_FIELD_TEXT = 3_000
export const GIT_TIMEOUT_MS = 30_000
export const GIT_MAX_BUFFER = 8 * 1024 * 1024

export const PROJECT_INIT_TOOL = 'cowork_project_init'
export const ROUTE_TOOL = 'cowork_route'
export const WORK_ITEM_TOOL = 'cowork_work_item_create'
export const REVIEW_REQUEST_TOOL = 'cowork_review_request'
export const REVIEW_VERDICT_TOOL = 'cowork_review_verdict'
export const HANDOFF_TOOL = 'cowork_handoff'
export const MERGE_TOOL = 'cowork_checkout_merge'


export const M12_EXPECTED_ACTIVITY_TYPES = [
  'topic-created',
  'route-created',
  'work-item-created',
  'review-requested',
  'review-verdict',
  'work-item-merged',
  'status-changed',
  'topic-archived',
  'topic-reopened',
] as const

export const M12_STEP_IDS = [
  'setup',
  'route-topic',
  'session-list',
  'overview',
  'work-item',
  'work-item-commit',
  'review-request',
  'review-verdict',
  'master-merge-decision',
  'handoff-done',
  'merge',
  'archive',
  'no-undo',
  'resolved-no-receive',
  'reopen',
  'activity',
  'cleanup',
] as const

export type M12RunState = 'running' | 'done' | 'failed'

export type M12StepStatus = 'pending' | 'running' | 'passed' | 'failed'

export type PromptMode = 'queue' | 'steer'

export type M12SessionRole = 'master' | 'topic' | 'reviewer'

export interface SessionEvent {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
}

export interface M12SessionRow {
  readonly sessionId: string
  readonly cwd?: string
  readonly running: boolean
}

export interface M12Assertion {
  readonly name: string
  readonly ok: boolean
  readonly evidence: string
}

export interface M12ToolCallEvidence {
  readonly name: string
  readonly callId: string
  readonly arguments: string
  resultText: string | null
  isError: boolean | null
}

export interface M12PromptEvidence {
  readonly sessionId: string
  readonly role: M12SessionRole
  readonly content: string
  readonly mode: PromptMode
  accepted: boolean
  readonly fromSeq: number
  assistantText: string
  toolCalls: M12ToolCallEvidence[]
}

export interface M12StepEvidence {
  startedAt: string | null
  endedAt: string | null
  prompts: M12PromptEvidence[]
  observations: Record<string, unknown>
  assertions: M12Assertion[]
  note?: string
  error?: string
}

export interface M12StepView {
  readonly id: string
  readonly status: M12StepStatus
  readonly evidence: M12StepEvidence
}

export interface M12RunStatusView {
  readonly runId: string
  readonly state: M12RunState
  readonly startedAt: string
  readonly endedAt?: string
  readonly steps: readonly M12StepView[]
  readonly evidenceFile: string
  readonly error?: string
}

export interface M12ArtifactIdentity {
  readonly repoPath: string
  readonly pluginVersion: string
  
  readonly head: string | null
  
  readonly baseRef: string
  
  readonly baseCommit: string | null
  
  readonly diffSha256: string | null
  
  readonly diffCommand: string
  
  readonly statusPorcelain: string | null
  
  readonly gitAvailable: boolean
  readonly error?: string
  
  readonly emptyRange: boolean
}

export interface M12ArchivedSession {
  readonly role: string
  readonly sessionId: string
  readonly archived: boolean
  readonly error: string | null
}

export interface M12CleanupReport {
  readonly sessions: readonly M12ArchivedSession[]
  readonly archivedSessionIds: readonly string[]
  readonly archiveErrors: readonly string[]
  readonly workspaceId: string | null
  readonly workspaceDeleted: boolean
  readonly workspaceError: string | null
  readonly fixturePath: string
  readonly keepFixture: boolean
  readonly fixtureRemoved: boolean
  readonly errors: readonly string[]
}

export interface M12EvidenceDocument {
  readonly version: 1
  readonly runId: string
  readonly state: M12RunState
  readonly startedAt: string
  readonly endedAt: string | null
  readonly evidenceFile: string
  readonly host: {
    readonly plugin: string
    readonly pluginVersion: string
    readonly node: string
    readonly platform: string
    readonly arch: string
    readonly repoPath: string
  }
  readonly fixture: {
    readonly path: string | null
    readonly keep: boolean
  }
  readonly artifactIdentity: M12ArtifactIdentity | null
  readonly steps: readonly M12StepView[]
  readonly finalIndex: unknown
  readonly cleanup: M12CleanupReport | Record<string, unknown>
  readonly error?: string
}

export interface M12ReviewRequestView {
  readonly filePath: string
  readonly requestId: string
  readonly status: string
  readonly topicId: string
  readonly workItemId: string | null
  readonly baseCommit: string
  readonly headCommit: string
  readonly path: string
  readonly branch: string | null
  readonly changedPaths: readonly string[]
  readonly verificationCount: number
  readonly reviewerSessionId: string | null
  readonly requestedAt: string
  readonly reviewedAt: string | null
  readonly summary: string | null
  readonly findingCount: number
  readonly record: Record<string, unknown>
}

export interface M12OverviewTopic {
  readonly topicId: string
  readonly status: string
  readonly awaitingReview: boolean
  readonly reviewStatus: string | null
  readonly resolvedAt: string | null
  readonly resolvedBy: string | null
}

export interface M12PanelResult {
  readonly status: number
  readonly body: unknown
}

export interface M12PanelProbe {
  overview(input: { sessionId: string }): Promise<M12PanelResult>
  reopen(input: { sessionId: string; topicId: string }): Promise<M12PanelResult>
  /** Archive one topic through the shipped resolve route (the topic-page menu). */
  resolve(input: { sessionId: string; topicId: string }): Promise<M12PanelResult>
  /** Decide one pending authorization (topic page action). */
  authorizationResolve(input: {
    sessionId: string
    topicId: string
    requestId: string
    decision: 'allow' | 'deny'
  }): Promise<M12PanelResult>
}

export interface M12E2EHost {
  readonly sessionController: {
    create(request: {
      workspaceId?: string
      cwd?: string
      sessionId?: string
      agentPreset?: string
    }): Promise<{ sessionId: string; agentPreset?: string }>
    prompt(
      request: {
        requestId: string
        sessionId: string
        mode: PromptMode
        content: ReadonlyArray<{ type: 'text'; text: string }>
      },
      signal?: AbortSignal,
    ): Promise<{ accepted: boolean }>
    list(request?: unknown, signal?: AbortSignal): Promise<{ items: readonly M12SessionRow[] }>
    inspect(sessionId: string, signal?: AbortSignal): Promise<{ meta: { id: string; cwd?: string; agentPreset?: string } }>
  }
  readonly workspaceRegistry: {
    resolveByPath(path: string): Promise<{ id: string; path: string } | undefined>
    delete(id: string): Promise<boolean>
    archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
    
    readonly archivedSessionIds?: readonly string[]
  }
  on(
    name: 'session/event',
    listener: (session: { id: string }, event: SessionEvent) => void,
  ): () => void
}

export interface M12E2EConfig {
  
  readonly repoPath: string
  
  readonly fixturePath?: string
  
  readonly keepFixture?: boolean
  
  readonly artifactBaseRef?: string
  readonly promptTimeoutMs: number
  
  readonly idleAfterMs: number
  readonly resolveAfterMs: number
  readonly pluginName: string
  readonly pluginVersion: string
  readonly panel: M12PanelProbe
  readonly log?: (message: string) => void
}

export interface MutableStep {
  readonly id: string
  status: M12StepStatus
  readonly evidence: M12StepEvidence
}

export interface MutableRun {
  readonly runId: string
  state: M12RunState
  readonly startedAt: string
  endedAt?: string
  readonly steps: MutableStep[]
  error?: string
  finalIndex: unknown
  cleanup: M12CleanupReport | Record<string, unknown>
  artifactIdentity: M12ArtifactIdentity | null
}

export interface GitOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface DeliveryEvent {
  readonly type: string
  readonly seq: number
  readonly source: 'event' | 'assistant-text'
  readonly text: string
}
