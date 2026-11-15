import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeEvidenceText } from '../../scripts/evidence/evidence-sanitize.mjs'

test('failure evidence redacts URL tokens, cookies, and bearer values', () => {
  const input = [
    'GET http://127.0.0.1:3000/?token=super-secret&next=1 failed',
    'cookie: dsh-auth=abc123; theme=light',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
  ].join('\n')
  const output = sanitizeEvidenceText(input)
  assert.doesNotMatch(output, /super-secret|abc123|eyJhbGciOiJIUzI1NiJ9/)
  assert.match(output, /token=\[redacted\]/)
  assert.match(output, /cookie: \[redacted\]/)
  assert.match(output, /Authorization: \[redacted\]/)
})

test('plain text without credentials is unchanged', () => {
  const input = 'browser-panel: no matching combo entry'
  assert.equal(sanitizeEvidenceText(input), input)
})
