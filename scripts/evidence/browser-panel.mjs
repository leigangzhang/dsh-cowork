#!/usr/bin/env node
/**
 * Real DSH browser panel lane.
 *
 * Starts a packed host in a throwaway DSH_HOME, creates two temporary
 * workspaces/sessions through the host Remote API, seeds both with deterministic
 * Cowork data, then drives the installed client in one Chromium context.
 *
 * The lane is observational until it has three green runs. `DSH_BROWSER_STRICT=1`
 * turns a missing host or browser into a failure instead of a named skip.
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDshHost } from './dsh-host-session.mjs'
import {
  clientCoverageFromEntries,
  clientCoverageLcov,
  comboSectionIndex,
  comboSourceMapUrl,
  coverageNavigationGuard,
  coverageCompletenessFailures,
  pluginBundleEntries,
} from './client-coverage.mjs'
import { gateArtifactFromEnv } from './test-coverage.mjs'
import { sanitizeEvidenceText } from './evidence-sanitize.mjs'
import { failurePayload, redactUrl } from './browser-evidence.mjs'
import { seedBrowserProject, seedSecondaryProject } from '../../tests/browser/fixtures.mjs'
import { runBrowserScenarios, runReloadScenarios } from '../../tests/browser/scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const CLIENT_BUNDLE_PATH = resolve(root, 'lib/client.js')
const CLIENT_MAP_PATH = resolve(root, 'lib/client.js.map')
const COVERAGE_OPTIONS = Object.freeze({ resetOnNavigation: false, reportAnonymousScripts: false })
const STRICT = process.env.DSH_BROWSER_STRICT === '1'
const KEEP = process.env.DSH_BROWSER_KEEP === '1'
const HEADFUL = process.env.DSH_BROWSER_HEADFUL === '1'
const MAX_PAGE_ERRORS = 50
const MAX_CONSOLE_MESSAGES = 100
const MAX_NETWORK_ROWS = 300

/** Keep failure evidence bounded without hiding the most recent events. */
function pushBounded(list, value, limit) {
  list.push(value)
  if (list.length > limit) list.splice(0, list.length - limit)
}

function skipOrFail(message) {
  if (STRICT) throw new Error(message)
  console.log(`SKIP browser-panel: ${message} (set DSH_BROWSER_STRICT=1 to make it fatal)`)
  process.exitCode = 0
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/** The host Remote envelope uses a different args field for the list endpoint. */
function remoteRequest(method, request) {
  const args = method === 'session/list' ? { _request: {} } : { request }
  return {
    type: 'client-request',
    rpcId: randomUUID(),
    method,
    payload: { args },
  }
}

function remoteErrorMessage(method, body) {
  return `${method}: ${JSON.stringify(body?.result?.error ?? body)}`
}

function remoteResult(method, body) {
  if (body?.result?.ok !== true) throw new Error(remoteErrorMessage(method, body))
  return body.result.value
}

async function hostRpc(host, method, request) {
  const response = await fetch(`${host.origin}/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: host.cookie,
    },
    body: JSON.stringify(remoteRequest(method, request)),
  })
  return remoteResult(method, await response.json())
}

async function createWorkspaceSession(host, repoPath) {
  mkdirSync(repoPath, { recursive: true })
  const workspace = await hostRpc(host, 'workspace/create', { path: repoPath })
  const session = await hostRpc(host, 'session/create', { workspaceId: workspace.workspace.workspaceId })
  return {
    repoPath,
    workspaceId: workspace.workspace.workspaceId,
    sessionId: session.sessionId,
  }
}

/** Dismiss the first preview notice; the locator handler owns the start dialog. */
async function dismissFirstRun(page) {
  const preview = page.getByRole('dialog', { name: '预览版说明' })
  if ((await preview.count()) > 0) {
    await preview.getByText('继续', { exact: true }).click()
    await preview.waitFor({ state: 'hidden' })
  }
}

async function openPanel(page) {
  const panel = page.getByTestId('cw-panel')
  if (!(await panel.isVisible().catch(() => false))) {
    const footer = page.getByRole('button', { name: '打开 Cowork 面板' })
    await footer.waitFor({ timeout: 15_000 })
    await footer.click()
  }
  await panel.waitFor({ timeout: 15_000 })
}

/** Save the bounded evidence a failed browser run needs for diagnosis. */
async function writeFailureArtifacts({ page, error, pageErrors, consoleMessages, network, coverage, hostLogs }) {
  const runId = `browser-${randomUUID()}`
  const target = resolve(root, '.dsh-cowork', 'browser', runId)
  mkdirSync(target, { recursive: true })
  if (page !== undefined) {
    await page.screenshot({ path: join(target, 'screenshot.png'), fullPage: true }).catch(() => {})
    await page.content()
      .then(html => writeFileSync(join(target, 'page.html'), sanitizeEvidenceText(html), 'utf8'))
      .catch(() => {})
  }
  const payload = failurePayload({ error, pageErrors, consoleMessages, network, coverage, hostLogs })
  writeFileSync(join(target, 'failure.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return target
}

function coverageSummary(report) {
  return report.files.map(file => file.status === 'blocked'
    ? `${file.file} blocked: ${file.blockedReason}`
    : `${file.file} line ${file.lineCoverage}% function ${file.functionCoverage}%`)
}

async function prepareFixtures(host, primaryRepo, secondaryRepo, emptyRepo) {
  // The secondary and empty workspaces start without sessions; their Sessions
  // are created through the real sidebar action during the switch and
  // empty-project scenarios. The primary Session is created last so it is the
  // one selected when the page opens.
  const secondaryWorkspace = await hostRpc(host, 'workspace/create', { path: secondaryRepo })
  const emptyWorkspace = await hostRpc(host, 'workspace/create', { path: emptyRepo })
  const primaryIdentity = await createWorkspaceSession(host, primaryRepo)
  const primary = await seedBrowserProject(primaryRepo, primaryIdentity.sessionId)
  const fixtures = {
    primary,
    primaryWorkspaceId: primaryIdentity.workspaceId,
    primarySessionId: primaryIdentity.sessionId,
    secondaryWorkspaceId: secondaryWorkspace.workspace.workspaceId,
    emptyWorkspaceId: emptyWorkspace.workspace.workspaceId,
    // The secondary project's master is the primary Session, so the session
    // created in the secondary workspace is a topic session with a real
    // master to navigate back to.
    prepareSecondarySession: async (sessionId) => {
      const secondary = await seedSecondaryProject(secondaryRepo, {
        masterSessionId: fixtures.primarySessionId,
        topicId: sessionId,
      })
      fixtures.secondary = secondary
      return secondary
    },
  }
  return fixtures
}

async function openBrowserPage(chromium, host, state) {
  const context = await chromium.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'Asia/Shanghai',
  })
  const page = await context.newPage()
  // The host opens a keyless "开始使用" dialog on several first-use surfaces.
  // Playwright runs this handler whenever that dialog blocks another action.
  await page.addLocatorHandler(page.getByRole('dialog', { name: '开始使用' }), async (dialog) => {
    const close = dialog.getByRole('button', { name: '关闭' })
    if ((await close.count()) > 0) await close.click()
  })
  page.on('pageerror', error => { pushBounded(state.pageErrors, error.message, MAX_PAGE_ERRORS) })
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      pushBounded(state.consoleMessages, { type: message.type(), text: message.text() }, MAX_CONSOLE_MESSAGES)
    }
  })
  page.on('response', (response) => {
    pushBounded(state.network, {
      method: response.request().method(),
      url: redactUrl(response.url()),
      status: response.status(),
    }, MAX_NETWORK_ROWS)
  })
  await page.coverage.startJSCoverage(COVERAGE_OPTIONS)
  await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 30_000 })
  await dismissFirstRun(page)
  await openPanel(page)
  return page
}

/** The plugin's bundle entries, section index, and served map URL. */
function coverageSource(coverageEntries) {
  const entries = pluginBundleEntries(coverageEntries)
  const first = entries[0]
  if (first === undefined) throw new Error('the plugin client bundle was not present in JSCoverage')
  const sectionIndex = comboSectionIndex(first.url)
  if (sectionIndex === null) throw new Error('the plugin package is missing from the combo URL')
  return { entries, sectionIndex, servedMapUrl: comboSourceMapUrl(first.url) }
}

async function servedSourceMap(host, servedMapUrl) {
  const response = await fetch(servedMapUrl, { headers: { cookie: host.cookie } })
  if (!response.ok) throw new Error(`the host combo source map returned ${response.status}`)
  return response.json()
}

function mappedCoverageReport({ entries, sectionIndex, sourceMapPayload }) {
  const report = clientCoverageFromEntries({
    entries,
    sourceMapPayload,
    repoRoot: root,
    mapDirectory: dirname(CLIENT_MAP_PATH),
    sectionIndex,
  })
  const completeness = coverageCompletenessFailures(report)
  if (completeness.length > 0) {
    throw new Error(`browser coverage completeness failed: ${completeness.join('; ')}`)
  }
  return report
}

function gitState() {
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  return {
    head,
    dirty: status !== '',
    gitStatus: status === '' ? [] : status.split('\n').slice(0, 100),
  }
}

function coverageArtifact({ host, probe, servedMapUrl }) {
  return {
    ...gitState(),
    gateArtifact: gateArtifactFromEnv(),
    generatedAt: new Date().toISOString(),
    pluginVersion: host.packageJson.version,
    playwrightVersion: host.packageJson.devDependencies?.playwright ?? 'unknown',
    dshVersion: probe.stdout.trim(),
    clientSha256: sha256(CLIENT_BUNDLE_PATH),
    mapSha256: sha256(CLIENT_MAP_PATH),
    servedMapUrl,
  }
}

// A standalone strict run needs a clean tree. The layered gate binds the exact
// dirty tree through COVERAGE_GATE_ARTIFACT, so it can judge uncommitted work.
function assertStrictEvidence(artifact) {
  if (STRICT && artifact.dirty && artifact.gateArtifact === null) {
    throw new Error('browser lane requires a clean worktree before standalone strict evidence')
  }
}

function coverageOutput(artifact, report) {
  return {
    formatVersion: 1,
    artifact,
    policy: {
      gate: 'report-only',
      branchMetric: 'not reported by precise coverage',
      tsxOwner: 'browser',
      tsOwner: 'node-test-coverage',
    },
    summary: coverageSummary(report),
    ...report,
  }
}

function writeCoverageFiles(output, report) {
  mkdirSync(resolve(root, 'coverage'), { recursive: true })
  writeFileSync(resolve(root, 'coverage', 'client.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  writeFileSync(resolve(root, 'coverage', 'browser.lcov'), clientCoverageLcov(report), 'utf8')
}

function reportCoverageResult(output, report, artifact) {
  const counted = report.files.filter(file => file.status === 'counted').length
  console.log(
    `PASS browser-panel: ${counted} counted client files, ${report.files.length} reported`
    + `${artifact.dirty ? ' (dirty worktree)' : ''}`,
  )
  for (const line of output.summary) console.log(`  ${line}`)
  if (!KEEP) return
  const target = resolve(root, '.dsh-cowork', 'browser', `browser-${randomUUID()}`)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'summary.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  console.log(`  kept summary: ${target}`)
}

async function publishCoverage({ host, probe, entries }) {
  const { entries: bundleEntries, sectionIndex, servedMapUrl } = coverageSource(entries)
  const sourceMapPayload = await servedSourceMap(host, servedMapUrl)
  const report = mappedCoverageReport({ entries: bundleEntries, sectionIndex, sourceMapPayload })
  const artifact = coverageArtifact({ host, probe, servedMapUrl })
  assertStrictEvidence(artifact)
  const output = coverageOutput(artifact, report)
  writeCoverageFiles(output, report)
  reportCoverageResult(output, report, artifact)
  return report
}

function dshProbe(dsh) {
  const probe = spawnSync(dsh, ['--version'], { encoding: 'utf8', timeout: 15_000 })
  return probe.error !== undefined || probe.status !== 0 ? null : probe
}

async function loadChromium() {
  let playwright
  try {
    playwright = await import('playwright')
  } catch {
    return {
      chromium: null,
      reason: 'playwright is not installed; run npm ci && npx playwright install chromium',
    }
  }
  const executable = playwright.chromium.executablePath()
  if (!existsSync(executable)) {
    return {
      chromium: null,
      reason: `Chromium is not installed at ${executable}; run npx playwright install chromium`,
    }
  }
  return { chromium: playwright.chromium, reason: null }
}

async function closeLane({ browser, host }) {
  if (browser !== undefined) await browser.close().catch(() => {})
  if (host !== undefined) await host.stop()
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

async function reportLaneFailure({ page, error, pageErrors, consoleMessages, network, coverage, host }) {
  const target = await writeFailureArtifacts({
    page,
    error,
    pageErrors,
    consoleMessages,
    network,
    coverage,
    hostLogs: host?.logTail?.() ?? '',
  })
  console.error(`FAIL browser-panel: ${errorText(error)}`)
  console.error(`  evidence: ${target}`)
  process.exitCode = 1
}

async function runBrowserLane({ chromium, probe }) {
  const laneRoot = mkdtempSync(join(tmpdir(), 'cowork-browser-lane-'))
  const primaryRepo = join(laneRoot, 'primary-repo')
  const secondaryRepo = join(laneRoot, 'secondary-repo')
  const emptyRepo = join(laneRoot, 'empty-repo')
  mkdirSync(primaryRepo, { recursive: true })
  mkdirSync(secondaryRepo, { recursive: true })
  mkdirSync(emptyRepo, { recursive: true })
  const state = { pageErrors: [], consoleMessages: [], network: [] }
  let host
  let browser
  let page
  let coverageEntries = []
  try {
    host = await startDshHost({
      patchRepoPath: primaryRepo,
      cwd: primaryRepo,
      profileName: 'cowork-browser',
      prefix: 'cowork-browser-host-',
    })
    const fixtures = await prepareFixtures(host, primaryRepo, secondaryRepo, emptyRepo)
    browser = await chromium.launch({ headless: !HEADFUL })
    page = await openBrowserPage(browser, host, state)
    const guard = coverageNavigationGuard(page)
    await runBrowserScenarios(page, fixtures)
    coverageEntries = await page.coverage.stopJSCoverage()
    guard.assertFirstEmpty()
    await page.coverage.startJSCoverage(COVERAGE_OPTIONS)
    guard.enterSecond()
    await runReloadScenarios(page, fixtures)
    coverageEntries = coverageEntries.concat(await page.coverage.stopJSCoverage())
    guard.assertSecondReloadOnly()
    if (state.pageErrors.length > 0) throw new Error(`page errors: ${state.pageErrors.join(' | ')}`)
    await publishCoverage({ host, probe, entries: coverageEntries })
  } catch (error) {
    await reportLaneFailure({ page, error, ...state, coverage: coverageEntries, host })
  } finally {
    await closeLane({ browser, host })
    rmSync(laneRoot, { recursive: true, force: true })
  }
}

async function main() {
  const dsh = process.env.DSH_BIN || 'dsh'
  const probe = dshProbe(dsh)
  if (probe === null) {
    skipOrFail(`'${dsh}' is not available`)
    return
  }
  const { chromium, reason } = await loadChromium()
  if (chromium === null) {
    skipOrFail(reason)
    return
  }
  await runBrowserLane({ chromium, probe })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL browser-panel: ${errorText(error)}`)
    process.exitCode = 1
  })
}
