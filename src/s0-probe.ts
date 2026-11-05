/**
 * Temporary M1 S0 probe: the three questions docs/M1_HANDOFF.md makes
 * mandatory before any M1 product code is written.
 *
 * 1. Can a preset with an empty `plugins` list complete one turn, and which
 *    tools can that session actually see?
 * 2. Can `standard`'s plugin rows be read at runtime (so a preset could be a
 *    clone), and in which shape does the registry expose them?
 * 3. Does the tool execution surface expose the calling session
 *    (`exec.agent`), and from which preset compositions is it populated?
 *
 * This module is evidence-only. It is registered behind loopback probe routes,
 * keeps its runs under `.dsh-cowork/probe/s0-*`, and M1's product modules do
 * not import it.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Preset registered by the plugin's apply() with an empty `plugins` list. */
export const EMPTY_PRESET_ID = 'cowork-probe'
/** Preset registered with explicit tool rows, to prove a thread preset can carry tools. */
export const THREAD_SMOKE_PRESET_ID = 'cowork-thread-s0'

/** One session event as the S0 probe consumes it. */
export interface S0Event {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: Record<string, unknown>
}

/** One tool call observed in a session event stream. */
export interface S0ToolCall {
  readonly seq: number
  readonly name: string
  readonly arguments: string
}

/** Folded view of one completed turn. */
export interface S0Turn {
  readonly turn: number | undefined
  readonly startSeq: number | undefined
  readonly endSeq: number | undefined
  readonly reason: string | undefined
  readonly text: string
  readonly toolCalls: readonly S0ToolCall[]
}

/** Identity reported by the temporary `cowork_identity_probe` tool. */
export interface S0Identity {
  readonly token: string
  readonly agentId: string | null
  readonly cwd: string | null
  readonly agentPreset: string | null
  readonly execKeys: readonly string[]
  readonly hasAgent: boolean
}

/** One workspace record as the probe consumes it. */
interface WorkspaceLike {
  readonly id: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** One session row as the probe consumes it. */
interface SessionRowLike {
  readonly sessionId: string
  readonly cwd?: string
  readonly running: boolean
  readonly blank: boolean
}

/** One session header as the probe consumes it. */
interface SessionHeaderLike {
  readonly id: string
  readonly cwd?: string
  readonly agentPreset?: string
}

/** One preset roster row as the probe consumes it. */
interface PresetRowLike {
  readonly id: string
  readonly broken?: unknown
  readonly [key: string]: unknown
}

/** The host services S0 needs. */
export interface S0Host {
  readonly sessionController: {
    create(request: { workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>
    list(request?: unknown, signal?: AbortSignal): Promise<{ items: readonly SessionRowLike[] }>
    prompt(
      request: {
        requestId: string
        sessionId: string
        mode: 'queue' | 'steer'
        content: ReadonlyArray<{ type: 'text'; text: string }>
      },
      signal?: AbortSignal,
    ): Promise<{ accepted: boolean }>
    inspect(sessionId: string, signal?: AbortSignal): Promise<{ meta: SessionHeaderLike }>
  }
  readonly workspaceRegistry: {
    get(id: string): WorkspaceLike | undefined
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  }
  readonly agentPresets: {
    list(): Promise<readonly PresetRowLike[]>
    resolve(id?: string): Promise<Record<string, unknown>>
    readDocument?(agentPreset: string): Promise<Record<string, unknown>>
    compositionInventory?(): Promise<readonly Record<string, unknown>[]>
  }
  on(name: 'session/event', listener: (session: { id: string }, event: S0Event) => void): () => void
}

/** S0 knobs carried by the plugin Config. */
export interface S0Config {
  readonly repoPath: string
  readonly promptTimeoutMs: number
}

/** Runtime phase status. */
export type S0PhaseStatus = 'pending' | 'running' | 'passed' | 'failed'

/** One phase view returned by the status route. */
export interface S0PhaseView {
  readonly id: string
  readonly status: S0PhaseStatus
  readonly startedAt?: number
  readonly endedAt?: number
  readonly evidence?: Record<string, unknown>
  readonly error?: string
}

/** One run view returned by the status route. */
export interface S0RunView {
  readonly runId: string
  readonly state: 'running' | 'done' | 'failed'
  readonly startedAt: number
  readonly endedAt?: number
  readonly phases: readonly S0PhaseView[]
  readonly sessionIds: readonly string[]
  readonly error?: string
}

/** The ordered phases of one S0 run. */
const PHASES = ['preset-surface', 'empty-turn', 'preset-compose', 'identity'] as const

const MAX_EVENTS_PER_SESSION = 500
const MAX_TEXT = 900
const MAX_ARGUMENTS = 400
const MAX_DOC_HEAD = 2400

interface MutablePhase {
  id: string
  status: S0PhaseStatus
  startedAt?: number
  endedAt?: number
  evidence?: Record<string, unknown>
  error?: string
}

interface MutableRun {
  runId: string
  state: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  phases: MutablePhase[]
  sessionIds: string[]
  error?: string
}

interface Waiter {
  readonly events: S0Event[]
  readonly timer: NodeJS.Timeout
  readonly resolve: (turn: S0Turn) => void
  readonly reject: (error: Error) => void
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contentText(message: unknown): string | undefined {
  const record = isRecord(message) ? message : undefined
  const content = record?.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    const block = isRecord(part) ? part : undefined
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/** Fold events newer than `fromSeq` into one turn summary. */
function summarize(events: readonly S0Event[], fromSeq: number): S0Turn {
  let turn: number | undefined
  let startSeq: number | undefined
  let endSeq: number | undefined
  let reason: string | undefined
  const texts: string[] = []
  const toolCalls: S0ToolCall[] = []
  for (const event of events) {
    if (event.seq <= fromSeq) continue
    if (event.type === 'turn/start') {
      if (typeof event.data.turn === 'number') turn = event.data.turn
      startSeq = event.seq
      texts.length = 0
      toolCalls.length = 0
    } else if (event.type === 'assistant/message') {
      const text = contentText(event.data.message)
      if (text !== undefined) texts.push(text)
    } else if (event.type === 'tool/call') {
      const name = typeof event.data.name === 'string' ? event.data.name : '(unnamed)'
      const args = typeof event.data.arguments === 'string' ? event.data.arguments : ''
      toolCalls.push({ seq: event.seq, name, arguments: clip(args, MAX_ARGUMENTS) })
    } else if (event.type === 'turn/end') {
      endSeq = event.seq
      const kind = isRecord(event.data.reason) ? event.data.reason.kind : undefined
      reason = typeof kind === 'string' ? kind : undefined
    }
  }
  return { turn, startSeq, endSeq, reason, text: clip(texts.join('\n'), MAX_TEXT), toolCalls }
}

/** One identity round's observable facts. */
interface IdentityRoundView {
  readonly label: string
  readonly sessionId: string
  readonly presetId: string
  readonly callSeen: boolean
  readonly toolCalls: readonly string[]
  readonly identity: S0Identity | null
  readonly text: string
  readonly reason: string | undefined
}

/** The temporary S0 runner: bounded phases, raw evidence, no product state. */
export class S0Runner {
  private readonly runs = new Map<string, MutableRun>()
  private readonly events = new Map<string, S0Event[]>()
  private readonly trackedSessions = new Set<string>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly identities = new Map<string, S0Identity>()
  private lastRunId: string | null = null
  private disposed = false

  constructor(
    private readonly host: S0Host,
    private readonly config: S0Config,
  ) {}

  /** Subscribe to the host's session event feed; returns the disposer. */
  attachEvents(): () => void {
    return this.host.on('session/event', (session, event) => {
      if (!this.trackedSessions.has(session.id)) return
      const list = this.events.get(session.id) ?? []
      list.push(event)
      if (list.length > MAX_EVENTS_PER_SESSION) list.splice(0, list.length - MAX_EVENTS_PER_SESSION)
      this.events.set(session.id, list)
      const waiter = this.waiters.get(session.id)
      if (waiter === undefined) return
      waiter.events.push(event)
      if (event.type !== 'turn/end') return
      clearTimeout(waiter.timer)
      this.waiters.delete(session.id)
      waiter.resolve(summarize(waiter.events, 0))
    })
  }

  /** Record one tool-executed identity; called by the temporary identity tool. */
  recordIdentity(identity: S0Identity): void {
    this.identities.set(identity.token, identity)
  }

  /** Start one S0 run and return its initial view. */
  start(): S0RunView {
    if (this.disposed) throw new Error('S0 probe runner is disposed')
    const active = this.lastRunId === null ? undefined : this.runs.get(this.lastRunId)
    if (active !== undefined && active.state === 'running') {
      throw new Error(`S0 run ${active.runId} is still running`)
    }
    const run: MutableRun = {
      runId: `s0-${randomUUID()}`,
      state: 'running',
      startedAt: Date.now(),
      phases: PHASES.map((id) => ({ id, status: 'pending' })),
      sessionIds: [],
    }
    this.runs.set(run.runId, run)
    this.lastRunId = run.runId
    void this.execute(run)
    return this.view(run)
  }

  /** Read one run view, or undefined when unknown. */
  status(runId: string): S0RunView | undefined {
    const run = this.runs.get(runId)
    return run === undefined ? undefined : this.view(run)
  }

  /** Read one run from memory or from disk after a host reload. */
  async resolve(runId: string): Promise<S0RunView | undefined> {
    const live = this.status(runId)
    if (live !== undefined) return live
    const base = join(this.config.repoPath, '.dsh-cowork', 'probe')
    const candidates = [join(base, 'last-s0-run.json')]
    if (/^s0-[0-9a-fA-F-]{8,64}$/.test(runId)) candidates.push(join(base, 's0-runs', `${runId}.json`))
    for (const file of candidates) {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as S0RunView
        if (parsed.runId === runId) return parsed
      } catch {
        // A missing or unreadable record is not an error for the status route.
      }
    }
    return undefined
  }

  /** Reject pending waits so dispose cannot hang a run. */
  dispose(): void {
    this.disposed = true
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('S0 probe disposed while waiting for a turn'))
    }
    this.waiters.clear()
  }

  private async execute(run: MutableRun): Promise<void> {
    try {
      for (const phase of run.phases) {
        if (this.disposed) throw new Error('S0 probe was disposed')
        phase.status = 'running'
        phase.startedAt = Date.now()
        try {
          phase.evidence = await this.runPhase(phase.id, run)
          phase.status = 'passed'
        } catch (error) {
          phase.status = 'failed'
          phase.error = messageOf(error)
          run.state = 'failed'
        } finally {
          phase.endedAt = Date.now()
        }
      }
    } catch (error) {
      run.state = 'failed'
      run.error = messageOf(error)
    } finally {
      if (run.state === 'running') run.state = 'done'
      run.endedAt = Date.now()
      await this.persistRun(run)
    }
  }

  private async runPhase(id: string, run: MutableRun): Promise<Record<string, unknown>> {
    switch (id) {
      case 'preset-surface': return this.phasePresetSurface()
      case 'empty-turn': return this.phaseEmptyTurn(run)
      case 'preset-compose': return this.phasePresetCompose(run)
      case 'identity': return this.phaseIdentity(run)
      default: throw new Error(`unknown S0 phase: ${id}`)
    }
  }

  /** Q2: what the preset registry exposes for `standard`, and in which shape. */
  private async phasePresetSurface(): Promise<Record<string, unknown>> {
    const presets = await this.host.agentPresets.list()
    const roster = presets.map((row) => ({
      id: row.id,
      broken: row.broken ?? null,
      keys: Object.keys(row).sort(),
      hasPluginsProperty: Array.isArray(row.plugins),
    }))
    const evidence: Record<string, unknown> = {
      roster,
      presetIds: roster.map((row) => row.id),
      registryOwnKeys: Object.keys(this.host.agentPresets as object).sort(),
    }

    let resolved: unknown
    try {
      resolved = await this.host.agentPresets.resolve('standard')
    } catch (error) {
      evidence.resolveError = messageOf(error)
    }
    if (resolved !== undefined) {
      evidence.resolveStandard = {
        keys: isRecord(resolved) ? Object.keys(resolved).sort() : [],
        hasPluginsArray: isRecord(resolved) && Array.isArray(resolved.plugins),
        json: clip(JSON.stringify(resolved), 600),
      }
    }

    if (this.host.agentPresets.readDocument === undefined) {
      evidence.readDocumentAvailable = false
    } else {
      evidence.readDocumentAvailable = true
      try {
        const document = await this.host.agentPresets.readDocument('standard')
        const content = typeof document.content === 'string' ? document.content : ''
        evidence.readDocumentStandard = {
          keys: Object.keys(document).sort(),
          agentPreset: document.agentPreset ?? null,
          contentBytes: content.length,
          contentHead: clip(content, MAX_DOC_HEAD),
          contentHasJsExpressions: content.includes('!!js'),
          contentRowsStartWithDash: /(^|\n)- /.test(content),
          node: typeof document.node === 'undefined' ? null : document.node,
        }
        // Probe one round-trip-free reading path: did the registry hand back a
        // structured array anywhere, or only YAML text?
        evidence.pluginsObtainable = {
          viaResolve: isRecord(resolved) && Array.isArray(resolved.plugins),
          viaReadDocumentStructured: Array.isArray(document.plugins),
          viaReadDocumentYamlText: typeof document.content === 'string' && document.content !== '',
        }
      } catch (error) {
        evidence.readDocumentStandard = { error: messageOf(error) }
        evidence.pluginsObtainable = {
          viaResolve: isRecord(resolved) && Array.isArray(resolved.plugins),
          viaReadDocumentStructured: false,
          viaReadDocumentYamlText: false,
          error: messageOf(error),
        }
      }
    }

    if (this.host.agentPresets.compositionInventory !== undefined) {
      try {
        const inventory = await this.host.agentPresets.compositionInventory()
        evidence.compositionInventory = inventory.map((row) => ({
          id: row.id ?? null,
          broken: row.broken ?? null,
          rows: Array.isArray(row.rows)
            ? row.rows.map((entry) => {
              const item = isRecord(entry) ? entry : {}
              return { entryId: item.entryId ?? null, moduleName: item.moduleName ?? null, enabled: item.enabled ?? null }
            })
            : null,
        }))
      } catch (error) {
        evidence.compositionInventory = { error: messageOf(error) }
      }
    } else {
      evidence.compositionInventory = { available: false }
    }
    return evidence
  }

  /** Q1(a): an empty `plugins` preset runs one turn; Q1(b): the tools it can see. */
  private async phaseEmptyTurn(run: MutableRun): Promise<Record<string, unknown>> {
    const workspaceId = await this.requireWorkspaceId()
    const created = await this.host.sessionController.create({ workspaceId, agentPreset: EMPTY_PRESET_ID })
    this.track(run, created.sessionId)
    const header = await this.host.sessionController.inspect(created.sessionId)
    const round = await this.promptRound(
      created.sessionId,
      'Reply with exactly COWORK_PROBE_PRESET_OK on the first line. '
      + 'Then list the exact names of every tool available to you, one per line. '
      + 'If you have no tools at all, write NONE.',
    )
    const listRow = await this.findSessionRow(created.sessionId)
    const evidence: Record<string, unknown> = {
      sessionId: created.sessionId,
      workspaceId,
      createReturnedPreset: created.agentPreset ?? null,
      headerPreset: header.meta.agentPreset ?? null,
      headerCwd: header.meta.cwd ?? null,
      workspaceSessionIdsIncludes: this.host.workspaceRegistry.get(workspaceId)?.sessionIds.includes(created.sessionId) ?? null,
      listedAfterTurn: listRow !== undefined,
      round,
      answeredMarker: round.text.includes('COWORK_PROBE_PRESET_OK'),
      sawNoTools: /\bNONE\b/.test(round.text),
      toolsActuallyCalled: round.toolCalls.map((call) => call.name),
    }
    if (header.meta.agentPreset !== EMPTY_PRESET_ID) {
      throw new Error(`empty preset session header records ${String(header.meta.agentPreset)}`)
    }
    if (round.reason !== 'completed') throw new Error(`empty preset turn ended with reason ${String(round.reason)}`)
    return evidence
  }

  /** Explicit preset rows (persona + bash + fs + fs-search) can carry tools into a session. */
  private async phasePresetCompose(run: MutableRun): Promise<Record<string, unknown>> {
    const workspaceId = await this.requireWorkspaceId()
    const created = await this.host.sessionController.create({ workspaceId, agentPreset: THREAD_SMOKE_PRESET_ID })
    this.track(run, created.sessionId)
    const header = await this.host.sessionController.inspect(created.sessionId)
    const round = await this.promptRound(
      created.sessionId,
      'Use one of your tools to read the file package.json in the current working directory. '
      + 'Reply with a line containing exactly THREAD_TOOLS_OK and the value of its "name" field.',
    )
    const presetRow = (await this.host.agentPresets.list()).find((row) => row.id === THREAD_SMOKE_PRESET_ID)
    const evidence: Record<string, unknown> = {
      presetId: THREAD_SMOKE_PRESET_ID,
      presetBroken: presetRow?.broken ?? null,
      sessionId: created.sessionId,
      headerPreset: header.meta.agentPreset ?? null,
      headerCwd: header.meta.cwd ?? null,
      round,
      toolNamesCalled: round.toolCalls.map((call) => call.name),
      repliedWithMarker: round.text.includes('THREAD_TOOLS_OK'),
      repliedWithPackageName: round.text.includes('@dsh-external/dsh-cowork'),
    }
    if (round.reason !== 'completed') throw new Error(`preset-compose turn ended with reason ${String(round.reason)}`)
    if (round.toolCalls.length === 0) throw new Error('preset-compose session called no tool')
    if (!round.text.includes('@dsh-external/dsh-cowork')) {
      throw new Error(`preset-compose reply does not contain the package name: ${clip(round.text, 300)}`)
    }
    return evidence
  }

  /** Q3: `exec.agent` from a standard-preset session and from the empty preset. */
  private async phaseIdentity(run: MutableRun): Promise<Record<string, unknown>> {
    const workspaceId = await this.requireWorkspaceId()
    const workspace = this.host.workspaceRegistry.get(workspaceId)
    const master = await this.identityRound(run, workspaceId, 'standard', 'master', 'cowork-master-simulated-standard')
    const thread = await this.identityRound(run, workspaceId, EMPTY_PRESET_ID, 'thread', 'empty-preset')
    const evidence: Record<string, unknown> = {
      workspaceId,
      workspacePath: workspace?.path ?? null,
      standardPreset: master,
      emptyPreset: thread,
      identityCheck: {
        agentPresentForStandard: master.identity !== null,
        agentPresentForEmpty: thread.identity !== null,
        cwdMatchesWorkspaceForStandard: master.identity?.cwd === workspace?.path,
        cwdMatchesWorkspaceForEmpty: thread.identity?.cwd === workspace?.path,
      },
    }
    if (master.identity === null) {
      throw new Error('cowork_identity_probe was not called from the standard-preset session')
    }
    return evidence
  }

  private async identityRound(
    run: MutableRun,
    workspaceId: string,
    presetId: string,
    token: string,
    label: string,
  ): Promise<IdentityRoundView> {
    const created = await this.host.sessionController.create({ workspaceId, agentPreset: presetId })
    this.track(run, created.sessionId)
    const round = await this.promptRound(
      created.sessionId,
      `Call the tool cowork_identity_probe with token "${token}". `
      + 'Then reply with its exact JSON output. '
      + 'If the tool is not available to you, reply exactly TOOL_UNAVAILABLE.',
    )
    return {
      label,
      sessionId: created.sessionId,
      presetId,
      callSeen: round.toolCalls.some((call) => call.name === 'cowork_identity_probe'),
      toolCalls: round.toolCalls.map((call) => call.name),
      identity: this.identities.get(token) ?? null,
      text: round.text,
      reason: round.reason,
    }
  }

  private async requireWorkspaceId(): Promise<string> {
    const workspace = await this.host.workspaceRegistry.resolveByPath(this.config.repoPath)
    if (workspace === undefined) throw new Error(`no DSH workspace is registered for ${this.config.repoPath}`)
    return workspace.id
  }

  private async findSessionRow(sessionId: string): Promise<SessionRowLike | undefined> {
    const { items } = await this.host.sessionController.list({})
    return items.find((item) => item.sessionId === sessionId)
  }

  private track(run: MutableRun, sessionId: string): void {
    run.sessionIds.push(sessionId)
    this.trackedSessions.add(sessionId)
    this.events.set(sessionId, [])
  }

  private waitForTurn(sessionId: string): Promise<S0Turn> {
    return new Promise<S0Turn>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(sessionId)
        const seen = (this.events.get(sessionId) ?? []).slice(-6).map((event) => `${event.type}#${event.seq}`)
        reject(new Error(
          `timeout after ${this.config.promptTimeoutMs}ms waiting for turn/end on ${sessionId}; recent events: ${seen.join(', ') || '(none)'}`,
        ))
      }, this.config.promptTimeoutMs)
      this.waiters.set(sessionId, { events: [], timer, resolve, reject })
    })
  }

  private async promptRound(sessionId: string, text: string): Promise<S0Turn> {
    const fromSeq = (this.events.get(sessionId) ?? []).at(-1)?.seq ?? 0
    const wait = this.waitForTurn(sessionId)
    try {
      await this.host.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, AbortSignal.timeout(this.config.promptTimeoutMs))
    } catch (error) {
      const waiter = this.waiters.get(sessionId)
      if (waiter !== undefined) {
        clearTimeout(waiter.timer)
        this.waiters.delete(sessionId)
      }
      throw error
    }
    const folded = await wait
    // The waiter folds from its own event buffer; re-fold against the full
    // sequence so events that arrived before the wait are not double-counted.
    const all = summarize(this.events.get(sessionId) ?? [], fromSeq)
    return { ...folded, toolCalls: all.toolCalls.length > 0 ? all.toolCalls : folded.toolCalls }
  }

  private async persistRun(run: MutableRun): Promise<void> {
    const base = join(this.config.repoPath, '.dsh-cowork', 'probe')
    const body = `${JSON.stringify(this.view(run), null, 2)}\n`
    try {
      await mkdir(join(base, 's0-runs'), { recursive: true })
      await writeFile(join(base, 'last-s0-run.json'), body, 'utf8')
      await writeFile(join(base, 's0-runs', `${run.runId}.json`), body, 'utf8')
    } catch {
      // The persisted copy is evidence convenience; the in-memory run is authoritative.
    }
  }

  private view(run: MutableRun): S0RunView {
    return JSON.parse(JSON.stringify(run)) as S0RunView
  }
}
