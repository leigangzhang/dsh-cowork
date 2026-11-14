---
name: pr-description
description: Use when creating or updating a dsh-cowork pull request description, including motivation, behavior changes, test design, actual test entries, and reviewable evidence
---

# PR description

Write the PR as evidence for a reviewer who has not followed the session. State only behavior the diff guarantees and tests cover; never present a plan or a self-report as a completed result.

## When to use

Use when opening a PR, moving a draft to ready, or updating a description after a behavior change, review round, or base update. This skill owns both the PR structure and the description content; there is no separate `.github/pull_request_template.md` file.

## How

### PR structure

Use this exact skeleton in this order. Do not replace the headings with a prose narrative.

```markdown
## Motivation

<!-- One sentence: what problem does this PR solve? Use Fixes/Closes/Resolves #N, or Refs #N for context. -->

## Changes

### Interface changes

<!-- Commands, scripts, config keys, exports, bundle/preset or persisted formats. Write None when there are none. -->

### Behavior changes

<!-- User-, model-, developer-, or system-visible behavior. State only what the diff and tests guarantee. Write None when there are none. -->

### Review focus

<!-- Name the riskiest seam or decision a reviewer should inspect first. -->

## Testing

### Test design

<!-- Behavior: scenario × before × after × owning test. Refactor: how unchanged behavior is pinned. Docs: how links/content are checked. -->

### Test entries

<!-- One line per test actually run: command, behavior covered, result. -->

### Not run

<!-- Name every relevant check that did not run, with the reason. Write None when all required checks ran. -->

## Evidence

<!-- Reviewable proof only: counts, artifact identity, file hashes, screenshots, or external state. -->
```

1. **Fill the title and Motivation.** State the problem in one sentence and reference the same-repository issue with `Fixes/Closes/Resolves #N` or `Refs #N`. A PR number is not an issue reference.
2. **Changes.** Separate interface changes (commands, scripts, config keys, exports, bundle/preset or persisted formats) from observable behavior changes (defaults, output, timing, errors, model-visible text). Write `None` where there are none; add a short review focus naming the riskiest seam.
3. **Testing.** Start with test design: behavior matrix for behavior changes, before/after values for performance, byte/snapshot comparison for refactors, and link/content checks for docs. Then list only tests actually run, with command and result; state every relevant check that did not run.
4. **Evidence.** Run `npm run change-scope -- --base <verified-base>` for the scope groups and `npm run gate-artifact -- --base <verified-base>` for HEAD, binary diff SHA-256, porcelain, and the same groups. Put that identity in the `## Evidence` section when the base or head changed, with test counts, hashes, screenshots, or external state. [docs/agent-teams.md](../../../docs/agent-teams.md) owns identity reuse and scope reconciliation. Long output belongs in a collapsible block or an uploaded artifact, not as a wall of text.
5. **Update instead of appending.** When the PR changes, rewrite affected sections so they describe the current diff and current evidence; do not keep a chronological “round 1, round 2” history. Preserve media or text authored by a human.

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
- Replacing a required heading with free-form prose, or creating a separate template file that duplicates this structure.
