# Decision: One required gate over independent review and heavy evidence

Status: implemented
Date: 2026-11-20
Class: process

## Problem

The workstream used to open a PR, wait for CI and pre-merge, and only then ask for an independent review. The derived `gate-artifact` was already event-driven, but review was not: the user had to notice a blocked gate, request review in the session, wait for the reviewer to post a PR comment, and only then merge. Heavy auto-ran after CI, but its result was visible only as a commit status, a check run, and runner logs; the PR itself had no readable summary comment. The cost was orchestration delay, not a missing check.

This record extends [the head-bound heavy gate proposal](2026-11-20-heavy-lane-head-bound-gate.md) and supersedes its single-gate rollout assumptions. The head-bound `heavy-gate` result, the auto trigger, and the single-gate input are implemented. This record fixes the remaining review orchestration and comment surface, and freezes the decision to keep one required context.

## Decision

**1. One required context remains.** `gate-artifact` is the only required gate and is carried by a commit status. `gate-artifact-v2` remains a non-required display check; it is not renamed, split, or added to the ruleset. Review and heavy are independent evidence flows that feed the composite decision.

**2. Opening a PR starts review.** When delivery opens a PR, the captain immediately creates a fresh independent `review` task on the current head. The reviewer loads [code-review](../../../../.agents/skills/code-review/SKILL.md), checks the diff and evidence, and posts `review-verdict:v2` on the PR. The implementer never supplies the final verdict. A new commit invalidates the old verdict and creates a new review task; an old verdict is not reused.

**3. Heavy runs from trusted main.** Same-repository `agent/*` PRs trigger heavy after CI success; fork PRs skip; the `heavy` label and manual dispatch remain fallbacks. The workflow runs tests in the PR checkout, but the result publisher, pre-run identity recorder, and docs-only classifier execute from a temporary `git archive` of `refs/remotes/origin/main`. The workflow records and logs the actual `trusted_sha`; there is no dispatch input that points those scripts at the PR checkout. Base resolution records the refreshed `origin/main` SHA and computes the merge-base in the local source checkout. Docs-only heads stop before dependency installation and the full lane.

**4. Heavy publishes a separate PR summary.** `.github/workflows/heavy-comment.yml` runs on `Heavy` completion from a trusted `main` checkout with only `pull-requests: write`; it never executes PR code. `scripts/ci/publish-heavy-comment.mjs` resolves the unique open PR for the run head, reads the published `heavy-gate` status and `heavy-gate-result`, and creates or updates one comment carrying `<!-- heavy-gate-summary -->`. The comment includes head, base, current main, diff SHA-256, worktree state, command exits, failure reasons, and the run URL. It skips a run with no open PR or a successful docs-only run with no heavy result, and still writes a failure summary when heavy failed before publishing a result. The comment is audit-only and never feeds the gate.

**5. Gate composition and merge stay explicit.** Non-docs PRs need the review marker and a valid heavy result; docs-only PRs remain heavy-exempt. `gate-artifact-v2` keeps the complete combined reasons, review identity, heavy identity, and component errors. The gate recomputes on PR, review, CI, and pre-merge events. After heavy publishes, `Heavy Comment` resolves the PR and dispatches `Policy V2` with `pr_number`; `Policy V2` remains the only gate publisher. It does not listen for `Heavy` completion because a `workflow_run` from Heavy carries the default-branch run metadata, not the PR head. Merge remains manual.

## Alternatives considered

**Two independent required checks, one for review and one for heavy.** Lost because required contexts are unconditional: docs-only PRs, fork PRs, and runs where the self-hosted runner is offline would all get a missing required check. It also loses one merge-box explanation and makes every workflow redesign a ruleset change.

**Split the required context and rename `gate-artifact-v2` to `gate-artifact`.** Lost because the existing required context is already a commit status named `gate-artifact`; renaming the display check would collide and reverse the transport decision that moved the required context from check runs to a single commit status. It would also require a ruleset and app-identity migration without adding a merge decision.

**Run an automated review bot inside GitHub Actions.** Deferred, not rejected. It needs provider credentials, a trusted execution environment, and a headless review procedure that does not run untrusted PR code with write access. A fresh local AgentTeams reviewer delivers the same independence with fewer secrets and less blast radius today.

**Run the heavy summary from the heavy test job.** Lost because that job executes PR code. Granting it `pull-requests: write` would let a branch alter the publisher while holding the comment token. A separate trusted-main workflow keeps the write token out of the test job.

**Leave heavy results only in the status, check, and runner log.** Lost because a reviewer or maintainer cannot see the result and failed command in the PR conversation. A single idempotent summary comment preserves the audit trail without adding a required check or a second source of truth.

**Run heavy before CI completes.** Lost because the current trust boundary uses CI success and a same-repository head; running earlier would either execute more unverified code or require a second gating policy. `heavy` label and manual dispatch remain available when an operator deliberately wants an early run.

## Consequences

- Repeated gate evaluations overwrite one `gate-artifact` status on the head; `gate-artifact-v2` remains display-only.
- Review starts before CI finishes, but the gate still waits for the current head's CI, pre-merge, and heavy evidence. The merge remains manual.
- Heavy tests still execute the PR head. The publisher, classifier, and pre-run identity are trusted-main code; the separate comment workflow adds the only PR write token and never checks out the PR.
- Docs-only PRs occupy only the refresh/checkout/base/classify steps. A failed classify step leaves later steps enabled so the run fails visibly rather than silently skipping.
- `Policy V2` no longer listens to `Heavy`. A `workflow_run` from Heavy reports the default-branch run metadata, so the gate could not resolve the PR head; `Heavy Comment` instead dispatches `Policy V2` with the resolved PR number after the heavy result and summary exist. This keeps one gate publisher and avoids a second writer racing the required status.
- The heavy comment can be delayed or fail without changing the gate. It is best-effort audit evidence and links the run for investigation; no consumer parses it.
- `workflow_run` for the comment workflow and the automatic heavy trigger only run from the default branch. The first post-merge PR verifies that chain; before merge, the workflows were exercised by manual dispatch or local publisher tests.
- The first review of this rollout found a PR-checkout publisher with a write token, a stale local-main base, and missing docs-only short-circuit. Those are fixed; the follow-up guard tests pin them.
- `fallow health --baseline` remains a separate maintenance item; this change does not refresh the baseline.
- Revisit this decision if GitHub supports conditional required contexts, or if a hosted reviewer can run with stronger isolation and without repository secrets.

## Testing

- [A1] `gate-artifact` remains the only required context; `gate-artifact-v2` remains a non-required display check with the complete combined reasons and component identity — `workflow`: `tests/guards/publish-gate.test.mjs`
- [A2] Review and heavy are independently produced and tested as inputs to one composite decision; docs-only PRs skip heavy and a new head invalidates old review/heavy evidence — `tests`: `tests/guards/publish-gate.test.mjs`, `npm test`
- [A3] Heavy auto-runs for same-repository `agent/*` PRs only after CI success, skips forks, keeps label/manual fallbacks, resolves the refreshed `origin/main`, runs trusted-main scripts, and short-circuits docs-only heads — `ci-workflow`: `tests/guards/heavy-workflow.test.mjs`, `tests/guards/heavy-gate.test.mjs`
- [A4] Heavy completion creates or updates one marked PR summary from a trusted-main workflow that holds only `pull-requests: write` and `actions: write`, skips no-PR/docs-only runs, reports failures, and dispatches `Policy V2` with the PR number — `ci-workflow`: `tests/guards/heavy-comment.test.mjs`, `tests/guards/heavy-comment-workflow.test.mjs`
- [A5] Opening a PR starts an independent review task on the current head, and a new commit requires a new verdict instead of reusing the old one — `agent-skills`: `docs/agent-teams.md`, `AGENTS.md`, `npm run check`
- [A6] The gate, heavy runbook, and testing contract state the single-gate architecture, docs-only exemption, trusted publisher boundary, comment workflow, and manual merge step — `plan-docs`: `docs/github-workflow.md`, `docs/heavy-runner.md`, `npm run check`
