import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const read = (rel) => readFileSync(resolve(root, rel), 'utf8')
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'lib', 'dist'])

function listMarkdownFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (IGNORED_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listMarkdownFiles(full))
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

function patternMatches(pattern, rel) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(rel)
}

function sectionBodyLines(doc, heading) {
  const lines = doc.split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
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

test('tools/workflow.json declares unique surfaces with non-empty evidence', () => {
  const workflow = JSON.parse(read('tools/workflow.json'))
  assert.equal(workflow.version, 1)
  assert.ok(Array.isArray(workflow.surfaces) && workflow.surfaces.length > 0)
  const names = new Set()
  for (const surface of workflow.surfaces) {
    assert.ok(surface.name, 'surface must have a name')
    assert.ok(!names.has(surface.name), `duplicate surface name: ${surface.name}`)
    names.add(surface.name)
    assert.ok(Array.isArray(surface.patterns) && surface.patterns.length > 0, `${surface.name} needs patterns`)
    assert.ok(Array.isArray(surface.evidence) && surface.evidence.length > 0, `${surface.name} needs evidence`)
    assert.ok(surface.evidence.every((e) => typeof e === 'string' && e.trim()), `${surface.name} has an empty evidence entry`)
    assert.ok(typeof surface.why === 'string' && surface.why.trim(), `${surface.name} needs why`)
  }
  assert.ok(names.has('agent-skills'), 'workflow must declare the agent-skills surface')
  assert.ok(Array.isArray(workflow.checks) && workflow.checks.length > 0, 'workflow must declare document checks')
  const checkIds = new Set()
  for (const check of workflow.checks) {
    assert.ok(check.id, 'document check must have an id')
    assert.ok(!checkIds.has(check.id), `duplicate document check id: ${check.id}`)
    checkIds.add(check.id)
    assert.ok(check.kind, `${check.id} needs a kind`)
    assert.ok(Array.isArray(check.patterns) && check.patterns.length > 0, `${check.id} needs patterns`)
  }
  for (const id of ['markdown-links', 'doc-index-reachability', 'kind-manifest', 'markdown-size']) {
    assert.ok(checkIds.has(id), `workflow missing document check: ${id}`)
  }
  const kinds = JSON.parse(read('docs/kinds.json'))
  assert.ok(Array.isArray(kinds.kinds) && kinds.kinds.length > 0, 'docs/kinds.json needs a non-empty kinds list')
  assert.ok(Array.isArray(kinds.assignments) && kinds.assignments.length > 0, 'docs/kinds.json needs assignments')
})

test('the PR template carries the review and evidence sections', () => {
  const template = read('.github/pull_request_template.md')
  for (const heading of ['## Motivation', '## Changes', '## Testing', '## Evidence']) {
    assert.ok(template.includes(`${heading}\n`), `PR template is missing ${heading}`)
  }
  assert.match(template, /npm run change-scope -- --base/)
  assert.match(template, /### Not run/)
})

test('executable test lanes are wired to scripts, workflow evidence, and the testing guide', () => {
  const pkg = JSON.parse(read('package.json'))
  const workflow = JSON.parse(read('tools/workflow.json'))
  const testing = read('docs/testing.md')
  for (const script of ['test', 'test:coverage', 'test:host-smoke', 'check:lib-sync', 'change-scope', 'typecheck', 'build']) {
    assert.equal(typeof pkg.scripts?.[script], 'string', `package.json is missing script ${script}`)
  }
  const source = workflow.surfaces.find((surface) => surface.name === 'source')
  assert.ok(source, 'workflow must declare the source surface')
  for (const command of ['npm run test:coverage', 'npm run typecheck', 'npm run build', 'npm run check:lib-sync', 'npm run test:host-smoke']) {
    assert.ok(source.evidence.includes(command), `source evidence is missing: ${command}`)
  }
  const packaging = workflow.surfaces.find((surface) => surface.name === 'packaging')
  assert.ok(packaging, 'workflow must declare the packaging surface')
  for (const command of ['npm test', 'npm run build', 'npm run check:lib-sync', 'npm run test:host-smoke']) {
    assert.ok(packaging.evidence.includes(command), `packaging evidence is missing: ${command}`)
  }
  assert.ok(packaging.patterns.includes('cordis.patch.yml'), 'packaging must own the bundle patch')
  assert.ok(packaging.patterns.includes('lib/**'), 'packaging must own the tracked lib artifact')
  for (const command of ['npm run test:coverage', 'npm run test:host-smoke']) {
    assert.ok(testing.includes(command), `docs/testing.md is missing: ${command}`)
  }
})

test('AGENTS.md keeps the context budget and the required pointers', () => {
  const agents = read('AGENTS.md')
  const workflow = JSON.parse(read('tools/workflow.json'))
  const budget = workflow.checks.find((check) => check.id === 'context-budget')?.maxLines
  assert.equal(budget, 120, 'context-budget must match the reference ceiling')
  assert.ok(agents.split('\n').length <= budget, `AGENTS.md exceeds ${budget} lines`)
  for (const token of ['## Read first', '## Commands', 'docs/PLAN.md', 'tools/workflow.json']) {
    assert.ok(agents.includes(token), `AGENTS.md missing ${token}`)
  }
})

test('decision templates carry non-empty lifecycle sections', () => {
  const proposed = read('.agents/notes/proposed/TEMPLATE.md')
  const implemented = read('.agents/notes/implemented/TEMPLATE.md')
  for (const heading of ['## Problem', '## Proposal', '## Alternatives considered', '## Acceptance criteria']) {
    assert.ok(sectionHasBody(proposed, heading), `proposed TEMPLATE ${heading} is empty`)
  }
  for (const heading of ['## Problem', '## Decision', '## Alternatives considered', '## Consequences', '## Testing']) {
    assert.ok(sectionHasBody(implemented, heading), `implemented TEMPLATE ${heading} is empty`)
  }
})

test('note templates use the lifecycle header', () => {
  const proposed = read('.agents/notes/proposed/TEMPLATE.md')
  const implemented = read('.agents/notes/implemented/TEMPLATE.md')
  assert.match(proposed, /^# Proposal: /m)
  assert.match(implemented, /^# Decision: /m)
  for (const doc of [proposed, implemented]) {
    assert.match(doc, /^Status: /m)
    assert.match(doc, /^Date: /m)
    assert.match(doc, /^Class: /m)
  }
})

test('publish.json classifies every Markdown file exactly once', () => {
  const manifest = JSON.parse(read('docs/publish.json'))
  assert.ok(Array.isArray(manifest.public), 'public must be an array')
  assert.ok(Array.isArray(manifest.internal), 'internal must be an array')
  for (const entry of manifest.public) {
    assert.equal(typeof entry, 'string')
    assert.ok(!entry.includes('*'), `public entry may not use a glob: ${entry}`)
    assert.ok(existsSync(resolve(root, entry)), `public entry has no file: ${entry}`)
  }
  for (const entry of manifest.internal) {
    assert.ok(entry.pattern, 'internal entry needs pattern')
    assert.ok(entry.reason, `internal entry needs reason: ${entry.pattern}`)
  }
  const files = listMarkdownFiles(root).map((f) => relative(root, f))
  for (const rel of files) {
    let matches = 0
    for (const entry of manifest.public) if (patternMatches(entry, rel)) matches += 1
    for (const entry of manifest.internal) if (patternMatches(entry.pattern, rel)) matches += 1
    assert.equal(matches, 1, `${rel} must match exactly one publication declaration`)
  }
})

test('standing policy homes keep their required sections', () => {
  const homes = [
    ['docs/AGENTS.md', ['## Document kinds', '## Directory layout', '## One home per fact', '## Tutorial or reference', '## Generated, mirrored, or linked', '## Budgets', '## Publication', '## The slop checklist', '## Known limits']],
    ['docs/testing.md', ['## Tiers', '## Determinism', '## Flake policy']],
    ['.agents/notes/README.md', ['## When to write one', '## Classes', '## Flow']],
  ]
  for (const [rel, sections] of homes) {
    const doc = read(rel)
    for (const section of sections) assert.ok(doc.includes(section), `${rel} missing ${section}`)
  }
})

test('skills carry a load trigger, four sections, and an index entry', () => {
  const skillsDir = resolve(root, '.agents/skills')
  const skills = readdirSync(skillsDir).filter((name) => statSync(join(skillsDir, name)).isDirectory())
  assert.ok(skills.includes('write-docs'), 'write-docs skill is missing')
  assert.ok(skills.includes('prose-standard'), 'prose-standard skill is missing')
  assert.ok(skills.includes('trim-cot-leakage'), 'trim-cot-leakage skill is missing')
  for (const name of ['code-review', 'pre-push-checks', 'pr-description', 'merging-stacked-prs', 'find-simplifications']) {
    assert.ok(skills.includes(name), `${name} skill is missing`)
  }
  assert.equal(skills.some((name) => name.startsWith('dsh-')), false, 'skill directories must not use a dsh- prefix')
  assert.ok(!skills.includes('trim-prose'), 'trim-prose must be renamed, not duplicated')
  assert.ok(existsSync(resolve(skillsDir, 'prose-standard', 'references', 'examples.md')), 'prose-standard examples are missing')
  for (const name of skills) {
    const rel = join('.agents/skills', name, 'SKILL.md')
    const doc = read(rel)
    assert.match(doc, /^---\n/, `${rel} has no front matter`)
    const description = doc.match(/^description:\s*(.+)$/m)?.[1] ?? ''
    assert.match(description, /^Use (?:when|before|after|during)\b/, `${rel} description is not a load trigger`)
    for (const heading of ['## When to use', '## How', '## Verification', '## Anti-patterns']) {
      assert.ok(sectionHasBody(doc, heading), `${rel} ${heading} is empty`)
    }
  }
  const index = read('docs/README.md')
  assert.ok(index.includes('.agents/skills/write-docs/SKILL.md'), 'docs index does not route to write-docs')
  assert.ok(index.includes('.agents/skills/prose-standard/SKILL.md'), 'docs index does not route to prose-standard')
  assert.ok(index.includes('.agents/skills/trim-cot-leakage/SKILL.md'), 'docs index does not route to trim-cot-leakage')
  for (const name of ['code-review', 'pre-push-checks', 'pr-description', 'merging-stacked-prs', 'find-simplifications']) {
    assert.ok(index.includes(`.agents/skills/${name}/SKILL.md`), `docs index does not route to ${name}`)
  }
  const skillsIndex = read('.agents/skills/README.md')
  for (const name of ['code-review', 'pre-push-checks', 'pr-description', 'merging-stacked-prs', 'find-simplifications']) {
    assert.ok(skillsIndex.includes(`(${name}/SKILL.md)`), `skills index does not route to ${name}`)
  }
})

test('handoff records are flat and design records are grouped by feature', () => {
  const docsRoot = resolve(root, 'docs')
  const rootMarkdown = readdirSync(docsRoot).filter((name) => name.endsWith('.md'))
  assert.deepEqual(
    rootMarkdown.filter((name) => /_(HANDOFF|RESULT|RECON)\.md$/.test(name)),
    [],
    'handoff/result/recon records must not live at the docs root',
  )
  assert.ok(existsSync(resolve(root, 'docs/handoff/README.md')), 'docs/handoff/README.md is missing')
  assert.ok(existsSync(resolve(root, 'docs/design/README.md')), 'docs/design/README.md is missing')
  for (const removed of ['docs/handoffs', 'docs/archived', 'docs/discussion']) {
    assert.equal(existsSync(resolve(root, removed)), false, `${removed} must not exist`)
  }
})

test('record templates trace each criterion to a declared surface', () => {
  const workflow = JSON.parse(read('tools/workflow.json'))
  const surfaces = new Set(workflow.surfaces.map((surface) => surface.name))
  for (const [rel, heading] of [
    ['.agents/notes/proposed/TEMPLATE.md', '## Acceptance criteria'],
    ['.agents/notes/implemented/TEMPLATE.md', '## Testing'],
  ]) {
    const bullets = (sectionBodyLines(read(rel), heading) ?? [])
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s/.test(line) || /^\d+\.\s/.test(line))
    assert.ok(bullets.length > 0, `${rel} has no criterion bullets`)
    for (const bullet of bullets) {
      assert.match(bullet, /\[[A-Za-z][A-Za-z0-9]*-?\d+\]/, `${rel} criterion has no [id]: ${bullet}`)
      const cited = [...bullet.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((match) => match[1])
      assert.ok(cited.some((name) => surfaces.has(name)), `${rel} criterion cites no declared surface: ${bullet}`)
    }
  }
})

test('README links the product plan', () => {
  const readme = read('README.md')
  assert.ok(readme.includes('docs/PLAN.md'))
})

test('the test suite keeps one definition of its shared setup', () => {
  const testFiles = readdirSync(resolve(root, 'tests'))
    .filter((name) => name.endsWith('.mjs'))
  for (const name of testFiles) {
    // This file holds the patterns themselves; it imports no fixture.
    if (name === 'workflow.test.mjs') continue
    const source = read(join('tests', name))
    for (const [pattern, why] of [
      [/async function withRepo\(/, 'withRepo'],
      [/const HOOK_SOURCE =/, 'HOOK_SOURCE'],
      [/async function seedRequest\(/, 'seedRequest'],
      [/async function seedProject\(/, 'seedProject'],
    ]) {
      assert.equal(pattern.test(source), false, `${name} must import the shared ${why}`)
    }
  }
  const fixtures = read(join('tests', 'support', 'inbox-fixtures.mjs'))
  for (const pattern of [
    /export async function withRepo\(/,
    /export function makeTopicFixture\(/,
    /export function makeSeedProject\(/,
    /export function makeSeedRequest\(/,
    /const TOPIC_TEMPLATE = /,
  ]) {
    assert.equal((fixtures.match(new RegExp(pattern.source, 'g')) ?? []).length, 1, pattern.source)
  }
  const surface = read(join('tests', 'support', 'public-surface.mjs'))
  assert.equal((surface.match(/const PANEL_ROUTES = /g) ?? []).length, 1)
  assert.equal((surface.match(/const BUSINESS_TOOL_ORDER = /g) ?? []).length, 1)
  for (const name of ['dev-gate.test.mjs', 'api.test.mjs', 'api-contract.test.mjs', 'project-tools.test.mjs', 'source-budget.test.mjs']) {
    assert.match(read(join('tests', name)), /public-surface\.mjs/, `${name} must use the shared public surface`)
  }
})

