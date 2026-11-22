/**
 * E2E scenario `artifact-chain`: the keyless work-item chain on a real host.
 *
 * A master session registers README.md as a work item, then the panel routes
 * read it, annotate it, save an edit, report presence, upload an attachment,
 * serve the attachment bytes, and consume the project SSE stream. The annotation
 * is delivered to the owning session, whose scripted model must call
 * `cowork_artifact_reply` for the dispatch to become `replied`; the comments
 * tool is read first. Assertions use the routes and the files, never prompt
 * text except to route the scripted model.
 */

import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { text, tool } from '../support/scripted-model.mjs'

export const artifactChainId = 'artifact-chain'

const SPEC_PATH = 'README.md'
const REBOUND_PATH = 'README-rebound.md'
const FIRST_COMMENT = 'E2E 第一段批注'
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** @param {ReturnType<import('../support/context.mjs').createScenarioContext>} ctx */
export async function runArtifactChain(ctx) {
  ctx.model.setHandler(({ prompt, toolResults }) => {
    if (toolResults.length > 0) return text('Step complete.')
    if (prompt.includes('cowork_project_init')) return tool('cowork_project_init', {})
    if (prompt.includes('cowork_artifact_create')) {
      return tool('cowork_artifact_create', { path: SPEC_PATH, title: 'E2E 工作项' })
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
    if (prompt.includes('cowork_artifact_reply')) {
      const artifactId = /artifact-[A-Za-z0-9-]+/.exec(prompt)?.[0] ?? ''
      const commentIds = [...prompt.matchAll(/annotation (comment-[A-Za-z0-9-]+)/g)].map((match) => match[1])
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
  }, { timeoutMs: 30_000 })
  ctx.check('the model reply closed the dispatch', replied.record.activeDispatch.state === 'replied', replied.record.activeDispatch.state)

  const dispatchTurn = ctx.model.calls.find((call) => call.sessionId === masterId && call.prompt.includes('cowork_artifact_reply'))
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
  const attached = await ctx.client.panelPost('/api/cowork.artifact.comment', {
    sessionId: masterId,
    artifactId,
    body: 'E2E 附件评论',
    attachments: [attachment.attachment],
    dispatch: false,
  })
  ctx.check('the attachment is referenced by a comment', attached.status === 200 && attached.body?.record?.attachmentCount >= 1, attached.status)
  const attachmentGet = await ctx.client.panelFetch(
    `/api/cowork.artifact.attachment?sessionId=${encodeURIComponent(masterId)}&artifactId=${encodeURIComponent(artifactId)}&attachmentId=${encodeURIComponent(attachment.attachment.attachmentId)}`,
  )
  const bytes = Buffer.from(await attachmentGet.arrayBuffer())
  ctx.check('the attachment route serves the bytes', attachmentGet.status === 200 && bytes.equals(PNG_BYTES), `${attachmentGet.status}:${bytes.length}`)

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

  // Move the registered file and re-point the work item at its new path.
  await rename(join(ctx.fixture.path, SPEC_PATH), join(ctx.fixture.path, REBOUND_PATH))
  const rebound = await ctx.client.panelPost('/api/cowork.artifact.rebind', {
    sessionId: masterId,
    artifactId,
    oldPath: SPEC_PATH,
    newPath: REBOUND_PATH,
  })
  ctx.check(
    'rebind re-points the moved file',
    rebound.status === 200 && rebound.body?.changed === true && rebound.body?.record?.primaryPath === REBOUND_PATH,
    `${rebound.status}:${rebound.body?.record?.primaryPath}`,
  )
  const idempotentRebind = await ctx.client.panelPost('/api/cowork.artifact.rebind', {
    sessionId: masterId,
    artifactId,
    oldPath: REBOUND_PATH,
    newPath: REBOUND_PATH,
  })
  ctx.check(
    'rebind is idempotent for the same path',
    idempotentRebind.status === 200
      && idempotentRebind.body?.changed === false
      && idempotentRebind.body?.record?.primaryPath === REBOUND_PATH,
    `${idempotentRebind.status}:${idempotentRebind.body?.changed}`,
  )
  const reboundList = await ctx.client.panelGet(`/api/cowork.artifact.list?sessionId=${encodeURIComponent(masterId)}`)
  ctx.check(
    'the rail lists the rebound path',
    reboundList.status === 200
      && reboundList.body?.items?.some((item) => item.artifactId === artifactId && item.primaryPath === REBOUND_PATH),
    reboundList.status,
  )
}
