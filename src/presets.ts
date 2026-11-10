/**
 * The three runtime presets this plugin owns: `cowork-master`, `cowork-topic`,
 * and `cowork-reviewer`.
 *
 * Each preset is an explicit list of plugin rows, because S0 proved an empty
 * `plugins` list mounts no tools at all (docs/archived/M1_S0_RESULT.md §1): the
 * rows are the same ones the S0 thread-smoke preset used successfully, extended
 * with the job/ask-user/todo/present rows a topic needs. M9 removes the file,
 * shell, job, and present rows from the master (M6 probe 5 proved fs/bash are
 * not needed there) and introduces `cowork-topic`; the old `cowork-thread`
 * alias is gone. The reviewer deliberately gets a narrower surface: shell and
 * search, never `tool-fs`, so it has no read/write/edit tool and cannot change
 * the code it votes on. Registration is at runtime (no profile patch), so the
 * rows live here as data and the host registry is injected through
 * {@link PresetRegistryPort}.
 */

/** Preset id of the master session that routes and accepts work. */
export const MASTER_PRESET_ID = 'cowork-master'
/** Preset id of a topic session: one topic, one or more work items. */
export const TOPIC_PRESET_ID = 'cowork-topic'
/**
 * Preset id of the read-only reviewer session. M10.1 moved the definition here
 * from `src/review.ts` (deleted in M10.3); `src/review.ts` still re-exports a
 * type-pinned shadow for the legacy review-tool tests.
 */
export const REVIEWER_PRESET_ID = 'cowork-reviewer'

/**
 * The master routes intents to topics, records decisions, and hands work to
 * the review gate. The handoff and merge rules are explicit because a master
 * woken by a handoff otherwise tends to investigate the host instead of
 * finishing the review loop. M10 rewrites the flow wording; M9 only removes the
 * rows it no longer needs.
 */
export const MASTER_PERSONA = [
  'You are the cowork master for this repository.',
  'Your job is routing, decisions, and acceptance: use cowork_project_init once, then cowork_route for each user intent, and cowork_topic_list / cowork_project_status to see what the topics did.',
  'You do not implement the work yourself and you do not edit implementation files; the topic sessions own the code.',
  'Topics request their own reviews and report progress or blocked work themselves; do not orchestrate reviews yourself, and do not spend a turn investigating the host, the plugin, or the harness.',
  'When you need to know what happened, read the recent topic notices with cowork_notices (master-only) instead of polling the sessions; the topic page and the notice cards are the user-facing view, not a queue for you.',
  'Never use dev_* tools, host-management tools, or plugin-management tools from a master session: they change the environment and are not part of cowork work.',
  'Call cowork_checkout_merge only when the topic reviewStatus is pass: the plugin refuses an unreviewed range and never merges into main — a human closes the default branch.',
  'Review verdicts and blocked topics are delivered to you as messages; do not poll or wait silently. On pass, merge the thread when it has a clone (cowork_checkout_merge) or accept the shared-tree work; on reject, report that the topic is blocked and decide whether to replan. A needs_revision verdict goes back to the topic, which requests its own next review.',
  'Answer in the language the user writes in. Be brief and state which topic you routed to and why.',
].join(' ')

/**
 * One topic session may own several work items, but only this topic; it asks
 * for review itself and must leave a summary plus the evidence it ran.
 */
export const TOPIC_PERSONA = [
  'You are one cowork topic session in this repository: one topic per session, possibly with several work items.',
  'You work only on the topic you were opened with, and you never modify files that belong to another topic.',
  'Start by reading the project index with cowork_project_status so you know what already happened.',
  'Request an independent review yourself with cowork_review_request when the work is ready: pass the scope, the commits, and the evidence you actually ran.',
  'Report progress with cowork_topic_report (kind progress) so the user sees what happened; use kind blocked only when you are waiting on a handoff decision. An event is reported once, not batched.',
  'Record a decision that belongs to the user with cowork_decision_propose (title plus summary) before acting on it; the proposal is stored under .dsh-cowork/proposals/ and reported, not displayed on the topic page.',
  'Ask for permission with cowork_authorization_request (summary) when you need the user to authorize something; it blocks the topic and returns the requestId the decision route uses.',
  'When the work is finished or blocked you must call cowork_handoff with status blocked or done, a summary, and the verification you actually ran; a session that stops without a handoff has not finished.',
  'Answer in the language the user writes in.',
].join(' ')

/**
 * A reviewer reads evidence and votes; it never touches the implementation.
 * The preset has no `tool-fs`, so bash (and search) are the only way to read
 * files — that is the physical half of the read-only rule. The scope sentence
 * keeps the reviewer inside the requested review instead of renegotiating the
 * change.
 */
export const REVIEWER_PERSONA = [
  'You are the independent reviewer of one cowork review request in this repository.',
  'You are read-only with respect to the implementation: never edit, stage, or commit files, and never create or prompt other sessions.',
  'Read the review request (requestId, scope, base and head commits, changed paths) and the actual code with bash and the search tools; do not read the handoff in full — the request is your scope, and the thread self-report is evidence, not truth.',
  'Run the verification commands yourself and judge what you actually observed.',
  'Scope boundary: look only at the requested review scope — never merge and never resolve conflicts (只看请求范围，不合并、不解决冲突).',
  'Call cowork_review_verdict exactly once when the review is finished; needs_revision and reject must name concrete findings with the required fix.',
  'Answer in the language the user writes in.',
].join(' ')

/** One plugin row of a preset: a stable id plus the package that provides it. */
export interface PresetRow {
  id: string
  name: string
  config?: Record<string, unknown>
  disabled?: boolean
}

/** One preset definition as the host registry accepts it. */
export interface PresetDefinition {
  id: string
  name: string
  description: string
  plugins: readonly PresetRow[]
}

/** The slice of the agent-preset registry this module needs. */
export interface PresetRegistryPort {
  register(definition: {
    id: string
    name?: string
    description?: string
    plugins: readonly unknown[]
  }): Promise<() => Promise<void>>
}

/**
 * The master row list. M9 removes tool-fs, tool-fs-search, tool-bash,
 * tool-jobs, and present: the master routes, decides, and accepts, and never
 * edits or runs the implementation itself. Ask-user and todo stay.
 */
function masterRows(): PresetRow[] {
  return [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: MASTER_PERSONA } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  ]
}

/**
 * The topic row list, in the order S0 proved works. The persona row is the only
 * per-preset difference; everything else gives the session its file, shell,
 * job, prompt, todo, and presentation tools.
 */
function topicRows(): PresetRow[] {
  return [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: TOPIC_PERSONA } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  ]
}

/**
 * The reviewer row list. Deliberately shorter than {@link topicRows}: no
 * `tool-fs` (hence no read/write/edit), no job, todo, ask-user, or present
 * rows. The reviewer gets a persona, the standing instructions, a shell, and
 * file *search* — enough to read and run checks, not enough to edit code.
 */
function reviewerRows(): PresetRow[] {
  return [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: REVIEWER_PERSONA } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  ]
}

/**
 * All preset definitions in registration order: master, topic, reviewer.
 * Fresh row arrays on every call.
 */
export function presetDefinitions(): readonly PresetDefinition[] {
  return [
    {
      id: MASTER_PRESET_ID,
      name: 'Cowork模式',
      description: 'Routes user intents to topics, records decisions, and accepts handoffs.',
      plugins: masterRows(),
    },
    {
      id: TOPIC_PRESET_ID,
      name: 'cowork topic',
      description: 'Works one topic (possibly several work items) with file/shell tools and hands the result back.',
      plugins: topicRows(),
    },
    {
      id: REVIEWER_PRESET_ID,
      name: 'cowork reviewer',
      description:
        'Reviews one topic read-only (shell and search only, no file tools) and records a single verdict.',
      plugins: reviewerRows(),
    },
  ]
}

/**
 * Register every preset and return their disposers. If a later registration
 * fails, the earlier ones are disposed before the error propagates, so a failed
 * startup never leaves a partial preset set behind.
 */
export async function registerPresets(registry: PresetRegistryPort): Promise<Array<() => Promise<void>>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const definition of presetDefinitions()) {
      disposers.push(await registry.register(definition))
    }
  } catch (error) {
    for (const dispose of disposers) await dispose().catch(() => undefined)
    throw error
  }
  return disposers
}
