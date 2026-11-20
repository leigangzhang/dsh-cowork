# Decision: required gate-artifact is a commit status

Status: implemented
Date: 2026-11-19
Class: process

## Problem

Two consecutive docs-only pull requests reached a green `gate-artifact` check run but stayed `BLOCKED` with GitHub showing `Expected — Waiting for status to be reported`. The publisher created a completed check run through the Checks API on every PR, review, and `workflow_run` event. GitHub attached those runs to the earliest Actions check suite on the head, while newer workflow runs kept creating newer suites without the required context. The merge box could therefore omit the later success even though `gh pr checks --required` and the Checks API both reported it as passed.

A check run is the wrong carrier for a required context that is republished by many independent runs. The gate needs a single mutable slot per head.

## Decision

**1. The required context is a commit status.** `scripts/ci/publish-gate.mjs` writes `gate-artifact` through `POST /repos/{owner}/{repo}/statuses/{head}`. The status is the merge gate. It is written as `pending` before evaluation, then overwritten with `success`, `failure`, or `error`. A blocker is expressed by the status, not by failing the publisher job.

**2. The check run is display-only.** The same publisher writes a non-required `gate-artifact-v2` check run that mirrors the decision on the Checks page. It never appears in the ruleset. The workflow tries a dedicated GitHub App token for this display check and falls back to the job token when the App variables are absent; the required status always uses the job token so its source stays GitHub Actions.

**3. Base invalidation writes the same status.** `scripts/ci/base-recheck.mjs` writes `pending` for `gate-artifact` and marks the `gate-artifact-v2` display check `action_required` after `main` advances. It never writes `success`.

**4. The ruleset keeps one required context.** `main` requires `pr-gate` (check run) and `gate-artifact` (commit status from GitHub Actions). `gate-artifact-v2` is never required.

**5. The workflow remains trusted.** `.github/workflows/gate-artifact-v2.yml` still checks out `main` and runs only trusted scripts. `workflow_run` remains a valid trigger because a commit status targets the pull-request head regardless of the workflow run's own `head_sha`.

This record supersedes the check-run transport in [2026-11-17-pre-merge-derived-gate](2026-11-17-pre-merge-derived-gate.md); the gate inputs, report/block modes, and review identity rules from that record remain in force.

## Alternatives considered

**Native `gate-artifact` job in a head-scoped workflow.** A native job check run is attached to the current run's suite, but the gate also depends on `pr-gate` and `pre-merge` from other workflows. Handling their completion would require polling or an indirect label/dispatch loop, and `workflow_run` native checks land on `main`, not the pull-request head.

**Dedicated GitHub App check run as the required context.** This stabilises the App's check-suite association, but still leaves a mutable required check run per head, requires App registration and secrets, and reproduces the same class of failure if the App suite is not the one the merge box evaluates. The App token is kept only as an optional display-check improvement.

**Commit status without an app constraint.** A context-only requirement can be satisfied by any integration that writes the same context. The ruleset keeps the GitHub Actions source constraint so another actor cannot spoof the gate.

**Keep the check-run publisher and rely on `recheck`.** A `recheck` rerun produced another success but did not clear the merge box; the failure is structural, not a missing event.

## Consequences

- Repeated evaluations overwrite one `gate-artifact` status on the head; there is no same-name required check-run accumulation and no dependency on check-suite ordering.
- The required status is briefly `pending` during each evaluation, so the merge box may show a wait instead of the previous success. That is intentional: an interrupted evaluation must not leave a stale success.
- The display check is best-effort. A missing App token, failed App step, or failed display write does not change the gate; only a failed status write is fatal.
- The ruleset must continue to accept the `gate-artifact` context from GitHub Actions. If GitHub changes how rulesets match statuses or the Actions integration id changes, revisit this record.
- The publisher still does not execute pull-request code and still requires a same-repository `agent/<topic>` branch when `workflow_run.pull_requests` is empty.

## Testing

- [A1] `publish-gate.mjs` writes the required `gate-artifact` status and the non-required `gate-artifact-v2` display check — `source`: `tests/guards/publish-gate.test.mjs`
- [A2] `base-recheck.mjs` writes `pending` for the required status and `action_required` for the display check — `source`: `tests/guards/base-recheck.test.mjs`
- [A3] The Policy V2 and Policy Base workflows grant `statuses: write`, keep the display-check App step pinned, and retain the trusted `main` checkout — `ci-workflow`: `tests/guards/policy-v2-workflow.test.mjs`, `tests/guards/review-gate.test.mjs`
- [A4] Repository conventions and the full suite stay green — `tests`: `npm run check`, `npm test`, `npm run test:coverage`
