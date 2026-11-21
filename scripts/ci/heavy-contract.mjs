/**
 * Shared identity between the heavy publisher and the derived gate.
 *
 * Keep the context names and command set here: the publisher writes them, the
 * gate reads them, and a rename must update both sides in the same change.
 */

/** Commit-status context the derived gate reads. Never add it to a ruleset. */
export const HEAVY_GATE_CONTEXT = 'heavy-gate'

/** Non-required display check carrying the structured heavy result summary. */
export const HEAVY_DISPLAY_CHECK = 'heavy-gate-result'

/** One row per command the heavy workflow must record. */
export const HEAVY_COMMANDS = Object.freeze([
  Object.freeze({ name: 'typecheck', command: 'npm run typecheck', blocking: true }),
  Object.freeze({ name: 'build', command: 'npm run build', blocking: true }),
  Object.freeze({ name: 'host-smoke', command: 'DSH_HOST_SMOKE_STRICT=1 npm run test:host-smoke', blocking: true }),
  Object.freeze({ name: 'coverage-layered', command: 'npm run test:coverage:layered -- --base <base>', blocking: true }),
  Object.freeze({ name: 'e2e-keyless', command: 'npm run test:e2e', blocking: true }),
  Object.freeze({ name: 'e2e-bash', command: 'npm run test:e2e:bash', blocking: false }),
])
