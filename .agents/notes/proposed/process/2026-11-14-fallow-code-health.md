# Proposal: Adopt fallow as a reviewed code-health signal

Status: proposed
Date: 2026-11-14
Class: process

## Problem

The repository already gates runtime exports (export audit), import direction and cycles (architecture test), file size (source budget), and unused locals/parameters (tsc). A fallow 3.43.0 run still found classes those gates cannot see: type-only exports outside the audit, exports of `tools/`/`scripts/` modules, unused class members, unowned dev scripts, duplicate symbol names, and no full-function complexity or duplication baseline. At zero config the run also mixed known noise into 118 findings: host-provided peer imports, the external `react` import, and a `new URL(..., import.meta.url)` lazy edge that the static graph proves is not a cycle.

## Proposal

Commit `.fallowrc.jsonc` with one reviewed reason per ignore, keep fallow as the local CLI (no `devDependency`, no lockfile, version 3.43.0 recorded), and use fallow as a reviewed signal rather than a second full-repo gate:

1. Extend the existing export audit to audit re-exports from the host entry (`src/app/apply.ts`); keep its declarations exempt.
2. Keep the 72 over-exported exports as an advisory warning; do not add a ratchet.
3. Use `fallow dead-code --unused-types` only as review evidence; do not extend the textual audit or add a type gate.
4. Apply fallow's default health thresholds (CC > 20, cognitive > 15, CRAP > 30, unit > 60) to all functions, with the 123-finding run as the reviewed baseline; duplication stays a change-level rule.
5. Analyse `scripts/build/` with `"ignorePatterns": ["!scripts/build/**"]`.
6. Unify `NOTICE_TITLE_MAX_CHARS` at 100 in its three homes.
7. Run `fallow audit --base <verified-base>` when reviewing a change, and re-baseline after a fallow upgrade.

## Alternatives considered

**Adopt fallow as a full-repo CI gate.** Rejected: 73 of the 78 unused exports are used inside their own module, overlapping the 72 over-exported entries the existing audit already tracks, and the zero-config baseline includes verified false positives.

**Add fallow as a devDependency and run a reproducible gate.** Rejected for now: it would introduce the repository's first `package-lock.json` plus a roughly 43 MB per-platform binary for a signal that can be read in review; revisit only if CI enforcement becomes a requirement.

**Extend the textual export audit to type exports.** Rejected: `tsc` owns type usage, and the textual audit counts identifier occurrences, so it cannot tell which module's re-export is actually consumed. Fallow's module graph can, which is why it stays review evidence.

## Acceptance criteria

- [A1] `.fallowrc.jsonc` is committed with one reason per ignore; `fallow doctor` reports no failing check. — `workflow`
- [A2] With the config, `fallow dead-code` opens at 32 findings; after the Phase 1 cleanup it reports no unused exports, types, or unresolved imports, with zero circular and zero unlisted dependencies. — `source`
- [A3] `fallow health` reports 123 full-function findings at 83.9/B, and the count does not grow. — `source`
- [A4] The Phase 1 dead set (5 exports, 8 types, 2 private methods, `tools/panel-fixture.mjs`) is removed, and `NOTICE_TITLE_MAX_CHARS` is 100 in all three homes. — `source`
- [A5] `npm run check`, `npm run check:self-test`, `npm run typecheck`, and the affected test lanes pass. — `workflow`

## Risks

- A fallow upgrade changes finding ids and counts; record `fallow --version` on every baseline and re-run the report after an upgrade.
- Keeping the CLI local means CI cannot enforce the full-function baseline; the review step is the only enforcement.
- Fallow's 60-line unit threshold is stricter than the 200-line rule in AGENTS.md; the standard must be reconciled when the work lands.
- Semantics-based false positives exist (interface-mediated class members, `import.meta.url` lazy edges); verify with `--trace` and the owning test before deleting.

## Delivery stages

1. Config and record — no code change; verify the 32/123 baselines.
2. Mechanical cleanup — remove the stale fixture, 5 exports, 8 types, and 2 unused private methods.
3. Symbol consolidation — unify duplicated names and `NOTICE_TITLE_MAX_CHARS`.
4. Complexity and duplication — burn down the 123-finding baseline from the top.
5. Review loop — keep the local CLI check in code review and re-baseline after upgrades.
