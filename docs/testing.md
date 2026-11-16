# Testing strategy

One home for how dsh-cowork decides that something is verified.

## Tiers

| Tier | Command | What it proves | When it is required |
|---|---|---|---|
| Unit | `npm test` | Edges, error paths, event order, real git/store behavior under temporary paths | Every pure module and contract change |
| Coverage | `npm run test:coverage` | Every owner-mapped unit module is at line 100 or exactly on the reviewed baseline; the merged report is reproducible | Every `src/**/*.ts` change |
| Layered coverage | `npm run test:coverage:layered -- --base <verified-base>` | Both coverage lanes ran against one artifact identity and the owner map is satisfied; browser floors apply when a reviewed floors file exists | Before delivery or merge |
| Browser | `npm run test:browser` | The packed plugin boots in a temporary DSH web profile; one Chromium context drives the real sidebar and panel; DOM/ARIA/HTTP requests are asserted; client TSX line/function coverage is reported and the expected TSX set must be present | Every `src/client/**/*.tsx`, `tests/browser/**`, or browser-lane script change; after `npm run build` |
| Built artifact | `npm run test:host-smoke` | The packed `lib/` installs into a temporary DSH profile, boots the host, serves its loopback health route, and proves the panel API rejects an unauthenticated request | Package, bundle-patch, build, or registration changes; after `npm run build` |
| Real host transaction | M12 dev route, recorded under `.dsh-cowork/e2e/M12_E2E.json` | Cross-session and cross-process behavior against a real DSH host | Before a release and for every cross-session/cross-process change |

Replayable expected output is not an executable lane yet. Do not cite it as evidence until a command exists. The browser panel is executable as an observational lane; it writes `coverage/client.json`, `coverage/browser.lcov`, and prints the covered client files.

A unit test that only reads a same-process typed value is not evidence for a cross-process claim. `sessionController.prompt` waking an idle session, workspace attach, and worktree merge must be proven through a real DSH run, not through mocks. The built-artifact smoke is necessary but not sufficient for that class: it proves loading and routing, not model-driven transactions.

## Commands

```sh
npm run check              # executable conventions
npm run check:self-test    # prove the guards can fail
npm test                   # node:test contract and behavior tests
npm run test:coverage      # deterministic per-file unit coverage gate
npm run test:coverage:layered -- --base <ref>  # unit + browser lanes, one artifact identity
npm run coverage:check     # re-check existing reports without running tests
npm run test:browser       # pack current lib/, boot a temporary host, drive Chromium
npm run test:host-smoke    # pack current lib/ and boot a temporary DSH profile
npx playwright install chromium  # install the browser used by test:browser
npm run typecheck          # TypeScript, when dependencies are installed
npm run build              # host build (types from a DSH source checkout, runtime from the installed app; no DSH_CHECKOUT needed)
npm run check:clean        # run the executable conventions in a copy without .dsh-cowork/ or lib/
npm run gate-artifact -- --base <verified-base>  # record HEAD, binary diff SHA-256, porcelain, and scope groups
```

`npm test` runs `tests/**/*.test.mjs`; the glob is quoted so Node expands it recursively. `test:coverage` uses the same recursive discovery from [scripts/evidence/test-coverage.mjs](../scripts/evidence/test-coverage.mjs), so a test moved into a subdirectory cannot be silently skipped on either lane.

`test:coverage` runs every test file in its own process, writes one LCOV report per process, and merges the reports by union. The aggregate `node --test` report is not used: it intermittently dropped a whole test file, which is fatal for a per-file gate. The gate is [coverage-check.mjs](../scripts/evidence/coverage-check.mjs) and its policy data is `tools/coverage-map.json` plus `tools/coverage-debt.json`.

Every `src/**/*.ts` and `src/client/**/*.tsx` is owned by exactly one lane: `unit`, `browser`, or `dev`. Ownership is exclusive; a file is judged by its own lane only. The six `src/dev/m12-e2e*` drivers are the only `dev` entries: they carry a reason and an exit condition, are reported for visibility, and are not gated. `src/client/notice.tsx` is a blocked browser entry until the host exposes `ctx.sessionNotices` (KI-40). A file with only type declarations is allowed to be absent from the coverage report; a file with runtime statements that no test loads fails.

Line coverage is per file: 100%, or exactly the uncovered-line set recorded in `tools/coverage-debt.json`. The baseline only shrinks; an unlisted gap, a regression, or a stale entry after an improvement is red. `npm run test:coverage -- --update-debt` is the only writer and exists for an intentional change; it refuses newly uncovered lines unless `--accept-regression` is passed explicitly, and the gate never rewrites its own baseline. Editing a file with uncovered lines shifts the stored line numbers, so the same change refreshes that entry and the new set may only shrink. The unit sidecar records HEAD and porcelain; `coverage:check` rejects a report whose live worktree no longer matches, so a successful old report cannot be presented after an edit. Reports live in the gitignored `coverage/` directory and are not committed.

The unit loader strips TypeScript in line-preserving mode; every `src` TypeScript file must be strip-compatible, because Node's transform-mode source-map remapping is not precise enough for a per-line gate. A transform fallback exists for future syntax but turns the coverage guard red. The mapping fixture in [tests/guards/coverage-policy.test.mjs](../tests/guards/coverage-policy.test.mjs) pins an executed line and an unexecuted line through the real loader and proves the transform fallback misattributes the latter.

`test:coverage:layered` rebuilds `lib/` first, then runs the unit lane and `test:browser`, passes both the same `gate-artifact` identity (HEAD, base, committed diff, porcelain; dirty content is not hashed), and refuses a missing lane, a mismatched identity, an incomplete browser surface, or a browser LCOV that lacks an owned file. It writes `coverage/layered.json`. The browser lane is strict here: missing `dsh`, Playwright, or Chromium is a failure, never a skip. Browser per-file line/function percentages stay observational until a reviewed `tools/coverage-browser-floors.json` is added; that file must cover every non-blocked browser-owned file, and a partial file is red. The client TSX line/function baseline is reported in `coverage/client.json`. A dirty-tree layered run is diagnostic review evidence; release evidence runs from a clean commit.

`lib/` is local build output and is gitignored. After changing `src/`, run `npm run build` before packaging, `test:browser`, or `test:host-smoke`; both consumers read the current local `lib/`. A stale local `lib/` is not detected by a source hash, so the build step is part of the evidence.

`test:host-smoke` uses a temporary `DSH_HOME`, a temporary npm cache, and a random port; it never starts or writes the user's real profile. It is keyless and does not call a model. Missing `dsh` prints a skip; set `DSH_HOST_SMOKE_STRICT=1` when a missing host must fail the run.

`test:browser` packs the same artifact, creates temporary workspaces and `.dsh-cowork` fixtures, opens the real right sidebar in one Chromium context, and removes host, profile, cache, and fixture paths in `finally`. It never touches the user's profile or project data. Missing `dsh` or Chromium prints a named skip; `DSH_BROWSER_STRICT=1` makes either fatal. A standalone strict run also needs a clean worktree; `test:coverage:layered` binds the exact dirty tree through its gate artifact instead. Browser page errors fail the run.

## Determinism

- No fixed waits (`setTimeout`, `sleep`) for readiness. Wait on state or a bounded retry loop with a deadline. The host smoke waits for the printed URL and the server's response; the browser lane waits for selectors or responses.
- Tests allocate temporary files under `os.tmpdir()` and remove them. Package tests pass their own `npm_config_cache`; the host smoke and browser lane pass their own `DSH_HOME` and npm cache. Never write into `~/.dsh` or a real profile.
- The unit coverage collector isolates every test file and merges by set union, so the result does not depend on process order or scheduling. The guard test runs a two-file collection twice and requires identical merged LCOV.
- Line attribution is proven, not assumed: the loader is strip-only, every `src` TypeScript file is checked for strip compatibility, and a fixture with one executed and one unexecuted line must stay exact. The same fixture through a transform-only hook must misattribute the unexecuted line.
- Every guard must have a negative control: `npm run check:self-test` must show synthetic violations go red; the coverage tests feed the checker unlisted gaps, regressions, stale improvements, missing lanes, and mismatched identities, and each must fail; the browser coverage mapper includes a synthetic unexecuted line that must fail its gate.
- Structural guards carry their negative controls in the owning test: [tests/guards/architecture.test.mjs](../tests/guards/architecture.test.mjs) feeds each rule a synthetic bad graph, [tests/guards/typecheck-policy.test.mjs](../tests/guards/typecheck-policy.test.mjs) makes the compiler reject an unused local and parameter, and [tests/guards/source-budget.test.mjs](../tests/guards/source-budget.test.mjs) computes byte and line violations from synthetic entries.

## Blocking and observational lanes

- Blocking: `npm test`, `npm run test:coverage`, `npm run typecheck`, `npm run build`, and `npm run test:host-smoke` for package/bundle changes when DSH is available. `npm run test:coverage:layered` is blocking for delivery and merge once the browser lane can run locally; a missing lane is red.
- Observational: the browser per-file floors (`src/client/**/*.tsx` percentages), the M12 real-host/model chain, and platform-specific or host-version-specific checks. The browser surface stays observational until three consecutive local green runs and a reviewed `tools/coverage-browser-floors.json`; then promote it to blocking.

## Flake policy

A flaky test is not fixed by a longer timeout, a retry, or a weaker assertion. Find the state dependency and synchronize on it. Only a transient failure at a real external provider may be retried at that boundary.

## Evidence per change

First run `npm run change-scope -- --base <verified-base>` and record the identity with `npm run gate-artifact -- --base <verified-base>`; account for committed, staged, unstaged, and untracked paths. [docs/agent-teams.md](agent-teams.md) owns how that artifact is reused and reconciled with task scope. Then decide the owning surface from `tools/workflow.json`:

- `src/**`, `scripts/**` → `npm run test:coverage` + typecheck + build + host smoke; add `npm run test:coverage:layered -- --base <verified-base>` for delivery.
- `tools/coverage-map.json`, `tools/coverage-debt.json`, `tools/coverage-browser-floors.json` → `npm run test:coverage` + `npm run coverage:check` + `npm run check`.
- `src/client/**/*.tsx`, `tests/browser/**`, browser-lane scripts → `npm run build` + `npm run test:browser`; keep the browser page-error and mapping negative controls green; add the layered command for delivery.
- `tests/*` → `npm test` + `npm run test:coverage`, and watch the new test fail for the regression it pins.
- `package.json`, `cordis.patch.yml`, build config → `npm run check` + typecheck + `npm test` + build + host smoke.
- `tools/workflow.json`, `tools/check-invariants.mjs`, `.gitignore` → `npm run check` + `npm run check:self-test`.
- `AGENTS.md`, `docs/*` → `npm run check` and read the changed section as its reader.

A delivery is not verified unless the commands that ran, their three-state result, and the entries that did not run are named in the final report.
