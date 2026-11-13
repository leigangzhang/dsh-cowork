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
export const COWORK_MEMORY_SECTION = 'cowork:memory';
/** Sorted late: project memory is context, not an override of the base prompt. */
export const COWORK_MEMORY_ORDER = 900;
/**
 * Only cowork business agents get project memory; other presets must stay
 * untouched. `cowork-master` and `cowork-topic` are the current presets. The
 * reviewer is deliberately absent: it judges evidence and must not inherit the
 * project's own memory framing.
 */
export const COWORK_MEMORY_PRESETS = ['cowork-master', 'cowork-topic'];
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
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
export function registerMemoryPrompt(host, deps) {
    const registeredIds = [];
    const sectionDisposers = [];
    /** Agents we already attempted, so a repeated event cannot register twice. */
    const attempted = new Set();
    /**
     * Agent ids whose registration threw. A set, not a counter: the host can
     * replay the same agent (list + create event, restore after hot reload), and
     * `duplicateSkipped()` must report the number of *agents* that collided, not
     * the number of failed attempts.
     */
    const duplicateAgents = new Set();
    let disposed = false;
    let unsubscribe = null;
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        if (unsubscribe !== null) {
            const off = unsubscribe;
            unsubscribe = null;
            off();
        }
        // Explicit release: a section disposer left uncalled survives the plugin
        // unload and keeps the old provider alive inside a live agent.
        for (const releaseSection of sectionDisposers.splice(0)) {
            try {
                releaseSection();
            }
            catch (error) {
                deps.log?.(`cowork: memory section disposer failed: ${describeError(error)}`);
            }
        }
        registeredIds.length = 0;
        attempted.clear();
        duplicateAgents.clear();
    };
    const tryRegister = (agent) => {
        if (disposed || agent === undefined || agent === null)
            return;
        if (typeof agent.id !== 'string' || agent.id.length === 0)
            return;
        if (attempted.has(agent.id))
            return;
        const header = agent.session?.header;
        const preset = header?.agentPreset;
        if (typeof preset !== 'string' || !COWORK_MEMORY_PRESETS.includes(preset))
            return;
        const cwd = header?.cwd;
        if (typeof cwd !== 'string' || cwd.trim().length === 0)
            return;
        let repoPath;
        try {
            repoPath = deps.resolveProjectRoot(cwd);
        }
        catch (error) {
            deps.log?.(`cowork: project lookup failed for agent ${agent.id}: ${describeError(error)}`);
            return;
        }
        if (repoPath === null)
            return;
        const projectRoot = repoPath;
        // Cache is per agent: two agents on different projects must never share a
        // rendered block, and one agent's digest must not mask another's change.
        let cachedDigest = null;
        let cachedText = '';
        const provider = (_context) => {
            if (disposed)
                return '';
            const render = deps.renderMemory(projectRoot);
            if (render === null) {
                // No memory block right now (project index gone, memory file
                // unreadable, or every entry filtered out). Drop the cache: keeping it
                // would let a later render whose digest happens to equal the stale one
                // return the old text after the memory had already disappeared.
                cachedDigest = null;
                cachedText = '';
                return '';
            }
            if (cachedDigest === render.digest)
                return cachedText;
            cachedDigest = render.digest;
            cachedText = render.text;
            return cachedText;
        };
        attempted.add(agent.id);
        try {
            const releaseSection = agent.ctx.systemPrompt.section({
                name: COWORK_MEMORY_SECTION,
                order: COWORK_MEMORY_ORDER,
                interpolate: false,
                text: provider,
            });
            if (typeof releaseSection !== 'function') {
                throw new Error(`${COWORK_MEMORY_SECTION}: section() returned no disposer`);
            }
            sectionDisposers.push(releaseSection);
            registeredIds.push(agent.id);
        }
        catch (error) {
            duplicateAgents.add(agent.id);
            deps.log?.(`cowork: memory section registration failed for agent ${agent.id}: ${describeError(error)}`);
        }
    };
    unsubscribe = host.onAgentCreated((payload) => {
        tryRegister(payload?.agent);
    });
    // Hot reload / late plugin mount: agents may already exist before we attach.
    for (const agent of host.listAgents())
        tryRegister(agent);
    return {
        dispose,
        registered: () => registeredIds.slice(),
        duplicateSkipped: () => duplicateAgents.size,
    };
}
//# sourceMappingURL=memory-prompt.js.map