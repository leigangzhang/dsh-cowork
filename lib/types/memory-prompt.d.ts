/**
 * Per-agent system-prompt section that injects the project memory block.
 *
 * The module owns no host or filesystem code: `registerMemoryPrompt` takes
 * structural ports (`MemoryPromptHost` / `MemoryPromptDeps`), so filtering,
 * caching and lifecycle stay unit-testable without a running DSH host. The
 * plugin wires the real agent registry and project store in src/index.ts.
 *
 * Why `text` is a function: DSH re-evaluates it on every prompt assembly, which
 * is what makes memory written *after* the agent was created show up without
 * re-registering the section. The digest cache keeps the produced text stable
 * (and the assembly byte-identical) while the rendered memory has not changed.
 */
/** Section id shared by every cowork agent preset; one section per agent. */
export declare const COWORK_MEMORY_SECTION = "cowork:memory";
/** Sorted late: project memory is context, not an override of the base prompt. */
export declare const COWORK_MEMORY_ORDER = 900;
/**
 * Only cowork business agents get project memory; other presets must stay
 * untouched. `cowork-master` and `cowork-topic` are the current presets. The
 * reviewer is deliberately absent: it judges evidence and must not inherit the
 * project's own memory framing.
 */
export declare const COWORK_MEMORY_PRESETS: readonly string[];
/** Structural mirror of the host's system-prompt section descriptor. */
export interface MemoryPromptSectionInput {
    name: string;
    order: number;
    text: string | ((context: unknown) => string);
    interpolate?: boolean;
}
/**
 * The slice of a DSH agent this module needs. `id` is the identity used for
 * dedupe; `ctx.systemPrompt.section` registers into that agent's scope only,
 * so the section never leaks into another agent's assembly.
 */
export interface MemoryPromptAgent {
    readonly id: string;
    readonly session: {
        readonly header: {
            readonly cwd?: string;
            readonly agentPreset?: string;
        };
    };
    readonly ctx: {
        readonly systemPrompt: {
            section(section: MemoryPromptSectionInput): () => void;
        };
    };
}
/** Agent registry port. The disposer returned by `onAgentCreated` is tracked. */
export interface MemoryPromptHost {
    onAgentCreated(listener: (payload: {
        agent: MemoryPromptAgent;
        source?: string;
    }) => void): () => void;
    listAgents(): readonly MemoryPromptAgent[];
}
/** One rendered memory block plus the digest that identifies its content. */
export interface MemoryRender {
    text: string;
    digest: string;
}
/**
 * Injected IO. `resolveProjectRoot` decides whether a cwd belongs to an
 * initialized cowork project; `null` means "not ours, do not inject".
 */
export interface MemoryPromptDeps {
    resolveProjectRoot(cwd: string): string | null;
    renderMemory(repoPath: string): MemoryRender | null;
    log?(message: string): void;
}
/** Handle returned by `registerMemoryPrompt`; every getter is a copy. */
export interface MemoryPromptRegistration {
    dispose(): void;
    registered(): readonly string[];
    /** Number of distinct agents whose registration was rejected; never per event. */
    duplicateSkipped(): number;
}
/**
 * Register the memory section for every current and future cowork agent.
 *
 * Order matters: the listener is attached before `listAgents()` is drained, so
 * an agent created between the two calls cannot be missed.
 *
 * Failures are contained per agent: a section name collision (for example a
 * second plugin instance, or a hot reload that left the old section in place)
 * is counted, logged, and does not stop the remaining agents.
 */
export declare function registerMemoryPrompt(host: MemoryPromptHost, deps: MemoryPromptDeps): MemoryPromptRegistration;
