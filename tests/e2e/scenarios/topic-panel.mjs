/**
 * E2E scenario `topic-panel`: the keyless topic and panel chain.
 *
 * A routed topic creates an isolated work item, reports progress, proposes a
 * decision, asks for authorization, asks the user a question, submits a plan,
 * and requests a user review. The panel routes then authorize, answer, approve,
 * pass, move, archive, and reopen the topic against the real host. Request
 * files, the project index, and panel responses are asserted independently of
 * the model's prompts.
 */

import { text, tool } from '../support/scripted-model.mjs'

export const topicPanelId = 'topic-panel'

const TOPIC_INTENT = 'Build the panel E2E topic'
const TOPIC_BRIEF = 'Panel E2E brief.'
const REPORT_SUMMARY = 'Progress from the keyless E2E topic'
const MOVE_INTENT = 'move the routed panel intent'

/** @param {ReturnType<import('../support/context.mjs').createScenarioContext>} ctx */
export async function runTopicPanel(ctx) {
  let topicResolveArgs = null
  let routeArgs = { intent: TOPIC_INTENT, brief: TOPIC_BRIEF }
  ctx.model.setHandler(({ role, prompt, toolResults }) => {
    if (role === 'topic') {
      if (toolResults.length > 0) return text('Step complete.')
      if (prompt.includes('cowork_work_item_create')) return tool('cowork_work_item_create', {})
      if (prompt.includes('cowork_topic_report')) {
        return tool('cowork_topic_report', { summary: REPORT_SUMMARY, kind: 'progress' })
      }
      if (prompt.includes('cowork_decision_propose')) {
        return tool('cowork_decision_propose', {
          title: 'E2E decision',
          summary: 'Record the panel scenario decision.',
        })
      }
      if (prompt.includes('cowork_authorization_request')) {
        return tool('cowork_authorization_request', { summary: 'Authorize the E2E write' })
      }
      if (prompt.includes('cowork_request_question')) {
        return tool('cowork_request_question', {
          questions: [{
            prompt: 'Pick the E2E color',
            mode: 'single',
            options: [{ label: 'green', recommended: true }, { label: 'blue' }],
          }],
        })
      }
      if (prompt.includes('cowork_request_plan')) {
        return tool('cowork_request_plan', {
          planPath: 'PLAN.md',
          summary: 'Approve the fixture plan?',
        })
      }
      if (prompt.includes('cowork_user_review_request')) {
        return tool('cowork_user_review_request', {
          purpose: 'Review the fixture README',
          changedPaths: ['README.md'],
          verification: [{ command: 'test -f README.md', exitCode: 0, evidence: 'README.md exists' }],
        })
      }
      return text('Topic brief acknowledged.')
    }
    if (toolResults.length > 0) return text('Step complete.')
    if (prompt.includes('cowork_project_init')) return tool('cowork_project_init', {})
    if (prompt.includes('cowork_route')) {
      return tool('cowork_route', routeArgs)
    }
    if (prompt.includes('cowork_topic_create')) {
      return tool('cowork_topic_create', { title: 'Route move target', scope: 'The route.move destination' })
    }
    if (prompt.includes('cowork_topic_resolve')) {
      return tool('cowork_topic_resolve', topicResolveArgs ?? {})
    }
    if (prompt.includes('cowork_project_status')) return tool('cowork_project_status', {})
    return text('No scripted step matched this prompt.')
  })

  const master = await ctx.client.createSession({ cwd: ctx.fixture.path, agentPreset: 'cowork-master' })
  const masterId = master.sessionId
  await ctx.promptForTool(masterId, 'Call cowork_project_init exactly once with no arguments.', 'cowork_project_init')
  const routed = await ctx.promptForTool(
    masterId,
    `Call cowork_route exactly once with these arguments (JSON): ${JSON.stringify({ intent: TOPIC_INTENT, brief: TOPIC_BRIEF })}`,
    'cowork_route',
  )
  const topicId = routed.payload?.topicId
  ctx.check('route created the scenario topic', typeof topicId === 'string' && topicId !== '', String(topicId))
  await ctx.waitUntil('the topic brief turn', () =>
    ctx.model.calls.find((call) => call.sessionId === topicId && call.role === 'topic' && call.prompt.includes(TOPIC_BRIEF)))
  await ctx.client.waitIdle(topicId, {})

  const target = await ctx.promptForTool(
    masterId,
    `Call cowork_topic_create exactly once with these arguments (JSON): ${JSON.stringify({ title: 'Route move target', scope: 'The route.move destination' })}`,
    'cowork_topic_create',
  )
  const targetTopicId = target.payload?.topic?.topicId
  ctx.check('a second topic exists for route.move', typeof targetTopicId === 'string' && targetTopicId !== topicId, String(targetTopicId))

  const workItem = await ctx.promptForTool(
    topicId,
    'Call cowork_work_item_create exactly once with no arguments.',
    'cowork_work_item_create',
  )
  const workItemId = workItem.payload?.workItemId
  ctx.check('work_item_create returned an id', typeof workItemId === 'string' && workItemId !== '', String(workItemId))
  const indexAfterWorkItem = await ctx.index()
  const row = indexAfterWorkItem?.workItems.find((item) => item.workItemId === workItemId)
  ctx.check('the work item is active in the index', row?.status === 'active', String(row?.status))
  ctx.check(
    'the work item branch is cowork/<id>',
    row?.branch === `cowork/${workItemId}`,
    String(row?.branch),
  )
  ctx.check('the work item clone exists', row?.path !== undefined, String(row?.path))

  await ctx.promptForTool(
    topicId,
    `Call cowork_topic_report exactly once with these arguments (JSON): ${JSON.stringify({ summary: REPORT_SUMMARY, kind: 'progress' })}`,
    'cowork_topic_report',
  )
  const reported = (await ctx.index())?.topics.find((topic) => topic.topicId === topicId)
  ctx.check('topic_report updated the topic digest', reported?.digest.includes(REPORT_SUMMARY), reported?.digest)

  const decision = await ctx.promptForTool(
    topicId,
    'Call cowork_decision_propose exactly once with these arguments (JSON): {"title":"E2E decision","summary":"Record the panel scenario decision."}',
    'cowork_decision_propose',
  )
  ctx.check('decision_propose returned a proposal id', typeof decision.payload?.proposal?.proposalId === 'string', String(decision.payload?.proposal?.proposalId))
  ctx.check('the proposal file exists', (await ctx.proposals()).length === 1, String((await ctx.proposals()).length))

  const authorization = await ctx.promptForTool(
    topicId,
    'Call cowork_authorization_request exactly once with these arguments (JSON): {"summary":"Authorize the E2E write"}',
    'cowork_authorization_request',
  )
  const authorizationId = authorization.payload?.requestId
  ctx.check('authorization_request returned a request id', typeof authorizationId === 'string', String(authorizationId))
  const blocked = await ctx.waitUntil('the blocked topic', async () => {
    const topic = (await ctx.index())?.topics.find((entry) => entry.topicId === topicId)
    return topic?.blocked === true && topic.authorization !== null ? topic : undefined
  })
  ctx.check('the topic is blocked by the authorization', blocked.blocked === true, String(blocked.blocked))
  const overviewBlocked = await ctx.panelGet(`/api/cowork.overview?sessionId=${encodeURIComponent(masterId)}`)
  ctx.check('overview reports the pending authorization', overviewBlocked.status === 200
    && overviewBlocked.body?.topics?.some((entry) => entry.topicId === topicId && entry.awaitingAuthorization === true), String(overviewBlocked.status))

  const allow = await ctx.panelPost('/api/cowork.authorization.resolve', {
    sessionId: masterId,
    topicId,
    requestId: authorizationId,
    decision: 'allow',
  })
  ctx.check('POST authorization.resolve returns 200', allow.status === 200, String(allow.status))
  ctx.check('the authorization decision is recorded', allow.body?.ok === true && allow.body?.decision === 'allow', JSON.stringify(allow.body).slice(0, 300))
  const unblocked = await ctx.waitUntil('the topic to unblock', async () => {
    const topic = (await ctx.index())?.topics.find((entry) => entry.topicId === topicId)
    return topic?.blocked === false ? topic : undefined
  })
  ctx.check('the topic is unblocked after allow', unblocked.blocked === false, String(unblocked.blocked))
  await ctx.client.waitIdle(topicId, {})

  const question = await ctx.promptForTool(
    topicId,
    'Call cowork_request_question exactly once with these arguments (JSON): {"questions":[{"prompt":"Pick the E2E color","mode":"single","options":[{"label":"green","recommended":true},{"label":"blue"}]}]}',
    'cowork_request_question',
  )
  const questionId = question.payload?.requestId
  ctx.check('request_question returned a request id', typeof questionId === 'string', String(questionId))
  const inboxQuestion = await ctx.panelGet(`/api/cowork.inbox?sessionId=${encodeURIComponent(masterId)}`)
  ctx.check('the inbox lists the pending question', inboxQuestion.status === 200
    && inboxQuestion.body?.items?.some((item) => item.requestId === questionId && item.requestKind === 'question' && item.status === 'pending'), String(inboxQuestion.status))
  const skipped = await ctx.panelPost('/api/cowork.inbox.resolve', { sessionId: masterId, requestId: questionId, action: 'skip' })
  ctx.check('POST inbox.resolve skips the question', skipped.status === 200 && skipped.body?.item?.status === 'skipped', JSON.stringify(skipped.body?.item?.status))
  await ctx.client.waitIdle(topicId, {})

  const plan = await ctx.promptForTool(
    topicId,
    'Call cowork_request_plan exactly once with these arguments (JSON): {"planPath":"PLAN.md","summary":"Approve the fixture plan?"}',
    'cowork_request_plan',
  )
  const planId = plan.payload?.requestId
  ctx.check('request_plan returned a request id', typeof planId === 'string', String(planId))
  const approved = await ctx.panelPost('/api/cowork.inbox.resolve', { sessionId: masterId, requestId: planId, action: 'approve' })
  ctx.check('POST inbox.resolve approves the plan', approved.status === 200 && approved.body?.item?.status === 'approved', JSON.stringify(approved.body?.item?.status))
  await ctx.client.waitIdle(topicId, {})

  const userReview = await ctx.promptForTool(
    topicId,
    'Call cowork_user_review_request exactly once with these arguments (JSON): {"purpose":"Review the fixture README","changedPaths":["README.md"],"verification":[{"command":"test -f README.md","exitCode":0,"evidence":"README.md exists"}]}',
    'cowork_user_review_request',
  )
  const userReviewId = userReview.payload?.requestId
  ctx.check('user_review_request returned a request id', typeof userReviewId === 'string', String(userReviewId))
  const passed = await ctx.panelPost('/api/cowork.inbox.resolve', { sessionId: masterId, requestId: userReviewId, action: 'pass' })
  ctx.check('POST inbox.resolve passes the user review', passed.status === 200 && passed.body?.item?.status === 'passed', JSON.stringify(passed.body?.item?.status))
  await ctx.client.waitIdle(topicId, {})

  const activity = await ctx.panelGet(`/api/cowork.activity?sessionId=${encodeURIComponent(masterId)}`)
  ctx.check('GET cowork.activity returns 200', activity.status === 200 && activity.body?.ok === true, String(activity.status))
  const topicRead = await ctx.panelGet(`/api/cowork.topic?sessionId=${encodeURIComponent(masterId)}&topicId=${encodeURIComponent(topicId)}`)
  ctx.check('GET cowork.topic returns 200', topicRead.status === 200 && topicRead.body?.ok === true, String(topicRead.status))
  ctx.check('GET cowork.topic names the scenario topic', topicRead.body?.topic?.topicId === topicId, String(topicRead.body?.topic?.topicId))

  const moved = await ctx.panelPost('/api/cowork.route.move', {
    sessionId: masterId,
    fromTopicId: topicId,
    toTopicId: targetTopicId,
    intent: MOVE_INTENT,
  })
  ctx.check('POST route.move returns 200', moved.status === 200, String(moved.status))
  const movedTarget = (await ctx.index())?.topics.find((topic) => topic.topicId === targetTopicId)
  ctx.check(
    'route.move appended the intent tokens to the target aliases',
    ['routed', 'panel', 'intent'].every((token) => movedTarget?.aliases?.includes(token)),
    JSON.stringify(movedTarget?.aliases),
  )

  const archived = await ctx.panelPost('/api/cowork.topic.resolve', { sessionId: masterId, topicId })
  ctx.check('POST topic.resolve archives the topic', archived.status === 200 && archived.body?.topic?.status === 'resolved', String(archived.body?.topic?.status))
  const resolvedOverview = await ctx.panelGet(`/api/cowork.overview?sessionId=${encodeURIComponent(masterId)}`)
  ctx.check('the overview counts the resolved topic', (resolvedOverview.body?.counts?.resolved ?? 0) >= 1, String(resolvedOverview.body?.counts?.resolved))
  const reopenedTopic = await ctx.panelPost('/api/cowork.topic.reopen', { sessionId: masterId, topicId })
  ctx.check('POST topic.reopen restores the topic', reopenedTopic.status === 200 && reopenedTopic.body?.topic?.status === 'active', String(reopenedTopic.body?.topic?.status))

  topicResolveArgs = { topicId }
  const toolResolved = await ctx.promptForTool(
    masterId,
    `Call cowork_topic_resolve exactly once with these arguments (JSON): ${JSON.stringify({ topicId })}`,
    'cowork_topic_resolve',
  )
  ctx.check('cowork_topic_resolve archives the topic', toolResolved.payload?.ok === true, String(toolResolved.payload?.ok))
  const afterToolResolve = (await ctx.index())?.topics.find((topic) => topic.topicId === topicId)
  ctx.check('the index records the tool resolution', afterToolResolve?.status === 'resolved', String(afterToolResolve?.status))

  const marker = ctx.model.calls.length
  routeArgs = {
    intent: 'Follow up after the resolved panel topic',
    topicId,
    brief: 'Resolved follow-up brief.',
  }
  const followUp = await ctx.promptForTool(
    masterId,
    `Call cowork_route exactly once with these arguments (JSON): ${JSON.stringify(routeArgs)}`,
    'cowork_route',
  )
  ctx.check('a resolved target reports resolved_match', followUp.payload?.action === 'resolved_match', String(followUp.payload?.action))
  ctx.check('resolved_match names the old topic', followUp.payload?.resolvedMatch?.topicId === topicId, String(followUp.payload?.resolvedMatch?.topicId))
  const replacementId = followUp.payload?.topicId
  ctx.check('the follow-up created a replacement topic', typeof replacementId === 'string' && replacementId !== topicId, String(replacementId))
  const replacement = (await ctx.index())?.topics.find((topic) => topic.topicId === replacementId)
  ctx.check('the replacement topic starts live', replacement?.status === 'active' || replacement?.status === 'idle', String(replacement?.status))
  const oldTopicTurns = ctx.model.calls.slice(marker).filter((call) => call.sessionId === topicId)
  ctx.check('the resolved topic received no follow-up turn', oldTopicTurns.length === 0, String(oldTopicTurns.length))
  await ctx.waitUntil('the replacement topic brief', () =>
    ctx.model.calls.slice(marker).find((call) => call.sessionId === replacementId && call.role === 'topic'))
  await ctx.client.waitIdle(replacementId, {})

  const status = await ctx.promptForTool(masterId, 'Call cowork_project_status exactly once with no arguments.', 'cowork_project_status')
  const statuses = (status.payload?.topics ?? []).map((topic) => topic.status)
  ctx.check('project_status reports a live idle topic', statuses.includes('idle'), JSON.stringify(statuses))
}
