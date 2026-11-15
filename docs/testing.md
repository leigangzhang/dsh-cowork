# Testing strategy

One home for how dsh-cowork decides that something is verified.

## Tiers

| Tier | Command | What it proves | When it is required |
|---|---|---|---|
| Unit | `npm test` | Edges, error paths, event order, real git/store behavior under temporary paths | Every pure module and contract change |
| Coverage | `npm run test:coverage` | Every counted host TypeScript module stays above the reviewed line/branch/function floors | Every `src/**/*.ts` change |
| Browser | `npm run test:browser` | The packed plugin boots in a temporary DSH web profile; one Chromium context drives the real sidebar and panel; DOM/ARIA/HTTP requests and client TSX line/function coverage are asserted | Every `src/client/**/*.tsx`, `tests/browser/**`, or browser-lane script change; after `npm run build` |
| Built artifact | `npm run test:host-smoke` | The packed `lib/` installs into a temporary DSH profile, boots the host, serves its loopback health route, and proves the panel API rejects an unauthenticated request | Package, bundle-patch, build, or registration changes; after `npm run build` |
| Real host transaction | M12 dev route, recorded under `.dsh-cowork/e2e/M12_E2E.json` | Cross-session and cross-process behavior against a real DSH host | Before a release and for every cross-session/cross-process change |

Replayable expected output is not an executable lane yet. Do not cite it as evidence until a command exists. The browser panel is executable as an observational lane; it writes `coverage/client.json` and prints the covered client files.

A unit test that only reads a same-process typed value is not evidence for a cross-process claim. `sessionController.prompt` waking an idle session, workspace attach, and worktree merge must be proven through a real DSH run, not through mocks. The built-artifact smoke is necessary but not sufficient for that class: it proves loading and routing, not model-driven transactions.

## Commands

```sh
npm run check              # executable conventions
npm run check:self-test    # prove the guards can fail
npm test                   # node:test contract and behavior tests
npm run test:coverage      # node:test coverage floors
npm run test:browser       # pack current lib/, boot a temporary host, drive Chromium
npm run test:host-smoke    # pack current lib/ and boot a temporary DSH profile
npx playwright install chromium  # install the browser used by test:browser
npm run typecheck          # TypeScript, when dependencies are installed
npm run build              # host build (types from a DSH source checkout, runtime from the installed app; no DSH_CHECKOUT needed)
npm run check:clean        # run the executable conventions in a copy without .dsh-cowork/ or lib/
npm run gate-artifact -- --base <verified-base>  # record HEAD, binary diff SHA-256, porcelain, and scope groups
```

`npm test` runs `tests/**/*.test.mjs`; the glob is quoted so Node expands it recursively. `test:coverage` uses the same recursive discovery from [scripts/evidence/test-coverage.mjs](../scripts/evidence/test-coverage.mjs), so a test moved into a subdirectory cannot be silently skipped on either lane.

`test:coverage` counts `src/**/*.ts`, excludes the dev-only probe/E2E drivers named in [scripts/evidence/test-coverage.mjs](../scripts/evidence/test-coverage.mjs), and does not count the React TSX components. `test:browser` owns the reachable TSX files and reports client `.ts` as cross-check data; the Node lane remains their coverage owner. The floors live beside the exclusions; raise them only after the report moves above the new floor.

`lib/` is local build output and is gitignored. After changing `src/`, run `npm run build` before packaging, `test:browser`, or `test:host-smoke`; both consumers read the current local `lib/`. A stale local `lib/` is not detected by a source hash, so the build step is part of the evidence.

`test:host-smoke` uses a temporary `DSH_HOME`, a temporary npm cache, and a random port; it never starts or writes the user's real profile. It is keyless and does not call a model. Missing `dsh` prints a skip; set `DSH_HOST_SMOKE_STRICT=1` when a missing host must fail the run.

`test:browser` packs the same artifact, creates temporary workspaces and `.dsh-cowork` fixtures, opens the real right sidebar in one Chromium context, and removes host, profile, cache, and fixture paths in `finally`. It never touches the user's profile or project data. Missing `dsh` or Chromium prints a named skip; `DSH_BROWSER_STRICT=1` makes either fatal. Browser page errors fail the run. `src/client/notice.tsx` is listed as blocked by the missing host `sessionNotices` capability (KI-40), not counted as covered.

## Determinism

- No fixed waits (`setTimeout`, `sleep`) for readiness. Wait on state or a bounded retry loop with a deadline. The host smoke waits for the printed URL and the server's response; the browser lane waits for selectors or responses.
- Tests allocate temporary files under `os.tmpdir()` and remove them. Package tests pass their own `npm_config_cache`; the host smoke and browser lane pass their own `DSH_HOME` and npm cache. Never write into `~/.dsh` or a real profile.
- Every guard must have a negative control: `npm run check:self-test` must show synthetic violations go red; the coverage test includes a deliberately under-covered fixture that must fail a 100% function floor; and the browser coverage mapper includes a synthetic unexecuted line that must fail its gate.
- Structural guards carry their negative controls in the owning test: [tests/guards/architecture.test.mjs](../tests/guards/architecture.test.mjs) feeds each rule a synthetic bad graph, [tests/guards/typecheck-policy.test.mjs](../tests/guards/typecheck-policy.test.mjs) makes the compiler reject an unused local and parameter, and [tests/guards/source-budget.test.mjs](../tests/guards/source-budget.test.mjs) computes byte and line violations from synthetic entries.

## Blocking and observational lanes

- Blocking: `npm test`, `npm run test:coverage`, `npm run typecheck`, `npm run build`, and `npm run test:host-smoke` for package/bundle changes when DSH is available.
- Observational: `npm run test:browser`, the M12 real-host/model chain, and platform-specific or host-version-specific checks. The browser surface stays observational until three consecutive local green runs; then set reviewed per-file line/function floors for reachable TSX and promote it to blocking.

## Flake policy

A flaky test is not fixed by a longer timeout, a retry, or a weaker assertion. Find the state dependency and synchronize on it. Only a transient failure at a real external provider may be retried at that boundary.

## Evidence per change

First run `npm run change-scope -- --base <verified-base>` and record the identity with `npm run gate-artifact -- --base <verified-base>`; account for committed, staged, unstaged, and untracked paths. [docs/agent-teams.md](agent-teams.md) owns how that artifact is reused and reconciled with task scope. Then decide the owning surface from `tools/workflow.json`:

- `src/**`, `scripts/**` → `npm run test:coverage` + typecheck + build + host smoke.
- `src/client/**/*.tsx`, `tests/browser/**`, browser-lane scripts → `npm run build` + `npm run test:browser`; keep the browser page-error and mapping negative controls green.
- `tests/*` → `npm test` + `npm run test:coverage`, and watch the new test fail for the regression it pins.
- `package.json`, `cordis.patch.yml`, build config → `npm run check` + typecheck + `npm test` + build + host smoke.
- `tools/workflow.json`, `tools/check-invariants.mjs`, `.gitignore` → `npm run check` + `npm run check:self-test`.
- `AGENTS.md`, `docs/*` → `npm run check` and read the changed section as its reader.

A delivery is not verified unless the commands that ran, their three-state result, and the entries that did not run are named in the final report.
