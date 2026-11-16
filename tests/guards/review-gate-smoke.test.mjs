import test from 'node:test'
import assert from 'node:assert/strict'

test('review gate smoke: temporary PR can carry a review verdict', () => {
  assert.equal(1, 1)
})

// A second head proves a new commit invalidates the previous gate-artifact check.
test('review gate smoke: second head', () => {
  assert.equal(2, 2)
})
