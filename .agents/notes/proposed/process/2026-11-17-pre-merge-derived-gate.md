# Proposal: Pre-merge derived gate and stable PR HEAD

Status: proposed
Date: 2026-11-17
Class: process

## Problem

The current flow binds `pr-gate`, `review-verdict`, and `gate-artifact` to one PR HEAD. A `main` advance forces a branch update, which creates a new HEAD and invalidates the reviewed test and review results even when the authored diff did not change. `gate-artifact` also runs only on review events, so a review submitted before CI can leave the required check waiting indefinitely.

The first implementation attempt (PR #57) exposed this rollout blocker: it deleted `.github/workflows/gate-artifact.yml` before `scripts/ci/publish-gate.mjs` existed on `main`. A `pull_request_review` run executes the workflow from the PR head, so the replacement workflow checked out `main`, could not find the publisher script, and produced no required `gate-artifact` check. PR #57 restored the legacy workflow and landed the publisher with it; the follow-up PR retired the legacy workflow after the publisher reached `main`.

The repository is a personal public repository. Native GitHub merge queue is not available for user-owned repositories, so this proposal keeps manual merge and uses a trusted pre-merge check instead. It does not introduce a merge train, file-domain governance, conflict notification, or LLM conflict resolution.

## Proposal

**1. Keep one stable `pr-gate`.** Split `ci.yml` into `classify`, `docs-check`, `unit`, and an aggregate `pr-gate`. Docs-only changes run `npm run check`; non-docs changes additionally run `npm run test:coverage`. Do not repeat `npm test` in `pr-gate`.

**2. Add a trusted `pre-merge` check.** A `pull_request_target` workflow checks out the PR head with no secrets, merges the current `main` into a temporary tree, runs the path-selected checks, and publishes a `pre-merge` check whose summary records `head`, `base`, and `currentBase`. It never updates the PR branch.

**3. Use one success/decision publisher for required `gate-artifact`.** `scripts/ci/publish-gate.mjs` owns the required context in both modes:

- report mode: the required `gate-artifact` keeps the legacy validation (a current review marker for the head, `pr-gate`, current main as an ancestor, and PR metadata) and also publishes report-only `gate-artifact-v2` with the would-fail reasons;
- block mode: the required `gate-artifact` uses the latest review marker, which must be `pass`; it also verifies the v2 review's `base` and `diffSha`, a successful `pre-merge` on current main, PR metadata, and reviewed-path overlap. `needs_revision`, `reject`, or a later `CHANGES_REQUESTED` block an older pass.

`changedPaths` uses `--no-renames` so a main-side rename cannot hide an overlap. `Policy Base` publishes only `action_required` after a main push, invalidating both `gate-artifact` and `gate-artifact-v2`; it never publishes success.

**4. Bootstrap the publisher before deleting the legacy workflow.** The legacy `.github/workflows/gate-artifact.yml` must remain until `scripts/ci/publish-gate.mjs` is on `main`. The safe order is: land the publisher scripts on `main`, then delete the legacy workflow in a follow-up PR, then activate block mode. The legacy workflow must not be removed in the same PR that first introduces the publisher; PR #57 landed the publisher with a keep-alive guard, and the follow-up PR replaced that guard with the uniqueness assertion.

**5. Keep docs and evidence proportional.** A docs-only PR runs only `npm run check`, but review is still required. `docs/**` and `README.md` changes after an E2E evidence recording are evidence-neutral; runtime, test, script, catalog, and packaging changes still require a new recording. No `Docs-Impact` gate is added.

**6. Keep the operational boundary explicit.** Manual merge remains. No merge queue, merge train, auto-merge, file-domain lock, conflict notifier, or LLM conflict resolver is added. A conflict is handled by the human at merge time.

## Alternatives considered

**Native GitHub merge queue.** Rejected because GitHub merge queue is available only for organization-owned public repositories (or Enterprise Cloud organization private repositories); this repository is user-owned.

**Self-built merge train.** Rejected for this phase because it requires a long-lived bot with merge permission, queue state, idempotency, and conflict handling, while the repository already has a manual merge policy.

**Keep strict up-to-date and update every branch.** Rejected because every main advance creates a new head and forces a new review; it preserves the rework this proposal is intended to remove.

**Bind review to a patch identity while keeping branch updates.** Rejected as the primary design because it still requires branch rewrites and makes the review/diff identity harder to audit. Keeping the PR head stable and testing a temporary merge result is simpler.

**Adopt deepseek-harness weighted approval, native stacks, or its full review checklist.** Rejected because this is a single-maintainer repository; those mechanisms add app tokens, scoring, stack machinery, and a larger review surface without removing the manual merge decision.

**Add a `Docs-Impact` gate for every documentation change.** Rejected because PLAN, proposed feature design, and backend design documents can legitimately lead the code; a path-based gate would produce false positives.

**Add file-domain locking and Agent Note ownership.** Deferred. Shared-file conflicts remain a known risk and are handled at merge time for now.

**Let an LLM resolve conflicts.** Deferred. The current phase does not introduce conflict notification or automatic resolution.

## Acceptance criteria

- [A1] `pr-gate` remains one stable check; docs-only runs only `npm run check`, while non-docs runs `npm run test:coverage`; `npm test` is not repeated — `workflow`
- [A2] `pre-merge` tests a temporary merge of current `main` and the PR head without updating the branch — `workflow`
- [A3] report mode keeps the legacy required `gate-artifact` behavior and publishes `gate-artifact-v2` only as an advisory — `workflow`
- [A4] block mode requires the latest review marker to be `pass`, a matching v2 `base`/`diffSha`, a current-base `pre-merge`, valid metadata, and no reviewed-path overlap — `workflow`
- [A5] `Policy Base` only publishes `action_required` after main advances; it never publishes success — `workflow`
- [A6] required `gate-artifact` has one success/decision publisher; the legacy workflow remains until the publisher is on `main`, then is removed by a follow-up — `workflow`
- [A7] docs/README changes are evidence-neutral; runtime changes still require E2E re-recording; docs-only review is not waived — `tests`
- [A8] no merge queue, merge train, file-domain lock, conflict notifier, or LLM conflict resolver is added — `workflow`

## Risks

- **Bootstrap ordering.** Deleting the legacy workflow before the publisher is on `main` leaves the PR without its required gate; PR #57 hit this once. The keep-alive guard made the retirement a deliberate test change, and the follow-up assertion now requires the replacement publisher to be the only one.
- **Base-recheck timing.** `main` can advance before the stale `action_required` is published; there is a short window that a merge queue would close.
- **Fork PRs.** `workflow_run.pull_requests` can be empty for forks; the fallback requires exactly one open PR and otherwise fails closed. The current flow targets same-repository `agent/<topic>` branches.
- **Pagination and check selection.** Reviews and check runs use `per_page=100`; very long PRs may need pagination. The latest `pre-merge` check is selected by completion time, not "latest success".
- **Single-account review independence.** `review-verdict` cannot prove the reviewer is independent of the implementer; this remains a review-quality constraint.
- **Manual merge capacity.** Removing branch rewrites reduces rework, but the human merge decision remains the throughput limit.
- **Docs evidence exception.** A docs/README change can no longer refresh E2E evidence; the evidence still binds the last runtime tree.

## Delivery stages

1. **Unblock the bootstrap.** Keep the legacy workflow on the PR branch until the publisher reaches `main`; PR #57 restored it and landed the publisher. Splitting the publisher into a preparatory PR is the alternative if a branch is retargeted.
2. **Land publisher scripts on `main`.** Merge the publisher, pre-merge, gate, base-recheck, and tests without deleting the legacy workflow.
3. **Retire the legacy publisher.** In a follow-up, delete `.github/workflows/gate-artifact.yml` and verify the review event still produces required `gate-artifact`.
4. **Activate block mode.** Set `MERGE_POLICY_MODE=block`, verify a known failing PR is red and a known passing PR is green, then remove strict up-to-date.
5. **Rollback.** Restore strict up-to-date first; set `MERGE_POLICY_MODE=report`; restore the legacy publisher if it was removed; re-run a review event.
