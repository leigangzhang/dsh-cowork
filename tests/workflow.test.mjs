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
})

test('AGENTS.md keeps the context budget and the required pointers', () => {
  const agents = read('AGENTS.md')
  assert.ok(agents.split('\n').length <= 80, 'AGENTS.md exceeds 80 lines')
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
    ['docs/documentation.md', ['## Document kinds', '## One home per fact', '## Publication']],
    ['docs/testing.md', ['## Tiers', '## Determinism', '## Flake policy']],
    ['.agents/notes/README.md', ['## When to write one', '## Classes', '## Flow']],
  ]
  for (const [rel, sections] of homes) {
    const doc = read(rel)
    for (const section of sections) assert.ok(doc.includes(section), `${rel} missing ${section}`)
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
