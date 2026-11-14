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

### Code health checklist

Run this after the priority pass, before passing the change. A finding here is as real as a correctness finding when it names a concrete path or a missing control.

- **Lifecycle:** does a dev-only, temporary, or compatibility module have an owner, a retirement trigger, and the test or KI that retires it?
- **Legacy path:** is the adapter on a read path or on control/write? Removing it must migrate the role or transaction model, not just delete a reader.
- **Transactions and delivery:** does the design state what is guaranteed and what is not? Is a compensating failure observable? Is the shared thing an attempt/retry or a state/ledger?
- **Host boundary:** is a missing host capability handled with a budget and a KI, rather than a fake abstraction or a skipped check?
- **Structural migration:** is there a proposed record with target tree, import direction, phases, rollback, and the test-discovery change before any move?
- **Test split:** did the test and assertion counts actually stay the same, or were assertions copied to pad the split?
- **Model text:** did persona, tool description, and error text follow the tool or preset change?
- **Doc links:** do current docs point at existing files, and did historical records only change link targets, not conclusions?

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
- Passing a change whose temporary surface has no retirement trigger, or whose legacy adapter was removed without migrating the control path it still served.
- Letting the implementer give the final verdict on their own change.
- Running the full suite reflexively instead of selecting the owning evidence.
