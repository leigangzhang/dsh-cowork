# Proposal: Make the full heavy lane a head-bound merge gate with mechanical test-gap detection

Status: proposed
Date: 2026-11-20
Class: process

## Problem

The PR gate runs `npm run check`, unit coverage, `pre-merge`, and the derived `gate-artifact`. The browser lane and keyless E2E are not part of it: `test:browser` and `test:coverage:layered` run locally or in `.github/workflows/heavy.yml`, which is `workflow_dispatch`-only because no head-bound heavy result exists yet. The work-item PR (#71) showed the cost: its browser and E2E gaps surfaced only when the heavy lane was rerun during review, so the missing scenarios were found and added one at a time instead of being visible when the PR opened. The flat 300s scenario budget also hid which real-model turn stalled until the lane was rebuilt around per-turn timeouts.

Three facts cause the loop. The heavy result is not bound to a PR head, so it cannot be required. There is no mechanical statement of which changed surfaces need a browser or E2E scenario, so a gap is discovered by reading coverage output. Review is then expected to find the remaining gaps, which turns a judgement step into an inconsistent search step.

## Proposal

**1. State the coverage contract in `docs/testing.md` and enforce its mechanical parts in `npm run check`.** Every changed `src/client/**/*.tsx` must own a `tools/coverage-browser-floors.json` entry; every changed public surface (route, tool, preset, store status) must appear in at least one E2E scenario's `covers` list in `tests/e2e/manifest.json`; a new interactive surface must name the browser scenario that asserts it. The static half runs in `npm run check`, so an unregistered floor or an uncovered surface fails at PR open instead of during heavy.

**2. Add `npm run coverage:gaps -- --base <ref>`.** A new `tools/coverage-gaps.mjs` runs the browser lane and the layered lanes (reusing existing reports when their `gate-artifact` identity matches), parses `coverage/browser.lcov` and the unit report, and prints two lists: uncovered lines in files changed since `<ref>`, and changed surfaces missing from the manifest `covers`. The command is read-only and never records evidence.

**3. Publish the heavy result on the PR head.** A new `scripts/ci/publish-heavy.mjs` writes `heavy-result.json` (head, base, current main, binary diff SHA-256, porcelain, per-command exit codes) and publishes a `heavy-gate` commit status plus a display check run on the head. The publisher refuses success from a dirty tree, from a base that is no longer an ancestor of the head, or from a result whose head/diff does not match. `.github/workflows/heavy.yml` runs the full lane (typecheck, build, host-smoke, browser + layered coverage, keyless E2E, host-bash E2E marked observational so a missing sandbox backend cannot fail the required gate) and always publishes after the run.

**4. Trigger the heavy lane for same-repository PRs only.** `heavy.yml` gains a `workflow_run` trigger after CI completes for `agent/*` branches in this repository, plus the existing maintainer `workflow_dispatch` and an optional `heavy` label. Fork PRs never reach the self-hosted runner. Concurrency is keyed on the head SHA so a superseded run cannot publish for a newer head.

**5. Extend the derived gate instead of the ruleset.** `scripts/ci/publish-gate.mjs` `decideGate` adds a heavy input: a `heavy-gate` success for this head with an identity whose base is an ancestor of current main and whose diff SHA matches the current head; missing, failed, stale, or dirty means blocked with a named reason. Docs-only changes are exempt, using the classifier's `docs_only` output. The ruleset keeps exactly one required context, `gate-artifact`; `heavy-gate` is its input, not a second required check.

**6. Keep review as the quality layer.** The gap report and `gate-artifact` own mechanical coverage. `code-review` judges assertion meaning, negative controls, mock boundaries, declared unrun lanes, and whether a scenario would fail for the bug it claims to pin. Review is not the coverage detector.

**7. Roll out in stages.** Publish `heavy-gate` in observe mode first and compare its head/base identity with `gate-artifact` for one green cycle. Then make it a blocking input for non-docs PRs. Only after that, enable the automatic trigger and the optional bot comment that posts the gap report. Generated tests are written by the implementing agent in the normal workstream and pass review; no workflow commits tests to a reviewed head.

## Alternatives considered

**Add `heavy-gate` as a second required status context.** Lost because required contexts are unconditional: docs-only PRs, fork PRs, and PRs where the runner is down would all block on a check that cannot be produced, and every future change to the heavy lane would become a ruleset change. It also repeats the check-suite pollution already documented for required contexts.

**Run the browser and layered lanes on GitHub-hosted runners.** Deferred, not rejected. The lane packs `lib/`, starts `dsh web`, and drives Chromium; the repository has no evidence that a hosted runner can satisfy the host runtime, and the heavy lane exists precisely because the local checkout and installed app are available. Revisit if a hosted lane can run the same artifact identity.

**Trigger heavy on every `pull_request` event.** Lost because it lets arbitrary PR code execute on a self-hosted runner, including forks. The same-repository `workflow_run` trigger plus a maintainer label keeps the trusted-code boundary.

**Let code review find coverage gaps.** Lost because coverage is a mechanical fact and review is inconsistent at enumerating it; this is the approach that produced the step-by-step gap filling.

**Auto-generate and commit tests from the PR workflow.** Lost because it bypasses review on the reviewed head and needs write permissions in a job that runs PR code. Test generation stays in the implementing agent's workstream.

**Keep heavy manual and rely on the PR description's evidence.** Lost because nothing binds that text to the head, and the work-item PR demonstrated that the gaps are missed even when the evidence is written carefully.

## Acceptance criteria

- [A1] `heavy-gate` is published on the PR head with head, base, current main, diff SHA-256, porcelain, and per-command exits, and never reports success from a dirty or mismatched tree — `ci-workflow`
- [A2] `gate-artifact` blocks a non-docs PR when `heavy-gate` is missing, failed, bound to another head, or bound to a stale base, and exempts docs-only changes — `workflow`
- [A3] heavy runs automatically for same-repository `agent/*` PRs and never for fork PRs; concurrency is keyed on the head SHA — `ci-workflow`
- [A4] `npm run coverage:gaps -- --base <ref>` lists changed-file uncovered lines and changed surfaces missing from the E2E manifest without writing evidence — `browser`
- [A5] `npm run check` rejects a changed TSX without a browser floor and a changed public surface without manifest coverage — `e2e`
- [A6] `docs/testing.md` states the order (contract, gap report, heavy gate, review quality) and the docs-only heavy exemption — `decisions`
- [A7] the review procedure treats coverage discovery as gate-owned and confines itself to test quality and unrun-lane claims — `agent-skills`

## Risks

- A self-hosted runner executing same-repository PR code is a trust boundary; a compromised runner could read secrets. Mitigate with ephemeral workspaces, no repository secrets in the heavy job, the same-repository restriction, and the maintainer label during rollout.
- Making heavy blocking increases merge latency and flakiness surface. Mitigate with the observe-first rollout, concurrency keyed on head, a fast lane that runs browser + layered only, and a named reason when the runner is unavailable.
- Browser line coverage is not semantic coverage. The gap report narrows the search; it does not prove a scenario would fail for its bug. Review keeps that judgement.
- The host-bash lane is observational and can fail without a sandbox backend; the required result must treat it as observational rather than a hard failure.
- `main` moving during a heavy run can make the result stale; the publisher must reject a base that is no longer an ancestor and the gate must recompute when main advances.
- Revisit this decision if GitHub makes merge queues available for user-owned repositories, if a hosted browser/E2E lane proves viable, or if the heavy runner becomes unreliable enough that the gate needs a documented override.

## Delivery stages

1. Coverage contract and gap report: `docs/testing.md`, `tools/coverage-gaps.mjs`, `npm run coverage:gaps`, the static `npm run check` additions, and `tests/guards/coverage-gaps.test.mjs` — makes a missing scenario visible before the PR is opened.
2. Head-bound publisher in observe mode: `scripts/ci/publish-heavy.mjs`, `.github/workflows/heavy.yml`, `heavy-result.json`, `tests/guards/heavy-gate.test.mjs` — makes the heavy result an auditable status without blocking merge.
3. Gate input: `scripts/ci/publish-gate.mjs` `decideGate`, `tests/guards/publish-gate.test.mjs`, and the docs-only exemption — makes the heavy result required for non-docs PRs, with `gate-artifact` still the only required context.
4. Automatic trigger and gap-report comment: same-repository `workflow_run` trigger, optional `heavy` label, optional PR comment from the gap report — removes the manual dispatch step without letting workflows write tests.
