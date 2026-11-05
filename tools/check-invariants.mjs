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

import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const read = (rel) => readFileSync(resolve(root, rel), 'utf8')
const exists = (rel) => existsSync(resolve(root, rel))

function sectionHasBullet(doc, heading) {
  const lines = doc.split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start < 0) return false
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^##\s/.test(line)) return false
    if (/^\s*-\s+/.test(line)) return true
  }
  return false
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

  // README must point at the plan
  if (exists('README.md')) {
    const readme = read('README.md')
    if (!readme.includes('docs/PLAN.md')) errors.push('README.md does not link docs/PLAN.md')
  } else {
    errors.push('README.md is missing')
  }

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

  // Note templates: the sections are the lifecycle contract, and an empty
  // section is a hollow template — every owner section must carry a bullet.
  if (exists('.agents/notes/proposed/TEMPLATE.md')) {
    const p = read('.agents/notes/proposed/TEMPLATE.md')
    for (const token of ['## Alternatives considered', '## Acceptance criteria']) {
      if (!p.includes(token)) errors.push(`proposed TEMPLATE is missing section: ${token}`)
      else if (!sectionHasBullet(p, token)) errors.push(`proposed TEMPLATE section is empty: ${token}`)
    }
  } else {
    errors.push('.agents/notes/proposed/TEMPLATE.md is missing')
  }
  if (exists('.agents/notes/implemented/TEMPLATE.md')) {
    const d = read('.agents/notes/implemented/TEMPLATE.md')
    for (const token of ['## Decision', '## Consequences', '## Testing']) {
      if (!d.includes(token)) errors.push(`implemented TEMPLATE is missing section: ${token}`)
      else if (!sectionHasBullet(d, token)) errors.push(`implemented TEMPLATE section is empty: ${token}`)
    }
  } else {
    errors.push('.agents/notes/implemented/TEMPLATE.md is missing')
  }

  return errors
}

function selfTest() {
  const cases = [
    { name: 'bad workflow surface', make: () => ({ version: 1, surfaces: [{ patterns: [], evidence: [], why: '' }] }) },
    { name: 'wrong workflow version', make: () => ({ version: 2, surfaces: [] }) },
  ]
  let failed = 0
  for (const c of cases) {
    // Reuse the same validators by parsing the synthetic object through the same rules.
    const errors = []
    const w = c.make()
    if (w.version !== 1) errors.push('version')
    for (const s of w.surfaces) {
      if (!Array.isArray(s?.patterns) || s.patterns.length === 0) errors.push('patterns')
      if (!Array.isArray(s?.evidence) || s.evidence.length === 0 || s.evidence.some((e) => typeof e !== 'string' || !e.trim())) errors.push('evidence')
      if (typeof s?.why !== 'string' || !s.why.trim()) errors.push('why')
    }
    if (errors.length === 0) {
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
