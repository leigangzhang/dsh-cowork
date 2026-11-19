import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
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

function isNonEmptyText(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0
}

function assertWorkflowShape(workflow) {
  assert.equal(workflow.version, 1)
  assert.ok(isNonEmptyArray(workflow.surfaces))
  assert.ok(isNonEmptyArray(workflow.checks), 'workflow must declare document checks')
}

function assertSurfaceShape(surface) {
  assert.ok(isNonEmptyArray(surface.patterns), `${surface.name} needs patterns`)
  assert.ok(isNonEmptyArray(surface.evidence), `${surface.name} needs evidence`)
  assert.ok(surface.evidence.every(isNonEmptyText), `${surface.name} has an empty evidence entry`)
  assert.ok(isNonEmptyText(surface.why), `${surface.name} needs why`)
}

function assertSurface(surface, names) {
  assert.ok(surface.name, 'surface must have a name')
  assert.ok(!names.has(surface.name), `duplicate surface name: ${surface.name}`)
  names.add(surface.name)
  assertSurfaceShape(surface)
}

function assertUniqueSurfaces(surfaces) {
  const names = new Set()
  for (const surface of surfaces) assertSurface(surface, names)
  assert.ok(names.has('agent-skills'), 'workflow must declare the agent-skills surface')
}

function assertCheck(check, ids) {
  assert.ok(check.id, 'document check must have an id')
  assert.ok(!ids.has(check.id), `duplicate document check id: ${check.id}`)
  ids.add(check.id)
  assert.ok(check.kind, `${check.id} needs a kind`)
  assert.ok(isNonEmptyArray(check.patterns), `${check.id} needs patterns`)
}

function assertDocumentChecks(checks) {
  const ids = new Set()
  for (const check of checks) assertCheck(check, ids)
  for (const id of ['markdown-links', 'doc-index-reachability', 'kind-manifest', 'markdown-size']) {
    assert.ok(ids.has(id), `workflow missing document check: ${id}`)
  }
}

function assertKinds(kinds) {
  assert.ok(isNonEmptyArray(kinds.kinds), 'docs/kinds.json needs a non-empty kinds list')
  assert.ok(isNonEmptyArray(kinds.assignments), 'docs/kinds.json needs assignments')
}

function assertPackageScripts(pkg) {
  for (const script of ['test', 'test:browser', 'test:coverage', 'test:host-smoke', 'check:clean', 'change-scope', 'typecheck', 'build']) {
    assert.equal(typeof pkg.scripts?.[script], 'string', `package.json is missing script ${script}`)
  }
}

function declaredSurface(workflow, name) {
  const surface = workflow.surfaces.find((entry) => entry.name === name)
  assert.ok(surface, `workflow must declare the ${name} surface`)
  return surface
}

function assertSourceSurface(workflow) {
  const source = declaredSurface(workflow, 'source')
  for (const command of ['npm run test:coverage', 'npm run typecheck', 'npm run build', 'npm run test:host-smoke']) {
    assert.ok(source.evidence.includes(command), `source evidence is missing: ${command}`)
  }
}

function assertBrowserSurface(workflow) {
  const browser = declaredSurface(workflow, 'browser')
  assert.equal(browser.mode, 'blocking', 'the browser lane blocks through the layered gate')
  assert.ok(browser.patterns.includes('src/client/**/*.tsx'), 'the browser surface must own TSX')
  assert.ok(browser.evidence.includes('npm run test:browser'), 'browser evidence is missing the lane command')
  assert.ok(browser.evidence.includes('npm run test:coverage:layered -- --base <verified-base>'), 'browser evidence is missing the layered command')
  assert.ok(existsSync(resolve(root, 'tools/coverage-browser-floors.json')), 'a blocking browser surface needs reviewed per-file floors')
}

function assertLockfile(pkg) {
  const lock = JSON.parse(read('package-lock.json'))
  assert.equal(lock.packages?.['']?.devDependencies?.playwright, pkg.devDependencies.playwright, 'lockfile must pin the Playwright manifest version')
  assert.equal(lock.packages?.['node_modules/playwright']?.version, pkg.devDependencies.playwright, 'lockfile must contain the Playwright install')
  const resolved = Object.values(lock.packages ?? {})
    .map(entry => entry?.resolved)
    .filter(url => typeof url === 'string')
  assert.ok(resolved.length > 0, 'lockfile must contain resolved tarball URLs')
  for (const url of resolved) {
    assert.ok(url.startsWith('https://registry.npmjs.org/'), `lockfile resolved outside the official registry: ${url}`)
  }
}

function assertPackagingSurface(workflow) {
  const packaging = declaredSurface(workflow, 'packaging')
  for (const command of ['npm test', 'npm run build', 'npm run test:host-smoke']) {
    assert.ok(packaging.evidence.includes(command), `packaging evidence is missing: ${command}`)
  }
  assert.ok(packaging.patterns.includes('cordis.patch.yml'), 'packaging must own the bundle patch')
  assert.equal(packaging.patterns.includes('lib/**'), false, 'lib is local build output, not a tracked packaging input')
}

function assertTestingGuide(testing) {
  for (const command of ['npm run test:browser', 'npm run test:coverage', 'npm run test:host-smoke']) {
    assert.ok(testing.includes(command), `docs/testing.md is missing: ${command}`)
  }
}

test('tools/workflow.json declares unique surfaces with non-empty evidence', () => {
  const workflow = JSON.parse(read('tools/workflow.json'))
  assertWorkflowShape(workflow)
  assertUniqueSurfaces(workflow.surfaces)
  assertDocumentChecks(workflow.checks)
  assertKinds(JSON.parse(read('docs/kinds.json')))
})

test('pr-description owns the PR structure and no separate template exists', () => {
  const skill = read('.agents/skills/pr-description/SKILL.md')
  for (const heading of ['## Motivation', '## Changes', '## Testing', '## Evidence']) {
    assert.ok(skill.includes(`${heading}\n`), `pr-description is missing ${heading}`)
  }
  assert.match(skill, /### Not run/)
  assert.match(skill, /npm run change-scope -- --base/)
  assert.equal(existsSync(resolve(root, '.github/pull_request_template.md')), false, 'the PR template must live in the skill, not a separate file')
})

test('executable test lanes are wired to scripts, workflow evidence, and the testing guide', () => {
  const pkg = JSON.parse(read('package.json'))
  const workflow = JSON.parse(read('tools/workflow.json'))
  const testing = read('docs/testing.md')
  assertPackageScripts(pkg)
  assertSourceSurface(workflow)
  assertBrowserSurface(workflow)
  assertLockfile(pkg)
  assertPackagingSurface(workflow)
  assertTestingGuide(testing)
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

test('document evidence cannot link gitignored runtime data', () => {
  const workflow = JSON.parse(read('tools/workflow.json'))
  const check = workflow.checks.find((entry) => entry.id === 'no-ignored-evidence-links')
  assert.ok(check, 'workflow must declare the ignored-evidence link check')
  assert.equal(check.kind, 'forbidden-regex')
  assert.deepEqual(check.patterns, ['*.md'])
  for (const pattern of check.regex) {
    const regex = new RegExp(pattern)
    assert.ok(regex.test('proof: [run](.dsh-cowork/e2e/M12_E2E.json)'), `pattern ${pattern} must reject an ignored link`)
    assert.ok(regex.test('proof: [run](../.dsh-cowork/e2e/M12_E2E.json)'), `pattern ${pattern} must reject a parent-relative ignored link`)
    assert.equal(regex.test('runtime data lives in `.dsh-cowork/e2e/`'), false, `pattern ${pattern} must allow a plain code mention`)
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
  for (const name of ['code-review', 'pre-push-checks', 'pr-description', 'find-simplifications']) {
    assert.ok(skills.includes(name), `${name} skill is missing`)
  }
  assert.ok(!skills.includes('merging-stacked-prs'), 'stacked PR automation is manual; the skill must stay removed')
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
  for (const name of ['code-review', 'pre-push-checks', 'pr-description', 'find-simplifications']) {
    assert.ok(index.includes(`.agents/skills/${name}/SKILL.md`), `docs index does not route to ${name}`)
  }
  const skillsIndex = read('.agents/skills/README.md')
  for (const name of ['code-review', 'pre-push-checks', 'pr-description', 'find-simplifications']) {
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
  const testFiles = []
  const visitTests = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) visitTests(full)
      else if (entry.name.endsWith('.test.mjs')) testFiles.push(relative(root, full).split(sep).join('/'))
    }
  }
  visitTests(resolve(root, 'tests'))
  for (const name of testFiles) {
    // This file holds the patterns themselves; it imports no fixture.
    if (name.endsWith('workflow.test.mjs')) continue
    const source = read(name)
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
  // The panel API suite was split by route family; every split must load the
  // shared public surface, and the split must keep all three files.
  const apiRouteTests = testFiles
    .filter((name) => /\/api-(?:read|write|auth)\.test\.mjs$/.test(name))
    .sort()
  assert.deepEqual(
    apiRouteTests,
    ['tests/panel/api-auth.test.mjs', 'tests/panel/api-read.test.mjs', 'tests/panel/api-write.test.mjs'],
    'the panel API suite keeps its three route-family files',
  )
  for (const name of ['tests/guards/dev-gate.test.mjs', 'tests/panel/api-contract.test.mjs', 'tests/tools/project.test.mjs', 'tests/guards/source-budget.test.mjs', ...apiRouteTests]) {
    assert.match(read(name), /public-surface\.mjs/, `${name} must use the shared public surface`)
  }
})

