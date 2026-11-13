---
name: find-simplifications
description: Use when looking for dead, duplicated, speculative, or over-maintained behavior in dsh-cowork code, tests, configuration, scripts, or documentation, or when assessing a proposed deletion
---

# Find evidence-backed simplifications

Look for removable maintenance obligations, not for a target number of deleted lines. A candidate counts only after its producer, consumer, failure semantics, and lost capability are understood.

## When to use

Use for a simplification survey, a legacy-code cleanup proposal, or an assessment of someone else's deletion proposal. Do not treat a survey as permission to implement every candidate; substantial candidates need a proposal and the owning review.

## How

1. **Establish scope and constraints.** Read [AGENTS.md](../../../AGENTS.md), [docs/PLAN-V0.2.md](../../../docs/PLAN-V0.2.md), [docs/testing.md](../../../docs/testing.md), and the relevant implemented notes. Separate current product requirements from historical development scaffolding.
2. **Trace the complete effect path.** Search the exact symbol, config key, event name, wire field, and both `.method(` and `method(` forms. Read the producer, transformation, consumer, tests, and shipped entry point; a declaration or test that only exercises itself is not product use.
3. **Look for real obligations.** Candidates include a feature with no effect path, a distinction no consumer acts on, duplicated gate or store logic, speculative configuration, a compatibility layer whose data no longer exists, and a legacy driver superseded by a current E2E lane. Name the maintenance cost that disappears.
4. **Check compatibility and ownership.** Preserve durable/wire formats, failure reporting, cancellation, cleanup, security checks, and third-party extension points unless the proposal explicitly gives up that capability. Moving complexity to another owner is not a reduction.
5. **Record the trade-off.** For a substantial candidate, write a proposal with Problem, Proposal, Alternatives considered, Acceptance criteria, and Risks. State what is deleted, what remains, who consumes the replacement, and what capability is lost. Small local cleanups belong in an actionable TODO/FIXME comment, not a standalone record.
6. **Validate the removal.** Run the owning tests and coverage; for behavior changes also run the real host smoke or E2E lane. Confirm no generated, documented, or model-visible contract still references the removed item.

## Verification

- The proposal or PR names concrete producer/consumer evidence and the exact maintenance cost removed.
- Targeted tests, coverage, and the real entry path pass after deletion.
- No durable data, wire format, public command, security check, or documented extension path is silently broken.
- `npm run check` and any affected `npm run test:host-smoke` or E2E lane produce recorded results.

## Anti-patterns

- Equating “no local callers” with “safe to delete.”
- Scoring a simplification by line count or by the number of candidates.
- Adding a permanent gate merely to keep two duplicate definitions equal.
- Deleting a public or durable contract without recording the lost capability.
- Moving the same complexity behind a new adapter or “owner” and calling it a reduction.
- Treating an old screenshot, unused fixture, or archived note as current authority.
