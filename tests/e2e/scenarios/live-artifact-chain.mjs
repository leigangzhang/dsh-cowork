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
 * It needs `DEEPSEEK_API_KEY`, runs only with `--mode live`, and is never part of
 * the keyless release evidence.
 */

import { deflateSync } from 'node:zlib'
import { liveScenarioTimeout, LIVE_TURN_TIMEOUT_MS } from '../support/lane-timeouts.mjs'

export const liveArtifactChainId = 'live-artifact-chain'

/**
 * Turns this scenario waits on: master init, README registration, routing, the
 * routed topic's brief, PLAN registration, and one reply turn per dispatched
 * batch. Each turn owns its timeout; the scenario budget grows with the count.
 */
export const timeoutMs = liveScenarioTimeout(7)
const PROJECT_INIT_PROMPT = 'Call cowork_project_init exactly once with no arguments. Then stop.'

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
  await ctx.client.promptAndWait(masterId, PROJECT_INIT_PROMPT, { timeoutMs: LIVE_TURN_TIMEOUT_MS })
  const initialized = await ctx.waitUntil('the live model to initialize the project', async () => {
    const index = await ctx.index()
    return index?.masterSessionId === masterId ? index : undefined
  }, { timeoutMs: LIVE_TURN_TIMEOUT_MS })
  ctx.check('the live model initialized the project', initialized.masterSessionId === masterId, initialized.masterSessionId)

  // Artifact 1: the master registers README.md.
  await ctx.client.promptAndWait(
    masterId,
    'Call cowork_artifact_create exactly once with these arguments (JSON): {"path":"README.md","title":"Live 工作项"} . Then stop.',
    { timeoutMs: LIVE_TURN_TIMEOUT_MS },
  )
  const masterList = await ctx.waitUntil('the live model to register README.md', async () => {
    const list = await ctx.client.panelGet(`/api/cowork.artifact.list?sessionId=${encodeURIComponent(masterId)}`)
    const item = list.body?.items?.find((entry) => entry.primaryPath === 'README.md')
    return item === undefined ? undefined : item
  }, { timeoutMs: LIVE_TURN_TIMEOUT_MS })
  const masterArtifact = masterList.artifactId
  ctx.check('the live model registered README.md', typeof masterArtifact === 'string' && masterArtifact !== '', masterArtifact)

  // A routed topic registers a second artifact so two sessions can be in flight.
  await ctx.client.promptAndWait(
    masterId,
    'Call cowork_route exactly once with these arguments (JSON): {"intent":"Measure live work-item delivery","brief":"Live artifact brief.","forceCreate":true}. Then stop.',
    { timeoutMs: LIVE_TURN_TIMEOUT_MS },
  )
  const routed = await ctx.waitUntil('the live model to route a topic', async () => {
    const index = await ctx.index()
    return index !== undefined && index.topics.length > 0 ? index : undefined
  }, { timeoutMs: LIVE_TURN_TIMEOUT_MS })
  const topicId = routed.topics[0].topicId
  ctx.check('the routed topic is a real session', typeof topicId === 'string' && topicId.startsWith('session-'), topicId)
  await ctx.client.waitIdle(topicId, { timeoutMs: LIVE_TURN_TIMEOUT_MS })

  await ctx.client.promptAndWait(
    topicId,
    'Call cowork_artifact_create exactly once with these arguments (JSON): {"path":"PLAN.md","title":"Live topic 工作项"} . Then stop.',
    { timeoutMs: LIVE_TURN_TIMEOUT_MS },
  )
  const topicList = await ctx.waitUntil('the topic to register PLAN.md', async () => {
    const list = await ctx.client.panelGet(`/api/cowork.artifact.list?sessionId=${encodeURIComponent(topicId)}`)
    const item = list.body?.items?.find((entry) => entry.primaryPath === 'PLAN.md')
    return item === undefined ? undefined : item
  }, { timeoutMs: LIVE_TURN_TIMEOUT_MS })
  const topicArtifact = topicList.artifactId
  const topicOwner = topicList.ownerSessionId
  ctx.check('the topic registered PLAN.md and owns it', topicOwner === topicId, `${String(topicOwner)}/${String(topicId)}`)

  // The master's annotation carries a solid-red image and asks for the colour
  // word in the reply, which is observable without reading provider bytes.
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
  const masterCommentId = masterComment.body?.comment?.commentId
  ctx.check('the image annotation is dispatched', masterComment.status === 200 && masterComment.body?.dispatch?.state === 'queued', masterComment.body?.dispatch?.state)

  const topicComment = await ctx.client.panelPost('/api/cowork.artifact.comment', {
    sessionId: topicId,
    artifactId: topicArtifact,
    body: '请在回复正文里写出「已收到」并调用 cowork_artifact_reply 回答这条批注。不要修改文件。',
    anchor: { kind: 'line-range', path: 'PLAN.md', startLine: 1, endLine: 1, quote: '# PLAN' },
  })
  const topicCommentId = topicComment.body?.comment?.commentId
  ctx.check('the topic annotation is dispatched', topicComment.status === 200 && topicComment.body?.dispatch?.state === 'queued', topicComment.body?.dispatch?.state)

  const detailOf = async (sessionId, artifactId) => {
    const detail = await ctx.client.panelGet(`/api/cowork.artifact.detail?sessionId=${encodeURIComponent(sessionId)}&artifactId=${encodeURIComponent(artifactId)}`)
    return detail.body?.record
  }
  let overlap = false
  const settled = await ctx.waitUntil('both real models to reply', async () => {
    const [masterRecord, topicRecord] = await Promise.all([
      detailOf(masterId, masterArtifact),
      detailOf(topicId, topicArtifact),
    ])
    const masterState = masterRecord?.activeDispatch?.state
    const topicState = topicRecord?.activeDispatch?.state
    const inFlight = (state) => state === 'queued' || state === 'sent' || state === 'thinking' || state === 'working'
    if (inFlight(masterState) && inFlight(topicState)) overlap = true
    const terminal = (state) => state === 'replied' || state === 'failed' || state === 'blocked' || state === 'stale'
    if (!terminal(masterState) || !terminal(topicState)) return undefined
    return { masterState, topicState }
  }, { timeoutMs: LIVE_TURN_TIMEOUT_MS })
  ctx.check('the master batch reached replied', settled.masterState === 'replied', settled.masterState)
  ctx.check('the topic batch reached replied', settled.topicState === 'replied', settled.topicState)
  ctx.check('both batches were in flight at the same time', overlap === true, String(overlap))
  ctx.check('the two dispatches belong to different sessions', topicOwner !== masterId, topicOwner)

  const masterComments = await ctx.client.panelGet(`/api/cowork.artifact.comments?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(masterArtifact)}`)
  const masterReply = masterComments.body?.events?.find((event) =>
    event.type === 'reply' && event.threadId === masterCommentId && event.author === 'model')
  const topicComments = await ctx.client.panelGet(`/api/cowork.artifact.comments?sessionId=${encodeURIComponent(topicId)}&artifactId=${encodeURIComponent(topicArtifact)}`)
  const topicReply = topicComments.body?.events?.find((event) =>
    event.type === 'reply' && event.threadId === topicCommentId && event.author === 'model')
  ctx.check('the master model replied in its thread', masterReply !== undefined, masterCommentId)
  ctx.check('the topic model replied in its thread', topicReply !== undefined, topicCommentId)
  ctx.check('the reply mentions the red image', typeof masterReply?.body === 'string' && masterReply.body.includes('红'), (masterReply?.body ?? '').slice(0, 80))
  ctx.check('the reply acknowledges the topic annotation', typeof topicReply?.body === 'string' && topicReply.body.includes('已收到'), (topicReply?.body ?? '').slice(0, 80))
}
