import test from 'node:test'
import assert from 'node:assert/strict'
import './support/ts-hook.mjs'
/**
 * Contract tests for the shared delivery-attempt primitive: one success costs
 * one call, a retry can recover, an exhausted sequence returns the last error
 * instead of throwing, and the primitive never touches the caller's ledger.
 */
const { attemptDelivery, retryDelaySchedule, DELIVERY_DEFAULT_MAX_ATTEMPTS } =
  await import('../src/delivery.ts')

/** A hand-off that fails `failTimes` times, then resolves. */
function flaky(failTimes) {
  const calls = []
  return {
    calls,
    async deliver() {
      calls.push(calls.length + 1)
      if (calls.length <= failTimes) throw new Error(`attempt ${calls.length} failed`)
      return 'duplicate'
    },
  }
}

test('a successful hand-off is attempted exactly once', async () => {
  const port = flaky(0)
  const result = await attemptDelivery(() => port.deliver())
  assert.deepEqual(result, { attempts: 1, delivered: true, error: null })
  assert.equal(port.calls.length, 1)
  assert.equal(DELIVERY_DEFAULT_MAX_ATTEMPTS, 1)
})

test('a retry can recover, using the configured backoff in order', async () => {
  const port = flaky(2)
  const delays = []
  const result = await attemptDelivery(() => port.deliver(), {
    maxAttempts: 3,
    retryDelaysMs: [10, 20],
    sleep: async (ms) => { delays.push(ms) },
  })
  assert.deepEqual(result, { attempts: 3, delivered: true, error: null })
  assert.equal(port.calls.length, 3)
  assert.deepEqual(delays, [10, 20])
})

test('an exhausted sequence returns the last error and never throws', async () => {
  let calls = 0
  const result = await attemptDelivery(async () => {
    calls += 1
    throw new Error(`host is down (${calls})`)
  }, {
    maxAttempts: 2,
    retryDelaysMs: [1],
    sleep: async () => {},
  })
  assert.deepEqual(result, { attempts: 2, delivered: false, error: 'host is down (2)' })
  assert.equal(calls, 2)
})

test('a non-Error rejection and a throwing ledger hook stay values', async () => {
  const rejected = await attemptDelivery(() => Promise.reject('port offline'))
  assert.deepEqual(rejected, { attempts: 1, delivered: false, error: 'port offline' })

  const hookFailure = await attemptDelivery(async () => {}, {
    onAttempt: () => { throw new Error('ledger write failed') },
  })
  assert.deepEqual(hookFailure, { attempts: 1, delivered: false, error: 'ledger write failed' })
})

test('per-attempt state is reported without the primitive writing it', async () => {
  const ledger = { attempts: 0, lastError: null }
  const seen = []
  const result = await attemptDelivery(async () => {
    throw new Error('nope')
  }, {
    maxAttempts: 3,
    retryDelaysMs: [0],
    sleep: async () => {},
    onAttempt: (attempt) => { seen.push(attempt) },
  })
  assert.deepEqual(seen, [1, 2, 3])
  assert.equal(result.delivered, false)
  // The primitive only reports; it never mutates the caller's ledger.
  assert.deepEqual(ledger, { attempts: 0, lastError: null })
})

test('retryDelaySchedule repeats the last delay and shrinks with the budget', () => {
  assert.deepEqual(retryDelaySchedule(1, [1000]), [])
  assert.deepEqual(retryDelaySchedule(3, [1000, 5000]), [1000, 5000])
  assert.deepEqual(retryDelaySchedule(5, [1000, 5000, 30000]), [1000, 5000, 30000, 30000])
  assert.deepEqual(retryDelaySchedule(2, []), [0])
})
