/**
 * The one delivery-attempt primitive: try an asynchronous hand-off — a prompt
 * to a session, or a notice append to the host port — up to `maxAttempts`
 * times with a bounded backoff between failures.
 *
 * Two invariants keep every caller's ledger honest:
 * - the primitive never throws and never mutates caller state; it returns
 *   `{ attempts, delivered, error }`, and the caller decides what to record;
 * - only `deliver` is retried, so a ledger write or a clock read is never
 *   repeated here. A caller that must record per-attempt state (the notice
 *   ledger's `attempts`) passes `onAttempt`.
 */
/** Total attempts a delivery gets when the caller does not say otherwise. */
export const DELIVERY_DEFAULT_MAX_ATTEMPTS = 1

/** How one delivery is retried. */
export interface DeliveryAttemptOptions {
  /** Total attempts including the first; at least 1. Defaults to 1. */
  maxAttempts?: number
  /** Delays before each retry, in order; the last value repeats when attempts outnumber delays. */
  retryDelaysMs?: readonly number[]
  /** Injected wait so a test does not sleep; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Called before every attempt with its 1-based number. */
  onAttempt?: (attempt: number) => void
}

/** What one delivery attempt sequence did; `error` is the last failure. */
export interface DeliveryAttemptResult {
  attempts: number
  delivered: boolean
  error: string | null
}

/**
 * One delay per retry (`maxAttempts - 1` entries), repeating the schedule's
 * last value once the schedule runs out. An empty schedule means no wait.
 */
export function retryDelaySchedule(maxAttempts: number, delays: readonly number[]): number[] {
  const schedule: number[] = []
  for (let retry = 1; retry < maxAttempts; retry += 1) {
    schedule.push(delays[Math.min(retry - 1, delays.length - 1)] ?? 0)
  }
  return schedule
}

/** Error text for a caught value; never a stack trace. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A real bounded wait; `setTimeout` keeps the timer off the call stack. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((settle) => {
    setTimeout(settle, ms)
  })
}

/**
 * Run `deliver` until it resolves or the attempt budget is spent, never
 * throwing into the caller. Any resolution — including a notice port's
 * `duplicate` answer — is a delivery; anything thrown or rejected is a failure.
 *
 * @param deliver The single hand-off to attempt; its result is ignored.
 * @param options Attempt budget, backoff schedule, injected sleep, per-attempt hook.
 * @returns The attempt count, whether the hand-off resolved, and the last error text.
 */
export async function attemptDelivery(
  deliver: () => Promise<unknown>,
  options: DeliveryAttemptOptions = {},
): Promise<DeliveryAttemptResult> {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DELIVERY_DEFAULT_MAX_ATTEMPTS))
  const delays = retryDelaySchedule(maxAttempts, options.retryDelaysMs ?? [])
  const sleep = options.sleep ?? defaultSleep
  let attempts = 0
  let error: string | null = null

  while (attempts < maxAttempts) {
    attempts += 1
    try {
      options.onAttempt?.(attempts)
    } catch (caught) {
      // A broken ledger hook is a caller defect; stop before delivering again.
      return { attempts, delivered: false, error: errorText(caught) }
    }
    try {
      await deliver()
      return { attempts, delivered: true, error: null }
    } catch (caught) {
      error = errorText(caught)
    }
    if (attempts >= maxAttempts) break
    try {
      await sleep(delays[attempts - 1] ?? 0)
    } catch (caught) {
      // The wait itself failed; another attempt cannot be scheduled.
      return { attempts, delivered: false, error: errorText(caught) }
    }
  }
  return { attempts, delivered: false, error }
}
