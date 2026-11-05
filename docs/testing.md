# Testing strategy

One home for how dsh-cowork decides that something is verified.

## Tiers

| Tier | What it proves | When it is required |
|---|---|---|
| Unit | Edges, error paths, event order | Every pure module: `store`, `router`, `handoff` |
| Real entry | Real composition or a real artifact, asserting external state | M0 probe and every cross-session / cross-process change |
| Replayable expectation | Visible output replayed and compared | `cowork_*` tool JSON, handoff files, route decisions |
| Coverage | Every line has an owner | Only after the module has a stable consumer |

A unit test that only reads a same-process typed value is not evidence for a cross-process claim. `sessionController.prompt` waking an idle session, workspace attach, and worktree merge must be proven through a real DSH run, not through mocks.

## Commands

```sh
npm run check              # executable conventions
npm run check:self-test    # prove the guards can fail
npm test                   # node:test contract tests for this repository's rules
npm run typecheck          # TypeScript, when dependencies are installed
npm run build              # host build (types from a DSH source checkout, runtime from the installed app; no DSH_CHECKOUT needed)
```

`npm run build` builds the host half only: the client half is removed for M0 and returns in M3. The script probes a DSH source checkout for types and the installed DSH app for runtime links, so callers do not set `DSH_CHECKOUT`.

## Determinism

- No fixed waits (`setTimeout`, `sleep`) in tests. Wait on state or a bounded retry loop with a deadline.
- Every guard must have a negative control: `npm run check:self-test` must show synthetic violations go red.
- Tests allocate temporary files under `os.tmpdir()` and remove them; never write into `~/.dsh` or a real profile.

## Blocking and observational lanes

- Blocking: everything needed to land M0 and M1.
- Observational: platform-specific or host-version-specific checks that can be unstable. Mark them with `[observational]`, keep them reporting, and state how many consecutive green runs promote them back to blocking.

## Flake policy

A flaky test is not fixed by a longer timeout, a retry, or a weaker assertion. Find the state dependency and synchronize on it. Only a transient failure at a real external provider may be retried at that boundary.

## Evidence per change

Decide the owning surface from `tools/workflow.json`:

- `src/*`, `presets/*`, `scripts/*` → typecheck + build.
- `tests/*` → `npm test`, and watch the new test fail for the regression it pins.
- `tools/workflow.json`, `tools/check-invariants.mjs`, `.gitignore` → `npm run check:self-test`.
- `AGENTS.md`, `docs/*` → `npm run check` and read the changed section as its reader.

A delivery is not verified unless the commands that ran, their three-state result, and the entries that did not run are named in the final report.
