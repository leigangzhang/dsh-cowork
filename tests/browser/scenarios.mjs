/** User-outcome scenarios for the real DSH browser panel lane. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BROWSER_ARTIFACT, BROWSER_REQUESTS, BROWSER_SPEC, BROWSER_SPEC_PATH, BROWSER_TOPICS } from './fixtures.mjs'

const PATH_RESOLVE = '/api/cowork.topic.resolve'
const PATH_REOPEN = '/api/cowork.topic.reopen'
const PATH_INBOX = '/api/cowork.inbox'
const PATH_INBOX_RESOLVE = '/api/cowork.inbox.resolve'
const PATH_INBOX_OPEN = '/api/cowork.inbox.open'
const PATH_OVERVIEW = '/api/cowork.overview'

/** Thread id created by the chain scenario; resolved cards hide their body. */
let chainThreadId = null

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

/**
 * Click the panel refresh action after the right sidebar settles.
 *
 * A session switch can close the sidebar after `ensurePanel` observed the old
 * panel; reopening and retrying the click follows that transition without a
 * fixed wait.
 */
async function refreshCowork(page) {
  const refresh = page.getByRole('button', { name: '刷新 Cowork 项目' })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ensurePanel(page)
    try {
      await refresh.click({ timeout: 5_000 })
      return
    } catch {
      // The host closed the sidebar while the new session was becoming active.
    }
  }
  throw new Error('the Cowork refresh action did not appear')
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

  // Open the work-item viewer; selecting another session must close it. The
  // viewer owns the main area and closes the panel, so do panel work first.
  await page.locator('[data-testid="cw-tab"][data-tab="work-items"]').click()
  const workCard = page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`)
  await workCard.waitFor({ timeout: 15_000 })
  await workCard.click()
  await page.getByTestId('cwi-viewer').waitFor({ timeout: 15_000 })

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

  // The session switch released the old session's main view, so the viewer
  // must have closed itself instead of showing an idle work-item panel.
  await page.getByTestId('cwi-viewer').waitFor({ state: 'detached', timeout: 15_000 })
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
  await refreshCowork(page)
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
  // A different project has its own index but no work items: the rail shows
  // the empty surface, not the previous project's card.
  await page.locator('[data-testid="cw-tab"][data-tab="work-items"]').click()
  await page.getByTestId('cwi-list-empty').waitFor({ timeout: 15_000 })
  assert.equal(await page.getByTestId('cwi-card').count(), 0)
  await page.locator('[data-testid="cw-tab"][data-tab="topics"]').click()
  await waitForOverview(page)

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
  await refreshCowork(page)
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

/** The two placeholder tabs render their names and return to the topic tab. */
async function scenarioPanelTabs(page) {
  await ensurePanel(page)
  await page.locator('[data-testid="cw-tab"][data-tab="activity"]').click()
  const placeholder = page.getByTestId('cw-tab-placeholder')
  await placeholder.waitFor({ timeout: 10_000 })
  assert.match(await placeholder.innerText(), /活动记录/)
  await page.locator('[data-testid="cw-tab"][data-tab="memory"]').click()
  assert.match(await page.getByTestId('cw-tab-placeholder').innerText(), /项目记忆/)
  await page.locator('[data-testid="cw-tab"][data-tab="topics"]').click()
  await waitForOverview(page)
}

/**
 * Read the CodeMirror document text from its rendered lines.
 *
 * The lane's fixtures are short, so every line is rendered; CodeMirror
 * virtualizes long documents and would only expose the viewport here.
 */
function editorText(page) {
  return page.getByTestId('cwi-editor').evaluate(element =>
    Array.from(element.querySelectorAll('.cm-line')).map(line => line.textContent ?? '').join('\n'))
}

/** Replace the whole editor document through the real browser input path. */
async function fillEditor(page, text) {
  await page.getByTestId('cwi-editor').fill(text)
}

/** Open the work-item tab and return the rail locator. */
async function openWorkItemTab(page) {
  await ensurePanel(page)
  await page.locator('[data-testid="cw-tab"][data-tab="work-items"]').click()
  const list = page.getByTestId('cwi-list')
  await list.waitFor({ timeout: 15_000 })
  return list
}

/** Leave the work-item tab for the topic tab the next scenario expects. */
async function backToTopicTab(page) {
  await ensurePanel(page)
  await page.locator('[data-testid="cw-tab"][data-tab="topics"]').click()
  await waitForOverview(page)
}

/**
 * The read-only work-item chain: rail → main viewer → line selection → anchored
 * comment → thread resolve → reopen. The server persists every row, so the
 * reopen also proves the list and detail do not live only in memory.
 */
async function scenarioWorkItemChain(page) {
  // Delay the first list read so the rail's loading surface is observable
  // rather than a sleep.
  let delayed = false
  await page.route('**/api/cowork.artifact.list*', async (route) => {
    if (!delayed) {
      delayed = true
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    await route.continue()
  })
  await ensurePanel(page)
  await ensureTopicList(page)
  await page.locator('[data-testid="cw-tab"][data-tab="work-items"]').click()
  const loading = page.getByTestId('cwi-list')
  await loading.waitFor({ timeout: 10_000 })
  assert.equal(await loading.getAttribute('data-phase'), 'loading')
  const card = page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`)
  await card.waitFor({ timeout: 15_000 })
  await page.unroute('**/api/cowork.artifact.list*')

  // Filters keep the one seeded item visible and count it.
  const allFilter = page.locator('[data-testid="cwi-filter"][data-filter="all"]')
  assert.match(await allFilter.innerText(), /全部 1/)
  await page.locator('[data-testid="cwi-filter"][data-filter="confirmed"]').click()
  await page.getByTestId('cwi-list').getByText('这个筛选下没有工作项。').waitFor()
  await allFilter.click()
  await card.waitFor()

  await card.click()
  const viewer = page.getByTestId('cwi-viewer')
  await viewer.waitFor({ timeout: 15_000 })
  assert.equal(await page.getByTestId('cwi-title').innerText(), '浏览器交付物')
  assert.match(await page.getByTestId('cwi-status').innerText(), /需反馈/)
  const existing = page.locator('[data-testid="cwi-thread"]').filter({ hasText: '已有的浏览器批注' })
  await existing.waitFor({ timeout: 10_000 })
  assert.equal(await existing.getAttribute('data-resolved'), 'false')

  // A line and a shift-extended range become one anchored comment.
  await page.locator('[data-testid="cwi-line"][data-line="4"]').click()
  await page.locator('[data-testid="cwi-line"][data-line="5"]').click({ modifiers: ['Shift'] })
  await page.getByTestId('cwi-annotate').click()
  const composer = page.getByTestId('cwi-composer')
  await composer.fill('浏览器 lane 的新批注')
  await page.getByTestId('cwi-submit').click()
  const created = page.locator('[data-testid="cwi-thread"]').filter({ hasText: '浏览器 lane 的新批注' })
  await created.waitFor({ timeout: 10_000 })
  assert.equal(await created.getAttribute('data-resolved'), 'false')
  chainThreadId = await created.getAttribute('data-thread-id')

  // Resolve it: the server appends one resolve row and the card folds.
  await created.getByTestId('cwi-thread-toggle').click()
  const resolvedCard = page.locator(`[data-testid="cwi-thread"][data-thread-id="${chainThreadId}"]`)
  await page.waitForFunction((threadId) => {
    const thread = document.querySelector(`[data-testid="cwi-thread"][data-thread-id="${threadId}"]`)
    return thread?.getAttribute('data-resolved') === 'true'
  }, chainThreadId)

  // Back to the conversation, then reopen: the server serves the same thread.
  await page.getByTestId('cwi-back').click()
  const list = await openWorkItemTab(page)
  await list.waitFor()
  await card.click()
  const reopened = page.locator(`[data-testid="cwi-thread"][data-thread-id="${chainThreadId}"]`)
  await reopened.waitFor({ timeout: 10_000 })
  assert.equal(await reopened.getAttribute('data-resolved'), 'true')
  await page.getByTestId('cwi-back').click()
  await backToTopicTab(page)
}

/** Close the viewer and reopen the work-item rail for the next mocked type. */
async function closeViewerAndReopenList(page) {
  await page.getByTestId('cwi-back').click()
  await page.getByTestId('cwi-viewer').waitFor({ state: 'detached' })
  await openWorkItemTab(page)
}

/** Switch the viewer to its numbered source and assert the visible text. */
async function assertSourceText(page, pattern) {
  await page.getByTestId('cwi-mode').click()
  await page.locator('[data-testid="cwi-line"][data-line="1"]').waitFor()
  assert.match(await page.getByTestId('cwi-lines').innerText(), pattern)
}

/** Enter the text editor and leave it without changing the draft. */
async function toggleTextEditing(page) {
  await page.getByTestId('cwi-edit').click()
  await page.getByTestId('cwi-editor').waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-edit').click()
}

/**
 * The stage-4 renderers: one seeded work item is opened three times with a
 * mocked detail/file response, once per new type. The mocks keep the rail's
 * count assertions untouched while exercising the real host routes around the
 * viewer.
 */
/** Wait for the document tab to switch to the requested artifact family. */
async function waitForDocKind(page, kind) {
  await page.locator(`[data-testid="cwi-doc-view"][data-kind="${kind}"]`).waitFor({ timeout: 15_000 })
}

async function scenarioWorkItemTypes(page) {
  await ensurePanel(page)
  await ensureTopicList(page)
  await openWorkItemTab(page)
  const card = page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`)
  await card.waitFor({ timeout: 15_000 })

  const diagramSource = 'flowchart LR\n  A[开始] --> B[结束]\n'
  const htmlSource = '<!doctype html><html><body><h1 id="title">静态标题</h1><script>document.getElementById("title").textContent = "脚本已运行"</script></body></html>'
  const canvasSource = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'cowork-browser-fixture',
    elements: [{
      id: 'rect-browser-1', type: 'rectangle', x: 20, y: 20, width: 140, height: 80,
      angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'hachure',
      strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [],
      frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false,
      boundElements: null, updated: 1, link: null, locked: false,
    }],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  })
  const cases = [
    { type: 'diagram', path: 'docs/browser-diagram.mmd', mediaType: 'text/plain', content: diagramSource, title: '浏览器图表' },
    { type: 'html', path: 'docs/browser-page.html', mediaType: 'text/html', content: htmlSource, title: '浏览器网页' },
    { type: 'canvas', path: 'docs/browser-canvas.excalidraw', mediaType: 'application/json', content: canvasSource, title: '浏览器画布' },
  ]
  let current = cases[0]
  let currentRecord = null

  const patchRecord = (record) => {
    record.type = current.type
    record.title = current.title
    record.primaryPath = current.path
    record.files = [{
      ...record.files[0],
      path: current.path,
      mediaType: current.mediaType,
      editable: true,
      size: Buffer.byteLength(current.content, 'utf8'),
      sha256: '',
    }]
    currentRecord = record
    return record
  }
  await page.route('**/api/cowork.artifact.detail*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.record = patchRecord(body.record)
    await route.fulfill({ response, json: body })
  })
  // Viewing a work item records status through a second response; keep that
  // response on the same mocked type as detail so it cannot overwrite the
  // scenario's artifact family with the real text fixture.
  await page.route('**/api/cowork.artifact.status*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.record = patchRecord(body.record)
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/cowork.artifact.file*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        artifactId: BROWSER_ARTIFACT,
        path: current.path,
        mediaType: current.mediaType,
        content: current.content,
        size: Buffer.byteLength(current.content, 'utf8'),
        sha256: '',
        revision: 1,
        fsVersion: 'fixture-version',
      }),
    })
  })

  let editRevision = 1
  await page.route('**/api/cowork.artifact.edit*', async (route) => {
    const body = route.request().postDataJSON()
    const bytes = Buffer.byteLength(body.content, 'utf8')
    editRevision += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        path: body.path,
        content: body.content,
        revision: editRevision,
        fsVersion: `fixture-edit-${String(editRevision)}`,
        merged: false,
        record: {
          ...currentRecord,
          revision: editRevision,
          updatedAt: new Date().toISOString(),
          files: (currentRecord?.files ?? []).map(file => ({
            ...file,
            revision: editRevision,
            size: bytes,
          })),
        },
      }),
    })
  })

  try {
    // 图表: SVG preview, source lines, and the plain source editor.
    current = cases[0]
    await card.click()
    await page.getByTestId('cwi-viewer').waitFor({ timeout: 15_000 })
    await waitForDocKind(page, 'diagram')
    assert.equal(await page.getByTestId('cwi-doc-view').getAttribute('data-kind'), 'diagram')
    const diagram = page.getByTestId('cwi-diagram')
    await diagram.waitFor({ timeout: 15_000 })
    assert.match(await diagram.evaluate(element => element.textContent ?? ''), /开始/)
    assert.equal(await diagram.locator('svg').count(), 1)
    await assertSourceText(page, /flowchart LR/)
    await toggleTextEditing(page)
    await closeViewerAndReopenList(page)

    // Invalid Mermaid keeps the source reachable and names the failing position.
    current = { type: 'diagram', path: 'docs/browser-broken.mmd', mediaType: 'text/plain', content: 'flowchart LR\n  A -->\n', title: '损坏图表' }
    await card.click()
    await page.getByTestId('cwi-viewer').waitFor({ timeout: 15_000 })
    await page.getByTestId('cwi-diagram-error').waitFor({ timeout: 15_000 })
    assert.match(await page.getByTestId('cwi-diagram-error').innerText(), /图表无法渲染/)
    await page.getByTestId('cwi-mode').click()
    await page.locator('[data-testid="cwi-line"][data-line="1"]').waitFor()
    await page.getByTestId('cwi-back').click()
    await page.getByTestId('cwi-viewer').waitFor({ state: 'detached' })
    await openWorkItemTab(page)

    // HTML: static preview does not run the page script; interactive preview does.
    current = cases[1]
    await card.click()
    await page.getByTestId('cwi-viewer').waitFor({ timeout: 15_000 })
    await waitForDocKind(page, 'html')
    assert.equal(await page.getByTestId('cwi-doc-view').getAttribute('data-kind'), 'html')
    await page.getByTestId('cwi-html-frame').waitFor()
    assert.equal(await page.getByTestId('cwi-html-frame').getAttribute('data-interactive'), 'false')
    const staticFrame = page.frameLocator('[data-testid="cwi-html-frame"]')
    await staticFrame.locator('#title').waitFor({ timeout: 10_000 })
    assert.equal(await staticFrame.locator('#title').innerText(), '静态标题')
    await page.getByTestId('cwi-html-interactive').click()
    assert.equal(await page.getByTestId('cwi-html-frame').getAttribute('data-interactive'), 'true')
    assert.equal(await page.getByTestId('cwi-html-frame').getAttribute('sandbox'), 'allow-scripts')
    const interactiveFrame = page.frameLocator('[data-testid="cwi-html-frame"]')
    await interactiveFrame.locator('#title').filter({ hasText: '脚本已运行' }).waitFor({ timeout: 10_000 })
    await toggleTextEditing(page)
    await closeViewerAndReopenList(page)

    // 画布: Excalidraw mounts read-only, switches to edit, and the JSON source stays readable.
    current = cases[2]
    await card.click()
    await page.getByTestId('cwi-viewer').waitFor({ timeout: 15_000 })
    await waitForDocKind(page, 'canvas')
    assert.equal(await page.getByTestId('cwi-doc-view').getAttribute('data-kind'), 'canvas')
    const canvas = page.getByTestId('cwi-canvas')
    await canvas.waitFor({ timeout: 15_000 })
    assert.equal(await canvas.getAttribute('data-editable'), 'false')
    await canvas.locator('.excalidraw').waitFor({ timeout: 15_000 })
    // Entering edit mode holds the whole file: presence is reported before the
    // user changes any scene content.
    const presence = page.waitForRequest((request) => {
      try {
        return request.method() === 'POST' && new URL(request.url()).pathname === '/api/cowork.artifact.presence'
      } catch {
        return false
      }
    }, { timeout: 10_000 })
    await page.getByTestId('cwi-edit').click()
    assert.equal(await page.getByTestId('cwi-canvas').getAttribute('data-editable'), 'true')
    const presenceBody = (await presence).postDataJSON()
    assert.equal(presenceBody.path, 'docs/browser-canvas.excalidraw')
    assert.equal(presenceBody.ranges?.[0]?.startLine, 1)
    assert.ok(presenceBody.ranges?.[0]?.endLine >= 1)

    // A rectangle drawn by hand serializes and saves; a second save must keep
    // the same Excalidraw instance (and its undo history).
    const canvasBox = await page.getByTestId('cwi-canvas').boundingBox()
    assert.notEqual(canvasBox, null)
    await page.mouse.click(canvasBox.x + 80, canvasBox.y + 80)
    await page.keyboard.press('r')
    await page.mouse.move(canvasBox.x + 120, canvasBox.y + 120)
    await page.mouse.down()
    await page.mouse.move(canvasBox.x + 240, canvasBox.y + 200, { steps: 6 })
    await page.mouse.up()
    await page.getByTestId('cwi-save-state').filter({ hasText: '已保存 · r2' }).waitFor({ timeout: 10_000 })
    await page.locator('.excalidraw').evaluate((element) => { element.dataset.cwiKeep = '1' })
    await page.keyboard.press('r')
    await page.mouse.move(canvasBox.x + 280, canvasBox.y + 120)
    await page.mouse.down()
    await page.mouse.move(canvasBox.x + 380, canvasBox.y + 200, { steps: 6 })
    await page.mouse.up()
    await page.getByTestId('cwi-save-state').filter({ hasText: '已保存 · r3' }).waitFor({ timeout: 10_000 })
    assert.equal(await page.locator('.excalidraw').evaluate((element) => element.dataset.cwiKeep), '1')
    await page.getByTestId('cwi-edit').click()
    await assertSourceText(page, /excalidraw/)
    await closeViewerAndReopenList(page)

    // A broken scene explains itself and falls back to the source editor.
    current = { type: 'canvas', path: 'docs/browser-broken.excalidraw', mediaType: 'application/json', content: '{"type":"excalidraw"}', title: '损坏画布' }
    await card.click()
    await page.getByTestId('cwi-viewer').waitFor({ timeout: 15_000 })
    await page.getByTestId('cwi-canvas-error').waitFor({ timeout: 15_000 })
    assert.match(await page.getByTestId('cwi-canvas-error').innerText(), /elements/)
    await toggleTextEditing(page)
    await page.getByTestId('cwi-back').click()
    await page.getByTestId('cwi-viewer').waitFor({ state: 'detached' })
  } finally {
    await page.unroute('**/api/cowork.artifact.detail*')
    await page.unroute('**/api/cowork.artifact.status*')
    await page.unroute('**/api/cowork.artifact.file*')
    await page.unroute('**/api/cowork.artifact.edit*')
  }
  await backToTopicTab(page)
}

/**
 * The rail consumes the project SSE stream itself: a comment created outside
 * the list changes its count without remounting the tab, and a stopped stream
 * keeps the loaded rows and offers a retry instead of going stale silently.
 */
async function scenarioWorkItemListLive(page, fixtures) {
  await page.route('**/api/cowork.artifact.events*', route => route.abort())
  await openWorkItemTab(page)
  const card = page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`)
  await card.waitFor({ timeout: 15_000 })
  // EventSource retries on its own; three failures stop the rail and leave the
  // last list on screen.
  await page.getByTestId('cwi-list-sse').waitFor({ timeout: 30_000 })
  assert.equal(await card.isVisible(), true)
  await page.unroute('**/api/cowork.artifact.events*')
  await page.getByTestId('cwi-list-sse-retry').click()
  await page.getByTestId('cwi-list-sse').waitFor({ state: 'detached', timeout: 15_000 })

  const countBefore = Number(/(\d+) 条评论/.exec(await card.innerText())?.[1] ?? '0')
  await page.evaluate(async ({ sessionId, artifactId }) => {
    await fetch('/api/cowork.artifact.comment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, artifactId, body: '列表实时评论', dispatch: false }),
    })
  }, { sessionId: fixtures.primarySessionId, artifactId: BROWSER_ARTIFACT })
  await page.waitForFunction(({ artifactId, expected }) => {
    const element = document.querySelector(`[data-testid="cwi-card"][data-artifact-id="${artifactId}"]`)
    return element?.textContent?.includes(`${expected} 条评论`) === true
  }, { artifactId: BROWSER_ARTIFACT, expected: countBefore + 1 }, { timeout: 15_000 })
  await backToTopicTab(page)
}

/**
 * The text save path: edit, autosave, verify the file on disk, then merge a
 * concurrent external change, resolve an overlapping conflict both ways, and
 * prove an unsaved draft is not lost silently when leaving.
 */
async function scenarioWorkItemEdit(page, fixtures) {
  await openWorkItemTab(page)
  const card = page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`)
  await card.waitFor({ timeout: 15_000 })
  await card.click()
  await page.getByTestId('cwi-title').waitFor({ timeout: 15_000 })
  await page.getByTestId('cwi-edit').click()
  const editor = page.getByTestId('cwi-editor')
  await editor.waitFor({ timeout: 10_000 })
  assert.match(await editorText(page), /第一段：逐行批注。/)
  // The source surface is CodeMirror: a line-number gutter, Markdown token
  // spans, and the unresolved comment's line marker all render from the editor.
  await page.getByTestId('cwi-editor-host').locator('.cm-lineNumbers').waitFor({ timeout: 10_000 })
  // CodeMirror keeps a hidden width-measuring gutter element (the widest line
  // number), so assert that a real line-number cell rendered instead of
  // waiting for the first element to be visible.
  const gutterCells = await page.getByTestId('cwi-editor-host')
    .locator('.cm-lineNumbers .cm-gutterElement').allInnerTexts()
  assert.ok(gutterCells.some(text => text.trim() === '1'))
  // Highlighting classes are generated by CodeMirror, so assert that the
  // heading line carries styled spans rather than a plain text node.
  assert.ok(await editor.locator('.cm-line').first().locator('span').count() > 0)
  const anchoredLine = page.getByTestId('cwi-editor-host').locator('.cm-line.cwi-editor-anchored').first()
  await anchoredLine.waitFor({ timeout: 10_000 })
  assert.match(await anchoredLine.innerText(), /第一段：逐行批注。/)
  // The marker follows its text, not the old line number: inserting a line at
  // the top moves the annotated line and the marker with it. Block the save
  // route during this check so no autosave can relocate anchors on the server;
  // the editor's own mapping must keep the marker on its text. Undo restores
  // the exact base so the save steps below keep their expected content.
  await page.route('**/api/cowork.artifact.edit*', route => route.abort())
  await editor.locator('.cm-line').first().click({ position: { x: 2, y: 5 } })
  await page.keyboard.press('Home')
  await page.keyboard.insertText('前插行\n')
  assert.ok((await editorText(page)).startsWith('前插行\n'))
  await page.waitForFunction(() => {
    const line = document.querySelector('[data-testid="cwi-editor-host"] .cm-line.cwi-editor-anchored')
    return line?.textContent?.includes('第一段：逐行批注。') === true
  })
  for (let attempt = 0; attempt < 2 && (await editorText(page)) !== BROWSER_SPEC; attempt += 1) {
    await page.keyboard.press('ControlOrMeta+Z')
  }
  assert.equal(await editorText(page), BROWSER_SPEC)
  await page.unroute('**/api/cowork.artifact.edit*')
  const waitForEdit = () => page.waitForResponse((response) => {
    try {
      return new URL(response.url()).pathname === '/api/cowork.artifact.edit'
        && response.request().method() === 'POST'
    } catch {
      return false
    }
  })

  // 1) Direct save.
  const firstSaved = `${BROWSER_SPEC}\n第四段：浏览器保存。\n`
  const saveResponse = waitForEdit()
  await fillEditor(page, firstSaved)
  assert.equal((await saveResponse).status(), 200)
  await page.getByTestId('cwi-save-state').filter({ hasText: '已保存' }).waitFor({ timeout: 10_000 })
  assert.equal(await readFile(join(fixtures.primary.repoPath, BROWSER_SPEC_PATH), 'utf8'), firstSaved)

  // 2) A non-overlapping concurrent append must auto-merge with the user's
  // edit to a different line. The draft is dirty before the external write so
  // the viewer keeps the draft's base version; a clean refresh arriving first
  // would legitimately rebase the editor and turn the save into a direct write.
  const mergedDraft = firstSaved.replace('# 浏览器交付物', '# 浏览器交付物 (user)')
  const mergeResponse = waitForEdit()
  await fillEditor(page, mergedDraft)
  await writeFile(join(fixtures.primary.repoPath, BROWSER_SPEC_PATH), `${firstSaved}模型合并行。\n`, 'utf8')
  assert.equal((await mergeResponse).status(), 200)
  await page.getByText('已合并模型修改并保存').waitFor({ timeout: 10_000 })
  const mergedSaved = await readFile(join(fixtures.primary.repoPath, BROWSER_SPEC_PATH), 'utf8')
  assert.match(mergedSaved, /\(user\)/)
  assert.match(mergedSaved, /模型合并行。/)
  await page.getByTestId('cwi-save-state').filter({ hasText: '已保存' }).waitFor({ timeout: 10_000 })

  // 3) An overlapping external write becomes a real 409 and "load latest".
  let injected = false
  await page.route('**/api/cowork.artifact.edit*', async (route) => {
    if (!injected) {
      injected = true
      await writeFile(join(fixtures.primary.repoPath, BROWSER_SPEC_PATH), `${mergedSaved}模型并发行。\n`, 'utf8')
    }
    await route.continue()
  })
  const conflictResponse = waitForEdit()
  await fillEditor(page, `${mergedSaved}第五段：我的草稿。\n`)
  assert.equal((await conflictResponse).status(), 409)
  await page.unroute('**/api/cowork.artifact.edit*')
  await page.getByTestId('cwi-conflict').waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-conflict-diff').click()
  await page.getByTestId('cwi-conflict-latest').waitFor({ timeout: 10_000 })
  assert.match(await page.getByTestId('cwi-conflict-latest').innerText(), /模型并发行。/)
  await page.getByTestId('cwi-conflict-load').click()
  await page.getByTestId('cwi-conflict').waitFor({ state: 'detached', timeout: 10_000 })
  assert.match(await editorText(page), /模型并发行。/)
  // Loading the server content replaces the whole document; the anchored
  // marker must be rebuilt from the anchors, not silently dropped by mapping.
  const reloadedMarker = page.getByTestId('cwi-editor-host').locator('.cm-line.cwi-editor-anchored').first()
  await reloadedMarker.waitFor({ timeout: 10_000 })
  assert.match(await reloadedMarker.innerText(), /第一段：逐行批注。/)
  await page.getByTestId('cwi-edit').click()
  await page.getByTestId('cwi-lines').waitFor({ timeout: 10_000 })
  assert.match(await page.getByTestId('cwi-lines').innerText(), /模型并发行。/)

  // 4) A second conflict resolved with "keep mine" overwrites with the draft.
  await page.getByTestId('cwi-edit').click()
  const latest = await editorText(page)
  let injectedAgain = false
  await page.route('**/api/cowork.artifact.edit*', async (route) => {
    if (!injectedAgain) {
      injectedAgain = true
      await writeFile(join(fixtures.primary.repoPath, BROWSER_SPEC_PATH), `${latest}模型第二次并发行。\n`, 'utf8')
    }
    await route.continue()
  })
  const keepConflict = waitForEdit()
  const keepDraft = `${latest}我的保留行。\n`
  await fillEditor(page, keepDraft)
  assert.equal((await keepConflict).status(), 409)
  await page.unroute('**/api/cowork.artifact.edit*')
  await page.getByTestId('cwi-conflict').waitFor({ timeout: 10_000 })
  const keepResponse = waitForEdit()
  await page.getByTestId('cwi-conflict-keep').click()
  assert.equal((await keepResponse).status(), 200)
  await page.getByTestId('cwi-conflict').waitFor({ state: 'detached', timeout: 10_000 })
  const kept = await readFile(join(fixtures.primary.repoPath, BROWSER_SPEC_PATH), 'utf8')
  assert.match(kept, /我的保留行。/)

  // 5) A failed save keeps the draft when editing is reopened, and leaving
  // with that unsaved draft needs a second back click.
  await page.route('**/api/cowork.artifact.edit*', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'fixture edit boom' } }),
    })
  })
  const failedDraft = `${kept}失败后仍需保留的草稿`
  await fillEditor(page, failedDraft)
  await page.getByText(/保存失败/).first().waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-edit').click()
  await page.getByTestId('cwi-edit').click()
  await editor.waitFor({ timeout: 10_000 })
  assert.match(await editorText(page), /失败后仍需保留的草稿/)
  // Let the retained draft save so later scenarios open this work item read-only.
  await page.unroute('**/api/cowork.artifact.edit*')
  const recoveredSave = waitForEdit()
  assert.equal((await recoveredSave).status(), 200)
  await page.getByTestId('cwi-save-state').filter({ hasText: '已保存' }).waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-back').click()
  await page.getByTestId('cwi-viewer').waitFor({ state: 'detached', timeout: 10_000 })
  await backToTopicTab(page)
}

/**
 * Draft safety and viewer controls: a failed save survives a close/reopen,
 * then the toolbar tabs, mode toggle, rail toggle, pins, and thread focus work.
 */
async function scenarioWorkItemDraft(page) {
  await openWorkItemTab(page)
  const card = page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`)
  await card.waitFor({ timeout: 15_000 })
  let injectFailedDispatch = true
  await page.route('**/api/cowork.artifact.detail*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    if (!injectFailedDispatch) {
      await route.fulfill({ response })
      return
    }
    body.dispatches = [...(body.dispatches ?? []), {
      dispatchId: 'dispatch-browser-failed',
      state: 'failed',
      commentIds: [chainThreadId],
      errorCode: 'artifact/dispatch-unavailable',
      updatedAt: '2099-01-01T00:00:00.000Z',
    }]
    await route.fulfill({ status: response.status(), contentType: 'application/json', body: JSON.stringify(body) })
  })
  let retryCalls = 0
  await page.route('**/api/cowork.artifact.dispatch.retry*', async (route) => {
    retryCalls += 1
    if (retryCalls === 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'retry fixture boom' } }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        dispatch: {
          version: 1, dispatchId: 'dispatch-browser-retry', artifactId: BROWSER_ARTIFACT,
          sessionId: 'session-browser-running', commentIds: [chainThreadId], state: 'queued',
          attempts: 0, promptRequestId: 'prompt-browser-retry', errorCode: null,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
        },
        record: {},
      }),
    })
  })
  await card.click()
  await page.getByTestId('cwi-title').waitFor({ timeout: 15_000 })
  await page.getByTestId('cwi-edit').click()
  const editor = page.getByTestId('cwi-editor')
  await editor.waitFor({ timeout: 10_000 })

  await page.route('**/api/cowork.artifact.edit*', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'draft save boom' } }),
    })
  })
  await fillEditor(page, `${await editorText(page)}未保存草稿恢复验证\n`)
  await page.getByText(/保存失败/).first().waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-back').click()
  await page.getByText('还有未保存内容').waitFor({ timeout: 5_000 })
  await page.getByTestId('cwi-back').click()
  await page.getByTestId('cwi-viewer').waitFor({ state: 'detached', timeout: 10_000 })
  await page.unroute('**/api/cowork.artifact.edit*')

  await openWorkItemTab(page)
  await card.click()
  await page.getByTestId('cwi-title').waitFor({ timeout: 15_000 })
  await page.getByTestId('cwi-editor').waitFor({ timeout: 10_000 })
  assert.match(await editorText(page), /未保存草稿恢复验证/)
  const saveResponse = page.waitForResponse((response) => {
    try {
      return new URL(response.url()).pathname === '/api/cowork.artifact.edit'
        && response.request().method() === 'POST'
    } catch {
      return false
    }
  })
  assert.equal((await saveResponse).status(), 200)
  await page.getByTestId('cwi-save-state').filter({ hasText: '已保存' }).waitFor({ timeout: 15_000 })
  await page.getByTestId('cwi-edit').click()

  await page.getByTestId('cwi-view-tab').filter({ hasText: '版本' }).click()
  await page.getByTestId('cwi-versions').waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-view-tab').filter({ hasText: '附件' }).click()
  await page.getByTestId('cwi-attachments').waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-view-tab').filter({ hasText: '文档' }).click()
  await page.getByTestId('cwi-lines').waitFor({ timeout: 10_000 })

  const mode = page.getByTestId('cwi-mode')
  const before = await mode.getAttribute('data-mode')
  await mode.click()
  assert.notEqual(await mode.getAttribute('data-mode'), before)

  await page.getByTestId('cwi-rail-toggle').click()
  assert.equal(await page.getByTestId('cwi-rail').isVisible(), false)
  await page.getByTestId('cwi-rail-toggle').click()
  await page.getByTestId('cwi-rail').waitFor({ timeout: 10_000 })

  await page.getByTestId('cwi-line-pin').first().waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-thread-focus').first().click()
  await page.getByTestId('cwi-lines').waitFor({ timeout: 10_000 })

  // A failed batch exposes retry; the mocked route proves both the failure
  // receipt and the optimistic success path without enqueueing a real model
  // turn.
  await page.getByTestId('cwi-dispatch-retry').first().click()
  await page.getByText(/重试失败/).first().waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-dispatch-retry').first().click()
  await page.getByText('已重新投递').waitFor({ timeout: 10_000 })

  // Confirmation carries both failure and success receipts; the real record is
  // left unchanged so later scenarios still see the same status.
  await page.route('**/api/cowork.artifact.status*', async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'status boom' } }) })
  })
  await page.getByTestId('cwi-confirm').click()
  await page.getByText(/确认失败/).waitFor({ timeout: 10_000 })
  await page.unroute('**/api/cowork.artifact.status*')
  await page.route('**/api/cowork.artifact.status*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, record: {} }) })
  })
  await page.getByTestId('cwi-confirm').click()
  await page.getByText('已确认完成').waitFor({ timeout: 10_000 })
  await page.unroute('**/api/cowork.artifact.status*')
  injectFailedDispatch = false
  await page.unroute('**/api/cowork.artifact.detail*')
  await page.unroute('**/api/cowork.artifact.dispatch.retry*')

  await page.getByTestId('cwi-back').click()
  await backToTopicTab(page)
}

/** The attachment tab lists uploaded image/text metadata and download links. */
async function scenarioWorkItemAttachments(page) {
  await openWorkItemTab(page)
  const card = page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`)
  await card.waitFor({ timeout: 15_000 })
  await card.click()
  await page.getByTestId('cwi-title').waitFor({ timeout: 15_000 })
  await page.getByTestId('cwi-view-tab').filter({ hasText: '附件' }).click()
  await page.getByTestId('cwi-attachments').waitFor({ timeout: 10_000 })
  const rows = page.getByTestId('cwi-attachment-row')
  assert.ok(await rows.count() >= 2, 'image and text attachments are listed')
  assert.match(await page.getByTestId('cwi-attachments').innerText(), /shot\.png/)
  await page.getByTestId('cwi-back').click()
  await backToTopicTab(page)
}

/**
 * Interaction edges the happy paths cannot reach: a thread reply, a failed
 * upload with its removable pending chip, a failed file read notice, a failed
 * "load latest" after a real conflict, and the stream interruption notice.
 */
async function scenarioWorkItemEdges(page, fixtures) {
  await openWorkItemTab(page)
  const card = page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`)
  await card.waitFor({ timeout: 15_000 })

  // Three consecutive stream failures stop the viewer and offer a retry; the
  // retry reconnects once the route no longer refuses the stream.
  await page.route('**/api/cowork.artifact.events*', (route) => route.abort())
  await card.click()
  await page.getByTestId('cwi-title').waitFor({ timeout: 15_000 })
  const sseNotice = page.getByTestId('cwi-sse-notice')
  await sseNotice.waitFor({ timeout: 25_000 })
  assert.match(await sseNotice.innerText(), /实时更新中断/)
  await page.unroute('**/api/cowork.artifact.events*')
  await page.getByTestId('cwi-sse-retry').click()
  await sseNotice.waitFor({ state: 'detached', timeout: 10_000 })

  // Reply inside a thread: cancel first, then commit a real reply.
  const textThread = page.locator('[data-testid="cwi-thread"]').filter({ hasText: '这张文本附件说明问题' }).first()
  await textThread.waitFor({ timeout: 15_000 })
  const replyTarget = page.getByTestId('cwi-reply-target')
  await textThread.getByTestId('cwi-thread-reply').click()
  await replyTarget.waitFor({ timeout: 10_000 })
  assert.match(await replyTarget.innerText(), /回复/)
  await replyTarget.getByRole('button', { name: '取消回复' }).click()
  await replyTarget.waitFor({ state: 'detached', timeout: 10_000 })
  await textThread.getByTestId('cwi-thread-reply').click()
  await replyTarget.waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-composer').fill('浏览器线程回复')
  await page.getByTestId('cwi-submit').click()
  await replyTarget.waitFor({ state: 'detached', timeout: 10_000 })
  await page.locator('[data-testid="cwi-thread"]').filter({ hasText: '浏览器线程回复' }).first().waitFor({ timeout: 15_000 })

  // A refused upload surfaces its receipt and leaves no pending chip.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  await page.route('**/api/cowork.artifact.upload*', (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'upload fixture boom' } }),
  }))
  await page.getByTestId('cwi-file-input').setInputFiles({ name: 'boom.png', mimeType: 'image/png', buffer: png })
  await page.getByText(/附件上传失败/).first().waitFor({ timeout: 10_000 })
  await page.unroute('**/api/cowork.artifact.upload*')

  // A successful pick can be removed again before it is submitted.
  await page.getByTestId('cwi-file-input').setInputFiles({ name: 'remove-me.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
  const pending = page.getByTestId('cwi-pending-attachments')
  await pending.waitFor({ timeout: 15_000 })
  await page.getByRole('button', { name: '移除附件 remove-me.txt' }).click()
  await pending.waitFor({ state: 'detached', timeout: 10_000 })

  // A text attachment renders as a named download link.
  const link = textThread.getByTestId('cwi-attachment-link').first()
  await link.waitFor({ timeout: 10_000 })
  assert.equal(await link.getAttribute('download'), 'note.md')
  assert.match(await link.getAttribute('href') ?? '', /\/api\/cowork\.artifact\.attachment\?/)

  // A real overlapping save conflict, then a failed "load latest" keeps the
  // conflict card and reports the failure instead of dropping the draft.
  await page.getByTestId('cwi-edit').click()
  const editor = page.getByTestId('cwi-editor')
  await editor.waitFor({ timeout: 10_000 })
  const current = await editorText(page)
  let injected = false
  await page.route('**/api/cowork.artifact.edit*', async (route) => {
    if (!injected) {
      injected = true
      await writeFile(join(fixtures.primary.repoPath, BROWSER_SPEC_PATH), `${current}外部冲突行。\n`, 'utf8')
    }
    await route.continue()
  })
  await fillEditor(page, `${current}我的冲突草稿。\n`)
  await page.getByTestId('cwi-conflict').waitFor({ timeout: 15_000 })
  await page.unroute('**/api/cowork.artifact.edit*')
  await page.route('**/api/cowork.artifact.file*', (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'file fixture boom' } }),
  }))
  await page.getByTestId('cwi-conflict-load').click()
  await page.getByText(/加载失败/).first().waitFor({ timeout: 10_000 })
  await page.unroute('**/api/cowork.artifact.file*')
  await page.getByTestId('cwi-conflict-keep').click()
  await page.getByTestId('cwi-conflict').waitFor({ state: 'detached', timeout: 15_000 })
  await page.getByTestId('cwi-edit').click()
  await page.getByTestId('cwi-lines').waitFor({ timeout: 10_000 })

  // A failed file read still opens the viewer and names the missing file.
  await page.getByTestId('cwi-back').click()
  await page.getByTestId('cwi-viewer').waitFor({ state: 'detached', timeout: 10_000 })
  await page.route('**/api/cowork.artifact.file*', (route) => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'file fixture boom' } }),
  }))
  // Closing the viewer leaves the right panel on the topic tab; re-open the
  // work-item rail before clicking the row again.
  await openWorkItemTab(page)
  await card.click()
  await page.getByTestId('cwi-file-notice').waitFor({ timeout: 15_000 })
  await page.unroute('**/api/cowork.artifact.file*')
  await page.getByTestId('cwi-back').click()
  await page.getByTestId('cwi-viewer').waitFor({ state: 'detached', timeout: 10_000 })
  await backToTopicTab(page)
}

/**
 * Live updates and attachments: a comment created from the page context appears
 * through the project SSE stream without a reload, and an uploaded PNG renders
 * as a thumbnail in its thread.
 */
async function scenarioWorkItemLive(page, fixtures) {
  await openWorkItemTab(page)
  const card = page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`)
  await card.waitFor({ timeout: 15_000 })
  await card.click()
  await page.getByTestId('cwi-title').waitFor({ timeout: 15_000 })

  // A model edit arrives through the file.changed SSE event; the read-only
  // viewer must reload the content instead of keeping stale lines.
  const refreshed = await page.evaluate(async ({ sessionId, artifactId, path }) => {
    const query = `sessionId=${encodeURIComponent(sessionId)}&artifactId=${encodeURIComponent(artifactId)}&path=${encodeURIComponent(path)}`
    const file = await (await fetch(`/api/cowork.artifact.file?${query}`)).json()
    return (await fetch('/api/cowork.artifact.edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        artifactId,
        path,
        baseRevision: file.revision,
        baseVersion: file.fsVersion,
        content: `${file.content}模型刷新行\n`,
      }),
    })).json()
  }, { sessionId: fixtures.primarySessionId, artifactId: BROWSER_ARTIFACT, path: BROWSER_SPEC_PATH })
  assert.equal(refreshed.ok, true)
  await page.getByTestId('cwi-lines').filter({ hasText: '模型刷新行' }).waitFor({ timeout: 15_000 })

  // Create the comment in the page's own origin, so EventSource and fetch share
  // the browser cookie and the stream is the only reason the rail updates.
  await page.evaluate(async ({ sessionId, artifactId }) => {
    await fetch('/api/cowork.artifact.comment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, artifactId, body: '来自 SSE 的评论' }),
    })
  }, { sessionId: fixtures.primarySessionId, artifactId: BROWSER_ARTIFACT })
  await page.locator('[data-testid="cwi-thread"]').filter({ hasText: '来自 SSE 的评论' })
    .waitFor({ timeout: 15_000 })
  await page.getByTestId('cwi-activity').waitFor({ timeout: 10_000 })

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await page.getByTestId('cwi-file-input').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png })
  await page.getByTestId('cwi-pending-attachments').waitFor({ timeout: 15_000 })
  await page.getByTestId('cwi-composer').fill('这张截图说明问题')
  await page.getByTestId('cwi-submit').click()
  const attached = page.locator('[data-testid="cwi-thread"]').filter({ hasText: '这张截图说明问题' })
  await attached.waitFor({ timeout: 15_000 })
  const thumb = attached.getByTestId('cwi-attachment-thumb')
  await thumb.waitFor({ timeout: 15_000 })
  assert.match(await thumb.getAttribute('src'), /\/api\/cowork\.artifact\.attachment\?/)

  // A text attachment renders as a download link, not a thumbnail.
  await page.getByTestId('cwi-file-input').setInputFiles({
    name: 'note.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# note\n'),
  })
  await page.getByTestId('cwi-pending-attachments').waitFor({ timeout: 15_000 })
  await page.getByTestId('cwi-composer').fill('这张文本附件说明问题')
  await page.getByTestId('cwi-submit').click()
  const linked = page.locator('[data-testid="cwi-thread"]').filter({ hasText: '这张文本附件说明问题' })
  await linked.waitFor({ timeout: 15_000 })
  const link = linked.getByTestId('cwi-attachment-link')
  await link.waitFor({ timeout: 15_000 })
  assert.match(await link.innerText(), /note\.md/)
  await page.getByTestId('cwi-back').click()
  await backToTopicTab(page)
}

/** A failed detail read paints the viewer error; retry recovers to the record. */
async function scenarioWorkItemError(page) {
  // The rail reports a failed read and its retry recovers the list.
  let listFailed = false
  await page.route('**/api/cowork.artifact.list*', async (route) => {
    if (listFailed) {
      await route.continue()
      return
    }
    listFailed = true
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'list fixture boom' } }),
    })
  })
  await openWorkItemTab(page)
  await page.getByTestId('cwi-list-error').waitFor({ timeout: 15_000 })
  await page.getByTestId('cwi-list-error').getByRole('button', { name: '重试' }).click()
  await page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`).waitFor({ timeout: 15_000 })
  await page.unroute('**/api/cowork.artifact.list*')

  let failed = false
  await page.route('**/api/cowork.artifact.detail*', async (route) => {
    if (failed) {
      await route.continue()
      return
    }
    failed = true
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'detail fixture boom' } }),
    })
  })
  const card = page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`)
  await card.click()
  await page.getByTestId('cwi-viewer-error').waitFor({ timeout: 15_000 })
  await page.getByTestId('cwi-viewer').getByRole('button', { name: '重试' }).click()
  await page.getByTestId('cwi-title').waitFor({ timeout: 15_000 })
  await page.unroute('**/api/cowork.artifact.detail*')
  await page.getByTestId('cwi-back').click()
  await backToTopicTab(page)
}

/**
 * After the single reload: the work item, its comment, and its resolved flag
 * all come back from the host, not from browser memory.
 */
async function scenarioWorkItemRestore(page) {
  const list = await openWorkItemTab(page)
  const card = page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`)
  await card.waitFor({ timeout: 15_000 })
  // Read the rail before opening the viewer: selecting the main panel may
  // unmount the session-scoped tab body.
  assert.match(await list.innerText(), /浏览器交付物/)
  await card.click()
  const thread = page.locator(`[data-testid="cwi-thread"][data-thread-id="${chainThreadId}"]`)
  await thread.waitFor({ timeout: 10_000 })
  assert.equal(await thread.getAttribute('data-resolved'), 'true')
  await page.getByTestId('cwi-back').click()
  await backToTopicTab(page)
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
  await refreshCowork(page)
  const notice = page.locator('.cw-notice[data-notice]').filter({ hasText: /这个仓库还没有 Cowork 项目|这个项目还没有主题/ })
  await notice.waitFor({ timeout: 20_000 })
  assert.equal(await page.locator('.cw-group').count(), 0)
  // The work-item tab has no project to read: it reports the failure and a
  // retry instead of showing an empty list that pretends there are no items.
  await page.locator('[data-testid="cw-tab"][data-tab="work-items"]').click()
  await page.getByTestId('cwi-list-error').waitFor({ timeout: 15_000 })
  await page.locator('[data-testid="cw-tab"][data-tab="topics"]').click()
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
  await refreshCowork(page)
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
  await scenarioPanelTabs(page)
  await scenarioWorkItemChain(page)
  await scenarioWorkItemTypes(page)
  await scenarioWorkItemListLive(page, fixtures)
  await scenarioWorkItemEdit(page, fixtures)
  await scenarioWorkItemDraft(page)
  await scenarioWorkItemLive(page, fixtures)
  await scenarioWorkItemAttachments(page)
  await scenarioWorkItemEdges(page, fixtures)
  await scenarioWorkItemError(page)
  await scenarioFilterSetup(page)
}

/** The filtered-list persistence reload, then the other workspace sessions. */
export async function runReloadScenarios(page, fixtures) {
  await scenarioFilterRestore(page)
  await scenarioWorkItemRestore(page)
  await scenarioSessionSwitch(page, fixtures)
  await scenarioEmptyProject(page, fixtures)
}
