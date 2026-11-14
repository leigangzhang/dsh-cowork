import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUSINESS_TOOL_ORDER,
  PANEL_ROUTES,
  TOOL_DOMAINS,
} from '../support/public-surface.mjs'

/**
 * The public-surface snapshot: 22 business tools, 10 panel routes, 3 presets,
 * and 3 package export keys. Each count already has an owning behavior test;
 * this file exists so a deliberate surface change shows up as one diff that
 * must be reviewed together, not as three unrelated green updates.
 */
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const { presetDefinitions } = await import('../../src/platform/presets.ts')

test('the public surface stays at 22 tools, 10 routes, 3 presets, and 3 exports', () => {
  assert.equal(BUSINESS_TOOL_ORDER.length, 22)
  assert.equal(new Set(BUSINESS_TOOL_ORDER).size, 22, 'tool names must be unique')
  assert.equal(PANEL_ROUTES.length, 10)
  assert.equal(new Set(PANEL_ROUTES.map(([path]) => path)).size, 10, 'route paths must be unique')
  assert.equal(presetDefinitions().length, 3)

  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['.', './client', './package.json'])
})

test('every public tool has exactly one owning domain module', () => {
  const mapped = TOOL_DOMAINS.flatMap(([, names]) => names)
  assert.equal(mapped.length, 22)
  assert.equal(new Set(mapped).size, 22, 'a tool may map to only one domain module')
  assert.deepEqual([...mapped].sort(), [...BUSINESS_TOOL_ORDER].sort())
})
