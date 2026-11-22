# Decision: head-bound heavy lane gate with mechanical coverage gaps

Status: implemented
Date: 2026-11-20
Class: process

## Problem

The PR gate runs `npm run check`, unit coverage, `pre-merge`, and the derived `gate-artifact`. The browser lane and keyless E2E are not part of it: `test:browser` and `test:coverage:layered` run locally or in `.github/workflows/heavy.yml`, which was `workflow_dispatch`-only because no head-bound heavy result existed. The work-item PR (#71) showed the cost: its browser and E2E gaps surfaced only when the heavy lane was rerun during review, so the missing scenarios were found and added one at a time instead of being visible when the PR opened. The flat 300s scenario budget also hid which real-model turn stalled until the lane was rebuilt around per-turn timeouts.

## Decision

**1. The coverage contract is mechanical.** `npm run check` rejects a non-blocked browser-owned `src/client/**/*.tsx` without a reviewed entry in `tools/coverage-browser-floors.json`, and rejects a live public surface without a keyless E2E scenario or reviewed debt entry in `tests/e2e/manifest.json` / `tests/e2e/coverage-debt.json`. The static half lives in `tools/coverage-gaps.mjs`, `tools/e2e-coverage.mjs`, and `tools/check-invariants.mjs`; `docs/testing.md` states the order: contract, gap report, heavy gate, review quality.

**2. `npm run coverage:gaps -- --base <ref>` is the gap report.** `tools/coverage-gaps.mjs` reuses the layered reports when their gate-artifact identity matches the current HEAD/base/diff/porcelain, otherwise runs the layered lane, then prints changed-file uncovered lines and changed public keys absent from the E2E manifest's `covers` lists. It writes only gitignored coverage data and never records release evidence.

**3. The heavy result is head-bound.** `scripts/ci/publish-heavy.mjs` writes `heavy-result.json` with head, base, current main, diff SHA-256, porcelain, every command exit, and the bounded observational `coverageGaps` report. It publishes the non-required `heavy-gate` commit status and the `heavy-gate-result` display check through `scripts/ci/heavy-contract.mjs`. A dirty pre-run or post-run tree, a mismatched head/base/diff, a non-ancestor base, or a missing/failing blocking command produces a blocked result instead of a success.

**4. Heavy runs from the default branch and tests the pull-request head.** `.github/workflows/heavy.yml` triggers automatically after CI for same-repository `agent/*` PRs, and keeps the `heavy` label and `workflow_dispatch` fallbacks. Fork PRs skip the self-hosted job. The workflow runs `typecheck`, `build`, host smoke, layered coverage, the observational `coverage:gaps` command, keyless E2E, and observational host-bash. The publisher, pre-run identity recorder, docs-only classifier, and pre-run artifact are executed from a temporary export of `refs/remotes/origin/main`, not from the PR checkout. Concurrency is keyed to the tested head SHA.

**5. Heavy publishes two PR-readable audit comments.** `.github/workflows/heavy-comment.yml` resolves the open PR and actual tested head, then `scripts/ci/publish-heavy-comment.mjs` creates or updates one `<!-- heavy-gate-summary -->` summary comment and, when a heavy result exists, one `<!-- coverage-gap-report -->` comment. The gap text originates in the heavy job and is untrusted: `publish-heavy.mjs` reads at most 64 KiB, strips terminal controls, limits it to 12,000 characters / 300 lines, and the comment publisher places it inside a code fence sized to contain its longest backtick run. Neither comment feeds `gate-artifact`.

**6. The derived gate consumes heavy without adding a second required context.** `scripts/ci/publish-gate.mjs` requires a same-head `heavy-gate` success and a `heavy-gate-result` summary with the same base and diff; it validates that the base is an ancestor of both the head and current main, that the worktree is clean, and that every blocking command exited 0. Docs-only changes are exempt. `gate-artifact` remains the only required context; `heavy-gate` is its input and is never added to the ruleset.

**7. Review remains the quality layer.** The gap report and `gate-artifact` own mechanical coverage discovery. `code-review` judges assertion meaning, negative controls, mock boundaries, declared unrun lanes, and whether a scenario would fail for the bug it claims to pin.

The follow-up [independent review and heavy orchestration](2026-11-20-independent-review-heavy-orchestration.md) keeps this single-gate shape and fixes the PR summary/review flow; it does not restore a second required context. Its single-comment wording predates the separate coverage-gap audit comment introduced here.

## Alternatives considered

**Add `heavy-gate` as a second required status context.** Lost because required contexts are unconditional: docs-only PRs, fork PRs, and PRs where the runner is down would all block on a check that cannot be produced, and every future change to the heavy lane would become a ruleset change. It also repeats the check-suite pollution already documented for required contexts.

**Run the browser and layered lanes on GitHub-hosted runners.** Deferred, not rejected. The lane packs `lib/`, starts `dsh web`, and drives Chromium; the repository has no evidence that a hosted runner can satisfy the host runtime, and the heavy lane exists precisely because the local checkout and installed app are available. Revisit if a hosted lane can run the same artifact identity.

**Trigger heavy on every `pull_request` event.** Lost because it lets arbitrary PR code execute on a self-hosted runner, including forks. The same-repository `workflow_run` trigger plus a maintainer label keeps the trusted-code boundary.

**Let code review find coverage gaps.** Lost because coverage is a mechanical fact and review is inconsistent at enumerating it; this is the approach that produced the step-by-step gap filling.

**Auto-generate and commit tests from the PR workflow.** Lost because it bypasses review on the reviewed head and needs write permissions in a job that runs PR code. Test generation stays in the implementing agent's workstream.

**Keep heavy manual and rely on the PR description's evidence.** Lost because nothing binds that text to the head, and the work-item PR demonstrated that the gaps are missed even when the evidence is written carefully.

**Put the coverage-gap text directly in the run log only.** Lost because reviewers read the PR, not the runner log. The separate marked comment makes the same bounded evidence visible without giving the gap report any gate authority.

## Consequences

- A non-docs PR without a valid same-head `heavy-gate` result is blocked by `gate-artifact`; a docs-only PR is exempt. A new commit invalidates the previous result and requires a new run.
- The heavy workflow executes pull-request code on a self-hosted runner. The trusted publisher, classifier, and identity recorder are exported from `main`; the test job has no PR write token. This remains a trust boundary to monitor.
- `coverage-gaps` and `e2e-bash` are observational: their exit codes are recorded, but they do not change the heavy verdict. The gap comment reports what the command produced; it does not prove that a test would catch a bug.
- Browser line coverage is not semantic coverage. The static floor check and gap report narrow the search; review keeps the assertion-quality judgement.
- Both PR comments are best-effort audit surfaces. A delayed or failed comment does not change `gate-artifact`; if the heavy result was never published, there is no gap data to comment on.
- `main` moving during a heavy run can make the result stale. The publisher rejects a base that is no longer an ancestor, and the gate recomputes when main advances.
- The comment publisher treats gap text as untrusted and bounds it, but a report can still be noisy or incomplete; it is not a substitute for reading the owning test.
- Revisit this decision if GitHub supports conditional required contexts, if a hosted browser/E2E lane proves viable, or if the heavy runner becomes unreliable enough that the gate needs a documented override.

## Testing

- [A1] The heavy publisher records head/base/current main/diff/porcelain/command exits and refuses success for a dirty or mismatched tree — `ci-workflow`: `tests/guards/heavy-gate.test.mjs`
- [A2] `gate-artifact` blocks a non-docs PR when `heavy-gate` is missing, failed, bound to another head, or bound to a stale base, and exempts docs-only changes — `workflow`: `tests/guards/publish-gate.test.mjs`
- [A3] Heavy auto-runs for same-repository `agent/*` PRs only after CI success, skips forks, keys concurrency to the head, and runs trusted-main publisher sources — `ci-workflow`: `tests/guards/heavy-workflow.test.mjs`, `tests/guards/heavy-gate.test.mjs`
- [A4] `npm run coverage:gaps -- --base <ref>` lists changed-file uncovered lines and changed surfaces missing from the E2E manifest without writing evidence — `browser`: `tests/guards/coverage-gaps.test.mjs`
- [A5] `npm run check` rejects a browser-owned TSX without a floor and a live public surface without keyless manifest coverage — `e2e`: `tests/guards/coverage-gaps.test.mjs`, `tests/guards/e2e-coverage.test.mjs`
- [A6] `docs/testing.md` states the order and the docs-only heavy exemption — `decisions`: `docs/testing.md`, `npm run check`
- [A7] The review procedure treats coverage discovery as gate-owned and confines itself to test quality and unrun-lane claims — `agent-skills`: `.agents/skills/code-review/SKILL.md`, `npm run check`
- [A8] Heavy runs the gap command observationally, publishes bounded gap data in the result, and creates or updates an idempotent audit comment without changing the gate — `ci-workflow`: `tests/guards/heavy-workflow.test.mjs`, `tests/guards/heavy-gate.test.mjs`, `tests/guards/heavy-comment.test.mjs`
