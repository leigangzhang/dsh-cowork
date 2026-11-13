/** Preset registered by the plugin's apply() with an empty `plugins` list. */
export declare const EMPTY_PRESET_ID = "cowork-probe";
/** Preset registered with explicit tool rows, to prove a thread preset can carry tools. */
export declare const THREAD_SMOKE_PRESET_ID = "cowork-thread-s0";
/** One session event as the S0 probe consumes it. */
export interface S0Event {
    readonly type: string;
    readonly seq: number;
    readonly time: number;
    readonly data: Record<string, unknown>;
}
/** One tool call observed in a session event stream. */
export interface S0ToolCall {
    readonly seq: number;
    readonly name: string;
    readonly arguments: string;
}
/** Folded view of one completed turn. */
export interface S0Turn {
    readonly turn: number | undefined;
    readonly startSeq: number | undefined;
    readonly endSeq: number | undefined;
    readonly reason: string | undefined;
    readonly text: string;
    readonly toolCalls: readonly S0ToolCall[];
}
/** Identity reported by the temporary `cowork_identity_probe` tool. */
export interface S0Identity {
    readonly token: string;
    readonly agentId: string | null;
    readonly cwd: string | null;
    readonly agentPreset: string | null;
    readonly execKeys: readonly string[];
    readonly hasAgent: boolean;
}
/** One workspace record as the probe consumes it. */
interface WorkspaceLike {
    readonly id: string;
    readonly path: string;
    readonly sessionIds: readonly string[];
}
/** One session row as the probe consumes it. */
interface SessionRowLike {
    readonly sessionId: string;
    readonly cwd?: string;
    readonly running: boolean;
    readonly blank: boolean;
}
/** One session header as the probe consumes it. */
interface SessionHeaderLike {
    readonly id: string;
    readonly cwd?: string;
    readonly agentPreset?: string;
}
/** One preset roster row as the probe consumes it. */
interface PresetRowLike {
    readonly id: string;
    readonly broken?: unknown;
    readonly [key: string]: unknown;
}
/** The host services S0 needs. */
export interface S0Host {
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
            items: readonly SessionRowLike[];
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
        resolveByPath(path: string): Promise<WorkspaceLike | undefined>;
    };
    readonly agentPresets: {
        list(): Promise<readonly PresetRowLike[]>;
        resolve(id?: string): Promise<Record<string, unknown>>;
        readDocument?(agentPreset: string): Promise<Record<string, unknown>>;
        compositionInventory?(): Promise<readonly Record<string, unknown>[]>;
    };
    on(name: 'session/event', listener: (session: {
        id: string;
    }, event: S0Event) => void): () => void;
}
/** S0 knobs carried by the plugin Config. */
export interface S0Config {
    readonly repoPath: string;
    readonly promptTimeoutMs: number;
}
/** Runtime phase status. */
export type S0PhaseStatus = 'pending' | 'running' | 'passed' | 'failed';
/** One phase view returned by the status route. */
export interface S0PhaseView {
    readonly id: string;
    readonly status: S0PhaseStatus;
    readonly startedAt?: number;
    readonly endedAt?: number;
    readonly evidence?: Record<string, unknown>;
    readonly error?: string;
}
/** One run view returned by the status route. */
export interface S0RunView {
    readonly runId: string;
    readonly state: 'running' | 'done' | 'failed';
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly phases: readonly S0PhaseView[];
    readonly sessionIds: readonly string[];
    readonly error?: string;
}
/** The temporary S0 runner: bounded phases, raw evidence, no product state. */
export declare class S0Runner {
    private readonly host;
    private readonly config;
    private readonly runs;
    private readonly events;
    private readonly trackedSessions;
    private readonly waiters;
    private readonly identities;
    private lastRunId;
    private disposed;
    constructor(host: S0Host, config: S0Config);
    /** Subscribe to the host's session event feed; returns the disposer. */
    attachEvents(): () => void;
    /** Record one tool-executed identity; called by the temporary identity tool. */
    recordIdentity(identity: S0Identity): void;
    /** Start one S0 run and return its initial view. */
    start(): S0RunView;
    /** Read one run view, or undefined when unknown. */
    status(runId: string): S0RunView | undefined;
    /** Read one run from memory or from disk after a host reload. */
    resolve(runId: string): Promise<S0RunView | undefined>;
    /** Reject pending waits so dispose cannot hang a run. */
    dispose(): void;
    private execute;
    private runPhase;
    /** Q2: what the preset registry exposes for `standard`, and in which shape. */
    private phasePresetSurface;
    /** Q1(a): an empty `plugins` preset runs one turn; Q1(b): the tools it can see. */
    private phaseEmptyTurn;
    /** Explicit preset rows (persona + bash + fs + fs-search) can carry tools into a session. */
    private phasePresetCompose;
    /** Q3: `exec.agent` from a standard-preset session and from the empty preset. */
    private phaseIdentity;
    private identityRound;
    private requireWorkspaceId;
    private findSessionRow;
    private track;
    private waitForTurn;
    private promptRound;
    private persistRun;
    private view;
}
export {};
