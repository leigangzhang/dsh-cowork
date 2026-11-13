/**
 * The M0 probe runner: one run proves the five PLAN §3.2 risks against the
 * live host and keeps every phase's raw evidence. Runs are started by the
 * loopback route, report progress through the status route, and hold no
 * durable state beyond the probe store file.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { buildStoreDocument, parseStoreDocument, summarizeEvents, } from './probe-model.js';
import { listAtomicTempSiblings, readStoreText, writeStoreAtomic } from './probe-store.js';
const runFile = promisify(execFile);
/** Preset id the probe registers and asks the host to compose. */
export const PROBE_PRESET_ID = 'cowork-probe';
/** Marker the two wake turns must answer with. */
export const WAKE_MARKER = 'COWORK_PROBE_WAKE_OK';
/** Marker written into the probe worktree. */
export const WORKTREE_MARKER = 'COWORK_PROBE_WORKTREE_OK';
/** Probe worktree branch. */
const WORKTREE_BRANCH = 'cowork/probe-m0';
/** The ordered phases of one run. */
const PHASES = ['preset', 'wake', 'visibility', 'store', 'worktree', 'patchReload'];
const BUILD_TAG = 'm0-2';
const MAX_EVENTS_PER_SESSION = 500;
const MAX_TEXT = 500;
const MAX_LIST = 1200;
const MAX_RUNS = 20;
function clip(text, limit = MAX_TEXT) {
    return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Run one bounded phase and record its evidence. */
export class ProbeRunner {
    host;
    config;
    pluginName;
    pluginVersion;
    runs = new Map();
    events = new Map();
    trackedSessions = new Set();
    waiters = new Map();
    workspaceId = null;
    presetRegistered = false;
    lastRunId = null;
    disposed = false;
    constructor(host, config, pluginName, pluginVersion) {
        this.host = host;
        this.config = config;
        this.pluginName = pluginName;
        this.pluginVersion = pluginVersion;
    }
    /** Mark the runtime preset registration as complete (drives health). */
    markPresetRegistered() {
        this.presetRegistered = true;
    }
    /** Subscribe to the host's session event feed; returns the disposer. */
    attachEvents() {
        return this.host.on('session/event', (session, event) => {
            this.observe(session.id, event);
        });
    }
    /** Start one run and return its initial view. */
    start() {
        if (this.disposed)
            throw new Error('probe runner is disposed');
        const active = this.lastRunId === null ? undefined : this.runs.get(this.lastRunId);
        if (active !== undefined && active.state === 'running') {
            throw new Error(`probe run ${active.runId} is still running`);
        }
        const run = {
            runId: `run-${randomUUID()}`,
            state: 'running',
            startedAt: Date.now(),
            phases: PHASES.map((id) => ({ id, status: 'pending' })),
            sessionIds: [],
        };
        this.runs.set(run.runId, run);
        this.lastRunId = run.runId;
        this.trimRuns();
        void this.execute(run);
        return this.view(run);
    }
    /** Read one run view, or undefined when unknown. */
    status(runId) {
        const run = this.runs.get(runId);
        return run === undefined ? undefined : this.view(run);
    }
    /**
     * Resolve a run by id, falling back to the last run persisted on disk. A
     * host rebuild reloads this module and empties the in-memory table, so the
     * status route must still answer for the last cited run id.
     */
    async resolve(runId) {
        const live = this.status(runId);
        if (live !== undefined)
            return live;
        const base = join(this.config.repoPath, '.dsh-cowork', 'probe');
        const candidates = [join(base, 'last-run.json')];
        // The run id becomes a file name: accept only the ids this runner mints.
        if (/^run-[0-9a-fA-F-]{8,64}$/.test(runId))
            candidates.push(join(base, 'runs', `${runId}.json`));
        for (const file of candidates) {
            try {
                const persisted = JSON.parse(await readFile(file, 'utf8'));
                if (persisted.runId === runId)
                    return persisted;
            }
            catch {
                // A missing or unreadable record is not an error for the status route.
            }
        }
        return undefined;
    }
    /** Read the last run view. */
    lastRun() {
        return this.lastRunId === null ? undefined : this.status(this.lastRunId);
    }
    /** Read the health payload. */
    health() {
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
        };
    }
    /** Reject pending waits so a disposed plugin cannot hang a run forever. */
    dispose() {
        this.disposed = true;
        for (const [sessionId, waiter] of this.waiters) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error(`probe disposed while waiting for session ${sessionId}`));
        }
        this.waiters.clear();
    }
    observe(sessionId, event) {
        if (!this.trackedSessions.has(sessionId))
            return;
        const list = this.events.get(sessionId) ?? [];
        list.push(event);
        if (list.length > MAX_EVENTS_PER_SESSION)
            list.splice(0, list.length - MAX_EVENTS_PER_SESSION);
        this.events.set(sessionId, list);
        const waiter = this.waiters.get(sessionId);
        if (waiter === undefined)
            return;
        waiter.events.push(event);
        if (event.type !== 'turn/end')
            return;
        clearTimeout(waiter.timer);
        this.waiters.delete(sessionId);
        waiter.resolve(summarizeEvents(waiter.events));
    }
    waitForTurn(sessionId) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters.delete(sessionId);
                const seen = (this.events.get(sessionId) ?? []).slice(-6).map((event) => `${event.type}#${event.seq}`);
                reject(new Error(`timeout after ${this.config.promptTimeoutMs}ms waiting for turn/end on ${sessionId}; recent events: ${seen.join(', ') || '(none)'}`));
            }, this.config.promptTimeoutMs);
            this.waiters.set(sessionId, { events: [], timer, resolve, reject });
        });
    }
    track(run, sessionId) {
        run.sessionIds.push(sessionId);
        this.trackedSessions.add(sessionId);
    }
    releaseSessions(run) {
        for (const sessionId of run.sessionIds) {
            this.trackedSessions.delete(sessionId);
            this.events.delete(sessionId);
        }
    }
    async promptRound(sessionId, text) {
        const fromSeq = (this.events.get(sessionId) ?? []).at(-1)?.seq ?? 0;
        const wait = this.waitForTurn(sessionId);
        await this.host.sessionController.prompt({
            requestId: randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
        }, AbortSignal.timeout(this.config.promptTimeoutMs));
        const summary = await wait;
        return {
            fromSeq,
            startSeq: summary.startSeq,
            endSeq: summary.endSeq,
            turn: summary.turn,
            reason: summary.reason,
            text: clip(summary.text),
        };
    }
    async requireWorkspaceId() {
        if (this.workspaceId !== null)
            return this.workspaceId;
        const workspace = await this.host.workspaceRegistry.resolveByPath(this.config.repoPath);
        if (workspace === undefined) {
            throw new Error(`no DSH workspace is registered for ${this.config.repoPath}`);
        }
        this.workspaceId = workspace.id;
        return workspace.id;
    }
    async waitUntil(label, read) {
        const deadline = Date.now() + this.config.promptTimeoutMs;
        for (;;) {
            const value = await read();
            if (value !== undefined)
                return value;
            if (Date.now() >= deadline)
                throw new Error(`timeout after ${this.config.promptTimeoutMs}ms waiting for ${label}`);
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    async execute(run) {
        try {
            for (const phase of run.phases) {
                if (this.disposed)
                    throw new Error('probe runner was disposed');
                phase.status = 'running';
                phase.startedAt = Date.now();
                try {
                    phase.evidence = await this.runPhase(phase.id, run);
                    phase.status = 'passed';
                }
                catch (error) {
                    phase.status = 'failed';
                    phase.error = messageOf(error);
                    run.state = 'failed';
                }
                finally {
                    phase.endedAt = Date.now();
                }
            }
        }
        catch (error) {
            run.state = 'failed';
            run.error = messageOf(error);
        }
        finally {
            if (run.state === 'running')
                run.state = 'done';
            run.endedAt = Date.now();
            this.releaseSessions(run);
            await this.persistRun(run);
        }
    }
    async runPhase(id, run) {
        switch (id) {
            case 'preset': return this.phasePreset(run);
            case 'wake': return this.phaseWake(run);
            case 'visibility': return this.phaseVisibility(run);
            case 'store': return this.phaseStore(run);
            case 'worktree': return this.phaseWorktree(run);
            case 'patchReload': return this.phasePatchReload();
            default: throw new Error(`unknown probe phase: ${id}`);
        }
    }
    /** Risk 3: the runtime preset registration and per-session composition. */
    async phasePreset(run) {
        const presets = await this.host.agentPresets.list();
        const row = presets.find((preset) => preset.id === PROBE_PRESET_ID);
        const evidence = {
            presetId: PROBE_PRESET_ID,
            registered: row !== undefined,
            broken: row?.broken ?? null,
            presetIds: presets.map((preset) => preset.id),
        };
        if (row === undefined)
            throw new Error(`preset ${PROBE_PRESET_ID} is not registered`);
        if (row.broken !== undefined)
            throw new Error(`preset ${PROBE_PRESET_ID} is broken: ${clip(JSON.stringify(row.broken), 300)}`);
        const workspaceId = await this.requireWorkspaceId();
        const created = await this.host.sessionController.create({ workspaceId, agentPreset: PROBE_PRESET_ID });
        this.track(run, created.sessionId);
        const inspected = await this.host.sessionController.inspect(created.sessionId);
        evidence.sessionId = created.sessionId;
        evidence.workspaceId = workspaceId;
        evidence.createReturnedPreset = created.agentPreset ?? null;
        evidence.headerPreset = inspected.meta.agentPreset ?? null;
        evidence.headerCwd = inspected.meta.cwd ?? null;
        if (created.agentPreset !== PROBE_PRESET_ID) {
            throw new Error(`create returned agentPreset ${String(created.agentPreset)} instead of ${PROBE_PRESET_ID}`);
        }
        if (inspected.meta.agentPreset !== PROBE_PRESET_ID) {
            throw new Error(`session header records agentPreset ${String(inspected.meta.agentPreset)}`);
        }
        return evidence;
    }
    /** Risk 1: two queued prompts on one idle session each finish a full turn. */
    async phaseWake(run) {
        const workspaceId = await this.requireWorkspaceId();
        const created = await this.host.sessionController.create({ workspaceId });
        this.track(run, created.sessionId);
        const rounds = [];
        for (const index of [1, 2]) {
            const round = await this.promptRound(created.sessionId, `Probe wake round ${index}. Reply with exactly this token and nothing else: ${WAKE_MARKER}`);
            rounds.push(round);
            if (round.reason !== 'completed') {
                throw new Error(`wake round ${index} ended with reason ${String(round.reason)}`);
            }
            if (!round.text.includes(WAKE_MARKER)) {
                throw new Error(`wake round ${index} reply does not contain ${WAKE_MARKER}: ${clip(round.text)}`);
            }
        }
        run.wakeSessionId = created.sessionId;
        return { sessionId: created.sessionId, wakeMarker: WAKE_MARKER, rounds };
    }
    /** Risk 2: the session row and the workspace session list carry the session. */
    async phaseVisibility(run) {
        const sessionId = run.wakeSessionId;
        if (sessionId === undefined)
            throw new Error('visibility needs the wake session; run the wake phase first');
        const workspaceId = await this.requireWorkspaceId();
        const row = await this.waitUntil(`session ${sessionId} to appear idle in session.list`, async () => {
            const { items } = await this.host.sessionController.list({});
            const found = items.find((item) => item.sessionId === sessionId);
            return found !== undefined && found.running === false ? found : undefined;
        });
        const workspace = this.host.workspaceRegistry.get(workspaceId);
        if (workspace === undefined)
            throw new Error(`workspace ${workspaceId} disappeared from the registry`);
        const evidence = {
            sessionId,
            workspaceId,
            listed: true,
            running: row.running,
            blank: row.blank,
            cwd: row.cwd ?? null,
            workspacePath: workspace.path,
            attached: workspace.sessionIds.includes(sessionId),
            workspaceSessionCount: workspace.sessionIds.length,
        };
        if (row.cwd !== workspace.path)
            throw new Error(`session cwd ${String(row.cwd)} does not equal workspace path ${workspace.path}`);
        if (!workspace.sessionIds.includes(sessionId))
            throw new Error(`workspace.sessionIds does not contain ${sessionId}`);
        return evidence;
    }
    /** Atomic store written by the plugin, read back by a second session. */
    async phaseStore(run) {
        const workspaceId = await this.requireWorkspaceId();
        const storePath = join(this.config.repoPath, this.config.storeRelativePath);
        const token = `COWORK_PROBE_STORE_${randomUUID().slice(0, 8)}`;
        const document = { runId: run.runId, token, createdAt: Date.now() };
        await mkdir(dirname(storePath), { recursive: true });
        await writeStoreAtomic(storePath, buildStoreDocument(document));
        const onDisk = parseStoreDocument(await readStoreText(storePath));
        if (onDisk.token !== token)
            throw new Error('store read-back token mismatch');
        const tempSiblings = await listAtomicTempSiblings(storePath);
        const readers = [];
        for (const index of [1, 2]) {
            const reader = await this.host.sessionController.create({ workspaceId });
            this.track(run, reader.sessionId);
            const round = await this.promptRound(reader.sessionId, `Read the file ${storePath} and reply with only the value of its "token" field (reader ${index}).`);
            readers.push({ sessionId: reader.sessionId, round });
            if (round.reason !== 'completed') {
                throw new Error(`store reader ${index} turn ended with reason ${String(round.reason)}`);
            }
            if (!round.text.includes(token)) {
                throw new Error(`store reader ${index} reply does not contain the token: ${clip(round.text)}`);
            }
        }
        const evidence = {
            storePath,
            token,
            storeReadBack: onDisk.token === token,
            tempSiblings,
            readers,
            replyContainsToken: readers.every(({ round }) => round.text.includes(token)),
        };
        if (tempSiblings.length > 0)
            throw new Error(`atomic write left temp siblings: ${tempSiblings.join(', ')}`);
        return evidence;
    }
    /** Risk 4: a worktree-backed session reads the marker and writes a file. */
    async phaseWorktree(run) {
        const worktreePath = join(this.config.repoPath, this.config.worktreeRelativePath);
        const before = await this.git(['worktree', 'list', '--porcelain']);
        await this.git(['worktree', 'prune']);
        try {
            await this.git(['worktree', 'remove', '--force', worktreePath]);
        }
        catch {
            // No previous probe worktree is the normal first-run case.
        }
        await rm(worktreePath, { recursive: true, force: true });
        try {
            await this.git(['branch', '-D', WORKTREE_BRANCH]);
        }
        catch {
            // No previous probe branch is the normal first-run case.
        }
        await this.git(['worktree', 'add', '-B', WORKTREE_BRANCH, worktreePath]);
        const afterAdd = await this.git(['worktree', 'list', '--porcelain']);
        try {
            await writeFile(join(worktreePath, 'marker.txt'), `${WORKTREE_MARKER}\n`, 'utf8');
            const created = await this.host.sessionController.create({ cwd: worktreePath });
            this.track(run, created.sessionId);
            const header = await this.host.sessionController.inspect(created.sessionId);
            const round = await this.promptRound(created.sessionId, 'In the current working directory there is a file named marker.txt. '
                + 'Read it and reply with its exact content. Then write that same content '
                + 'to a file named out.txt in the current working directory.');
            const outPath = join(worktreePath, 'out.txt');
            const outContent = existsSync(outPath) ? (await readFile(outPath, 'utf8')).trim() : null;
            const evidence = {
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
            };
            if (header.meta.cwd !== worktreePath)
                throw new Error(`worktree session cwd ${String(header.meta.cwd)} does not equal ${worktreePath}`);
            if (round.reason !== 'completed')
                throw new Error(`worktree turn ended with reason ${String(round.reason)}`);
            if (!round.text.includes(WORKTREE_MARKER))
                throw new Error(`worktree reply does not contain the marker: ${clip(round.text)}`);
            if (outContent !== WORKTREE_MARKER)
                throw new Error(`worktree out.txt content is ${String(outContent)}`);
            return evidence;
        }
        finally {
            try {
                await this.git(['worktree', 'remove', '--force', worktreePath]);
            }
            catch {
                // The cleanup below removes the directory regardless.
            }
            await rm(worktreePath, { recursive: true, force: true });
            try {
                await this.git(['branch', '-D', WORKTREE_BRANCH]);
            }
            catch {
                // A missing branch means nothing to clean.
            }
        }
    }
    /** Risk 5 facts: patchReload is not a runtime switch; hot load comes from injection/HMR. */
    async phasePatchReload() {
        const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
        const profileDir = join(dshHome, 'profiles', 'web');
        const patchPath = join(profileDir, 'cordis.patch.yml');
        const packagePath = join(profileDir, 'package.json');
        const patchText = existsSync(patchPath) ? await readFile(patchPath, 'utf8') : '';
        const profileManifest = existsSync(packagePath)
            ? JSON.parse(await readFile(packagePath, 'utf8'))
            : undefined;
        const bundles = profileManifest?.dsh?.profile?.bundles ?? [];
        const entry = process.argv[1] ?? '';
        const marker = '/node_modules/';
        const at = entry.indexOf(marker);
        const installRoot = at > 0 ? entry.slice(0, at) : null;
        const hmrInstalled = installRoot === null
            ? false
            : existsSync(join(installRoot, 'node_modules', '@deepseek-ai', 'dsh-hmr'));
        const afterCleanup = await this.git(['worktree', 'list', '--porcelain']);
        return {
            profileDir,
            patchPath,
            patchReloadInPatch: patchText.includes('patchReload'),
            profileBundleCount: bundles.length,
            profileBundlesHasHmr: bundles.includes('@deepseek-ai/dsh-hmr'),
            hmrPackageInstalled: hmrInstalled,
            pluginServedLive: true,
            worktreeListAfterCleanup: clip(afterCleanup.stdout, MAX_LIST),
        };
    }
    async git(args) {
        const { stdout, stderr } = await runFile('git', args, {
            cwd: this.config.repoPath,
            timeout: 60_000,
            maxBuffer: 4 * 1024 * 1024,
        });
        return { stdout, stderr };
    }
    /**
     * Persist each run twice: `last-run.json` for the newest run and
     * `runs/<runId>.json` so a cited run stays addressable after a reload.
     */
    async persistRun(run) {
        const probeDir = join(this.config.repoPath, '.dsh-cowork', 'probe');
        const body = `${JSON.stringify(this.view(run), null, 2)}\n`;
        try {
            await mkdir(join(probeDir, 'runs'), { recursive: true });
            await writeStoreAtomic(join(probeDir, 'last-run.json'), body);
            await writeStoreAtomic(join(probeDir, 'runs', `${run.runId}.json`), body);
        }
        catch {
            // The persisted copy is evidence convenience; the in-memory run stays authoritative.
        }
    }
    trimRuns() {
        while (this.runs.size > MAX_RUNS) {
            const oldest = this.runs.keys().next().value;
            if (oldest === undefined || oldest === this.lastRunId)
                return;
            this.runs.delete(oldest);
        }
    }
    view(run) {
        return JSON.parse(JSON.stringify(run));
    }
}
//# sourceMappingURL=probe-engine.js.map