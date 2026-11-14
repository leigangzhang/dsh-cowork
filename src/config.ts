/**
 * Plugin configuration: the schema, the one defaults table, and the normalizer.
 *
 * {@link CONFIG_DEFAULTS} is the only place a default value is written. The
 * schemastery schema and {@link normalizeConfig} both read it, so a changed
 * default cannot leave the schema and a hand-built partial config disagreeing.
 * `apply` consumes only the normalized view.
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_ISOLATION_PROVIDER, DEFAULT_REVIEWER_RECLAIM } from './tool-runtime.js'
import { DEFAULT_IDLE_AFTER_MS, DEFAULT_RESOLVE_AFTER_MS } from './topic.js'

/** The third routing layer's knobs (PLAN-V0.2 §5.10, M9.1). */
export interface RoutingConfig {
  /** Whether the model fallback may run at all. */
  enabled: boolean
  /** Model provider id; empty means "unset". */
  provider: string
  /** Model id; empty means "unset". */
  model: string
  /** Reasoning effort; empty means "unset". */
  effort: string
  /** Model-call timeout in milliseconds. */
  timeoutMs: number
  /** Model output cap in tokens. */
  maxTokens: number
}

/** Work-item isolation settings (PLAN-V0.2 §4.5); M10 implements `clone`. */
export interface IsolationConfig {
  /** Provider that creates an isolated work item; unknown values fail the tool. */
  provider: string
}

/** Reviewer lifecycle settings (PLAN-V0.2 §5.4); M10 supports one value. */
export interface ReviewerConfig {
  /** When the reviewer session is reclaimed after a verdict. */
  reclaim: string
}

/** Plugin configuration; every field has a working default. */
export interface Config {
  /** Repository the plugin writes under; defaults to this plugin's package root. */
  repoPath: string
  /** Upper bound for one prompt's turn and for any bounded wait. */
  promptTimeoutMs: number
  /**
   * Retained for profile compatibility: M0's probe store is retired, so no
   * current surface reads this key. The schema still accepts it.
   */
  storeRelativePath: string
  /**
   * Retained for profile compatibility: M0's probe worktree is retired, so no
   * current surface reads this key. The schema still accepts it.
   */
  worktreeRelativePath: string
  /**
   * Register the M12 E2E run/status routes and the loopback health route. Off
   * by default: an installed profile keeps only the business tools, presets,
   * and panel API.
   */
  enableDevRoutes: boolean
  /** Silence after which a topic displays as idle (24h). */
  idleAfterMs: number
  /**
   * Deprecated and ignored: the lifecycle never resolves a topic on its own any
   * more (archiving is a user action). Kept so an existing profile still loads.
   */
  resolveAfterMs: number
  /** Third-layer model fallback (PLAN §5.10). */
  routing: RoutingConfig
  /** Isolation used for work items (PLAN §4.5). */
  isolation: IsolationConfig
  /** Reviewer lifecycle (PLAN §5.4). */
  reviewer: ReviewerConfig
}

/**
 * Every omitted configuration field's default.
 *
 * Frozen at each level: the schema and the normalizer read these same objects,
 * so an accidental write would otherwise become a later call's default.
 */
export const CONFIG_DEFAULTS: Readonly<Config> = Object.freeze({
  repoPath: '',
  promptTimeoutMs: 120_000,
  storeRelativePath: '.dsh-cowork/probe/store.json',
  worktreeRelativePath: '.dsh-cowork/worktrees/probe',
  enableDevRoutes: false,
  idleAfterMs: DEFAULT_IDLE_AFTER_MS,
  resolveAfterMs: DEFAULT_RESOLVE_AFTER_MS,
  routing: Object.freeze({
    enabled: true,
    provider: '',
    model: '',
    effort: '',
    timeoutMs: 2_000,
    maxTokens: 256,
  }),
  isolation: Object.freeze({ provider: DEFAULT_ISOLATION_PROVIDER }),
  reviewer: Object.freeze({ reclaim: DEFAULT_REVIEWER_RECLAIM }),
})

const defaults = CONFIG_DEFAULTS

/** The validated plugin configuration, derived from {@link CONFIG_DEFAULTS}. */
export const Config: z<Config> = z.object({
  repoPath: z.string().default(defaults.repoPath),
  promptTimeoutMs: z.number().min(30_000).max(600_000).default(defaults.promptTimeoutMs),
  storeRelativePath: z.string().default(defaults.storeRelativePath),
  worktreeRelativePath: z.string().default(defaults.worktreeRelativePath),
  enableDevRoutes: z.boolean().default(defaults.enableDevRoutes),
  idleAfterMs: z.number().min(0).default(defaults.idleAfterMs),
  resolveAfterMs: z.number().min(0).default(defaults.resolveAfterMs),
  routing: z.object({
    enabled: z.boolean().default(defaults.routing.enabled),
    provider: z.string().default(defaults.routing.provider),
    model: z.string().default(defaults.routing.model),
    effort: z.string().default(defaults.routing.effort),
    timeoutMs: z.number().min(1).default(defaults.routing.timeoutMs),
    maxTokens: z.number().min(1).default(defaults.routing.maxTokens),
  }),
  isolation: z.object({
    provider: z.string().default(defaults.isolation.provider),
  }),
  reviewer: z.object({
    reclaim: z.string().default(defaults.reviewer.reclaim),
  }),
})

/**
 * Fill every omitted configuration field from {@link CONFIG_DEFAULTS}.
 *
 * The host feeds `apply` a schema-validated `Config`, but tests and future
 * embedders construct one by hand; routing must not crash because one nested
 * object is missing. Every fallback is read from the same table the schema uses.
 */
export function normalizeConfig(
  config: Partial<Config> & {
    routing?: Partial<RoutingConfig> | null
    isolation?: Partial<IsolationConfig> | null
    reviewer?: Partial<ReviewerConfig> | null
  },
): Config {
  return {
    repoPath: config.repoPath ?? defaults.repoPath,
    promptTimeoutMs: config.promptTimeoutMs ?? defaults.promptTimeoutMs,
    storeRelativePath: config.storeRelativePath ?? defaults.storeRelativePath,
    worktreeRelativePath: config.worktreeRelativePath ?? defaults.worktreeRelativePath,
    enableDevRoutes: config.enableDevRoutes ?? defaults.enableDevRoutes,
    idleAfterMs: config.idleAfterMs ?? defaults.idleAfterMs,
    resolveAfterMs: config.resolveAfterMs ?? defaults.resolveAfterMs,
    routing: {
      enabled: config.routing?.enabled ?? defaults.routing.enabled,
      provider: config.routing?.provider ?? defaults.routing.provider,
      model: config.routing?.model ?? defaults.routing.model,
      effort: config.routing?.effort ?? defaults.routing.effort,
      timeoutMs: config.routing?.timeoutMs ?? defaults.routing.timeoutMs,
      maxTokens: config.routing?.maxTokens ?? defaults.routing.maxTokens,
    },
    isolation: {
      provider: config.isolation?.provider ?? defaults.isolation.provider,
    },
    reviewer: {
      reclaim: config.reviewer?.reclaim ?? defaults.reviewer.reclaim,
    },
  }
}
