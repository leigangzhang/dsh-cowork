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

/** @param {ReturnType<import('../support/context.mjs').createScenarioContext>} ctx */
export async function runArtifactChain(ctx) {
  // The last annotation delivery the scripted model received, with the ids it
  // parsed out of the structured block; the assertions below pin the format so
  // a drift fails with the observed message instead of silently starving the
  // dispatch.
  let delivery = null
  ctx.model.setHandler(({ prompt, toolResults }) => {
    if (toolResults.length > 0) return text('Step complete.')
    if (prompt.includes('cowork_project_init')) return tool('cowork_project_init', {})
    if (prompt.includes('cowork_artifact_create')) {
      return tool('cowork_artifact_create', { path: SPEC_PATH, title: 'E2E 工作项' })
    }
    if (prompt.includes('cowork_artifact_attach')) {
      const artifactId = /artifact-[A-Za-z0-9-]+/.exec(prompt)?.[0] ?? ''
      return tool('cowork_artifact_attach', { artifactId, sourcePath: CHART_PATH, name: 'e2e-chart.png' })
    }
    if (prompt.includes('cowork_artifact_comments')) {
      return tool('cowork_artifact_comments', { artifactId: /artifact-[A-Za-z0-9-]+/.exec(prompt)?.[0] ?? '' })
    }
    if (prompt.includes('Call edit exactly once')) {
      return tool('edit', {
        file_path: SPEC_PATH,
        old_string: '# dsh-cowork E2E fixture',
        new_string: '# GUARD TEST',
      })
    }
    // The dispatch message is the versioned marker plus one structured block
    // per comment; route on the marker's visible ASCII core, not on any tool
    // name that used to appear in the prompt.
    if (prompt.includes('cowork-annotation/v1')) {
      const artifactId = /Work item: (artifact-[A-Za-z0-9-]+)/.exec(prompt)?.[1] ?? ''
      const commentIds = [...prompt.matchAll(/--- annotation (comment-[A-Za-z0-9-]+) ---/g)].map((match) => match[1])
      delivery = { prompt, artifactId, commentIds }
      return tool('cowork_artifact_reply', {
        artifactId,
        commentIds,
        body: 'E2E 模型回复',
      })
    }
    return text('No scripted step matched this prompt.')
  })

  const master = await ctx.client.createSession({ cwd: ctx.fixture.path, agentPreset: 'cowork-master' })
  const masterId = master.sessionId
  await ctx.promptForTool(masterId, 'Call cowork_project_init exactly once with no arguments.', 'cowork_project_init')
  const created = await ctx.promptForTool(
    masterId,
    `Call cowork_artifact_create exactly once with these arguments (JSON): ${JSON.stringify({ path: SPEC_PATH, title: 'E2E 工作项' })}`,
    'cowork_artifact_create',
  )
  const artifactId = created.payload?.artifact?.artifactId
  ctx.check('artifact_create returned an id', typeof artifactId === 'string' && artifactId !== '', String(artifactId))

  const list = await ctx.client.panelGet(`/api/cowork.artifact.list?sessionId=${encodeURIComponent(masterId)}`)
  ctx.check('the rail lists the new work item', list.status === 200 && list.body?.items?.some((item) => item.artifactId === artifactId), JSON.stringify(list.body?.items?.length))
  const detail = await ctx.client.panelGet(`/api/cowork.artifact.detail?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}`)
  ctx.check('detail serves the record', detail.status === 200 && detail.body?.record?.primaryPath === SPEC_PATH, detail.body?.record?.primaryPath)

  const filePath = `/api/cowork.artifact.file?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}&path=${encodeURIComponent(SPEC_PATH)}`
  const file = await ctx.client.panelGet(filePath)
  ctx.check('the file route serves the text', file.status === 200 && typeof file.body?.content === 'string', file.status)
  const baseRevision = file.body.revision
  const baseVersion = file.body.fsVersion

  const viewed = await ctx.client.panelPost('/api/cowork.artifact.status', { sessionId: masterId, artifactId, action: 'view' })
  ctx.check('first view moves the status to pending-confirm', viewed.status === 200 && viewed.body?.record?.status === 'pending-confirm', viewed.body?.record?.status)

  const presence = await ctx.client.panelPost('/api/cowork.artifact.presence', {
    sessionId: masterId,
    artifactId,
    path: SPEC_PATH,
    ranges: [{ startLine: 1, endLine: 1 }],
  })
  ctx.check('presence reports its TTL', presence.status === 200 && presence.body?.ttlMs > 0, presence.body?.ttlMs)

  // Open the stream before the write, so the comment event proves live SSE.
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

  // The Session owns the model and reasoning effort. A dispatched annotation
  // must run the reply turn with that same selection, not a dispatch default.
  const selection = { provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'max' }
  const selected = await ctx.client.rpc('session/selectModel', { sessionId: masterId, ...selection })
  ctx.check(
    'the session accepts a model and effort selection',
    selected?.selected?.model === selection.model && selected?.selected?.reasoningEffort === selection.reasoningEffort,
    JSON.stringify(selected),
  )

  const comment = await ctx.client.panelPost('/api/cowork.artifact.comment', {
    sessionId: masterId,
    artifactId,
    body: FIRST_COMMENT,
    anchor: { kind: 'line-range', path: SPEC_PATH, startLine: 1, endLine: 1, quote: 'dsh-cowork E2E fixture' },
  })
  const commentId = comment.body?.comment?.commentId
  ctx.check('the comment is queued for delivery', comment.status === 200 && comment.body?.dispatch?.state === 'queued', comment.body?.dispatch?.state)
  await readUntil('event: comment.created', 'the live comment event arrives')
  controller.abort()

  const replied = await ctx.waitUntil('the dispatched batch becomes replied', async () => {
    const current = await ctx.client.panelGet(`/api/cowork.artifact.detail?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}`)
    return current.body?.record?.activeDispatch?.state === 'replied' ? current.body : undefined
  }, { timeoutMs: 30_000 }).catch((error) => { throw withPromptDiagnostics(ctx, masterId, error) })
  ctx.check('the model reply closed the dispatch', replied.record.activeDispatch.state === 'replied', replied.record.activeDispatch.state)

  // The delivery format is a contract the scripted model depends on: marker,
  // structured context, and one block per comment id.
  ctx.check(
    'the delivery prompt carries the annotation marker',
    delivery?.prompt.includes('cowork-annotation/v1') === true,
    delivery === null ? 'no marker-routed prompt' : delivery.prompt.slice(0, 80),
  )
  ctx.check(
    'the delivery prompt carries the structured annotation context',
    delivery !== null
      && delivery.prompt.includes('Annotations (')
      && delivery.prompt.includes(`--- annotation ${commentId} ---`)
      && delivery.prompt.includes(`Work item: ${artifactId}`),
    delivery?.prompt.slice(0, 160),
  )
  ctx.check(
    'the scripted model parsed the delivery ids',
    delivery !== null && delivery.artifactId === artifactId && JSON.stringify(delivery.commentIds) === JSON.stringify([commentId]),
    `${delivery?.artifactId}:${JSON.stringify(delivery?.commentIds)}`,
  )

  const dispatchTurn = ctx.model.calls.find((call) => call.sessionId === masterId && call.prompt.includes('cowork-annotation/v1'))
  ctx.check('the dispatched reply inherits the session model', dispatchTurn?.model === selection.model, dispatchTurn?.model)
  ctx.check('the dispatched reply inherits the session reasoning effort', dispatchTurn?.effort === selection.reasoningEffort, dispatchTurn?.effort)

  const comments = await ctx.client.panelGet(`/api/cowork.artifact.comments?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}`)
  const reply = comments.body?.events?.find((event) => event.type === 'reply' && event.body === 'E2E 模型回复')
  ctx.check('the reply landed in the thread', reply !== undefined && reply.threadId === commentId, reply?.threadId)

  const commentsTool = await ctx.promptForTool(
    masterId,
    `Call cowork_artifact_comments exactly once with these arguments (JSON): ${JSON.stringify({ artifactId })}`,
    'cowork_artifact_comments',
  )
  ctx.check('the comments tool sees the thread', (commentsTool.payload?.threads ?? []).some((thread) => thread.threadId === commentId), JSON.stringify(commentsTool.payload?.threads?.length))

  const resolved = await ctx.client.panelPost('/api/cowork.artifact.comment.resolve', {
    sessionId: masterId, artifactId, commentId, resolved: true,
  })
  ctx.check('resolve toggles the thread', resolved.status === 200 && resolved.body?.changed === true, resolved.body?.changed)

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
  let saved = await ctx.readText(SPEC_PATH)
  ctx.check('the save reached the file', saved?.includes('E2E saved line') === true, saved?.slice(-20))

  // A concurrent append and a user edit on a different line must auto-merge.
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
  saved = await ctx.readText(SPEC_PATH)
  ctx.check('the merged file keeps both edits', saved?.includes('(user)') === true && saved?.includes('model-concurrent-line') === true, saved?.slice(0, 60))

  // Replaying from sequence 0 must serve the persisted event window.
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
  ctx.check('the replay serves persisted events', /id: \d+/.test(replayFrames) && replayFrames.includes('event: comment.created'), replayFrames.slice(0, 80))
  replayController.abort()

  const upload = await ctx.client.panelFetch(
    `/api/cowork.artifact.upload?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}&name=shot.png`,
    { method: 'POST', body: PNG_BYTES, headers: { 'content-type': 'application/octet-stream' } },
  )
  const attachment = await upload.json()
  ctx.check('upload returns an attachment ref', upload.status === 200 && attachment.attachment?.mediaType === 'image/png', upload.status)
  const uploadedDetail = await ctx.client.panelGet(`/api/cowork.artifact.detail?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}`)
  ctx.check(
    'storing bytes publishes nothing',
    uploadedDetail.status === 200
      && uploadedDetail.body?.record?.attachmentCount === 0
      && (uploadedDetail.body?.publishedAttachments ?? []).length === 0,
    `${uploadedDetail.status}:${uploadedDetail.body?.record?.attachmentCount}`,
  )
  const publishBody = { sessionId: masterId, artifactId, attachmentId: attachment.attachment.attachmentId, name: 'shot.png' }
  const attachedRef = await ctx.client.panelPost('/api/cowork.artifact.attach', publishBody)
  ctx.check(
    'the browser attach route publishes the upload as a user attachment',
    attachedRef.status === 200
      && attachedRef.body?.source === 'user'
      && attachedRef.body?.published === true
      && attachedRef.body?.attachment?.mediaType === 'image/png',
    `${attachedRef.status}:${attachedRef.body?.source}:${String(attachedRef.body?.published)}`,
  )
  const republished = await ctx.client.panelPost('/api/cowork.artifact.attach', publishBody)
  ctx.check(
    'publishing the same upload again is idempotent',
    republished.status === 200 && republished.body?.published === false,
    `${republished.status}:${String(republished.body?.published)}`,
  )
  const attached = await ctx.client.panelPost('/api/cowork.artifact.comment', {
    sessionId: masterId,
    artifactId,
    body: 'E2E 附件评论',
    attachments: [attachment.attachment],
    dispatch: false,
  })
  ctx.check(
    'the attachment is referenced by a comment and still counted once',
    attached.status === 200 && attached.body?.record?.attachmentCount === 1,
    `${attached.status}:${attached.body?.record?.attachmentCount}`,
  )
  const attachmentGet = await ctx.client.panelFetch(
    `/api/cowork.artifact.attachment?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}&attachmentId=${encodeURIComponent(attachment.attachment.attachmentId)}`,
  )
  const bytes = Buffer.from(await attachmentGet.arrayBuffer())
  ctx.check('the attachment route serves the bytes', attachmentGet.status === 200 && bytes.equals(PNG_BYTES), `${attachmentGet.status}:${bytes.length}`)

  // The scripted model publishes a project file it "generated" as an attachment.
  await writeFile(join(ctx.fixture.path, CHART_PATH), PNG_BYTES)
  const modelAttach = await ctx.promptForTool(
    masterId,
    `Call cowork_artifact_attach exactly once with these arguments (JSON): ${JSON.stringify({
      artifactId,
      sourcePath: CHART_PATH,
      name: 'e2e-chart.png',
    })}`,
    'cowork_artifact_attach',
  )
  const modelAttachment = modelAttach.payload?.attachment
  ctx.check(
    'cowork_artifact_attach publishes a model attachment',
    modelAttach.payload?.source === 'model'
      && modelAttach.payload?.published === true
      && modelAttachment?.mediaType === 'image/png'
      && modelAttach.payload?.record?.attachmentCount === 2,
    `${modelAttach.payload?.source}:${String(modelAttach.payload?.published)}:${modelAttach.payload?.record?.attachmentCount}`,
  )
  const publishedDetail = await ctx.client.panelGet(`/api/cowork.artifact.detail?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}`)
  const publishedRows = publishedDetail.body?.publishedAttachments ?? []
  ctx.check(
    'detail lists both published attachments with their source',
    publishedRows.length === 2
      && publishedRows.some((row) => row.source === 'user')
      && publishedRows.some((row) => row.source === 'model')
      && publishedDetail.body?.record?.attachmentCount === 2,
    JSON.stringify(publishedRows.map((row) => row.source)),
  )

  // An active editing range must deny a model edit that overlaps it.
  const guardPresence = await ctx.client.panelPost('/api/cowork.artifact.presence', {
    sessionId: masterId,
    artifactId,
    path: SPEC_PATH,
    ranges: [{ startLine: 1, endLine: 1 }],
  })
  ctx.check('presence is again active for the guard', guardPresence.status === 200, guardPresence.status)
  const denied = await ctx.promptForTool(
    masterId,
    `Call edit exactly once with these arguments (JSON): ${JSON.stringify({
      file_path: SPEC_PATH,
      old_string: '# dsh-cowork E2E fixture',
      new_string: '# GUARD TEST',
    })} . Then stop.`,
    'edit',
    { expectOk: false, acceptError: true },
  )
  ctx.check('the guard denied the overlapping model edit', denied.isError === true && /用户正在编辑|重叠/.test(denied.text), denied.text.slice(0, 120))
  const guarded = await ctx.readText(SPEC_PATH)
  ctx.check('the denied edit left the file unchanged', guarded?.includes('GUARD TEST') === false, guarded?.slice(0, 40))

  await runRebindStep(ctx, masterId, artifactId)
}
