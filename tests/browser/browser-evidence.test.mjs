import test from 'node:test'
import assert from 'node:assert/strict'
import {
  coverageEntryEvidence,
  coverageEvidence,
  failurePayload,
  redactUrl,
} from '../../scripts/evidence/browser-evidence.mjs'

test('coverage evidence keeps size and range counts without the bundle source', () => {
  const source = 'x'.repeat(4096)
  const evidence = coverageEntryEvidence({
    url: 'http://127.0.0.1/plugins/@dsh-external/dsh-cowork/client.js?token=secret',
    source,
    functions: [
      { functionName: 'a', ranges: [{ count: 1 }, { count: 0 }] },
      { functionName: 'b', ranges: [{ count: 1 }] },
    ],
  })
  assert.equal(evidence.generatedLength, source.length)
  assert.equal(evidence.functions, 2)
  assert.equal(evidence.ranges, 3)
  assert.equal(evidence.url.includes('secret'), false)
  assert.equal(JSON.stringify(evidence).includes(source), false)
})

test('coverage evidence tolerates a partial entry', () => {
  assert.deepEqual(coverageEntryEvidence({}), {
    url: '',
    generatedLength: 0,
    functions: 0,
    ranges: 0,
  })
  assert.equal(coverageEntryEvidence({ text: 'abc' }).generatedLength, 3)
  assert.deepEqual(coverageEvidence(undefined), [])
})

test('redaction removes a token query parameter and leaves other URLs intact', () => {
  assert.equal(
    redactUrl('http://127.0.0.1/api?token=secret&view=1'),
    'http://127.0.0.1/api?view=1',
  )
  assert.equal(redactUrl('not a url'), 'not a url')
})

test('failure payload redacts credentials and omits raw source', () => {
  const payload = failurePayload({
    error: new Error('request failed with Bearer abc.def-123 and cookie=dsh=secret'),
    pageErrors: ['page failed at /api?token=secret'],
    consoleMessages: [{ type: 'error', text: 'console cookie=dsh-secret' }],
    network: [{ method: 'GET', url: 'http://127.0.0.1/api?token=secret', status: 500 }],
    coverage: [{
      url: 'http://127.0.0.1/plugins/@dsh-external/dsh-cowork/client.js?token=secret',
      source: 'raw bundle source',
      functions: [{ ranges: [{ count: 1 }] }],
    }],
    hostLogs: 'Authorization: Bearer secret',
  })
  assert.equal(payload.error.includes('secret'), false)
  assert.equal(payload.stack.includes('secret'), false)
  assert.equal(payload.pageErrors[0].includes('secret'), false)
  assert.equal(payload.consoleMessages[0].text.includes('secret'), false)
  assert.equal(payload.network[0].url.includes('secret'), false)
  assert.equal(payload.network[0].status, 500)
  assert.equal(payload.hostLogs.includes('secret'), false)
  assert.equal(payload.coverage[0].url.includes('secret'), false)
  assert.equal(payload.coverage[0].generatedLength, 'raw bundle source'.length)
  assert.equal(JSON.stringify(payload).includes('raw bundle source'), false)
})

test('failure payload accepts a thrown string and absent coverage', () => {
  const payload = failurePayload({
    error: 'plain failure',
    pageErrors: [],
    consoleMessages: [],
    network: [],
    coverage: undefined,
    hostLogs: undefined,
  })
  assert.equal(payload.error, 'plain failure')
  assert.equal(payload.stack, '')
  assert.deepEqual(payload.coverage, [])
  assert.equal(payload.hostLogs, '')
})
