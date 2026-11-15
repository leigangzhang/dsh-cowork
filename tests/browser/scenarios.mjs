/** User-outcome scenarios for the real DSH browser panel lane. */
import assert from 'node:assert/strict'
import { BROWSER_REQUESTS, BROWSER_TOPICS } from './fixtures.mjs'

const PATH_RESOLVE = '/api/cowork.topic.resolve'
const PATH_REOPEN = '/api/cowork.topic.reopen'
const PATH_INBOX_RESOLVE = '/api/cowork.inbox.resolve'
const PATH_OVERVIEW = '/api/cowork.overview'

/** Wait for one POST response by pathname. */
function waitForPost(page, path) {
  return page.waitForResponse((response) => {
    try {
      return new URL(response.url()).pathname === path && response.request().method() === 'POST'
    } catch {
      return false
    }
  })
}

/** The visible panel root, after ensuring the right-sidebar tab is open. */
async function ensurePanel(page) {
  const panel = page.getByTestId('cw-panel')
  if (!(await panel.isVisible().catch(() => false))) {
    const footer = page.getByRole('button', { name: '打开 Cowork 面板' })
    await footer.waitFor({ timeout: 15_000 })
    await footer.click()
  }
  await panel.waitFor({ timeout: 15_000 })
  return panel
}

/** Wait until the first overview read painted either groups or an error/empty surface. */
async function waitForOverview(page) {
  await page.locator('.cw-group, .cw-notice').first().waitFor({ timeout: 15_000 })
}

/** Leave the narrow inbox focus pane and wait for the topic list. */
async function ensureTopicList(page) {
  const back = page.getByTestId('cw-inbox-back')
  if (await back.isVisible().catch(() => false)) await back.click()
  await waitForOverview(page)
}

/** Open the narrow-layout inbox focus pane when the banner is present. */
async function ensureInboxVisible(page) {
  const focus = page.getByTestId('cw-inbox-focus')
  if (await focus.isVisible().catch(() => false)) return focus
  const banner = page.getByTestId('cw-needs-you-banner')
  if (await banner.isVisible().catch(() => false)) {
    await banner.click()
    await focus.waitFor({ timeout: 10_000 })
    return focus
  }
  await page.getByTestId('cw-inbox').waitFor({ timeout: 10_000 })
  return null
}

/** A request row by stable fixture id. */
function requestRow(page, requestId) {
  return page.locator(`[data-testid="cw-inbox-item"][data-request-id="${requestId}"]`)
}

/** Resolve one request through its card button and return the HTTP response. */
async function resolveRequest(page, requestId, action, prepare) {
  const row = requestRow(page, requestId)
  await row.waitFor({ timeout: 10_000 })
  if (prepare !== undefined) await prepare(row)
  const responsePromise = waitForPost(page, PATH_INBOX_RESOLVE)
  await row.locator(`[data-testid="cw-inbox-action"][data-action="${action}"]`).click()
  return responsePromise
}

/** One menu action: open the card menu, focus its item, press Enter. */
async function runCardMenu(page, topicId, expectedPath) {
  const card = page.locator(`.cw-card[data-topic-id="${topicId}"]`)
  await card.locator('.cw-card-more').click()
  const menu = card.locator('.cw-card-menu')
  await menu.waitFor({ timeout: 5_000 })
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem')
  const responsePromise = waitForPost(page, expectedPath)
  await page.keyboard.press('Enter')
  return responsePromise
}

/** Assert the core four-group panel, menu focus, optimistic writes and rollback. */
async function scenarioTopicGroups(page) {
  const panel = await ensurePanel(page)
  await waitForOverview(page)
  assert.equal(await panel.getAttribute('data-width-mode'), 'wide')
  assert.deepEqual(
    await page.locator('.cw-group').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-group'))),
    ['blocked', 'running', 'idle', 'resolved'],
  )
  assert.equal(await page.locator('.cw-group[data-group="resolved"] .cw-card').count(), 0)

  const blocked = page.locator(`.cw-card[data-topic-id="${BROWSER_TOPICS.blocked}"]`)
  await blocked.waitFor()
  const blockedMore = blocked.locator('.cw-card-more')
  await blockedMore.click()
  const blockedMenu = blocked.locator('.cw-card-menu')
  await blockedMenu.waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Home')
  await page.keyboard.press('End')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem')
  await page.keyboard.press('Escape')
  await blockedMenu.waitFor({ state: 'detached' })
  assert.equal(await blockedMore.evaluate(node => document.activeElement === node), true, 'Escape returns focus to the menu trigger')

  await blockedMore.click()
  await blockedMenu.waitFor()
  await page.keyboard.press('Tab')
  await blockedMenu.waitFor({ state: 'detached' })

  const runningId = BROWSER_TOPICS.running
  const archiveResponse = await runCardMenu(page, runningId, PATH_RESOLVE)
  assert.equal(archiveResponse.status(), 200)
  assert.equal(archiveResponse.request().postDataJSON().topicId, runningId)
  await page.locator(`.cw-card[data-topic-id="${runningId}"][data-group="resolved"]`).waitFor({ timeout: 10_000 })
  assert.match(await page.locator('.cw-receipt').innerText(), /已归档/)
  assert.equal(
    await page.locator('.cw-group[data-group="resolved"] .cw-group-toggle').evaluate(node => document.activeElement === node),
    true,
    'archiving opens the resolved group and parks focus on its toggle',
  )

  const restoreResponse = await runCardMenu(page, runningId, PATH_REOPEN)
  assert.equal(restoreResponse.status(), 200)
  assert.equal(restoreResponse.request().postDataJSON().topicId, runningId)
  await page.locator(`.cw-card[data-topic-id="${runningId}"][data-group="running"]`).waitFor({ timeout: 10_000 })
  assert.match(await page.locator('.cw-receipt').innerText(), /已恢复/)

  const idleId = BROWSER_TOPICS.idle
  let failNext = true
  await page.route(`**${PATH_RESOLVE}`, async (route) => {
    if (!failNext) {
      await route.continue()
      return
    }
    failNext = false
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'fixture boom' } }),
    })
  })
  const failed = await runCardMenu(page, idleId, PATH_RESOLVE)
  assert.equal(failed.status(), 500)
  await page.locator('.cw-receipt[data-kind="failed"]').filter({ hasText: 'fixture boom' }).waitFor({ timeout: 10_000 })
  await page.locator(`.cw-card[data-topic-id="${idleId}"][data-group="idle"]`).waitFor({ timeout: 10_000 })
  await page.unroute(`**${PATH_RESOLVE}`)
  return { runningId }
}

/** Wide/narrow host layout, narrow inbox focus, and per-session filter persistence. */
async function scenarioLayoutAndFilter(page) {
  await ensurePanel(page)
  await waitForOverview(page)
  assert.equal(await page.getByTestId('cw-panel').getAttribute('data-width-mode'), 'wide')
  assert.equal(await page.locator('.cw-columns').count(), 1)
  await page.getByRole('button', { name: '分栏' }).click()
  await page.getByTestId('cw-panel').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('[data-testid="cw-panel"]')?.getAttribute('data-width-mode') === 'narrow')
  assert.equal(await page.getByTestId('cw-needs-you-banner').isVisible(), true)

  const runningId = BROWSER_TOPICS.running
  const filter = page.locator(`.cw-card[data-topic-id="${runningId}"] [data-testid="cw-topic-filter"]`)
  await filter.click()
  assert.equal(await filter.getAttribute('aria-pressed'), 'true')
  const storage = await page.evaluate(() => Object.fromEntries(
    Object.keys(sessionStorage).filter(key => key.includes('cw.inbox.filter.')).map(key => [key, sessionStorage.getItem(key)]),
  ))
  assert.ok(Object.values(storage).some((value) => {
    try {
      return JSON.parse(value) === runningId
    } catch {
      return false
    }
  }), 'the topic filter is persisted in sessionStorage')

  await ensureInboxVisible(page)
  await page.getByTestId('cw-inbox-filter-clear').waitFor({ timeout: 10_000 })
  assert.match(await page.getByTestId('cw-inbox-filter-clear').innerText(), /浏览器运行主题/)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 30_000 })
  await ensurePanel(page)
  await ensureInboxVisible(page)
  await page.getByTestId('cw-inbox-filter-clear').waitFor({ timeout: 10_000 })
  assert.match(await page.getByTestId('cw-inbox-filter-clear').innerText(), /浏览器运行主题/)
}

/** All four request kinds, both actions of each kind, and write failure retention. */
async function scenarioInboxActions(page) {
  await ensurePanel(page)
  await ensureInboxVisible(page)
  const clear = page.getByTestId('cw-inbox-filter-clear')
  if (await clear.isVisible().catch(() => false)) {
    await clear.click()
    await clear.waitFor({ state: 'detached' })
  }
  const ids = BROWSER_REQUESTS

  const reviewReturn = requestRow(page, ids.reviewReturn)
  await reviewReturn.waitFor()
  await reviewReturn.locator('[data-testid="cw-inbox-comment"]').fill('请补充截图')
  const returnResponse = await resolveRequest(page, ids.reviewReturn, 'return')
  const returnBody = await returnResponse.json()
  assert.equal(returnBody.item.status, 'returned')
  assert.equal(returnResponse.request().postDataJSON().comment, '请补充截图')
  assert.equal(typeof returnBody.promptError, 'string', 'the fixture topic has no real Session, so the wake-up must report a warning')
  await requestRow(page, ids.reviewReturn)
    .locator('[data-testid="cw-inbox-receipt"][data-kind="warn"]')
    .waitFor({ timeout: 10_000 })

  const passResponse = await resolveRequest(page, ids.reviewPass, 'pass')
  assert.equal((await passResponse.json()).item.status, 'passed')

  const denyResponse = await resolveRequest(page, ids.authDeny, 'deny')
  assert.equal((await denyResponse.json()).item.status, 'denied')

  const allowResponse = await resolveRequest(page, ids.authAllow, 'allow')
  assert.equal((await allowResponse.json()).item.status, 'allowed')

  const skipResponse = await resolveRequest(page, ids.questionSkip, 'skip')
  assert.equal((await skipResponse.json()).item.status, 'skipped')

  const submitRow = requestRow(page, ids.questionSubmit)
  await submitRow.waitFor()
  await submitRow.locator('[data-testid="cw-inbox-option"][data-option-id="o1"]').click()
  await submitRow.getByRole('button', { name: '下一题' }).click()
  await submitRow.locator('[data-testid="cw-inbox-answer"]').fill('补充说明')
  const submitButton = submitRow.locator('[data-testid="cw-inbox-action"][data-action="submit"]')
  assert.equal(await submitButton.isEnabled(), true)
  const submitPromise = waitForPost(page, PATH_INBOX_RESOLVE)
  await submitButton.click()
  const submitResponse = await submitPromise
  const submitBody = await submitResponse.json()
  assert.equal(submitBody.item.status, 'answered')
  const submitPayload = submitResponse.request().postDataJSON()
  assert.deepEqual(submitPayload.answers, [
    { questionId: 'q1', selected: ['o1'] },
    { questionId: 'q2', text: '补充说明' },
  ])

  const reviseRow = requestRow(page, ids.planRevise)
  await reviseRow.waitFor()
  await reviseRow.locator('[data-testid="cw-inbox-action"][data-action="revise"]').click()
  await reviseRow.locator('[data-testid="cw-inbox-comment"]').fill('请把场景拆小')
  const revisePromise = waitForPost(page, PATH_INBOX_RESOLVE)
  await reviseRow.locator('[data-testid="cw-inbox-action"][data-action="revise"]').click()
  const reviseResponse = await revisePromise
  assert.equal((await reviseResponse.json()).item.status, 'revise')
  assert.equal(reviseResponse.request().postDataJSON().comment, '请把场景拆小')

  const approveResponse = await resolveRequest(page, ids.planApprove, 'approve')
  assert.equal((await approveResponse.json()).item.status, 'approved')

  const errorRow = requestRow(page, ids.error)
  await errorRow.waitFor()
  await page.route(`**${PATH_INBOX_RESOLVE}`, async (route) => {
    const body = route.request().postDataJSON()
    if (body.requestId !== ids.error) {
      await route.continue()
      return
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'fixture inbox boom' } }),
    })
  })
  const errorPromise = waitForPost(page, PATH_INBOX_RESOLVE)
  await errorRow.locator('[data-testid="cw-inbox-action"][data-action="allow"]').click()
  const errorResponse = await errorPromise
  assert.equal(errorResponse.status(), 500)
  await errorRow.locator('[data-testid="cw-inbox-receipt"][data-kind="error"]').filter({ hasText: 'fixture inbox boom' }).waitFor({ timeout: 10_000 })
  assert.equal(await errorRow.getAttribute('data-status'), 'pending')
  await page.unroute(`**${PATH_INBOX_RESOLVE}`)

  await page.locator('[data-testid="cw-inbox-note"][data-notice-kind="review-verdict"]').waitFor({ timeout: 10_000 })
}

/** Switch to a Session created through the real workspace action. */
async function scenarioSessionSwitch(page, fixtures) {
  await ensureTopicList(page)
  const primaryFilter = page.locator(`.cw-card[data-topic-id="${BROWSER_TOPICS.running}"] [data-testid="cw-topic-filter"]`)
  if ((await primaryFilter.getAttribute('aria-pressed')) !== 'true') await primaryFilter.click()

  await page.locator(`[data-row-key="workspace:${fixtures.secondaryWorkspaceId}"]`).hover()
  const createButton = page.locator('button[aria-label*="secondary-repo"][aria-label*="新建会话"]')
  await createButton.waitFor({ state: 'visible', timeout: 10_000 })
  const [created] = await Promise.all([
    page.waitForResponse((response) => {
      try {
        return new URL(response.url()).pathname === '/api/session/create'
      } catch {
        return false
      }
    }),
    createButton.click(),
  ])
  const selectedSessionId = (await created.json()).result.value.sessionId
  const secondary = await fixtures.prepareSecondarySession(selectedSessionId)
  await page.evaluate(({ sessionId, topicId }) => {
    sessionStorage.setItem(`cw.inbox.filter.${sessionId}`, JSON.stringify(topicId))
  }, { sessionId: selectedSessionId, topicId: secondary.topic.topicId })

  await ensurePanel(page)
  await waitForOverview(page)
  await page.getByText('第二个浏览器会话', { exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(await page.getByText('浏览器运行主题', { exact: true }).count(), 0)
  await ensureInboxVisible(page)
  const clear = page.getByTestId('cw-inbox-filter-clear')
  await clear.waitFor({ timeout: 10_000 })
  assert.match(await clear.innerText(), /第二个浏览器会话/)
}

/** The overview error surface retries into the normal four-group list. */
async function scenarioOverviewRetry(page) {
  await ensurePanel(page)
  await ensureTopicList(page)
  let failed = false
  await page.route(`**${PATH_OVERVIEW}*`, async (route) => {
    if (failed) {
      await route.continue()
      return
    }
    failed = true
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'overview fixture boom' } }),
    })
  })
  await page.getByRole('button', { name: '刷新 Cowork 项目' }).click()
  const alert = page.getByRole('alert').filter({ hasText: '读取 Cowork 项目失败' })
  await alert.waitFor({ timeout: 10_000 })
  await alert.getByRole('button', { name: '重试' }).click()
  await page.locator('.cw-group').first().waitFor({ timeout: 10_000 })
  await page.unroute(`**${PATH_OVERVIEW}*`)
}

/** Run every browser scenario in one context and return the ids it exercised. */
export async function runBrowserScenarios(page, fixtures) {
  await scenarioTopicGroups(page)
  await scenarioLayoutAndFilter(page)
  await scenarioInboxActions(page)
  await scenarioOverviewRetry(page)
  await scenarioSessionSwitch(page, fixtures)
}
