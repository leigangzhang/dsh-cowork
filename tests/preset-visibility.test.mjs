import test from 'node:test'
import assert from 'node:assert/strict'
import './support/ts-hook.mjs'
// `src/preset-visibility.ts` imports `./presets.js` with the build's extension.
// Node's type stripping does not retry `.js` as `.ts`, so use the same tiny
// resolve hook as the other source-level tests.

const {
  HIDDEN_PRESET_IDS,
  hidePresetsFromRoster,
} = await import('../src/preset-visibility.ts')

const ALL_IDS = ['cowork-master', 'cowork-topic', 'cowork-reviewer', 'standard']

class FakeRegistry {
  constructor() {
    this.presets = ALL_IDS.map((id) => ({ id, isDefault: id === 'cowork-master' }))
  }

  async list() {
    return this.presets
  }

  async remoteExportList() {
    return { presets: this.presets.map((row) => ({ ...row })) }
  }

  async resolve(id) {
    return { id }
  }
}

test('the hidden preset ids are topic and reviewer only', () => {
  assert.deepEqual([...HIDDEN_PRESET_IDS], ['cowork-topic', 'cowork-reviewer'])
})

test('filters the remote roster without hiding definitions from list or resolve', async () => {
  const registry = new FakeRegistry()
  const restore = hidePresetsFromRoster(registry)

  assert.deepEqual(
    (await registry.remoteExportList()).presets.map((row) => row.id),
    ['cowork-master', 'standard'],
  )
  assert.deepEqual(
    (await registry.list()).map((row) => row.id),
    ALL_IDS,
    'the internal registry list must keep every definition',
  )
  assert.deepEqual(await registry.resolve('cowork-topic'), { id: 'cowork-topic' })

  restore()
  assert.deepEqual(
    (await registry.remoteExportList()).presets.map((row) => row.id),
    ALL_IDS,
  )
})

test('restore is idempotent and never overwrites a later owner', async () => {
  const registry = new FakeRegistry()
  const restore = hidePresetsFromRoster(registry)
  restore()
  restore()

  assert.deepEqual(
    (await registry.remoteExportList()).presets.map((row) => row.id),
    ALL_IDS,
  )

  const second = hidePresetsFromRoster(registry)
  const laterOwner = async () => ({ presets: [] })
  registry.remoteExportList = laterOwner
  second()

  assert.equal(registry.remoteExportList, laterOwner)
})

test('an unsupported host fails loudly so the caller can log and continue', () => {
  assert.throws(
    () => hidePresetsFromRoster({}),
    /agentPresets\.remoteExportList is unavailable/,
  )
})
