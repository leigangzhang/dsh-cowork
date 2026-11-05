import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const read = (rel) => readFileSync(resolve(root, rel), 'utf8')

function sectionHasBullet(doc, heading) {
  const lines = doc.split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start < 0) return false
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) return false
    if (/^\s*-\s+/.test(lines[i])) return true
  }
  return false
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
  for (const heading of ['## Alternatives considered', '## Acceptance criteria']) {
    assert.ok(sectionHasBullet(proposed, heading), `proposed TEMPLATE ${heading} is empty`)
  }
  for (const heading of ['## Decision', '## Consequences', '## Testing']) {
    assert.ok(sectionHasBullet(implemented, heading), `implemented TEMPLATE ${heading} is empty`)
  }
})

test('README links the product plan', () => {
  const readme = read('README.md')
  assert.ok(readme.includes('docs/PLAN.md'))
})
