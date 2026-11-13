# AGENTS.md

Standing orders for anyone — human or agent — changing this repository. Every rule is one or two lines and links the file that owns the detail. Keep this file under 80 lines: it loads on every task.

## Read first

- Read [docs/PLAN.md](docs/PLAN.md) before touching `src/`, `presets/`, or the data model. It owns the product scope, architecture, and milestones.
- Read [.agents/notes/README.md](.agents/notes/README.md) before writing a decision record. It owns when to write one and what class to use.
- Read [docs/documentation.md](docs/documentation.md) before adding, renaming, or reclassifying a document. It owns kinds, one-home-per-fact, budgets, and the publication switch.
- Load [write-docs](.agents/skills/write-docs/SKILL.md), [prose-standard](.agents/skills/prose-standard/SKILL.md), or [trim-cot-leakage](.agents/skills/trim-cot-leakage/SKILL.md) when writing, judging, or cleaning prose. The skills own the procedure; documentation.md owns the rules.
- Read [docs/glossary.md](docs/glossary.md) before naming a new concept. One concept, one word; link the term instead of restating it.
- Read [tools/workflow.json](tools/workflow.json) before adding a rule, a file kind, or a check. A convention without an executable check is prose, not policy.

## Working rules

- **M0 first.** Before writing product code, prove the five API risks in PLAN.md §3.2 and record the result. Do not skip M0 because an API looks right in source.
- **Design before build.** A non-trivial capability starts as a proposal in `.agents/notes/proposed/` with `Alternatives considered` and acceptance criteria that name the check that will go red. Implementation follows.
- **A decision is not editable in place.** Move the proposal to `.agents/notes/implemented/` in the same delivery that lands the work and rewrite it in the present tense; overturning it means a new record.
- **One home per fact.** The plan owns scope and architecture; AGENTS.md owns pointers; tests and evidence own verification. Do not copy a fact into two files.
- **Docs are code.** Every Markdown file is classified exactly once in `docs/publish.json`; publication is a per-file promise, not a directory guess. No hand-copied interfaces or generated pages.
- **Topic = native DSH session.** The only supported way to create a topic is `sessionController.create`; never use a spawn/fork subagent as a user-openable session. `thread` is the 0.1.0 name and survives only as a preset alias.
- **No multi-orchestrator.** Do not add `dsh-agent-hub`, `dsh-forge`, `dsh-team-conductor`, or AgentTeams runtime as dependencies. Review may borrow their semantics, not their packages.
- **Local only.** No cloud upload, no reading or writing `viking://` from plugin code, no secrets in files or logs.
- **Verify the world, not the self-report.** Re-run the command or re-read the file from outside the writer. Say what did not run and what cannot be falsified.
- **Evidence per change, not all tests every time.** Decide the owning surface from [tools/workflow.json](tools/workflow.json); do not run the full suite unless the change crosses packaging or workflow surfaces.
- **Never end a silent turn.** If a check is red, the final message names what is red and what was tried.

## AgentTeams

- Before creating an AgentTeams plan, read [docs/AGENTTEAM.md](docs/AGENTTEAM.md); it owns the DAG, impact scan, gate artifact, worktree, review and delivery rules.
- Use a configured profile and its tool policies; do not recreate the roster in task prose. Verification/review depend on `integration-ready`; code freezes before final gates and docs-only changes skip E2E.
- Browser/panel verification follows R8/R9: fix host health and the overview API before driving the UI, reuse one browser session, and isolate the fixture from live data; never use sleeps as readiness.

## Closing the gate

- A check that cannot pass under any honest evidence is a gate defect. Report the defect with the exact call; do not bypass and do not report green.
- Two failed shapes of the same evidence is the signal to re-examine the check, not to retry a third identical time.

## Commands

```sh
npm run check              # executable conventions (workflow, skills, templates, publication, budgets)
npm run check:self-test    # prove the guards can fail
npm test                   # contract tests for the repository's own rules
npm run typecheck          # TypeScript check (requires deps installed)
npm run build              # host build (auto-detects a DSH source checkout for types and the installed app for runtime)
```

Build note: `npm run build` runs now that M0 landed. Types come from a DSH source checkout and runtime links from the installed app, both auto-detected; the client half is removed for M0 and returns in M3.
