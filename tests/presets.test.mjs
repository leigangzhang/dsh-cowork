import test from 'node:test'
import assert from 'node:assert/strict'
import './support/ts-hook.mjs'
// `src/presets.ts` is plain data with no sibling imports, but the rest of the
// preset/assembly surface it is compared against uses the build's `.js`
// specifiers. Node's type stripping does not retry relative `.js` as `.ts`, so
// this test keeps the same small resolve hook tests/api.test.mjs uses. No host
// is assembled here.

const {
  MASTER_PERSONA,
  MASTER_PRESET_ID,
  REVIEWER_PERSONA,
  REVIEWER_PRESET_ID,
  TOPIC_PERSONA,
  TOPIC_PRESET_ID,
  presetDefinitions,
} = await import('../src/presets.ts')

const PERSONA = '@deepseek-ai/dsh-persona'
const TOOL_ASK_USER = '@deepseek-ai/dsh-tool-ask-user'
const TOOL_BASH = '@deepseek-ai/dsh-tool-bash'
const TOOL_FS = '@deepseek-ai/dsh-tool-fs'
const TOOL_FS_SEARCH = '@deepseek-ai/dsh-tool-fs-search'
const TOOL_JOBS = '@deepseek-ai/dsh-tool-jobs'
const TOOL_TODO = '@deepseek-ai/dsh-tool-todo'
const PRESENT = '@deepseek-ai/dsh-tool-present'

const presetById = (id) => {
  const preset = presetDefinitions().find((candidate) => candidate.id === id)
  assert.ok(preset !== undefined, `preset ${id} must be defined`)
  return preset
}

const rowNames = (preset) => preset.plugins.map((row) => row.name)
const personaPrefixOf = (preset) => preset.plugins.find((row) => row.id === 'persona')?.config?.prefix

test('presetDefinitions returns three presets: master, topic, reviewer', () => {
  const definitions = presetDefinitions()

  assert.equal(definitions.length, 3)
  assert.deepEqual(
    definitions.map((preset) => preset.id),
    [MASTER_PRESET_ID, TOPIC_PRESET_ID, REVIEWER_PRESET_ID],
  )
  assert.equal(new Set(definitions.map((preset) => preset.id)).size, 3, 'preset ids must be unique')
  assert.equal(definitions[0].id, MASTER_PRESET_ID, 'master must register first')
  assert.equal(definitions[0].name, 'Cowork模式')
})

test('the removed cowork-thread preset is not registered', () => {
  assert.equal(TOPIC_PRESET_ID, 'cowork-topic')
  assert.equal(presetDefinitions().some((preset) => preset.id === 'cowork-thread'), false)
})

test('the master preset keeps only persona, instructions, time, ask-user, and todo', () => {
  const master = presetById(MASTER_PRESET_ID)

  assert.deepEqual(rowNames(master), [
    PERSONA,
    '@deepseek-ai/dsh-agent-instructions',
    '@deepseek-ai/dsh-time-context',
    TOOL_ASK_USER,
    TOOL_TODO,
  ])
  for (const removed of [TOOL_BASH, TOOL_FS, TOOL_FS_SEARCH, TOOL_JOBS, PRESENT]) {
    assert.equal(rowNames(master).includes(removed), false, `master must not mount ${removed}`)
  }
})

test('the topic preset keeps file, shell, search, job, ask-user, todo, and present tools', () => {
  const names = rowNames(presetById(TOPIC_PRESET_ID))

  for (const required of [
    PERSONA,
    '@deepseek-ai/dsh-agent-instructions',
    '@deepseek-ai/dsh-time-context',
    TOOL_BASH,
    TOOL_FS,
    TOOL_FS_SEARCH,
    TOOL_JOBS,
    TOOL_ASK_USER,
    TOOL_TODO,
    PRESENT,
  ]) {
    assert.equal(names.includes(required), true, `topic must mount ${required}`)
  }
  assert.equal(names.length, 10)
})

test('the topic persona states one topic per session, self-requested review, and a blocked|done handoff', () => {
  const persona = personaPrefixOf(presetById(TOPIC_PRESET_ID))

  assert.equal(typeof persona, 'string')
  assert.match(persona, /one topic per session/i)
  assert.match(persona, /cowork_review_request/)
  assert.match(persona, /cowork_handoff/)
  assert.match(persona, /blocked or done/)
  assert.match(persona, /evidence/i)
  assert.equal(/awaiting_review/.test(persona), false)
})

test('the reviewer persona works from the request scope and does not read the handoff in full', () => {
  const persona = personaPrefixOf(presetById(REVIEWER_PRESET_ID))

  assert.match(persona, /review request/i)
  assert.match(persona, /requestId/i)
  assert.match(persona, /changed paths/i)
  assert.match(persona, /do not read the handoff in full/i)
  assert.match(persona, /evidence, not truth/i)
})

test('the reviewer preset keeps shell plus search, has no file tools, and states its scope boundary', () => {
  const reviewer = presetById(REVIEWER_PRESET_ID)
  const names = rowNames(reviewer)

  // M4A2/M9: the reviewer is physically read-only — no tool-fs means no read,
  // write, or edit tool in its surface; the row list itself is unchanged.
  assert.deepEqual(names, [PERSONA, '@deepseek-ai/dsh-agent-instructions', TOOL_BASH, TOOL_FS_SEARCH])
  assert.equal(names.includes(TOOL_FS), false)
  assert.equal(names.includes(TOOL_FS_SEARCH), true)
  assert.equal(names.includes(TOOL_BASH), true)

  assert.match(REVIEWER_PERSONA, /look only at the requested review scope/i)
  assert.match(REVIEWER_PERSONA, /never merge/i)
  assert.match(REVIEWER_PERSONA, /never resolve conflicts/i)
  assert.match(REVIEWER_PERSONA, /只看请求范围，不合并、不解决冲突/)
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

test('presetDefinitions returns fresh row arrays so callers cannot mutate a shared definition', () => {
  const first = presetDefinitions()
  const second = presetDefinitions()

  assert.notEqual(first, second)
  for (let index = 0; index < first.length; index += 1) {
    assert.notEqual(first[index].plugins, second[index].plugins, `${first[index].id} plugins array must be fresh`)
  }

  const topic = first.find((preset) => preset.id === TOPIC_PRESET_ID)
  topic.plugins.length = 0
  assert.equal(rowNames(presetById(TOPIC_PRESET_ID)).length, 10)
})

test('the master persona reads reports from cowork_notices, not blocked messages', () => {
  assert.match(MASTER_PERSONA, /cowork_notices/)
  assert.match(MASTER_PERSONA, /Review verdicts still arrive as messages/)
  assert.equal(/blocked topics are delivered to you as messages/.test(MASTER_PERSONA), false)
  assert.match(MASTER_PERSONA, /blocked and progress reports/)
})

test('the personas carry no legacy handoff state or merge override (KI-25)', () => {
  const text = [MASTER_PERSONA, TOPIC_PERSONA, REVIEWER_PERSONA].join('\n')
  assert.equal(/awaiting_review/.test(text), false, 'awaiting_review is no longer a review trigger')
  assert.equal(/allowUnreviewed|overrideReason/.test(text), false, 'the merge override is gone')
  assert.match(MASTER_PERSONA, /topics? request/i, 'the master no longer orchestrates reviews')
})
