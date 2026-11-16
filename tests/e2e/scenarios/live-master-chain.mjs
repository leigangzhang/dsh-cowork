/**
 * E2E scenario `live-master-chain`: the observational real-model smoke.
 *
 * Unlike the keyless scenarios this one sends the real provider two turns: the
 * master is asked to initialize the project and then to route one new topic.
 * Model choice, latency, and tool selection are the observation; assertions are
 * the resulting index and panel state. It needs `DEEPSEEK_API_KEY`, runs only
 * with `--mode live`, and is never part of the keyless release evidence.
 */

export const id = 'live-master-chain'

const LIVE_TIMEOUT_MS = 300_000

/** @param {ReturnType<import('../support/context.mjs').createScenarioContext>} ctx */
export async function run(ctx) {
  const master = await ctx.client.createSession({ cwd: ctx.fixture.path, agentPreset: 'cowork-master' })
  const masterId = master.sessionId
  ctx.check('a real master session mounted cowork-master', master.agentPreset === 'cowork-master', String(master.agentPreset))

  await ctx.client.prompt(masterId, 'Call cowork_project_init exactly once with no arguments. Then stop.')
  const initialized = await ctx.waitUntil('the live model to initialize the project', () => {
    const index = ctx.index()
    return index?.masterSessionId === masterId ? index : undefined
  }, { timeoutMs: LIVE_TIMEOUT_MS })
  ctx.check('the live model called cowork_project_init', initialized.masterSessionId === masterId, initialized.masterSessionId)

  await ctx.client.prompt(
    masterId,
    'Call cowork_route exactly once with these arguments (JSON): {"intent":"Measure the live E2E routing path","brief":"Live E2E brief.","forceCreate":true}. Then stop.',
  )
  const routed = await ctx.waitUntil('the live model to route the topic', () => {
    const index = ctx.index()
    return index !== undefined && index.topics.length > 0 ? index : undefined
  }, { timeoutMs: LIVE_TIMEOUT_MS })
  const topic = routed.topics[0]
  ctx.check('the live model created exactly one topic', routed.topics.length === 1, String(routed.topics.length))
  ctx.check('the routed topic is a real session id', typeof topic.topicId === 'string' && topic.topicId.startsWith('session-'), topic.topicId)
  ctx.check('the routed topic records the master route target', routed.lastRouteTopicId === topic.topicId, String(routed.lastRouteTopicId))

  const overview = await ctx.panelGet(`/api/cowork.overview?sessionId=${encodeURIComponent(masterId)}`)
  ctx.check('GET cowork.overview returns 200 after the live turns', overview.status === 200 && overview.body?.ok === true, String(overview.status))
}
