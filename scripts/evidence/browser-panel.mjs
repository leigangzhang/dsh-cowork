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
import { clientCoverageFromEntry, comboSourceMapUrl, pluginBundleEntry } from './client-coverage.mjs'
import { seedBrowserProject, seedSecondaryProject } from '../../tests/browser/fixtures.mjs'
import { runBrowserScenarios } from '../../tests/browser/scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const STRICT = process.env.DSH_BROWSER_STRICT === '1'
const KEEP = process.env.DSH_BROWSER_KEEP === '1'
const HEADFUL = process.env.DSH_BROWSER_HEADFUL === '1'

function skipOrFail(message) {
  if (STRICT) throw new Error(message)
  console.log(`SKIP browser-panel: ${message} (set DSH_BROWSER_STRICT=1 to make it fatal)`)
  process.exitCode = 0
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

/** Remove credentials from URL-shaped evidence before it reaches disk. */
function redactUrl(value) {
  try {
    const url = new URL(value)
    url.searchParams.delete('token')
    return url.toString()
  } catch {
    return value
  }
}

/** The host Remote envelope uses a different args field for the list endpoint. */
async function hostRpc(host, method, request) {
  const args = method === 'session/list' ? { _request: {} } : { request }
  const response = await fetch(`${host.origin}/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: host.cookie,
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload: { args },
    }),
  })
  const body = await response.json()
  if (body?.result?.ok !== true) {
    throw new Error(`${method}: ${JSON.stringify(body?.result?.error ?? body)}`)
  }
  return body.result.value
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
async function writeFailureArtifacts({ page, error, pageErrors, consoleMessages, network, coverage }) {
  const runId = `browser-${randomUUID()}`
  const target = resolve(root, '.dsh-cowork', 'browser', runId)
  mkdirSync(target, { recursive: true })
  if (page !== undefined) {
    await page.screenshot({ path: join(target, 'screenshot.png'), fullPage: true }).catch(() => {})
    await page.content().then(html => writeFileSync(join(target, 'page.html'), html, 'utf8')).catch(() => {})
  }
  writeFileSync(join(target, 'failure.json'), `${JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack ?? '' : '',
    pageErrors,
    consoleMessages,
    network,
    coverage,
  }, null, 2)}\n`, 'utf8')
  return target
}

function coverageSummary(report) {
  return report.files
    .filter(file => file.status === 'counted')
    .map(file => `${file.file} line ${file.lineCoverage}% function ${file.functionCoverage}%`)
}

async function main() {
  const dsh = process.env.DSH_BIN || 'dsh'
  const probe = spawnSync(dsh, ['--version'], { encoding: 'utf8', timeout: 15_000 })
  if (probe.error !== undefined || probe.status !== 0) {
    skipOrFail(`'${dsh}' is not available`)
    return
  }

  let chromium
  try {
    ({ chromium } = await import('playwright'))
  } catch {
    skipOrFail('playwright is not installed; run npm ci && npx playwright install chromium')
    return
  }
  const executable = chromium.executablePath()
  if (!existsSync(executable)) {
    skipOrFail(`Chromium is not installed at ${executable}; run npx playwright install chromium`)
    return
  }

  const laneRoot = mkdtempSync(join(tmpdir(), 'cowork-browser-lane-'))
  const primaryRepo = join(laneRoot, 'primary-repo')
  const secondaryRepo = join(laneRoot, 'secondary-repo')
  mkdirSync(primaryRepo, { recursive: true })
  mkdirSync(secondaryRepo, { recursive: true })
  let host
  let browser
  let page
  let coverageEntries
  const pageErrors = []
  const consoleMessages = []
  const network = []
  try {
    host = await startDshHost({
      patchRepoPath: primaryRepo,
      cwd: primaryRepo,
      profileName: 'cowork-browser',
      prefix: 'cowork-browser-host-',
    })
    // The secondary workspace starts empty; its Session is created through the
    // real sidebar action during the switch scenario. The primary Session is
    // created last so it is the one selected when the page opens.
    const secondaryWorkspace = await hostRpc(host, 'workspace/create', { path: secondaryRepo })
    const primaryIdentity = await createWorkspaceSession(host, primaryRepo)
    const primary = await seedBrowserProject(primaryRepo, primaryIdentity.sessionId)
    const fixtures = {
      primary,
      primaryWorkspaceId: primaryIdentity.workspaceId,
      primarySessionId: primaryIdentity.sessionId,
      secondaryWorkspaceId: secondaryWorkspace.workspace.workspaceId,
      prepareSecondarySession: async (sessionId) => {
        const secondary = await seedSecondaryProject(secondaryRepo, sessionId)
        fixtures.secondary = secondary
        return secondary
      },
    }

    browser = await chromium.launch({ headless: !HEADFUL })
    const context = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1440, height: 1000 },
      timezoneId: 'Asia/Shanghai',
    })
    page = await context.newPage()
    // The host opens a keyless "开始使用" dialog on several first-use surfaces.
    // Playwright runs this handler whenever that dialog blocks another action.
    await page.addLocatorHandler(page.getByRole('dialog', { name: '开始使用' }), async (dialog) => {
      const close = dialog.getByRole('button', { name: '关闭' })
      if ((await close.count()) > 0) await close.click()
    })
    page.on('pageerror', error => { pageErrors.push(error.message) })
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        consoleMessages.push({ type: message.type(), text: message.text() })
      }
    })
    page.on('response', (response) => {
      network.push({
        method: response.request().method(),
        url: redactUrl(response.url()),
        status: response.status(),
      })
    })
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false })
    await page.goto(host.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 30_000 })
    await dismissFirstRun(page)
    await openPanel(page)
    await runBrowserScenarios(page, fixtures)
    coverageEntries = await page.coverage.stopJSCoverage()
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`)

    const entry = pluginBundleEntry(coverageEntries)
    if (entry === null) throw new Error('the plugin client bundle was not present in JSCoverage')
    const mapPath = join(root, 'lib', 'client.js.map')
    const bundlePath = join(root, 'lib', 'client.js')
    const servedMapUrl = comboSourceMapUrl(entry.url)
    const servedMapResponse = await fetch(servedMapUrl, { headers: { cookie: host.cookie } })
    if (!servedMapResponse.ok) {
      throw new Error(`the host combo source map returned ${servedMapResponse.status}`)
    }
    const report = clientCoverageFromEntry({
      entry,
      sourceMapPayload: await servedMapResponse.json(),
      repoRoot: root,
      mapDirectory: dirname(mapPath),
    })
    const artifact = {
      head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
      generatedAt: new Date().toISOString(),
      pluginVersion: host.packageJson.version,
      playwrightVersion: host.packageJson.devDependencies?.playwright ?? 'unknown',
      dshVersion: probe.stdout.trim(),
      clientSha256: sha256(bundlePath),
      mapSha256: sha256(mapPath),
      servedMapUrl,
    }
    const output = {
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
    mkdirSync(resolve(root, 'coverage'), { recursive: true })
    writeFileSync(resolve(root, 'coverage', 'client.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
    console.log(`PASS browser-panel: ${coverageSummary(report).length} counted client files`)
    for (const line of output.summary) console.log(`  ${line}`)
    if (KEEP) {
      const target = resolve(root, '.dsh-cowork', 'browser', `browser-${randomUUID()}`)
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'summary.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
      console.log(`  kept summary: ${target}`)
    }
  } catch (error) {
    const target = await writeFailureArtifacts({ page, error, pageErrors, consoleMessages, network, coverage: coverageEntries })
    console.error(`FAIL browser-panel: ${error instanceof Error ? error.message : String(error)}`)
    console.error(`  evidence: ${target}`)
    process.exitCode = 1
  } finally {
    if (browser !== undefined) await browser.close().catch(() => {})
    if (host !== undefined) await host.stop()
    rmSync(laneRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FAIL browser-panel: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
