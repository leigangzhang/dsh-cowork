# Proposal: One required gate over independent review and heavy evidence

Status: proposed
Date: 2026-11-20
Class: process

## Problem

The current workstream opens a PR, waits for CI and pre-merge, and only then asks for an independent review. The derived `gate-artifact` is already event-driven, but review is not: the user must notice a blocked gate, request review in the session, wait for the reviewer to post a PR comment, and only then can merge. Heavy auto-runs after CI, but its result is visible only as a commit status, a check run, and runner logs; the PR itself has no readable summary comment. The cost is orchestration delay, not a missing check.

This record extends [the head-bound heavy gate proposal](2026-11-20-heavy-lane-head-bound-gate.md). The head-bound `heavy-gate` result, the auto trigger, and the single-gate input are already implemented on `agent/heavy-gate-proposal`; this record fixes the remaining review orchestration and comment surface, and freezes the decision to keep one required context.

## Proposal

Keep exactly one required context, `gate-artifact`, carried by a commit status. Keep `gate-artifact-v2` as the non-required display check and do not rename or split it. Treat review and heavy as independent evidence flows that feed the composite gate.

- **Automatic review dispatch.** After the implementing agent creates a PR, the same workstream automatically creates an independent review task with a fresh context or reviewer member. The reviewer runs [code-review](../../../../.agents/skills/code-review/SKILL.md), checks the PR head, posts `review-verdict:v2` as a PR comment, and reports findings. A new commit invalidates the old verdict and automatically dispatches review for the new head. The implementer never supplies the final verdict.
- **Heavy execution and comment.** Same-repository `agent/*` PRs trigger heavy after CI success; fork PRs skip; `heavy` label and manual dispatch remain fallbacks. The workflow runs tests in the PR checkout, but the result publisher, pre-run identity recorder, and docs-only classifier execute from a temporary export of trusted `main`, not from author-controlled files in that checkout. Docs-only heads stop before dependency installation and the full lane. Heavy publishes `heavy-gate` and `heavy-gate-result`, then a separate trusted publisher job posts one idempotent PR summary comment containing head, base, current main, diff SHA-256, result, per-command exits, failure reasons, and run URL. The job that runs PR code never receives `pull-requests: write`.
- **Gate composition.** Non-docs PRs need the review marker and a valid heavy result; docs-only PRs remain heavy-exempt. `gate-artifact-v2` keeps the complete combined reasons, review identity, heavy identity, and component errors. The gate recomputes on PR, review, CI, pre-merge, and Heavy completion events. Merge remains manual.
- **Expected surfaces.** `.github/workflows/heavy.yml`, a comment publisher under `scripts/ci/`, `.github/workflows/gate-artifact-v2.yml`, `scripts/ci/publish-gate.mjs`, `.agents/skills/code-review/SKILL.md`, `docs/github-workflow.md`, `docs/heavy-runner.md`, and `docs/testing.md`.

## Alternatives considered

**Two independent required checks, one for review and one for heavy.** Lost because required contexts are unconditional: docs-only PRs, fork PRs, and runs where the self-hosted runner is offline would all get a missing required check. It also loses one merge-box explanation and makes every workflow redesign a ruleset change.

**Split the required context and rename `gate-artifact-v2` to `gate-artifact`.** Lost because the existing required context is already a commit status named `gate-artifact`; renaming the display check would collide and reverse the transport decision that moved the required context from check runs to a single commit status. It would also require a ruleset and app-identity migration without adding a merge decision.

**Run an automated review bot inside GitHub Actions.** Deferred, not rejected. It needs provider credentials, a trusted execution environment, and a headless review procedure that does not run untrusted PR code with write access. A fresh local AgentTeams reviewer delivers the same independence with fewer secrets and less blast radius today.

**Leave heavy results only in the status, check, and runner log.** Lost because a reviewer or maintainer cannot see the result and failed command in the PR conversation. A single idempotent summary comment preserves the audit trail without adding a required check or a second source of truth.

**Run heavy before CI completes.** Lost because the current trust boundary uses CI success and a same-repository head; running earlier would either execute more unverified code or require a second gating policy. `heavy` label and manual dispatch remain available when an operator deliberately wants an early run.

## Acceptance criteria

- [A1] `gate-artifact` remains the only required context; `gate-artifact-v2` remains a non-required display check with the complete combined reasons and component identity — `workflow`
- [A2] Review and heavy are independently produced and tested as inputs to one composite decision; docs-only PRs skip heavy and a new head invalidates old review/heavy evidence — `tests`
- [A3] Heavy auto-runs for same-repository `agent/*` PRs only after CI success, skips forks, and keeps `heavy` label plus manual dispatch as fallbacks — `ci-workflow`
- [A4] Heavy completion posts one idempotent PR summary comment from a separate job that does not run PR code with write permission — `ci-workflow`
- [A5] A PR automatically receives an independent review task on its current head, and a new commit re-dispatches review instead of reusing the old verdict — `agent-skills`
- [A6] The gate, heavy runbook, and testing contract state the single-gate architecture, docs-only exemption, comment publisher boundary, and manual merge step — `plan-docs`

## Risks

- Automatic review adds model and token cost and can become a rubber stamp. Mitigate with a fresh context, a mandatory code-review procedure, concrete findings, and no implementer verdict.
- The summary publisher needs `pull-requests: write`. Keep it in a separate job that reads the published status/check and never checks out or executes PR code; use an idempotent hidden marker so retries update one comment.
- Heavy comments may duplicate `gate-artifact-v2` content. The comment is the PR-readable run summary; the display check remains the machine-readable composite reason. Keep one marker and link the run.
- Auto-triggering and the Heavy-completion gate recompute only take effect after the workflow lands on the default branch. Until then, label and manual dispatch are the tested path.
- Revisit this decision if GitHub supports conditional required contexts, or if a hosted reviewer can run with stronger isolation and without repository secrets.

## Delivery stages

1. Land this record and the updated workflow/runbook language; keep the existing observe and gate results as evidence.
2. Add the heavy summary comment publisher, its idempotent update test, and a separate `pull-requests: write` job that does not execute PR code.
3. Add automatic review dispatch to the AgentTeams workstream procedure, then verify a fresh PR gets a review marker before the user asks and receives a heavy summary after the run.
