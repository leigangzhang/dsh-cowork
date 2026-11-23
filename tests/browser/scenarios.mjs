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

  // Open a work item first: the plugin tab is registered globally, and the
  // switch below proves it survives without leaking into the new Session.
  await page.locator('[data-testid="cw-tab"][data-tab="work-items"]').click()
  const workCard = page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`)
  await workCard.waitFor({ timeout: 15_000 })
  await workCard.click()
  await page.getByTestId('cwi-viewer').waitFor({ timeout: 15_000 })

  const selectedSessionId = await createSessionIn(page, fixtures.secondaryWorkspaceId, 'secondary-repo')
  const secondary = await fixtures.prepareSecondarySession(selectedSessionId)

  // The new Session is blank, so the host renders no conversation view at all:
  // the viewer is not on screen, but the open context survives for the return
  // below (the design keeps one open work item per browser tab).
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

/**
 * Start one deterministic conversation in the selected Session.
 *
 * A Session is blank until its first prompt, and the host renders no
 * conversation view (and no view tabs) for a blank Session. The work-item tab
 * therefore needs a started conversation, exactly like a real user switching
 * away from the hero composer. The scripted provider echoes the prompt, so the
 * wait names the turn that completed instead of sleeping.
 */
export async function engageSession(page, message) {
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await input.waitFor({ timeout: 30_000 })
  await input.click()
  await page.keyboard.type(message)
  await page.keyboard.press('Enter')
  await page.getByText(`收到：${message}`, { exact: false }).first().waitFor({ timeout: 60_000 })
}

/** Wait for a Session creation triggered by `button` and return its host id. */
async function createSessionVia(page, button) {
  const [created] = await Promise.all([
    page.waitForResponse((response) => {
      try {
        return new URL(response.url()).pathname === '/api/session/create'
      } catch {
        return false
      }
    }),
    button.click(),
  ])
  return (await created.json()).result.value.sessionId
}

/** Create a Session in one workspace through the real sidebar action. */
async function createSessionIn(page, workspaceId, repoLabel) {
  await page.locator(`[data-row-key="workspace:${workspaceId}"]`).hover()
  const create = page.locator(`button[aria-label*="${repoLabel}"][aria-label*="新建会话"]`)
  await create.waitFor({ state: 'visible', timeout: 10_000 })
  return createSessionVia(page, create)
}

/** The seeded artifact card in the work-item rail. */
async function artifactCard(page) {
  const card = page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`)
  await card.waitFor({ timeout: 15_000 })
  return card
}

/** Open the seeded artifact and wait for the viewer title. */
async function openArtifactViewer(page) {
  const card = await artifactCard(page)
  await card.click()
  await page.getByTestId('cwi-title').waitFor({ timeout: 15_000 })
  return card
}

/** Open the collapsed comment rail through its toolbar toggle. */
async function openRail(page) {
  const rail = page.getByTestId('cwi-rail')
  if (await rail.isVisible().catch(() => false)) return rail
  await page.getByTestId('cwi-rail-toggle').click()
  await rail.waitFor({ timeout: 10_000 })
  return rail
}

/** The host tab strip buttons in the conversation header. */
function viewTabs(page) {
  return page.locator('[data-conversation-tabs] button[role="tab"]')
}

/** The host composer seat inside the conversation scroll body. */
function composerSeat(page) {
  return page.locator('[data-conversation-scroll] > [data-composer-seat]')
}

/** The Cowork tab button in the host tab strip. */
function coworkTab(page) {
  return viewTabs(page).filter({ hasText: 'Cowork' })
}

/** The host's Chat tab; its label follows the host locale. */
function chatTab(page) {
  return viewTabs(page).filter({ hasText: /对话|Chat/ }).first()
}

/**
 * The work-item view tab integration: opening registers the tab, the viewer
 * occupies the conversation area, and closing removes the tab again.
 *
 * The host renders view tabs only for a started conversation, so this scenario
 * relies on the lane's initial engagement turn. The composer assertion is the
 * regression net for the host's DOM hooks changing underneath the CSS rule.
 */
async function scenarioWorkItemViewTab(page) {
  const list = await openWorkItemTab(page)
  const card = await artifactCard(page)

  // The rail starts with the document-only layout; the tab appears only now.
  assert.equal(await page.getByTestId('cwi-rail').isHidden(), true, 'the rail starts collapsed')
  assert.equal(await coworkTab(page).count(), 0, 'no Cowork tab before a work item is open')

  await card.click()
  const viewer = page.getByTestId('cwi-viewer')
  await viewer.waitFor({ timeout: 15_000 })
  await page.getByTestId('cwi-title').waitFor({ timeout: 15_000 })

  // T1: the host tab strip gains the Cowork tab and selects it. Other host
  // views (trajectory here, context/fleet on a user host) stay untouched.
  const tabs = viewTabs(page)
  await tabs.first().waitFor({ timeout: 10_000 })
  assert.ok(await tabs.count() >= 2)
  assert.equal(await page.locator('[data-conversation-tabs] [aria-selected="true"]').count(), 1)
  const cowork = coworkTab(page)
  assert.equal((await cowork.innerText()).trim(), 'Cowork')
  assert.equal(await cowork.getAttribute('aria-selected'), 'true')
  assert.equal(await chatTab(page).getAttribute('aria-selected'), 'false')

  // T13: the viewer draws no second breadcrumb line.
  assert.equal(await page.getByTestId('cwi-crumbs').count(), 0)

  // T10: the conversation composer is hidden while the Cowork view is active
  // and the footer stays visible at the viewer's bottom edge.
  assert.equal(await composerSeat(page).evaluate(element => getComputedStyle(element).display), 'none')
  assert.equal(await page.getByTestId('cwi-viewer-footer').isVisible(), true)

  // T14: the rail is collapsed and the toolbar toggle expands it.
  const toggle = page.getByTestId('cwi-rail-toggle')
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(await page.getByTestId('cwi-rail').isHidden(), true)
  await openRail(page)
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
  await toggle.click()
  assert.equal(await page.getByTestId('cwi-rail').isHidden(), true)

  // Chat is reachable without closing the work item; the composer returns and
  // switching back keeps the same open document.
  await chatTab(page).click()
  await viewer.waitFor({ state: 'detached', timeout: 10_000 })
  assert.notEqual(await composerSeat(page).evaluate(element => getComputedStyle(element).display), 'none')
  assert.equal(await page.getByTestId('cwi-rail').count(), 0)
  await coworkTab(page).click()
  await viewer.waitFor({ timeout: 10_000 })
  assert.equal(await page.getByTestId('cwi-title').innerText(), '浏览器交付物')
  // A remount returns to the default projection: the rail is collapsed again.
  assert.equal(await page.getByTestId('cwi-rail').isHidden(), true)
  assert.equal(await page.getByTestId('cwi-rail-toggle').getAttribute('aria-expanded'), 'false')

  // T2: closing disposes the registration; the plugin tab disappears and the
  // composer is usable again.
  await page.getByTestId('cwi-back').click()
  await viewer.waitFor({ state: 'detached', timeout: 10_000 })
  assert.equal(await coworkTab(page).count(), 0)
  // Other host views keep the strip: it falls back to Chat instead of vanishing.
  assert.equal(await chatTab(page).getAttribute('aria-selected'), 'true')
  assert.notEqual(await composerSeat(page).evaluate(element => getComputedStyle(element).display), 'none')
  await list.waitFor()
  await backToTopicTab(page)
}

/**
 * A work item opened from another Session stays a read-only preview, and
 * "open in the owning session" is the only way to switch.
 *
 * The second Session lives in the same project, so the rail lists the same
 * work item while its owner is the first Session.
 */
async function scenarioWorkItemCrossSession(page, fixtures) {
  const otherSessionId = await createSessionIn(page, fixtures.primaryWorkspaceId, 'primary-repo')
  assert.notEqual(otherSessionId, fixtures.primarySessionId)
  await engageSession(page, '跨会话第二会话')

  await ensurePanel(page)
  await page.locator('[data-testid="cw-tab"][data-tab="work-items"]').click()
  await openArtifactViewer(page)

  // T5: no editor, confirm, reply, resolve, or comment submission is offered.
  const banner = page.getByTestId('cwi-cross-banner')
  await banner.waitFor({ timeout: 10_000 })
  assert.match(await banner.innerText(), /当前会话不是该工作项所属会话/)
  assert.match(await banner.innerText(), /在所属会话打开/)
  assert.equal(await page.getByTestId('cwi-edit').isDisabled(), true)
  assert.equal(await page.getByTestId('cwi-confirm').isDisabled(), true)
  await openRail(page)
  assert.equal(await page.getByTestId('cwi-thread-reply').first().isDisabled(), true)
  assert.equal(await page.getByTestId('cwi-thread-toggle').first().isDisabled(), true)
  assert.equal(await page.getByTestId('cwi-composer').isDisabled(), true)
  assert.equal(await page.getByTestId('cwi-submit').isDisabled(), true)
  await selectReadingText(page, '第二段')
  assert.equal(await page.getByTestId('cwi-annotate').isDisabled(), true)
  await page.keyboard.press('Escape')
  await page.getByTestId('cwi-md-selection').waitFor({ state: 'detached', timeout: 5_000 })

  // T8: the cross-session preview reads the same artifact through its owner
  // session, and "open in the owning session" switches without a reload.
  await page.getByTestId('cwi-cross-open').click()
  await page.locator(`[data-conversation-session="${fixtures.primarySessionId}"]`).waitFor({ timeout: 20_000 })
  await banner.waitFor({ state: 'detached', timeout: 20_000 })
  assert.equal(await page.getByTestId('cwi-edit').isEnabled(), true)
  assert.equal(await page.getByTestId('cwi-cross-error').count(), 0)

  await page.getByTestId('cwi-back').click()
  await page.getByTestId('cwi-viewer').waitFor({ state: 'detached', timeout: 10_000 })
  await backToTopicTab(page)
}

/**
 * Opening a work item from a blank Session fails visibly in the rail.
 *
 * The host renders no conversation view for a blank Session (no tab strip, no
 * view area), so the tab activation cannot succeed. The rail must say so and
 * offer a retry instead of silently staying on Chat; the item stays open and
 * appears as soon as a started Session is selected.
 */
async function scenarioWorkItemTabFailure(page, fixtures) {
  const blankSessionId = await createSessionIn(page, fixtures.primaryWorkspaceId, 'primary-repo')
  assert.notEqual(blankSessionId, fixtures.primarySessionId)

  await ensurePanel(page)
  await page.locator('[data-testid="cw-tab"][data-tab="work-items"]').click()
  const card = await artifactCard(page)
  await card.click()
  const failure = page.getByTestId('cwi-list-switch-error')
  await failure.waitFor({ timeout: 20_000 })
  assert.match(await failure.innerText(), /没有找到「Cowork」会话标签/)
  assert.equal(await page.getByTestId('cwi-viewer').count(), 0)

  // The retry re-attempts the bounded activation and reports the same reason.
  await page.getByTestId('cwi-list-switch-retry').click()
  await failure.waitFor({ timeout: 20_000 })
  assert.match(await failure.innerText(), /没有找到「Cowork」会话标签/)

  // Returning to a started Session completes the open; closing clears it.
  await page.locator(`[data-row-key="session:${fixtures.primarySessionId}"]`).click()
  const ownerTab = coworkTab(page)
  await ownerTab.waitFor({ timeout: 20_000 })
  if (await ownerTab.getAttribute('aria-selected') !== 'true') await ownerTab.click()
  await page.getByTestId('cwi-viewer').waitFor({ timeout: 20_000 })
  await page.getByTestId('cwi-back').click()
  await page.getByTestId('cwi-viewer').waitFor({ state: 'detached', timeout: 10_000 })
  await backToTopicTab(page)
}

/** The owner session id a work item can name without the host knowing it. */
const GHOST_OWNER = 'session-browser-missing'

/**
 * A work item whose owner session is gone still opens as a read-only preview,
 * and "open in the owning session" fails visibly instead of pretending.
 *
 * The list and the owner-scoped reads are proxied to the real fixture so the
 * viewer has content; only the owner identity is impossible to navigate to.
 */
async function scenarioWorkItemOwnerFailure(page, fixtures) {
  const ghost = 'artifact-browser-ownerless'
  await ensurePanel(page)
  await page.locator('[data-testid="cw-tab"][data-tab="work-items"]').click()
  await page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`).waitFor({ timeout: 15_000 })

  // Append one listed item whose owner the host does not know.
  await page.route('**/api/cowork.artifact.list*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.items = [...body.items, {
      ...body.items[0],
      artifactId: ghost,
      title: '所属会话已不可用',
      ownerSessionId: GHOST_OWNER,
    }]
    // A list request can be superseded by a newer read; only the latest one is
    // the catalog this scenario intends to see.
    await route.fulfill({ response, json: body }).catch(() => {})
  })
  /**
   * Continue a request that is not for the ghost artifact.
   *
   * @returns true when the route was continued by this helper.
   */
  const continueUnlessGhost = async (route) => {
    if (new URL(route.request().url()).searchParams.get('artifactId') !== ghost) {
      await route.continue().catch(() => {})
      return true
    }
    return false
  }
  /** Re-label a proxied fixture response as the ghost work item. */
  const ghostBody = (body) => {
    if (body === null) return null
    if (body.record !== undefined) body.record = { ...body.record, artifactId: ghost, title: '所属会话已不可用' }
    if (body.artifactId !== undefined) body.artifactId = ghost
    return body
  }
  /** Mark the ghost item's primary file missing and attach one failed delivery. */
  const patchGhostDetail = (body) => {
    body.record = {
      ...body.record,
      files: body.record.files.map(file => ({ ...file, missing: true })),
    }
    body.dispatches = [{
      dispatchId: 'dispatch-browser-readonly',
      state: 'failed',
      commentIds: ['comment-browser-1'],
      errorCode: 'artifact/dispatch-unavailable',
      updatedAt: '2099-01-01T00:00:00.000Z',
    }]
  }
  /** Proxy one owner-scoped read onto the real fixture Session/artifact. */
  const proxy = async (route) => {
    if (await continueUnlessGhost(route)) return
    const url = new URL(route.request().url())
    url.searchParams.set('sessionId', fixtures.primarySessionId)
    url.searchParams.set('artifactId', BROWSER_ARTIFACT)
    const response = await route.fetch({ url: url.toString() })
    const body = ghostBody(await response.json().catch(() => null))
    if (body === null) {
      await route.fulfill({ response }).catch(() => {})
      return
    }
    if (url.pathname.endsWith('.detail')) patchGhostDetail(body)
    await route.fulfill({ response, json: body }).catch(() => {})
  }
  /** The ghost item's primary file is gone; the rebind entry must stay read-only. */
  const missingFile = async (route) => {
    if (await continueUnlessGhost(route)) return
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'artifact/file-missing', message: '文件已移动' } }),
    }).catch(() => {})
  }
  await page.route('**/api/cowork.artifact.detail*', proxy)
  await page.route('**/api/cowork.artifact.file*', missingFile)
  await page.route('**/api/cowork.artifact.comments*', proxy)
  try {
    // Re-enter the tab so the list reads the patched catalog.
    await page.locator('[data-testid="cw-tab"][data-tab="topics"]').click()
    await waitForOverview(page)
    await page.locator('[data-testid="cw-tab"][data-tab="work-items"]').click()
    const ghostCard = page.locator(`[data-testid="cwi-card"][data-artifact-id="${ghost}"]`)
    await ghostCard.waitFor({ timeout: 15_000 })
    await ghostCard.click()
    await page.getByTestId('cwi-title').waitFor({ timeout: 15_000 })
    await page.getByTestId('cwi-cross-banner').waitFor({ timeout: 10_000 })
    // A missing primary file renders the rebind entry instead of an edit button.
    assert.equal(await page.getByTestId('cwi-edit').count(), 0)
    assert.equal(await page.getByTestId('cwi-confirm').isDisabled(), true)
    await openRail(page)
    // Every write path stays disabled: rebinding the file and retrying a
    // delivery both mutate the owning session's work item.
    assert.equal(await page.getByTestId('cwi-rebind-input').isDisabled(), true)
    assert.equal(await page.getByTestId('cwi-rebind-submit').isDisabled(), true)
    assert.equal(await page.getByTestId('cwi-dispatch-retry').first().isDisabled(), true)

    // The host refuses the unknown session; the failure is visible and the
    // viewer stays a read-only preview.
    await page.getByTestId('cwi-cross-open').click()
    const failure = page.getByTestId('cwi-cross-error')
    await failure.waitFor({ timeout: 10_000 })
    assert.match(await failure.innerText(), /切换会话失败|切换后没有进入所属会话/)
    await page.getByTestId('cwi-cross-retry').click()
    await failure.waitFor({ timeout: 10_000 })
    assert.equal(await page.getByTestId('cwi-rebind-submit').isDisabled(), true)
    assert.equal(await page.getByTestId('cwi-cross-banner').count(), 1)

    await page.getByTestId('cwi-back').click()
    await page.getByTestId('cwi-viewer').waitFor({ state: 'detached', timeout: 10_000 })
  } finally {
    await page.unroute('**/api/cowork.artifact.list*')
    await page.unroute('**/api/cowork.artifact.detail*')
    await page.unroute('**/api/cowork.artifact.file*')
    await page.unroute('**/api/cowork.artifact.comments*')
  }
  await backToTopicTab(page)
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
    // The loading probe holds one request; a session or panel transition may
    // release the route before this handler resumes, which is not the check.
    await route.continue().catch(() => {})
  })
  await ensurePanel(page)
  await ensureTopicList(page)
  await page.locator('[data-testid="cw-tab"][data-tab="work-items"]').click()
  const loading = page.getByTestId('cwi-list')
  await loading.waitFor({ timeout: 10_000 })
  assert.equal(await loading.getAttribute('data-phase'), 'loading')
  const card = await artifactCard(page)
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
  await openRail(page)
  assert.match(await page.getByTestId('cwi-status').innerText(), /需反馈/)
  const existing = page.locator('[data-testid="cwi-thread"]').filter({ hasText: '已有的浏览器批注' })
  await existing.waitFor({ timeout: 10_000 })
  assert.equal(await existing.getAttribute('data-resolved'), 'false')

  // A cross-block text selection becomes one anchored comment; the anchor
  // keeps the selected text beside the full-line quote.
  await selectReadingRange(page, '第一段：逐行批注。', '第二段：模型与用户共享的版本。')
  await page.getByTestId('cwi-annotate').click()
  assert.match(await page.getByTestId('cwi-rail').innerText(), /第 3–4 行/)
  const composer = page.getByTestId('cwi-composer')
  const commentRequest = page.waitForRequest((request) => {
    try {
      return new URL(request.url()).pathname === '/api/cowork.artifact.comment'
    } catch {
      return false
    }
  })
  await composer.fill('浏览器 lane 的新批注')
  await page.getByTestId('cwi-submit').click()
  const postedAnchor = (await commentRequest).postDataJSON().anchor
  assert.equal(postedAnchor.startLine, 3)
  assert.equal(postedAnchor.endLine, 4)
  assert.match(postedAnchor.selectedText, /第一段/)
  assert.match(postedAnchor.selectedText, /第二段/)
  const created = page.locator('[data-testid="cwi-thread"]').filter({ hasText: '浏览器 lane 的新批注' })
  await created.waitFor({ timeout: 10_000 })
  assert.equal(await created.getAttribute('data-resolved'), 'false')
  chainThreadId = await created.getAttribute('data-thread-id')

  // The three-state filter and its shortcut stay in sync: pending keeps both
  // unresolved cards and hides the (empty) resolved summary.
  const filter = page.getByTestId('cwi-thread-filter')
  await filter.selectOption('pending')
  assert.equal(await page.locator('[data-testid="cwi-thread"]').count(), 2)
  assert.equal(await page.getByTestId('cwi-resolved-line').count(), 0)
  await page.getByTestId('cwi-rail-pending-filter').uncheck({ force: true })
  assert.equal(await filter.inputValue(), 'all')

  // Resolve it: the server appends one resolve row and the rail groups it
  // under the resolved summary.
  await created.getByTestId('cwi-thread-toggle').click()
  await page.getByTestId('cwi-resolved-line').waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-resolved-line').click()
  const resolvedCard = page.locator(`[data-testid="cwi-thread"][data-thread-id="${chainThreadId}"]`)
  await resolvedCard.waitFor({ timeout: 10_000 })
  assert.equal(await resolvedCard.getAttribute('data-resolved'), 'true')
  // Expanded resolved cards must disappear under pending, not just the summary.
  await filter.selectOption('pending')
  assert.equal(await resolvedCard.count(), 0)
  assert.equal(await page.getByTestId('cwi-resolved-line').count(), 0)
  await filter.selectOption('resolved')
  await resolvedCard.waitFor({ timeout: 10_000 })
  assert.equal(await resolvedCard.getAttribute('data-resolved'), 'true')
  await filter.selectOption('all')
  await resolvedCard.waitFor({ timeout: 10_000 })

  // Back to the conversation, then reopen: the server serves the same thread.
  await page.getByTestId('cwi-back').click()
  const list = await openWorkItemTab(page)
  await list.waitFor()
  await card.click()
  await openRail(page)
  await page.getByTestId('cwi-resolved-line').waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-resolved-line').click()
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

/** Select one substring inside the rendered Markdown and wait for the entry. */
async function selectReadingText(page, needle) {
  const found = await page.evaluate((text) => {
    const root = document.querySelector('[data-testid="cwi-md-read"]')
    if (root === null) return false
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes = []
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node)
    const target = nodes
      .map((node) => ({ node, index: node.textContent?.indexOf(text) ?? -1 }))
      .find((entry) => entry.index >= 0)
    if (target === undefined) return false
    const range = document.createRange()
    range.setStart(target.node, target.index)
    range.setEnd(target.node, target.index + text.length)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  }, needle)
  assert.equal(found, true, `reading text not found: ${needle}`)
  await page.getByTestId('cwi-md-selection').waitFor({ timeout: 10_000 })
}

/** Select from one substring through another, spanning rendered blocks. */
async function selectReadingRange(page, startText, endText) {
  const found = await page.evaluate(({ start, end }) => {
    const root = document.querySelector('[data-testid="cwi-md-read"]')
    if (root === null) return false
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes = []
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node)
    const locate = (text) => {
      for (const node of nodes) {
        const index = node.textContent?.indexOf(text) ?? -1
        if (index >= 0) return { node, index }
      }
      return null
    }
    const matches = [locate(start), locate(end)]
    if (matches.some((match) => match === null)) return false
    const [first, last] = matches
    const range = document.createRange()
    range.setStart(first.node, first.index)
    range.setEnd(last.node, last.index + end.length)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  }, { start: startText, end: endText })
  assert.equal(found, true, `reading range not found: ${startText} … ${endText}`)
  await page.getByTestId('cwi-md-selection').waitFor({ timeout: 10_000 })
}

/**
 * The Markdown reading surface: rich block rendering, block pins, selection
 * annotate, the dirty-draft gate, and frontmatter as a read-only header.
 *
 * The seeded file is mocked twice so one scenario can exercise frontmatter,
 * tables, task lists, links, images, raw HTML, and the large-file layout
 * without committing a second fixture to the workspace profile.
 */
const RICH_MARKDOWN = [
  '# 富文本标题',
  '',
  '正文含 **粗体**、*斜体*、~~删除~~、`行内代码`、[外链](https://example.com/spec) 与 [相对](./docs/x.md)。',
  '',
  '- [x] 已完成任务',
  '- [ ] 未完成任务',
  '',
  '> 引用段落',
  '',
  '```ts',
  'const a = 1',
  '```',
  '',
  '| 左 | 中 | 右 |',
  '|:--|:-:|--:|',
  '| 1 | 2 | 3 |',
  '',
  '![有说明的图片](https://127.0.0.1:9/a.png)',
  '![](https://127.0.0.1:9/b.png)',
  '',
  '![坏图](data:image/png;base64,AAAA)',
  '',
  '<img src=x onerror=alert(1)> 按字面显示',
  '',
  '---',
].join('\n')

const FRONTMATTER_MARKDOWN = [
  '---',
  'status: proposed',
  'owner: 工作项页设计',
  '---',
  '# 元数据文档',
  '',
  '正文。',
].join('\n')

/** One mocked file response for the Markdown scenario. */
function markdownFile(content) {
  return {
    ok: true,
    artifactId: BROWSER_ARTIFACT,
    path: BROWSER_SPEC_PATH,
    mediaType: 'text/markdown',
    content,
    size: Buffer.byteLength(content, 'utf8'),
    sha256: '',
    revision: 1,
    fsVersion: 'fixture-markdown',
  }
}

async function scenarioWorkItemMarkdown(page, fixtures) {
  let fileContent = RICH_MARKDOWN
  await page.route('**/api/cowork.artifact.file*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(markdownFile(fileContent)) })
  })
  try {
    await openWorkItemTab(page)
    await page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`).click()
    const reading = page.getByTestId('cwi-md-read')
    await reading.waitFor({ timeout: 15_000 })

    // Rich block rendering.
    assert.equal(await page.getByTestId('cwi-md-frontmatter').count(), 0)
    assert.match(await reading.innerText(), /富文本标题/)
    assert.ok(await page.locator('.cwi-md-read strong').count() >= 1)
    assert.equal(await page.locator('.cwi-md-read del').count(), 1)
    assert.ok(await page.locator('.cwi-md-read code').count() >= 1)
    const link = page.locator('.cwi-md-link').first()
    assert.equal(await link.getAttribute('href'), 'https://example.com/spec')
    assert.equal(await link.getAttribute('target'), '_blank')
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer')
    assert.equal(await page.locator('a[href="./docs/x.md"]').count(), 0, 'relative links stay text')
    assert.match(await reading.innerText(), /<img src=x onerror=alert\(1\)> 按字面显示/)
    assert.equal(await page.locator('.cwi-md-hr').count(), 1)
    assert.match(await page.locator('.cwi-md-pre').innerText(), /const a = 1/)

    const boxes = page.getByTestId('cwi-md-task')
    assert.equal(await boxes.count(), 2)
    assert.equal(await boxes.nth(0).isChecked(), true)
    assert.equal(await boxes.nth(1).isChecked(), false)
    assert.equal(await boxes.nth(0).isDisabled(), true)

    const headers = page.locator('.cwi-md-table th')
    assert.equal(await headers.count(), 3)
    assert.equal(await headers.nth(0).evaluate(element => element.style.textAlign), 'left')
    assert.equal(await headers.nth(1).evaluate(element => element.style.textAlign), 'center')
    assert.equal(await headers.nth(2).evaluate(element => element.style.textAlign), 'right')

    // Both http images fail their request (closed port): the dashed placeholder
    // replaces the broken image and the missing alt gets a visible caption.
    await page.getByTestId('cwi-md-image-failed').first().waitFor({ timeout: 20_000 })
    assert.equal(await page.getByTestId('cwi-md-image-failed').count(), 2)
    assert.match(await page.getByTestId('cwi-md-image-failed').nth(1).innerText(), /未提供图片说明/)
    // markdown-it accepts data:image by default; the allowlist must refuse it.
    assert.equal(await page.getByTestId('cwi-md-image-unavailable').count(), 1)
    assert.equal(await page.locator('img[src^="data:"]').count(), 0)

    // One block pin for the seeded thread, with the grouped aria label.
    const pin = page.getByTestId('cwi-md-pin').first()
    await pin.waitFor({ timeout: 10_000 })
    // The chain scenario already added one thread on these lines.
    assert.match(await pin.getAttribute('aria-label'), /第 1 条批注，共 2 条，第 3 行/)
    await pin.click()
    await page.locator('.cwi-md-thread-target').first().waitFor({ timeout: 10_000 })

    // Selection annotate: the anchor keeps the sub-line text; the server still
    // derives the full-line quote from the real file.
    await page.route('**/api/cowork.artifact.comment*', async (route) => {
      await route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), dispatch: false }) })
    })
    await selectReadingText(page, '粗体')
    await page.getByTestId('cwi-annotate').click()
    assert.match(await page.getByTestId('cwi-rail').innerText(), /第 3 行/)
    const commentRequest = page.waitForRequest((request) => {
      try {
        return new URL(request.url()).pathname === '/api/cowork.artifact.comment'
      } catch {
        return false
      }
    })
    await page.getByTestId('cwi-composer').fill('阅读态选区批注')
    await page.getByTestId('cwi-submit').click()
    const anchor = (await commentRequest).postDataJSON().anchor
    assert.equal(anchor.startLine, 3)
    assert.equal(anchor.endLine, 3)
    assert.equal(anchor.selectedText, '粗体')
    await page.locator('[data-testid="cwi-thread"]').filter({ hasText: '阅读态选区批注' }).waitFor({ timeout: 10_000 })
    assert.match(await page.getByTestId('cwi-md-pin').first().getAttribute('aria-label'), /共 3 条/)
    await page.unroute('**/api/cowork.artifact.comment*')

    // Back to the real file for the draft-gate and frontmatter checks.
    await page.unroute('**/api/cowork.artifact.file*')
    await page.getByTestId('cwi-more').click()
    await page.getByTestId('cwi-menu-refresh').click()
    await reading.filter({ hasText: '第一段：逐行批注。' }).waitFor({ timeout: 15_000 })

    // A dirty draft renders the draft but hides pins and disables annotating.
    await page.getByTestId('cwi-edit').click()
    await page.getByTestId('cwi-editor').waitFor({ timeout: 10_000 })
    await page.route('**/api/cowork.artifact.edit*', route => route.abort())
    await page.getByTestId('cwi-editor').locator('.cm-line').first().click({ position: { x: 2, y: 5 } })
    await page.keyboard.press('End')
    await page.keyboard.insertText('草稿')
    await page.getByTestId('cwi-mode').click()
    await reading.waitFor({ timeout: 10_000 })
    assert.equal(await page.getByTestId('cwi-md-pin').count(), 0, 'pins hide while the draft is unsaved')
    await page.getByText(/未保存草稿：保存后可批注/).first().waitFor({ timeout: 10_000 })
    await selectReadingText(page, '第一段')
    assert.equal(await page.getByTestId('cwi-annotate').isDisabled(), true)
    await page.keyboard.press('Escape')

    // Saving the draft restores the pins.
    await page.unroute('**/api/cowork.artifact.edit*')
    await page.getByTestId('cwi-edit').click()
    await page.getByTestId('cwi-editor').waitFor({ timeout: 10_000 })
    const saved = waitForPost(page, '/api/cowork.artifact.edit')
    await page.getByTestId('cwi-editor').locator('.cm-line').first().click({ position: { x: 2, y: 5 } })
    await page.keyboard.press('End')
    await page.keyboard.insertText('已保存')
    assert.equal((await saved).status(), 200)
    await page.getByTestId('cwi-mode').click()
    await reading.waitFor({ timeout: 10_000 })
    await page.getByTestId('cwi-md-pin').first().waitFor({ timeout: 10_000 })

    // Frontmatter is a collapsed, read-only block; an anchor inside it gets no
    // pin because the header is not annotatable.
    fileContent = FRONTMATTER_MARKDOWN
    await page.route('**/api/cowork.artifact.file*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(markdownFile(fileContent)) })
    })
    await page.getByTestId('cwi-more').click()
    await page.getByTestId('cwi-menu-refresh').click()
    const frontmatter = page.getByTestId('cwi-md-frontmatter')
    await frontmatter.waitFor({ timeout: 15_000 })
    // The details element is collapsed: read the stored text, not innerText.
    assert.match(await page.locator('.cwi-md-frontmatter-body').textContent(), /status: proposed/)
    assert.equal(await page.getByTestId('cwi-md-pin').count(), 0)

    // A file over the read threshold falls back to the numbered Markdown-ish
    // source lines: the notice names the reason and line work stays available.
    fileContent = [
      '# 大文件',
      '',
      '**粗体** 一行文本',
      ...Array.from({ length: 2100 }, (_, index) => `第 ${index} 行 ${'x'.repeat(1000)}`),
    ].join('\n')
    await page.getByTestId('cwi-more').click()
    await page.getByTestId('cwi-menu-refresh').click()
    // Layout of 2 MB in the DOM is slow on purpose; attached is the branch
    // check, and the visible notice text is read without forcing innerText.
    await page.getByTestId('cwi-md-fallback').waitFor({ state: 'attached', timeout: 60_000 })
    assert.match(await page.getByTestId('cwi-md-fallback').textContent(), /2 MB/)
    assert.equal(await page.getByTestId('cwi-md-read').count(), 0)

    await page.unroute('**/api/cowork.artifact.file*')
    await page.getByTestId('cwi-more').click()
    await page.getByTestId('cwi-menu-refresh').click()
    await reading.filter({ hasText: '第一段：逐行批注。' }).waitFor({ timeout: 15_000 })
    await page.getByTestId('cwi-back').click()
    await page.getByTestId('cwi-viewer').waitFor({ state: 'detached', timeout: 10_000 })
    // Restore the seeded bytes: the draft-gate step saved an extra line.
    await writeFile(join(fixtures.primary.repoPath, BROWSER_SPEC_PATH), BROWSER_SPEC, 'utf8')
    await backToTopicTab(page)
  } finally {
    await page.unroute('**/api/cowork.artifact.file*').catch(() => {})
    await page.unroute('**/api/cowork.artifact.edit*').catch(() => {})
    await page.unroute('**/api/cowork.artifact.comment*').catch(() => {})
  }
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
  const card = await artifactCard(page)

  const diagramSource = 'flowchart LR\n  A[开始] --> B[结束]\n  B --> C[完成]\n'
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
    // The numbered source keeps line picking, the range bar, keyboard
    // annotation, and line pins usable for non-Markdown families.
    await page.locator('[data-testid="cwi-line"][data-line="1"]').click()
    await page.locator('.cwi-selection-bar').waitFor({ timeout: 10_000 })
    assert.equal(await page.getByTestId('cwi-annotate').isDisabled(), false)
    await page.locator('.cwi-selection-bar').getByRole('button', { name: '取消' }).click()
    await page.getByTestId('cwi-lines').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('data-testid') === 'cwi-composer',
      undefined,
      { timeout: 10_000 },
    )
    assert.match(await page.getByTestId('cwi-rail').innerText(), /第 2 行/)
    await page.getByTestId('cwi-rail').getByRole('button', { name: '取消位置' }).click()
    await page.getByTestId('cwi-line-pin').first().click()
    assert.equal(await page.locator('[data-testid="cwi-thread"][data-selected="true"]').count(), 1)
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
  const card = await artifactCard(page)
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
  await openArtifactViewer(page)
  await page.getByTestId('cwi-viewer-footer').waitFor({ timeout: 10_000 })
  // Overflow menu: copy path and refresh are the two local actions.
  await page.getByTestId('cwi-more').click()
  await page.getByTestId('cwi-menu-copy').click()
  await page.getByText(/路径已复制|复制失败/).waitFor({ timeout: 5_000 })
  await page.getByTestId('cwi-more').click()
  await page.getByTestId('cwi-menu').waitFor({ timeout: 5_000 })
  await page.getByTestId('cwi-menu-refresh').click()
  await page.getByTestId('cwi-menu').waitFor({ state: 'detached', timeout: 5_000 })
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
  await page.getByTestId('cwi-md-read').waitFor({ timeout: 10_000 })
  assert.match(await page.getByTestId('cwi-md-read').innerText(), /模型并发行。/)

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
  await editor.locator('.cm-line').first().click({ position: { x: 2, y: 5 } })
  await page.keyboard.press('End')
  await page.keyboard.insertText('恢复保存')
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
  const card = await artifactCard(page)
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
  await page.getByTestId('cwi-md-read').waitFor({ timeout: 10_000 })

  await page.getByTestId('cwi-view-tab').filter({ hasText: '版本' }).click()
  await page.getByTestId('cwi-versions').waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-view-tab').filter({ hasText: '附件' }).click()
  await page.getByTestId('cwi-attachments').waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-view-tab').filter({ hasText: '文档' }).click()
  await page.getByTestId('cwi-md-read').waitFor({ timeout: 10_000 })

  // The segmented control is the read/source switch: for Markdown the source
  // surface is the editor, and switching back restores the flow view.
  const mode = page.getByTestId('cwi-mode')
  assert.equal(await mode.getAttribute('data-mode'), 'read')
  await mode.click()
  await page.getByTestId('cwi-editor').waitFor({ timeout: 10_000 })
  assert.equal(await mode.getAttribute('data-mode'), 'source')
  await mode.click()
  await page.getByTestId('cwi-md-read').waitFor({ timeout: 10_000 })
  assert.equal(await mode.getAttribute('data-mode'), 'read')

  // The rail starts collapsed; the toolbar toggle is the expand/collapse entry.
  const rail = page.getByTestId('cwi-rail')
  assert.equal(await rail.isHidden(), true)
  await page.getByTestId('cwi-rail-toggle').click()
  await rail.waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-rail-toggle').click()
  assert.equal(await rail.isHidden(), true)
  await openRail(page)

  await page.getByTestId('cwi-md-pin').first().waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-thread-focus').first().click()
  await page.getByTestId('cwi-md-read').waitFor({ timeout: 10_000 })

  // The failed batch belongs to the thread resolved earlier; expand the
  // resolved summary before reaching its retry action.
  await page.getByTestId('cwi-resolved-line').click()
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
  await openArtifactViewer(page)
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
  const card = await artifactCard(page)

  // Three consecutive stream failures stop the viewer and offer a retry; the
  // retry reconnects once the route no longer refuses the stream.
  await page.route('**/api/cowork.artifact.events*', (route) => route.abort())
  await card.click()
  await page.getByTestId('cwi-title').waitFor({ timeout: 15_000 })
  await openRail(page)
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
  await page.getByTestId('cwi-md-read').waitFor({ timeout: 10_000 })

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
  await openArtifactViewer(page)
  await openRail(page)

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
  await page.getByTestId('cwi-md-read').filter({ hasText: '模型刷新行' }).waitFor({ timeout: 15_000 })

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
  // T7: the open state is in memory only; after the reload no view is registered.
  assert.equal(await coworkTab(page).count(), 0, 'a reload leaves no open work item')
  const list = await openWorkItemTab(page)
  const card = await artifactCard(page)
  // Read the rail before opening the viewer: selecting the main panel may
  // unmount the session-scoped tab body.
  assert.match(await list.innerText(), /浏览器交付物/)
  await card.click()
  await openRail(page)
  await page.getByTestId('cwi-resolved-line').waitFor({ timeout: 10_000 })
  await page.getByTestId('cwi-resolved-line').click()
  const thread = page.locator(`[data-testid="cwi-thread"][data-thread-id="${chainThreadId}"]`)
  await thread.waitFor({ timeout: 10_000 })
  assert.equal(await thread.getAttribute('data-resolved'), 'true')
  await page.getByTestId('cwi-back').click()
  await backToTopicTab(page)
}

/** A session with no Cowork project renders the empty surface, not an error. */
async function scenarioEmptyProject(page, fixtures) {
  await createSessionIn(page, fixtures.emptyWorkspaceId, 'empty-repo')
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


/** One comments-route row; the paging scenario owns its own page. */
function commentEvent({ eventId, threadId = eventId, body = '批注', line = null }) {
  return {
    version: 1,
    eventId,
    artifactId: BROWSER_ARTIFACT,
    commentId: threadId,
    threadId,
    type: 'create',
    author: 'user',
    body,
    ...(line === null
      ? {}
      : { anchor: { kind: 'line-range', path: BROWSER_SPEC_PATH, startLine: line, endLine: line, quote: '' } }),
    createdAt: '2026-11-20T00:00:00.000Z',
  }
}

/** The work item the rebind scenario repairs. */
const REBOUND_PATH = 'docs/rebound.md'
const REBOUND_SPEC = '# 已重新绑定\n\n新文件内容。'

/** Open the seeded work item viewer and wait for its first line. */
async function openWorkItemViewer(page) {
  await page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`).click()
  await page.getByTestId('cwi-viewer').waitFor({ timeout: 15_000 })
  await page.getByTestId('cwi-md-read').waitFor({ timeout: 15_000 })
}

/** Assert a group of elements is reachable with Tab (tabIndex >= 0). */
function assertTabbable(values, label) {
  assert.ok(values.length > 0 && values.every(index => index >= 0), `${label} must be tabbable`)
}

/** The outline a focused element renders. */
async function outlineOf(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element)
    return { style: style.outlineStyle, width: style.outlineWidth }
  })
}

/** Assert one focused element shows an outline ring, not only a colour change. */
function assertRing(ring, label) {
  assert.notEqual(ring.style, 'none', `${label} needs an outline`)
  assert.notEqual(ring.width, '0px')
}

/** Wait for one comments request with the given `before` cursor (null = first page). */
function waitForCommentsPage(page, before, timeout = 15_000) {
  return page.waitForRequest((request) => {
    try {
      const url = new URL(request.url())
      return url.pathname === '/api/cowork.artifact.comments' && url.searchParams.get('before') === before
    } catch {
      return false
    }
  }, { timeout })
}

/** The mocked comment rows one `before` cursor returns. */
function pagedComments(before) {
  if (before === null) {
    return [
      commentEvent({ eventId: 'event-a', threadId: 'thread-a', line: 1 }),
      commentEvent({ eventId: 'event-b', threadId: 'thread-b', line: 4 }),
    ]
  }
  if (before === 'event-a') {
    return [
      commentEvent({ eventId: 'event-old', threadId: 'thread-old', line: 2 }),
      commentEvent({ eventId: 'event-a', threadId: 'thread-a', line: 1 }),
    ]
  }
  return []
}

/**
 * Keyboard and focus: the line list, thread cards, and pins are operable from
 * the keyboard with a visible ring, and Escape closes overlays without sending.
 */
async function scenarioWorkItemKeyboard(page) {
  await openWorkItemTab(page)
  await openWorkItemViewer(page)
  await openRail(page)

  // Toolbar buttons, thread cards, and block pins all sit in the tab order.
  const tabbable = await page.evaluate(() => {
    const read = (selector) => Array.from(document.querySelectorAll(selector)).map(element => element.tabIndex)
    return {
      tabs: read('[data-testid="cwi-view-tab"]'),
      railToggle: read('[data-testid="cwi-rail-toggle"]'),
      cards: read('[data-testid="cwi-thread"]'),
      pins: read('[data-testid="cwi-md-pin"]'),
    }
  })
  assertTabbable(tabbable.tabs, 'view tabs')
  assertTabbable(tabbable.railToggle, 'rail toggle')
  assertTabbable(tabbable.cards, 'thread cards')
  assertTabbable(tabbable.pins, 'block pins')
  assert.equal(await page.getByTestId('cwi-md-pin').first().evaluate(element => element.tagName), 'BUTTON')
  // Reading mode is flow content: the annotated lines are not focusable rows.
  assert.equal(await page.locator('[data-testid="cwi-line"]').count(), 0)

  // Focus is visible as a ring, not only as a colour change, for the toolbar,
  // a thread card, and a block pin. Tab into each one so :focus-visible applies.
  await page.getByTestId('cwi-more').focus()
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'cwi-view-tab')
  assertRing(await outlineOf(page.getByTestId('cwi-view-tab').first()), 'a focused toolbar tab')

  await page.getByTestId('cwi-thread').first().focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'cwi-thread')
  assertRing(await outlineOf(page.getByTestId('cwi-thread').first()), 'a focused thread card')

  // Tab from the last toolbar control into the document until the block pin
  // takes focus; the pin must paint the same ring.
  await page.getByTestId('cwi-rail-toggle').focus()
  let pinFocused = false
  for (let step = 0; step < 40 && !pinFocused; step += 1) {
    await page.keyboard.press('Tab')
    pinFocused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'cwi-md-pin')
  }
  assert.equal(pinFocused, true, 'a block pin must be reachable with Tab')
  assertRing(await outlineOf(page.getByTestId('cwi-md-pin').first()), 'a focused block pin')

  // A card selects itself with Enter; a pin opens the thread it numbers.
  const card = page.getByTestId('cwi-thread').first()
  await card.focus()
  await page.keyboard.press('Enter')
  assert.equal(await card.getAttribute('data-selected'), 'true')
  const pin = page.getByTestId('cwi-md-pin').first()
  await pin.focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('[data-testid="cwi-thread"][data-selected="true"]').count(), 1)

  // Escape closes the overflow menu and never submits the composer draft.
  await page.getByTestId('cwi-more').click()
  await page.getByTestId('cwi-menu').waitFor({ timeout: 5_000 })
  await page.keyboard.press('Escape')
  await page.getByTestId('cwi-menu').waitFor({ state: 'detached', timeout: 5_000 })
  const threadCount = await page.locator('[data-testid="cwi-thread"]').count()
  await page.getByTestId('cwi-composer').fill('Escape 不应该发送这条批注')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('[data-testid="cwi-thread"]').count(), threadCount)
  assert.equal(await page.getByTestId('cwi-composer').inputValue(), 'Escape 不应该发送这条批注')
  await page.getByTestId('cwi-composer').fill('')
  await page.getByTestId('cwi-back').click()
  await backToTopicTab(page)
}

/**
 * The narrow layout: the rail list is one column, the viewer body one column,
 * and the comment rail is a drawer that Escape, its close button, and the
 * backdrop all dismiss without horizontal overflow.
 */
async function scenarioWorkItemNarrow(page) {
  await page.setViewportSize({ width: 820, height: 900 })
  try {
    const list = await openWorkItemTab(page)
    const listLayout = await list.evaluate((element) => ({
      direction: getComputedStyle(element).flexDirection,
      overflow: element.scrollWidth - element.clientWidth,
    }))
    assert.equal(listLayout.direction, 'column', 'the rail list must stay a single column')
    assert.ok(listLayout.overflow <= 1, `the rail list overflows horizontally by ${listLayout.overflow}px`)

    await openWorkItemViewer(page)
    const rail = page.getByTestId('cwi-rail')
    assert.equal(await rail.getAttribute('data-drawer'), 'true')
    assert.equal(await rail.isHidden(), true, 'the narrow drawer also starts collapsed')
    const bodyDirection = await page.locator('.cwi-body').evaluate(element => getComputedStyle(element).flexDirection)
    assert.equal(bodyDirection, 'column')
    await openRail(page)
    const railBox = await rail.boundingBox()
    assert.notEqual(railBox, null)
    assert.ok(railBox.x >= 0 && railBox.x + railBox.width <= 821, 'the drawer must stay inside the viewport')
    assert.equal(await page.getByTestId('cwi-rail-backdrop').count(), 1)

    // Escape closes the drawer and returns focus to its toggle.
    await page.keyboard.press('Escape')
    assert.equal(await page.getByTestId('cwi-rail').isHidden(), true)
    assert.equal(await page.getByTestId('cwi-rail-backdrop').count(), 0)
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'cwi-rail-toggle')

    // Reopen, then close with the drawer's own button.
    await page.getByTestId('cwi-rail-toggle').click()
    await page.getByTestId('cwi-rail').waitFor({ timeout: 5_000 })
    assert.equal(await page.getByTestId('cwi-rail-close').count(), 1)
    await page.getByTestId('cwi-rail-close').click()
    assert.equal(await page.getByTestId('cwi-rail').isHidden(), true)

    // Reopen, then dismiss with the backdrop.
    await page.getByTestId('cwi-rail-toggle').click()
    await page.getByTestId('cwi-rail-backdrop').waitFor({ timeout: 5_000 })
    // The drawer covers the lower part of the body; dismiss by the free area above it.
    await page.getByTestId('cwi-rail-backdrop').click({ position: { x: 8, y: 8 } })
    assert.equal(await page.getByTestId('cwi-rail').isHidden(), true)

    // Nothing on the viewer surface overflows horizontally at this width.
    const overflow = await page.evaluate(() => {
      const viewer = document.querySelector('[data-testid="cwi-viewer"]')
      return {
        document: document.documentElement.scrollWidth - window.innerWidth,
        viewer: viewer === null ? 0 : viewer.scrollWidth - viewer.clientWidth,
      }
    })
    assert.ok(overflow.document <= 1, `the page overflows horizontally by ${overflow.document}px`)
    assert.ok(overflow.viewer <= 1, `the viewer overflows horizontally by ${overflow.viewer}px`)

    // The 390 px tier: no horizontal overflow, a visible footer, no composer,
    // and the rail still starts collapsed.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByTestId('cwi-viewer').waitFor({ timeout: 5_000 })
    const small = await page.evaluate(() => {
      const viewer = document.querySelector('[data-testid="cwi-viewer"]')
      const footer = document.querySelector('[data-testid="cwi-viewer-footer"]')
      return {
        document: document.documentElement.scrollWidth - window.innerWidth,
        viewer: viewer === null ? 0 : viewer.scrollWidth - viewer.clientWidth,
        footerVisible: footer !== null && footer.getBoundingClientRect().bottom <= window.innerHeight + 1,
      }
    })
    assert.ok(small.document <= 1, `the 390 px page overflows horizontally by ${small.document}px`)
    assert.ok(small.viewer <= 1, `the 390 px viewer overflows horizontally by ${small.viewer}px`)
    assert.equal(small.footerVisible, true, 'the footer is not clipped at 390 px')
    assert.equal(await composerSeat(page).evaluate(element => getComputedStyle(element).display), 'none')
    // The right sidebar is not the subject of this tier; restore a width where
    // the panel is reachable before leaving the viewer.
    await page.setViewportSize({ width: 820, height: 900 })
    await page.getByTestId('cwi-back').click()
    await backToTopicTab(page)
  } finally {
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
}

/**
 * Backward comment paging: the rail offers "load older", requests the page
 * before the earliest loaded event with the same 200-row limit, dedupes an
 * overlapping row, keeps the selected thread, and hides the entry on an empty
 * page instead of pretending there is more.
 */
async function scenarioWorkItemPaging(page) {
  let olderFailures = 0
  await page.route('**/api/cowork.artifact.events*', route => route.abort())
  await page.route('**/api/cowork.artifact.comments*', async (route) => {
    const url = new URL(route.request().url())
    const before = url.searchParams.get('before')
    if (before === 'event-a' && olderFailures === 0) {
      olderFailures += 1
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'internal', message: 'older page boom' } }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, events: pagedComments(before), truncated: false, hasOlder: before !== 'event-old' }),
    })
  })
  try {
    const initialRequest = waitForCommentsPage(page, null)
    await openWorkItemTab(page)
    await page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`).click()
    const request = await initialRequest
    assert.equal(new URL(request.url()).searchParams.get('limit'), '200')
    await openRail(page)
    await page.locator('[data-testid="cwi-load-older"]').waitFor({ timeout: 15_000 })
    assert.equal(await page.locator('[data-testid="cwi-thread"]').count(), 2)

    const target = page.locator('[data-testid="cwi-thread"][data-thread-id="thread-b"]')
    await target.click()
    assert.equal(await target.getAttribute('data-selected'), 'true')

    const failedRequest = waitForCommentsPage(page, 'event-a')
    await page.getByTestId('cwi-load-older').click()
    assert.equal(new URL((await failedRequest).url()).searchParams.get('limit'), '200')
    await page.getByRole('status').filter({ hasText: '加载更早的批注失败' }).waitFor({ timeout: 10_000 })
    assert.equal(await page.getByTestId('cwi-load-older').count(), 1)

    const olderRequest = waitForCommentsPage(page, 'event-a')
    await page.getByTestId('cwi-load-older').click()
    assert.equal(new URL((await olderRequest).url()).searchParams.get('limit'), '200')
    await page.locator('[data-testid="cwi-thread"][data-thread-id="thread-old"]').waitFor({ timeout: 10_000 })
    assert.equal(await page.locator('[data-testid="cwi-thread"]').count(), 3)
    assert.equal(await target.getAttribute('data-selected'), 'true', 'loading older rows must keep the selection')

    const emptyRequest = waitForCommentsPage(page, 'event-old')
    await page.getByTestId('cwi-load-older').click()
    await emptyRequest
    await page.getByTestId('cwi-load-older').waitFor({ state: 'detached', timeout: 10_000 })
    assert.equal(await page.locator('[data-testid="cwi-thread"]').count(), 3)
    await page.getByTestId('cwi-back').click()
    await backToTopicTab(page)
  } finally {
    await page.unroute('**/api/cowork.artifact.events*')
    await page.unroute('**/api/cowork.artifact.comments*')
  }
}

/**
 * The missing-file entry: the viewer names the vanished path, validates input
 * locally, reports the server's reason on failure, and on success applies the
 * returned record and re-reads the file from its new path.
 */
async function scenarioWorkItemRebind(page) {
  let reboundPath = null
  let patchedRecord = null
  let rebindRequest = null
  let rebindCalls = 0

  await page.route('**/api/cowork.artifact.events*', route => route.abort())
  await page.route('**/api/cowork.artifact.detail*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    const record = body.record
    record.files = record.files.map(file => ({
      ...file,
      path: reboundPath ?? BROWSER_SPEC_PATH,
      missing: reboundPath === null,
      size: reboundPath === null ? file.size : Buffer.byteLength(REBOUND_SPEC, 'utf8'),
    }))
    record.primaryPath = reboundPath ?? BROWSER_SPEC_PATH
    patchedRecord = record
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/cowork.artifact.file*', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path')
    if (path === REBOUND_PATH) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          artifactId: BROWSER_ARTIFACT,
          path: REBOUND_PATH,
          mediaType: 'text/markdown',
          content: REBOUND_SPEC,
          size: Buffer.byteLength(REBOUND_SPEC, 'utf8'),
          sha256: '',
          revision: 1,
          fsVersion: 'fixture-rebound',
        }),
      })
      return
    }
    if (path === BROWSER_SPEC_PATH && reboundPath === null) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'artifact/file-missing', message: '文件已移动' } }),
      })
      return
    }
    await route.continue()
  })
  await page.route('**/api/cowork.artifact.rebind', async (route) => {
    rebindRequest = route.request().postDataJSON()
    rebindCalls += 1
    if (rebindCalls === 1) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'artifact/file-missing', message: '目标文件不存在' } }),
      })
      return
    }
    reboundPath = rebindRequest.newPath
    const record = {
      ...patchedRecord,
      primaryPath: reboundPath,
      files: (patchedRecord?.files ?? []).map(file => ({
        ...file,
        path: reboundPath,
        missing: false,
        size: Buffer.byteLength(REBOUND_SPEC, 'utf8'),
      })),
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, changed: true, record }),
    })
  })
  try {
    await openWorkItemTab(page)
    await page.locator(`[data-testid="cwi-card"][data-artifact-id="${BROWSER_ARTIFACT}"]`).click()
    await page.getByTestId('cwi-rebind').waitFor({ timeout: 15_000 })
    assert.match(await page.getByTestId('cwi-rebind').innerText(), new RegExp(BROWSER_SPEC_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(await page.getByTestId('cwi-rebind-input').count(), 1)
    // An unusable file has no fake actions: open and export are disabled, edit is absent.
    assert.equal(await page.getByTestId('cwi-open').isDisabled(), true)
    assert.equal(await page.getByTestId('cwi-export').isDisabled(), true)
    assert.equal(await page.getByTestId('cwi-edit').count(), 0)

    // Local validation refuses an empty path and an absolute one.
    await page.getByTestId('cwi-rebind-submit').click()
    await page.getByTestId('cwi-rebind-error').waitFor({ timeout: 5_000 })
    assert.match(await page.getByTestId('cwi-rebind-error').innerText(), /请输入/)
    await page.getByTestId('cwi-rebind-input').fill('/etc/passwd')
    await page.getByTestId('cwi-rebind-submit').click()
    assert.match(await page.getByTestId('cwi-rebind-error').innerText(), /相对路径/)

    // The server's refusal is shown with its own reason and keeps the form.
    await page.getByTestId('cwi-rebind-input').fill(REBOUND_PATH)
    await page.getByTestId('cwi-rebind-submit').click()
    await page.getByTestId('cwi-rebind-error').filter({ hasText: '新路径不存在' }).waitFor({ timeout: 10_000 })
    assert.match(await page.getByTestId('cwi-rebind-error').innerText(), /目标文件不存在/)
    assert.equal(rebindRequest.oldPath, BROWSER_SPEC_PATH)
    assert.equal(rebindRequest.newPath, REBOUND_PATH)
    assert.equal(await page.getByTestId('cwi-rebind').count(), 1)

    // Success applies the returned record and re-reads the new path.
    await page.getByTestId('cwi-rebind-submit').click()
    await page.getByTestId('cwi-rebind').waitFor({ state: 'detached', timeout: 10_000 })
    await page.getByTestId('cwi-md-read').filter({ hasText: '已重新绑定' }).waitFor({ timeout: 10_000 })
    assert.match(await page.getByTestId('cwi-primary-path').innerText(), new RegExp(REBOUND_PATH.replace('.', '\\.')))
    await page.getByRole('status').filter({ hasText: '已重新绑定到' }).waitFor({ timeout: 10_000 })
    assert.equal(await page.getByTestId('cwi-open').isDisabled(), false)
    await page.getByTestId('cwi-back').click()
    await backToTopicTab(page)
  } finally {
    await page.unroute('**/api/cowork.artifact.events*')
    await page.unroute('**/api/cowork.artifact.detail*')
    await page.unroute('**/api/cowork.artifact.file*')
    await page.unroute('**/api/cowork.artifact.rebind')
  }
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
  await scenarioWorkItemViewTab(page)
  await scenarioWorkItemTabFailure(page, fixtures)
  await scenarioWorkItemCrossSession(page, fixtures)
  await scenarioWorkItemOwnerFailure(page, fixtures)
  await scenarioWorkItemChain(page)
  await scenarioWorkItemMarkdown(page, fixtures)
  await scenarioWorkItemTypes(page)
  await scenarioWorkItemListLive(page, fixtures)
  await scenarioWorkItemEdit(page, fixtures)
  await scenarioWorkItemDraft(page)
  await scenarioWorkItemLive(page, fixtures)
  await scenarioWorkItemAttachments(page)
  await scenarioWorkItemEdges(page, fixtures)
  await scenarioWorkItemError(page)
  await scenarioWorkItemKeyboard(page)
  await scenarioWorkItemNarrow(page)
  await scenarioWorkItemPaging(page)
  await scenarioWorkItemRebind(page)
  await scenarioFilterSetup(page)
}

/** The filtered-list persistence reload, then the other workspace sessions. */
export async function runReloadScenarios(page, fixtures) {
  await scenarioFilterRestore(page)
  await scenarioWorkItemRestore(page)
  await scenarioSessionSwitch(page, fixtures)
  await scenarioEmptyProject(page, fixtures)
}
