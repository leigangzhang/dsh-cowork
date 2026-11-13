/**
 * @dsh-external/dsh-cowork host plugin.
 *
 * The business surface — the panel API, the nineteen cowork tools, the three
 * presets, and the project-memory prompt section — is always registered. The
 * M0/S0/M2/M3 probe and E2E surfaces (two probe tools, two probe presets, the
 * loopback-only start/status routes, and four session event feeds) only exist
 * when `Config.enableDevRoutes` is true, so an installed profile does not
 * expose them to users.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { registerCoworkApi } from './api.js';
import { AUTHORIZATION_RESOLVE_PATH, OVERVIEW_PATH, REOPEN_PATH, RESOLVE_PATH } from './api-contract.js';
import { panelProbeRequest, panelRoutePathname } from './panel-probe.js';
export { panelRoutePathname };
import { PROBE_PRESET_ID, ProbeRunner } from './probe-engine.js';
import { MEMORY_FILES, MEMORY_KINDS, memoryFilePath, parseMemoryFile, renderMemoryBlock } from './memory.js';
import { registerMemoryPrompt } from './memory-prompt.js';
import { M2E2ERunner } from './m2-e2e.js';
import { M3E2ERunner, M3_E2E_RUN_PATH, M3_E2E_STATUS_PATH } from './m3-e2e.js';
import { M12E2ERunner, M12_E2E_RUN_PATH, M12_E2E_STATUS_PATH } from './m12-e2e.js';
import { canonicalRepoPath, isLoopbackAddress, isLoopbackHost, readPath, readQuery, requireRunId } from './probe-model.js';
import { registerPresets } from './presets.js';
import { HIDDEN_PRESET_IDS, hidePresetsFromRoster } from './preset-visibility.js';
import { S0Runner, THREAD_SMOKE_PRESET_ID } from './s0-probe.js';
import { ProjectStore, findProjectRoot, findProjectRootSync } from './store.js';
import { SessionSlice } from './session-slice.js';
import { createLlmRoutingPort } from './llm-port.js';
import { DEFAULT_ISOLATION_PROVIDER, DEFAULT_REVIEWER_RECLAIM } from './tool-runtime.js';
import { NoopTopicNoticePort, TopicNoticeDispatcher } from './notices.js';
import { registerCoworkTools } from './tools.js';
import { TopicEvents } from './topic-events.js';
import { DEFAULT_IDLE_AFTER_MS, DEFAULT_RESOLVE_AFTER_MS } from './topic.js';
import { repairCoworkWorkspaces } from './workspace-repair.js';
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
const PLUGIN_NAME = packageJson.name;
const PLUGIN_VERSION = packageJson.version;
/** Health route: liveness, plugin identity, and preset registration state. */
const HEALTH_PATH = '/dsh-cowork/probe/health';
/** Run route: start one probe run and return its id immediately. */
const RUN_PATH = '/dsh-cowork/probe/run';
/** Status route: poll one run's phases, evidence, sessions, and error. */
const STATUS_PATH = '/dsh-cowork/probe/status';
/** S0 run route: start one M1 S0 probe run and return its id immediately. */
const S0_RUN_PATH = '/dsh-cowork/probe/s0';
/** S0 status route: poll one S0 run. */
const S0_STATUS_PATH = '/dsh-cowork/probe/s0-status';
/** M2 E2E run route: start one real-host run and return its id immediately. */
const M2_E2E_RUN_PATH = '/dsh-cowork/e2e/m2/run';
/** M2 E2E status route: poll one run's steps, evidence, and error. */
const M2_E2E_STATUS_PATH = '/dsh-cowork/e2e/m2/status';
/** Working defaults for the fields a caller may omit. */
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
const DEFAULT_STORE_RELATIVE_PATH = '.dsh-cowork/probe/store.json';
const DEFAULT_WORKTREE_RELATIVE_PATH = '.dsh-cowork/worktrees/probe';
const DEFAULT_ROUTING_TIMEOUT_MS = 2_000;
const DEFAULT_ROUTING_MAX_TOKENS = 256;
export const Config = z.object({
    repoPath: z.string().default(''),
    promptTimeoutMs: z.number().min(30_000).max(600_000).default(DEFAULT_PROMPT_TIMEOUT_MS),
    storeRelativePath: z.string().default(DEFAULT_STORE_RELATIVE_PATH),
    worktreeRelativePath: z.string().default(DEFAULT_WORKTREE_RELATIVE_PATH),
    enableDevRoutes: z.boolean().default(false),
    idleAfterMs: z.number().min(0).default(DEFAULT_IDLE_AFTER_MS),
    resolveAfterMs: z.number().min(0).default(DEFAULT_RESOLVE_AFTER_MS),
    routing: z.object({
        enabled: z.boolean().default(true),
        provider: z.string().default(''),
        model: z.string().default(''),
        effort: z.string().default(''),
        timeoutMs: z.number().min(1).default(DEFAULT_ROUTING_TIMEOUT_MS),
        maxTokens: z.number().min(1).default(DEFAULT_ROUTING_MAX_TOKENS),
    }),
    isolation: z.object({
        provider: z.string().default(DEFAULT_ISOLATION_PROVIDER),
    }),
    reviewer: z.object({
        reclaim: z.string().default(DEFAULT_REVIEWER_RECLAIM),
    }),
});
/**
 * Fill every omitted configuration field with its documented default.
 *
 * The host feeds `apply` a schema-validated `Config`, but tests and future
 * embedders construct one by hand; routing must not crash because one nested
 * object is missing. This is the single place that knows the defaults, and
 * `apply` uses only its result.
 */
export function normalizeConfig(config) {
    return {
        repoPath: config.repoPath ?? '',
        promptTimeoutMs: config.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
        storeRelativePath: config.storeRelativePath ?? DEFAULT_STORE_RELATIVE_PATH,
        worktreeRelativePath: config.worktreeRelativePath ?? DEFAULT_WORKTREE_RELATIVE_PATH,
        enableDevRoutes: config.enableDevRoutes ?? false,
        idleAfterMs: config.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS,
        resolveAfterMs: config.resolveAfterMs ?? DEFAULT_RESOLVE_AFTER_MS,
        routing: {
            enabled: config.routing?.enabled ?? true,
            provider: config.routing?.provider ?? '',
            model: config.routing?.model ?? '',
            effort: config.routing?.effort ?? '',
            timeoutMs: config.routing?.timeoutMs ?? DEFAULT_ROUTING_TIMEOUT_MS,
            maxTokens: config.routing?.maxTokens ?? DEFAULT_ROUTING_MAX_TOKENS,
        },
        isolation: {
            provider: config.isolation?.provider ?? DEFAULT_ISOLATION_PROVIDER,
        },
        reviewer: {
            reclaim: config.reviewer?.reclaim ?? DEFAULT_REVIEWER_RECLAIM,
        },
    };
}
/** Host services this plugin cannot activate without. */
export const inject = ['webServer', 'tools', 'agentPresets', 'sessionController', 'workspaceRegistry', 'agents'];
function sendJson(response, status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
    });
    response.end(body);
}
function loopbackOnly(request) {
    return isLoopbackAddress(request.socket.remoteAddress)
        && isLoopbackHost(request.headers.host);
}
function sendMethodNotAllowed(response, allow) {
    response.setHeader('allow', allow);
    sendJson(response, 405, { ok: false, error: 'method not allowed' });
}
function guard(request, response, allow) {
    if (!loopbackOnly(request)) {
        sendJson(response, 403, { ok: false, error: 'loopback requests only' });
        return false;
    }
    if (request.method !== allow) {
        sendMethodNotAllowed(response, allow);
        return false;
    }
    return true;
}
/** The plugin root (the directory holding package.json), used as the default repo. */
function defaultRepoPath() {
    return resolve(fileURLToPath(new URL('..', import.meta.url)));
}
/**
 * Project the host registry onto the slice's workspace port. Every other
 * operation is forwarded unchanged; `attachSession` resolves the live entity
 * first, because attaching is an operation on the workspace, not the registry.
 */
function workspacePortsOf(registry) {
    return {
        resolveByPath: (path) => registry.resolveByPath(path),
        create: (path, title) => registry.create(path, title),
        delete: (id) => registry.delete(id),
        archiveSession: (sessionId, options) => registry.archiveSession(sessionId, options),
        attachSession: async (workspaceId, sessionId) => {
            const workspace = registry.get(workspaceId);
            if (workspace === undefined) {
                throw new Error(`workspace '${workspaceId}' is not registered, so it cannot own session '${sessionId}'`);
            }
            await workspace.attachSession(sessionId);
        },
    };
}
/**
 * Render the project memory block for one repository.
 *
 * Synchronous by contract: the system-prompt provider is synchronous, so the
 * three files are read with `readFileSync`. A missing file is empty memory; any
 * other read failure disables injection for this prompt rather than quoting a
 * half-read file. The digest is the sha1 of the rendered text, which is what
 * lets the section cache its output until the memory actually changes.
 */
function renderProjectMemory(repoPath) {
    const inputs = [];
    for (const kind of MEMORY_KINDS) {
        let content = '';
        try {
            content = readFileSync(memoryFilePath(repoPath, kind), 'utf8');
        }
        catch (error) {
            const code = error.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR')
                return null;
        }
        inputs.push({ kind, entries: parseMemoryFile(kind, MEMORY_FILES[kind], content).entries });
    }
    const block = renderMemoryBlock(inputs);
    if (block.text === '')
        return null;
    const text = `Project memory for ${repoPath}:\n\n${block.text}`;
    return { text, digest: createHash('sha1').update(text).digest('hex') };
}
/**
 * Register the M0/S0/M2/M3 probe and E2E surfaces: two probe tools, two probe
 * presets, the loopback-only start/status routes, and the four session event
 * feeds. Every registration is an effect owned by this fiber, so an unload
 * leaves neither a route nor a listener behind.
 */
function registerDevSurfaces(ctx, options) {
    const host = ctx;
    const probeConfig = {
        // The host canonicalizes a session cwd (/tmp → /private/tmp on macOS); the
        // probe must compare against the same real path or its assertions fail.
        repoPath: canonicalRepoPath(options.repoPath),
        promptTimeoutMs: options.promptTimeoutMs,
        storeRelativePath: options.storeRelativePath,
        worktreeRelativePath: options.worktreeRelativePath,
    };
    const runner = new ProbeRunner(host, probeConfig, PLUGIN_NAME, PLUGIN_VERSION);
    const s0 = new S0Runner(ctx, {
        repoPath: probeConfig.repoPath,
        promptTimeoutMs: probeConfig.promptTimeoutMs,
    });
    // M2 real-host E2E: loopback-only start/status routes, evidence under .dsh-cowork/e2e/.
    const m2e2e = new M2E2ERunner(ctx, {
        repoPath: probeConfig.repoPath,
        promptTimeoutMs: probeConfig.promptTimeoutMs,
        pluginName: PLUGIN_NAME,
        pluginVersion: PLUGIN_VERSION,
        log: (message) => ctx.logger?.info?.(`[${PLUGIN_NAME}] ${message}`),
    });
    // M3 real-host E2E: independent review gate, two review rounds, evidence under
    // .dsh-cowork/e2e/M3_E2E.json. Same loopback-only start/status shape as M2.
    const m3e2e = new M3E2ERunner(ctx, {
        repoPath: probeConfig.repoPath,
        promptTimeoutMs: probeConfig.promptTimeoutMs,
        pluginName: PLUGIN_NAME,
        pluginVersion: PLUGIN_VERSION,
        log: (message) => ctx.logger?.info?.(`[${PLUGIN_NAME}] ${message}`),
    });
    // M12 real-host E2E: the 0.2.0 topic-session chain, run in a throwaway
    // repository under os.tmpdir(); evidence under .dsh-cowork/e2e/M12_E2E.json.
    const m12e2e = new M12E2ERunner(ctx, {
        repoPath: probeConfig.repoPath,
        promptTimeoutMs: probeConfig.promptTimeoutMs,
        idleAfterMs: options.idleAfterMs,
        resolveAfterMs: options.resolveAfterMs,
        pluginName: PLUGIN_NAME,
        pluginVersion: PLUGIN_VERSION,
        panel: options.panel,
        log: (message) => ctx.logger?.info?.(`[${PLUGIN_NAME}] ${message}`),
    });
    // Risk 3: a preset registered at runtime, owned by this fiber's lifetime.
    ctx.effect(() => {
        const registration = host.agentPresets.register({
            id: PROBE_PRESET_ID,
            name: 'cowork probe',
            description: 'M0 probe preset: registered at runtime, mounts no extra plugins.',
            plugins: [],
        });
        void registration.then(() => runner.markPresetRegistered(), () => { });
        return registration;
    }, 'dsh-cowork: runtime agent preset');
    // S0: explicit plugin rows prove whether a thread-smoke preset can carry tools.
    ctx.effect(() => host.agentPresets.register({
        id: THREAD_SMOKE_PRESET_ID,
        name: 'cowork thread s0',
        description: 'M1 S0 probe preset: persona plus explicit tool rows.',
        plugins: [
            {
                id: 'persona',
                name: '@deepseek-ai/dsh-persona',
                config: { prefix: 'You are a cowork thread probe. Use your tools to inspect the repository when asked.' },
            },
            { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
            { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
            { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
            { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
        ],
    }), 'dsh-cowork: S0 thread preset');
    // S0: report the calling session identity to answer whether `exec.agent` exists.
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'cowork_identity_probe',
        description: 'Temporary M1 S0 probe: report the calling session id, cwd, preset, and execution keys. Read-only.',
        parameters: {
            token: { type: 'string', required: true, description: 'Evidence label, e.g. "master" or "thread".' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
            const caller = exec;
            const identity = {
                token: args.token,
                agentId: caller.agent?.id ?? null,
                cwd: caller.agent?.session?.header?.cwd ?? null,
                agentPreset: caller.agent?.session?.header?.agentPreset ?? null,
                execKeys: Object.keys(exec).sort(),
                hasAgent: caller.agent !== undefined,
            };
            s0.recordIdentity(identity);
            return JSON.parse(JSON.stringify(identity));
        },
    })), 'dsh-cowork: S0 identity probe tool');
    // One read-only tool: health plus the last run summary.
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'cowork_probe',
        description: 'Read the dsh-cowork M0 probe health and the last run summary. Starts no work.',
        parameters: {},
        output: {
            schema: { type: 'json' },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async () => {
            const payload = { health: runner.health(), lastRun: runner.lastRun() ?? null };
            return JSON.parse(JSON.stringify(payload));
        },
    })), 'dsh-cowork: cowork_probe tool');
    const routes = [
        {
            kind: 'exact',
            path: HEALTH_PATH,
            handler: (request, response) => {
                if (!guard(request, response, 'GET'))
                    return;
                sendJson(response, 200, runner.health());
            },
        },
        {
            kind: 'exact',
            path: RUN_PATH,
            handler: (request, response) => {
                if (!guard(request, response, 'POST'))
                    return;
                request.resume();
                try {
                    const run = runner.start();
                    sendJson(response, 200, { runId: run.runId, state: run.state });
                }
                catch (error) {
                    sendJson(response, 409, {
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                        lastRunId: runner.lastRun()?.runId ?? null,
                    });
                }
            },
        },
        {
            kind: 'exact',
            path: STATUS_PATH,
            handler: async (request, response) => {
                if (!guard(request, response, 'GET'))
                    return;
                let runId;
                try {
                    runId = requireRunId(readQuery(request.url, 'runId'));
                }
                catch (error) {
                    sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
                    return;
                }
                const run = await runner.resolve(runId);
                if (run === undefined) {
                    sendJson(response, 404, { ok: false, error: `unknown runId: ${runId}` });
                    return;
                }
                sendJson(response, 200, run);
            },
        },
    ];
    routes.push({
        kind: 'exact',
        path: S0_RUN_PATH,
        handler: (request, response) => {
            if (!guard(request, response, 'POST'))
                return;
            request.resume();
            try {
                const run = s0.start();
                sendJson(response, 200, { runId: run.runId, state: run.state });
            }
            catch (error) {
                sendJson(response, 409, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        },
    }, {
        kind: 'exact',
        path: S0_STATUS_PATH,
        handler: async (request, response) => {
            if (!guard(request, response, 'GET'))
                return;
            let runId;
            try {
                runId = requireRunId(readQuery(request.url, 'runId'));
            }
            catch (error) {
                sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
                return;
            }
            const run = await s0.resolve(runId);
            if (run === undefined) {
                sendJson(response, 404, { ok: false, error: `unknown S0 runId: ${runId}` });
                return;
            }
            sendJson(response, 200, run);
        },
    }, {
        kind: 'exact',
        path: M2_E2E_RUN_PATH,
        handler: (request, response) => {
            if (!guard(request, response, 'POST'))
                return;
            request.resume();
            try {
                const run = m2e2e.start();
                sendJson(response, 200, { ok: true, runId: run.runId });
            }
            catch (error) {
                sendJson(response, 409, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        },
    }, {
        kind: 'exact',
        path: M2_E2E_STATUS_PATH,
        handler: async (request, response) => {
            if (!guard(request, response, 'GET'))
                return;
            let runId;
            try {
                runId = requireRunId(readQuery(request.url, 'runId'));
            }
            catch (error) {
                sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
                return;
            }
            const run = await m2e2e.resolve(runId);
            if (run === undefined) {
                sendJson(response, 404, { ok: false, error: `unknown M2 E2E runId: ${runId}` });
                return;
            }
            sendJson(response, 200, {
                ok: true,
                runId: run.runId,
                state: run.state,
                startedAt: run.startedAt,
                ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
                steps: run.steps,
                evidenceFile: run.evidenceFile,
                ...(run.error === undefined ? {} : { error: run.error }),
            });
        },
    }, {
        kind: 'exact',
        path: M3_E2E_RUN_PATH,
        handler: (request, response) => {
            if (!guard(request, response, 'POST'))
                return;
            request.resume();
            try {
                const run = m3e2e.start();
                sendJson(response, 200, { ok: true, runId: run.runId });
            }
            catch (error) {
                sendJson(response, 409, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        },
    }, {
        kind: 'exact',
        path: M3_E2E_STATUS_PATH,
        handler: async (request, response) => {
            if (!guard(request, response, 'GET'))
                return;
            let runId;
            try {
                runId = requireRunId(readQuery(request.url, 'runId'));
            }
            catch (error) {
                sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
                return;
            }
            const run = await m3e2e.resolve(runId);
            if (run === undefined) {
                sendJson(response, 404, { ok: false, error: `unknown M3 E2E runId: ${runId}` });
                return;
            }
            sendJson(response, 200, {
                ok: true,
                runId: run.runId,
                state: run.state,
                startedAt: run.startedAt,
                ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
                steps: run.steps,
                evidenceFile: run.evidenceFile,
                ...(run.error === undefined ? {} : { error: run.error }),
            });
        },
    }, {
        kind: 'exact',
        path: M12_E2E_RUN_PATH,
        handler: (request, response) => {
            if (!guard(request, response, 'POST'))
                return;
            request.resume();
            try {
                // `keep=1` keeps the throwaway project for a debug run; `base=<ref>`
                // names the artifact diff base (the M12 base commit).
                const keep = readQuery(request.url, 'keep');
                const run = m12e2e.start({
                    keep: keep === '1' || keep === 'true',
                    baseRef: readQuery(request.url, 'base') ?? '',
                });
                sendJson(response, 200, { ok: true, runId: run.runId });
            }
            catch (error) {
                sendJson(response, 409, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        },
    }, {
        kind: 'exact',
        path: M12_E2E_STATUS_PATH,
        handler: async (request, response) => {
            if (!guard(request, response, 'GET'))
                return;
            let runId;
            try {
                runId = requireRunId(readQuery(request.url, 'runId'));
            }
            catch (error) {
                sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
                return;
            }
            const run = await m12e2e.resolve(runId);
            if (run === undefined) {
                sendJson(response, 404, { ok: false, error: `unknown M12 E2E runId: ${runId}` });
                return;
            }
            sendJson(response, 200, {
                ok: true,
                runId: run.runId,
                state: run.state,
                startedAt: run.startedAt,
                ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
                steps: run.steps,
                evidenceFile: run.evidenceFile,
                ...(run.error === undefined ? {} : { error: run.error }),
            });
        },
    });
    for (const route of routes) {
        ctx.effect(() => ctx.webServer.register(route), `dsh-cowork: route ${readPath(route.path)}`);
    }
    ctx.effect(() => runner.attachEvents(), 'dsh-cowork: session event feed');
    ctx.effect(() => s0.attachEvents(), 'dsh-cowork: S0 session event feed');
    ctx.effect(() => m2e2e.attachEvents(), 'dsh-cowork: M2 E2E session event feed');
    ctx.effect(() => m3e2e.attachEvents(), 'dsh-cowork: M3 E2E session event feed');
    ctx.effect(() => m12e2e.attachEvents(), 'dsh-cowork: M12 E2E session event feed');
    ctx.effect(() => () => {
        runner.dispose();
        s0.dispose();
        m2e2e.dispose();
        m3e2e.dispose();
        m12e2e.dispose();
    }, 'dsh-cowork: probe runners');
    ctx.logger?.info?.(`[${PLUGIN_NAME}] M0 probe ready at ${HEALTH_PATH} (repo ${probeConfig.repoPath})`);
    ctx.logger?.info?.(`[${PLUGIN_NAME}] M1 S0 probe ready at ${S0_RUN_PATH}`);
}
/** Read one optional host service without making it a required injection. */
function hostService(ctx, name) {
    const get = ctx.get;
    if (typeof get !== 'function')
        return undefined;
    try {
        return get.call(ctx, name);
    }
    catch {
        return undefined;
    }
}
/**
 * The host's current default model route, used when `routing.provider/model`
 * are unset. Swallowing a missing service keeps this an optional enhancement.
 */
function hostCurrentModelRoute(ctx) {
    return () => {
        const service = hostService(ctx, 'agentDefaultModel');
        if (service === undefined || service === null || typeof service.currentSelection !== 'function')
            return null;
        try {
            const selection = service.currentSelection();
            if (typeof selection?.provider === 'string' && selection.provider.trim() !== ''
                && typeof selection.model === 'string' && selection.model.trim() !== '') {
                return { provider: selection.provider, model: selection.model };
            }
            return null;
        }
        catch {
            return null;
        }
    };
}
/** How long the host desktop opener may take before the call is aborted. */
export const OPEN_WORKSPACE_PATH_TIMEOUT_MS = 10_000;
/**
 * Build the panel's `openWorkspacePath` port from one host session controller.
 *
 * The route passes an absolute path inside the repository; this adapter binds
 * the host's two-argument contract and a bounded timeout signal. A host
 * without the method, or a host that rejects the native open, throws and the
 * open route maps that onto `inbox/open-unsupported` — never a faked success.
 */
export function createOpenWorkspacePathPort(opener, timeoutMs = OPEN_WORKSPACE_PATH_TIMEOUT_MS) {
    return async (path) => {
        const open = opener?.openWorkspacePath;
        if (typeof open !== 'function') {
            throw new Error('the host session controller exposes no openWorkspacePath');
        }
        await open.call(opener, { path, action: 'reveal' }, AbortSignal.timeout(timeoutMs));
    };
}
/** The ten panel routes' shared ports; production and the M12 probe use the same ones. */
function createPanelPorts(ctx, assembly, settings, notices) {
    return {
        // Metadata only: `inspect` also reads the session event log and hung the
        // panel requests on running or large sessions.
        listSessions: () => assembly.sessionController.list(),
        findProjectRoot,
        // Same construction as the tool layer: a panel-triggered migration must
        // archive a cancelled reviewer through the host, not record a fake failure.
        createStore: (repoPath) => new ProjectStore({
            repoPath,
            clock: () => new Date(),
            archiveSession: (sessionId, options) => assembly.workspaceRegistry.archiveSession(sessionId, options),
        }),
        // M11: the panel's lifecycle read point uses the same clock and threshold
        // as the tool layer, and logs a failed activity row instead of failing the
        // request. `resolveAfterMs` is no longer read: nothing auto-resolves.
        now: () => new Date(),
        idleAfterMs: settings.idleAfterMs,
        // The topic page's archive/reopen/authorization semantics need the host
        // session and notice ports; a failure is logged there, not returned.
        archiveSession: (sessionId, options) => assembly.workspaceRegistry.archiveSession(sessionId, options),
        unarchiveSession: (sessionId) => {
            const port = assembly.workspaceRegistry.unarchiveSession;
            if (port === undefined)
                throw new Error('the host workspace registry exposes no unarchiveSession');
            return port.call(assembly.workspaceRegistry, sessionId);
        },
        promptSession: (sessionId, text) => new SessionSlice({
            sessions: assembly.sessionController,
            workspaces: assembly.workspaceRegistry,
        }).promptSession(sessionId, text),
        // The inbox open route is the only caller: the browser sends a request or
        // notice id, the host file browser is handed the resolved absolute path.
        // The adapter supplies the AbortSignal the installed host requires.
        openWorkspacePath: createOpenWorkspacePathPort(assembly.sessionController),
        noticePort: notices.port,
        kickNotices: (repoPath) => notices.kick(repoPath),
        log: (message) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] ${message}`),
    };
}
/**
 * In-process probe for the M12 E2E driver. A plugin has no client for the host
 * `connection` channel, so the probe registers the production panel handlers on
 * a private connection and calls them with a real `Request`. The handlers,
 * guards, store, and lifecycle read point are the shipped ones; only the host's
 * HTTP transport is bypassed, which the evidence document states.
 */
function createM12PanelProbe(ports) {
    const routes = new Map();
    const connection = {
        fetch: {
            register(route) {
                routes.set(route.path, route);
                return async () => { };
            },
        },
    };
    const host = {
        get: (name) => (name === 'connection' ? connection : undefined),
        effect: (execute) => {
            execute();
        },
    };
    registerCoworkApi(host, ports);
    const call = async (path, init) => {
        const route = routes.get(panelRoutePathname(path));
        if (route === undefined)
            throw new Error(`M12 panel probe: no route registered for ${path}`);
        const response = await route.fetch(panelProbeRequest(path, init));
        let body = null;
        try {
            body = await response.json();
        }
        catch {
            body = null;
        }
        return { status: response.status, body };
    };
    return {
        overview: (input) => call(`${OVERVIEW_PATH}?sessionId=${encodeURIComponent(input.sessionId)}`, { method: 'GET' }),
        reopen: (input) => call(REOPEN_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: input.sessionId, topicId: input.topicId }),
        }),
        resolve: (input) => call(RESOLVE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: input.sessionId, topicId: input.topicId }),
        }),
        authorizationResolve: (input) => call(AUTHORIZATION_RESOLVE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
        }),
    };
}
/** Register the business surface, plus the opt-in dev probe surface when enabled. */
export function apply(ctx, config) {
    // One normalized view of the settings: a hand-built partial config (tests,
    // embedders) must not crash routing because `routing` is absent.
    const settings = normalizeConfig(config);
    // M10 supports exactly one reviewer reclaim mode. Any other value fails
    // startup instead of quietly pretending to support it (PLAN §5.4, M10 §8).
    if (settings.reviewer.reclaim !== DEFAULT_REVIEWER_RECLAIM) {
        throw new Error(`${PLUGIN_NAME}: reviewer.reclaim must be '${DEFAULT_REVIEWER_RECLAIM}' (M10 supports only after-verdict); got '${settings.reviewer.reclaim}'`);
    }
    // M1 assembly services: one dependency bag for the presets and the nineteen tools.
    const assembly = ctx;
    // Business repo path: identical in both dev modes and unchanged from M0-M3.
    // Only the dev probe canonicalizes it, because only the probe compares paths
    // against a host session cwd.
    const repoPath = settings.repoPath === '' ? defaultRepoPath() : resolve(settings.repoPath);
    const workspacePorts = workspacePortsOf(assembly.workspaceRegistry);
    // Topic notices (B mode): the host has no notice channel, so the port reports
    // `supported: false` and the ledger stays pending. The dispatcher is wired and
    // disposed with the fiber so an A2 adapter can replace only the port later.
    const noticePort = new NoopTopicNoticePort();
    const noticeDispatcher = new TopicNoticeDispatcher({
        storeFor: (repoPath) => new ProjectStore({
            repoPath,
            clock: () => new Date(),
            archiveSession: (sessionId, options) => assembly.workspaceRegistry.archiveSession(sessionId, options),
        }),
        port: noticePort,
        clock: () => new Date(),
        log: (message) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] ${message}`),
    });
    ctx.effect(() => () => noticeDispatcher.dispose(), 'dsh-cowork: notice dispatcher');
    const noticeRuntime = {
        port: noticePort,
        kick: (repoPath) => noticeDispatcher.kick(repoPath),
    };
    const coworkDeps = {
        sessionController: assembly.sessionController,
        workspaceRegistry: workspacePorts,
        agentPresets: assembly.agentPresets,
        clock: () => new Date(),
        resolveRepoPath: () => repoPath,
        // Non-fatal degradations (for example an unbound workspace) reach the host
        // log as warnings; a tool result still reports its own failure state.
        log: (message) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] ${message}`),
        // M9.1/M9.3a: the tool layer owns the lifecycle read point. The values come
        // from the normalized config, never from a second set of defaults here.
        idleAfterMs: settings.idleAfterMs,
        resolveAfterMs: settings.resolveAfterMs,
        isolationProvider: settings.isolation.provider,
        reviewerReclaim: settings.reviewer.reclaim,
        routing: settings.routing,
        // M9.3b: the only host LLM entry point. Missing services leave the third
        // layer on its structured fallback; they never fail a route.
        llmRoutingPort: createLlmRoutingPort(hostService(ctx, 'llm')),
        currentModelRoute: hostCurrentModelRoute(ctx),
        notices: noticeRuntime,
    };
    // M11 panel: four read routes and six write routes over the host connection
    // service (the request inbox adds its read, resolve, and open routes). The project root is derived from the session's own cwd, never from
    // the request.
    const panelPorts = createPanelPorts(ctx, assembly, settings, noticeRuntime);
    registerCoworkApi(ctx, panelPorts);
    // M8.2: the session event stream keeps topic activity fresh and reopens a
    // resolved topic when its owner returns. The rules live in topic-events.ts
    // behind injected ports; this effect releases the listener on unload.
    const topicEvents = new TopicEvents({
        onSessionEvent: (listener) => ctx.on('session/event', listener),
        resolveRepoPath: async (session) => {
            const cwd = session.header?.cwd;
            if (typeof cwd !== 'string' || cwd === '')
                return null;
            return findProjectRoot(cwd);
        },
        storeFor: (repoPath) => new ProjectStore({
            repoPath,
            clock: () => new Date(),
            archiveSession: (sessionId, options) => assembly.workspaceRegistry.archiveSession(sessionId, options),
        }),
        clock: () => new Date(),
        log: (message) => ctx.logger?.warn?.(`[${PLUGIN_NAME}] ${message}`),
    });
    ctx.effect(() => topicEvents.attach(), 'dsh-cowork: topic lifecycle events');
    // Transitional (KI-39): the target is registration at cowork_project_init or
    // session creation. This startup pass only repairs records already lost; it
    // must be removed when KI-39 closes. A workspace record the registry loses is
    // not rebuilt from session headers once its domain is initialized, so a
    // healthy Cowork project can vanish from the sidebar after a restart even
    // though its index and sessions are intact. Re-create only the missing
    // records for sessions that already sit at a Cowork project root, then attach
    // those sessions. The pass is bounded and every failure is logged: a failed
    // repair must never fail plugin startup.
    ctx.effect(() => {
        let active = true;
        void repairCoworkWorkspaces({
            listSessions: async () => (await assembly.sessionController.list()).items,
            resolveProjectRoot: findProjectRoot,
            resolveWorkspace: (path) => workspacePorts.resolveByPath(path),
            createWorkspace: (path) => workspacePorts.create(path),
            attachSession: (workspaceId, sessionId) => workspacePorts.attachSession(workspaceId, sessionId),
        }).then((result) => {
            if (!active)
                return;
            if (result.createdWorkspaces.length > 0 || result.attachedSessions > 0) {
                ctx.logger?.info?.(`[${PLUGIN_NAME}] workspace repair: created ${result.createdWorkspaces.length} workspace(s), attached ${result.attachedSessions} session(s)`);
            }
            for (const error of result.errors) {
                ctx.logger?.warn?.(`[${PLUGIN_NAME}] workspace repair: ${error}`);
            }
        }).catch((error) => {
            // The repair reports its own failures; this arm only guards a programming
            // error and still must not fail startup.
            ctx.logger?.warn?.(`[${PLUGIN_NAME}] workspace repair failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        return () => {
            active = false;
        };
    }, 'dsh-cowork: workspace repair');
    // Dev surfaces are opt-in: an installed profile never exposes the probe
    // routes, the probe tools, the probe presets, or the session event feeds.
    if (settings.enableDevRoutes) {
        registerDevSurfaces(ctx, {
            repoPath,
            promptTimeoutMs: settings.promptTimeoutMs,
            storeRelativePath: settings.storeRelativePath,
            worktreeRelativePath: settings.worktreeRelativePath,
            panel: createM12PanelProbe(panelPorts),
            idleAfterMs: settings.idleAfterMs,
            resolveAfterMs: settings.resolveAfterMs,
        });
    }
    // M1: the three runtime presets and the eleven cowork tools, owned by this fiber.
    ctx.effect(() => registerPresets(coworkDeps.agentPresets).then((disposers) => async () => {
        for (const dispose of disposers)
            await dispose();
    }), 'dsh-cowork: cowork presets');
    // DSH 0.2.1-rc.2 has no `hidden` preset flag. Keep topic/reviewer registered
    // for sessionController.create/resume, but remove them from the remote
    // new-session roster; only the master is a manual entry point.
    ctx.effect(() => {
        try {
            return hidePresetsFromRoster(assembly.agentPresets, HIDDEN_PRESET_IDS);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            ctx.logger?.warn?.(`[${PLUGIN_NAME}] internal preset entries stay visible: ${detail}`);
            return () => { };
        }
    }, 'dsh-cowork: hide internal presets');
    ctx.effect(() => {
        const disposers = registerCoworkTools(ctx, coworkDeps);
        return () => {
            for (const dispose of disposers)
                dispose();
        };
    }, 'dsh-cowork: cowork tools');
    // M2: project memory rides in the system prompt of every cowork agent. The
    // section is registered per agent (current and future) and released when the
    // plugin unloads, so a hot reload does not leave a stale provider behind.
    const memoryHost = {
        onAgentCreated: (listener) => {
            const events = ctx;
            return events.on('agent/created', (payload) => listener(payload));
        },
        listAgents: () => assembly.agents.list(),
    };
    const memoryDeps = {
        resolveProjectRoot: (cwd) => findProjectRootSync(cwd),
        renderMemory: (repoPath) => renderProjectMemory(repoPath),
        log: (message) => ctx.logger?.warn?.(message),
    };
    ctx.effect(() => {
        const registration = registerMemoryPrompt(memoryHost, memoryDeps);
        if (registration.duplicateSkipped() > 0) {
            ctx.logger?.warn?.(`[${PLUGIN_NAME}] ${registration.duplicateSkipped()} cowork memory section(s) already registered; skipped`);
        }
        return () => registration.dispose();
    }, 'dsh-cowork: project memory prompt');
    ctx.logger?.info?.(`[${PLUGIN_NAME}] cowork tools, presets, and panel ready`);
}
//# sourceMappingURL=index.js.map