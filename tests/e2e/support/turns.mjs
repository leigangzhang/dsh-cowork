/**
 * Per-turn ledger for observational live scenarios.
 *
 * A live scenario must keep observing after one model turn fails: the failed
 * turn is recorded, turns that depend on it are skipped with a reason, and
 * independent turns still run. The summary reports passed, failed, skipped and
 * a pass rate over the attempted turns; a skipped turn is never counted as
 * passed.
 */

/**
 * Summarize recorded turn rows.
 *
 * @param {ReadonlyArray<{status: 'passed'|'failed'|'skipped'}>} rows Turn rows.
 * @returns {{passed: number, failed: number, skipped: number, attempted: number,
 *   rate: number|null}} Counts and the pass rate over attempted turns.
 */
export function summarizeTurns(rows) {
  const passed = rows.filter((row) => row.status === 'passed').length
  const failed = rows.filter((row) => row.status === 'failed').length
  const skipped = rows.filter((row) => row.status === 'skipped').length
  const attempted = passed + failed
  return { passed, failed, skipped, attempted, rate: attempted === 0 ? null : passed / attempted }
}

/** One turn ledger; scenarios wrap each real-model turn in `run`. */
export function createTurnLedger() {
  const rows = []
  const byName = new Map()

  const record = (name, row) => {
    byName.set(name, row)
    rows.push({ name, ...row })
  }

  return {
    /**
     * Run one turn, or skip it when a declared dependency did not pass.
     *
     * @param {string} name Unique turn name.
     * @param {{dependsOn?: readonly string[]}} [options] Turn prerequisites.
     * @param {() => Promise<any>} operation The bounded model-turn work.
     * @returns {Promise<any>} The operation value, or undefined after a skip/failure.
     */
    async run(name, options, operation) {
      if (typeof name !== 'string' || name === '') throw new Error('live turn name must be a non-empty string')
      if (byName.has(name)) throw new Error(`live turn "${name}" is declared twice`)
      const dependsOn = options?.dependsOn ?? []
      const blocked = dependsOn.find((dependency) => byName.get(dependency)?.status !== 'passed')
      if (blocked !== undefined) {
        const status = byName.get(blocked)?.status ?? 'missing'
        record(name, { status: 'skipped', dependsOn, reason: `${status} dependency "${blocked}"` })
        return undefined
      }
      try {
        const value = await operation()
        record(name, { status: 'passed', dependsOn })
        return value
      } catch (error) {
        record(name, { status: 'failed', dependsOn, reason: error instanceof Error ? error.message : String(error) })
        return undefined
      }
    },

    /** Everything recorded so far, in execution order. */
    rows() {
      return rows.map((row) => ({ ...row }))
    },

    /** Counts and the rate over attempted turns; `rate` is null before an attempt. */
    stats() {
      return { ...summarizeTurns(rows), turns: rows.map((row) => ({ ...row })) }
    },
  }
}
