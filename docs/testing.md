# Testing strategy

One home for how dsh-cowork decides that something is verified.

## Tiers

| Tier | Command | What it proves | When it is required |
|---|---|---|---|
| Unit | `npm test` | Edges, error paths, event order, real git/store behavior under temporary paths | Every pure module and contract change |
| Coverage | `npm run test:coverage` | Every owner-mapped unit module is at line 100; the merged report is reproducible | Every `src/**/*.ts` change |
| Layered coverage | `npm run test:coverage:layered -- --base <verified-base>` | Both lanes ran against one artifact identity; the owner map is satisfied and every non-blocked browser-owned file meets its reviewed floor | Before delivery or merge |
| Browser | `npm run test:browser` | The packed plugin boots in a temporary DSH web profile; one Chromium context drives the real sidebar and panel; DOM/ARIA/HTTP requests are asserted; client TSX line/function coverage and the expected TSX set must be present | Every `src/client/**/*.tsx`, `tests/browser/**`, or browser-lane script change; after `npm run build` |
| Built artifact | `npm run test:host-smoke` | The packed `lib/` installs into a temporary DSH profile, boots the host, serves its loopback health route, and proves the panel API rejects an unauthenticated request | Package, bundle-patch, build, or registration changes; after `npm run build` |
| Versioned E2E | `npm run test:e2e` | Keyless real-host sessions, tools, stores, and panel routes from the manifest; a local scripted endpoint replaces the provider. `npm run test:e2e:live` is the observational real-model lane | `tests/e2e/**`, `scripts/evidence/e2e.mjs`, `tools/e2e-coverage.mjs`, and every version change (the committed evidence is checked) |
| PR gate | GitHub Actions `pr-gate` | Documentation conventions on every PR; the source coverage lane additionally runs for non-docs changes | Every PR to `main` |
| Pre-merge | GitHub Actions `pre-merge` | A temporary merge of the current `main` and PR head passes the path-selected tests | Every PR before merge; rerun after `main` advances |
| Local build gate | Heavy lane | `npm run typecheck`, `npm run build`, host smoke, browser, keyless E2E, and the observational host-bash check where the DSH source/app or Chromium exists | Every affected source/client change until the local heavy runner is stable enough to be required |
| Derived gate | GitHub Actions `gate-artifact` (required) | Review, `pr-gate`, and current-main integration identity; `gate-artifact-v2` is report-only | Report mode uses legacy validation; block uses v2 plus pre-merge. |

A same-process value is not evidence for a cross-process claim: session waking, workspace attach, and worktree merge need a real DSH run; host smoke proves loading, not transactions.

## Commands

```sh
npm run check              # executable conventions
npm run check:self-test    # prove the guards can fail
npm test                   # node:test contract and behavior tests
npm run test:coverage      # deterministic per-file unit coverage gate
npm run test:coverage:layered -- --base <ref>  # unit + browser lanes, one artifact identity
npm run coverage:check     # re-check existing reports without running tests
npm run test:e2e           # pack current lib/, boot a temporary host, run the keyless E2E scenarios
npm run test:browser       # pack current lib/, boot a temporary host, drive Chromium
npm run test:host-smoke    # pack current lib/ and boot a temporary DSH profile
npx playwright install chromium  # install the browser used by test:browser
npm run typecheck          # TypeScript, when dependencies are installed
npm run build              # host build (types from a DSH source checkout, runtime from the installed app; no DSH_CHECKOUT needed)
npm run check:clean        # run the executable conventions in a copy without .dsh-cowork/ or lib/
npm run gate-artifact -- --base <verified-base>  # record HEAD, binary diff SHA-256, porcelain, and scope groups
```

`npm test` runs `tests/**/*.test.mjs`; the glob is quoted so Node expands it recursively. `test:coverage` uses the same recursive discovery from [scripts/evidence/test-coverage.mjs](../scripts/evidence/test-coverage.mjs), so a test moved into a subdirectory cannot be silently skipped on either lane.

`test:coverage` runs every test file in its own process, writes one LCOV report per process, and merges the reports by union. The aggregate `node --test` report is not used: it intermittently dropped a test file. The gate is [coverage-check.mjs](../scripts/evidence/coverage-check.mjs) and its policy data is `tools/coverage-map.json` plus `tools/coverage-debt.json`.

Every `src/**/*.ts` and `src/client/**/*.tsx` is owned by exactly one lane: `unit`, `browser`, or `dev`. Ownership is exclusive. No source file currently uses the `dev` lane; the owner map and checker still support it for an opt-in surface. `src/client/notice.tsx` is a blocked browser entry until the host exposes `ctx.sessionNotices` (KI-40). A file with only type declarations is allowed to be absent from the coverage report; a file with runtime statements that no test loads fails.

Line coverage is per file: every owner-mapped unit module must be at 100%. `tools/coverage-debt.json` is the reviewed exception list for an intentional gap; it is empty, and an entry that grows or goes stale is red. `--update-debt` is its only writer; it refuses newly uncovered lines unless `--accept-regression` is explicit. `coverage:check` rejects a report whose recorded HEAD or porcelain no longer matches. Reports live in gitignored `coverage/`.

The unit loader strips TypeScript in line-preserving mode; every `src` TypeScript file must be strip-compatible, because Node's transform-mode source-map remapping is not precise enough for a per-line gate. A transform fallback exists for future syntax but turns the coverage guard red. The mapping fixture in [tests/guards/coverage-policy.test.mjs](../tests/guards/coverage-policy.test.mjs) pins an executed line and an unexecuted line through the real loader and proves the transform fallback misattributes the latter.

`test:coverage:layered` rebuilds `lib/`, runs both lanes under one `gate-artifact` identity, and refuses a missing lane, mismatched identity, incomplete browser surface, or browser LCOV without an owned file. `tools/coverage-browser-floors.json` must cover every non-blocked browser-owned file and fails a file below its floor; missing, partial, or malformed is red. Coverage is collected in two phases around the reload, and an undeclared navigation is red. Standalone `npm run test:browser` is diagnostic; release evidence runs from a clean commit.

`lib/` is local build output and is gitignored. After changing `src/`, run `npm run build` before packaging, `test:browser`, or `test:host-smoke`; both consumers read the current local `lib/`. A stale local `lib/` is not detected by a source hash, so the build step is part of the evidence.

`test:host-smoke` uses a temporary `DSH_HOME`, npm cache, and port; it never writes the real profile and calls no model. Missing `dsh` prints a skip; `DSH_HOST_SMOKE_STRICT=1` makes it fatal.

`test:e2e` packs `lib/`, boots one temporary host, and points the real adapter at a local scripted Messages endpoint through `baseURL`. Each scenario creates a fresh fixture, uses the host Remote API for real sessions and prompts, and calls panel routes with the cookie. It needs no provider connection; temporary host/profile/fixtures are removed in `finally`, while the gitignored `.dsh-cowork/e2e/` evidence is kept. Missing `dsh` skips (`DSH_E2E_STRICT=1` fatal); an out-of-range DSH major.minor fails, and `--record` requires a tested host. `--record` writes a sanitized summary for a green run from a clean worktree; `npm run check` requires it for the current version and every keyless scenario. Docs and README changes are evidence-neutral; runtime, test, script, catalog, or packaging changes require a new recording. `--mode live` runs only with `DEEPSEEK_API_KEY`, is observational, and is never keyless evidence. `npm run test:e2e:bash` is the observational host-bash check; the heavy lane runs it.

`test:browser` packs the same artifact, creates temporary workspaces and `.dsh-cowork` fixtures, opens the real right sidebar in one Chromium context, and removes host, profile, cache, and fixture paths in `finally`. Missing `dsh` or Chromium prints a named skip; `DSH_BROWSER_STRICT=1` makes either fatal. A standalone strict run needs a clean worktree (the layered command binds the dirty tree); page errors fail the run.

## Determinism

- No fixed waits (`setTimeout`, `sleep`) for readiness. Wait on state or a bounded retry loop with a deadline. The host smoke waits for the printed URL and the server's response; the browser lane waits for selectors or responses.
- Tests allocate temporary files under `os.tmpdir()` and remove them. Package tests pass their own `npm_config_cache`; the host smoke and browser lane pass their own `DSH_HOME` and npm cache. Never write into `~/.dsh` or a real profile.
- The unit coverage collector isolates every test file and merges by set union, so the result does not depend on process order or scheduling. The guard test runs a two-file collection twice and requires identical merged LCOV.
- Line attribution is proven, not assumed: the loader is strip-only, every `src` TypeScript file is checked for strip compatibility, and a fixture with one executed and one unexecuted line must stay exact. The same fixture through a transform-only hook must misattribute the unexecuted line.
- Every guard must have a negative control: `npm run check:self-test` must show synthetic violations go red; the coverage tests feed the checker unlisted gaps, regressions, stale improvements, missing lanes, and mismatched identities, and each must fail; the browser coverage mapper includes a synthetic unexecuted line that must fail its gate.
- Structural guards carry their negative controls in the owning test: [architecture](../tests/guards/architecture.test.mjs) feeds a synthetic bad graph, [typecheck-policy](../tests/guards/typecheck-policy.test.mjs) makes the compiler reject an unused local and parameter, and [source-budget](../tests/guards/source-budget.test.mjs) computes violations from synthetic entries.

## Blocking and observational lanes

- Blocking: `npm test`, `npm run test:coverage`, `npm run typecheck`, `npm run build`, and `npm run test:host-smoke` for package/bundle changes when DSH is available. `npm run test:coverage:layered` blocks delivery and merge: a missing lane, incomplete surface, or file below its floor is red.
- Blocking for release: the keyless lane's committed evidence for the current version. Observational: `test:e2e:live`, `test:e2e:bash`, the standalone browser run, and host-specific checks; standalone runs never decide delivery, and live/host-bash results are never release evidence.

## Flake policy

A flaky test is not fixed by a longer timeout, a retry, or a weaker assertion. Find the state dependency and synchronize on it. Only a transient failure at a real external provider may be retried at that boundary.

## Evidence per change

First run `npm run change-scope -- --base <verified-base>` and record the identity with `npm run gate-artifact -- --base <verified-base>`; account for committed, staged, unstaged, and untracked paths. [docs/agent-teams.md](agent-teams.md) owns how that artifact is reused and reconciled with task scope. Then decide the owning surface from `tools/workflow.json`:

- `src/**`, `scripts/**` → `npm run test:coverage` + typecheck + build + host smoke; add `npm run test:coverage:layered -- --base <verified-base>` for delivery.
- `tools/coverage-map.json`, `tools/coverage-debt.json`, `tools/coverage-browser-floors.json` → `npm run test:coverage` + `npm run coverage:check` + `npm run test:coverage:layered -- --base <verified-base>` + `npm run check`.
- `src/client/**/*.tsx`, `tests/browser/**`, browser-lane scripts → `npm run build` + `npm run test:browser`; keep the browser page-error and mapping negative controls green; add the layered command for delivery.
- `tests/*` → `npm test` + `npm run test:coverage`, and watch the new test fail for the regression it pins.
- `tests/e2e/**`, `scripts/evidence/e2e.mjs`, `tools/e2e-coverage.mjs` → `npm run test:e2e` + `npm run check` + `npm test`; re-record the evidence whenever the keyless manifest changes.
- `package.json`, `cordis.patch.yml`, build config → `npm run check` + typecheck + `npm test` + build + host smoke.
- `tools/workflow.json`, `tools/check-invariants.mjs`, `.gitignore` → `npm run check` + `npm run check:self-test`.
- `tools/fallow-health-baseline.json` → `fallow health --baseline tools/fallow-health-baseline.json` (zero new findings) and `fallow audit --base <verified-base>` (change gate); refresh the baseline only in a dedicated maintenance PR naming the CLI version and HEAD, with each added entry reviewed.
- `AGENTS.md`, `docs/*` → `npm run check` and read the changed section as its reader.

A delivery is not verified unless the commands that ran, their three-state result, and the entries that did not run are named in the final report.
