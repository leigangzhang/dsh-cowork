---
name: pr-description
description: Use when creating or updating a dsh-cowork pull request description, including motivation, behavior changes, test design, actual test entries, and reviewable evidence
---

# PR description

Write the PR as evidence for a reviewer who has not followed the session. State only behavior the diff guarantees and tests cover; never present a plan or a self-report as a completed result.

## When to use

Use when opening a PR, moving a draft to ready, or updating a description after a behavior change, review round, or base update. This skill owns the description content; [.github/pull_request_template.md](../../../.github/pull_request_template.md) owns the section skeleton.

## How

1. **Start from the template.** Keep exactly `## Motivation`, `## Changes`, `## Testing`, and `## Evidence` in that order. Do not replace the headings with a prose narrative.
2. **Motivation.** State the problem in one sentence and reference the same-repository issue with `Fixes/Closes/Resolves #N` or `Refs #N`. A PR number is not an issue reference.
3. **Changes.** Separate interface changes (commands, scripts, config keys, exports, bundle/preset or persisted formats) from observable behavior changes (defaults, output, timing, errors, model-visible text). Write `None` where there are none; add a short review focus naming the riskiest seam.
4. **Testing.** Start with test design: behavior matrix for behavior changes, before/after values for performance, byte/snapshot comparison for refactors, and link/content checks for docs. Then list only tests actually run, with command and result; state every relevant check that did not run.
5. **Evidence.** Put reviewable facts in the `## Evidence` section: `change-scope` summary, HEAD and artifact identity, test counts, hashes, screenshots, or external state. Long output belongs in a collapsible block or an uploaded artifact, not as a wall of text.
6. **Update instead of appending.** When the PR changes, rewrite affected sections so they describe the current diff and current evidence; do not keep a chronological “round 1, round 2” history. Preserve media or text authored by a human.

## Verification

- Read the description back and confirm the four headings exist and every Changes item has a Testing or Evidence counterpart.
- Run the listed commands or confirm their recorded results; mark an unrun command in `Not run` rather than implying it passed.
- For a UI or packaging change, include the evidence required by the owning testing lane.
- Confirm the description does not contain secrets, tokens, machine-specific absolute paths, or unverified claims.

## Anti-patterns

- “This PR improves X” without a behavior, test, or evidence entry.
- Listing tests that were not run or implying local results are CI results.
- Turning the description into a diff walkthrough or a review-session transcript.
- Updating only the “latest changes” append and leaving earlier sections stale.
- Replacing a template heading with free-form prose.
