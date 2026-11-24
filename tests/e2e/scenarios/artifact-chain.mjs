/**
 * E2E scenario `artifact-chain`: the keyless work-item chain on a real host.
 *
 * A master session registers README.md as a work item, then the panel routes
 * read it, annotate it, save an edit, report presence, upload attachment bytes,
 * publish them through `artifact.attach`, serve the attachment bytes, and
 * consume the project SSE stream. The scripted model attaches a project PNG as
 * a model-sourced attachment through `cowork_artifact_attach`, and must call
 * `cowork_artifact_reply` for the dispatched annotation to become `replied`.
 * Assertions use the routes, the tool payloads, and the files; the only
 * prompt-text assertions pin the annotation delivery format the scripted model
 * routes on, so a format drift fails with the observed message.
 */

import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { text, tool } from '../support/scripted-model.mjs'

export const artifactChainId = 'artifact-chain'

const SPEC_PATH = 'README.md'
const REBOUND_PATH = 'README-rebound.md'
const CHART_PATH = 'e2e-chart.png'
const FIRST_COMMENT = 'E2E 第一段批注'
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)


/** The primary path one rebind response reports. */
function reboundPath(response) {
  return response.body?.record?.primaryPath
}

/** Whether one panel response answered 200. */
function panelOk(response) {
  return response.status === 200
}

/** Whether one rebind response reported a changed record. */
function rebindChanged(response) {
  return response.body?.changed === true
}

/**
 * Re-throw a dispatch wait timeout with the model prompts that actually ran.
 *
 * A routing mismatch used to surface only as "timed out waiting for the batch
 * to become replied"; naming the observed prompts makes a format drift
 * actionable (the first line is the annotation marker or the prompt's own
 * opening line).
 */
function withPromptDiagnostics(ctx, sessionId, error) {
  const observed = ctx.model.calls
    .filter((call) => call.sessionId === sessionId)
    .map((call) => call.prompt.split('\n')[0].slice(0, 80))
  const reason = error instanceof Error ? error.message : String(error)
  return new Error(`${reason}; model prompts: ${JSON.stringify(observed)}`)
}

/** Check the response that moved the registered file to its new path. */
function checkRebound(ctx, response, newPath) {
  const ok = panelOk(response) && rebindChanged(response) && reboundPath(response) === newPath
  ctx.check('rebind re-points the moved file', ok, `${response.status}:${reboundPath(response)}`)
}

/** Check the idempotent retry that re-sends the same old and new path. */
function checkIdempotentRebind(ctx, response, path) {
  const ok = panelOk(response) && rebindChanged(response) === false && reboundPath(response) === path
  ctx.check('rebind is idempotent for the same path', ok, `${response.status}:${rebindChanged(response)}`)
}

/** Whether the rail list carries this work item at its rebound path. */
function listedRebound(response, artifactId, path) {
  return response.body?.items?.some(
    (item) => item.artifactId === artifactId && item.primaryPath === path,
  ) === true
}

/** Check the rail list after a rebind reports the new primary path. */
function checkReboundListed(ctx, response, artifactId, path) {
  const listed = listedRebound(response, artifactId, path)
  ctx.check('the rail lists the rebound path', panelOk(response) && listed, String(response.status))
}

/** Move the registered file and prove the work item now points at its new path. */
async function runRebindStep(ctx, masterId, artifactId) {
  await rename(join(ctx.fixture.path, SPEC_PATH), join(ctx.fixture.path, REBOUND_PATH))
  const rebind = (oldPath, newPath) => ctx.client.panelPost('/api/cowork.artifact.rebind', {
    sessionId: masterId,
    artifactId,
    oldPath,
    newPath,
  })
  checkRebound(ctx, await rebind(SPEC_PATH, REBOUND_PATH), REBOUND_PATH)
  checkIdempotentRebind(ctx, await rebind(REBOUND_PATH, REBOUND_PATH), REBOUND_PATH)
  const list = await ctx.client.panelGet(`/api/cowork.artifact.list?sessionId=${encodeURIComponent(masterId)}`)
  checkReboundListed(ctx, list, artifactId, REBOUND_PATH)
}
const WORK_ITEM_TITLE = 'E2E 工作项'
const GUARD_EDIT_ARGS = {
  file_path: SPEC_PATH,
  old_string: '# dsh-cowork E2E fixture',
  new_string: '# GUARD TEST',
}
/** The model/effort the dispatched reply must inherit from its session. */
const MODEL_SELECTION = { provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'max' }

/** The first artifact id one prompt names, or the empty string. */
function artifactIdOf(prompt) {
  return /artifact-[A-Za-z0-9-]+/.exec(prompt)?.[0] ?? ''
}

/** The attach tool input for the file the scenario generated. */
function attachToolInput(prompt) {
  return { artifactId: artifactIdOf(prompt), sourcePath: CHART_PATH, name: 'e2e-chart.png' }
}

/** The dispatched annotation's ids, recorded for the format assertions. */
function parseDelivery(prompt) {
  return {
    prompt,
    artifactId: /Work item: (artifact-[A-Za-z0-9-]+)/.exec(prompt)?.[1] ?? '',
    commentIds: [...prompt.matchAll(/--- annotation (comment-[A-Za-z0-9-]+) ---/g)].map((match) => match[1]),
  }
}

/** Answer one delivered annotation with `cowork_artifact_reply`. */
function annotationReply(prompt, rememberDelivery) {
  const delivery = parseDelivery(prompt)
  rememberDelivery(delivery)
  return tool('cowork_artifact_reply', {
    artifactId: delivery.artifactId,
    commentIds: delivery.commentIds,
    body: 'E2E 模型回复',
  })
}

/** The instruction-shaped prompts this scenario drives, in routing order. */
const STEP_ROUTES = [
  ['cowork_project_init', () => tool('cowork_project_init', {})],
  ['cowork_artifact_create', () => tool('cowork_artifact_create', { path: SPEC_PATH, title: WORK_ITEM_TITLE })],
  ['cowork_artifact_attach', (prompt) => tool('cowork_artifact_attach', attachToolInput(prompt))],
  ['cowork_artifact_comments', (prompt) => tool('cowork_artifact_comments', { artifactId: artifactIdOf(prompt) })],
  ['Call edit exactly once', () => tool('edit', GUARD_EDIT_ARGS)],
]

/** The tool reply one instruction prompt asks for, or null. */
function stepReplyFor(prompt) {
  const route = STEP_ROUTES.find(([needle]) => prompt.includes(needle))
  return route === undefined ? null : route[1](prompt)
}

/** One scripted assistant turn: a step tool, an annotation reply, or prose. */
function scriptedTurnFor(prompt, toolResults, rememberDelivery) {
  if (toolResults.length > 0) return text('Step complete.')
  const step = stepReplyFor(prompt)
  if (step !== null) return step
  if (prompt.includes('cowork-annotation/v1')) return annotationReply(prompt, rememberDelivery)
  return text('No scripted step matched this prompt.')
}

/** Create the master session the scenario drives. */
async function createMasterSession(ctx) {
  const master = await ctx.client.createSession({ cwd: ctx.fixture.path, agentPreset: 'cowork-master' })
  return master.sessionId
}

/** Initialize the project and register README.md as the work item. */
async function registerWorkItem(ctx, masterId) {
  await ctx.promptForTool(masterId, 'Call cowork_project_init exactly once with no arguments.', 'cowork_project_init')
  const created = await ctx.promptForTool(
    masterId,
    `Call cowork_artifact_create exactly once with these arguments (JSON): ${JSON.stringify({ path: SPEC_PATH, title: WORK_ITEM_TITLE })}`,
    'cowork_artifact_create',
  )
  const artifactId = created.payload?.artifact?.artifactId
  const produced = typeof artifactId === 'string' && artifactId !== ''
  ctx.check('artifact_create returned an id', produced, String(artifactId))
  return artifactId
}

/** Whether one list body carries the work item. */
function listCarries(body, artifactId) {
  return (body?.items ?? []).some((item) => item.artifactId === artifactId)
}

/** The rail's first list read must project the new work item. */
async function checkListProjection(ctx, masterId, artifactId) {
  const list = await ctx.client.panelGet(`/api/cowork.artifact.list?sessionId=${encodeURIComponent(masterId)}`)
  ctx.check('the rail lists the new work item', list.status === 200 && listCarries(list.body, artifactId), JSON.stringify(list.body?.items?.length))
}

/** Detail must serve the record the list projected. */
async function checkDetailProjection(ctx, masterId, artifactId) {
  const detail = await ctx.client.panelGet(`/api/cowork.artifact.detail?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}`)
  ctx.check('detail serves the record', detail.status === 200 && detail.body?.record?.primaryPath === SPEC_PATH, detail.body?.record?.primaryPath)
}

/** Read the registered text file and keep the revisions later saves depend on. */
async function readRegisteredFile(ctx, masterId, artifactId) {
  const filePath = `/api/cowork.artifact.file?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}&path=${encodeURIComponent(SPEC_PATH)}`
  const file = await ctx.client.panelGet(filePath)
  ctx.check('the file route serves the text', file.status === 200 && typeof file.body?.content === 'string', file.status)
  return { filePath, baseRevision: file.body.revision, baseVersion: file.body.fsVersion }
}

/** The first view moves the collaboration status. */
async function markViewed(ctx, masterId, artifactId) {
  const viewed = await ctx.client.panelPost('/api/cowork.artifact.status', { sessionId: masterId, artifactId, action: 'view' })
  ctx.check('first view moves the status to pending-confirm', viewed.status === 200 && viewed.body?.record?.status === 'pending-confirm', viewed.body?.record?.status)
}

/** Presence reports a positive TTL for one editing range. */
async function reportPresence(ctx, masterId, artifactId) {
  const presence = await ctx.client.panelPost('/api/cowork.artifact.presence', {
    sessionId: masterId,
    artifactId,
    path: SPEC_PATH,
    ranges: [{ startLine: 1, endLine: 1 }],
  })
  ctx.check('presence reports its TTL', presence.status === 200 && presence.body?.ttlMs > 0, presence.body?.ttlMs)
}

/** Open the project stream before the write and return a frame reader. */
async function openEventStream(ctx, masterId, artifactId) {
  const controller = new AbortController()
  const stream = await ctx.client.panelFetch(
    `/api/cowork.artifact.events?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}`,
    { signal: controller.signal },
  )
  ctx.check('the SSE route answers text/event-stream', stream.status === 200 && (stream.headers.get('content-type') ?? '').includes('text/event-stream'), stream.status)
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let frames = ''
  const readUntil = async (needle, label) => {
    await ctx.waitUntil(label, async () => {
      while (!frames.includes(needle)) {
        const chunk = await reader.read()
        if (chunk.done) return false
        frames += decoder.decode(chunk.value, { stream: true })
      }
      return true
    }, { timeoutMs: 15_000 })
  }
  await readUntil(': ready', 'the stream replays and becomes ready')
  return { readUntil, close: () => controller.abort() }
}

/** Select the session model/effort the dispatched turn must inherit. */
async function selectSessionModel(ctx, masterId) {
  const selected = await ctx.client.rpc('session/selectModel', { sessionId: masterId, ...MODEL_SELECTION })
  ctx.check(
    'the session accepts a model and effort selection',
    selected?.selected?.model === MODEL_SELECTION.model && selected?.selected?.reasoningEffort === MODEL_SELECTION.reasoningEffort,
    JSON.stringify(selected),
  )
}

/** Post the first annotation and wait for its live event. */
async function dispatchFirstComment(ctx, masterId, artifactId, readUntil) {
  const comment = await ctx.client.panelPost('/api/cowork.artifact.comment', {
    sessionId: masterId,
    artifactId,
    body: FIRST_COMMENT,
    anchor: { kind: 'line-range', path: SPEC_PATH, startLine: 1, endLine: 1, quote: 'dsh-cowork E2E fixture' },
  })
  const commentId = comment.body?.comment?.commentId
  ctx.check('the comment is queued for delivery', comment.status === 200 && comment.body?.dispatch?.state === 'queued', comment.body?.dispatch?.state)
  await readUntil('event: comment.created', 'the live comment event arrives')
  return commentId
}

/** Wait until the dispatch the comment opened becomes replied. */
async function awaitRepliedBatch(ctx, masterId, artifactId) {
  const url = `/api/cowork.artifact.detail?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}`
  return ctx.waitUntil('the dispatched batch becomes replied', async () => {
    const current = await ctx.client.panelGet(url)
    return current.body?.record?.activeDispatch?.state === 'replied' ? current.body : undefined
  }, { timeoutMs: 30_000 }).catch((error) => { throw withPromptDiagnostics(ctx, masterId, error) })
}

/** The model reply must close the dispatch. */
function checkReplyClosed(ctx, replied) {
  ctx.check('the model reply closed the dispatch', replied.record.activeDispatch.state === 'replied', replied.record.activeDispatch.state)
}

/** The delivery must start with the versioned marker. */
function checkDeliveryMarker(ctx, delivery) {
  const marked = delivery !== null && delivery.prompt.includes('cowork-annotation/v1')
  const detail = delivery === null ? 'no marker-routed prompt' : delivery.prompt.slice(0, 80)
  ctx.check('the delivery prompt carries the annotation marker', marked, detail)
}

/** The delivery must carry the structured context for this batch. */
function checkDeliveryContext(ctx, delivery, artifactId, commentId) {
  const hasContext = delivery !== null
    && delivery.prompt.includes('Annotations (')
    && delivery.prompt.includes(`--- annotation ${commentId} ---`)
    && delivery.prompt.includes(`Work item: ${artifactId}`)
  ctx.check('the delivery prompt carries the structured annotation context', hasContext, delivery?.prompt.slice(0, 160))
}

/** The scripted model must parse the delivery's work item and comment ids. */
function checkDeliveryIds(ctx, delivery, artifactId, commentId) {
  const parsed = delivery !== null
    && delivery.artifactId === artifactId
    && JSON.stringify(delivery.commentIds) === JSON.stringify([commentId])
  ctx.check('the scripted model parsed the delivery ids', parsed, `${delivery?.artifactId}:${JSON.stringify(delivery?.commentIds)}`)
}

/** The reply turn must run with the session's model selection. */
function checkDispatchTurn(ctx, masterId) {
  const dispatchTurn = ctx.model.calls.find((call) => call.sessionId === masterId && call.prompt.includes('cowork-annotation/v1'))
  ctx.check('the dispatched reply inherits the session model', dispatchTurn?.model === MODEL_SELECTION.model, dispatchTurn?.model)
  ctx.check('the dispatched reply inherits the session reasoning effort', dispatchTurn?.effort === MODEL_SELECTION.reasoningEffort, dispatchTurn?.effort)
}

/** The model reply must appear in the comment thread. */
async function checkReplyLanded(ctx, masterId, artifactId, commentId) {
  const comments = await ctx.client.panelGet(`/api/cowork.artifact.comments?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}`)
  const reply = comments.body?.events?.find((event) => event.type === 'reply' && event.body === 'E2E 模型回复')
  ctx.check('the reply landed in the thread', reply !== undefined && reply.threadId === commentId, reply?.threadId)
}

/** The comments tool must see the open thread. */
async function checkCommentsTool(ctx, masterId, artifactId, commentId) {
  const commentsTool = await ctx.promptForTool(
    masterId,
    `Call cowork_artifact_comments exactly once with these arguments (JSON): ${JSON.stringify({ artifactId })}`,
    'cowork_artifact_comments',
  )
  const threads = commentsTool.payload?.threads ?? []
  const seen = threads.some((thread) => thread.threadId === commentId)
  ctx.check('the comments tool sees the thread', seen, JSON.stringify(commentsTool.payload?.threads?.length))
}

/** Resolving the thread must report a change. */
async function resolveThread(ctx, masterId, artifactId, commentId) {
  const resolved = await ctx.client.panelPost('/api/cowork.artifact.comment.resolve', {
    sessionId: masterId, artifactId, commentId, resolved: true,
  })
  ctx.check('resolve toggles the thread', resolved.status === 200 && resolved.body?.changed === true, resolved.body?.changed)
}

/** Append one line through the save route and keep the new content. */
async function saveNewRevision(ctx, masterId, artifactId, filePath, baseRevision, baseVersion) {
  const content = await ctx.readText(SPEC_PATH)
  const edited = await ctx.client.panelPost('/api/cowork.artifact.edit', {
    sessionId: masterId,
    artifactId,
    path: SPEC_PATH,
    baseRevision,
    baseVersion,
    content: `${content}E2E saved line\n`,
  })
  ctx.check('the save appends a revision', edited.status === 200 && edited.body?.revision === baseRevision + 1, `${edited.status}:${edited.body?.revision}`)
  const saved = await ctx.readText(SPEC_PATH)
  ctx.check('the save reached the file', saved?.includes('E2E saved line') === true, saved?.slice(-20))
  return saved
}

/** A concurrent append and a different-line edit must auto-merge. */
async function mergeConcurrentEdit(ctx, masterId, artifactId, filePath, saved) {
  const mergeBase = await ctx.client.panelGet(filePath)
  await writeFile(join(ctx.fixture.path, SPEC_PATH), `${saved}model-concurrent-line\n`)
  const merged = await ctx.client.panelPost('/api/cowork.artifact.edit', {
    sessionId: masterId,
    artifactId,
    path: SPEC_PATH,
    baseRevision: mergeBase.body.revision,
    baseVersion: mergeBase.body.fsVersion,
    content: `${saved}model-concurrent-line\n`.replace('# dsh-cowork E2E fixture', '# dsh-cowork E2E fixture (user)'),
  })
  ctx.check('a non-overlapping stale save merges', merged.status === 200 && merged.body?.merged === true, `${merged.status}:${String(merged.body?.merged)}`)
  const mergedText = await ctx.readText(SPEC_PATH)
  const keepsBoth = mergedText?.includes('(user)') === true && mergedText?.includes('model-concurrent-line') === true
  ctx.check('the merged file keeps both edits', keepsBoth, mergedText?.slice(0, 60))
}

/** Replaying from sequence 0 must serve the persisted event window. */
async function replayEvents(ctx, masterId, artifactId) {
  const replayController = new AbortController()
  const replay = await ctx.client.panelFetch(
    `/api/cowork.artifact.events?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}`,
    { signal: replayController.signal, headers: { 'last-event-id': '0' } },
  )
  const replayReader = replay.body.getReader()
  let replayFrames = ''
  await ctx.waitUntil('the SSE replay to reach the ready marker', async () => {
    while (!replayFrames.includes(': ready')) {
      const chunk = await replayReader.read()
      if (chunk.done) return false
      replayFrames += new TextDecoder().decode(chunk.value, { stream: true })
    }
    return true
  }, { timeoutMs: 15_000 })
  const served = /id: \d+/.test(replayFrames) && replayFrames.includes('event: comment.created')
  ctx.check('the replay serves persisted events', served, replayFrames.slice(0, 80))
  replayController.abort()
}

/** Upload the PNG bytes and return the minted attachment ref. */
async function uploadBytes(ctx, masterId, artifactId) {
  const upload = await ctx.client.panelFetch(
    `/api/cowork.artifact.upload?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}&name=shot.png`,
    { method: 'POST', body: PNG_BYTES, headers: { 'content-type': 'application/octet-stream' } },
  )
  const attachment = await upload.json()
  ctx.check('upload returns an attachment ref', upload.status === 200 && attachment.attachment?.mediaType === 'image/png', upload.status)
  return attachment
}

/** Bytes alone must not publish, count, or list. */
async function checkByteUploadUnpublished(ctx, masterId, artifactId) {
  const detail = await ctx.client.panelGet(`/api/cowork.artifact.detail?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}`)
  const unpublished = detail.status === 200
    && detail.body?.record?.attachmentCount === 0
    && (detail.body?.publishedAttachments ?? []).length === 0
  ctx.check('storing bytes publishes nothing', unpublished, `${detail.status}:${detail.body?.record?.attachmentCount}`)
}

/** Publish the upload through the browser attach route. */
async function publishBrowserAttachment(ctx, masterId, artifactId, attachment) {
  const body = { sessionId: masterId, artifactId, attachmentId: attachment.attachment.attachmentId, name: 'shot.png' }
  const attachedRef = await ctx.client.panelPost('/api/cowork.artifact.attach', body)
  const published = attachedRef.status === 200
    && attachedRef.body?.source === 'user'
    && attachedRef.body?.published === true
    && attachedRef.body?.attachment?.mediaType === 'image/png'
  ctx.check('the browser attach route publishes the upload as a user attachment', published, `${attachedRef.status}:${attachedRef.body?.source}:${String(attachedRef.body?.published)}`)
  return body
}

/** Publishing the same id again is idempotent. */
async function checkIdempotentPublish(ctx, body) {
  const republished = await ctx.client.panelPost('/api/cowork.artifact.attach', body)
  const idempotent = republished.status === 200 && republished.body?.published === false
  ctx.check('publishing the same upload again is idempotent', idempotent, `${republished.status}:${String(republished.body?.published)}`)
}

/** Referencing the upload from a comment still counts it once. */
async function referenceAttachment(ctx, masterId, artifactId, attachment) {
  const attached = await ctx.client.panelPost('/api/cowork.artifact.comment', {
    sessionId: masterId,
    artifactId,
    body: 'E2E 附件评论',
    attachments: [attachment.attachment],
    dispatch: false,
  })
  const counted = attached.status === 200 && attached.body?.record?.attachmentCount === 1
  ctx.check('the attachment is referenced by a comment and still counted once', counted, `${attached.status}:${attached.body?.record?.attachmentCount}`)
}

/** The attachment route must serve the published bytes. */
async function checkAttachmentServed(ctx, masterId, artifactId, attachment) {
  const attachmentGet = await ctx.client.panelFetch(
    `/api/cowork.artifact.attachment?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}&attachmentId=${encodeURIComponent(attachment.attachment.attachmentId)}`,
  )
  const bytes = Buffer.from(await attachmentGet.arrayBuffer())
  const served = attachmentGet.status === 200 && bytes.equals(PNG_BYTES)
  ctx.check('the attachment route serves the bytes', served, `${attachmentGet.status}:${bytes.length}`)
}

/** One nested field of a maybe-missing payload. */
function payloadField(payload, key) {
  return payload === undefined || payload === null ? undefined : payload[key]
}

/** Whether the attach payload reports a model-sourced, published image. */
function isModelAttachment(payload) {
  if (payloadField(payload, 'source') !== 'model') return false
  if (payloadField(payload, 'published') !== true) return false
  return payloadField(payloadField(payload, 'attachment'), 'mediaType') === 'image/png'
}

/** The scripted model publishes a project file it "generated". */
async function attachModelFile(ctx, masterId, artifactId) {
  await writeFile(join(ctx.fixture.path, CHART_PATH), PNG_BYTES)
  const modelAttach = await ctx.promptForTool(
    masterId,
    `Call cowork_artifact_attach exactly once with these arguments (JSON): ${JSON.stringify({ artifactId, sourcePath: CHART_PATH, name: 'e2e-chart.png' })}`,
    'cowork_artifact_attach',
  )
  const payload = modelAttach.payload
  const count = payloadField(payloadField(payload, 'record'), 'attachmentCount')
  const published = isModelAttachment(payload) && count === 2
  ctx.check('cowork_artifact_attach publishes a model attachment', published, `${payloadField(payload, 'source')}:${String(payloadField(payload, 'published'))}:${count}`)
}

/** Detail lists both published attachments with their source. */
async function checkPublishedList(ctx, masterId, artifactId) {
  const detail = await ctx.client.panelGet(`/api/cowork.artifact.detail?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}`)
  const rows = detail.body?.publishedAttachments ?? []
  const complete = rows.length === 2
    && rows.some((row) => row.source === 'user')
    && rows.some((row) => row.source === 'model')
    && detail.body?.record?.attachmentCount === 2
  ctx.check('detail lists both published attachments with their source', complete, JSON.stringify(rows.map((row) => row.source)))
}

/** The upload/attach/reference/serve sequence, in order. */
async function runAttachmentFlow(ctx, masterId, artifactId) {
  const attachment = await uploadBytes(ctx, masterId, artifactId)
  await checkByteUploadUnpublished(ctx, masterId, artifactId)
  const publishBody = await publishBrowserAttachment(ctx, masterId, artifactId, attachment)
  await checkIdempotentPublish(ctx, publishBody)
  await referenceAttachment(ctx, masterId, artifactId, attachment)
  await checkAttachmentServed(ctx, masterId, artifactId, attachment)
  await attachModelFile(ctx, masterId, artifactId)
  await checkPublishedList(ctx, masterId, artifactId)
}

/** An active editing range must deny a model edit that overlaps it. */
async function runEditGuard(ctx, masterId, artifactId, specPath) {
  const guardPresence = await ctx.client.panelPost('/api/cowork.artifact.presence', {
    sessionId: masterId,
    artifactId,
    path: specPath,
    ranges: [{ startLine: 1, endLine: 1 }],
  })
  ctx.check('presence is again active for the guard', guardPresence.status === 200, guardPresence.status)
  const denied = await ctx.promptForTool(
    masterId,
    `Call edit exactly once with these arguments (JSON): ${JSON.stringify(GUARD_EDIT_ARGS)} . Then stop.`,
    'edit',
    { expectOk: false, acceptError: true },
  )
  const refused = denied.isError === true && /用户正在编辑|重叠/.test(denied.text)
  ctx.check('the guard denied the overlapping model edit', refused, denied.text.slice(0, 120))
  const guarded = await ctx.readText(specPath)
  ctx.check('the denied edit left the file unchanged', guarded?.includes('GUARD TEST') === false, guarded?.slice(0, 40))
}

/** @param {ReturnType<import('../support/context.mjs').createScenarioContext>} ctx */
export async function runArtifactChain(ctx) {
  // The last annotation delivery the scripted model received, with the ids it
  // parsed out of the structured block; the assertions below pin the format so
  // a drift fails with the observed message instead of silently starving the
  // dispatch.
  const delivery = { current: null }
  ctx.model.setHandler(({ prompt, toolResults }) => scriptedTurnFor(prompt, toolResults, (entry) => { delivery.current = entry }))

  const masterId = await createMasterSession(ctx)
  const artifactId = await registerWorkItem(ctx, masterId)
  await checkListProjection(ctx, masterId, artifactId)
  await checkDetailProjection(ctx, masterId, artifactId)
  const { filePath, baseRevision, baseVersion } = await readRegisteredFile(ctx, masterId, artifactId)
  await markViewed(ctx, masterId, artifactId)
  await reportPresence(ctx, masterId, artifactId)

  const stream = await openEventStream(ctx, masterId, artifactId)
  await selectSessionModel(ctx, masterId)
  const commentId = await dispatchFirstComment(ctx, masterId, artifactId, stream.readUntil)
  stream.close()

  const replied = await awaitRepliedBatch(ctx, masterId, artifactId)
  checkReplyClosed(ctx, replied)
  checkDeliveryMarker(ctx, delivery.current)
  checkDeliveryContext(ctx, delivery.current, artifactId, commentId)
  checkDeliveryIds(ctx, delivery.current, artifactId, commentId)
  checkDispatchTurn(ctx, masterId)
  await checkReplyLanded(ctx, masterId, artifactId, commentId)
  await checkCommentsTool(ctx, masterId, artifactId, commentId)
  await resolveThread(ctx, masterId, artifactId, commentId)

  const saved = await saveNewRevision(ctx, masterId, artifactId, filePath, baseRevision, baseVersion)
  await mergeConcurrentEdit(ctx, masterId, artifactId, filePath, saved)
  await replayEvents(ctx, masterId, artifactId)
  await runAttachmentFlow(ctx, masterId, artifactId)
  await runEditGuard(ctx, masterId, artifactId, SPEC_PATH)
  await runRebindStep(ctx, masterId, artifactId)
}
