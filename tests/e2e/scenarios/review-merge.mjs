/**
 * E2E scenario `review-merge`: the keyless independent-review chain.
 *
 * A topic creates an isolated work item, the harness commits one file into the
 * clone, and the freshly created reviewer session
 * runs its own read-only check and records a pass verdict. The topic then hands
 * off, the master merges the reviewed range, and the scenario asserts the merged
 * work item, the untouched `main` ref and the removed clone.
 */

import { commitFile, readText, readGitHead } from '../support/fixture.mjs'
import { text, tool } from '../support/scripted-model.mjs'

export const reviewMergeId = 'review-merge'

const FILE_NAME = 'e2e-review.txt'
const FILE_CONTENT = 'reviewed by the keyless E2E lane'
const REVIEW_SUMMARY = 'The reviewed commit adds the expected E2E file.'

/** @param {ReturnType<import('../support/context.mjs').createScenarioContext>} ctx */
export async function runReviewMerge(ctx) {
  let workItem = null
  let reviewedHead = null
  let reviewerRequestId = null

  ctx.model.setHandler(({ role, prompt, toolResults }) => {
    if (role === 'reviewer') {
      if (reviewerRequestId === null) {
        const match = /requestId ([A-Za-z0-9._-]+)/.exec(prompt)
        if (match !== null) reviewerRequestId = match[1]
      }
      if (toolResults.some((row) => row.toolName === 'cowork_review_verdict')) return text('Review complete.')
      if (toolResults.some((row) => row.toolName === 'grep')) {
        if (reviewerRequestId === null) return text('No review request id was delivered.')
        return tool('cowork_review_verdict', {
          requestId: reviewerRequestId,
          verdict: 'pass',
          summary: REVIEW_SUMMARY,
          findings: [],
          verification: [{
            command: `test -f ${FILE_NAME}`,
            exitCode: 0,
            evidence: `${FILE_NAME} exists in the reviewed clone`,
          }],
        })
      }
      if (workItem !== null) {
        return tool('grep', {
          pattern: FILE_CONTENT,
          path: workItem.path,
        })
      }
      return text('Reviewer waiting for the brief.')
    }
    if (role === 'topic') {
      if (toolResults.length > 0) return text('Step complete.')
      if (prompt.includes('cowork_work_item_create')) return tool('cowork_work_item_create', {})
      if (prompt.includes('cowork_review_request')) {
        return tool('cowork_review_request', {
          purpose: 'Confirm the E2E commit adds the reviewed file',
          baseCommit: workItem.baseCommit,
          headCommit: reviewedHead,
          path: workItem.path,
          workItemId: workItem.workItemId,
          changedPaths: [FILE_NAME],
          verification: [{
            command: `test -f ${FILE_NAME}`,
            exitCode: 0,
            evidence: `${FILE_NAME} exists in the reviewed clone`,
          }],
        })
      }
      if (prompt.includes('cowork_handoff')) {
        return tool('cowork_handoff', {
          status: 'done',
          summary: 'The reviewed work item is ready to merge.',
          verification: [{
            command: `test -f ${FILE_NAME}`,
            exitCode: 0,
            evidence: `${FILE_NAME} exists in the reviewed clone`,
          }],
          changedPaths: [FILE_NAME],
        })
      }
      return text('Topic brief acknowledged.')
    }
    if (toolResults.length > 0) return text('Step complete.')
    if (prompt.includes('cowork_project_init')) return tool('cowork_project_init', {})
    if (prompt.includes('cowork_route')) {
      return tool('cowork_route', {
        intent: 'Prove the independent review and merge path',
        brief: 'Review the work item and merge it.',
        forceCreate: true,
      })
    }
    if (prompt.includes('cowork_checkout_merge')) {
      return tool('cowork_checkout_merge', { workItemId: workItem.workItemId })
    }
    if (prompt.includes('cowork_project_status')) return tool('cowork_project_status', {})
    return text('No scripted step matched this prompt.')
  })

  const master = await ctx.client.createSession({ cwd: ctx.fixture.path, agentPreset: 'cowork-master' })
  const masterId = master.sessionId
  await ctx.promptForTool(masterId, 'Call cowork_project_init exactly once with no arguments.', 'cowork_project_init')
  const routed = await ctx.promptForTool(
    masterId,
    'Call cowork_route exactly once with these arguments (JSON): {"intent":"Prove the independent review and merge path","brief":"Review the work item and merge it.","forceCreate":true}',
    'cowork_route',
  )
  const topicId = routed.payload?.topicId
  ctx.check('route created the review topic', typeof topicId === 'string' && topicId !== '', String(topicId))
  await ctx.waitUntil('the topic brief turn', () =>
    ctx.model.calls.find((call) => call.sessionId === topicId && call.role === 'topic'))
  await ctx.client.waitIdle(topicId, {})

  const created = await ctx.promptForTool(topicId, 'Call cowork_work_item_create exactly once with no arguments.', 'cowork_work_item_create')
  workItem = {
    workItemId: created.payload?.workItemId,
    path: created.payload?.path,
    baseCommit: created.payload?.baseCommit,
    branch: created.payload?.branch,
  }
  ctx.check('work_item_create returned a clone path', typeof workItem.path === 'string' && workItem.path !== '', String(workItem.path))
  ctx.check('the clone starts at the fixture HEAD', workItem.baseCommit === ctx.fixture.head, `${String(workItem.baseCommit)} vs ${ctx.fixture.head}`)

  reviewedHead = await commitFile(workItem.path, FILE_NAME, FILE_CONTENT, 'feat: add the E2E review file')
  ctx.check('the commit advanced the clone beyond its base', reviewedHead !== workItem.baseCommit, `${workItem.baseCommit} -> ${reviewedHead}`)
  const committedFile = await readText(`${workItem.path}/${FILE_NAME}`)
  ctx.check('the committed file exists in the clone', committedFile?.trim() === FILE_CONTENT, committedFile === undefined ? 'missing' : 'present')
  await ctx.client.waitIdle(topicId, {})

  const requested = await ctx.promptForTool(
    topicId,
    `Call cowork_review_request exactly once with these arguments (JSON): ${JSON.stringify({
      purpose: 'Confirm the E2E commit adds the reviewed file',
      baseCommit: workItem.baseCommit,
      headCommit: reviewedHead,
      path: workItem.path,
      workItemId: workItem.workItemId,
      changedPaths: [FILE_NAME],
      verification: [{ command: `test -f ${FILE_NAME}`, exitCode: 0, evidence: `${FILE_NAME} exists in the reviewed clone` }],
    })}`,
    'cowork_review_request',
  )
  const reviewRequestId = requested.payload?.requestId
  const reviewerId = requested.payload?.reviewerSessionId
  ctx.check('review_request returned a pending request', requested.payload?.status === 'pending', String(requested.payload?.status))
  ctx.check('review_request created a reviewer session', typeof reviewerId === 'string' && reviewerId !== topicId && reviewerId !== masterId, String(reviewerId))

  const reviewerState = await ctx.waitUntil('the reviewer preset', () => ctx.client.sessionState(reviewerId))
  ctx.check('the reviewer mounted cowork-reviewer', reviewerState.projections?.values?.agentPreset === 'cowork-reviewer', String(reviewerState.projections?.values?.agentPreset))
  const reviewFile = await ctx.waitUntil('the review request file', async () => {
    const reviews = await ctx.reviews()
    return reviews.find((entry) => entry.value.requestId === reviewRequestId)
  })
  ctx.check('the review file records the request range', reviewFile.value.headCommit === reviewedHead, String(reviewFile.value.headCommit))

  await ctx.waitUntil('the reviewer read-only grep', () =>
    ctx.model.calls.find((call) => call.role === 'reviewer' && call.toolResults.some((row) => row.toolName === 'grep' && row.isError === false)))
  const reviewerVerdict = await ctx.waitUntil('the reviewer verdict call', () =>
    ctx.model.calls.find((call) => call.role === 'reviewer' && call.reply?.tool === 'cowork_review_verdict'))
  ctx.check('the reviewer delivered a verdict', reviewerVerdict.reply.tool === 'cowork_review_verdict', reviewerVerdict.reply.tool)
  const passed = await ctx.waitUntil('the pass verdict in the request and index', async () => {
    const [reviews, index] = await Promise.all([ctx.reviews(), ctx.index()])
    const review = reviews.find((entry) => entry.value.requestId === reviewRequestId)
    const topic = index?.topics.find((entry) => entry.topicId === topicId)
    const item = index?.workItems.find((entry) => entry.workItemId === workItem.workItemId)
    return review?.value.status === 'pass' && topic?.reviewStatus === 'pass' && item?.status === 'reviewing'
      ? { review, topic, item }
      : undefined
  })
  ctx.check('the pass verdict is recorded', passed.review.value.status === 'pass', String(passed.review.value.status))
  ctx.check('the work item is reviewing after the pass', passed.item.status === 'reviewing', String(passed.item.status))
  const mergeNotice = await ctx.waitUntil('the merge-needed delivery to the master', async () => {
    const rows = await ctx.inbox()
    return Array.isArray(rows)
      ? rows.find((entry) => entry.topicId === topicId && entry.kind === 'merge-needed' && entry.deliveredAt !== null)
      : undefined
  })
  ctx.check('the pass wrote a delivered merge-needed inbox row', mergeNotice.deliveredAt !== null, String(mergeNotice.deliveredAt))
  const mergeMessage = await ctx.waitUntil('the merge-needed model turn', () =>
    ctx.model.calls.find((call) => call.sessionId === masterId && call.prompt.includes('[merge-needed]')))
  ctx.check('the master received the merge-needed message', mergeMessage.role === 'master', mergeMessage.role)

  await ctx.promptForTool(
    topicId,
    `Call cowork_handoff exactly once with these arguments (JSON): ${JSON.stringify({
      status: 'done',
      summary: 'The reviewed work item is ready to merge.',
      verification: [{ command: `test -f ${FILE_NAME}`, exitCode: 0, evidence: `${FILE_NAME} exists in the reviewed clone` }],
      changedPaths: [FILE_NAME],
    })}`,
    'cowork_handoff',
  )
  const handoff = (await ctx.index())?.topics.find((entry) => entry.topicId === topicId)
  ctx.check('the handoff confirms the delivery', handoff?.lastDeliveryConfirmedAt !== null, String(handoff?.lastDeliveryConfirmedAt))
  const handoffFile = await ctx.waitUntil('the handoff record file', async () => {
    const files = await ctx.handoffs()
    return files.find((entry) => entry.value.threadId === topicId && entry.value.status === 'done')
  })
  ctx.check('the handoff file exists with done', handoffFile.value.status === 'done', String(handoffFile.value.status))

  await ctx.promptForTool(
    masterId,
    `Call cowork_checkout_merge exactly once with these arguments (JSON): ${JSON.stringify({ workItemId: workItem.workItemId })}`,
    'cowork_checkout_merge',
  )
  const merged = await ctx.waitUntil('the merged work item', async () => {
    const index = await ctx.index()
    const item = index?.workItems.find((entry) => entry.workItemId === workItem.workItemId)
    return item?.status === 'merged' ? item : undefined
  })
  ctx.check('the work item is merged', merged.status === 'merged', String(merged.status))
  ctx.check('the merged clone was removed', !(await readText(`${workItem.path}/README.md`)), 'clone still present')
  ctx.check('the merged file is on the integration branch', (await ctx.readText(FILE_NAME))?.trim() === FILE_CONTENT, 'missing')
  ctx.check('main did not move', readGitHead(ctx.fixture.path, 'refs/heads/main') === ctx.fixture.mainRef, 'main moved')
  ctx.check('the integration branch moved', readGitHead(ctx.fixture.path) !== ctx.fixture.head, 'branch did not move')
  const activityTypes = new Set((await ctx.activity()).map((event) => event.type))
  for (const type of ['review-requested', 'review-verdict', 'work-item-merged']) {
    ctx.check(`activity records ${type}`, activityTypes.has(type), [...activityTypes].join(','))
  }

  const status = await ctx.promptForTool(masterId, 'Call cowork_project_status exactly once with no arguments.', 'cowork_project_status')
  ctx.check(
    'project_status reports the reviewed topic',
    status.payload?.topics?.some((topic) => topic.topicId === topicId && topic.awaitingReview === false),
    JSON.stringify(status.payload?.topics?.map((topic) => topic.topicId)),
  )
}
