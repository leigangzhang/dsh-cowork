#!/usr/bin/env node
/**
 * Publish the observe-mode `heavy-gate` result on one dispatched head.
 *
 * The heavy workflow records one `{name, exitCode}` row per command in a JSONL
 * file, then invokes this publisher. The publisher recomputes the current
 * gate-artifact identity, compares it with the identity captured before the
 * lane started, fetches current `main`, writes `heavy-result.json`, and
 * publishes a commit status plus a non-required display check.
 *
 * A published blocked result is still a successful publisher run: the status
 * and result file own the verdict. Only an unexpected publisher failure exits
 * non-zero, after attempting to write an `error` status on the same head.
 *
 * The publisher never checks out or executes pull-request code; the workflow
 * already ran the explicitly dispatched branch on the self-hosted runner.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectGateArtifact } from '../review/gate-artifact.mjs'
import { isAncestor, publishGateCheck, publishGateStatus } from './publish-gate.mjs'

/** Required status context once the derived gate consumes the heavy result. */
export const HEAVY_GATE_CONTEXT = 'heavy-gate'
/** Non-required display check; never add this name to required contexts. */
export const HEAVY_DISPLAY_CHECK = 'heavy-gate-result'
/** One row per command the heavy workflow must record. */
export const HEAVY_COMMANDS = Object.freeze([
  Object.freeze({ name: 'typecheck', command: 'npm run typecheck', blocking: true }),
  Object.freeze({ name: 'build', command: 'npm run build', blocking: true }),
  Object.freeze({ name: 'host-smoke', command: 'DSH_HOST_SMOKE_STRICT=1 npm run test:host-smoke', blocking: true }),
  Object.freeze({ name: 'coverage-layered', command: 'npm run test:coverage:layered -- --base <base>', blocking: true }),
  Object.freeze({ name: 'e2e-keyless', command: 'npm run test:e2e', blocking: true }),
  Object.freeze({ name: 'e2e-bash', command: 'npm run test:e2e:bash', blocking: false }),
])

const COMMIT_SHA = /^[0-9a-f]{40}$/
const API_TIMEOUT_MS = 15_000

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
export function heavyDecision({ artifact, beforeArtifact, expectedHead, currentMain, commands, baseIsAncestor }) {
  const reasons = []
  if (typeof expectedHead !== 'string' || !COMMIT_SHA.test(expectedHead)) {
    reasons.push('HEAD_SHA is not a full commit SHA')
  } else if (artifact?.resolved?.headSha !== expectedHead) {
    reasons.push(`checked-out head ${String(artifact?.resolved?.headSha)} does not match HEAD_SHA ${expectedHead}`)
  }
  if (beforeArtifact === null || typeof beforeArtifact !== 'object') {
    reasons.push('pre-run gate artifact is missing')
  } else {
    if (beforeArtifact.resolved?.headSha !== artifact?.resolved?.headSha) {
      reasons.push('pre-run head does not match the post-run head')
    }
    if (beforeArtifact.resolved?.baseSha !== artifact?.resolved?.baseSha) {
      reasons.push('pre-run base does not match the post-run base')
    }
    if (beforeArtifact.diff?.sha256 !== artifact?.diff?.sha256) {
      reasons.push('pre-run diff SHA-256 does not match the post-run diff')
    }
    if (Array.isArray(beforeArtifact.porcelain) && beforeArtifact.porcelain.length > 0) {
      reasons.push(`pre-run worktree was dirty: ${porcelainSummary(beforeArtifact.porcelain)}`)
    }
  }
  if (!Array.isArray(artifact?.porcelain) || artifact.porcelain.length > 0) {
    reasons.push(`post-run worktree is dirty: ${porcelainSummary(artifact?.porcelain)}`)
  }
  if (!baseIsAncestor) reasons.push('tested base is no longer an ancestor of the head')
  if (typeof currentMain !== 'string' || !COMMIT_SHA.test(currentMain)) {
    reasons.push('current main is not a full commit SHA')
  }
  for (const command of commands) {
    if (!command.blocking) continue
    if (command.exitCode === null) reasons.push(`blocking command ${command.name} has no exit code`)
    else if (command.exitCode !== 0) reasons.push(`blocking command ${command.name} exited ${String(command.exitCode)}`)
  }
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
 * Fetch current main from the GitHub API.
 *
 * @param {{token: string, repository: string, apiUrl: string, fetchImpl?: typeof fetch}} input API inputs.
 * @returns {Promise<string>} Current main SHA.
 */
export async function fetchCurrentMain(input) {
  const response = await (input.fetchImpl ?? fetch)(`${input.apiUrl}/repos/${input.repository}/git/ref/heads/main`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${input.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`reading current main failed (${String(response.status)}): ${detail}`)
  }
  const body = await response.json()
  return body.object?.sha
}

/**
 * Render the commit-status description for the observe result.
 *
 * @param {{pass: boolean, reasons: string[]}} decision Heavy decision.
 * @returns {string} Description of at most 140 characters.
 */
export function heavyStatusDescription(decision) {
  const text = decision.pass
    ? 'observe: heavy passed'
    : `observe: blocked: ${decision.reasons[0] ?? 'heavy result blocked'}`
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

async function main() {
  const token = requiredEnv('GH_TOKEN')
  const repository = requiredEnv('GITHUB_REPOSITORY')
  const expectedHead = requiredEnv('HEAD_SHA')
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com'
  const runUrl = process.env.RUN_URL ?? ''
  const workspace = process.env.HEAVY_WORKSPACE ?? process.env.GATE_WORKSPACE ?? process.cwd()
  const baseRef = process.env.HEAVY_BASE_REF ?? 'origin/main'
  const commandsPath = requiredEnv('HEAVY_COMMANDS_FILE')
  const beforePath = process.env.HEAVY_BEFORE_ARTIFACT ?? ''
  const resultPath = process.env.HEAVY_RESULT_PATH ?? resolve(workspace, 'heavy-result.json')
  let head = expectedHead
  try {
    const artifact = collectGateArtifact(['--base', baseRef, '--head', expectedHead], workspace)
    head = artifact.resolved.headSha
    const beforeArtifact = readOptionalJson(beforePath)
    const currentMain = await fetchCurrentMain({ token, repository, apiUrl })
    const commands = mergeCommandResults(readCommandResults(commandsPath))
    const baseIsAncestor = isAncestor(workspace, artifact.resolved.baseSha, artifact.resolved.headSha)
    const decision = heavyDecision({
      artifact,
      beforeArtifact,
      expectedHead,
      currentMain,
      commands,
      baseIsAncestor,
    })
    const result = buildHeavyResult({ artifact, currentMain, commands, decision, baseIsAncestor })
    writeHeavyResult(resultPath, result)
    const published = await publishHeavy({
      token,
      checkToken: process.env.GATE_CHECK_TOKEN || token,
      repository,
      apiUrl,
      head,
      decision,
      result,
      detailsUrl: runUrl,
    })
    if (published.checkError !== null) {
      process.stderr.write(`publish-heavy: display check not published: ${published.checkError}\n`)
    }
    process.stdout.write(`${JSON.stringify({ decision, published, resultPath })}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`publish-heavy: ${message}\n`)
    try {
      await publishGateStatus({
        token,
        repository,
        apiUrl,
        head,
        state: 'error',
        description: 'observe: heavy publisher failed',
        detailsUrl: runUrl,
        context: HEAVY_GATE_CONTEXT,
      })
    } catch (statusError) {
      process.stderr.write(`publish-heavy: error status not published: ${statusError instanceof Error ? statusError.message : String(statusError)}\n`)
    }
    process.exitCode = 1
  }
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  await main()
}
