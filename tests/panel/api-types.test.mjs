import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../support/ts-hook.mjs'

/**
 * The API type split: the port/route types live in a leaf module, so
 * `src/panel/inbox-api.ts` no longer imports `src/panel/api.ts` (a type-only cycle the
 * compiler still follows), while `src/panel/api.ts` keeps every moved name exported
 * for the panel client and the existing importers.
 *
 * The acyclicity test follows local `.js` specifiers (runtime and `import type`)
 * between the request/panel modules and proves the graph has no back edge.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Source text of one repository file. */
function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

/** The names `src/panel/api.ts` re-exports from the leaf module. */
const SHARED_TYPES = [
  'PanelSessionRow',
  'CoworkStorePort',
  'CoworkApiPorts',
  'PanelFetchMethod',
  'PanelRequestBodyMode',
  'PanelFetchRoute',
  'CoworkConnection',
  'CoworkApiHost',
]

test('inbox-api no longer imports the API implementation', () => {
  const source = read('src/panel/inbox-api.ts')
  assert.equal(/from '\.\/api\.js'/.test(source), false, 'inbox-api must not import ./api.js')
  assert.match(source, /from '\.\/api-types\.js'/)
})

test('api-types declares the shared names and imports no implementation sibling', () => {
  const source = read('src/panel/api-types.ts')
  for (const name of SHARED_TYPES) {
    assert.match(
      source,
      new RegExp(`export (?:interface|type) ${name}\\b`),
      `api-types must export ${name}`,
    )
  }
  assert.equal(/from '\.\/(?:api|inbox-api)\.js'/.test(source), false)
})

test('api.ts keeps every moved name as a public export', () => {
  const source = read('src/panel/api.ts')
  const block = source.match(/export type \{([\s\S]*?)\} from '\.\/api-types\.js'/)
  assert.ok(block !== null, 'api.ts must re-export the shared types')
  const exported = block[1].split(/[\s,]+/).filter((name) => name !== '')
  for (const name of SHARED_TYPES) {
    assert.ok(exported.includes(name), `api.ts must re-export ${name}`)
  }
})

test('the request/panel module graph has no import cycle', () => {
  const nodes = [
    'src/panel/api.ts',
    'src/panel/api-types.ts',
    'src/panel/inbox-api.ts',
    'src/domains/requests/request-service.ts',
    'src/domains/requests/request-lifecycle.ts',
    'src/domains/requests/authorization-decision.ts',
    'src/domains/requests/request-support.ts',
    'src/store/request-store.ts',
    'src/domains/requests/request-schema.ts',
  ]
  const known = new Set(nodes.map((node) => node.replace(/^src\//, '').replace(/\.ts$/, '')))
  const edges = new Map()
  for (const node of nodes) {
    const source = read(node)
    const targets = new Set()
    for (const match of source.matchAll(/from '\.\/([a-z-]+)\.js'/g)) {
      if (known.has(match[1])) targets.add(`src/${match[1]}.ts`)
    }
    edges.set(node, [...targets])
  }
  const visiting = new Set()
  const done = new Set()
  const cycle = (node, path) => {
    if (visiting.has(node)) return [...path, node]
    if (done.has(node)) return null
    visiting.add(node)
    for (const target of edges.get(node) ?? []) {
      const found = cycle(target, [...path, node])
      if (found !== null) return found
    }
    visiting.delete(node)
    done.add(node)
    return null
  }
  for (const node of nodes) {
    const found = cycle(node, [])
    assert.equal(found, null, `import cycle: ${found === null ? '' : found.join(' -> ')}`)
  }
})

test('the public runtime exports survive the type move', async () => {
  const api = await import('../../src/panel/api.ts')
  const service = await import('../../src/domains/requests/request-service.ts')
  for (const name of ['registerCoworkApi', 'toPanelTopic', 'toErrorResponse', 'jsonResponse', 'panelErrorStatus']) {
    assert.equal(typeof api[name], 'function', `api.ts must export ${name}`)
  }
  for (const name of ['resolveAuthorizationDecision', 'settleAuthorizationRequestRecord', 'resolveRequest', 'promptRequestTopic']) {
    assert.equal(typeof service[name], 'function', `request-service.ts must export ${name}`)
  }
})
