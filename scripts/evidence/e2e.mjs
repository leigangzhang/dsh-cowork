#!/usr/bin/env node
/**
 * Versioned E2E lane.
 *
 * Packs the current `lib/`, boots one throwaway DSH host in a temporary
 * `DSH_HOME`, points the real DeepSeek adapter at a local scripted Messages
 * endpoint, and runs the keyless scenarios declared by `tests/e2e/manifest.json`
 * against real sessions, tools, stores, and panel routes.
 *
 * The keyless run needs no model credentials and opens no provider connection.
 * `--mode live` is the observational lane: it uses the deployment's real provider
 * and `DEEPSEEK_API_KEY`, so it is opt-in and never written to the release
 * summary. Neither run writes the user's profile; sessions, workspaces, and
 * fixtures live under one temporary root removed in `finally`. The only local
 * output is the gitignored `.dsh-cowork/e2e/<run>/` evidence directory, which
 * is intentionally kept for inspection.
 *
 * Usage:
 *   node scripts/evidence/e2e.mjs [--scenario <id>]... [--keep] [--record] [--list]
 *
 * A failed scenario does not stop the remaining scenarios; the process exits 1
 * after writing the local evidence. `--record` writes the sanitized release
 * summary to `tests/e2e/evidence/<pluginVersion>.json` and refuses a red run.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SCENARIOS } from '../../tests/e2e/scenarios/index.mjs'
import { catalogSha256 } from '../../tests/e2e/support/catalog.mjs'
import { startDshHost } from './dsh-host-session.mjs'
import { sanitizeEvidenceText } from './evidence-sanitize.mjs'
import { createHostClient } from '../../tests/e2e/support/host-client.mjs'
import { createScenarioContext } from '../../tests/e2e/support/context.mjs'
import { createFixture, removeFixture } from '../../tests/e2e/support/fixture.mjs'
import { startScriptedModel } from '../../tests/e2e/support/scripted-model.mjs'
import { scenarioTimeoutOf } from '../../tests/e2e/support/lane-timeouts.mjs'
import { hostSupport } from '../../tests/e2e/support/versions.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const manifestPath = join(root, 'tests/e2e/manifest.json')
const STRICT = process.env.DSH_E2E_STRICT === '1'
/** Flat budget for a scenario that does not declare a per-turn one. */
const SCENARIO_TIMEOUT_MS = 300_000

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function gitOutput(args, options = {}) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr?.toString().trim() ?? ''}`)
  return result.stdout
}

function artifactIdentity(tarball) {
  const head = gitOutput(['rev-parse', 'HEAD']).trim()
  const porcelain = gitOutput(['status', '--porcelain', '--untracked-files=all'])
    .split('\n')
    .filter((line) => line !== '')
  const diff = spawnSync('git', ['-C', root, 'diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'], {
    maxBuffer: 64 * 1024 * 1024,
  })
  if (diff.error !== undefined) throw diff.error
  if (diff.status !== 0) throw new Error(`git diff HEAD: ${String(diff.status)}`)
  return {
    head,
    dirty: porcelain.length > 0,
    workingDiffSha256: sha256(diff.stdout),
    tarballSha256: sha256(readFileSync(tarball)),
  }
}

function strictSkip(message) {
  if (STRICT) throw new Error(message)
  console.log(`SKIP e2e: ${message} (set DSH_E2E_STRICT=1 to make this fatal)`)
}

function loadScenario(entry) {
  const module = SCENARIOS.get(entry.id)
  if (module === undefined) throw new Error(`scenario ${entry.id} has no module in tests/e2e/scenarios/index.mjs`)
  if (module.id !== entry.id) throw new Error(`scenario ${entry.id} resolves to module id "${module.id}"`)
  if (typeof module.run !== 'function') throw new Error(`scenario ${entry.id} has no run() function`)
  return module
}

async function withTimeout(promise, milliseconds, label) {
  let timer
  const running = Promise.resolve(promise)
  // A timed-out scenario keeps running until the host is torn down; its late
  // rejection must not escape as an unhandled rejection.
  running.catch(() => undefined)
  try {
    return await Promise.race([
      running,
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ __timeout: label }), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', multiple: true },
      mode: { type: 'string', default: 'keyless' },
      keep: { type: 'boolean', default: false },
      record: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      'allow-untested-host': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  })
  if (values.help) {
    console.log('usage: node scripts/evidence/e2e.mjs [--mode keyless|live] [--scenario <id>]... [--keep] [--record] [--list] [--allow-untested-host]')
    return
  }

  const manifest = readJson(manifestPath, 'the E2E manifest')
  const mode = values.mode
  const MODE_FILTER = { keyless: 'keyless', live: 'live-model', bash: 'host-bash' }
  if (!Object.hasOwn(MODE_FILTER, mode)) throw new Error(`--mode must be keyless, live, or bash, got ${JSON.stringify(mode)}`)
  if (values.list) {
    for (const scenario of manifest.scenarios) console.log(`${scenario.mode} ${scenario.id} — ${scenario.summary}`)
    return
  }
  const requested = values.scenario
  const selected = requested === undefined || requested.length === 0
    ? manifest.scenarios.filter((scenario) => scenario.mode === MODE_FILTER[mode])
    : manifest.scenarios.filter((scenario) => requested.includes(scenario.id))
  if (selected.length === 0) {
    throw new Error(`no ${MODE_FILTER[mode]} scenario matched ${JSON.stringify(requested ?? [])}`)
  }
  const hasLive = selected.some((scenario) => scenario.mode === 'live-model')
  if ((hasLive || mode === 'bash') && values.record) throw new Error('observational evidence cannot be recorded as release evidence; --record is keyless-only')
  if (values.record && !hasLive) {
    const declared = manifest.scenarios.filter((scenario) => scenario.mode === 'keyless').map((scenario) => scenario.id).sort()
    const chosen = selected.map((scenario) => scenario.id).sort()
    if (JSON.stringify(declared) !== JSON.stringify(chosen)) {
      throw new Error('--record requires every keyless scenario in the manifest; run it without --scenario to record release evidence')
    }
  }
  if (hasLive && (process.env.DEEPSEEK_API_KEY ?? '').trim() === '') {
    strictSkip('live-model scenarios need DEEPSEEK_API_KEY; none is set')
    return
  }
  for (const entry of selected) loadScenario(entry)

  const dsh = process.env.DSH_BIN ?? 'dsh'
  const versionResult = spawnSync(dsh, ['--version'], { encoding: 'utf8', timeout: 15_000 })
  if (versionResult.error !== undefined || versionResult.status !== 0) {
    strictSkip(`'${dsh} --version' is unavailable`)
    return
  }
  const dshVersion = versionResult.stdout.trim()
  const support = hostSupport(manifest.host, dshVersion)
  if (!support.supported) throw new Error(support.reason)
  if (!support.tested) {
    if (!values['allow-untested-host']) throw new Error(`${support.reason}; pass --allow-untested-host to run an untested patch`)
    if (values.record) throw new Error(`${support.reason}; release evidence requires a tested host`)
    console.log(`WARN e2e: ${support.reason}`)
  }
  for (const path of ['lib/index.js', 'lib/client.js']) {
    if (!existsSync(join(root, path))) throw new Error(`${path} is missing; run \`npm run build\` first`)
  }

  const packageJson = readJson(join(root, 'package.json'), 'package.json')
  const runRoot = await mkdtemp(join(tmpdir(), 'cowork-e2e-run-'))
  const pluginProject = join(runRoot, 'plugin-project')
  mkdirSync(pluginProject, { recursive: true })
  const startedAt = new Date().toISOString()
  const results = []
  let model = null
  let host = null
  let artifact = null
  let runDir = null

  try {
    if (hasLive) {
      model = { calls: [], errors: [], setHandler() {}, reset() {}, close() {} }
    } else {
      model = await startScriptedModel()
    }
    mkdirSync(join(root, '.dsh-cowork/e2e'), { recursive: true })
    runDir = join(root, '.dsh-cowork/e2e', startedAt.replace(/[:.]/gu, '-'))
    mkdirSync(runDir, { recursive: true })
    host = await startDshHost({
      patchRepoPath: pluginProject,
      profileName: 'cowork-e2e',
      prefix: 'cowork-e2e-host-',
      keep: values.keep,
      env: hasLive ? {} : { DEEPSEEK_API_KEY: 'e2e-scripted-key' },
      patchOptions: {
        enableDevRoutes: false,
        routing: false,
        idleAfterMs: 1,
        extraEntries: hasLive
          ? [
              // The live lane is a latency-bounded smoke. Reasoning effort stays
              // off so one thinking turn cannot starve the later turns of the
              // same scenario; the keyless lane covers reasoning-free behavior.
              '- id: llm-deepseek',
              '  config:',
              '    thinking: disabled',
              '    reasoningEffort: off',
              '- id: session-title-llm',
              '  disabled: true',
            ]
          : [
              '- id: llm-deepseek',
              '  config:',
              `    baseURL: ${model.origin}`,
              '    models:',
              '      - id: deepseek-flash',
              '        name: scripted-e2e-flash',
              '        contextWindow: 200000',
              '      - id: deepseek-pro',
              '        name: scripted-e2e-pro',
              '        contextWindow: 200000',
              '- id: session-title-llm',
              '  disabled: true',
            ],
      },
    })
    artifact = artifactIdentity(host.tarball)
    if (values.record && artifact.dirty) {
      throw new Error('refusing to record release evidence from a dirty worktree; commit the tested tree first')
    }
    const client = createHostClient(host)

    for (const entry of selected) {
      const scenario = loadScenario(entry)
      // A live scenario budgets one timeout per model turn; a keyless one keeps
      // the flat lane budget. Validate before the fixture and host work.
      const scenarioTimeoutMs = scenarioTimeoutOf(scenario, SCENARIO_TIMEOUT_MS)
      const fixture = await createFixture(runRoot)
      model.reset()
      const context = createScenarioContext({ scenarioId: entry.id, fixture, client, model })
      const scenarioStartedAt = new Date().toISOString()
      const scenarioStartMs = Date.now()
      let error = null
      let timedOut = false
      try {
        const outcome = await withTimeout(scenario.run(context), scenarioTimeoutMs, entry.id)
        if (outcome !== undefined && outcome?.__timeout !== undefined) {
          timedOut = true
          error = `scenario ${entry.id} exceeded its ${String(scenarioTimeoutMs)}ms budget; the run stops here and never lets a stray scenario share the next fixture`
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
      } finally {
        // A timed-out scenario is still running. Its fixture and the shared host
        // are torn down below before the run root is removed; never let the next
        // scenario reuse the host or the scripted handler.
        if (timedOut) {
          // keep the fixture for the outer teardown
        } else if (values.keep) console.log(`kept fixture ${fixture.path}`)
        else await removeFixture(fixture.path)
      }
      const result = {
        id: entry.id,
        mode: entry.mode,
        summary: entry.summary,
        passed: error === null,
        error,
        checks: context.checks,
        startedAt: scenarioStartedAt,
        durationMs: Date.now() - scenarioStartMs,
        modelCalls: model.calls.slice(-40).map((call) => ({
          index: call.index,
          role: call.role,
          sessionId: call.sessionId,
          prompt: call.prompt,
          toolResults: call.toolResults,
          reply: call.reply,
          error: call.error,
        })),
      }
      results.push(result)
      writeFileSync(
        join(runDir, `${entry.id}.json`),
        `${JSON.stringify({ ...result, evidence: sanitizeEvidenceText(result) }, null, 2)}\n`,
        'utf8',
      )
      if (error === null) console.log(`PASS ${entry.id}: ${result.checks.length} checks`)
      else console.log(`FAIL ${entry.id}: ${error}`)
      if (timedOut) break
    }
  } finally {
    if (host !== null) await host.stop()
    if (model !== null) await model.close()
    if (values.keep) console.log(`kept run root ${runRoot}`)
    else await rm(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }

  const passed = results.every((result) => result.passed)
  const summary = {
    formatVersion: 1,
    mode,
    hostTested: support.tested,
    pluginVersion: packageJson.version,
    dshVersion,
    nodeVersion: process.version,
    command: 'npm run test:e2e',
    startedAt,
    finishedAt: new Date().toISOString(),
    result: passed ? 'pass' : 'fail',
    artifact,
    scenarios: results,
  }
  if (runDir !== null) writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

  if (values.record) {
    if (!passed) throw new Error('refusing to record release evidence for a red run')
    const record = {
      formatVersion: 1,
      pluginVersion: summary.pluginVersion,
      dshVersion: summary.dshVersion,
      catalogSha256: await catalogSha256(join(root, 'tests/e2e')),
      nodeVersion: summary.nodeVersion,
      command: 'npm run test:e2e -- --record',
      recordedAt: summary.finishedAt,
      result: 'pass',
      artifact: summary.artifact,
      scenarios: results.map((result) => ({
        id: result.id,
        mode: result.mode,
        passed: result.passed,
        checks: result.checks.map((check) => ({ name: check.name, passed: check.passed })),
      })),
    }
    mkdirSync(join(root, 'tests/e2e/evidence'), { recursive: true })
    const recordPath = join(root, 'tests/e2e/evidence', `${summary.pluginVersion}.json`)
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    console.log(`RECORDED tests/e2e/evidence/${summary.pluginVersion}.json`)
  }

  const checkCount = results.reduce((total, result) => total + result.checks.length, 0)
  if (!passed) {
    const failed = results.filter((result) => !result.passed).map((result) => result.id)
    throw new Error(`e2e failed: ${failed.join(', ')}`)
  }
  const lane = mode === 'keyless' ? 'e2e' : `${mode} e2e (observational)`
  console.log(`PASS ${lane}: ${results.length} scenarios, ${checkCount} checks, plugin ${packageJson.version} on DSH ${dshVersion}`)
}

main().catch((error) => {
  console.error(`FAIL e2e: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
