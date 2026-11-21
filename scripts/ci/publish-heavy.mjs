#!/usr/bin/env node
/**
 * Publish the head-bound `heavy-gate` result that the derived gate consumes.
 *
 * The heavy workflow records one `{name, exitCode}` row per command in a JSONL
 * file, then invokes this publisher. The publisher recomputes the current
 * gate-artifact identity, compares it with the identity captured before the
 * lane started, fetches current `main`, writes `heavy-result.json`, and
 * publishes a commit status plus the structured display check. The display
 * check is mandatory: it carries the head/base/diff identity the gate verifies.
 *
 * A published blocked result is still a successful publisher run: the status
 * and result file own the verdict. Only an unexpected publisher failure exits
 * non-zero, after attempting to write an `error` status on the same head.
 *
 * The publisher never checks out or executes pull-request code; the workflow
 * already ran the target head on the self-hosted runner.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectGateArtifact } from '../review/gate-artifact.mjs'
import { fetchCurrentMainSha } from './github-response.mjs'
import { HEAVY_COMMANDS, HEAVY_DISPLAY_CHECK, HEAVY_GATE_CONTEXT } from './heavy-contract.mjs'
import { isAncestor, publishGateCheck, publishGateStatus } from './publish-gate.mjs'

export { HEAVY_COMMANDS, HEAVY_DISPLAY_CHECK, HEAVY_GATE_CONTEXT } from './heavy-contract.mjs'

const COMMIT_SHA = /^[0-9a-f]{40}$/

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readOptionalJson(path) {
  if (path === '') return null
  try {
    return readJson(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function commandMap(rows) {
  const byName = new Map()
  for (const [index, row] of rows.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`command result row ${String(index)} must be an object`)
    }
    if (typeof row.name !== 'string' || row.name.trim() === '') {
      throw new Error(`command result row ${String(index)} needs a name`)
    }
    if (!Number.isInteger(row.exitCode)) {
      throw new Error(`command result ${row.name}.exitCode must be an integer`)
    }
    if (byName.has(row.name)) throw new Error(`command result ${row.name} appears more than once`)
    byName.set(row.name, row.exitCode)
  }
  return byName
}

/**
 * Parse one JSONL command-result file.
 *
 * A missing file means the workflow stopped before the first command; it is
 * represented as no rows so the publisher can still write and publish a
 * `fail` result that names every missing command.
 *
 * @param {string} path JSONL path.
 * @returns {Map<string, number>} Command name to integer exit code.
 */
export function readCommandResults(path) {
  if (!existsSync(path)) return new Map()
  const rows = []
  for (const [index, raw] of readFileSync(path, 'utf8').split('\n').entries()) {
    const line = raw.trim()
    if (line === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`${path}:${String(index + 1)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return commandMap(rows)
}

/**
 * Join the expected command list with the exits the workflow recorded.
 *
 * Unknown names are an error instead of silently disappearing: a renamed
 * workflow step must fail the publisher, not produce a green result with a
 * missing check.
 *
 * @param {Map<string, number>} exits Recorded command exits.
 * @param {typeof HEAVY_COMMANDS} specs Expected commands.
 * @returns {Array<{name: string, command: string, blocking: boolean, exitCode: number|null}>}
 *   One merged row per expected command.
 */
export function mergeCommandResults(exits, specs = HEAVY_COMMANDS) {
  const expected = new Set(specs.map((spec) => spec.name))
  for (const name of exits.keys()) {
    if (!expected.has(name)) throw new Error(`command result names unknown command: ${name}`)
  }
  return specs.map((spec) => ({
    ...spec,
    exitCode: exits.get(spec.name) ?? null,
  }))
}

function porcelainSummary(porcelain) {
  if (!Array.isArray(porcelain) || porcelain.length === 0) return ''
  return porcelain.slice(0, 3).join('; ')
}

/**
 * Decide whether a heavy result may be published as success.
 *
 * The pre-run artifact is the identity captured before npm ci or any test ran.
 * Comparing it with the post-run artifact proves the commands measured the
 * same head and diff; a dirty worktree at either edge is a failure.
 *
 * @param {object} input Decision inputs.
 * @param {object} input.artifact Post-run gate artifact.
 * @param {object|null} input.beforeArtifact Pre-run gate artifact, when available.
 * @param {string} input.expectedHead Head the workflow was dispatched to test.
 * @param {string} input.currentMain Current main SHA fetched from GitHub.
 * @param {Array<{name: string, blocking: boolean, exitCode: number|null}>} input.commands Merged commands.
 * @param {boolean} input.baseIsAncestor Whether the tested base is an ancestor of the head.
 * @returns {{pass: boolean, reasons: string[]}} Publishable verdict.
 */
function headIdentityReasons(artifact, expectedHead) {
  if (typeof expectedHead !== 'string' || !COMMIT_SHA.test(expectedHead)) {
    return ['HEAD_SHA is not a full commit SHA']
  }
  if (artifact?.resolved?.headSha !== expectedHead) {
    return [`checked-out head ${String(artifact?.resolved?.headSha)} does not match HEAD_SHA ${expectedHead}`]
  }
  return []
}

function beforeArtifactIdentityReasons(beforeArtifact, artifact) {
  if (beforeArtifact === null || typeof beforeArtifact !== 'object') {
    return ['pre-run gate artifact is missing']
  }
  const reasons = []
  if (beforeArtifact.resolved?.headSha !== artifact?.resolved?.headSha) {
    reasons.push('pre-run head does not match the post-run head')
  }
  if (beforeArtifact.resolved?.baseSha !== artifact?.resolved?.baseSha) {
    reasons.push('pre-run base does not match the post-run base')
  }
  if (beforeArtifact.diff?.sha256 !== artifact?.diff?.sha256) {
    reasons.push('pre-run diff SHA-256 does not match the post-run diff')
  }
  return reasons
}

function beforeArtifactDirtyReason(beforeArtifact) {
  return Array.isArray(beforeArtifact?.porcelain) && beforeArtifact.porcelain.length > 0
    ? [`pre-run worktree was dirty: ${porcelainSummary(beforeArtifact.porcelain)}`]
    : []
}

function commandReasons(commands) {
  const reasons = []
  for (const command of commands) {
    if (!command.blocking) continue
    if (command.exitCode === null) reasons.push(`blocking command ${command.name} has no exit code`)
    else if (command.exitCode !== 0) reasons.push(`blocking command ${command.name} exited ${String(command.exitCode)}`)
  }
  return reasons
}

export function heavyDecision({ artifact, beforeArtifact, expectedHead, currentMain, commands, baseIsAncestor }) {
  const reasons = [
    ...headIdentityReasons(artifact, expectedHead),
    ...beforeArtifactIdentityReasons(beforeArtifact, artifact),
    ...beforeArtifactDirtyReason(beforeArtifact),
  ]
  if (!Array.isArray(artifact?.porcelain) || artifact.porcelain.length > 0) {
    reasons.push(`post-run worktree is dirty: ${porcelainSummary(artifact?.porcelain)}`)
  }
  if (!baseIsAncestor) reasons.push('tested base is no longer an ancestor of the head')
  if (typeof currentMain !== 'string' || !COMMIT_SHA.test(currentMain)) {
    reasons.push('current main is not a full commit SHA')
  }
  reasons.push(...commandReasons(commands))
  return { pass: reasons.length === 0, reasons }
}

/**
 * Build the machine-readable result written to `heavy-result.json`.
 *
 * @param {{artifact: object, currentMain: string, commands: Array<object>,
 *   decision: {pass: boolean, reasons: string[]}, baseIsAncestor: boolean}} input Result inputs.
 * @returns {object} Versioned heavy result.
 */
export function buildHeavyResult(input) {
  return {
    formatVersion: 1,
    head: input.artifact.resolved.headSha,
    base: input.artifact.resolved.baseSha,
    currentMain: input.currentMain,
    diffSha256: input.artifact.diff.sha256,
    porcelain: input.artifact.porcelain,
    clean: input.artifact.porcelain.length === 0,
    baseIsAncestor: input.baseIsAncestor,
    commands: input.commands.map((command) => ({
      name: command.name,
      command: command.command,
      blocking: command.blocking,
      exitCode: command.exitCode,
    })),
    result: input.decision.pass ? 'pass' : 'fail',
    reasons: input.decision.reasons,
  }
}

/**
 * Write the result file with one trailing newline.
 *
 * @param {string} path Result path.
 * @param {object} result Versioned result.
 */
export function writeHeavyResult(path, result) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`)
}

/**
 * Render the commit-status description for the observe result.
 *
 * @param {{pass: boolean, reasons: string[]}} decision Heavy decision.
 * @returns {string} Description of at most 140 characters.
 */
export function heavyStatusDescription(decision) {
  const text = decision.pass
    ? 'heavy: passed'
    : `blocked: ${decision.reasons[0] ?? 'heavy result blocked'}`
  return text.length <= 140 ? text : `${text.slice(0, 137)}...`
}

/**
 * Publish the heavy commit status and its non-required display check.
 *
 * The display check is best effort: the commit status carries the auditable
 * verdict even when the Checks API is unavailable.
 *
 * @param {{token: string, checkToken?: string, repository: string, apiUrl: string,
 *   head: string, decision: {pass: boolean, reasons: string[]}, result: object,
 *   detailsUrl: string, fetchImpl?: typeof fetch}} input Publication inputs.
 * @returns {Promise<{status: object, check: object|null, checkError: string|null}>} Published identities.
 */
export async function publishHeavy(input) {
  const token = input.token
  const status = await publishGateStatus({
    token,
    repository: input.repository,
    apiUrl: input.apiUrl,
    head: input.head,
    state: input.decision.pass ? 'success' : 'failure',
    description: heavyStatusDescription(input.decision),
    detailsUrl: input.detailsUrl,
    context: HEAVY_GATE_CONTEXT,
    fetchImpl: input.fetchImpl,
  })
  let check = null
  let checkError = null
  try {
    check = await publishGateCheck({
      token: input.checkToken ?? token,
      repository: input.repository,
      apiUrl: input.apiUrl,
      head: input.head,
      name: HEAVY_DISPLAY_CHECK,
      conclusion: input.decision.pass ? 'success' : 'failure',
      title: input.decision.pass ? 'heavy-gate: pass' : 'heavy-gate: blocked',
      summary: JSON.stringify(input.result),
      detailsUrl: input.detailsUrl,
      fetchImpl: input.fetchImpl,
    })
  } catch (error) {
    checkError = error instanceof Error ? error.message : String(error)
  }
  return { status, check, checkError }
}

function publisherConfig() {
  const workspace = process.env.HEAVY_WORKSPACE ?? process.env.GATE_WORKSPACE ?? process.cwd()
  return {
    token: requiredEnv('GH_TOKEN'),
    checkToken: process.env.GATE_CHECK_TOKEN || requiredEnv('GH_TOKEN'),
    repository: requiredEnv('GITHUB_REPOSITORY'),
    expectedHead: requiredEnv('HEAD_SHA'),
    apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
    runUrl: process.env.RUN_URL ?? '',
    workspace,
    baseRef: process.env.HEAVY_BASE_REF ?? 'origin/main',
    commandsPath: requiredEnv('HEAVY_COMMANDS_FILE'),
    beforePath: process.env.HEAVY_BEFORE_ARTIFACT ?? '',
    resultPath: process.env.HEAVY_RESULT_PATH ?? resolve(workspace, 'heavy-result.json'),
  }
}

async function publishFromGit(config) {
  const artifact = collectGateArtifact(['--base', config.baseRef, '--head', config.expectedHead], config.workspace)
  const beforeArtifact = readOptionalJson(config.beforePath)
  const currentMain = await fetchCurrentMainSha({
    token: config.token,
    repository: config.repository,
    apiUrl: config.apiUrl,
  })
  const commands = mergeCommandResults(readCommandResults(config.commandsPath))
  const baseIsAncestor = isAncestor(config.workspace, artifact.resolved.baseSha, artifact.resolved.headSha)
  const decision = heavyDecision({
    artifact,
    beforeArtifact,
    expectedHead: config.expectedHead,
    currentMain,
    commands,
    baseIsAncestor,
  })
  const result = buildHeavyResult({ artifact, currentMain, commands, decision, baseIsAncestor })
  writeHeavyResult(config.resultPath, result)
  const published = await publishHeavy({
    token: config.token,
    checkToken: config.checkToken,
    repository: config.repository,
    apiUrl: config.apiUrl,
    head: artifact.resolved.headSha,
    decision,
    result,
    detailsUrl: config.runUrl,
  })
  if (published.checkError !== null) throw new Error(`display check not published: ${published.checkError}`)
  return { decision, published, resultPath: config.resultPath }
}

async function publishFailure(config) {
  try {
    await publishGateStatus({
      token: config.token,
      repository: config.repository,
      apiUrl: config.apiUrl,
      head: config.expectedHead,
      state: 'error',
      description: 'heavy publisher failed',
      detailsUrl: config.runUrl,
      context: HEAVY_GATE_CONTEXT,
    })
  } catch (statusError) {
    process.stderr.write(`publish-heavy: error status not published: ${statusError instanceof Error ? statusError.message : String(statusError)}\n`)
  }
}

async function main() {
  let config = null
  try {
    config = publisherConfig()
    const output = await publishFromGit(config)
    process.stdout.write(`${JSON.stringify(output)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`publish-heavy: ${message}\n`)
    if (config !== null) await publishFailure(config)
    process.exitCode = 1
  }
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  await main()
}
