# AgentTeams operating rules

Audience: AgentTeams captains and members working in this repository. Read this before creating a team plan or accepting a task. These rules extend [AGENTS.md](../AGENTS.md) and refine the AgentTeams protocol; they do not replace either.

## Build the DAG

Use the smallest DAG that can prove the change. Every quality task (`requirements`, `implementation`, `verification`, `review`, `repair`, or `integration`) states its objective and acceptance criteria. Implementation and repair tasks also state `inScope` and `verify`. `inScope` uses explicit paths, never globs.

A quality-mode run uses this sequence:

1. `impact-scan` (`work`) starts first. It searches the tests, guards, and configuration that reference the changed symbols, and checks file budgets.
2. `requirements` (`requirements`) is optional and follows the impact scan.
3. Implementation tasks (`implementation`) follow the impact scan, and the requirements task when one exists. Parallel implementations use disjoint `inScope`, an explicit `worktreePath`, and a base commit verified before writing starts.
4. `integration-ready` (`work`, not `integration`) depends on every implementation and pre-merge repair. It merges, builds, injects once, reaches health, writes the readiness marker and gate artifact identity, then messages the verifier.
5. `fast-contract` (`work`) may run alongside `integration-ready`. It runs deterministic, host-free tests with no LLM calls.
6. `verification` (`verification`) depends on both `integration-ready` and `fast-contract`.
7. `review` (`review`) depends on verification and sets `reviewedTaskId` to the latest implementation. It runs in an isolated copy, and the implementer is never the final reviewer.
8. `batch-cleanup` (`repair`) collects all review findings and the required documentation and record updates. Its subject names the batch.
9. `final integration` (`integration`) depends on every required review and on batch cleanup. `delivery` (`integration`) depends on final integration.
10. `delivery` is a task, not a chat message. It merges, pushes, opens the PR, and records final HEAD, artifact SHA-256, `git status`, and the branch or PR URL.

Give every required contributor a task or an explicit message. When a profile already supplies a roster or tasks, use that supply instead of recreating it in task prose.

## Readiness and gate artifacts (R1, R3, R4)

- Readiness comes from task completion or a direct message, not a 10-second file poll. If a readiness marker must be polled, cap the wait at 60 seconds and record why. The DAG must show `verification` depending on `integration-ready`.
- Implementation tasks run only their targeted `verify`. The four repository checks (check, test, typecheck, and build) run once at `integration-ready`; the verifier independently runs them once, then one real E2E. Do not run the full suite in every worktree, feature branch, or member before that gate.
- The first verification run records a gate artifact with `npm run gate-artifact -- --base <verified-base>`: candidate HEAD, the SHA-256 of the `base..HEAD` binary diff, porcelain status, and the four `change-scope` path groups. Reuse evidence while that identity is unchanged; rerun when any field changes.
- Reconcile the artifact's committed, staged, unstaged, and untracked path groups against every implementation task's `inScope` union. An out-of-scope path is allowed only as an explicit exception named in the task contract; the reviewer checks the exception, not the member's summary.
- In an isolated copy or worktree, a reviewer may execute commands through a read-only policy such as `verify-only`. If the reviewer cannot execute, report a static review and never present the verifier's results as its own run.
- Build incrementally, and inject or reload once per gate. Use a fixed test host and port, and use health or readiness state rather than blind re-injection. If a stale fiber appears, record the evidence; perform one clean re-injection only when necessary and record why. Do not let the stale fiber keep serving.
- A member report is evidence, not fact. The captain rechecks critical claims against the artifact or command output before acting on them.

## Impact scan, parallel writes, and merge (R6)

- Before dispatch, search for tests, guards, and configuration that reference every changed symbol or constant. Check the file budget. Put every existing test that must change into `inScope`; discovering it after dispatch is a planning defect.
- Parallel writes begin only after the base commit passes verification. Every writer receives disjoint explicit paths and a `worktreePath`. The captain merges serially and may use a merge queue; the final merge decision and quality gate remain the captain's.
- Implementation reports list `changedPaths`; every path must fall inside that task's `inScope`. After dispatch, no changed test file may fall outside the declared scope.
- Targeted prechecks may run in parallel. Pre-merge fixes land before `integration-ready`, never while the verifier is waiting.

## Fast tests and real E2E (R2, R5)

- For problems that only a real host exposes, such as review-request or verdict races, stale tool schemas, and client cache behavior, first write a deterministic host-free or fake-host test with no LLM calls. Run the real E2E only after that test passes.
- After two same-shape E2E failures, stop identical reruns. Codify the failure as a fast test or assertion, fix it, then run the real E2E once. Each failed attempt leaves a finding and a regression test. Keep only the final passing run.
- Documentation-only changes do not run E2E. Code changes that affect review, merge, client behavior, or plugin loading get one complete E2E after fixes. A documentation-only change runs `npm run check`.
- Wait on events or terminal task states, not 10-second polling. Give every step a fail-fast timeout. Independent browser sessions may run in parallel when their work is safe to overlap.

## Browser verification and panel fixtures (R8, R9)

Before using the browser:

- Confirm that the host health endpoint returns 200, `/api/cowork.overview` returns 200, and the BrowserSkill extension is connected. If any check fails, fix the host or perform a clean injection first. Do not restart the browser to hide a backend failure.
- Reuse one long-lived session and tab. Do not stop and start the browser for each step. Reopen at most once after a reload or extension failure, and record the reason.
- Use a dedicated small profile, session, and test repository. Do not load a user's large session list or long transcript. Prefer `data-testid` or stable selectors. When a target moves, sync once and then click; do not retry blindly.
- Treat screenshots as evidence. Do not repeatedly inspect the same state. Stop the session when the check finishes.
- Acceptance: one verification uses at most 10 `bsk_session` calls, and no sleep or API wait exceeds 60 seconds.

For panel fixtures:

- Do not edit the real `.dsh-cowork` data while the host is serving panel requests. Prefer a fixture repository or an isolated `DSH_HOME`, profile, and port; otherwise stop the host first. If the real data must be touched, complete apply and restore as one operation and verify the hashes.
- Fixture scripts write only the fixture data directory, through direct filesystem calls. They do not call the host API or wait on the project lock. Back up before apply, make restore idempotent, and do not put Markdown in the data directory ([KI-13](KNOWN_ISSUES.md)).
- Fix host health and API behavior before measuring fixture timings. Host event-loop or result-delivery latency is not fixture I/O evidence.
- Acceptance: apply and restore each finish within 5 seconds, the real index is restored with its hash and topic count, and screenshots come from the fixture view.

## Review, repair, final integration, and delivery (R10)

- Reviewer method: load [code-review](../.agents/skills/code-review/SKILL.md) before opening the diff; it owns `change-scope`, evidence selection, review priorities, and finding format. This section owns the DAG and verdict only.
- Review and requirements tasks complete only with `verdict=pass`. `needs_revision` and `reject` fail with findings. Each finding names a relative path and line and the required fix.
- Batch all review findings into one repair task. Do not derive a repair task from each low-risk comment, and do not trigger a full re-review for each finding.
- If the repair batch changes behavior, restart at `integration-ready`, then repeat verification and review. If it changes only comments or documentation, run `npm run check`, the owning targeted tests, and a delta review.
- After final `integration-ready`, only documentation and records may change. A required behavior change restarts `integration-ready`, then verification, then review.
- Final integration runs the four checks for a behavior change. Otherwise it runs `npm run check` and a delta review. Do not start delivery until review passes and final integration completes.
- Close a failed task with `supersededBy` or an output summary. Use the quality kinds `verification`, `review`, `repair`, and `integration` for their named stages; do not substitute `work`.
- When a gate fails, decide whether the contract or the code is wrong. If the objective, acceptance, `verify`, or `inScope` cannot be satisfied honestly, amend the task contract and record the reason; never bypass the gate, weaken a check, or rerun the same evidence hoping for a different result.

## Closeout records (R7)

Review these fields at each AgentTeams closeout and record them:

- `integration-ready` start and end times;
- marker wait;
- E2E attempts and duration;
- number of full four-check runs;
- inject count;
- gate artifact identity;
- failure causes.

Targets are a verifier wait of at most 300 seconds, a marker wait of at most 60 seconds, zero failed E2E reruns, and team wait or background time of at most 800 seconds. If a process does not reduce waiting, keep the previous process and record why. Never fabricate evidence or reduce validation coverage to meet a target.

## Authority

Predefined profiles own roles, model tiers, tool policies, and short protocols. This file owns the DAG, impact scan, gate artifact, worktree, review, and delivery details. When they conflict, this file overrides the profile template. A user instruction overrides this file; record the exception in the affected task.

Every task contract that depends on integration names `integration-ready` as a dependency. Every task that runs a real E2E names its `fast-contract` prerequisite.
