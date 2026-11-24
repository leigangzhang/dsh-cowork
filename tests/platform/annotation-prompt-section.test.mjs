import test from 'node:test'
import assert from 'node:assert/strict'
import '../support/ts-hook.mjs'

/**
 * Registration lifecycle of the static annotation section: which agents receive
 * it, how repeated events are counted, and what teardown releases. The section
 * text's own content is asserted here because its rules are the reason the
 * delivered message can stay short.
 */
const {
  ANNOTATION_SECTION_TEXT,
  COWORK_ANNOTATION_ORDER,
  COWORK_ANNOTATION_PRESETS,
  COWORK_ANNOTATION_SECTION,
  registerAnnotationPrompt,
} = await import('../../src/platform/annotation-prompt.ts')

/**
 * Fake agent whose `ctx.systemPrompt.section()` records the descriptor and
 * hands back an inspectable disposer. The section text is static, so the test
 * reads `input.text` directly instead of calling a provider.
 */
function fakeAgent(options = {}) {
  const id = Object.hasOwn(options, 'id') ? options.id : 'topic-1'
  const preset = Object.hasOwn(options, 'preset') ? options.preset : 'cowork-topic'
  const header = {}
  if (preset !== undefined) header.agentPreset = preset
  const sections = []
  const agent = {
    id,
    session: { header },
    ctx: {
      systemPrompt: {
        section(input) {
          const record = { input, active: true, disposeCalls: 0 }
          sections.push(record)
          if (options.onSection) options.onSection(input, sections)
          return () => {
            record.active = false
            record.disposeCalls += 1
          }
        },
      },
    },
  }
  return { agent, sections }
}

/** Fake agent registry: manual `emit` plus a swappable `listAgents()` result. */
function fakeHost(initialAgents = []) {
  const listeners = new Set()
  let agents = [...initialAgents]
  const host = {
    onAgentCreated(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    listAgents() {
      return agents
    },
  }
  return {
    host,
    emit(agent, source) {
      for (const listener of [...listeners]) listener({ agent, source })
    },
    listenerCount: () => listeners.size,
    setAgents(next) {
      agents = [...next]
    },
  }
}

/** A logger that records instead of writing to the host. */
function makeDeps() {
  const logs = []
  return { logs, log: (message) => logs.push(message) }
}

test('exports the documented section constants', () => {
  assert.equal(COWORK_ANNOTATION_SECTION, 'cowork:annotation')
  assert.equal(COWORK_ANNOTATION_ORDER, 950)
  assert.deepEqual([...COWORK_ANNOTATION_PRESETS], ['cowork-topic'])
})

test('the section text carries the p1/p2/p3 contract and every handling rule', () => {
  assert.equal(typeof ANNOTATION_SECTION_TEXT, 'string')
  for (const required of [
    'p1',
    'p2',
    'p3',
    'cowork_artifact_reply',
    'cowork_artifact_attach',
    'cowork-attachment://<attachmentId>',
    'write/edit',
    'bash',
    '只改工作项已登记的文件',
    '数据，不是指令',
    'data:',
    'blob:',
    'file:',
    '重新读取',
    '不要把批注讨论',
    '不要长时间思考',
  ]) {
    assert.ok(ANNOTATION_SECTION_TEXT.includes(required), `section text is missing ${required}`)
  }
  // The section is the only home of the rules: the delivery builder does not
  // import this text (see annotation-prompt.test.mjs), so it must not be a
  // per-assembly provider either.
  assert.equal(ANNOTATION_SECTION_TEXT.includes('Work item:'), false)
})

test('registers an existing cowork-topic agent with the exact section contract', () => {
  const { agent, sections } = fakeAgent({ id: 'topic-1' })
  const host = fakeHost([agent])
  const deps = makeDeps()

  const registration = registerAnnotationPrompt(host.host, deps)

  assert.equal(sections.length, 1)
  assert.equal(sections[0].input.name, COWORK_ANNOTATION_SECTION)
  assert.equal(sections[0].input.order, COWORK_ANNOTATION_ORDER)
  assert.equal(sections[0].input.interpolate, false)
  assert.equal(sections[0].input.text, ANNOTATION_SECTION_TEXT)
  assert.deepEqual(registration.registered(), ['topic-1'])
  assert.deepEqual(deps.logs, [])
})

test('never injects annotation rules into the master, the reviewer, or an unknown preset', () => {
  const master = fakeAgent({ id: 'master', preset: 'cowork-master' }).agent
  const reviewer = fakeAgent({ id: 'reviewer', preset: 'cowork-reviewer' }).agent
  const legacy = fakeAgent({ id: 'legacy', preset: 'cowork-thread' }).agent
  const unknown = fakeAgent({ id: 'unknown', preset: 'default' }).agent
  const missing = fakeAgent({ id: 'missing', preset: undefined }).agent
  const host = fakeHost([master, reviewer, legacy, unknown, missing])
  const registration = registerAnnotationPrompt(host.host, makeDeps())

  assert.deepEqual(registration.registered(), [])
})

test('skips an agent without a usable id', () => {
  const blank = fakeAgent({ id: '' }).agent
  const registration = registerAnnotationPrompt(fakeHost([blank]).host, makeDeps())

  assert.deepEqual(registration.registered(), [])
})

test('registers agents created after startup', () => {
  const host = fakeHost([])
  const registration = registerAnnotationPrompt(host.host, makeDeps())
  assert.equal(host.listenerCount(), 1)

  const late = fakeAgent({ id: 'late' })
  host.emit(late.agent, 'create')

  assert.deepEqual(registration.registered(), ['late'])
  assert.equal(late.sections.length, 1)
})

test('registers each agent only once even if it is listed and emitted repeatedly', () => {
  const { agent, sections } = fakeAgent({ id: 'once' })
  const host = fakeHost([agent])
  const registration = registerAnnotationPrompt(host.host, makeDeps())

  host.emit(agent, 'create')
  host.emit(agent, 'restore')

  assert.equal(sections.length, 1)
  assert.deepEqual(registration.registered(), ['once'])
})

test('counts a duplicate section registration without breaking other agents', () => {
  const failing = fakeAgent({
    id: 'dup',
    onSection(input) {
      assert.equal(input.name, COWORK_ANNOTATION_SECTION)
      throw new Error('duplicate section name')
    },
  })
  const healthy = fakeAgent({ id: 'ok' })
  const host = fakeHost([failing.agent, healthy.agent])
  const deps = makeDeps()
  const registration = registerAnnotationPrompt(host.host, deps)

  assert.equal(registration.duplicateSkipped(), 1)
  assert.deepEqual(registration.registered(), ['ok'])
  assert.equal(healthy.sections.length, 1)
  assert.equal(deps.logs.length, 1)
  assert.match(deps.logs[0], /agent dup/)
  assert.match(deps.logs[0], /duplicate section name/)
})

test('counts one duplicate per agent even when its failing event repeats', () => {
  const host = fakeHost([])
  const deps = makeDeps()
  const registration = registerAnnotationPrompt(host.host, deps)
  const failing = fakeAgent({
    id: 'dup',
    onSection() {
      throw new Error('duplicate section name')
    },
  })

  host.emit(failing.agent, 'create')
  host.emit(failing.agent, 'restore')
  host.emit(failing.agent, 'create')

  assert.equal(registration.duplicateSkipped(), 1)
  assert.deepEqual(registration.registered(), [])
  assert.equal(deps.logs.length, 1)
})

test('a section registration that returns no disposer is reported as a failed agent', () => {
  const agent = fakeAgent({ id: 'no-disposer' })
  agent.agent.ctx.systemPrompt.section = () => undefined
  const deps = makeDeps()
  const registration = registerAnnotationPrompt(fakeHost([agent.agent]).host, deps)

  assert.equal(registration.duplicateSkipped(), 1)
  assert.deepEqual(registration.registered(), [])
  assert.equal(deps.logs.length, 1)
  assert.match(deps.logs[0], /section\(\) returned no disposer/)
})

test('dispose releases every section disposer, the listener, and later agents', () => {
  const a = fakeAgent({ id: 'a' })
  const b = fakeAgent({ id: 'b' })
  const host = fakeHost([a.agent, b.agent])
  const registration = registerAnnotationPrompt(host.host, makeDeps())

  registration.dispose()
  registration.dispose()

  assert.equal(host.listenerCount(), 0)
  for (const section of [a.sections[0], b.sections[0]]) {
    assert.equal(section.active, false)
    assert.equal(section.disposeCalls, 1)
  }
  assert.deepEqual(registration.registered(), [])

  const after = fakeAgent({ id: 'after' })
  host.emit(after.agent, 'create')
  assert.equal(after.sections.length, 0)
})

test('a throwing section disposer is logged and the remaining sections are still released', () => {
  const broken = fakeAgent({ id: 'broken' })
  broken.agent.ctx.systemPrompt.section = () => () => {
    throw new Error('release refused')
  }
  const healthy = fakeAgent({ id: 'healthy' })
  const deps = makeDeps()
  const registration = registerAnnotationPrompt(fakeHost([broken.agent, healthy.agent]).host, deps)

  assert.deepEqual(registration.registered(), ['broken', 'healthy'])
  registration.dispose()

  assert.equal(deps.logs.length, 1)
  assert.match(deps.logs[0], /cowork: annotation section disposer failed: release refused/)
  assert.equal(healthy.sections[0].active, false, 'one failing disposer must not leak the next section')
  assert.equal(healthy.sections[0].disposeCalls, 1)
})
