/**
 * E2E scenario `live-artifact-chain`: the observational real-model delivery chain.
 *
 * The real provider (not a scripted one) must:
 * - register two work items, one from the master and one from a routed topic;
 * - answer an annotation that carries a solid-red image, with the colour word in
 *   the reply (the only externally observable proof the image prompt arrived);
 * - honour `cowork_artifact_reply` for both dispatches, on two sessions at once,
 *   so both batches reach `replied`;
 * - leave the annotation threads in the artifact store.
 *
 * Every real-model turn is observed separately: a failed turn is recorded and
 * the turns that depend on it are skipped, while the master and topic branches
 * continue wherever they are independent. The run reports a per-turn rate.
 * It needs `DEEPSEEK_API_KEY`, runs only with `--mode live`, and is never part of
 * the keyless release evidence.
 */

import { deflateSync } from 'node:zlib'
import { LIVE_TURN_TIMEOUT_MS, liveScenarioTimeout } from '../support/lane-timeouts.mjs'

export const liveArtifactChainId = 'live-artifact-chain'

/**
 * Turns this scenario observes: master init, README registration, routing, the
 * routed topic's brief turn, PLAN registration, and one reply turn per
 * dispatched batch. Each turn owns its timeout; the scenario budget grows with
 * the count.
 */
export const timeoutMs = liveScenarioTimeout(7)

const PROJECT_INIT_PROMPT = 'Call cowork_project_init exactly once with no arguments. Then stop.'
const IN_FLIGHT = new Set(['queued', 'sent', 'thinking', 'working'])
const TERMINAL = new Set(['replied', 'failed', 'blocked', 'stale'])

/** CRC-32 for the PNG chunks this scenario builds. */
function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
    }
  }
  return (value ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length, type, data, CRC. */
function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/** A solid-red 16×16 PNG built without an image dependency. */
function redPng() {
  const width = 16
  const height = 16
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row += 1) {
    const offset = row * stride
    raw[offset] = 0
    for (let column = 0; column < width; column += 1) {
      const pixel = offset + 1 + column * 3
      raw[pixel] = 255
      raw[pixel + 1] = 0
      raw[pixel + 2] = 0
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** @param {ReturnType<import('../support/context.mjs').createScenarioContext>} ctx */
export async function runLiveArtifactChain(ctx) {
  const master = await ctx.client.createSession({ cwd: ctx.fixture.path, agentPreset: 'cowork-master' })
  const masterId = master.sessionId
  const detailOf = async (sessionId, artifactId) => {
    const detail = await ctx.client.panelGet(`/api/cowork.artifact.detail?sessionId=${encodeURIComponent(sessionId)}&artifactId=${encodeURIComponent(artifactId)}`)
    return detail.body?.record
  }

  const initialized = await ctx.turn('master project init', {}, async () => {
    await ctx.client.promptAndWait(masterId, PROJECT_INIT_PROMPT, { timeoutMs: LIVE_TURN_TIMEOUT_MS })
    return await ctx.waitUntil('the live model to initialize the project', async () => {
      const index = await ctx.index()
      return index?.masterSessionId === masterId ? index : undefined
    }, { timeoutMs: LIVE_TURN_TIMEOUT_MS })
  })
  if (initialized !== undefined) {
    ctx.check('the live model initialized the project', initialized.masterSessionId === masterId, initialized.masterSessionId)
  }

  // Artifact 1: the master registers README.md.
  const masterList = await ctx.turn('master registers README.md', { dependsOn: ['master project init'] }, async () => {
    await ctx.client.promptAndWait(
      masterId,
      'Call cowork_artifact_create exactly once with these arguments (JSON): {"path":"README.md","title":"Live 工作项"} . Then stop.',
      { timeoutMs: LIVE_TURN_TIMEOUT_MS },
    )
    return await ctx.waitUntil('the live model to register README.md', async () => {
      const list = await ctx.client.panelGet(`/api/cowork.artifact.list?sessionId=${encodeURIComponent(masterId)}`)
      return list.body?.items?.find((item) => item.primaryPath === 'README.md')
    }, { timeoutMs: LIVE_TURN_TIMEOUT_MS })
  })
  const masterArtifact = masterList?.artifactId
  if (masterList !== undefined) {
    ctx.check('the live model registered README.md', typeof masterArtifact === 'string' && masterArtifact !== '', masterArtifact)
  }

  // A routed topic registers a second artifact so two sessions can be in flight.
  const routed = await ctx.turn('master routes a topic', { dependsOn: ['master project init'] }, async () => {
    await ctx.client.promptAndWait(
      masterId,
      'Call cowork_route exactly once with these arguments (JSON): {"intent":"Measure live work-item delivery","brief":"Live artifact brief.","forceCreate":true}. Then stop.',
      { timeoutMs: LIVE_TURN_TIMEOUT_MS },
    )
    return await ctx.waitUntil('the live model to route a topic', async () => {
      const index = await ctx.index()
      return index !== undefined && index.topics.length > 0 ? index : undefined
    }, { timeoutMs: LIVE_TURN_TIMEOUT_MS })
  })
  const topicId = routed?.topics?.[0]?.topicId
  if (routed !== undefined) {
    ctx.check('the routed topic is a real session', typeof topicId === 'string' && topicId.startsWith('session-'), topicId)
  }

  await ctx.turn('the routed topic finishes its brief turn', { dependsOn: ['master routes a topic'] }, async () => {
    if (topicId === undefined) throw new Error('the routed topic is missing')
    return await ctx.client.waitIdle(topicId, { timeoutMs: LIVE_TURN_TIMEOUT_MS })
  })

  const topicList = await ctx.turn('topic registers PLAN.md', { dependsOn: ['the routed topic finishes its brief turn'] }, async () => {
    if (topicId === undefined) throw new Error('the routed topic is missing')
    await ctx.client.promptAndWait(
      topicId,
      'Call cowork_artifact_create exactly once with these arguments (JSON): {"path":"PLAN.md","title":"Live topic 工作项"} . Then stop.',
      { timeoutMs: LIVE_TURN_TIMEOUT_MS },
    )
    return await ctx.waitUntil('the topic to register PLAN.md', async () => {
      const list = await ctx.client.panelGet(`/api/cowork.artifact.list?sessionId=${encodeURIComponent(topicId)}`)
      return list.body?.items?.find((item) => item.primaryPath === 'PLAN.md')
    }, { timeoutMs: LIVE_TURN_TIMEOUT_MS })
  })
  const topicArtifact = topicList?.artifactId
  if (topicList !== undefined) {
    ctx.check('the topic registered PLAN.md and owns it', topicList.ownerSessionId === topicId, `${String(topicList.ownerSessionId)}/${String(topicId)}`)
  }

  // The master's annotation carries a solid-red image and asks for the colour
  // word in the reply, which is observable without reading provider bytes.
  let masterCommentId
  if (masterArtifact !== undefined) {
    const upload = await ctx.client.panelFetch(
      `/api/cowork.artifact.upload?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(masterArtifact)}&name=red.png`,
      { method: 'POST', body: redPng(), headers: { 'content-type': 'application/octet-stream' } },
    )
    const attachment = await upload.json()
    ctx.check('the red image uploads', upload.status === 200 && attachment.attachment?.mediaType === 'image/png', upload.status)
    const masterComment = await ctx.client.panelPost('/api/cowork.artifact.comment', {
      sessionId: masterId,
      artifactId: masterArtifact,
      body: '附件是一张纯红色（solid red）的图片，对应 README.md 第 1 行。请先在回复正文里写出「红」这个字，再调用 cowork_artifact_reply 回答这条批注。不要修改文件。',
      anchor: { kind: 'line-range', path: 'README.md', startLine: 1, endLine: 1, quote: '# dsh-cowork E2E fixture' },
      attachments: [attachment.attachment],
    })
    masterCommentId = masterComment.body?.comment?.commentId
    ctx.check('the image annotation is dispatched', masterComment.status === 200 && masterComment.body?.dispatch?.state === 'queued', masterComment.body?.dispatch?.state)
  }

  let topicCommentId
  if (topicArtifact !== undefined) {
    const topicComment = await ctx.client.panelPost('/api/cowork.artifact.comment', {
      sessionId: topicId,
      artifactId: topicArtifact,
      body: '请在回复正文里写出「已收到」并调用 cowork_artifact_reply 回答这条批注。不要修改文件。',
      anchor: { kind: 'line-range', path: 'PLAN.md', startLine: 1, endLine: 1, quote: '# PLAN' },
    })
    topicCommentId = topicComment.body?.comment?.commentId
    ctx.check('the topic annotation is dispatched', topicComment.status === 200 && topicComment.body?.dispatch?.state === 'queued', topicComment.body?.dispatch?.state)
  }

  // Both annotations are posted before either wait, so two sessions can be in
  // flight together; the poller only observes, it never decides a turn.
  let overlap = false
  let polling = false
  const poller = setInterval(async () => {
    if (overlap || polling || masterArtifact === undefined || topicArtifact === undefined) return
    polling = true
    try {
      const [masterRecord, topicRecord] = await Promise.all([
        detailOf(masterId, masterArtifact),
        detailOf(topicId, topicArtifact),
      ])
      if (IN_FLIGHT.has(masterRecord?.activeDispatch?.state) && IN_FLIGHT.has(topicRecord?.activeDispatch?.state)) overlap = true
    } catch {
      // A failed poll is retried by the next tick.
    } finally {
      polling = false
    }
  }, 250)

  let masterReply
  let topicReply
  try {
    masterReply = await ctx.turn('master replies to its annotation', { dependsOn: ['master registers README.md'] }, async () => {
      if (masterArtifact === undefined || masterCommentId === undefined) throw new Error('the master annotation is missing')
      return await waitForReply(ctx, masterId, masterArtifact)
    })
    topicReply = await ctx.turn('topic replies to its annotation', { dependsOn: ['topic registers PLAN.md'] }, async () => {
      if (topicArtifact === undefined || topicCommentId === undefined) throw new Error('the topic annotation is missing')
      return await waitForReply(ctx, topicId, topicArtifact)
    })
  } finally {
    clearInterval(poller)
  }

  if (masterReply !== undefined) {
    const comments = await ctx.client.panelGet(`/api/cowork.artifact.comments?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(masterArtifact)}`)
    const reply = comments.body?.events?.find((event) =>
      event.type === 'reply' && event.threadId === masterCommentId && event.author === 'model')
    ctx.check('the master model replied in its thread', reply !== undefined, masterCommentId)
    ctx.check('the reply mentions the red image', typeof reply?.body === 'string' && reply.body.includes('红'), (reply?.body ?? '').slice(0, 80))
  }
  if (topicReply !== undefined) {
    const comments = await ctx.client.panelGet(`/api/cowork.artifact.comments?sessionId=${encodeURIComponent(topicId)}&artifactId=${encodeURIComponent(topicArtifact)}`)
    const reply = comments.body?.events?.find((event) =>
      event.type === 'reply' && event.threadId === topicCommentId && event.author === 'model')
    ctx.check('the topic model replied in its thread', reply !== undefined, topicCommentId)
    ctx.check('the reply acknowledges the topic annotation', typeof reply?.body === 'string' && reply.body.includes('已收到'), (reply?.body ?? '').slice(0, 80))
  }
  if (masterReply !== undefined && topicReply !== undefined) {
    ctx.check('both batches were in flight at the same time', overlap === true, String(overlap))
  }
  if (topicList !== undefined) {
    ctx.check('the two dispatches belong to different sessions', topicList.ownerSessionId !== masterId, topicList.ownerSessionId)
  }
}

/**
 * Wait for one dispatched batch to reach a terminal state, failing the turn
 * unless it reached `replied`.
 *
 * @param {object} ctx Scenario context.
 * @param {string} sessionId Owning session the panel route needs.
 * @param {string} artifactId Work item id.
 * @returns {Promise<object>} The record whose dispatch reached `replied`.
 */
async function waitForReply(ctx, sessionId, artifactId) {
  const record = await ctx.waitUntil('the dispatched batch to settle', async () => {
    const detail = await ctx.client.panelGet(`/api/cowork.artifact.detail?sessionId=${encodeURIComponent(sessionId)}&artifactId=${encodeURIComponent(artifactId)}`)
    const current = detail.body?.record
    return TERMINAL.has(current?.activeDispatch?.state) ? current : undefined
  }, { timeoutMs: LIVE_TURN_TIMEOUT_MS })
  const state = record.activeDispatch?.state
  if (state !== 'replied') throw new Error(`dispatch ended ${String(state)}`)
  return record
}
