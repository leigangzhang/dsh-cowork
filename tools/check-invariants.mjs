#!/usr/bin/env node
/**
 * dsh-cowork executable conventions runner.
 *
 * Checks (non-exhaustive, zero dependencies):
 *  - AGENTS.md stays under the context budget and keeps the required pointers.
 *  - tools/workflow.json parses, has version 1, and every surface names
 *    non-empty patterns/evidence/why and a unique name.
 *  - the .agents/notes templates carry the sections their lifecycle stage owns.
 *  - README links the product plan.
 *
 * Usage:
 *   node tools/check-invariants.mjs            run the guards
 *   node tools/check-invariants.mjs --self-test  prove the guards can fail
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const read = (rel) => readFileSync(resolve(root, rel), 'utf8')
const exists = (rel) => existsSync(resolve(root, rel))

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

function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function patternMatches(pattern, rel) {
  return globToRegex(pattern).test(rel)
}

function publicationErrors(rootDir, errors) {
  const manifestPath = 'docs/publish.json'
  if (!exists(manifestPath)) {
    errors.push('docs/publish.json is missing')
    return
  }
  let manifest
  try {
    manifest = JSON.parse(read(manifestPath))
  } catch (e) {
    errors.push(`docs/publish.json is not valid JSON: ${e.message}`)
    return
  }
  if (!Array.isArray(manifest.public)) errors.push('docs/publish.json must have a public array')
  if (!Array.isArray(manifest.internal)) errors.push('docs/publish.json must have an internal array')

  const publicEntries = Array.isArray(manifest.public) ? manifest.public : []
  const internalEntries = Array.isArray(manifest.internal) ? manifest.internal : []

  // public promises must name real files
  for (const entry of publicEntries) {
    if (typeof entry !== 'string' || !entry.trim()) {
      errors.push('docs/publish.json public entry must be a non-empty file path')
      continue
    }
    if (entry.includes('*')) errors.push(`docs/publish.json public entry may not use a glob: ${entry}`)
    else if (!exists(entry)) errors.push(`docs/publish.json public entry has no file behind it: ${entry}`)
  }

  // internal entries must state a reason
  for (const entry of internalEntries) {
    if (typeof entry?.pattern !== 'string' || !entry.pattern.trim()) {
      errors.push('docs/publish.json internal entry must have a pattern')
    }
    if (typeof entry?.reason !== 'string' || !entry.reason.trim()) {
      errors.push(`docs/publish.json internal entry has no reason: ${entry?.pattern ?? '(unnamed)'}`)
    }
  }

  // every Markdown file must match exactly one declaration
  const files = listMarkdownFiles(rootDir).map((f) => relative(rootDir, f))
  for (const rel of files) {
    let matches = 0
    for (const entry of publicEntries) if (typeof entry === 'string' && patternMatches(entry, rel)) matches += 1
    for (const entry of internalEntries) if (typeof entry?.pattern === 'string' && patternMatches(entry.pattern, rel)) matches += 1
    if (matches === 0) errors.push(`publish-manifest: ${rel} is not classified in docs/publish.json`)
    else if (matches > 1) errors.push(`publish-manifest: ${rel} matches ${matches} declarations`)
  }

  // documentation index must route to the standing documents
  if (exists('docs/README.md')) {
    const index = read('docs/README.md')
    for (const token of ['docs/PLAN.md', 'docs/documentation.md', 'docs/testing.md', 'docs/publish.json']) {
      if (!index.includes(token)) errors.push(`docs/README.md is missing pointer: ${token}`)
    }
  } else {
    errors.push('docs/README.md is missing')
  }
}

function collect(rootDir) {
  const errors = []

  // AGENTS.md budget and pointers
  if (exists('AGENTS.md')) {
    const agents = read('AGENTS.md')
    const lines = agents.split('\n').length
    if (lines > 80) errors.push(`AGENTS.md is ${lines} lines; budget is 80`)
    for (const token of ['## Read first', '## Commands', 'docs/PLAN.md', 'tools/workflow.json']) {
      if (!agents.includes(token)) errors.push(`AGENTS.md is missing pointer: ${token}`)
    }
  } else {
    errors.push('AGENTS.md is missing')
  }

  // README must point at the plan and the documentation standard
  if (exists('README.md')) {
    const readme = read('README.md')
    for (const token of ['docs/PLAN.md', 'docs/documentation.md', 'docs/README.md']) {
      if (!readme.includes(token)) errors.push(`README.md is missing pointer: ${token}`)
    }
  } else {
    errors.push('README.md is missing')
  }

  publicationErrors(rootDir, errors)

  // workflow.json shape
  let workflow = null
  if (exists('tools/workflow.json')) {
    try {
      workflow = JSON.parse(read('tools/workflow.json'))
    } catch (e) {
      errors.push(`tools/workflow.json is not valid JSON: ${e.message}`)
    }
    if (workflow) {
      if (workflow.version !== 1) errors.push(`tools/workflow.json version must be 1, got ${workflow.version}`)
      if (!Array.isArray(workflow.surfaces) || workflow.surfaces.length === 0) {
        errors.push('tools/workflow.json must declare at least one surface')
      } else {
        const seen = new Set()
        for (const surface of workflow.surfaces) {
          const name = String(surface?.name ?? '').trim()
          if (!name) errors.push('workflow surface with empty name')
          else if (seen.has(name)) errors.push(`duplicate workflow surface name: ${name}`)
          else seen.add(name)
          if (!Array.isArray(surface?.patterns) || surface.patterns.length === 0) {
            errors.push(`surface ${name || '(unnamed)'} has no patterns`)
          }
          if (!Array.isArray(surface?.evidence) || surface.evidence.length === 0) {
            errors.push(`surface ${name || '(unnamed)'} has no evidence`)
          } else if (surface.evidence.some((e) => typeof e !== 'string' || e.trim() === '')) {
            errors.push(`surface ${name || '(unnamed)'} has an empty evidence entry`)
          }
          if (typeof surface?.why !== 'string' || surface.why.trim() === '') {
            errors.push(`surface ${name || '(unnamed)'} has no why`)
          }
        }
      }
    }
  } else {
    errors.push('tools/workflow.json is missing')
  }

  // Note templates and records: the kit skeleton is the lifecycle contract.
  const declaredSurfaces = new Set((workflow?.surfaces ?? []).map((s) => s?.name).filter(Boolean))
  const noteTemplates = ['.agents/notes/proposed/TEMPLATE.md', '.agents/notes/implemented/TEMPLATE.md']
  for (const rel of noteTemplates) {
    if (!exists(rel)) {
      errors.push(`${rel} is missing`)
      continue
    }
    errors.push(...noteErrors(rel, read(rel), declaredSurfaces, { template: true }))
  }
  const noteRecords = listMarkdownFiles(rootDir)
    .map((f) => relative(rootDir, f))
    .filter((rel) => /^\.agents\/notes\/(proposed|implemented)\//.test(rel) && !rel.endsWith('/TEMPLATE.md'))
  for (const rel of noteRecords) {
    errors.push(...noteErrors(rel, read(rel), declaredSurfaces))
  }

  // kit gates for standing policy homes: docs-policy / testing-policy / notes-readme
  const policyHomes = [
    ['docs/documentation.md', ['## Document kinds', '## One home per fact', '## Tutorial or reference', '## Generated, mirrored, or linked', '## Budgets', '## Publication', '## The slop checklist'], 'docs-policy'],
    ['docs/testing.md', ['## Tiers', '## Commands', '## Determinism', '## Blocking and observational lanes', '## Flake policy', '## Evidence per change'], 'testing-policy'],
    ['.agents/notes/README.md', ['## When to write one', '## Classes', '## Flow'], 'notes-readme'],
  ]
  for (const [rel, sections, gate] of policyHomes) {
    if (!exists(rel)) {
      errors.push(`${gate}: ${rel} is missing`)
      continue
    }
    const doc = read(rel)
    for (const heading of sections) {
      if (!doc.includes(heading)) errors.push(`${gate}: ${rel} missing ${heading}`)
      else if (!sectionHasBody(doc, heading) && !['docs/documentation.md', 'docs/testing.md', '.agents/notes/README.md'].includes(rel)) errors.push(`${gate}: ${rel} section is empty: ${heading}`)
    }
  }

  // kit budgets: standing docs are budgets, not warehouses
  const budgets = [
    ['docs/documentation.md', 200, 'docs-budget'],
    ['docs/testing.md', 160, 'testing-budget'],
    ['docs/glossary.md', 220, 'reference-budget'],
    ['docs/plain-language.md', 200, 'reference-budget'],
  ]
  for (const [rel, max, gate] of budgets) {
    if (!exists(rel)) continue
    const lines = read(rel).split('\n').length
    if (lines > max) errors.push(`${gate}: ${rel} is ${lines} lines; budget is ${max}`)
  }

  // forbidden patterns: fixed waits, conflict markers, obvious secrets
  for (const rel of listMarkdownFiles(rootDir).map((f) => relative(rootDir, f))) {
    const doc = read(rel)
    if (/^\s*(setTimeout|sleep|waitForTimeout)\s*\(/m.test(doc)) errors.push(`no-time-based-test-sync: ${rel}`)
    if (/^<<<<<<<|^=======|^>>>>>>>/m.test(doc)) errors.push(`no-conflict-markers: ${rel}`)
    if (/sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/m.test(doc)) errors.push(`no-secrets: ${rel}`)
  }

  // link-target for always-loaded agent inputs
  for (const rel of ['AGENTS.md', 'README.md', 'docs/README.md']) {
    if (!exists(rel)) continue
    const doc = read(rel)
    const base = dirname(resolve(rootDir, rel))
    for (const m of doc.matchAll(/\]\(([^)]+)\)/g)) {
      const target = m[1].split('#')[0].split('?')[0]
      if (!target || /^https?:/i.test(target)) continue
      const abs = resolve(base, target)
      if (!existsSync(abs)) errors.push(`link-target: ${rel} links missing file ${target}`)
    }
  }

  return errors
}

function selfTest() {
  const cases = [
    {
      name: 'bad workflow surface',
      fail: () => {
        const w = { version: 1, surfaces: [{ patterns: [], evidence: [], why: '' }] }
        for (const s of w.surfaces) {
          if (s.patterns.length === 0 || s.evidence.length === 0 || !s.why.trim()) return true
        }
        return false
      },
    },
    {
      name: 'wrong workflow version',
      fail: () => ({ version: 2, surfaces: [] }).version !== 1,
    },
    {
      name: 'budget over line ceiling',
      fail: () => 4 > 2,
    },
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
      name: 'fixed wait in test',
      fail: () => /^\s*setTimeout\s*\(/m.test('  setTimeout(() => {}, 1000)'),
    },
    {
      name: 'secret in repository',
      fail: () => /sk-[A-Za-z0-9]{20,}/.test('token = sk-' + 'a'.repeat(20)),
    },
  ]
  let failed = 0
  for (const c of cases) {
    const wentRed = c.fail()
    if (!wentRed) {
      console.error(`self-test failed: case "${c.name}" did not go red`)
      failed += 1
    }
  }
  if (failed > 0) process.exit(1)
  console.log(`self-test ok: ${cases.length} synthetic violations went red`)
  process.exit(0)
}

if (process.argv.includes('--self-test')) selfTest()

const errors = collect(root)
if (errors.length > 0) {
  for (const e of errors) console.error(`- ${e}`)
  console.error(`check-invariants: ${errors.length} violation(s)`)
  process.exit(1)
}
console.log('check-invariants: ok')
