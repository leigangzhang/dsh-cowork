import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// `src/presets.ts` imports its reviewer id from `./review.js` — the build's
// specifier. Node's type stripping does not retry relative `.js` as `.ts`, so
// this test installs the same small resolve hook tests/api.test.mjs uses. No
// host is assembled here: the presets are plain data.
const HOOK_SOURCE = [
  'export async function resolve(specifier, context, nextResolve) {',
  "  if (specifier.startsWith('.') && specifier.endsWith('.js')) {",
  "    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch {}",
  '  }',
  '  return nextResolve(specifier, context)',
  '}',
].join('\n')
register(`data:text/javascript,${encodeURIComponent(HOOK_SOURCE)}`)

const {
  MASTER_PRESET_ID,
  REVIEWER_PRESET_ID,
  THREAD_PRESET_ID,
  presetDefinitions,
} = await import('../src/presets.ts')

const TOOL_FS = '@deepseek-ai/dsh-tool-fs'
const TOOL_FS_SEARCH = '@deepseek-ai/dsh-tool-fs-search'
const TOOL_BASH = '@deepseek-ai/dsh-tool-bash'
const PERSONA = '@deepseek-ai/dsh-persona'

const presetById = (id) => {
  const preset = presetDefinitions().find((candidate) => candidate.id === id)
  assert.ok(preset !== undefined, `preset ${id} must be defined`)
  return preset
}

const rowNames = (preset) => preset.plugins.map((row) => row.name)

test('presetDefinitions returns exactly the three cowork presets, master first', () => {
  const definitions = presetDefinitions()
  assert.deepEqual(
    [...new Set(definitions.map((preset) => preset.id))].sort(),
    [MASTER_PRESET_ID, REVIEWER_PRESET_ID, THREAD_PRESET_ID].sort(),
  )
  assert.equal(definitions.length, 3)
  assert.equal(definitions[0].id, MASTER_PRESET_ID)
})

test('the reviewer preset has no tool-fs and keeps shell plus search', () => {
  const reviewer = presetById(REVIEWER_PRESET_ID)
  const names = rowNames(reviewer)
  // M4A2: the reviewer is physically read-only — no tool-fs means no read,
  // write, or edit tool in its surface.
  assert.equal(names.includes(TOOL_FS), false)
  assert.equal(names.includes(TOOL_FS_SEARCH), true)
  assert.equal(names.includes(TOOL_BASH), true)
})

test('the master and thread presets keep tool-fs', () => {
  for (const id of [MASTER_PRESET_ID, THREAD_PRESET_ID]) {
    assert.equal(rowNames(presetById(id)).includes(TOOL_FS), true, `${id} must mount ${TOOL_FS}`)
  }
})

test('every preset has unique row ids and a non-empty persona prefix', () => {
  for (const preset of presetDefinitions()) {
    const rowIds = preset.plugins.map((row) => row.id)
    assert.equal(new Set(rowIds).size, rowIds.length, `${preset.id} row ids must be unique`)

    const personaRows = preset.plugins.filter((row) => row.id === 'persona')
    assert.equal(personaRows.length, 1, `${preset.id} must have exactly one persona row`)
    const persona = personaRows[0]
    assert.equal(persona.name, PERSONA)
    const prefix = persona.config?.prefix
    assert.equal(typeof prefix, 'string', `${preset.id} persona prefix must be a string`)
    assert.notEqual(prefix.trim(), '', `${preset.id} persona prefix must be non-empty`)
  }
})
