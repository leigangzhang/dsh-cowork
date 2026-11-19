# Decision: Pre-merge derived gate and stable PR HEAD

Status: implemented
Date: 2026-11-17
Class: process

## Problem

The flow bound `pr-gate`, `review-verdict`, and `gate-artifact` to one PR HEAD. A `main` advance forced a branch update, which created a new HEAD and invalidated the reviewed test and review results even when the authored diff did not change. `gate-artifact` also ran only on review events, so a review submitted before CI could leave the required check waiting indefinitely.

The repository is a personal public repository. Native GitHub merge queue is not available for user-owned repositories, so the flow keeps manual merge and uses a trusted pre-merge check instead.

## Decision

**1. One stable `pr-gate`.** `.github/workflows/ci.yml` splits `classify`, `docs-check`, `unit`, and the aggregate `pr-gate`. Docs-only changes run `npm run check`; non-docs changes also run `npm run test:coverage`; `npm test` is not repeated.

**2. Trusted `pre-merge`.** `.github/workflows/pre-merge.yml` runs on `pull_request_target`, checks out the PR head with no secrets, merges current `main` into a temporary tree, runs the path-selected checks, and publishes a `pre-merge` check whose summary records `head`, `base`, `currentBase`, `docsOnly`, and `result`. It never updates the PR branch. The test job sets the same `GIT_AUTHOR_*` / `GIT_COMMITTER_*` environment and `init.defaultBranch main` as the CI `unit` job; the publisher job is named `pre-merge-publish` so its job check cannot collide with the published `pre-merge` check. The `recheck` label re-runs it against the current main.

**3. Single required-gate publisher.** `.github/workflows/gate-artifact-v2.yml` (`Policy V2`) checks out `main`, runs `scripts/ci/publish-gate.mjs`, and is the only workflow that publishes the required `gate-artifact` context. `MERGE_POLICY_MODE` selects the decision: report mode keeps the legacy validation (a current review marker for the head, `pr-gate`, current main as an ancestor, PR metadata) and also publishes report-only `gate-artifact-v2`; block mode uses the latest v2 review marker, which must be `pass`, the review `base`/`diffSha`, a successful current-base `pre-merge`, PR metadata, and reviewed-path overlap. `changedPaths` uses `--no-renames`. `.github/workflows/base-recheck.yml` publishes only `action_required` after a main push. The publisher job stays green for a published blocked decision; the required check run carries the verdict, because a failed job marks the app check suite failed and a GitHub ruleset then treats the required check as `expected`.

**4. Review identity.** `scripts/ci/review-verdict.mjs` parses `review-verdict:v1` and `v2`; v2 binds `head`, `base`, and the binary diff `diffSha`. A newer `needs_revision`, `reject`, or `CHANGES_REQUESTED` blocks an older pass. A main advance alone does not require a new review; reviewed-path overlap requires merging current main and a delta review.

**5. Bootstrap and retirement.** The legacy `.github/workflows/gate-artifact.yml` stayed until `publish-gate.mjs` was on `main`; a follow-up PR then deleted it. `tests/guards/review-gate.test.mjs` now asserts the legacy workflow is absent and `publish-gate.mjs` appears in exactly one workflow.

**6. Operational boundary.** `main` uses the `main-pr-gate` ruleset with required `pr-gate` + `gate-artifact`, resolved conversations, merge commits, no bypass actors, and no strict up-to-date after activation. `MERGE_POLICY_MODE=block` is the active mode. Manual merge remains; no merge queue, merge train, auto-merge, file-domain lock, conflict notifier, or LLM conflict resolver is added.

## Alternatives considered

**Native GitHub merge queue.** Rejected because GitHub merge queue is available only for organization-owned public repositories (or Enterprise Cloud organization private repositories); this repository is user-owned.

**Self-built merge train.** Rejected for this phase because it requires a long-lived bot with merge permission, queue state, idempotency, and conflict handling, while the repository already has a manual merge policy.

**Keep strict up-to-date and update every branch.** Rejected because every main advance creates a new head and forces a new review; it preserves the rework this decision removes.

**Bind review to a patch identity while keeping branch updates.** Rejected as the primary design because it still requires branch rewrites and makes the review/diff identity harder to audit. Keeping the PR head stable and testing a temporary merge result is simpler.

**Adopt deepseek-harness weighted approval, native stacks, or its full review checklist.** Rejected because this is a single-maintainer repository; those mechanisms add app tokens, scoring, stack machinery, and a larger review surface without removing the manual merge decision.

**Add a `Docs-Impact` gate for every documentation change.** Rejected because PLAN, proposed feature design, and backend design documents can legitimately lead the code; a path-based gate would produce false positives.

**Add file-domain locking and Agent Note ownership.** Deferred. Shared-file conflicts remain a known risk and are handled at merge time.

**Let an LLM resolve conflicts.** Deferred. The current phase does not introduce conflict notification or automatic resolution.

## Consequences

- A main advance no longer forces a branch update: `pre-merge` tests the temporary merge and the gate recomputes when CI or Pre-Merge completes. Reviewed-path overlap still requires merging main and a delta review.
- The ruleset no longer requires an up-to-date branch. The trade-off is a short window between a main push and `Policy Base` publishing `action_required`; the `recheck` label re-runs `pre-merge` against the current main.
- Fork PRs fail closed: `workflow_run.pull_requests` can be empty and the fallback requires exactly one open PR. The flow targets same-repository `agent/<topic>` branches.
- Single-account review independence remains a procedural constraint; `review-verdict` cannot prove that the reviewer is independent of the implementer.
- Manual merge remains the throughput limit. Removing branch rewrites reduces rework but does not remove the human decision.
- Bootstrap ordering cost one blocked PR: the legacy workflow had to stay until the publisher was on `main`. The keep-alive guard then made the retirement a deliberate, reviewed test change.
- Check-suite pollution cost one temporary ruleset relaxation: a failed publisher job marks the app check suite failed, and a GitHub ruleset then treats the required check as `expected` even after a later success. The publisher now keeps its job green for a published blocked decision; only unexpected errors fail it.
- Docs and `README.md` changes are evidence-neutral after an E2E recording; runtime, test, script, catalog, and packaging changes still require a new recording. Docs-only review is not waived.
- The second opinion targets an independent non-DeepSeek model, `kimi-k2.7-code` at high effort. The configured `kimi` provider is not in the subagent model allow-list and `KIMI_API_KEY` is unset, so a second opinion is recorded `not run`, never a default pass. Revisit when the provider is routable.
- Revisit this decision if GitHub adds merge queues for user-owned repositories, if the second-opinion route changes, or if the ruleset or check-suite behaviour changes.

## Testing

- [A1] `pr-gate` remains one stable check; docs-only runs `npm run check`, non-docs also run `npm run test:coverage`, and `npm test` is not repeated — `workflow` (`.github/workflows/ci.yml`, `tests/guards/ci-workflow.test.mjs`)
- [A2] `pre-merge` tests a temporary merge of current `main` and the PR head without updating the branch — `workflow` (`.github/workflows/pre-merge.yml`, `tests/guards/pre-merge-workflow.test.mjs`; run 44497705103)
- [A3] report mode keeps the legacy required `gate-artifact` and publishes `gate-artifact-v2` only as an advisory — `workflow` (`scripts/ci/publish-gate.mjs`, `tests/guards/publish-gate.test.mjs`; run 44492036034)
- [A4] block mode requires a latest v2 pass marker, matching `base`/`diffSha`, a current-base `pre-merge`, valid metadata, and no reviewed-path overlap — `workflow` (`scripts/ci/publish-gate.mjs`; run 44498656133)
- [A5] `Policy Base` only publishes `action_required` after main advances — `workflow` (`.github/workflows/base-recheck.yml`, `tests/guards/base-recheck.test.mjs`)
- [A6] required `gate-artifact` has one publisher; the legacy workflow is retired — `workflow` (`tests/guards/review-gate.test.mjs`)
- [A7] docs/README changes are evidence-neutral; runtime changes still require E2E recording; docs-only review is not waived — `tests` (`tools/e2e-coverage.mjs`, `tests/guards/e2e-coverage.test.mjs`)
- [A8] no merge queue, merge train, file-domain lock, conflict notifier, or LLM conflict resolver is added — `workflow` (no queue or train workflow or repository setting exists; the boundary stays review-only)
