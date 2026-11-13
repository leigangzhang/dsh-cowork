import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { ProbeEvent } from './probe-model.js';
/** Preset id the probe registers and asks the host to compose. */
export declare const PROBE_PRESET_ID = "cowork-probe";
/** Marker the two wake turns must answer with. */
export declare const WAKE_MARKER = "COWORK_PROBE_WAKE_OK";
/** Marker written into the probe worktree. */
export declare const WORKTREE_MARKER = "COWORK_PROBE_WORKTREE_OK";
/** One session row as the probe consumes it. */
export interface SessionSummaryLike {
    readonly sessionId: string;
    readonly cwd?: string;
    readonly running: boolean;
    readonly blank: boolean;
}
/** One workspace record as the probe consumes it. */
export interface WorkspaceLike {
    readonly id: string;
    readonly path: string;
    readonly sessionIds: readonly string[];
}
/** One session header as the probe consumes it. */
export interface SessionHeaderLike {
    readonly id: string;
    readonly cwd?: string;
    readonly agentPreset?: string;
}
/** One preset roster row as the probe consumes it. */
export interface PresetRowLike {
    readonly id: string;
    readonly broken?: unknown;
}
/** The host services the probe calls. */
export interface ProbeHost {
    readonly sessionController: {
        create(request: {
            workspaceId?: string;
            cwd?: string;
            agentPreset?: string;
        }): Promise<{
            sessionId: string;
            agentPreset?: string;
        }>;
        list(request?: unknown, signal?: AbortSignal): Promise<{
            items: readonly SessionSummaryLike[];
        }>;
        prompt(request: {
            requestId: string;
            sessionId: string;
            mode: 'queue' | 'steer';
            content: ReadonlyArray<{
                type: 'text';
                text: string;
            }>;
        }, signal?: AbortSignal): Promise<{
            accepted: boolean;
        }>;
        inspect(sessionId: string, signal?: AbortSignal): Promise<{
            meta: SessionHeaderLike;
        }>;
    };
    readonly workspaceRegistry: {
        get(id: string): WorkspaceLike | undefined;
        list(): readonly WorkspaceLike[];
        resolveByPath(path: string): Promise<WorkspaceLike | undefined>;
    };
    readonly agentPresets: {
        list(): Promise<readonly PresetRowLike[]>;
        register(definition: {
            id: string;
            name?: string;
            description?: string;
            plugins: readonly unknown[];
        }): Promise<() => Promise<void>>;
    };
    readonly webServer: {
        register(route: WebRoute): () => void;
    };
    on(name: 'session/event', listener: (session: {
        id: string;
    }, event: ProbeEvent) => void): () => void;
}
/** Probe knobs carried by the plugin Config. */
export interface ProbeConfig {
    readonly repoPath: string;
    readonly promptTimeoutMs: number;
    readonly storeRelativePath: string;
    readonly worktreeRelativePath: string;
}
/** Runtime phase status. */
export type PhaseStatus = 'pending' | 'running' | 'passed' | 'failed';
/** One phase view returned by the status route. */
export interface PhaseView {
    readonly id: string;
    readonly status: PhaseStatus;
    readonly startedAt?: number;
    readonly endedAt?: number;
    readonly evidence?: Record<string, unknown>;
    readonly error?: string;
}
/** One run view returned by the status route. */
export interface RunView {
    readonly runId: string;
    readonly state: 'running' | 'done' | 'failed';
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly phases: readonly PhaseView[];
    readonly sessionIds: readonly string[];
    readonly error?: string;
}
/** Health payload returned by the health route and the probe tool. */
export interface HealthView {
    readonly ok: true;
    readonly plugin: string;
    readonly preset: string | null;
    readonly host: string;
    readonly version: string;
    readonly repoPath: string;
    readonly workspaceId: string | null;
    readonly lastRunId: string | null;
    readonly buildTag: string;
}
/** Run one bounded phase and record its evidence. */
export declare class ProbeRunner {
    private readonly host;
    private readonly config;
    private readonly pluginName;
    private readonly pluginVersion;
    private readonly runs;
    private readonly events;
    private readonly trackedSessions;
    private readonly waiters;
    private workspaceId;
    private presetRegistered;
    private lastRunId;
    private disposed;
    constructor(host: ProbeHost, config: ProbeConfig, pluginName: string, pluginVersion: string);
    /** Mark the runtime preset registration as complete (drives health). */
    markPresetRegistered(): void;
    /** Subscribe to the host's session event feed; returns the disposer. */
    attachEvents(): () => void;
    /** Start one run and return its initial view. */
    start(): RunView;
    /** Read one run view, or undefined when unknown. */
    status(runId: string): RunView | undefined;
    /**
     * Resolve a run by id, falling back to the last run persisted on disk. A
     * host rebuild reloads this module and empties the in-memory table, so the
     * status route must still answer for the last cited run id.
     */
    resolve(runId: string): Promise<RunView | undefined>;
    /** Read the last run view. */
    lastRun(): RunView | undefined;
    /** Read the health payload. */
    health(): HealthView;
    /** Reject pending waits so a disposed plugin cannot hang a run forever. */
    dispose(): void;
    private observe;
    private waitForTurn;
    private track;
    private releaseSessions;
    private promptRound;
    private requireWorkspaceId;
    private waitUntil;
    private execute;
    private runPhase;
    /** Risk 3: the runtime preset registration and per-session composition. */
    private phasePreset;
    /** Risk 1: two queued prompts on one idle session each finish a full turn. */
    private phaseWake;
    /** Risk 2: the session row and the workspace session list carry the session. */
    private phaseVisibility;
    /** Atomic store written by the plugin, read back by a second session. */
    private phaseStore;
    /** Risk 4: a worktree-backed session reads the marker and writes a file. */
    private phaseWorktree;
    /** Risk 5 facts: patchReload is not a runtime switch; hot load comes from injection/HMR. */
    private phasePatchReload;
    private git;
    /**
     * Persist each run twice: `last-run.json` for the newest run and
     * `runs/<runId>.json` so a cited run stays addressable after a reload.
     */
    private persistRun;
    private trimRuns;
    private view;
}
