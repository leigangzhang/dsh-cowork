---
name: pre-push-checks
description: Use before pushing, opening or updating a PR, or claiming checks pass on a dsh-cowork branch, to select the smallest evidence that covers the outgoing change
---

# Pre-push checks

Select evidence from the outgoing diff, not from habit. The full suite is not a universal local baseline; it is an explicit exception for broad or cross-cutting changes.

## When to use

Use this skill immediately before a commit that will be pushed, before marking a draft PR ready, and after a rebase or base update rewrites the reviewed range. Use the `code-review` skill when the task is to judge correctness rather than to choose and run evidence.

## How

1. **Freeze the outgoing range.** Run `git status --short --branch`, verify the live PR base or parent branch, and fetch it. Run `npm run change-scope -- --base <verified-base>`; account for committed, staged, unstaged, and untracked paths.
2. **Select the owning evidence.** Map the paths through [tools/workflow.json](../../../tools/workflow.json). Use focused `node --test tests/<owning>.test.mjs` for a narrow test change, then add `npm test` / `npm run test:coverage` when the change crosses a behavior or coverage surface.
3. **Bound the evidence.** For `src/` changes run `npm run test:coverage`, `npm run typecheck`, `npm run build`, and `npm run test:host-smoke`. For packaging or bundle changes, also run `npm test` and `npm run check`. For docs-only changes, run `npm run check`.
4. **Keep the local lib current.** `lib/` is gitignored build output. After changing `src/`, rebuild before packaging or host smoke; a stale local `lib/` is not detected by source hashes. Do not treat a hand-written `lib` edit as equivalent to a build.
5. **Run the full local rehearsal only when it is justified.** Use it when the user explicitly asks, when diagnosing a CI failure, or when the change spans packaging, workflow, and runtime surfaces so widely that no narrower set is credible.
6. **Push safely.** Stage only the files owned by this change; scan the staged diff with `gitleaks protect --staged --redact --no-banner`. Do not use `--force`, `--force-with-lease`, or hook bypasses. After pushing, verify `git rev-parse HEAD` equals `git rev-parse origin/<branch>`.

## Verification

- `npm run change-scope -- --base <verified-base>` covers every outgoing path.
- The selected commands ran once after the latest edit and their exit codes are recorded.
- `lib/` was rebuilt after the last `src/` edit when packaging or host smoke is claimed.
- `git status --short` contains only intended changes; staged files have no secrets.
- The final report names every check that did not run and why.

## Anti-patterns

- Running the full suite before every push “just in case.”
- Repeating a passing check because a commit or push follows.
- Pushing while a red check is still explained only by the self-report.
- Editing `lib/` directly or claiming a host-smoke result without rebuilding after the last source edit.
- Using force, force-with-lease, or `--no-verify` to bypass a push problem.
- Treating a green local check as proof that the remote/CI matrix is green.
