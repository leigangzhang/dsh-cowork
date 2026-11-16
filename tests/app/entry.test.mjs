import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'

// The package entry is the one src file no unit test imported, so it stayed out
// of the coverage report. Loading it here also pins the re-export surface the
// host resolves through `main`; a broken barrel must fail before packaging.
const entry = await import('../../src/index.ts')

test('the package entry re-exports the host assembly surface', () => {
  assert.equal(typeof entry.apply, 'function')
  assert.ok(Array.isArray(entry.inject))
  assert.equal(typeof entry.OPEN_WORKSPACE_PATH_TIMEOUT_MS, 'number')
  assert.equal(typeof entry.createOpenWorkspacePathPort, 'function')
  assert.equal(typeof entry.panelRoutePathname, 'function')
  assert.equal(typeof entry.Config, 'function')
  assert.equal(typeof entry.normalizeConfig, 'function')
  assert.equal(typeof entry.CONFIG_DEFAULTS, 'object')
})

test('the entry stays a re-export barrel', async () => {
  const namespace = await import('../../src/index.ts')
  assert.deepEqual(Object.keys(namespace).sort(), [
    'CONFIG_DEFAULTS',
    'Config',
    'OPEN_WORKSPACE_PATH_TIMEOUT_MS',
    'apply',
    'createOpenWorkspacePathPort',
    'inject',
    'normalizeConfig',
    'panelRoutePathname',
  ])
})
