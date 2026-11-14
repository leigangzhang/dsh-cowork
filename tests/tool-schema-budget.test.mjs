import test from 'node:test'
import assert from 'node:assert/strict'
import './support/ts-hook.mjs'
import { BUSINESS_TOOL_ORDER } from './support/public-surface.mjs'

/**
 * Context-cost guard for the tool surface (audit item 10).
 *
 * The host sends every registered tool's definition to the model on every call.
 * This plugin registers all twenty-two business tools at the profile level —
 * there is no per-session or per-agent trimming hook in the host — so the whole
 * serialized schema below is charged on each request, for every cowork session.
 * The budget is therefore a hard ceiling: changing a description, parameter, or
 * enum grows the payload and fails here until the budget is raised on purpose.
 *
 * Budget provenance: 16,523 B measured from this tree at base 14e8b0c
 * (sum of `JSON.stringify({ name, description, parameters })` over the 22
 * registered tools). Trimming the schema passes; growth fails.
 */
const TOOL_SCHEMA_BUDGET_BYTES = 16_523

/** The fields the model receives for one tool; `execute`/`output` stay host-side. */
const SERIALIZED_FIELDS = ['name', 'description', 'parameters']

const { apply } = await import('../src/index.ts')

/** Serialized definition of one registered tool, in the shape the model sees. */
function serializedTool(tool) {
  const definition = {}
  for (const field of SERIALIZED_FIELDS) definition[field] = tool[field]
  return JSON.stringify(definition)
}

const schemaBytes = (tools) => tools.reduce(
  (total, tool) => total + Buffer.byteLength(serializedTool(tool), 'utf8'),
  0,
)

/**
 * Minimal host that records tool registrations. `apply` also mounts the panel
 * API, presets, and memory section; those registrations are accepted silently
 * because this test only measures the tool surface.
 */
function fakeHost() {
  const tools = []
  const presets = []
  const connection = { fetch: { register: () => () => {} } }
  const ctx = {
    get: (name) => (name === 'connection' ? connection : undefined),
    effect(callback) {
      return callback()
    },
    webServer: { register: () => () => {} },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    on: () => () => {},
    logger: { info() {}, warn() {} },
    sessionController: { list: async () => ({ items: [] }) },
    workspaceRegistry: {},
    agentPresets: {
      list: async () => presets,
      remoteExportList: async () => ({ presets }),
      register: async (definition) => {
        presets.push(definition)
        return async () => {}
      },
    },
    agents: { list: () => [] },
  }
  return { ctx, tools }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('the twenty-two business tools stay inside the measured schema budget', async () => {
  const host = fakeHost()
  apply(host.ctx, { repoPath: '', promptTimeoutMs: 120_000, enableDevRoutes: false })
  await settle()

  assert.equal(host.tools.length, 22, 'the budget assumes exactly the twenty-two business tools')
  assert.deepEqual(host.tools.map((tool) => tool.name), BUSINESS_TOOL_ORDER)
  for (const tool of host.tools) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.trim() !== '', `${tool.name} needs a description`)
    assert.equal(tool.parameters.type, 'object', `${tool.name} must expose an object schema`)
  }

  const total = schemaBytes(host.tools)
  console.log(`# serialized tool schema: ${total} B / ${TOOL_SCHEMA_BUDGET_BYTES} B (${host.tools.length} tools)`)
  assert.ok(
    total <= TOOL_SCHEMA_BUDGET_BYTES,
    `the tool schema is ${total} B, over the ${TOOL_SCHEMA_BUDGET_BYTES} B budget; trim it or raise the budget deliberately`,
  )
})

test('the budget rejects one more tool on this surface', async () => {
  // A negative control: the surface already sits at its ceiling, so adding a
  // tool with an ordinary description must push the same arithmetic over the
  // budget. This proves the assertion above can go red, not just compute a sum.
  const host = fakeHost()
  apply(host.ctx, { repoPath: '', promptTimeoutMs: 120_000, enableDevRoutes: false })
  await settle()

  const grown = schemaBytes([...host.tools, {
    name: 'cowork_extra',
    description: 'A twenty-third tool that this plugin does not ship.',
    parameters: { type: 'object', properties: {} },
  }])
  assert.ok(grown > TOOL_SCHEMA_BUDGET_BYTES, `a grown surface must exceed the budget, got ${grown} B`)
})
