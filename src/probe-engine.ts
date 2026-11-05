/**
 * The M0 probe runner: one run proves the five PLAN §3.2 risks against the
 * live host and keeps every phase's raw evidence. Runs are started by the
 * loopback route, report progress through the status route, and hold no
 * durable state beyond the probe store file.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ProbeEvent, StoreDocument, TurnSummary } from './probe-model.js'
import {
  buildStoreDocument,
  parseStoreDocument,
  summarizeEvents,
} from './probe-model.js'
import { listAtomicTempSiblings, readStoreText, writeStoreAtomic } from './probe-store.js'

const runFile = promisify(execFile)

/** Preset id the probe registers and asks the host to compose. */
export const PROBE_PRESET_ID = 'cowork-probe'
/** Marker the two wake turns must answer with. */
export const WAKE_MARKER = 'COWORK_PROBE_WAKE_OK'
/** Marker written into the probe worktree. */
export const WORKTREE_MARKER = 'COWORK_PROBE_WORKTREE_OK'
/** Probe worktree branch. */
const WORKTREE_BRANCH = 'cowork/probe-m0'

/** One session row as the probe consumes it. */
export interface SessionSummaryLike {
  readonly sessionId: string
  readonly cwd?: string
  readonly running: boolean
  readonly blank: boolean
}

/** One workspace record as the probe consumes it. */
export interface WorkspaceLike {
  readonly id: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** One session header as the probe consumes it. */
export interface SessionHeaderLike {
  readonly id: string
  readonly cwd?: string
  readonly agentPreset?: string
}

/** One preset roster row as the probe consumes it. */
export interface PresetRowLike {
  readonly id: string
  readonly broken?: unknown
}

/** The host services the probe calls. */
export interface ProbeHost {
  readonly sessionController: {
    create(request: { workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>
    list(request?: unknown, signal?: AbortSignal): Promise<{ items: readonly SessionSummaryLike[] }>
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
    list(): readonly WorkspaceLike[]
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  }
  readonly agentPresets: {
    list(): Promise<readonly PresetRowLike[]>
    register(definition: {
      id: string
      name?: string
      description?: string
      plugins: readonly unknown[]
    }): Promise<() => Promise<void>>
  }
  readonly webServer: { register(route: WebRoute): () => void }
  on(name: 'session/event', listener: (session: { id: string }, event: ProbeEvent) => void): () => void
}

/** Probe knobs carried by the plugin Config. */
export interface ProbeConfig {
  readonly repoPath: string
  readonly promptTimeoutMs: number
  readonly storeRelativePath: string
  readonly worktreeRelativePath: string
}

/** Runtime phase status. */
export type PhaseStatus = 'pending' | 'running' | 'passed' | 'failed'

/** One phase view returned by the status route. */
export interface PhaseView {
  readonly id: string
  readonly status: PhaseStatus
  readonly startedAt?: number
  readonly endedAt?: number
  readonly evidence?: Record<string, unknown>
  readonly error?: string
}

/** One run view returned by the status route. */
export interface RunView {
  readonly runId: string
  readonly state: 'running' | 'done' | 'failed'
  readonly startedAt: number
  readonly endedAt?: number
  readonly phases: readonly PhaseView[]
  readonly sessionIds: readonly string[]
  readonly error?: string
}

/** Health payload returned by the health route and the probe tool. */
export interface HealthView {
  readonly ok: true
  readonly plugin: string
  readonly preset: string | null
  readonly host: string
  readonly version: string
  readonly repoPath: string
  readonly workspaceId: string | null
  readonly lastRunId: string | null
  readonly buildTag: string
}

/** The ordered phases of one run. */
const PHASES = ['preset', 'wake', 'visibility', 'store', 'worktree', 'patchReload'] as const

interface MutablePhase {
  id: string
  status: PhaseStatus
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
  wakeSessionId?: string
  error?: string
}

interface Waiter {
  readonly events: ProbeEvent[]
  readonly timer: NodeJS.Timeout
  readonly resolve: (summary: TurnSummary) => void
  readonly reject: (error: Error) => void
}

/** One prompt round's observable facts. */
interface RoundView {
  readonly fromSeq: number
  readonly startSeq: number | undefined
  readonly endSeq: number | undefined
  readonly turn: number | undefined
  readonly reason: string | undefined
  readonly text: string
}

const BUILD_TAG = 'm0-2'

const MAX_EVENTS_PER_SESSION = 500
const MAX_TEXT = 500
const MAX_LIST = 1200
const MAX_RUNS = 20

function clip(text: string, limit = MAX_TEXT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Run one bounded phase and record its evidence. */
export class ProbeRunner {
  private readonly runs = new Map<string, MutableRun>()
  private readonly events = new Map<string, ProbeEvent[]>()
  private readonly trackedSessions = new Set<string>()
  private readonly waiters = new Map<string, Waiter>()
  private workspaceId: string | null = null
  private presetRegistered = false
  private lastRunId: string | null = null
  private disposed = false

  constructor(
    private readonly host: ProbeHost,
    private readonly config: ProbeConfig,
    private readonly pluginName: string,
    private readonly pluginVersion: string,
  ) {}

  /** Mark the runtime preset registration as complete (drives health). */
  markPresetRegistered(): void {
    this.presetRegistered = true
  }

  /** Subscribe to the host's session event feed; returns the disposer. */
  attachEvents(): () => void {
    return this.host.on('session/event', (session, event) => {
      this.observe(session.id, event)
    })
  }

  /** Start one run and return its initial view. */
  start(): RunView {
    if (this.disposed) throw new Error('probe runner is disposed')
    const active = this.lastRunId === null ? undefined : this.runs.get(this.lastRunId)
    if (active !== undefined && active.state === 'running') {
      throw new Error(`probe run ${active.runId} is still running`)
    }
    const run: MutableRun = {
      runId: `run-${randomUUID()}`,
      state: 'running',
      startedAt: Date.now(),
      phases: PHASES.map((id) => ({ id, status: 'pending' })),
      sessionIds: [],
    }
    this.runs.set(run.runId, run)
    this.lastRunId = run.runId
    this.trimRuns()
    void this.execute(run)
    return this.view(run)
  }

  /** Read one run view, or undefined when unknown. */
  status(runId: string): RunView | undefined {
    const run = this.runs.get(runId)
    return run === undefined ? undefined : this.view(run)
  }

  /**
   * Resolve a run by id, falling back to the last run persisted on disk. A
   * host rebuild reloads this module and empties the in-memory table, so the
   * status route must still answer for the last cited run id.
   */
  async resolve(runId: string): Promise<RunView | undefined> {
    const live = this.status(runId)
    if (live !== undefined) return live
    const base = join(this.config.repoPath, '.dsh-cowork', 'probe')
    const candidates = [join(base, 'last-run.json')]
    // The run id becomes a file name: accept only the ids this runner mints.
    if (/^run-[0-9a-fA-F-]{8,64}$/.test(runId)) candidates.push(join(base, 'runs', `${runId}.json`))
    for (const file of candidates) {
      try {
        const persisted = JSON.parse(await readFile(file, 'utf8')) as RunView
        if (persisted.runId === runId) return persisted
      } catch {
        // A missing or unreadable record is not an error for the status route.
      }
    }
    return undefined
  }

  /** Read the last run view. */
  lastRun(): RunView | undefined {
    return this.lastRunId === null ? undefined : this.status(this.lastRunId)
  }

  /** Read the health payload. */
  health(): HealthView {
    return {
      ok: true,
      plugin: this.pluginName,
      preset: this.presetRegistered ? PROBE_PRESET_ID : null,
      host: hostname(),
      version: this.pluginVersion,
      repoPath: this.config.repoPath,
      workspaceId: this.workspaceId,
      lastRunId: this.lastRunId,
      buildTag: BUILD_TAG,
    }
  }

  /** Reject pending waits so a disposed plugin cannot hang a run forever. */
  dispose(): void {
    this.disposed = true
    for (const [sessionId, waiter] of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`probe disposed while waiting for session ${sessionId}`))
    }
    this.waiters.clear()
  }

  private observe(sessionId: string, event: ProbeEvent): void {
    if (!this.trackedSessions.has(sessionId)) return
    const list = this.events.get(sessionId) ?? []
    list.push(event)
    if (list.length > MAX_EVENTS_PER_SESSION) list.splice(0, list.length - MAX_EVENTS_PER_SESSION)
    this.events.set(sessionId, list)
    const waiter = this.waiters.get(sessionId)
    if (waiter === undefined) return
    waiter.events.push(event)
    if (event.type !== 'turn/end') return
    clearTimeout(waiter.timer)
    this.waiters.delete(sessionId)
    waiter.resolve(summarizeEvents(waiter.events))
  }

  private waitForTurn(sessionId: string): Promise<TurnSummary> {
    return new Promise<TurnSummary>((resolve, reject) => {
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

  private track(run: MutableRun, sessionId: string): void {
    run.sessionIds.push(sessionId)
    this.trackedSessions.add(sessionId)
  }

  private releaseSessions(run: MutableRun): void {
    for (const sessionId of run.sessionIds) {
      this.trackedSessions.delete(sessionId)
      this.events.delete(sessionId)
    }
  }

  private async promptRound(sessionId: string, text: string): Promise<RoundView> {
    const fromSeq = (this.events.get(sessionId) ?? []).at(-1)?.seq ?? 0
    const wait = this.waitForTurn(sessionId)
    await this.host.sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, AbortSignal.timeout(this.config.promptTimeoutMs))
    const summary = await wait
    return {
      fromSeq,
      startSeq: summary.startSeq,
      endSeq: summary.endSeq,
      turn: summary.turn,
      reason: summary.reason,
      text: clip(summary.text),
    }
  }

  private async requireWorkspaceId(): Promise<string> {
    if (this.workspaceId !== null) return this.workspaceId
    const workspace = await this.host.workspaceRegistry.resolveByPath(this.config.repoPath)
    if (workspace === undefined) {
      throw new Error(`no DSH workspace is registered for ${this.config.repoPath}`)
    }
    this.workspaceId = workspace.id
    return workspace.id
  }

  private async waitUntil<T>(label: string, read: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + this.config.promptTimeoutMs
    for (;;) {
      const value = await read()
      if (value !== undefined) return value
      if (Date.now() >= deadline) throw new Error(`timeout after ${this.config.promptTimeoutMs}ms waiting for ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  private async execute(run: MutableRun): Promise<void> {
    try {
      for (const phase of run.phases) {
        if (this.disposed) throw new Error('probe runner was disposed')
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
      this.releaseSessions(run)
      await this.persistRun(run)
    }
  }

  private async runPhase(id: string, run: MutableRun): Promise<Record<string, unknown>> {
    switch (id) {
      case 'preset': return this.phasePreset(run)
      case 'wake': return this.phaseWake(run)
      case 'visibility': return this.phaseVisibility(run)
      case 'store': return this.phaseStore(run)
      case 'worktree': return this.phaseWorktree(run)
      case 'patchReload': return this.phasePatchReload()
      default: throw new Error(`unknown probe phase: ${id}`)
    }
  }

  /** Risk 3: the runtime preset registration and per-session composition. */
  private async phasePreset(run: MutableRun): Promise<Record<string, unknown>> {
    const presets = await this.host.agentPresets.list()
    const row = presets.find((preset) => preset.id === PROBE_PRESET_ID)
    const evidence: Record<string, unknown> = {
      presetId: PROBE_PRESET_ID,
      registered: row !== undefined,
      broken: row?.broken ?? null,
      presetIds: presets.map((preset) => preset.id),
    }
    if (row === undefined) throw new Error(`preset ${PROBE_PRESET_ID} is not registered`)
    if (row.broken !== undefined) throw new Error(`preset ${PROBE_PRESET_ID} is broken: ${clip(JSON.stringify(row.broken), 300)}`)
    const workspaceId = await this.requireWorkspaceId()
    const created = await this.host.sessionController.create({ workspaceId, agentPreset: PROBE_PRESET_ID })
    this.track(run, created.sessionId)
    const inspected = await this.host.sessionController.inspect(created.sessionId)
    evidence.sessionId = created.sessionId
    evidence.workspaceId = workspaceId
    evidence.createReturnedPreset = created.agentPreset ?? null
    evidence.headerPreset = inspected.meta.agentPreset ?? null
    evidence.headerCwd = inspected.meta.cwd ?? null
    if (created.agentPreset !== PROBE_PRESET_ID) {
      throw new Error(`create returned agentPreset ${String(created.agentPreset)} instead of ${PROBE_PRESET_ID}`)
    }
    if (inspected.meta.agentPreset !== PROBE_PRESET_ID) {
      throw new Error(`session header records agentPreset ${String(inspected.meta.agentPreset)}`)
    }
    return evidence
  }

  /** Risk 1: two queued prompts on one idle session each finish a full turn. */
  private async phaseWake(run: MutableRun): Promise<Record<string, unknown>> {
    const workspaceId = await this.requireWorkspaceId()
    const created = await this.host.sessionController.create({ workspaceId })
    this.track(run, created.sessionId)
    const rounds: RoundView[] = []
    for (const index of [1, 2]) {
      const round = await this.promptRound(
        created.sessionId,
        `Probe wake round ${index}. Reply with exactly this token and nothing else: ${WAKE_MARKER}`,
      )
      rounds.push(round)
      if (round.reason !== 'completed') {
        throw new Error(`wake round ${index} ended with reason ${String(round.reason)}`)
      }
      if (!round.text.includes(WAKE_MARKER)) {
        throw new Error(`wake round ${index} reply does not contain ${WAKE_MARKER}: ${clip(round.text)}`)
      }
    }
    run.wakeSessionId = created.sessionId
    return { sessionId: created.sessionId, wakeMarker: WAKE_MARKER, rounds }
  }

  /** Risk 2: the session row and the workspace session list carry the session. */
  private async phaseVisibility(run: MutableRun): Promise<Record<string, unknown>> {
    const sessionId = run.wakeSessionId
    if (sessionId === undefined) throw new Error('visibility needs the wake session; run the wake phase first')
    const workspaceId = await this.requireWorkspaceId()
    const row = await this.waitUntil(
      `session ${sessionId} to appear idle in session.list`,
      async () => {
        const { items } = await this.host.sessionController.list({})
        const found = items.find((item) => item.sessionId === sessionId)
        return found !== undefined && found.running === false ? found : undefined
      },
    )
    const workspace = this.host.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new Error(`workspace ${workspaceId} disappeared from the registry`)
    const evidence: Record<string, unknown> = {
      sessionId,
      workspaceId,
      listed: true,
      running: row.running,
      blank: row.blank,
      cwd: row.cwd ?? null,
      workspacePath: workspace.path,
      attached: workspace.sessionIds.includes(sessionId),
      workspaceSessionCount: workspace.sessionIds.length,
    }
    if (row.cwd !== workspace.path) throw new Error(`session cwd ${String(row.cwd)} does not equal workspace path ${workspace.path}`)
    if (!workspace.sessionIds.includes(sessionId)) throw new Error(`workspace.sessionIds does not contain ${sessionId}`)
    return evidence
  }

  /** Atomic store written by the plugin, read back by a second session. */
  private async phaseStore(run: MutableRun): Promise<Record<string, unknown>> {
    const workspaceId = await this.requireWorkspaceId()
    const storePath = join(this.config.repoPath, this.config.storeRelativePath)
    const token = `COWORK_PROBE_STORE_${randomUUID().slice(0, 8)}`
    const document: StoreDocument = { runId: run.runId, token, createdAt: Date.now() }
    await mkdir(dirname(storePath), { recursive: true })
    await writeStoreAtomic(storePath, buildStoreDocument(document))
    const onDisk = parseStoreDocument(await readStoreText(storePath))
    if (onDisk.token !== token) throw new Error('store read-back token mismatch')
    const tempSiblings = await listAtomicTempSiblings(storePath)

    const readers: Array<{ sessionId: string; round: RoundView }> = []
    for (const index of [1, 2]) {
      const reader = await this.host.sessionController.create({ workspaceId })
      this.track(run, reader.sessionId)
      const round = await this.promptRound(
        reader.sessionId,
        `Read the file ${storePath} and reply with only the value of its "token" field (reader ${index}).`,
      )
      readers.push({ sessionId: reader.sessionId, round })
      if (round.reason !== 'completed') {
        throw new Error(`store reader ${index} turn ended with reason ${String(round.reason)}`)
      }
      if (!round.text.includes(token)) {
        throw new Error(`store reader ${index} reply does not contain the token: ${clip(round.text)}`)
      }
    }
    const evidence: Record<string, unknown> = {
      storePath,
      token,
      storeReadBack: onDisk.token === token,
      tempSiblings,
      readers,
      replyContainsToken: readers.every(({ round }) => round.text.includes(token)),
    }
    if (tempSiblings.length > 0) throw new Error(`atomic write left temp siblings: ${tempSiblings.join(', ')}`)
    return evidence
  }

  /** Risk 4: a worktree-backed session reads the marker and writes a file. */
  private async phaseWorktree(run: MutableRun): Promise<Record<string, unknown>> {
    const worktreePath = join(this.config.repoPath, this.config.worktreeRelativePath)
    const before = await this.git(['worktree', 'list', '--porcelain'])
    await this.git(['worktree', 'prune'])
    try {
      await this.git(['worktree', 'remove', '--force', worktreePath])
    } catch {
      // No previous probe worktree is the normal first-run case.
    }
    await rm(worktreePath, { recursive: true, force: true })
    try {
      await this.git(['branch', '-D', WORKTREE_BRANCH])
    } catch {
      // No previous probe branch is the normal first-run case.
    }
    await this.git(['worktree', 'add', '-B', WORKTREE_BRANCH, worktreePath])
    const afterAdd = await this.git(['worktree', 'list', '--porcelain'])
    try {
      await writeFile(join(worktreePath, 'marker.txt'), `${WORKTREE_MARKER}\n`, 'utf8')
      const created = await this.host.sessionController.create({ cwd: worktreePath })
      this.track(run, created.sessionId)
      const header = await this.host.sessionController.inspect(created.sessionId)
      const round = await this.promptRound(
        created.sessionId,
        'In the current working directory there is a file named marker.txt. '
        + 'Read it and reply with its exact content. Then write that same content '
        + 'to a file named out.txt in the current working directory.',
      )
      const outPath = join(worktreePath, 'out.txt')
      const outContent = existsSync(outPath) ? (await readFile(outPath, 'utf8')).trim() : null
      const evidence: Record<string, unknown> = {
        worktreePath,
        branch: WORKTREE_BRANCH,
        marker: WORKTREE_MARKER,
        before: clip(before.stdout, MAX_LIST),
        afterAdd: clip(afterAdd.stdout, MAX_LIST),
        sessionId: created.sessionId,
        sessionCwd: header.meta.cwd ?? null,
        round,
        replyContainsMarker: round.text.includes(WORKTREE_MARKER),
        outFile: outPath,
        outContent,
        outFileWroteMarker: outContent === WORKTREE_MARKER,
      }
      if (header.meta.cwd !== worktreePath) throw new Error(`worktree session cwd ${String(header.meta.cwd)} does not equal ${worktreePath}`)
      if (round.reason !== 'completed') throw new Error(`worktree turn ended with reason ${String(round.reason)}`)
      if (!round.text.includes(WORKTREE_MARKER)) throw new Error(`worktree reply does not contain the marker: ${clip(round.text)}`)
      if (outContent !== WORKTREE_MARKER) throw new Error(`worktree out.txt content is ${String(outContent)}`)
      return evidence
    } finally {
      try {
        await this.git(['worktree', 'remove', '--force', worktreePath])
      } catch {
        // The cleanup below removes the directory regardless.
      }
      await rm(worktreePath, { recursive: true, force: true })
      try {
        await this.git(['branch', '-D', WORKTREE_BRANCH])
      } catch {
        // A missing branch means nothing to clean.
      }
    }
  }

  /** Risk 5 facts: patchReload is not a runtime switch; hot load comes from injection/HMR. */
  private async phasePatchReload(): Promise<Record<string, unknown>> {
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const profileDir = join(dshHome, 'profiles', 'web')
    const patchPath = join(profileDir, 'cordis.patch.yml')
    const packagePath = join(profileDir, 'package.json')
    const patchText = existsSync(patchPath) ? await readFile(patchPath, 'utf8') : ''
    const profileManifest = existsSync(packagePath)
      ? JSON.parse(await readFile(packagePath, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
      : undefined
    const bundles = profileManifest?.dsh?.profile?.bundles ?? []
    const entry = process.argv[1] ?? ''
    const marker = '/node_modules/'
    const at = entry.indexOf(marker)
    const installRoot = at > 0 ? entry.slice(0, at) : null
    const hmrInstalled = installRoot === null
      ? false
      : existsSync(join(installRoot, 'node_modules', '@deepseek-ai', 'dsh-hmr'))
    const afterCleanup = await this.git(['worktree', 'list', '--porcelain'])
    return {
      profileDir,
      patchPath,
      patchReloadInPatch: patchText.includes('patchReload'),
      profileBundleCount: bundles.length,
      profileBundlesHasHmr: bundles.includes('@deepseek-ai/dsh-hmr'),
      hmrPackageInstalled: hmrInstalled,
      pluginServedLive: true,
      worktreeListAfterCleanup: clip(afterCleanup.stdout, MAX_LIST),
    }
  }

  private async git(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await runFile('git', args, {
      cwd: this.config.repoPath,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { stdout, stderr }
  }

  /**
   * Persist each run twice: `last-run.json` for the newest run and
   * `runs/<runId>.json` so a cited run stays addressable after a reload.
   */
  private async persistRun(run: MutableRun): Promise<void> {
    const probeDir = join(this.config.repoPath, '.dsh-cowork', 'probe')
    const body = `${JSON.stringify(this.view(run), null, 2)}\n`
    try {
      await mkdir(join(probeDir, 'runs'), { recursive: true })
      await writeStoreAtomic(join(probeDir, 'last-run.json'), body)
      await writeStoreAtomic(join(probeDir, 'runs', `${run.runId}.json`), body)
    } catch {
      // The persisted copy is evidence convenience; the in-memory run stays authoritative.
    }
  }

  private trimRuns(): void {
    while (this.runs.size > MAX_RUNS) {
      const oldest = this.runs.keys().next().value
      if (oldest === undefined || oldest === this.lastRunId) return
      this.runs.delete(oldest)
    }
  }

  private view(run: MutableRun): RunView {
    return JSON.parse(JSON.stringify(run)) as RunView
  }
}
