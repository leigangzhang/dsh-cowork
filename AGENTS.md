# AGENTS.md

Standing orders for anyone — human or agent — changing this repository. Every rule is one or two lines and links the file that owns the detail. Keep this file under 120 lines: it loads on every task.

## Read first

- Current product scope, architecture, and milestones: [docs/PLAN-V0.2.md](docs/PLAN-V0.2.md). [docs/PLAN.md](docs/PLAN.md) is the V0.1 history, not current behavior.
- Decision-record rules: [.agents/notes/README.md](.agents/notes/README.md). Records are opt-in; do not create one for every edit.
- Documentation rules: [docs/AGENTS.md](docs/AGENTS.md). It owns kinds, one home per fact, budgets, and publication.
- Test strategy, commands, and evidence map: [docs/testing.md](docs/testing.md) and [tools/workflow.json](tools/workflow.json).
- AgentTeams DAG, review gates, worktrees, and delivery: [docs/agent-teams.md](docs/agent-teams.md).
- Task procedures: [.agents/skills/README.md](.agents/skills/README.md). Skills load progressively by their own `description`; this file does not mirror the catalog.
- Vocabulary: [docs/glossary.md](docs/glossary.md) before naming a new concept; one concept, one word.

## Project structure

```text
src/          host plugin: entry + app/platform/store/domains/tools/panel/dev
src/client/   browser panel: contracts, models, TSX components, styles
tests/        node:test contracts and behavior, mirroring the src layers
scripts/      build/, evidence/, review/ command entry points
tools/        executable document/workflow gates and migration drill
docs/         plans, guides, references, handoff and design records
.agents/      skills and decision records
lib/          local build output; gitignored, consumed by tarball and host smoke
coverage/     local coverage reports; gitignored
.dsh-cowork/  local runtime/evidence data; gitignored
```

## Working rules

- **Plan before product code.** New behavior follows the current milestone and acceptance in [PLAN-V0.2](docs/PLAN-V0.2.md); do not re-litigate a completed M0 API probe.
- **Decision records are opt-in and immutable at rest.** Create one only on user request or for a substantial public tool/format/preset/architecture contract; one per workflow, never per commit or subtask. A landed record is not rewritten to reverse its decision.
- **One workstream branch.** Keep one `agent/<topic>` branch for one authorized workflow; do not create a branch per commit, review round, or subtask.
- **Manual merge.** PR merging is explicit and manual; do not add stack/auto-merge machinery or merge before review and checks pass.
- **One home per fact; docs are code.** The plan owns scope, source owns interfaces, tests own evidence, and every Markdown file is classified once in [docs/publish.json](docs/publish.json). Code symbols follow the same rule: one home for every exported value and type name.
- **Registrations are effects.** Tools, routes, presets, listeners, and prompt sections must be owned by a disposer; a registry registration is not complete until teardown is proven ([src/app/apply.ts](./src/app/apply.ts), [tests/guards/dev-gate.test.mjs](./tests/guards/dev-gate.test.mjs)).
- **Config is explicit.** Deployment-varying values are validated `Config` fields, not hidden defaults inside operations ([src/app/apply.ts](./src/app/apply.ts)).
- **Validate at trust boundaries.** Parsers, files, tool JSON, wire input, subprocesses, and external APIs are untrusted; typed same-process values trust TypeScript instead of adding redundant runtime checks.
- **Errors stay owned.** Do not swallow failures; expected tool failures carry a stable code and actionable context ([src/platform/tool-model.ts](./src/platform/tool-model.ts)).
- **Tests describe behavior.** A change to tested behavior updates its test deliberately; never weaken or delete an assertion merely to get green ([docs/testing.md](docs/testing.md)).
- **Code health is executable.** Exports, stale names, ignored-evidence links, budgets, architecture, and `noUnused*` are gates in `npm run check` / `check:clean` / `typecheck`; the judgement checklist is [code-review](.agents/skills/code-review/SKILL.md), and full-function complexity is baselined in [tools/fallow-health-baseline.json](tools/fallow-health-baseline.json). The baseline is reviewed existing state, not a waiver: `fallow health --baseline` must report zero new findings, `fallow audit --base` gates the change, and a baseline refresh is its own maintenance PR reviewed entry by entry.
- **Exports and tools have owners.** A runtime or type export needs a cross-module consumer, a reviewed [tools/export-baseline.json](tools/export-baseline.json) entry, or it becomes module-private; a re-export needs a consumer, and every `tools/*.mjs` is claimed by a workflow surface or a script/test import.
- **Source plane and artifact plane stay separate.** Tests resolve `src`; built-artifact smoke consumes the local `lib/`. Do not mix them to hide a missing build ([docs/testing.md](docs/testing.md)).
- **Topic = native DSH session.** Create topics only through `sessionController.create`; never expose a spawn/fork subagent as a user-openable session. `thread` is only the 0.1.0 alias.
- **No multi-orchestrator.** Do not add AgentTeams, `dsh-agent-hub`, `dsh-forge`, or `dsh-team-conductor` as runtime dependencies; borrow semantics, not packages.
- **Local only.** No cloud upload, no `viking://` reads/writes from plugin code, and no secrets or personal data in files, logs, fixtures, or prompts.
- **Prefer owned or maintained code.** Add a dependency only when it removes more owned code and tests than it creates; record the reason and do not install tools globally.
- **Verify the world.** Re-run the command or re-read the file from outside the writer; report what did not run and what cannot be falsified.

## Type safety and documentation

Everything compiles under `strict: true`; avoid `any`, and any remaining `any` explains why narrowing is infeasible. Every module and non-obvious export has concise JSDoc for its contract; function-like exports include `@param`/`@returns` when the contract is not obvious from names and types.

Comments and docs state complete contracts and context, not reasoning transcripts. Use concrete terms; reserve `contract` for obligations, invariants, compatibility, and other caller/callee promises, and `boundary` for a literal process, wire, security, transaction, or lifecycle edge. Do not narrate control flow or tests, preserve review history, or restate code; keep behavior, failure, timing, ownership, and safe-use facts, and link the rationale. Use [prose-standard](.agents/skills/prose-standard/SKILL.md) for editorial decisions.

Docs accompany every code change: update affected README, JSDoc, and owning docs together. Wire mechanically checkable invariants into `npm run check` or the owning test and prove a changed guard rejects an invalid case; use narrow, justified exceptions instead of disabling a rule globally. Current-state prose, one home per fact, and budgets live in [docs/AGENTS.md](docs/AGENTS.md).

## Run relevant checks locally

Before pushing, load [pre-push-checks](.agents/skills/pre-push-checks/SKILL.md), confirm the live base, and run `npm run change-scope -- --base <verified-base>`. Report only commands that actually ran; name every unrun check.

- Match evidence to the owning surface in [tools/workflow.json](tools/workflow.json). Docs-only: `npm run check`; skill/workflow: `npm run check` + `npm run check:self-test`; tests: `npm test` + `npm run test:coverage` and observe the regression red first; source/scripts: `npm run test:coverage` + `npm run typecheck` + `npm run build` + `npm run test:host-smoke`; coverage policy data (`tools/coverage-*.json`): `npm run test:coverage` + `npm run coverage:check` + `npm run check`; packaging/bundle: that source/script set plus `npm test` and `npm run check`. Delivery and merge add `npm run test:coverage:layered -- --base <verified-base>`.
- PR CI runs the hosted core commands in `pr-gate`: `npm run check`, `npm test`, and `npm run test:coverage`. `npm run typecheck`, `npm run build`, `test:host-smoke`, `test:browser`, and `test:coverage:layered` run in the local heavy lane because they need a DSH source checkout or host runtime. Local runs only the affected subset; do not duplicate a passing check merely to match CI. A green local check is not proof that `pr-gate` passed.
- Do not default to the full suite or repeat a passing check for commit/push. Rehearse everything only by explicit request, when diagnosing CI, or when an irreducibly repository-wide change crosses several surfaces.
- `tests/e2e/**`, `scripts/evidence/e2e.mjs`, `tools/e2e-coverage.mjs`: `npm run test:e2e` + `npm run check` + `npm test`; the manifest must match the live public surface and the committed evidence must match the current version. `test:e2e:live` is observational and needs `DEEPSEEK_API_KEY`; a red keyless run is reported, never skipped silently.
- `npm run test:coverage` is the source coverage gate: one process per test file, merged by union, then a per-file line gate at 100% over the exclusive owner map `tools/coverage-map.json`. `tools/coverage-debt.json` is the reviewed exception list for an intentional gap and is empty. It does not count React TSX; `npm run test:browser` owns those as an observational lane. `npm run test:coverage:layered` binds both lanes to one artifact and is the delivery gate.
- `lib/` is local build output and gitignored. After anything under `src/` changes, run `npm run build` before `test:host-smoke`; the smoke consumes the current local `lib/`, uses a temporary `DSH_HOME`, and skips when `dsh` is absent unless `DSH_HOST_SMOKE_STRICT=1`.
- PR descriptions use [pr-description](.agents/skills/pr-description/SKILL.md); merge is a separate manual step. A green local check is not proof that `pr-gate` passed or that an unrun real-host E2E exists.

## AgentTeams

- Before creating a plan, read [docs/agent-teams.md](docs/agent-teams.md); it owns the DAG, impact scan, gate artifact, worktree, review, and delivery rules.
- Use a configured profile and its tool policies; do not recreate the roster in task prose. Verification/review depend on `integration-ready`; docs-only changes skip E2E.
- Browser/panel verification follows R8/R9: fix host health and overview API before driving the UI, reuse one browser session, isolate fixtures, and never use sleeps as readiness.

## Closing the gate

- A check that cannot pass under honest evidence is a gate defect. Report the exact call; do not bypass it or report green.
- Two failed shapes of the same evidence mean re-examine the check, not retry a third identical time.
- Never end a silent turn: if a check is red, name the failing command and what was tried.

## Commands

```sh
npm run check              # executable conventions (workflow, skills, templates, publication, budgets)
npm run check:self-test    # prove the guards can fail
npm test                   # contract and behavior tests
npm run test:coverage      # deterministic per-file unit coverage gate
npm run test:browser       # real host + Chromium panel lane (observational)
npm run test:coverage:layered -- --base <ref>  # unit + browser lanes, one artifact identity
npm run coverage:check     # re-check existing coverage reports
npm run test:e2e           # pack current lib/, run the keyless E2E scenarios in a temporary host
npm run test:e2e:live      # observational real-model E2E; needs DEEPSEEK_API_KEY, never release evidence
npm run test:e2e:bash      # observational topic-bash check; needs a usable bash sandbox, never keyless evidence
npm run test:host-smoke    # pack current lib/ and boot a temporary DSH profile
npm run change-scope -- --base <verified-base>  # committed/staged/unstaged/untracked review scope
npm run typecheck          # TypeScript check (requires deps installed)
npm run build              # host build (auto-detects a DSH source checkout for types and the installed app for runtime)
```

Build note: `lib/` is gitignored local output. After changing `src/`, run `npm run build` before packaging or `test:host-smoke`; a stale local `lib/` is not detected by source hashes.
