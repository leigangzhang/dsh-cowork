/**
 * Timing model for the versioned E2E lane.
 *
 * Keyless scenarios are deterministic and fit one flat budget. Live-model
 * scenarios spend wall clock on a variable number of real turns, so they budget
 * one timeout per turn plus a bounded observation: a flat scenario cap cannot
 * tell a slow turn from a scenario with more turns, and it hides or interrupts
 * the turns that never ran.
 */

/** One real-model turn, including its tool round-trip. */
export const LIVE_TURN_TIMEOUT_MS = 120_000

/** The observation after a turn: session idle, dispatch window, index write. */
export const LIVE_TURN_OBSERVATION_MS = 15_000

/** Session creation, fixture setup, and teardown around the turns. */
export const LIVE_SCENARIO_SETUP_MS = 60_000

/**
 * The hard budget for a live scenario that waits on `turns` model turns.
 *
 * @param {number} turns Bounded model turns the scenario waits on.
 * @returns {number} Milliseconds.
 */
export function liveScenarioTimeout(turns) {
  if (!Number.isSafeInteger(turns) || turns < 1) {
    throw new Error(`live scenario budget needs a positive integer turn count, got ${String(turns)}`)
  }
  return turns * (LIVE_TURN_TIMEOUT_MS + LIVE_TURN_OBSERVATION_MS) + LIVE_SCENARIO_SETUP_MS
}

/**
 * The hard budget for one scenario: its own per-turn budget when declared,
 * otherwise the lane's flat keyless budget.
 *
 * @param {{ id: string, timeoutMs?: number }} scenario Registry entry.
 * @param {number} fallbackMs Budget for a scenario that declares none.
 * @returns {number} Milliseconds.
 */
export function scenarioTimeoutOf(scenario, fallbackMs) {
  if (scenario.timeoutMs === undefined) return fallbackMs
  if (!Number.isSafeInteger(scenario.timeoutMs) || scenario.timeoutMs < 1) {
    throw new Error(`scenario ${String(scenario.id)} timeoutMs must be a positive integer`)
  }
  return scenario.timeoutMs
}
