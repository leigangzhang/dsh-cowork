import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { panelRoutePathname } from './panel-probe.js';
export { panelRoutePathname };
/** The third routing layer's knobs (PLAN-V0.2 §5.10, M9.1). */
export interface RoutingConfig {
    /** Whether the model fallback may run at all. */
    enabled: boolean;
    /** Model provider id; empty means "unset". */
    provider: string;
    /** Model id; empty means "unset". */
    model: string;
    /** Reasoning effort; empty means "unset". */
    effort: string;
    /** Model-call timeout in milliseconds. */
    timeoutMs: number;
    /** Model output cap in tokens. */
    maxTokens: number;
}
/** Work-item isolation settings (PLAN-V0.2 §4.5); M10 implements `clone`. */
export interface IsolationConfig {
    /** Provider that creates an isolated work item; unknown values fail the tool. */
    provider: string;
}
/** Reviewer lifecycle settings (PLAN-V0.2 §5.4); M10 supports one value. */
export interface ReviewerConfig {
    /** When the reviewer session is reclaimed after a verdict. */
    reclaim: string;
}
/** Plugin configuration; every field has a working default. */
export interface Config {
    /** Repository the probe writes under; defaults to this plugin's package root. */
    repoPath: string;
    /** Upper bound for one prompt's turn and for any bounded wait; M0 pins 120s. */
    promptTimeoutMs: number;
    /** Probe store path, relative to `repoPath`. */
    storeRelativePath: string;
    /** Probe worktree path, relative to `repoPath`. */
    worktreeRelativePath: string;
    /**
     * Register the M0/S0/M2/M3 probe and E2E surfaces. Off by default: an
     * installed profile keeps only the business tools, presets, and panel API.
     */
    enableDevRoutes: boolean;
    /** Silence after which a topic displays as idle (24h). */
    idleAfterMs: number;
    /**
     * Deprecated and ignored: the lifecycle never resolves a topic on its own any
     * more (archiving is a user action). Kept so an existing profile still loads.
     */
    resolveAfterMs: number;
    /** Third-layer model fallback (PLAN §5.10). */
    routing: RoutingConfig;
    /** Isolation used for work items (PLAN §4.5). */
    isolation: IsolationConfig;
    /** Reviewer lifecycle (PLAN §5.4). */
    reviewer: ReviewerConfig;
}
export declare const Config: z<Config>;
/**
 * Fill every omitted configuration field with its documented default.
 *
 * The host feeds `apply` a schema-validated `Config`, but tests and future
 * embedders construct one by hand; routing must not crash because one nested
 * object is missing. This is the single place that knows the defaults, and
 * `apply` uses only its result.
 */
export declare function normalizeConfig(config: Partial<Config> & {
    routing?: Partial<RoutingConfig> | null;
    isolation?: Partial<IsolationConfig> | null;
    reviewer?: Partial<ReviewerConfig> | null;
}): Config;
/** Host services this plugin cannot activate without. */
export declare const inject: string[];
/** How long the host desktop opener may take before the call is aborted. */
export declare const OPEN_WORKSPACE_PATH_TIMEOUT_MS = 10000;
/**
 * The host session controller's desktop file-browser method (stage-0 probe 2).
 * Structural because the plugin cannot import the app's own session types; a
 * host without it answers `inbox/open-unsupported` at the open route.
 *
 * The installed host (DSH 0.2.1-rc.2) reads `signal.throwIfAborted()` before
 * touching the filesystem, so the second argument is mandatory at this
 * boundary: calling it with only the request object threw
 * "Cannot read properties of undefined (reading 'aborted')" and every real
 * "查看全文" turned into `inbox/open-unsupported` (t13 F-GUI-1).
 */
export interface HostSessionOpener {
    openWorkspacePath?(request: {
        path: string;
        action?: 'reveal';
    }, signal: AbortSignal): Promise<unknown>;
}
/**
 * Build the panel's `openWorkspacePath` port from one host session controller.
 *
 * The route passes an absolute path inside the repository; this adapter binds
 * the host's two-argument contract and a bounded timeout signal. A host
 * without the method, or a host that rejects the native open, throws and the
 * open route maps that onto `inbox/open-unsupported` — never a faked success.
 */
export declare function createOpenWorkspacePathPort(opener: HostSessionOpener | undefined, timeoutMs?: number): (path: string) => Promise<void>;
/** Register the business surface, plus the opt-in dev probe surface when enabled. */
export declare function apply(ctx: Context, config: Config): void;
