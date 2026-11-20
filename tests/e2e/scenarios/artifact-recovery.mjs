/**
 * E2E scenario `artifact-recovery`: restart reconciliation on a real host.
 *
 * The scenario builds a project whose artifact directory already carries a
 * previous run's dispatch logs (an in-flight `sent` batch and a still-`queued`
 * one) before the plugin runtime is created. The first artifact route then runs
 * the real recovery pass: the in-flight batch becomes `stale` without a new
 * prompt, and the queued batch is re-scheduled and replied to by the scripted
 * model. Assertions read the routes and files, never the prompt text.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { text, tool } from '../support/scripted-model.mjs'

export const artifactRecoveryId = 'artifact-recovery'

const NOTES_PATH = 'notes.md'
const QUEUED_COMMENT = 'comment-recovery-queued'
const STALE_ARTIFACT = 'artifact-00000000-0000-4000-8000-000000000001'
const QUEUED_ARTIFACT = 'artifact-00000000-0000-4000-8000-000000000002'

/** @param {ReturnType<import('../support/context.mjs').createScenarioContext>} ctx */
export async function runArtifactRecovery(ctx) {
  const repo = await mkdtemp(join(tmpdir(), 'cowork-recovery-'))
  const content = '# recovery notes\n\nfirst line\n'
  try {
    ctx.model.setHandler(({ prompt, toolResults }) => {
      if (toolResults.length > 0) return text('Step complete.')
      if (prompt.includes('cowork_artifact_reply')) {
        const artifactId = /artifact-[A-Za-z0-9-]+/.exec(prompt)?.[0] ?? ''
        const commentIds = [...prompt.matchAll(/annotation (comment-[A-Za-z0-9-]+)/g)].map((match) => match[1])
        return tool('cowork_artifact_reply', { artifactId, commentIds, body: '恢复后的回复' })
      }
      return text('No scripted step matched this prompt.')
    })

    const session = await ctx.client.createSession({ cwd: repo, agentPreset: 'cowork-master' })
    const sessionId = session.sessionId
    // Write the index directly, without a model turn: a session turn after the
    // index exists would create the runtime (and run recovery) before the
    // dispatch logs are seeded, which is the ordering this scenario must avoid.
    const index = {
      version: 2,
      projectId: 'project-e2e-recovery',
      masterSessionId: sessionId,
      createdAt: '2026-01-01T00:00:00.000Z',
      topics: [],
      workItems: [],
    }
    await mkdir(join(repo, '.dsh-cowork'), { recursive: true })
    await writeFile(join(repo, '.dsh-cowork/index.json'), `${JSON.stringify(index)}\n`)
    ctx.check('the recovery project has an index', typeof index.projectId === 'string' && index.projectId !== '', index.projectId)

    await writeFile(join(repo, NOTES_PATH), content)
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    const directory = join(repo, '.dsh-cowork', 'artifacts')
    const createdAt = '2026-01-01T00:00:00.000Z'
    const fileEntry = {
      path: NOTES_PATH,
      mediaType: 'text/markdown',
      editable: true,
      size: Buffer.byteLength(content, 'utf8'),
      sha256,
      revision: 1,
      fsVersion: null,
      missing: false,
    }
    const dispatch = (artifactId, dispatchId, state) => ({
      version: 1,
      dispatchId,
      artifactId,
      sessionId,
      commentIds: [QUEUED_COMMENT],
      state,
      attempts: 0,
      promptRequestId: dispatchId,
      errorCode: null,
      createdAt,
      updatedAt: createdAt,
    })
    const record = (artifactId, activeDispatch) => ({
      version: 1,
      artifactId,
      projectId: index.projectId,
      ownerSessionId: sessionId,
      title: '恢复工作项',
      type: 'text',
      status: 'needs-feedback',
      files: [fileEntry],
      primaryPath: NOTES_PATH,
      revision: 1,
      commentCount: artifactId === QUEUED_ARTIFACT ? 1 : 0,
      attachmentCount: 0,
      activeDispatch,
      createdAt,
      updatedAt: createdAt,
    })
    const writeArtifact = async (artifactId, state, withComment) => {
      const artifactDir = join(directory, artifactId)
      await mkdir(artifactDir, { recursive: true })
      const dispatchRecord = dispatch(artifactId, `dispatch-${state}-${artifactId}`, state)
      await writeFile(join(artifactDir, 'artifact.json'), `${JSON.stringify(record(artifactId, {
        dispatchId: dispatchRecord.dispatchId,
        state,
        updatedAt: createdAt,
      }), null, 2)}\n`)
      await writeFile(join(artifactDir, 'dispatch.jsonl'), `${JSON.stringify(dispatchRecord)}\n`)
      if (withComment) {
        const comment = {
          version: 1,
          eventId: 'comment-event-recovery-queued',
          artifactId,
          commentId: QUEUED_COMMENT,
          threadId: QUEUED_COMMENT,
          type: 'create',
          author: 'user',
          body: '恢复后请回答这条批注',
          anchor: { kind: 'line-range', path: NOTES_PATH, startLine: 1, endLine: 1, quote: '# recovery notes' },
          createdAt,
        }
        await writeFile(join(artifactDir, 'comments.jsonl'), `${JSON.stringify(comment)}\n`)
      }
    }
    await writeArtifact(STALE_ARTIFACT, 'sent', false)
    await writeArtifact(QUEUED_ARTIFACT, 'queued', true)

    // The first artifact read creates the runtime and runs recovery.
    const list = await ctx.client.panelGet(`/api/cowork.artifact.list?sessionId=${encodeURIComponent(sessionId)}`)
    ctx.check('the seeded work items list', list.status === 200 && list.body?.items?.length === 2, String(list.body?.items?.length))
    const detailOf = (artifactId) => ctx.client.panelGet(
      `/api/cowork.artifact.detail?sessionId=${encodeURIComponent(sessionId)}&artifactId=${encodeURIComponent(artifactId)}`,
    )
    const stale = await ctx.waitUntil('the in-flight batch to become stale', async () => {
      const detail = await detailOf(STALE_ARTIFACT)
      return detail.body?.record?.activeDispatch?.state === 'stale' ? detail.body.record : undefined
    }, { timeoutMs: 20_000 })
    ctx.check('recovery turned the in-flight batch stale', stale.activeDispatch.state === 'stale', stale.activeDispatch.state)

    const replied = await ctx.waitUntil('the queued batch to be rescheduled and replied', async () => {
      const detail = await detailOf(QUEUED_ARTIFACT)
      return detail.body?.record?.activeDispatch?.state === 'replied' ? detail.body.record : undefined
    }, { timeoutMs: 30_000 })
    ctx.check('recovery rescheduled the queued batch to replied', replied.activeDispatch.state === 'replied', replied.activeDispatch.state)
    const comments = await ctx.client.panelGet(
      `/api/cowork.artifact.comments?sessionId=${encodeURIComponent(sessionId)}&artifactId=${encodeURIComponent(QUEUED_ARTIFACT)}`,
    )
    const reply = comments.body?.events?.find((event) => event.type === 'reply' && event.body === '恢复后的回复')
    ctx.check('the rescheduled batch has a model reply', reply !== undefined, String(reply?.threadId))

    // The stale batch must not have prompted the session again.
    const prompts = ctx.model.calls.filter((call) => call.sessionId === sessionId).map((call) => call.prompt)
    ctx.check('the stale batch prompted no new turn', prompts.every((prompt) => !prompt.includes(STALE_ARTIFACT)), `prompts=${String(prompts.length)}`)
    const queuedPrompts = prompts.filter((prompt) => prompt.includes(QUEUED_ARTIFACT))
    ctx.check('the queued batch prompted exactly once', queuedPrompts.length === 1, `prompts=${String(queuedPrompts.length)}`)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}
