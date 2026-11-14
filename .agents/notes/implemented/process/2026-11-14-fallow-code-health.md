# Decision: Adopt fallow as a reviewed code-health signal

Status: implemented
Date: 2026-11-14
Class: process

## Problem

The repository already gates runtime exports (export audit), import direction and cycles (architecture test), file size (source budget), and unused locals/parameters (tsc). A fallow 3.43.0 run still found classes those gates cannot see: type-only exports outside the audit, exports of `tools/`/`scripts/` modules, unused class members, unowned dev scripts, duplicate symbol names, and no full-function complexity or duplication baseline. At zero config the run also mixed known noise into 118 findings: host-provided peer imports, the external `react` import, and a `new URL(..., import.meta.url)` lazy edge that the static graph proves is not a cycle.

## Decision

Fallow is a reviewed local signal, and each concern keeps one owner. `.fallowrc.jsonc` records one reason per ignore; the CLI stays local (no `devDependency`, no lockfile, version 3.43.0 recorded in the report).

1. The export audit also checks re-exports from the host entry (`src/app/apply.ts`); that entry's own declarations stay exempt.
2. The over-exported count stays advisory; there is no ratchet.
3. `fallow dead-code --unused-types` is review evidence only; there is no type gate.
4. Fallow's default health thresholds (CC > 20, cognitive > 15, CRAP > 30, unit > 60) apply to all functions through the reviewed baseline in `tools/fallow-health-baseline.json`; duplication stays a change-level rule.
5. `scripts/build/` is analysed through `"ignorePatterns": ["!scripts/build/**"]`.
6. `NOTICE_TITLE_MAX_CHARS` is 100 in the notice contract and both readers.
7. Every `tools/*.mjs` must be claimed by a workflow surface or a script/test import; an unowned tool fails `npm run check`.
8. `AGENTS.md` and the code-review skill carry the export/tool ownership rule and the baseline check.

## Alternatives considered

**Adopt fallow as a full-repo CI gate.** Rejected: 73 of the 78 unused exports were used inside their own module, overlapping the over-exported entries the existing audit already tracks, and the zero-config baseline included verified false positives.

**Add fallow as a devDependency and run a reproducible gate.** Rejected: it would introduce the repository's first `package-lock.json` plus a roughly 43 MB per-platform binary for a signal that can be read in review; revisit only if CI enforcement becomes a requirement.

**Extend the textual export audit to type exports.** Rejected: `tsc` owns type usage, and the textual audit counts identifier occurrences, so it cannot tell which module's re-export is actually consumed. Fallow's module graph can, which is why it stays review evidence.

## Consequences

- `fallow dead-code` goes from 118 zero-config findings to 3 verified false positives: the design asset `docs/design/topic/assets/topic-demo.css`, the workflow-invoked `tools/m12-migration-drill.mjs`, and the interface-mediated `mutateNotices` member. No unused export, unused type, or duplicate export name remains.
- `fallow health` reports 118 full-function findings at 84.4/B. That set is the reviewed baseline; `fallow health --baseline tools/fallow-health-baseline.json` reports zero and fails on a new finding. Burn-down of the inherited list is tracked by the baseline, not by this decision.
- The CLI stays local, so the full-function baseline cannot be enforced in CI; reviewer adoption is the only enforcement. Revisit if CI enforcement becomes required.
- Fallow's 60-line unit threshold is stricter than the user-level 200-line function rule; the executable bound is now the fallow baseline.
- `NOTICE_TITLE_MAX_CHARS` is a value change: client cards clip at 100 (was 120), while the ledger and activity descriptors clip at 100 (was 80).
- `scripts/build/` is now in the analysis; its two CRAP-only moderate findings are part of the baseline.

## Testing

- [A1] `.fallowrc.jsonc` is committed, every ignore carries a reason, and `fallow doctor` reports no failing check. — `workflow`
- [A2] `fallow dead-code` reports the 3 verified false positives only; no unused exports, types, or duplicate export names remain. — `source`
- [A3] `fallow health --baseline tools/fallow-health-baseline.json` exits 0 with zero new findings; the saved baseline is 118 findings at 84.4/B. — `source`
- [A4] The host-re-export and tools-ownership invariants each reject a synthetic bad case; `npm run check:self-test` proves 19 project controls. — `workflow`
- [A5] `npm test` (989), `npm run check`, `npm run check:self-test`, `npm run typecheck`, `npm run test:coverage`, `npm run build`, and `npm run test:host-smoke` pass. — `workflow`
