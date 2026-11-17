/**
 * E2E scenario `review-revision`: the keyless revision and rejection branch.
 *
 * A topic commits one work item, requests a review, and the reviewer returns
 * needs_revision with a finding. The topic commits a fix and re-requests the
 * review with `previousRequestId`; the second reviewer rejects the range, which
 * blocks the topic and writes the review-reject inbox record. Both branches are
 * asserted from the request files, the index, and the project inbox.
 */

import { commitFile, readText, readGitHead } from '../support/fixture.mjs'
import { text, tool } from '../support/scripted-model.mjs'

export const reviewRevisionId = 'review-revision'

const FILE_NAME = 'e2e-review.txt'
const FIRST_CONTENT = 'first E2E review attempt'
const FIXED_CONTENT = 'second E2E review attempt'

/** @param {ReturnType<import('../support/context.mjs').createScenarioContext>} ctx */
export async function runReviewRevision(ctx) {
  let workItem = null
  let reviewedHead = null
  let previousRequestId = null
  let expectedVerdict = 'needs_revision'
  const reviewerRequestIds = new Map()

  ctx.model.setHandler(({ role, sessionId, prompt, toolResults }) => {
    if (role === 'reviewer') {
      if (!reviewerRequestIds.has(sessionId)) {
        const match = /requestId ([A-Za-z0-9._-]+)/.exec(prompt)
        reviewerRequestIds.set(sessionId, match?.[1] ?? null)
      }
      const requestId = reviewerRequestIds.get(sessionId)
      if (toolResults.some((row) => row.toolName === 'cowork_review_verdict')) return text('Review complete.')
      if (toolResults.some((row) => row.toolName === 'grep')) {
        if (typeof requestId !== 'string') return text('No review request id was delivered.')
        return tool('cowork_review_verdict', {
          requestId,
          verdict: expectedVerdict,
          summary: expectedVerdict === 'reject'
            ? 'The revision still does not satisfy the request.'
            : 'The request needs a revision before it can pass.',
          findings: [{
            id: 'F1',
            severity: 'medium',
            problem: 'The reviewed file does not yet satisfy the request purpose.',
            requiredFix: 'Commit the requested correction and request the next review.',
          }],
          verification: [{
            command: `test -f ${FILE_NAME}`,
            exitCode: 0,
            evidence: `${FILE_NAME} exists in the reviewed clone`,
          }],
        })
      }
      return tool('grep', { pattern: 'E2E review attempt', path: workItem.path })
    }
    if (role === 'topic') {
      if (toolResults.length > 0) return text('Step complete.')
      if (prompt.includes('cowork_work_item_create')) return tool('cowork_work_item_create', {})
      if (prompt.includes('cowork_review_request') && prompt.includes('exactly once with these arguments')) {
        return tool('cowork_review_request', {
          purpose: 'Confirm the E2E review file satisfies the request',
          baseCommit: workItem.baseCommit,
          headCommit: reviewedHead,
          path: workItem.path,
          workItemId: workItem.workItemId,
          changedPaths: [FILE_NAME],
          ...(previousRequestId === null ? {} : { previousRequestId }),
          verification: [{
            command: `test -f ${FILE_NAME}`,
            exitCode: 0,
            evidence: `${FILE_NAME} exists in the reviewed clone`,
          }],
        })
      }
      return text('Topic brief acknowledged.')
    }
    if (toolResults.length > 0) return text('Step complete.')
    if (prompt.includes('cowork_project_init')) return tool('cowork_project_init', {})
    if (prompt.includes('cowork_route')) {
      return tool('cowork_route', {
        intent: 'Prove the review revision and rejection branch',
        brief: 'Revise the work item when the review asks for it.',
        forceCreate: true,
      })
    }
    return text('No scripted step matched this prompt.')
  })

  const master = await ctx.client.createSession({ cwd: ctx.fixture.path, agentPreset: 'cowork-master' })
  const masterId = master.sessionId
  await ctx.promptForTool(masterId, 'Call cowork_project_init exactly once with no arguments.', 'cowork_project_init')
  const routed = await ctx.promptForTool(
    masterId,
    'Call cowork_route exactly once with these arguments (JSON): {"intent":"Prove the review revision and rejection branch","brief":"Revise the work item when the review asks for it.","forceCreate":true}',
    'cowork_route',
  )
  const topicId = routed.payload?.topicId
  ctx.check('route created the revision topic', typeof topicId === 'string' && topicId !== '', String(topicId))
  await ctx.waitUntil('the topic brief turn', () =>
    ctx.model.calls.find((call) => call.sessionId === topicId && call.role === 'topic'))
  await ctx.client.waitIdle(topicId, {})

  const created = await ctx.promptForTool(topicId, 'Call cowork_work_item_create exactly once with no arguments.', 'cowork_work_item_create')
  workItem = {
    workItemId: created.payload?.workItemId,
    path: created.payload?.path,
    baseCommit: created.payload?.baseCommit,
  }
  ctx.check('work_item_create returned a clone path', typeof workItem.path === 'string' && workItem.path !== '', String(workItem.path))
  reviewedHead = await commitFile(workItem.path, FILE_NAME, FIRST_CONTENT, 'feat: add the reviewed file')

  const first = await ctx.promptForTool(
    topicId,
    `Call cowork_review_request exactly once with these arguments (JSON): ${JSON.stringify({
      purpose: 'Confirm the E2E review file satisfies the request',
      baseCommit: workItem.baseCommit,
      headCommit: reviewedHead,
      path: workItem.path,
      workItemId: workItem.workItemId,
      changedPaths: [FILE_NAME],
      verification: [{ command: `test -f ${FILE_NAME}`, exitCode: 0, evidence: `${FILE_NAME} exists in the reviewed clone` }],
    })}`,
    'cowork_review_request',
  )
  previousRequestId = first.payload?.requestId
  ctx.check('the first review request is pending', first.payload?.status === 'pending', String(first.payload?.status))

  const needsRevision = await ctx.waitUntil('the needs_revision verdict', async () => {
    const [reviews, index] = await Promise.all([ctx.reviews(), ctx.index()])
    const review = reviews.find((entry) => entry.value.requestId === previousRequestId)
    const topic = index?.topics.find((entry) => entry.topicId === topicId)
    const item = index?.workItems.find((entry) => entry.workItemId === workItem.workItemId)
    if (review?.value.status !== 'needs_revision' || topic?.reviewStatus !== 'needs_revision') return undefined
    return { review, topic, item }
  })
  ctx.check('the review file records needs_revision', needsRevision.review.value.status === 'needs_revision', String(needsRevision.review.value.status))
  ctx.check('the topic records needs_revision', needsRevision.topic.reviewStatus === 'needs_revision', String(needsRevision.topic.reviewStatus))
  ctx.check('the work item returns to active after needs_revision', needsRevision.item?.status === 'active', String(needsRevision.item?.status))
  const revisionPrompt = await ctx.waitUntil('the revision message to the topic', () =>
    ctx.model.calls.find((call) => call.sessionId === topicId && call.prompt.includes('needs_revision')))
  ctx.check('the revision verdict was delivered to the topic', revisionPrompt.role === 'topic', revisionPrompt.role)

  reviewedHead = await commitFile(workItem.path, FILE_NAME, FIXED_CONTENT, 'fix: address the review finding')
  expectedVerdict = 'reject'
  const second = await ctx.promptForTool(
    topicId,
    `Call cowork_review_request exactly once with these arguments (JSON): ${JSON.stringify({
      purpose: 'Confirm the E2E review file satisfies the request',
      baseCommit: workItem.baseCommit,
      headCommit: reviewedHead,
      path: workItem.path,
      workItemId: workItem.workItemId,
      changedPaths: [FILE_NAME],
      previousRequestId,
      verification: [{ command: `test -f ${FILE_NAME}`, exitCode: 0, evidence: `${FILE_NAME} exists in the reviewed clone` }],
    })}`,
    'cowork_review_request',
  )
  ctx.check('the re-review request is pending', second.payload?.status === 'pending', String(second.payload?.status))
  ctx.check('the re-review names the previous request', second.payload?.requestId !== previousRequestId, String(second.payload?.requestId))

  const rejected = await ctx.waitUntil('the reject verdict', async () => {
    const [reviews, index] = await Promise.all([ctx.reviews(), ctx.index()])
    const review = reviews.find((entry) => entry.value.requestId === second.payload?.requestId)
    const topic = index?.topics.find((entry) => entry.topicId === topicId)
    if (review?.value.status !== 'reject' || topic?.reviewStatus !== 'reject') return undefined
    return { review, topic }
  })
  ctx.check('the reject verdict records the finding', rejected.review.value.findings.length === 1, String(rejected.review.value.findings.length))
  ctx.check('the topic records reject and is blocked', rejected.topic.reviewStatus === 'reject' && rejected.topic.blocked === true, `${String(rejected.topic.reviewStatus)} blocked=${String(rejected.topic.blocked)}`)
  const inbox = await ctx.waitUntil('the review-reject inbox record', async () => {
    const rows = await ctx.inbox()
    return Array.isArray(rows) ? rows.find((entry) => entry.topicId === topicId && entry.kind === 'review-reject') : undefined
  })
  ctx.check('the rejection wrote the review-reject inbox record', inbox.kind === 'review-reject', String(inbox.kind))
  const file = await readText(`${workItem.path}/${FILE_NAME}`)
  ctx.check('the rejected clone keeps the revised file', file?.trim() === FIXED_CONTENT, file === undefined ? 'missing' : 'present')
  ctx.check('the clone head is the second reviewed commit', readGitHead(workItem.path) === reviewedHead, reviewedHead)
}
