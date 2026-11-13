---
name: code-review
description: Use when reviewing a dsh-cowork change, preparing a PR, selecting pre-push evidence, or judging whether review findings are fixed
---

# Code review for dsh-cowork

Review against the owning requirements and evidence, not against memory of the rules. One substantiated blocker is more useful than a list of style nits.

## When to use

Use before approving or rejecting a change, before opening or updating a PR, before pushing a branch whose evidence is incomplete, and when deciding whether a review finding is fixed or declined. For AgentTeams work, this procedure supplies the reviewer's method; [docs/agent-teams.md](../../../docs/agent-teams.md) still owns the DAG, verdict, worktree, and delivery rules.

## How

1. **Freeze the review range.** Run `git status --short --branch`, verify the live base ref from the PR or parent branch, and fetch it. Run `npm run change-scope -- --base <verified-base>`; use the committed, staged, unstaged, and untracked groups together. Re-run after a retarget, merge, or base update.
2. **Read the requirements before the diff.** Map changed paths through [tools/workflow.json](../../../tools/workflow.json) and read the owning sections of [docs/PLAN-V0.2.md](../../../docs/PLAN-V0.2.md), [docs/testing.md](../../../docs/testing.md), and the relevant guide or decision record. Open the implementation and enough callers to understand the data flow.
3. **Review in priority order.** Check correctness, lifecycle and concurrency, failure and cleanup, security boundaries, persisted/wire compatibility, model-visible prompts and tool schemas, bounds, packaging, tests, and documentation. Judge simplifications by removed maintenance cost and preserved behavior, not by line count.
4. **Verify the evidence.** A test must fail for the regression it claims to pin and assert external state, not the implementation's self-report. Check negative controls, resource ownership, teardown, source/lib synchronization, and the real entry path where the change touches packaging or plugin loading. Do not repeat an issue that a green owning gate already proves.
5. **Report findings.** Each finding names a relative `path:line`, the affected behavior, the evidence, and the required fix. Separate blockers from suggestions; use a change-level comment for cross-cutting architecture or scope. Verify each claim before replying to a review thread.
6. **Keep review independent.** The implementer must not be the final reviewer of their own change. Review/requirements tasks pass only with `verdict=pass`; `needs_revision` and `reject` carry findings. Batch low-risk findings into one repair, and restart the owning gate if a repair changes behavior.

## Verification

- Run `npm run change-scope -- --base <verified-base>` and confirm all four path groups are accounted for.
- Run `npm run check`; for a skill or workflow change also run `npm run check:self-test`.
- Select the narrowest tests from `tools/workflow.json`. For a behavior change, run `npm run test:coverage`, `npm run build`, and `npm run test:host-smoke`; for a docs-only change, run `npm run check`.
- Confirm the final report states commands and results, including checks that did not run.
- For a PR, use [pr-description](../pr-description/SKILL.md) to write the Motivation / Changes / Testing / Evidence structure with test design, actual test entries, unrun checks, and reviewable evidence.

## Anti-patterns

- Reviewing from memory or reading the diff before the owning requirements.
- Reporting only style nits while missing a lifecycle, cleanup, security, or compatibility defect.
- Trusting an agent's summary instead of re-reading the file, state, or command output.
- Ignoring untracked or unstaged paths because the PR branch is clean.
- Rewriting or weakening a test to make a review pass.
- Letting the implementer give the final verdict on their own change.
- Running the full suite reflexively instead of selecting the owning evidence.
