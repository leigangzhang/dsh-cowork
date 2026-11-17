/**
 * E2E scenario `topic-bash`: the observational host-bash check.
 *
 * The scripted model drives a real topic session to commit through the host
 * `bash` tool. It only passes on a host whose bash sandbox backend is usable
 * (for example the self-hosted heavy runner or a normal terminal host); the
 * DSH agent's own bash sandbox refuses a nested sandbox, so this scenario is
 * not part of the keyless release evidence and never runs in the default lane.
 */

import { readGitHead, readText } from '../support/fixture.mjs'
import { text, tool } from '../support/scripted-model.mjs'

export const topicBashId = 'topic-bash'

const FILE_NAME = 'e2e-bash.txt'
const FILE_CONTENT = 'committed by the topic bash tool'
const INTENT = 'Prove the topic bash tool can commit'

/** @param {ReturnType<import('../support/context.mjs').createScenarioContext>} ctx */
export async function runTopicBash(ctx) {
  let workItem = null

  ctx.model.setHandler(({ role, prompt, toolResults }) => {
    if (role === 'topic') {
      if (toolResults.length > 0) return text('Step complete.')
      if (prompt.includes('cowork_work_item_create')) return tool('cowork_work_item_create', {})
      if (prompt.includes('Use the bash tool')) {
        return tool('bash', {
          command: `printf '%s\\n' '${FILE_CONTENT}' > ${FILE_NAME} && git add ${FILE_NAME} && git commit -m 'feat: add the bash E2E file'`,
          workdir: workItem.path,
          description: 'commit the bash E2E file',
        })
      }
      return text('Topic brief acknowledged.')
    }
    if (toolResults.length > 0) return text('Step complete.')
    if (prompt.includes('cowork_project_init')) return tool('cowork_project_init', {})
    if (prompt.includes('cowork_route')) {
      return tool('cowork_route', { intent: INTENT, brief: 'Run the bash commit.', forceCreate: true })
    }
    return text('No scripted step matched this prompt.')
  })

  const master = await ctx.client.createSession({ cwd: ctx.fixture.path, agentPreset: 'cowork-master' })
  const masterId = master.sessionId
  await ctx.promptForTool(masterId, 'Call cowork_project_init exactly once with no arguments.', 'cowork_project_init')
  const routed = await ctx.promptForTool(
    masterId,
    `Call cowork_route exactly once with these arguments (JSON): ${JSON.stringify({ intent: INTENT, brief: 'Run the bash commit.', forceCreate: true })}`,
    'cowork_route',
  )
  const topicId = routed.payload?.topicId
  ctx.check('route created the bash topic', typeof topicId === 'string' && topicId !== '', String(topicId))
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
  const headBefore = readGitHead(workItem.path)

  const bash = await ctx.promptForTool(
    topicId,
    `Use the bash tool to run exactly this command with workdir ${workItem.path}, and keep its real exit code: printf '%s\\n' '${FILE_CONTENT}' > ${FILE_NAME} && git add ${FILE_NAME} && git commit -m 'feat: add the bash E2E file'`,
    'bash',
    { acceptError: true, expectOk: false, timeoutMs: 120_000 },
  )
  ctx.check('the bash tool result is not an error', bash.isError === false, bash.text.slice(0, 300))
  const headAfter = readGitHead(workItem.path)
  ctx.check('the bash commit advanced the clone', headAfter !== headBefore, `${headBefore} -> ${headAfter}`)
  ctx.check('the bash commit wrote the file', (await readText(`${workItem.path}/${FILE_NAME}`))?.trim() === FILE_CONTENT, 'missing')
}
