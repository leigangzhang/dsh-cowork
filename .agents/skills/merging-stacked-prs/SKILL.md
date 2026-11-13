---
name: merging-stacked-prs
description: Use when landing dependent GitHub pull requests, merging a PR whose base is another open PR, or when the task mentions a PR stack or dependent PRs
---

# Merging stacked PRs

Stacked PRs are an optional delivery shape, not a default. Use GitHub's official stack object when a real dependency chain exists; otherwise keep one topic per branch.

## When to use

Use when PR B must land after PR A and PR C must land after B, or when a PR's base is another open PR's branch. If the changes are independent, use ordinary single-topic branches and ordinary PR review instead.

## How

1. **Require native support.** Run `gh stack --version`; if the official extension or server-side stack feature is unavailable, stop and report rather than manually imitating a stack. Every branch in the chain must live in the same repository.
2. **Read the live chain.** Fetch current PR metadata and exact head OIDs: `number`, `author`, `baseRefName`, `baseRefOid`, `headRefName`, `headRefOid`, `state`, `isDraft`, `reviewDecision`, `mergeStateStatus`, and `statusCheckRollup`. Query `PullRequest.stack` and `stackEntry.position`; do not infer membership from base names alone.
3. **Link only when safe.** If a same-author chain is not yet linked, link it bottom-to-top with `gh stack link --base <trunk> <bottom-pr> <next-pr> ...`. If authors differ, ask before changing GitHub state; never reorder, dissolve, or rebuild an existing stack automatically.
4. **Refresh only when required.** Prefer GitHub's native cascading rebase or an explicit merge-forward through the stack. A rewritten layer invalidates old OIDs; after any sync, re-fetch heads and re-audit review threads, approvals, mergeability, and checks.
5. **Preflight the merge range.** Re-query the official stack immediately before merging. Require each selected PR to be open, non-draft, in the expected order, and compliant with this repository's review and check rules; a ready top layer does not prove its dependencies.
6. **Merge through the stack API.** Merge the whole stack with `gh stack merge <stack-number> --yes --merge`, or a requested prefix with `gh stack merge <boundary-pr> --yes --merge`. Do not pass `--delete-branch`, manually retarget dependents, or issue per-PR `gh pr merge` commands.
7. **Verify the landed state.** Wait until every selected PR reports `MERGED`; queued is not landed. For a partial merge, re-query the remaining stack and verify order, current heads, reviews, and checks. Delete a branch only after its PR is merged and `gh pr list --state open --base <branch>` returns `0`.

## Verification

- `gh stack --version` succeeds and the live metadata shows one stack with the expected bottom-to-top order.
- The selected PRs all report `MERGED` after `gh stack merge`.
- Remaining PRs still target the stack trunk or their immediate lower layer.
- Any branch deletion has zero open PRs using it as a base.

## Anti-patterns

- Manually merging and retargeting a stack one PR at a time.
- Inferring stack order from branch names or memory instead of the official stack object.
- Force-pushing a rewritten branch without re-auditing reviews and checks; raw `--force` is always forbidden here.
- Merging a draft, conflicted, or red PR because its parent is green.
- Deleting a branch before verifying the dependent PRs.
- Using a stack for independent changes that would be clearer as separate single-topic PRs.
