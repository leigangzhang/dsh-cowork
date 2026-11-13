/**
 * The three runtime presets this plugin owns: `cowork-master`, `cowork-topic`,
 * and `cowork-reviewer`.
 *
 * Each preset is an explicit list of plugin rows, because S0 proved an empty
 * `plugins` list mounts no tools at all (docs/handoff/M1_S0_RESULT.md §1): the
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
export declare const MASTER_PRESET_ID = "cowork-master";
/** Preset id of a topic session: one topic, one or more work items. */
export declare const TOPIC_PRESET_ID = "cowork-topic";
/**
 * Preset id of the read-only reviewer session. M10.1 moved the definition here
 * from `src/review.ts` (deleted in M10.3); `src/review.ts` still re-exports a
 * type-pinned shadow for the legacy review-tool tests.
 */
export declare const REVIEWER_PRESET_ID = "cowork-reviewer";
/**
 * The master routes intents to topics, records decisions, and hands work to
 * the review gate. The handoff and merge rules are explicit because a master
 * woken by a handoff otherwise tends to investigate the host instead of
 * finishing the review loop. M10 rewrites the flow wording; M9 only removes the
 * rows it no longer needs.
 */
export declare const MASTER_PERSONA: string;
/**
 * One topic session may own several work items, but only this topic; it asks
 * for review itself and must leave a summary plus the evidence it ran.
 */
export declare const TOPIC_PERSONA: string;
/**
 * A reviewer reads evidence and votes; it never touches the implementation.
 * The preset has no `tool-fs`, so bash (and search) are the only way to read
 * files — that is the physical half of the read-only rule. The scope sentence
 * keeps the reviewer inside the requested review instead of renegotiating the
 * change.
 */
export declare const REVIEWER_PERSONA: string;
/** One plugin row of a preset: a stable id plus the package that provides it. */
export interface PresetRow {
    id: string;
    name: string;
    config?: Record<string, unknown>;
    disabled?: boolean;
}
/** One preset definition as the host registry accepts it. */
export interface PresetDefinition {
    id: string;
    name: string;
    description: string;
    plugins: readonly PresetRow[];
}
/** The slice of the agent-preset registry this module needs. */
export interface PresetRegistryPort {
    register(definition: {
        id: string;
        name?: string;
        description?: string;
        plugins: readonly unknown[];
    }): Promise<() => Promise<void>>;
}
/**
 * All preset definitions in registration order: master, topic, reviewer.
 * Fresh row arrays on every call.
 */
export declare function presetDefinitions(): readonly PresetDefinition[];
/**
 * Register every preset and return their disposers. If a later registration
 * fails, the earlier ones are disposed before the error propagates, so a failed
 * startup never leaves a partial preset set behind.
 */
export declare function registerPresets(registry: PresetRegistryPort): Promise<Array<() => Promise<void>>>;
