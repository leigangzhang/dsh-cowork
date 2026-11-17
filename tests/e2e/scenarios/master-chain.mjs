/**
 * E2E scenario `master-chain`: the keyless master chain.
 *
 * One real master session initializes the project, writes and searches memory,
 * creates a topic through both the canonical tool and the deprecated alias,
 * lists topics, routes an intent (which creates a fresh topic session and briefs
 * it), then reads the bounded project status and the notice ledger. Assertions
 * use the project's files and the host's session list, never the prompt text.
 */

import { realpath } from 'node:fs/promises'
import { text, tool } from '../support/scripted-model.mjs'

export const masterChainId = 'master-chain'

const MEMORY_TITLE = 'E2E memory entry'
const ROUTED_INTENT = 'Prove the routed E2E topic receives its brief'
const ROUTED_BRIEF = 'One keyless real-host E2E brief.'

/** @param {ReturnType<import('../support/context.mjs').createScenarioContext>} ctx */
export async function runMasterChain(ctx) {
  ctx.model.setHandler(({ role, prompt, toolResults }) => {
    // The routed topic receives the route brief as its first user message.
    if (role === 'topic') return text('Topic brief acknowledged.')
    if (toolResults.length > 0) return text('Step complete.')
    if (prompt.includes('cowork_project_init')) return tool('cowork_project_init', {})
    if (prompt.includes('cowork_memory_write')) {
      return tool('cowork_memory_write', {
        kind: 'fact',
        title: MEMORY_TITLE,
        text: 'The keyless E2E lane booted a real host.',
        source: 'scenario:master-chain',
      })
    }
    if (prompt.includes('cowork_memory_search')) return tool('cowork_memory_search', { query: 'keyless E2E' })
    if (prompt.includes('cowork_topic_create')) {
      return tool('cowork_topic_create', { title: 'Second E2E topic', scope: 'Created through the canonical tool' })
    }
    if (prompt.includes('cowork_thread_create')) {
      return tool('cowork_thread_create', { title: 'Alias E2E topic' })
    }
    if (prompt.includes('cowork_topic_list')) return tool('cowork_topic_list', {})
    if (prompt.includes('cowork_thread_list')) return tool('cowork_thread_list', {})
    if (prompt.includes('cowork_route')) return tool('cowork_route', { intent: ROUTED_INTENT, brief: ROUTED_BRIEF, forceCreate: true })
    if (prompt.includes('cowork_project_status')) return tool('cowork_project_status', {})
    if (prompt.includes('cowork_notices')) return tool('cowork_notices', { limit: 5 })
    return text('No scripted step matched this prompt.')
  })

  const master = await ctx.client.createSession({ cwd: ctx.fixture.path, agentPreset: 'cowork-master' })
  ctx.check('a real master session mounted cowork-master', master.agentPreset === 'cowork-master', String(master.agentPreset))
  const masterId = master.sessionId

  await ctx.promptForTool(masterId, 'Call cowork_project_init exactly once with no arguments.', 'cowork_project_init')
  const initialized = await ctx.waitUntil('the project index names the master', async () => {
    const index = await ctx.index()
    return index?.masterSessionId === masterId ? index : undefined
  })
  ctx.check('the project index names the created master', initialized.masterSessionId === masterId, initialized.masterSessionId)
  ctx.check('the index starts with no topics', initialized.topics.length === 0, initialized.topics.length)

  await ctx.promptForTool(
    masterId,
    `Call cowork_memory_write exactly once with these arguments (JSON): ${JSON.stringify({
      kind: 'fact',
      title: MEMORY_TITLE,
      text: 'The keyless E2E lane booted a real host.',
      source: 'scenario:master-chain',
    })}`,
    'cowork_memory_write',
  )
  const memory = await ctx.readText('.dsh-cowork/memory/facts.md')
  ctx.check('memory_write appended the fact file', memory !== undefined && memory.includes(MEMORY_TITLE), memory === undefined ? 'missing' : 'present')

  const search = await ctx.promptForTool(
    masterId,
    'Call cowork_memory_search exactly once with these arguments (JSON): {"query":"keyless E2E"}',
    'cowork_memory_search',
  )
  ctx.check('memory_search returned the entry', (search.payload?.hits ?? []).some((hit) => hit.title === MEMORY_TITLE), JSON.stringify(search.payload?.total))

  const created = await ctx.promptForTool(
    masterId,
    `Call cowork_topic_create exactly once with these arguments (JSON): ${JSON.stringify({ title: 'Second E2E topic', scope: 'Created through the canonical tool' })}`,
    'cowork_topic_create',
  )
  const canonicalTopicId = created.payload?.topic?.topicId
  ctx.check('topic_create returned the new topic', typeof canonicalTopicId === 'string' && canonicalTopicId !== '', String(canonicalTopicId))
  const aliasCreated = await ctx.promptForTool(
    masterId,
    `Call cowork_thread_create exactly once with these arguments (JSON): ${JSON.stringify({ title: 'Alias E2E topic' })}`,
    'cowork_thread_create',
  )
  const aliasTopicId = aliasCreated.payload?.topic?.topicId
  ctx.check('thread_create (deprecated alias) returned a distinct topic', typeof aliasTopicId === 'string' && aliasTopicId !== canonicalTopicId, String(aliasTopicId))
  let index = await ctx.index()
  ctx.check('two topics exist before routing', index?.topics.length === 2, String(index?.topics.length))

  await ctx.promptForTool(masterId, 'Call cowork_topic_list exactly once with no arguments.', 'cowork_topic_list')
  await ctx.promptForTool(masterId, 'Call cowork_thread_list exactly once with no arguments.', 'cowork_thread_list')

  const routed = await ctx.promptForTool(
    masterId,
    `Call cowork_route exactly once with these arguments (JSON): ${JSON.stringify({ intent: ROUTED_INTENT, brief: ROUTED_BRIEF, forceCreate: true })}`,
    'cowork_route',
  )
  ctx.check('route created a new topic', routed.payload?.action === 'create', String(routed.payload?.action))
  const routedTopicId = routed.payload?.topicId
  index = await ctx.waitUntil('three topics and the routed target in the index', async () => {
    const current = await ctx.index()
    return current?.topics.length === 3 && current.lastRouteTopicId === routedTopicId ? current : undefined
  })
  ctx.check('the routed topic is a real session id', index.topics.some((topic) => topic.topicId === routedTopicId), String(routedTopicId))
  const routedTopic = index.topics.find((topic) => topic.topicId === routedTopicId)
  ctx.check('the routed topic starts live', routedTopic?.status === 'active' || routedTopic?.status === 'idle', String(routedTopic?.status))
  ctx.check('the route was prompted into the topic session', routed.payload?.prompted === true, String(routed.payload?.prompted))

  await ctx.waitUntil('the routed topic model turn', () =>
    ctx.model.calls.find((call) => call.sessionId === routedTopicId && call.role === 'topic' && call.prompt.includes(ROUTED_BRIEF)))
  await ctx.client.waitIdle(routedTopicId, {})

  const sessions = await ctx.client.listSessions()
  const byId = new Map(sessions.map((session) => [session.sessionId, session]))
  const fixturePath = await realpath(ctx.fixture.path)
  for (const sessionId of [masterId, ...index.topics.map((topic) => topic.topicId)]) {
    const session = byId.get(sessionId)
    let sessionCwd = session?.cwd
    if (typeof sessionCwd === 'string') {
      try {
        sessionCwd = await realpath(sessionCwd)
      } catch {
        // A missing cwd is reported by the equality check below.
      }
    }
    ctx.check(`session ${sessionId.slice(0, 18)}… runs in the fixture`, sessionCwd === fixturePath, String(sessionCwd))
    ctx.check(`session ${sessionId.slice(0, 18)}… is not running`, session?.running === false, String(session?.running))
  }
  for (const topicId of [canonicalTopicId, aliasTopicId, routedTopicId]) {
    const session = byId.get(topicId)
    ctx.check(`topic ${topicId.slice(0, 18)}… is a real session`, session !== undefined, 'missing')
    ctx.check(
      `topic ${topicId.slice(0, 18)}… mounted cowork-topic`,
      session?.projections?.values?.agentPreset === 'cowork-topic',
      String(session?.projections?.values?.agentPreset),
    )
  }

  const status = await ctx.promptForTool(masterId, 'Call cowork_project_status exactly once with no arguments.', 'cowork_project_status')
  ctx.check('project_status lists the three topics', status.payload?.topics?.length === 3, String(status.payload?.topics?.length))
  const notices = await ctx.promptForTool(
    masterId,
    'Call cowork_notices exactly once with these arguments (JSON): {"limit":5}',
    'cowork_notices',
  )
  ctx.check('notices is an ok read', notices.payload?.ok === true, String(notices.payload?.ok))
}
