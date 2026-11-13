#!/usr/bin/env node
/**
 * dsh-cowork executable conventions runner.
 *
 * Document checks are declared in tools/workflow.json and executed by
 * tools/doc-gate-engine.mjs. This file adds the project-specific rules that do not
 * fit a generic document kind: decision-record lifecycle, skill directories, and the
 * standing entry-point pointers.
 *
 * Usage:
 *   node tools/check-invariants.mjs                 run every declared check
 *   node tools/check-invariants.mjs --self-test     prove every check kind can fail
 *   node tools/check-invariants.mjs --list          list declared document checks
 *   node tools/check-invariants.mjs --changed BASE  run only checks reading changed paths
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  changedPaths,
  iterFiles,
  listChecks,
  loadConfig,
  runChecks,
  selectChecks,
  selfTest as engineSelfTest,
} from './doc-gate-engine.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const configPath = resolve(root, 'tools/workflow.json')
const read = (rel) => readFileSync(resolve(root, rel), 'utf8')
const exists = (rel) => existsSync(resolve(root, rel))

function sectionBodyLines(doc, heading) {
  const lines = doc.split('\n')
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start < 0) return null
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break
    body.push(lines[i])
  }
  return body
}

function sectionHasBody(doc, heading) {
  const body = sectionBodyLines(doc, heading)
  return body !== null && body.some((line) => line.trim() !== '')
}

const NOTE_CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing']
const NOTE_SECTIONS = {
  proposed: ['## Problem', '## Proposal', '## Alternatives considered', '## Acceptance criteria'],
  implemented: ['## Problem', '## Decision', '## Alternatives considered', '## Consequences', '## Testing'],
}
const NOTE_CRITERIA = { proposed: '## Acceptance criteria', implemented: '## Testing' }
const PROPOSAL_ERA_HEADING = /^## (?:Proposal|Plan|Migration plan|Acceptance criteria)\b/m
const CRITERION_ID = /\[([A-Za-z][A-Za-z0-9]*-?\d+)\]/
const CRITERION_SURFACE = /`([a-z][a-z0-9-]*)`/g

function noteErrors(rel, doc, declaredSurfaces, { template = false } = {}) {
  const lifecycle = rel.includes('/proposed/') ? 'proposed' : rel.includes('/implemented/') ? 'implemented' : null
  if (lifecycle === null) return [`${rel}: note record is outside proposed/ or implemented/`]
  const errors = []
  for (const heading of NOTE_SECTIONS[lifecycle]) {
    if (!doc.includes(heading)) errors.push(`${rel}: decision-${lifecycle} missing ${heading}`)
    else if (!sectionHasBody(doc, heading)) errors.push(`${rel}: decision-${lifecycle} section is empty: ${heading}`)
  }
  if (lifecycle === 'implemented' && PROPOSAL_ERA_HEADING.test(doc)) {
    errors.push(`${rel}: implemented record keeps a proposal-era heading (Proposal/Plan/Migration plan/Acceptance criteria)`)
  }
  if (!template) {
    const lines = doc.split('\n')
    const title = lines.find((line) => line.startsWith('# ')) ?? ''
    const prefix = lifecycle === 'proposed' ? '# Proposal: ' : '# Decision: '
    if (!title.startsWith(prefix)) errors.push(`${rel}: title must start with "${prefix.trim()}"`)
    const status = doc.match(/^Status:\s*(.+)$/m)
    if (status === null) errors.push(`${rel}: missing Status: line`)
    else if (status[1].trim() !== lifecycle) errors.push(`${rel}: Status: ${status[1].trim()} disagrees with ${lifecycle}/`)
    const date = doc.match(/^Date:\s*(\d{4}-\d{2}-\d{2})$/m)
    if (date === null) errors.push(`${rel}: missing Date: line`)
    else {
      const fileDate = (rel.split('/').pop() ?? '').match(/^(\d{4}-\d{2}-\d{2})-/)
      if (fileDate !== null && fileDate[1] !== date[1]) errors.push(`${rel}: Date: ${date[1]} disagrees with filename ${fileDate[1]}`)
    }
    const cls = doc.match(/^Class:\s*(.+)$/m)
    if (cls === null) errors.push(`${rel}: missing Class: line`)
    else {
      const fromPath = rel.split('/')[3]
      const value = cls[1].trim()
      if (!NOTE_CLASSES.includes(value)) errors.push(`${rel}: unknown Class: ${value}`)
      else if (value !== fromPath) errors.push(`${rel}: Class: ${value} disagrees with folder ${fromPath}`)
    }
  }
  const criteriaHeading = NOTE_CRITERIA[lifecycle]
  const bullets = (sectionBodyLines(doc, criteriaHeading) ?? [])
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s/.test(line) || /^\d+\.\s/.test(line))
  if (bullets.length === 0) {
    errors.push(`${rel}: ${criteriaHeading} carries no criterion bullets`)
  } else {
    for (const bullet of bullets) {
      if (!CRITERION_ID.test(bullet)) errors.push(`${rel}: criterion has no [id]: ${bullet.slice(0, 60)}`)
      const cited = [...bullet.matchAll(CRITERION_SURFACE)].map((match) => match[1])
      if (!cited.some((name) => declaredSurfaces.has(name))) {
        errors.push(`${rel}: criterion cites no declared surface: ${bullet.slice(0, 60)}`)
      }
    }
  }
  return errors
}

function projectRuleErrors(config) {
  const errors = []
  const agents = read('AGENTS.md')
  for (const token of ['## Read first', '## Commands', 'docs/PLAN.md', 'tools/workflow.json']) {
    if (!agents.includes(token)) errors.push(`AGENTS.md is missing pointer: ${token}`)
  }
  const readme = read('README.md')
  for (const token of ['docs/PLAN.md', 'docs/AGENTS.md', 'docs/README.md']) {
    if (!readme.includes(token)) errors.push(`README.md is missing pointer: ${token}`)
  }
  const index = read('docs/README.md')
  for (const token of ['docs/PLAN.md', 'docs/AGENTS.md', 'docs/testing.md', 'docs/publish.json', 'docs/handoffs/README.md', '.agents/skills/write-docs/SKILL.md', '.agents/skills/prose-standard/SKILL.md', '.agents/skills/trim-cot-leakage/SKILL.md']) {
    if (!index.includes(token)) errors.push(`docs/README.md is missing pointer: ${token}`)
  }

  const skillsDir = resolve(root, '.agents/skills')
  if (!existsSync(skillsDir)) {
    errors.push('.agents/skills is missing')
  } else {
    const skillNames = readdirSync(skillsDir).filter((name) => statSync(join(skillsDir, name)).isDirectory())
    if (skillNames.length === 0) errors.push('.agents/skills contains no skill directory')
    for (const name of skillNames) {
      if (!exists(`.agents/skills/${name}/SKILL.md`)) errors.push(`.agents/skills/${name}/SKILL.md is missing`)
    }
  }

  const declaredSurfaces = new Set((config.surfaces ?? []).map((surface) => surface?.name).filter(Boolean))
  const noteTemplates = ['.agents/notes/proposed/TEMPLATE.md', '.agents/notes/implemented/TEMPLATE.md']
  for (const rel of noteTemplates) {
    if (!exists(rel)) {
      errors.push(`${rel} is missing`)
      continue
    }
    errors.push(...noteErrors(rel, read(rel), declaredSurfaces, { template: true }))
  }
  const noteRecords = iterFiles(root, ['.agents/notes/*'])
    .map(([rel]) => rel)
    .filter((rel) => /^\.agents\/notes\/(proposed|implemented)\//.test(rel) && !rel.endsWith('/TEMPLATE.md'))
  for (const rel of noteRecords) {
    errors.push(...noteErrors(rel, read(rel), declaredSurfaces))
  }
  return errors
}

function projectSelfTest() {
  const cases = [
    {
      name: 'implemented record without alternatives',
      fail: () => noteErrors(
        '.agents/notes/implemented/architecture/2026-01-01-x.md',
        '# Decision: x\n\nStatus: implemented\nDate: 2026-01-01\nClass: architecture\n\n## Problem\n\np\n\n## Decision\n\nd\n\n## Consequences\n\nc\n\n## Testing\n\n- [A1] x — `source`\n',
        new Set(['source']),
      ).some((error) => error.includes('Alternatives considered')),
    },
    {
      name: 'implemented record keeps a proposal-era heading',
      fail: () => noteErrors(
        '.agents/notes/implemented/architecture/2026-01-01-x.md',
        '# Decision: x\n\nStatus: implemented\nDate: 2026-01-01\nClass: architecture\n\n## Problem\n\np\n\n## Decision\n\nd\n\n## Alternatives considered\n\na\n\n## Consequences\n\nc\n\n## Testing\n\n- [A1] x — `source`\n\n## Acceptance criteria\n\n- [A2] y — `source`\n',
        new Set(['source']),
      ).some((error) => error.includes('proposal-era')),
    },
    {
      name: 'criterion without a declared surface',
      fail: () => noteErrors(
        '.agents/notes/implemented/architecture/2026-01-01-x.md',
        '# Decision: x\n\nStatus: implemented\nDate: 2026-01-01\nClass: architecture\n\n## Problem\n\np\n\n## Decision\n\nd\n\n## Alternatives considered\n\na\n\n## Consequences\n\nc\n\n## Testing\n\n- [A1] no owner here\n',
        new Set(['source']),
      ).some((error) => error.includes('declared surface')),
    },
  ]
  let failed = 0
  for (const testCase of cases) {
    if (!testCase.fail()) {
      console.error(`self-test failed: project rule "${testCase.name}" did not go red`)
      failed += 1
    }
  }
  if (failed > 0) return false
  console.log(`PASS project-rules: ${cases.length} negative controls`)
  return true
}

function usage() {
  console.log(`Usage:
  node tools/check-invariants.mjs
  node tools/check-invariants.mjs --self-test
  node tools/check-invariants.mjs --list
  node tools/check-invariants.mjs --changed BASE [--worktree-only]`)
}

function parseArgs(argv) {
  const args = { selfTest: false, list: false, changed: null, worktreeOnly: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--self-test') args.selfTest = true
    else if (value === '--list') args.list = true
    else if (value === '--worktree-only') args.worktreeOnly = true
    else if (value === '--help' || value === '-h') args.help = true
    else if (value === '--changed') {
      args.changed = argv[i + 1]
      if (!args.changed) throw new Error('--changed requires a base revision')
      i += 1
    } else {
      throw new Error(`unknown argument: ${value}`)
    }
  }
  if (args.worktreeOnly && !args.changed) throw new Error('--worktree-only requires --changed BASE')
  return args
}

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`check-invariants: ${error.message}`)
  usage()
  process.exit(2)
}

if (args.help) {
  usage()
  process.exit(0)
}

if (args.selfTest) {
  const engineOk = engineSelfTest()
  const projectOk = projectSelfTest()
  process.exit(engineOk && projectOk ? 0 : 1)
}

let config
try {
  config = loadConfig(configPath)
} catch (error) {
  console.error(`check-invariants: ${error.message}`)
  process.exit(2)
}

let checks = config.checks
if (args.changed) {
  try {
    const paths = changedPaths(root, args.changed, args.worktreeOnly)
    checks = selectChecks(config, paths)
    console.log(`check-invariants: ${paths.length} changed path(s); ${checks.length} of ${config.checks.length} declared check(s) read them`)
  } catch (error) {
    console.error(`check-invariants: ${error.message}`)
    process.exit(2)
  }
}

if (args.list) {
  listChecks(checks)
  process.exit(0)
}

let violations = 0
for (const [id, problems] of runChecks(root, checks)) {
  if (problems.length === 0) {
    console.log(`PASS ${id}`)
    continue
  }
  console.log(`FAIL ${id}`)
  for (const problem of problems) console.log(`  ${problem}`)
  violations += problems.length
}

if (!args.changed) {
  const projectErrors = projectRuleErrors(config)
  if (projectErrors.length > 0) {
    console.log('FAIL project-rules')
    for (const error of projectErrors) console.log(`  ${error}`)
    violations += projectErrors.length
  } else {
    console.log('PASS project-rules')
  }
}

if (violations > 0) {
  console.error(`check-invariants: ${violations} violation(s)`)
  process.exit(1)
}
console.log('check-invariants: ok')
