# AGENTS.md

Standing orders for anyone — human or agent — changing this repository. Every rule is one or two lines and links the file that owns the detail. Keep this file under 80 lines: it loads on every task.

## Read first

- Current product scope, architecture, and milestones: [docs/PLAN-V0.2.md](docs/PLAN-V0.2.md). [docs/PLAN.md](docs/PLAN.md) is the V0.1 history, not current behavior.
- Decision-record rules: [.agents/notes/README.md](.agents/notes/README.md). Records are opt-in; do not create one for every edit.
- Documentation rules: [docs/AGENTS.md](docs/AGENTS.md). It owns kinds, one home per fact, budgets, and publication.
- Test strategy, commands, and evidence map: [docs/testing.md](docs/testing.md) and [tools/workflow.json](tools/workflow.json).
- AgentTeams DAG, review gates, worktrees, and delivery: [docs/agent-teams.md](docs/agent-teams.md).
- Writing procedures: [write-docs](.agents/skills/write-docs/SKILL.md), [prose-standard](.agents/skills/prose-standard/SKILL.md), [trim-cot-leakage](.agents/skills/trim-cot-leakage/SKILL.md).
- Review and delivery procedures: [code-review](.agents/skills/code-review/SKILL.md), [pre-push-checks](.agents/skills/pre-push-checks/SKILL.md), [pr-description](.agents/skills/pr-description/SKILL.md), [find-simplifications](.agents/skills/find-simplifications/SKILL.md).
- Vocabulary: [docs/glossary.md](docs/glossary.md) before naming a new concept; one concept, one word.

## Working rules

- **Plan before product code.** New behavior follows the current milestone and acceptance in [PLAN-V0.2](docs/PLAN-V0.2.md); do not re-litigate a completed M0 API probe.
- **Decision records are opt-in and immutable at rest.** Create one only on user request or for a substantial public tool/format/preset/architecture contract; one per workflow, never per commit or subtask. A landed record is not rewritten to reverse its decision.
- **One workstream branch.** Keep one `agent/<topic>` branch for one authorized workflow; do not create a branch per commit, review round, or subtask.
- **Manual merge.** PR merging is explicit and manual; do not add stack/auto-merge machinery or merge before review and checks pass.
- **One home per fact; docs are code.** The plan owns scope, source owns interfaces, tests own evidence, and every Markdown file is classified once in [docs/publish.json](docs/publish.json).
- **Registrations are effects.** Tools, routes, presets, listeners, and prompt sections must be owned by a disposer; a registry registration is not complete until teardown is proven ([src/index.ts](src/index.ts), [tests/dev-gate.test.mjs](tests/dev-gate.test.mjs)).
- **Config is explicit.** Deployment-varying values are validated `Config` fields, not hidden defaults inside operations ([src/index.ts](src/index.ts)).
- **Validate at trust boundaries.** Parsers, files, tool JSON, wire input, subprocesses, and external APIs are untrusted; typed same-process values trust TypeScript instead of adding redundant runtime checks.
- **Errors stay owned.** Do not swallow failures; expected tool failures carry a stable code and actionable context ([src/tool-model.ts](src/tool-model.ts)).
- **Tests describe behavior.** A change to tested behavior updates its test deliberately; never weaken or delete an assertion merely to get green ([docs/testing.md](docs/testing.md)).
- **Source plane and artifact plane stay separate.** Tests resolve `src`; built-artifact smoke consumes tracked `lib/`. Do not mix them to hide a missing build ([docs/testing.md](docs/testing.md)).
- **Topic = native DSH session.** Create topics only through `sessionController.create`; never expose a spawn/fork subagent as a user-openable session. `thread` is only the 0.1.0 alias.
- **No multi-orchestrator.** Do not add AgentTeams, `dsh-agent-hub`, `dsh-forge`, or `dsh-team-conductor` as runtime dependencies; borrow semantics, not packages.
- **Local only.** No cloud upload, no `viking://` reads/writes from plugin code, and no secrets or personal data in files, logs, fixtures, or prompts.
- **Prefer owned or maintained code.** Add a dependency only when it removes more owned code and tests than it creates; record the reason and do not install tools globally.
- **Verify the world.** Re-run the command or re-read the file from outside the writer; report what did not run and what cannot be falsified.

## Run relevant checks locally

Before pushing, load [pre-push-checks](.agents/skills/pre-push-checks/SKILL.md), confirm the live base, and run `npm run change-scope -- --base <verified-base>`. Report only commands that actually ran; name every unrun check.

- Match evidence to the owning surface in [tools/workflow.json](tools/workflow.json). Docs-only: `npm run check`; skill/workflow: `npm run check` + `npm run check:self-test`; tests: `npm test` + `npm run test:coverage` and observe the regression red first; source/scripts: `npm run test:coverage` + `npm run typecheck` + `npm run build` + `npm run check:lib-sync` + `npm run test:host-smoke`; packaging/bundle: that source/script set plus `npm test` and `npm run check`.
- Do not default to the full suite or repeat a passing check for commit/push. Rehearse everything only by explicit request, when diagnosing CI, or when an irreducibly repository-wide change crosses several surfaces.
- `npm run test:coverage` is the source coverage gate; it runs the suite and enforces global line/branch/function floors, not per-file 100%. It does not count React TSX or dev-only E2E/probe drivers; browser automation is not yet an executable lane.
- `lib/` is tracked. After anything under `src/` changes, run `npm run build`, commit the matching `lib/`, and let `npm run check:lib-sync` prove the source hash. `npm run test:host-smoke` consumes the current `lib/`, uses a temporary `DSH_HOME`, and skips when `dsh` is absent unless `DSH_HOST_SMOKE_STRICT=1`.
- PR descriptions use [pr-description](.agents/skills/pr-description/SKILL.md); merge is a separate manual step. A green local check is not proof that a remote matrix or an unrun real-host E2E exists.

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
npm run test:coverage      # node:test coverage floors for host TypeScript
npm run test:host-smoke    # pack current lib/ and boot a temporary DSH profile
npm run check:lib-sync     # fail when src changed without rebuilding tracked lib/
npm run change-scope -- --base <verified-base>  # committed/staged/unstaged/untracked review scope
npm run typecheck          # TypeScript check (requires deps installed)
npm run build              # host build (auto-detects a DSH source checkout for types and the installed app for runtime)
```

Build note: `lib/` is tracked because tarball install and `test:host-smoke` consume it. `npm test` includes the sourceHash guard, so a stale `lib/` fails the suite.
