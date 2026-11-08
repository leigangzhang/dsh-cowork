import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  COWORK_MEMORY_ORDER,
  COWORK_MEMORY_PRESETS,
  COWORK_MEMORY_SECTION,
  registerMemoryPrompt,
} from '../src/memory-prompt.ts'

const SOURCE_URL = new URL('../src/memory-prompt.ts', import.meta.url)

/**
 * Fake agent whose `ctx.systemPrompt.section()` records the descriptor and
 * hands back a disposer the test can inspect. The provider is never called by
 * the harness itself, so tests invoke `sections[i].input.text` explicitly —
 * that is the same function the host would call per assembly.
 */
function fakeAgent(options = {}) {
  const id = options.id ?? 'agent-1'
  // Distinguish "field absent" from an explicit `undefined`, which stands for a
  // header that simply does not carry that field.
  const cwd = Object.hasOwn(options, 'cwd') ? options.cwd : '/work/app'
  const preset = Object.hasOwn(options, 'preset') ? options.preset : 'cowork-master'
  const header = {}
  if (cwd !== undefined) header.cwd = cwd
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

/** Pull the provider out of a recorded section and assert it is a function. */
function providerOf(sections, index = 0) {
  const section = sections[index]
  assert.ok(section, `expected a registered section at index ${index}`)
  assert.equal(typeof section.input.text, 'function')
  return section.input.text
}

/** Fake agent registry: manual `emit` + swappable `listAgents()` result. */
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

/**
 * Fake IO ports. `options.resolve(cwd)` overrides project lookup;
 * `options.render(repoPath, callNumber)` overrides the rendered memory so a
 * test can change the digest between assemblies.
 */
function makeDeps(options = {}) {
  const resolveCalls = []
  const renderCalls = []
  const logs = []
  const deps = {
    resolveCalls,
    renderCalls,
    logs,
    resolveProjectRoot(cwd) {
      resolveCalls.push(cwd)
      if (options.resolve) return options.resolve(cwd)
      return cwd.startsWith('/work/') ? `${cwd}/.dsh-cowork` : null
    },
    renderMemory(repoPath) {
      renderCalls.push(repoPath)
      if (options.render) return options.render(repoPath, renderCalls.length)
      return options.renderValue ?? null
    },
    log(message) {
      logs.push(message)
    },
  }
  return deps
}

test('exports the documented constants', () => {
  assert.equal(COWORK_MEMORY_SECTION, 'cowork:memory')
  assert.equal(COWORK_MEMORY_ORDER, 900)
  assert.deepEqual([...COWORK_MEMORY_PRESETS], ['cowork-master', 'cowork-topic', 'cowork-thread'])
})

test('registers an existing cowork-master agent with the exact section contract', () => {
  const { agent, sections } = fakeAgent({ id: 'master', cwd: '/work/app', preset: 'cowork-master' })
  const host = fakeHost([agent])
  const deps = makeDeps()

  const registration = registerMemoryPrompt(host.host, deps)

  assert.equal(sections.length, 1)
  assert.equal(sections[0].input.name, COWORK_MEMORY_SECTION)
  assert.equal(sections[0].input.order, COWORK_MEMORY_ORDER)
  assert.equal(sections[0].input.interpolate, false)
  assert.equal(typeof sections[0].input.text, 'function')
  assert.deepEqual(registration.registered(), ['master'])
  assert.deepEqual(deps.resolveCalls, ['/work/app'])
  // Rendering is lazy: registering must not touch the memory store.
  assert.deepEqual(deps.renderCalls, [])
})

test('registers a cowork-thread agent too', () => {
  const { agent, sections } = fakeAgent({ id: 'thread-1', preset: 'cowork-thread' })
  const deps = makeDeps()
  const registration = registerMemoryPrompt(fakeHost([agent]).host, deps)

  assert.equal(sections.length, 1)
  assert.equal(sections[0].input.name, 'cowork:memory')
  assert.deepEqual(registration.registered(), ['thread-1'])
})

test('registers a cowork-topic agent with the same section contract', () => {
  const { agent, sections } = fakeAgent({ id: 'topic-1', preset: 'cowork-topic' })
  const deps = makeDeps()
  const registration = registerMemoryPrompt(fakeHost([agent]).host, deps)

  assert.equal(sections.length, 1)
  assert.equal(sections[0].input.name, COWORK_MEMORY_SECTION)
  assert.deepEqual(registration.registered(), ['topic-1'])
  assert.deepEqual(deps.resolveCalls, ['/work/app'])
})

test('never injects memory into the reviewer or an unknown preset', () => {
  const reviewer = fakeAgent({ id: 'reviewer', preset: 'cowork-reviewer' }).agent
  const unknown = fakeAgent({ id: 'unknown', preset: 'cowork-topic-legacy' }).agent
  const deps = makeDeps()
  const registration = registerMemoryPrompt(fakeHost([reviewer, unknown]).host, deps)

  assert.deepEqual(registration.registered(), [])
  assert.deepEqual(deps.resolveCalls, [])
})

test('skips agents whose preset is not a cowork preset', () => {
  const plain = fakeAgent({ id: 'plain', preset: 'default' }).agent
  const missing = fakeAgent({ id: 'missing', preset: undefined }).agent
  const deps = makeDeps()
  const registration = registerMemoryPrompt(fakeHost([plain, missing]).host, deps)

  assert.deepEqual(registration.registered(), [])
  assert.deepEqual(deps.resolveCalls, [])
})

test('skips agents without a usable cwd', () => {
  const absent = fakeAgent({ id: 'no-cwd', cwd: undefined }).agent
  const blank = fakeAgent({ id: 'blank-cwd', cwd: '   ' }).agent
  const deps = makeDeps()
  const registration = registerMemoryPrompt(fakeHost([absent, blank]).host, deps)

  assert.deepEqual(registration.registered(), [])
  assert.deepEqual(deps.resolveCalls, [])
})

test('skips agents whose cwd is not inside an initialized project', () => {
  const { agent, sections } = fakeAgent({ id: 'outside', cwd: '/elsewhere/repo' })
  const deps = makeDeps()
  const registration = registerMemoryPrompt(fakeHost([agent]).host, deps)

  assert.equal(sections.length, 0)
  assert.deepEqual(registration.registered(), [])
  assert.deepEqual(deps.resolveCalls, ['/elsewhere/repo'])
})

test('re-renders memory on every assembly', () => {
  const { agent, sections } = fakeAgent()
  const deps = makeDeps({ renderValue: { text: 'memory one', digest: 'd1' } })
  registerMemoryPrompt(fakeHost([agent]).host, deps)
  const provider = providerOf(sections)

  assert.equal(provider({}), 'memory one')
  assert.equal(provider({}), 'memory one')
  assert.equal(provider({}), 'memory one')
  assert.deepEqual(deps.renderCalls, ['/work/app/.dsh-cowork', '/work/app/.dsh-cowork', '/work/app/.dsh-cowork'])
})

test('reuses the cached text while the digest is unchanged', () => {
  const { agent, sections } = fakeAgent()
  const deps = makeDeps({
    render: (_repo, call) => (call === 1
      ? { text: 'first text', digest: 'stable' }
      : { text: 'should never be used', digest: 'stable' }),
  })
  registerMemoryPrompt(fakeHost([agent]).host, deps)
  const provider = providerOf(sections)

  assert.equal(provider({}), 'first text')
  assert.equal(provider({}), 'first text')
  assert.equal(deps.renderCalls.length, 2)
})

test('returns new text and updates the cache when the digest changes', () => {
  const { agent, sections } = fakeAgent()
  const deps = makeDeps({
    render: (_repo, call) => {
      if (call === 1) return { text: 'v1', digest: 'd1' }
      if (call === 2) return { text: 'v2', digest: 'd2' }
      return { text: 'ignored v2 body', digest: 'd2' }
    },
  })
  registerMemoryPrompt(fakeHost([agent]).host, deps)
  const provider = providerOf(sections)

  assert.equal(provider({}), 'v1')
  assert.equal(provider({}), 'v2')
  assert.equal(provider({}), 'v2')
})

test('renders an empty string when the project has no memory yet', () => {
  const { agent, sections } = fakeAgent()
  const deps = makeDeps({ renderValue: null })
  registerMemoryPrompt(fakeHost([agent]).host, deps)

  assert.equal(providerOf(sections)({}), '')
})

test('clears the cache when renderMemory returns null so recovered text is fresh', () => {
  const { agent, sections } = fakeAgent()
  const deps = makeDeps({
    render: (_repo, call) => {
      if (call === 1) return { text: 'stale block', digest: 'same' }
      if (call === 2) return null
      // Same digest as the pre-null render: only a cleared cache re-emits text.
      return { text: 'fresh block', digest: 'same' }
    },
  })
  registerMemoryPrompt(fakeHost([agent]).host, deps)
  const provider = providerOf(sections)

  assert.equal(provider({}), 'stale block')
  assert.equal(provider({}), '')
  assert.equal(provider({}), 'fresh block')
  assert.equal(deps.renderCalls.length, 3)
})

test('keeps the provider cache isolated per agent', () => {
  const renders = {
    '/work/a/.dsh-cowork': { text: 'A one', digest: 'a1' },
    '/work/b/.dsh-cowork': { text: 'B one', digest: 'b1' },
  }
  const deps = makeDeps({ render: (repo) => renders[repo] })
  const a = fakeAgent({ id: 'a', cwd: '/work/a' })
  const b = fakeAgent({ id: 'b', cwd: '/work/b' })
  registerMemoryPrompt(fakeHost([a.agent, b.agent]).host, deps)
  const providerA = providerOf(a.sections)
  const providerB = providerOf(b.sections)

  assert.equal(providerA({}), 'A one')
  assert.equal(providerB({}), 'B one')
  renders['/work/b/.dsh-cowork'] = { text: 'B two', digest: 'b2' }
  assert.equal(providerB({}), 'B two')
  assert.equal(providerA({}), 'A one')
})

test('counts a duplicate section registration without breaking other agents', () => {
  const failing = fakeAgent({
    id: 'dup',
    onSection(input) {
      assert.equal(input.name, COWORK_MEMORY_SECTION)
      throw new Error('duplicate section name')
    },
  })
  const healthy = fakeAgent({ id: 'ok' })
  const deps = makeDeps()
  const registration = registerMemoryPrompt(fakeHost([failing.agent, healthy.agent]).host, deps)

  assert.equal(registration.duplicateSkipped(), 1)
  assert.deepEqual(registration.registered(), ['ok'])
  assert.equal(healthy.sections.length, 1)
  assert.equal(deps.logs.length, 1)
  assert.match(deps.logs[0], /dup/)
  assert.match(deps.logs[0], /duplicate section name/)
})

test('counts one duplicate per agent even when its failing event repeats', () => {
  const host = fakeHost([])
  const deps = makeDeps()
  const registration = registerMemoryPrompt(host.host, deps)
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
  // One log line: the repeat events are rejected before registering again.
  assert.equal(deps.logs.length, 1)
})

test('counts each failing agent separately across listing and emitted events', () => {
  const listed = fakeAgent({
    id: 'dup-a',
    onSection() {
      throw new Error('duplicate section name')
    },
  })
  const host = fakeHost([listed.agent])
  const deps = makeDeps()
  const registration = registerMemoryPrompt(host.host, deps)

  const emitted = fakeAgent({
    id: 'dup-b',
    onSection() {
      throw new Error('duplicate section name')
    },
  })
  host.emit(emitted.agent, 'create')

  assert.equal(registration.duplicateSkipped(), 2)
  // Re-emitting an already counted agent must not raise the count.
  host.emit(listed.agent, 'restore')
  assert.equal(registration.duplicateSkipped(), 2)
})

test('registers each agent only once even if it is listed and emitted repeatedly', () => {
  const { agent, sections } = fakeAgent({ id: 'once' })
  const host = fakeHost([agent])
  const deps = makeDeps()
  const registration = registerMemoryPrompt(host.host, deps)

  host.emit(agent, 'create')
  host.emit(agent, 'restore')

  assert.equal(sections.length, 1)
  assert.deepEqual(registration.registered(), ['once'])
})

test('registers agents created after startup and stops listening after dispose', () => {
  const host = fakeHost([])
  const deps = makeDeps()
  const registration = registerMemoryPrompt(host.host, deps)
  assert.equal(host.listenerCount(), 1)

  const late = fakeAgent({ id: 'late' })
  host.emit(late.agent, 'create')
  assert.deepEqual(registration.registered(), ['late'])
  assert.equal(late.sections.length, 1)

  registration.dispose()
  assert.equal(host.listenerCount(), 0)

  const after = fakeAgent({ id: 'after' })
  host.emit(after.agent, 'create')
  assert.equal(after.sections.length, 0)
  assert.deepEqual(registration.registered(), [])
})

test('dispose releases every section disposer exactly once', () => {
  const a = fakeAgent({ id: 'a' })
  const b = fakeAgent({ id: 'b' })
  const host = fakeHost([a.agent, b.agent])
  const deps = makeDeps()
  const registration = registerMemoryPrompt(host.host, deps)

  registration.dispose()
  registration.dispose()

  assert.equal(host.listenerCount(), 0)
  assert.equal(a.sections[0].active, false)
  assert.equal(b.sections[0].active, false)
  assert.equal(a.sections[0].disposeCalls, 1)
  assert.equal(b.sections[0].disposeCalls, 1)
  assert.deepEqual(registration.registered(), [])
})

test('does not render through a stale provider after dispose', () => {
  const { agent, sections } = fakeAgent()
  const deps = makeDeps({ renderValue: { text: 'memory', digest: 'd1' } })
  const registration = registerMemoryPrompt(fakeHost([agent]).host, deps)
  const provider = providerOf(sections)

  assert.equal(provider({}), 'memory')
  assert.equal(deps.renderCalls.length, 1)

  registration.dispose()
  assert.equal(provider({}), '')
  assert.equal(deps.renderCalls.length, 1)
})

test('registered() hands out a copy, not the internal list', () => {
  const { agent } = fakeAgent({ id: 'copy' })
  const registration = registerMemoryPrompt(fakeHost([agent]).host, makeDeps())

  const first = registration.registered()
  first.push('injected')

  assert.deepEqual(registration.registered(), ['copy'])
})

test('logs and skips an agent whose project lookup throws', () => {
  const broken = fakeAgent({ id: 'broken', cwd: '/work/broken' })
  const healthy = fakeAgent({ id: 'healthy', cwd: '/work/healthy' })
  const deps = makeDeps({
    resolve(cwd) {
      if (cwd === '/work/broken') throw new Error('store corrupt')
      return `${cwd}/.dsh-cowork`
    },
  })
  const registration = registerMemoryPrompt(fakeHost([broken.agent, healthy.agent]).host, deps)

  assert.deepEqual(registration.registered(), ['healthy'])
  assert.equal(broken.sections.length, 0)
  assert.equal(deps.logs.length, 1)
  assert.match(deps.logs[0], /store corrupt/)
})

test('source stays pure: no fs and no host imports', () => {
  const source = readFileSync(SOURCE_URL, 'utf8')
  assert.doesNotMatch(source, /from\s+['"]node:/)
  assert.doesNotMatch(source, /from\s+['"]@deepseek-ai\//)
  assert.doesNotMatch(source, /from\s+['"]\.{1,2}\//)
  assert.doesNotMatch(source, /\bimport\s*\(/)
})
