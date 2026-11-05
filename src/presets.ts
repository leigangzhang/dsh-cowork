/**
 * The two runtime presets this plugin owns: `cowork-master` and
 * `cowork-thread`.
 *
 * Each preset is an explicit list of plugin rows, because S0 proved an empty
 * `plugins` list mounts no tools at all (docs/M1_S0_RESULT.md §1): the rows are
 * the same ones the S0 thread-smoke preset used successfully, extended with the
 * job/ask-user/todo/present rows a thread needs. Registration is at runtime (no
 * profile patch), so the rows live here as data and the host registry is
 * injected through {@link PresetRegistryPort}.
 */

/** Preset id of the master session that routes and accepts work. */
export const MASTER_PRESET_ID = 'cowork-master'
/** Preset id of a thread session that does one subject and hands it back. */
export const THREAD_PRESET_ID = 'cowork-thread'

/** The master routes intents to threads, records decisions, and accepts handoffs. */
export const MASTER_PERSONA = [
  'You are the cowork master for this repository.',
  'Your job is routing, decisions, and acceptance: use cowork_project_init once, then cowork_route for each user intent, and cowork_thread_list / cowork_project_status to see what the threads did.',
  'You do not implement the work yourself and you do not edit implementation files; the thread sessions own the code.',
  'When a thread hands off, read its summary and verification, then accept it or send the thread one more concrete instruction.',
  'Answer in the language the user writes in. Be brief and state which thread you routed to and why.',
].join(' ')

/** A thread works only inside its own subject and must hand off before it stops. */
export const THREAD_PERSONA = [
  'You are one cowork thread in this repository.',
  'You work only on the subject you were opened with, and you never modify files that belong to another thread.',
  'Start by reading the project index and the latest handoff with cowork_project_status so you know what already happened.',
  'When the work is finished or blocked you must call cowork_handoff with status, summary, and the verification you actually ran; a thread that stops without a handoff has not finished.',
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
 * The explicit row list, in the order S0 proved works. The persona row is the
 * only per-preset difference; everything else gives the session its file, shell,
 * job, prompt, todo, and presentation tools.
 */
function presetRows(persona: string): PresetRow[] {
  return [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: persona } },
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

/** Both preset definitions, master first. Fresh row arrays on every call. */
export function presetDefinitions(): readonly PresetDefinition[] {
  return [
    {
      id: MASTER_PRESET_ID,
      name: 'cowork master',
      description: 'Routes user intents to threads, records decisions, and accepts thread handoffs.',
      plugins: presetRows(MASTER_PERSONA),
    },
    {
      id: THREAD_PRESET_ID,
      name: 'cowork thread',
      description: 'Works one subject with file/shell tools and hands the result back to the master.',
      plugins: presetRows(THREAD_PERSONA),
    },
  ]
}

/**
 * Register both presets and return their disposers. If the second registration
 * fails the first is disposed before the error propagates, so a failed startup
 * never leaves half a preset pair behind.
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
