/** User-outcome scenarios for the real DSH browser panel lane. */
import assert from 'node:assert/strict'
import { BROWSER_REQUESTS, BROWSER_TOPICS } from './fixtures.mjs'

const PATH_RESOLVE = '/api/cowork.topic.resolve'
const PATH_REOPEN = '/api/cowork.topic.reopen'
const PATH_INBOX = '/api/cowork.inbox'
const PATH_INBOX_RESOLVE = '/api/cowork.inbox.resolve'
const PATH_INBOX_OPEN = '/api/cowork.inbox.open'
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

/**
 * The visible panel root, after ensuring the right-sidebar tab is open.
 *
 * A session switch can land between the visibility check and the tab open, and
 * the host may close the right sidebar for the new session. Re-check the end
 * state and open the tab again instead of trusting one click.
 */
function isPanelVisible(panel) {
  return panel.isVisible().catch(() => false)
}

/** Click the footer entry when it is on screen; it is the only tab opener. */
async function openPanelTab(page) {
  const footer = page.getByRole('button', { name: '打开 Cowork 面板' })
  if (!(await footer.isVisible().catch(() => false))) return
  await footer.click({ timeout: 5_000 }).catch(() => {})
}

async function ensurePanel(page) {
  const panel = page.getByTestId('cw-panel')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await isPanelVisible(panel)) return panel
    await openPanelTab(page)
    const remaining = Math.max(1, deadline - Date.now())
    const settled = await panel.waitFor({ timeout: Math.min(2_000, remaining) }).then(() => true).catch(() => false)
    if (settled) return panel
  }
  throw new Error('the Cowork panel did not become visible within 20s')
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
  // The topic menu has one state action, so Arrow/Home/End have no sibling to
  // move to; the observable contract here is initial focus, Escape and Tab.
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem')
  await page.keyboard.press('Escape')
  await blockedMenu.waitFor({ state: 'detached' })
  assert.equal(await blockedMore.evaluate(node => document.activeElement === node), true, 'Escape returns focus to the menu trigger')

  await blockedMore.click()
  await blockedMenu.waitFor()
  await page.keyboard.press('Tab')
  await blockedMenu.waitFor({ state: 'detached' })

  // A pointer outside the menu closes it without returning focus; the single
  // item keeps focus under every arrow, Home and End key.
  await blockedMore.click()
  await blockedMenu.waitFor()
  await page.locator('.cw-header').click({ position: { x: 4, y: 4 } })
  await blockedMenu.waitFor({ state: 'detached' })
  assert.equal(
    await blockedMore.evaluate(node => document.activeElement === node),
    false,
    'a pointer outside closes the menu without stealing focus back',
  )
  await blockedMore.click()
  await blockedMenu.waitFor()
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    await page.keyboard.press(key)
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('role')),
      'menuitem',
      `${key} keeps focus on the only menu item`,
    )
  }
  await page.keyboard.press('Escape')
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

  // A failed restore rolls the resolved card back and keeps a failed receipt.
  let failRestore = true
  await page.route(`**${PATH_REOPEN}`, async (route) => {
    if (!failRestore) {
      await route.continue()
      return
    }
    failRestore = false
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'reopen fixture boom' } }),
    })
  })
  const resolvedId = BROWSER_TOPICS.resolved
  const failedRestore = await runCardMenu(page, resolvedId, PATH_REOPEN)
  assert.equal(failedRestore.status(), 500)
  await page.locator('.cw-receipt[data-kind="failed"]').filter({ hasText: 'reopen fixture boom' }).waitFor({ timeout: 10_000 })
  await page.locator(`.cw-card[data-topic-id="${resolvedId}"][data-group="resolved"]`).waitFor({ timeout: 10_000 })
  await page.unroute(`**${PATH_REOPEN}`)
  return { runningId }
}

/** Wide/narrow host layout and the narrow inbox focus pane. */
async function scenarioLayoutAndFilter(page) {
  await ensurePanel(page)
  await waitForOverview(page)
  assert.equal(await page.getByTestId('cw-panel').getAttribute('data-width-mode'), 'wide')
  assert.equal(await page.locator('.cw-columns').count(), 1)
  await page.getByRole('button', { name: '分栏' }).click()
  await page.getByTestId('cw-panel').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('[data-testid="cw-panel"]')?.getAttribute('data-width-mode') === 'narrow')
  assert.equal(await page.getByTestId('cw-needs-you-banner').isVisible(), true)
}

/** Set the per-session topic filter and assert it is stored, before the reload. */
async function scenarioFilterSetup(page) {
  assert.equal(await page.getByTestId('cw-panel').getAttribute('data-width-mode'), 'narrow')
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
}

/**
 * Assert the stored filter survives a real reload.
 *
 * This opens the second coverage phase: the lane snapshots coverage before the
 * reload and union both phases, because Chromium only reports scripts that are
 * alive when collection stops. Keeping every pre-reload interaction in phase
 * one is what makes the union complete.
 */
async function scenarioFilterRestore(page) {
  const runningId = BROWSER_TOPICS.running
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 30_000 })
  await ensurePanel(page)
  await ensureInboxVisible(page)
  await page.getByTestId('cw-inbox-filter-clear').waitFor({ timeout: 10_000 })
  assert.match(await page.getByTestId('cw-inbox-filter-clear').innerText(), /浏览器运行主题/)
  const restoredStorage = await page.evaluate((topicId) => Object.values(sessionStorage).some((value) => {
    try {
      return JSON.parse(value) === topicId
    } catch {
      return false
    }
  }), runningId)
  assert.equal(restoredStorage, true, 'the reload restores the stored filter entry')

  // Toggling the active topic filter off drops the stored selection, and the
  // inbox clear button drops it from the inbox header.
  await ensureTopicList(page)
  const restored = page.locator(`.cw-card[data-topic-id="${runningId}"] [data-testid="cw-topic-filter"]`)
  const clear = page.getByTestId('cw-inbox-filter-clear')
  assert.equal(await restored.getAttribute('aria-pressed'), 'true', 'the reloaded panel restores the active filter')
  await restored.click()
  assert.equal(await restored.getAttribute('aria-pressed'), 'false')
  await ensureInboxVisible(page)
  await clear.waitFor({ state: 'detached' })
  await ensureTopicList(page)
  await restored.click()
  await ensureInboxVisible(page)
  await clear.waitFor({ timeout: 10_000 })
  await clear.click()
  await clear.waitFor({ state: 'detached' })
  await ensureTopicList(page)
  assert.equal(await restored.getAttribute('aria-pressed'), 'false')
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
  const submitButton = submitRow.locator('[data-testid="cw-inbox-action"][data-action="submit"]')
  assert.equal(await submitButton.isDisabled(), true, 'submit is disabled before both answers')
  await submitRow.locator('[data-testid="cw-inbox-option"][data-option-id="o1"]').click()
  await submitRow.getByRole('button', { name: '下一题' }).click()
  assert.equal(await submitButton.isDisabled(), true, 'submit stays disabled while the text answer is empty')
  await submitRow.locator('[data-testid="cw-inbox-answer"]').fill('补充说明')
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

  const multiRow = requestRow(page, ids.questionMulti)
  await multiRow.waitFor()
  const option = (id) => multiRow.locator(`[data-testid="cw-inbox-option"][data-option-id="${id}"]`)
  await option('m1').click()
  await option('m2').click()
  assert.equal(await option('m1').getAttribute('data-selected'), 'true')
  assert.equal(await option('m2').getAttribute('data-selected'), 'true')
  assert.equal(await option('m3').getAttribute('data-selected'), 'false')
  await option('m1').click()
  assert.equal(await option('m1').getAttribute('data-selected'), 'false', 'a multi option toggles off')
  await option('m1').click()
  const multiPromise = waitForPost(page, PATH_INBOX_RESOLVE)
  await multiRow.locator('[data-testid="cw-inbox-action"][data-action="submit"]').click()
  const multiResponse = await multiPromise
  assert.equal((await multiResponse.json()).item.status, 'answered')
  const multiAnswers = multiResponse.request().postDataJSON().answers
  assert.equal(multiAnswers.length, 1)
  assert.deepEqual([...multiAnswers[0].selected].sort(), ['m1', 'm2'])

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

  await ensurePanel(page)
  // The new session may have read the panel before the fixture landed. Force
  // one overview read after seeding and bind it to the selected session id.
  const overview = page.waitForResponse((response) => {
    try {
      const url = new URL(response.url())
      return url.pathname === PATH_OVERVIEW && url.searchParams.get('sessionId') === selectedSessionId
    } catch {
      return false
    }
  })
  await page.getByRole('button', { name: '刷新 Cowork 项目' }).click()
  assert.equal((await overview).status(), 200)
  await waitForOverview(page)
  await page.getByText('第二个浏览器会话', { exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(await page.getByText('浏览器运行主题', { exact: true }).count(), 0)

  const secondaryFilter = page.locator(
    `.cw-card[data-topic-id="${secondary.topic.topicId}"] [data-testid="cw-topic-filter"]`,
  )
  await secondaryFilter.click()
  assert.equal(await secondaryFilter.getAttribute('aria-pressed'), 'true')
  await ensureInboxVisible(page)
  const clear = page.getByTestId('cw-inbox-filter-clear')
  await clear.waitFor({ timeout: 10_000 })
  assert.match(await clear.innerText(), /第二个浏览器会话/)

  // The card's topic is the session already selected, so opening it exercises
  // the real navigation path without leaving the app on a session that the
  // host does not know.
  await ensureTopicList(page)
  await page.locator(`.cw-card[data-topic-id="${secondary.topic.topicId}"] .cw-card-open`).click()
  await page.locator('.cw-receipt[data-kind="ok"]').filter({ hasText: '已切换到主题' }).waitFor({ timeout: 10_000 })

  // The selected session is a topic whose master is a different real session,
  // so the header renders the breadcrumb and it navigates back to the master.
  const breadcrumb = page.getByRole('button', { name: /返回 master/ })
  await breadcrumb.waitFor({ timeout: 10_000 })
  assert.equal(await breadcrumb.isEnabled(), true)
  await breadcrumb.click()
  await waitForOverview(page)
  await ensureTopicList(page)
  await page.getByText('浏览器运行主题', { exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(await page.locator('.cw-breadcrumb').count(), 0, 'the master session has no breadcrumb')
}

/** A failed inbox read paints only the inbox area, and its retry recovers. */
async function scenarioInboxError(page) {
  await ensurePanel(page)
  await ensureInboxVisible(page)
  let failed = false
  await page.route(`**${PATH_INBOX}*`, async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname !== PATH_INBOX || failed) {
      await route.continue()
      return
    }
    failed = true
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'inbox fixture boom' } }),
    })
  })
  await page.getByRole('button', { name: '刷新 Cowork 项目' }).click()
  const error = page.getByTestId('cw-inbox-error')
  await error.waitFor({ timeout: 10_000 })
  assert.match(await error.innerText(), /读取收件箱失败：inbox fixture boom/)
  await error.getByRole('button', { name: '重试' }).click()
  await page.locator('[data-testid="cw-inbox-item"]').first().waitFor({ timeout: 10_000 })
  await error.waitFor({ state: 'detached' })
  await page.unroute(`**${PATH_INBOX}*`)
}

/** A proposal note opens its file through the host, and a failure keeps a receipt. */
async function scenarioNoteOpen(page) {
  await ensurePanel(page)
  await ensureInboxVisible(page)
  const note = page.locator('[data-testid="cw-inbox-item"][data-item-kind="notification"]')
    .filter({ has: page.locator('[data-testid="cw-inbox-note"][data-notice-kind="proposal"]') })
  await note.waitFor({ timeout: 10_000 })
  const open = note.locator('[data-testid="cw-inbox-open"]')

  // The real host route reveals the proposal in the user's OS file browser.
  // That side effect is not client evidence (and pops a Finder window on every
  // run), so the lane stubs the reveal; the route contract is covered by
  // tests/panel/inbox-api.test.mjs.
  let opened = 0
  await page.route(`**${PATH_INBOX_OPEN}`, async (route) => {
    opened += 1
    if (opened === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, opened: true }),
      })
      return
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'open fixture boom' } }),
    })
  })
  const successPromise = waitForPost(page, PATH_INBOX_OPEN)
  await open.click()
  const successResponse = await successPromise
  assert.equal(successResponse.status(), 200)
  assert.equal(typeof successResponse.request().postDataJSON().noticeId, 'string')
  await note.locator('[data-testid="cw-inbox-receipt"][data-kind="ok"]').waitFor({ timeout: 10_000 })

  const failPromise = waitForPost(page, PATH_INBOX_OPEN)
  await open.click()
  assert.equal((await failPromise).status(), 500)
  await note.locator('[data-testid="cw-inbox-receipt"][data-kind="error"]').filter({ hasText: 'open fixture boom' }).waitFor({ timeout: 10_000 })
  await page.unroute(`**${PATH_INBOX_OPEN}`)
}

/** A session with no Cowork project renders the empty surface, not an error. */
async function scenarioEmptyProject(page, fixtures) {
  const row = page.locator(`[data-row-key="workspace:${fixtures.emptyWorkspaceId}"]`)
  await row.hover()
  const create = page.locator('button[aria-label*="empty-repo"][aria-label*="新建会话"]')
  await create.waitFor({ state: 'visible', timeout: 10_000 })
  await Promise.all([
    page.waitForResponse((response) => {
      try {
        return new URL(response.url()).pathname === '/api/session/create'
      } catch {
        return false
      }
    }),
    create.click(),
  ])
  await ensurePanel(page)
  await page.getByRole('button', { name: '刷新 Cowork 项目' }).click()
  const notice = page.locator('.cw-notice[data-notice]').filter({ hasText: /这个仓库还没有 Cowork 项目|这个项目还没有主题/ })
  await notice.waitFor({ timeout: 20_000 })
  assert.equal(await page.locator('.cw-group').count(), 0)
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

/**
 * Run the scenarios that never navigate the page.
 *
 * The browser lane collects coverage in two phases because Chromium's precise
 * coverage only reports live scripts: a reload makes the previous document's
 * execution disappear. Everything here runs before `runReloadScenarios`, and
 * the lane unions both phases.
 */
export async function runBrowserScenarios(page, fixtures) {
  await scenarioTopicGroups(page)
  await scenarioLayoutAndFilter(page)
  await scenarioInboxActions(page)
  await scenarioInboxError(page)
  await scenarioNoteOpen(page)
  await scenarioOverviewRetry(page)
  await scenarioFilterSetup(page)
}

/** The filtered-list persistence reload, then the other workspace sessions. */
export async function runReloadScenarios(page, fixtures) {
  await scenarioFilterRestore(page)
  await scenarioSessionSwitch(page, fixtures)
  await scenarioEmptyProject(page, fixtures)
}
