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
  for (const token of ['docs/PLAN.md', 'docs/AGENTS.md', 'docs/testing.md', 'docs/publish.json', 'docs/handoff/README.md', 'docs/design/README.md', '.agents/skills/write-docs/SKILL.md', '.agents/skills/prose-standard/SKILL.md', '.agents/skills/trim-cot-leakage/SKILL.md']) {
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
  errors.push(...exportAuditErrors(root))
  errors.push(...staleNameErrors(iterFiles(root, STALE_NAME_SCOPE.patterns, STALE_NAME_SCOPE.exclude)))
  return errors
}

/**
 * Dependency-free source hygiene rules (audit item 9).
 *
 * Each rule names the kind of text it forbids and the tree it applies to:
 * `console` bypasses the host logger, `debugger` ships a pause, `@ts-ignore`
 * silences a type error instead of narrowing the value, and `test.skip`/
 * `test.only` narrow the suite silently. Enforced by the gate rather than
 * ESLint/Prettier so the repository keeps its zero-lint-dependency toolchain.
 */
const HYGIENE_RULES = [
  {
    id: 'src-console',
    root: 'src',
    extensions: ['.ts', '.tsx'],
    pattern: /\bconsole\s*\./,
    sample: 'console.log("debug")',
    message: 'src/ must log through ctx.logger, not console',
  },
  {
    id: 'src-debugger',
    root: 'src',
    extensions: ['.ts', '.tsx'],
    pattern: /\bdebugger\b/,
    sample: 'debugger',
    message: 'src/ must not keep a debugger statement',
  },
  {
    id: 'src-ts-ignore',
    root: 'src',
    extensions: ['.ts', '.tsx'],
    pattern: /@ts-ignore\b/,
    sample: '// @ts-ignore',
    message: 'src/ must not suppress a type error with @ts-ignore',
  },
  {
    id: 'tests-skip-only',
    root: 'tests',
    extensions: ['.mjs'],
    pattern: /\btest\s*\.\s*(?:skip|only)\b/,
    sample: 'test.only("narrowed", () => {})',
    message: 'tests/ must not skip or narrow the suite with test.skip/.only',
  },
]

/** Violations of one rule in one file's text. */
function hygieneRuleErrors(rule, rel, text) {
  if (!rel.startsWith(`${rule.root}/`) || !rule.extensions.some((extension) => rel.endsWith(extension))) return []
  const errors = []
  text.split('\n').forEach((line, index) => {
    if (rule.pattern.test(line)) errors.push(`${rel}:${index + 1}: ${rule.message}`)
  })
  return errors
}

/** Every source-hygiene violation under the repository root. */
function hygieneErrors() {
  const errors = []
  for (const rule of HYGIENE_RULES) {
    for (const [rel, text] of iterFiles(root, [`${rule.root}/**`])) {
      errors.push(...hygieneRuleErrors(rule, rel, text))
    }
  }
  return errors
}

/**
 * Runtime exports used only outside their own file, measured by identifier
 * occurrence rather than by a TypeScript parse.
 *
 * Textual counting is deliberate: this is an advisory audit for dead and
 * test-only surface, not a type checker. A mention in a comment counts as a
 * reference, so the audit can miss a dead export; it cannot invent one in a
 * tree where the name does not occur at all. Type-only exports are out of
 * scope; `tsc --noEmit` owns type usage, and this audit owns the values a
 * runtime module exposes to another module.
 */
const EXPORT_BASELINE_PATH = 'tools/export-baseline.json'
const HOST_ENTRY = 'src/app/apply.ts'
const RUNTIME_EXPORT_DECLARATION = /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm

function escapeName(name) {
  return name.replace(/[$]/g, '\\$')
}

function nameOccurrences(text, name) {
  return (text.match(new RegExp(`\\b${escapeName(name)}\\b`, 'g')) ?? []).length
}

function runtimeDeclarationCount(text, name) {
  const pattern = new RegExp(
    `^export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${escapeName(name)}\\b`,
    'gm',
  )
  return (text.match(pattern) ?? []).length
}

/**
 * Categorize runtime exports from `sources` ([relative path, text] pairs) and
 * `tests` (same shape).
 *
 * @returns {{dead: Array<{name: string, files: string[]}>, testOnly: Array<{name: string, files: string[]}>, overExported: Array<{name: string, files: string[]}>}}
 *   Dead: never referenced beyond the declaration. Test-only: referenced only
 *   by tests. Over-exported: referenced only inside the declaring file, so the
 *   `export` keyword can be dropped on the next touch.
 */
function exportAuditCategories(sources, tests) {
  const owners = new Map()
  for (const [rel, text] of sources) {
    if (rel === HOST_ENTRY) continue
    for (const match of text.matchAll(RUNTIME_EXPORT_DECLARATION)) {
      if (!owners.has(match[1])) owners.set(match[1], new Set())
      owners.get(match[1]).add(rel)
    }
  }
  const report = { dead: [], testOnly: [], overExported: [] }
  for (const [name, ownerFiles] of owners) {
    let declarations = 0
    let inOwnerFiles = 0
    for (const rel of ownerFiles) {
      const text = sources.find(([file]) => file === rel)?.[1] ?? ''
      declarations += runtimeDeclarationCount(text, name)
      inOwnerFiles += nameOccurrences(text, name)
    }
    let total = inOwnerFiles
    const external = []
    for (const [rel, text] of sources) {
      if (ownerFiles.has(rel)) continue
      const count = nameOccurrences(text, name)
      total += count
      if (count > 0) external.push(rel)
    }
    let testReferences = 0
    for (const [, text] of tests) testReferences += nameOccurrences(text, name)
    total += testReferences
    const entry = { name, files: [...ownerFiles].sort() }
    if (external.length > 0) continue
    if (testReferences > 0) report.testOnly.push(entry)
    else if (total > declarations) report.overExported.push(entry)
    else report.dead.push(entry)
  }
  const byName = (a, b) => a.name.localeCompare(b.name)
  report.dead.sort(byName)
  report.testOnly.sort(byName)
  report.overExported.sort(byName)
  return report
}

/** Problems from comparing one audit report with the reviewed baseline. */
function exportAuditProblems(report, baseline) {
  const errors = []
  const listed = new Set(baseline.testOnly)
  for (const entry of report.dead) {
    errors.push(
      `${entry.files.join(', ')}: export '${entry.name}' is referenced nowhere; delete it or give it a production caller`,
    )
  }
  for (const entry of report.testOnly) {
    if (listed.has(entry.name)) continue
    errors.push(
      `${entry.files.join(', ')}: export '${entry.name}' is referenced only by tests and is not in ${EXPORT_BASELINE_PATH}; ` +
        'add a reason there or give production code a caller',
    )
  }
  for (const name of listed) {
    if (report.testOnly.some((entry) => entry.name === name)) continue
    errors.push(`${EXPORT_BASELINE_PATH}: '${name}' is no longer a test-only export; shrink the baseline`)
  }
  return errors
}

/** Validate the reviewed export baseline; a malformed file cannot be an allowlist. */
function exportBaselineProblems(baseline) {
  const problems = []
  if (typeof baseline !== 'object' || baseline === null || Array.isArray(baseline)) return ['baseline must be an object']
  if (typeof baseline.why !== 'string' || baseline.why.trim() === '') problems.push('baseline needs a non-empty why')
  if (typeof baseline.reviewBy !== 'string' || baseline.reviewBy.trim() === '') problems.push('baseline needs a non-empty reviewBy')
  if (!Array.isArray(baseline.testOnly)) {
    problems.push('baseline needs a testOnly array')
    return problems
  }
  const seen = new Set()
  baseline.testOnly.forEach((name, index) => {
    if (typeof name !== 'string' || name.trim() === '') problems.push(`baseline testOnly[${index}] must be a non-empty string`)
    else if (seen.has(name)) problems.push(`baseline lists '${name}' twice`)
    else seen.add(name)
  })
  return problems
}

/** Read the export baseline; a missing or malformed baseline is a gate defect. */
function readExportBaseline() {
  if (!exists(EXPORT_BASELINE_PATH)) return { error: `${EXPORT_BASELINE_PATH} is missing; the export audit has no reviewed allowlist` }
  let baseline
  try {
    baseline = JSON.parse(read(EXPORT_BASELINE_PATH))
  } catch (error) {
    return { error: `cannot read ${EXPORT_BASELINE_PATH}: ${error.message}` }
  }
  const problems = exportBaselineProblems(baseline)
  return problems.length > 0 ? { error: problems.join('; ') } : { baseline }
}

function exportAuditErrors(auditRoot) {
  const sources = iterFiles(auditRoot, ['src/**']).filter(([rel]) => /\.(ts|tsx)$/.test(rel))
  const tests = iterFiles(auditRoot, ['tests/**']).filter(([rel]) => rel.endsWith('.mjs'))
  const report = exportAuditCategories(sources, tests)
  const readBaseline = readExportBaseline()
  if (readBaseline.error !== undefined) return [readBaseline.error]
  const errors = exportAuditProblems(report, readBaseline.baseline)
  if (report.overExported.length > 0) {
    console.log(
      `export-audit: ${report.overExported.length} export(s) are used only inside their own module; ` +
        'drop the export keyword when touching them (`--print-export-audit` lists them)',
    )
  }
  return errors
}

/**
 * Names and counts that stopped being true. The scope is current-state prose:
 * source, the root guides, the docs root (except the two plan/history files and
 * the glossary of retired wording), and the skills. Historical records under
 * `docs/handoff/` and `.agents/notes/` keep their old names, and tests keep
 * negative assertions.
 */
const STALE_NAME_RULES = [
  { pattern: /\bcowork_probe\b/, message: 'the M0 cowork_probe tool was removed' },
  { pattern: /\bcowork_identity_probe\b/, message: 'the M0 cowork_identity_probe tool was removed' },
  { pattern: /\bcowork-probe\b/, message: 'the M0 cowork-probe preset was removed' },
  { pattern: /\bprobe-engine\.ts\b/, message: 'src/probe-engine.ts was removed' },
  { pattern: /\bprobe-store\.ts\b/, message: 'src/probe-store.ts was removed' },
  { pattern: /\bsrc\/router\.ts\b/, message: 'src/router.ts was replaced by src/routing.ts' },
  { pattern: /\bcowork-thread\b/, message: 'the cowork-thread preset was removed' },
  { pattern: /(?:19|十五)\s*(?:个工具|tools)\b/i, message: 'the tool count is 22, not 19' },
  { pattern: /(?:15|十五)\s*(?:个工具|tools)\b/i, message: 'the tool count is 22, not 15' },
  { pattern: /(?:4|四)\s*(?:个|个\s*)?presets?\b/i, message: 'there are three presets, not four' },
  { pattern: /(?:6|六)\s*(?:条)?\s*(?:路由|routes)\b/i, message: 'the panel API has ten routes, not six' },
]
const STALE_NAME_SCOPE = {
  patterns: ['src/**', 'README.md', 'AGENTS.md', '.agents/skills/**', 'docs/*.md'],
  exclude: [
    // Plan files are milestone records; their completed sections cite old names.
    'docs/PLAN.md',
    'docs/PLAN-V0.2.md',
    // Historical delivery records.
    'docs/handoff/*',
    'docs/design/*',
    // The plain-language table quotes retired wording on purpose.
    'docs/plain-language.md',
  ],
}

const REMOVAL_MARKER = /(?:已删除|已移除|删除|removed|retired|退役)/i

function staleNameErrors(files) {
  const errors = []
  for (const [rel, text] of files) {
    text.split('\n').forEach((line, index) => {
      // A line that explicitly marks the name as removed is a true migration
      // note, not a stale instruction; only unflagged mentions are red.
      if (REMOVAL_MARKER.test(line)) return
      for (const rule of STALE_NAME_RULES) {
        if (rule.pattern.test(line)) {
          errors.push(`${rel}:${index + 1}: ${rule.message}: ${line.trim().slice(0, 120)}`)
        }
      }
    })
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
    {
      name: 'export audit: a dead export is red',
      fail: () => exportAuditCategories(
        [['src/a.ts', 'export function dead() { return 1 }\n']],
        [],
      ).dead.some((entry) => entry.name === 'dead'),
    },
    {
      name: 'export audit: a new test-only export is red while a baselined one stays green',
      fail: () => {
        const sources = [['src/a.ts', 'export function pinned() { return 1 }\nexport function fresh() { return 2 }\n']]
        const tests = [['tests/a.test.mjs', "import { pinned, fresh } from '../src/a.ts'\n"]]
        const problems = exportAuditProblems(
          exportAuditCategories(sources, tests),
          { why: 'self-test', reviewBy: 'self-test', testOnly: ['pinned'] },
        )
        return problems.some((problem) => problem.includes("'fresh'"))
          && !problems.some((problem) => problem.includes("'pinned'"))
      },
    },
    {
      name: 'export audit: a stale baseline entry is red',
      fail: () => exportAuditProblems(
        exportAuditCategories([['src/a.ts', 'export const used = 1\n']], []),
        { why: 'self-test', reviewBy: 'self-test', testOnly: ['gone'] },
      ).some((problem) => problem.includes("'gone'")),
    },
    {
      name: 'stale name: a removed tool name is red',
      fail: () => staleNameErrors([['src/a.ts', "export const label = 'cowork_probe'\n"]]).length > 0,
    },
    {
      name: 'stale name: a current tool name is green',
      fail: () => staleNameErrors([['src/a.ts', "export const label = 'cowork_project_init'\n"]]).length === 0,
    },
    {
      name: 'stale name: an explicit removal note is green',
      fail: () => staleNameErrors([['README.md', '- `cowork-thread` 已删除，改用 `cowork-topic`。\n']]).length === 0,
    },
  ]
  let failed = 0
  for (const testCase of cases) {
    if (!testCase.fail()) {
      console.error(`self-test failed: project rule "${testCase.name}" did not go red`)
      failed += 1
    }
  }
  for (const rule of HYGIENE_RULES) {
    const rel = `${rule.root}/self-test${rule.extensions[0]}`
    if (hygieneRuleErrors(rule, rel, `${rule.sample}\n`).length === 0) {
      console.error(`self-test failed: hygiene rule "${rule.id}" did not go red`)
      failed += 1
    }
    if (hygieneRuleErrors(rule, rel, 'export const clean = 1\n').length !== 0) {
      console.error(`self-test failed: hygiene rule "${rule.id}" flagged clean source`)
      failed += 1
    }
  }
  if (failed > 0) return false
  console.log(`PASS project-rules: ${cases.length + HYGIENE_RULES.length * 2} negative controls`)
  return true
}

function usage() {
  console.log(`Usage:
  node tools/check-invariants.mjs
  node tools/check-invariants.mjs --self-test
  node tools/check-invariants.mjs --list
  node tools/check-invariants.mjs --print-export-audit
  node tools/check-invariants.mjs --changed BASE [--worktree-only]`)
}

function parseArgs(argv) {
  const args = { selfTest: false, list: false, printExportAudit: false, changed: null, worktreeOnly: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--self-test') args.selfTest = true
    else if (value === '--list') args.list = true
    else if (value === '--print-export-audit') args.printExportAudit = true
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

if (args.printExportAudit) {
  const report = exportAuditCategories(
    iterFiles(root, ['src/**']).filter(([rel]) => /\.(ts|tsx)$/.test(rel)),
    iterFiles(root, ['tests/**']).filter(([rel]) => rel.endsWith('.mjs')),
  )
  console.log(JSON.stringify({
    dead: report.dead.map((entry) => entry.name),
    testOnly: report.testOnly.map((entry) => entry.name),
    overExported: report.overExported.map((entry) => entry.name),
  }, null, 2))
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

const hygiene = hygieneErrors()
if (hygiene.length > 0) {
  console.log('FAIL source-hygiene')
  for (const error of hygiene) console.log(`  ${error}`)
  violations += hygiene.length
} else {
  console.log('PASS source-hygiene')
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
