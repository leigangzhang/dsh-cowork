#!/usr/bin/env node
/**
 * Config-driven document gates, adapted from agent-workflow-kit's kitcheck engine.
 *
 * Checks live in tools/workflow.json. Every supported kind has one runner and one
 * invalid/valid self-test fixture; a check whose patterns match no file is rejected,
 * because a guard with no subject cannot fail.
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const SUPPORTED_KINDS = [
  'budget',
  'required-sections',
  'forbidden-regex',
  'link-target',
  'publish-manifest',
  'skill-trigger',
  'docs-layout',
  'index-reachable',
  'kind-manifest',
]

const MAX_FILE_BYTES = 2 * 1024 * 1024
const TRIGGER_PREFIX = /^Use (?:when|before|after|during)\b/
const SKIP_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', 'node_modules',
  'dist', 'build', 'target', '.next', '.cache', '.mypy_cache', '.pytest_cache',
  'vendor', 'coverage', 'lib',
])
const ARCHIVED_FAMILIES = new Set(['handoffs', 'results', 'recon'])

export function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

export function patternMatches(pattern, rel) {
  return globToRegex(pattern).test(rel)
}

function matchesAny(rel, patterns) {
  return patterns.some((pattern) => patternMatches(pattern, rel))
}

function corpusPaths(rootDir) {
  try {
    const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new Set(listed.split('\0').filter(Boolean))
  } catch {
    return null
  }
}

function walkFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) out.push(...walkFiles(full))
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

export function iterFiles(rootDir, patterns, exclude = []) {
  const corpus = corpusPaths(rootDir)
  const out = []
  for (const full of walkFiles(rootDir).sort()) {
    const rel = relative(rootDir, full).split(sep).join('/')
    if (corpus !== null && !corpus.has(rel)) continue
    if (!matchesAny(rel, patterns) || matchesAny(rel, exclude)) continue
    try {
      if (lstatSync(full).size > MAX_FILE_BYTES) continue
      const bytes = readFileSync(full)
      if (bytes.includes(0)) continue
      out.push([rel, bytes.toString('utf8')])
    } catch {
      continue
    }
  }
  return out
}

export function countLines(text) {
  if (text === '') return 0
  return (text.match(/\n/g) ?? []).length + (text.endsWith('\n') ? 0 : 1)
}

export function countWords(text) {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length
}

export function sectionBody(text, heading) {
  const body = []
  let inside = false
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      if (inside) break
      inside = line === heading
      continue
    }
    if (inside) body.push(line)
  }
  return body
}

function sectionVariants(section, check) {
  const variants = typeof section === 'string' ? [section] : Array.isArray(section) ? section : []
  if (variants.length === 0 || variants.some((value) => typeof value !== 'string' || !value.startsWith('## '))) {
    throw new Error(`check ${check.id}: each sections entry must be a heading or a non-empty list of headings`)
  }
  return variants
}

export function checkBudget(rootDir, check) {
  const limits = []
  for (const field of ['maxLines', 'maxWords', 'maxBytes']) {
    const value = check[field]
    if (value === undefined) continue
    if (!Number.isInteger(value) || value < 1) throw new Error(`check ${check.id}: ${field} must be a positive integer`)
    limits.push([field, value])
  }
  if (limits.length === 0) throw new Error(`check ${check.id}: needs maxLines, maxWords, or maxBytes`)
  const violations = []
  for (const [rel, text] of iterFiles(rootDir, check.patterns, check.exclude)) {
    for (const [field, limit] of limits) {
      const counted = field === 'maxLines'
        ? countLines(text)
        : field === 'maxWords'
          ? countWords(text)
          : Buffer.byteLength(text, 'utf8')
      const unit = field === 'maxLines' ? 'lines' : field === 'maxWords' ? 'words' : 'bytes'
      if (counted > limit) violations.push(`${rel}: ${counted} ${unit}, budget is ${limit}`)
    }
  }
  return violations
}

export function checkRequiredSections(rootDir, check) {
  if (!Array.isArray(check.sections) || check.sections.length === 0) {
    throw new Error(`check ${check.id}: sections must be a non-empty list`)
  }
  const minimum = check.minBodyLines ?? 1
  if (!Number.isInteger(minimum) || minimum < 1) throw new Error(`check ${check.id}: minBodyLines must be positive`)
  const violations = []
  for (const [rel, text] of iterFiles(rootDir, check.patterns, check.exclude)) {
    const headings = text.split('\n').filter((line) => line.startsWith('## '))
    for (const section of check.sections) {
      const variants = sectionVariants(section, check)
      const matched = variants.find((variant) => headings.includes(variant))
      if (matched === undefined) {
        violations.push(`${rel}: missing section ${variants.map((value) => `'${value}'`).join(' or ')}`)
        continue
      }
      const filled = sectionBody(text, matched).filter((line) => line.trim() !== '')
      if (filled.length < minimum) violations.push(`${rel}: section '${matched}' has an empty body`)
    }
  }
  return violations
}

export function checkForbiddenRegex(rootDir, check) {
  if (!Array.isArray(check.regex) || check.regex.length === 0) {
    throw new Error(`check ${check.id}: regex must be a non-empty list`)
  }
  const compiled = check.regex.map((pattern) => {
    try {
      return [pattern, new RegExp(pattern)]
    } catch (error) {
      throw new Error(`check ${check.id}: invalid regex ${pattern}: ${error.message}`)
    }
  })
  const violations = []
  for (const [rel, text] of iterFiles(rootDir, check.patterns, check.exclude)) {
    for (const [number, line] of text.split('\n').entries()) {
      for (const [pattern, regex] of compiled) {
        if (regex.test(line)) violations.push(`${rel}:${number + 1}: matches forbidden pattern '${pattern}'`)
      }
    }
  }
  return violations
}

export function checkLinkTarget(rootDir, check) {
  const violations = []
  for (const [rel, text] of iterFiles(rootDir, check.patterns, check.exclude)) {
    const base = dirname(resolve(rootDir, rel))
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      let target = match[1].trim()
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
      else target = target.split(/\s+/)[0]
      const pathPart = target.split('#')[0].split('?')[0]
      if (!pathPart || pathPart.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(pathPart) || pathPart.startsWith('//')) continue
      let decoded = pathPart
      try { decoded = decodeURIComponent(pathPart) } catch {}
      if (!existsSync(resolve(base, decoded))) violations.push(`${rel}: link target does not exist: ${target}`)
    }
  }
  return violations
}

export function checkPublishManifest(rootDir, check) {
  if (typeof check.manifest !== 'string' || check.manifest === '') throw new Error(`check ${check.id}: manifest is required`)
  const manifestPath = resolve(rootDir, check.manifest)
  if (!existsSync(manifestPath)) throw new Error(`check ${check.id}: manifest not found: ${check.manifest}`)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`check ${check.id}: cannot read ${check.manifest}: ${error.message}`)
  }
  if (typeof manifest !== 'object' || manifest === null || !Array.isArray(manifest.public) || manifest.public.length === 0) {
    throw new Error(`check ${check.id}: manifest needs a non-empty public list`)
  }
  const violations = []
  const declared = []
  manifest.public.forEach((pattern, index) => {
    if (typeof pattern !== 'string' || pattern === '') {
      violations.push(`${check.manifest} public[${index}]: must be a non-empty string`)
      return
    }
    if (/[*?\[]/.test(pattern)) {
      violations.push(`${check.manifest} public[${index}] '${pattern}': publication is a per-file promise; do not publish a directory`)
    }
    declared.push([pattern, 'public'])
  })
  const internal = manifest.internal ?? []
  if (!Array.isArray(internal)) throw new Error(`check ${check.id}: manifest internal must be a list`)
  internal.forEach((entry, index) => {
    const label = `${check.manifest} internal[${index}]`
    if (typeof entry !== 'object' || entry === null) {
      violations.push(`${label}: not an object`)
      return
    }
    if (typeof entry.pattern !== 'string' || entry.pattern === '') {
      violations.push(`${label}: missing non-empty pattern`)
      return
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      violations.push(`${label} '${entry.pattern}': missing reason`)
    }
    declared.push([entry.pattern, 'internal'])
  })
  const seen = new Set()
  for (const [pattern] of declared) {
    if (seen.has(pattern)) violations.push(`${check.manifest}: pattern '${pattern}' is declared twice`)
    seen.add(pattern)
  }
  const corpus = iterFiles(rootDir, check.patterns, check.exclude).map(([rel]) => rel)
  for (const [pattern, side] of declared) {
    if (side === 'public' && !corpus.some((rel) => patternMatches(pattern, rel))) {
      violations.push(`${check.manifest}: public pattern '${pattern}' matches no file`)
    }
  }
  for (const rel of corpus) {
    const hits = declared.filter(([pattern]) => patternMatches(pattern, rel))
    if (hits.length === 0) violations.push(`${rel}: matches no declared pattern — classify it public or internal in ${check.manifest}`)
    else if (hits.length > 1) violations.push(`${rel}: matches ${hits.length} declarations — a file has exactly one class`)
  }
  return violations
}

function frontMatter(text) {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  return end > 0 ? lines.slice(1, end) : null
}

export function checkSkillTrigger(rootDir, check) {
  const violations = []
  for (const [rel, text] of iterFiles(rootDir, check.patterns, check.exclude)) {
    const meta = frontMatter(text)
    if (meta === null) {
      violations.push(`${rel}: no front-matter block, so nothing declares when it loads`)
      continue
    }
    const fields = {}
    for (const line of meta) {
      const separator = line.indexOf(':')
      if (separator < 0) continue
      const key = line.slice(0, separator).trim()
      if (key === 'name' || key === 'description') fields[key] = line.slice(separator + 1).trim()
    }
    if (!fields.name) violations.push(`${rel}: front matter has no name:`)
    else if (fields.name !== rel.split('/').at(-2)) violations.push(`${rel}: front matter name '${fields.name}' disagrees with its directory`)
    if (!fields.description) violations.push(`${rel}: front matter has no description:, so the skill has no load trigger`)
    else if (!TRIGGER_PREFIX.test(fields.description)) {
      violations.push(`${rel}: description must open with when the skill loads ('Use when' / 'Use before' / 'Use after' / 'Use during'), not a summary`)
    }
  }
  return violations
}

export function checkDocsLayout(rootDir, check) {
  const violations = []
  for (const [rel] of iterFiles(rootDir, check.patterns, check.exclude)) {
    if (/^docs\/[^/]+_(?:HANDOFF|RESULT|RECON)\.md$/.test(rel)) {
      violations.push(`${rel} belongs in a record family subdirectory`)
    }
    if (/^docs\/archived\/[^/]+\.md$/.test(rel) && rel !== 'docs/archived/README.md') {
      violations.push(`${rel} must be filed under docs/archived/{handoffs,results,recon}/`)
    }
    if (rel.startsWith('docs/handoffs/') && rel !== 'docs/handoffs/README.md' && !rel.endsWith('_HANDOFF.md')) {
      violations.push(`${rel} is not a handoff record`)
    }
    if (rel.startsWith('docs/archived/handoffs/') && !rel.endsWith('_HANDOFF.md')) violations.push(`${rel} is not a handoff record`)
    if (rel.startsWith('docs/archived/results/') && !rel.endsWith('_RESULT.md')) violations.push(`${rel} is not a result record`)
    if (rel.startsWith('docs/archived/recon/') && !rel.endsWith('_RECON.md')) violations.push(`${rel} is not a reconnaissance record`)
    if (rel.startsWith('docs/archived/')) {
      const parts = rel.split('/')
      if (parts.length > 3 && !ARCHIVED_FAMILIES.has(parts[2])) violations.push(`${rel} uses an unknown archive family '${parts[2]}'`)
    }
  }
  return violations
}

export function checkIndexReachable(rootDir, check) {
  if (typeof check.index !== 'string' || check.index === '') throw new Error(`check ${check.id}: index is required`)
  const indexPath = resolve(rootDir, check.index)
  if (!existsSync(indexPath)) throw new Error(`check ${check.id}: index not found: ${check.index}`)
  const text = readFileSync(indexPath, 'utf8')
  const linked = new Set()
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim()
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    else target = target.split(/\s+/)[0]
    const pathPart = target.split('#')[0].split('?')[0]
    if (!pathPart || pathPart.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(pathPart) || pathPart.startsWith('//')) continue
    let decoded = pathPart
    try { decoded = decodeURIComponent(pathPart) } catch {}
    linked.add(relative(rootDir, resolve(dirname(indexPath), decoded)).split(sep).join('/'))
  }

  const required = new Set()
  if (check.manifest) {
    const manifestPath = resolve(rootDir, check.manifest)
    if (!existsSync(manifestPath)) throw new Error(`check ${check.id}: manifest not found: ${check.manifest}`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!Array.isArray(manifest.public)) throw new Error(`check ${check.id}: manifest public must be a list`)
    for (const entry of manifest.public) {
      if (typeof entry === 'string' && entry !== '' && !/[*?\[]/.test(entry)) required.add(entry)
    }
  }
  if (Array.isArray(check.rootPatterns)) {
    for (const [rel] of iterFiles(rootDir, check.rootPatterns, check.exclude)) {
      if (rel.split('/').length === 2) required.add(rel)
    }
  }
  const excluded = new Set(check.requiredExclude ?? [])
  const violations = []
  for (const rel of required) {
    if (!excluded.has(rel) && !linked.has(rel)) violations.push(`${rel}: not reachable from ${check.index}`)
  }
  return violations
}

export function checkKindManifest(rootDir, check) {
  if (typeof check.manifest !== 'string' || check.manifest === '') throw new Error(`check ${check.id}: manifest is required`)
  const manifestPath = resolve(rootDir, check.manifest)
  if (!existsSync(manifestPath)) throw new Error(`check ${check.id}: manifest not found: ${check.manifest}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(manifest.kinds) || manifest.kinds.length === 0) throw new Error(`check ${check.id}: kinds must be a non-empty list`)
  if (!Array.isArray(manifest.assignments) || manifest.assignments.length === 0) throw new Error(`check ${check.id}: assignments must be a non-empty list`)
  const kinds = new Set(manifest.kinds)
  let checksById = null
  if (check.declaredIn) {
    const configPath = resolve(rootDir, check.declaredIn)
    if (!existsSync(configPath)) throw new Error(`check ${check.id}: declaredIn not found: ${check.declaredIn}`)
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    checksById = new Map((config.checks ?? []).map((item) => [item.id, item]))
  }
  const violations = []
  const assignments = manifest.assignments.map((assignment, index) => {
    if (!kinds.has(assignment.kind)) violations.push(`${check.manifest} assignments[${index}]: unknown kind '${assignment.kind}'`)
    if (!Array.isArray(assignment.patterns) || assignment.patterns.length === 0) {
      violations.push(`${check.manifest} assignments[${index}]: missing patterns`)
    }
    if (assignment.skeletonCheck) {
      const skeleton = checksById?.get(assignment.skeletonCheck)
      if (!skeleton) violations.push(`${check.manifest} assignments[${index}]: skeletonCheck '${assignment.skeletonCheck}' is not a declared check`)
      else if (skeleton.kind !== 'required-sections') {
        violations.push(`${check.manifest} assignments[${index}]: skeletonCheck '${assignment.skeletonCheck}' is not a required-sections check`)
      }
    }
    return assignment
  })
  const used = new Set()
  for (const [rel] of iterFiles(rootDir, check.patterns, check.exclude)) {
    const hits = assignments
      .map((assignment, index) => ({ assignment, index }))
      .filter(({ assignment }) => matchesAny(rel, assignment.patterns ?? []) && !matchesAny(rel, assignment.exclude ?? []))
    if (hits.length === 0) violations.push(`${rel}: matches no declared kind`)
    else if (hits.length > 1) violations.push(`${rel}: matches ${hits.length} kinds: ${hits.map(({ assignment }) => assignment.kind).join(', ')}`)
    else used.add(hits[0].index)
  }
  assignments.forEach((assignment, index) => {
    if (!used.has(index)) violations.push(`${check.manifest} assignments[${index}] (${assignment.kind}) matches no file`)
  })
  return violations
}

const RUNNERS = {
  budget: checkBudget,
  'required-sections': checkRequiredSections,
  'forbidden-regex': checkForbiddenRegex,
  'link-target': checkLinkTarget,
  'publish-manifest': checkPublishManifest,
  'skill-trigger': checkSkillTrigger,
  'docs-layout': checkDocsLayout,
  'index-reachable': checkIndexReachable,
  'kind-manifest': checkKindManifest,
}

export function validateConfig(config) {
  const errors = []
  if (!config || typeof config !== 'object') return ['workflow config must be an object']
  if (config.version !== 1) errors.push(`workflow version must be 1, got ${config.version}`)
  if (!Array.isArray(config.surfaces) || config.surfaces.length === 0) errors.push('workflow must declare at least one surface')
  else {
    const names = new Set()
    for (const surface of config.surfaces) {
      if (!surface?.name) errors.push('workflow surface with empty name')
      else if (names.has(surface.name)) errors.push(`duplicate workflow surface name: ${surface.name}`)
      else names.add(surface.name)
      if (!Array.isArray(surface?.patterns) || surface.patterns.length === 0) errors.push(`surface ${surface?.name ?? '(unnamed)'} needs patterns`)
      if (!Array.isArray(surface?.evidence) || surface.evidence.length === 0) errors.push(`surface ${surface?.name ?? '(unnamed)'} needs evidence`)
      if (typeof surface?.why !== 'string' || surface.why.trim() === '') errors.push(`surface ${surface?.name ?? '(unnamed)'} needs why`)
    }
  }
  if (!Array.isArray(config.checks) || config.checks.length === 0) errors.push('workflow must declare at least one check')
  else {
    const ids = new Set()
    for (const check of config.checks) {
      if (!check?.id) errors.push('document check with empty id')
      else if (ids.has(check.id)) errors.push(`duplicate document check id: ${check.id}`)
      else ids.add(check.id)
      if (!SUPPORTED_KINDS.includes(check?.kind)) errors.push(`check ${check?.id ?? '(unnamed)'} has unsupported kind ${check?.kind}`)
      if (!Array.isArray(check?.patterns) || check.patterns.length === 0) errors.push(`check ${check?.id ?? '(unnamed)'} needs patterns`)
      if (check?.exclude !== undefined && !Array.isArray(check.exclude)) errors.push(`check ${check?.id ?? '(unnamed)'} exclude must be a list`)
    }
  }
  return errors
}

export function runChecks(rootDir, checks) {
  const results = []
  for (const check of checks) {
    const runner = RUNNERS[check.kind]
    if (!runner) throw new Error(`check ${check.id}: unsupported kind ${check.kind}`)
    const matched = iterFiles(rootDir, check.patterns, check.exclude).length
    let violations = runner(rootDir, check)
    if (matched === 0) violations = [`no file matched ${JSON.stringify(check.patterns)}: a check with no subject cannot fail`, ...violations]
    results.push([check.id, violations])
  }
  return results
}

export function loadConfig(path) {
  let config
  try {
    config = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`)
  }
  const errors = validateConfig(config)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return config
}

export function selectChecks(config, paths) {
  return config.checks.filter((check) => paths.some((rel) =>
    matchesAny(rel, check.patterns) && !matchesAny(rel, check.exclude ?? []),
  ))
}

export function changedPaths(rootDir, base, worktreeOnly = false) {
  const git = (args) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8' }).trim()
  const paths = new Set()
  if (!worktreeOnly) {
    const mergeBase = git(['merge-base', base, 'HEAD'])
    for (const line of git(['diff', '--name-status', '--find-renames', mergeBase, 'HEAD']).split('\n')) {
      if (!line) continue
      const fields = line.split('\t')
      if (fields.length >= 2) paths.add(fields.at(-1))
    }
  }
  for (const line of git(['status', '--porcelain', '--untracked-files=all']).split('\n')) {
    if (line.length < 4) continue
    let path = line.slice(3).trim()
    if (path.includes(' -> ')) path = path.split(' -> ').at(-1)
    paths.add(path)
  }
  return [...paths].sort()
}

export function listChecks(checks) {
  for (const check of checks) console.log(`  ${check.id}  (${check.kind})  ${check.why ?? ''}`)
}

function writeFixtures(files) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-gate-self-'))
  for (const [rel, text] of Object.entries(files)) {
    const target = join(dir, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text, 'utf8')
  }
  return dir
}

function withFixtures(files, fn) {
  const dir = writeFixtures(files)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function selfTest() {
  const cases = [
    ['budget', { id: 'self-budget', kind: 'budget', patterns: ['AGENTS.md'], maxLines: 2 }, { 'AGENTS.md': '# Rules\nalpha\nbeta\ngamma\n' }, { 'AGENTS.md': '# Rules\nalpha\n' }],
    ['required-sections', { id: 'self-sections', kind: 'required-sections', patterns: ['doc.md'], sections: ['## Problem', ['## Alternatives considered', '## 曾考虑的替代方案']], minBodyLines: 1 }, { 'doc.md': '## Problem\nbroken\n\n## Alternatives considered\n\n## Decision\nfixed\n' }, { 'doc.md': '## Problem\nbroken\n\n## 曾考虑的替代方案\n\n**Do nothing.** It stays broken.\n' }],
    ['forbidden-regex', { id: 'self-regex', kind: 'forbidden-regex', patterns: ['*'], regex: ['BEGIN-FAKE-SECRET'] }, { 'leak.txt': 'token = BEGIN-FAKE-SECRET\n' }, { 'clean.txt': 'token = redacted\n' }],
    ['link-target', { id: 'self-link', kind: 'link-target', patterns: ['*.md'] }, { 'AGENTS.md': '# A\n\nRead [the map](docs/gone.md).\n' }, { 'AGENTS.md': '# A\n\nRead [the map](docs/here.md).\n', 'docs/here.md': '# Map\n' }],
    ['publish-manifest', { id: 'self-publish', kind: 'publish-manifest', patterns: ['docs/*.md'], manifest: 'docs/publish.json' }, { 'docs/publish.json': JSON.stringify({ public: ['docs/a.md'], internal: [] }), 'docs/a.md': '# A\n', 'docs/b.md': '# B\n' }, { 'docs/publish.json': JSON.stringify({ public: ['docs/a.md'], internal: [{ pattern: 'docs/b.md', reason: 'internal draft' }] }), 'docs/a.md': '# A\n', 'docs/b.md': '# B\n' }],
    ['skill-trigger', { id: 'self-skill', kind: 'skill-trigger', patterns: ['.agents/skills/*/SKILL.md'] }, { '.agents/skills/a/SKILL.md': '---\nname: a\ndescription: Summarizes the testing policy.\n---\n\n## When to use\nx\n' }, { '.agents/skills/a/SKILL.md': '---\nname: a\ndescription: Use when a check fails.\n---\n\n## When to use\nx\n' }],
    ['docs-layout', { id: 'self-layout', kind: 'docs-layout', patterns: ['docs/*.md'] }, { 'docs/TOPIC_EXAMPLE_HANDOFF.md': '# handoff\n' }, { 'docs/handoffs/TOPIC_EXAMPLE_HANDOFF.md': '# handoff\n' }],
    ['index-reachable', { id: 'self-index', kind: 'index-reachable', patterns: ['README.md'], index: 'README.md', rootPatterns: ['docs/*.md'], manifest: 'docs/publish.json', requiredExclude: ['docs/README.md'] }, { 'README.md': '# Index\n\n[A](docs/a.md)\n', 'docs/a.md': '# A\n', 'docs/b.md': '# B\n', 'docs/publish.json': JSON.stringify({ public: ['docs/a.md'], internal: [] }) }, { 'README.md': '# Index\n\n[A](docs/a.md)\n[B](docs/b.md)\n', 'docs/a.md': '# A\n', 'docs/b.md': '# B\n', 'docs/publish.json': JSON.stringify({ public: ['docs/a.md'], internal: [] }) }],
    ['kind-manifest', { id: 'self-kind', kind: 'kind-manifest', patterns: ['*.md'], manifest: 'docs/kinds.json' }, { 'docs/kinds.json': JSON.stringify({ kinds: ['guide'], assignments: [{ kind: 'guide', patterns: ['a.md'] }] }), 'a.md': '# A\n', 'b.md': '# B\n' }, { 'docs/kinds.json': JSON.stringify({ kinds: ['guide'], assignments: [{ kind: 'guide', patterns: ['a.md'] }, { kind: 'guide', patterns: ['b.md'] }] }), 'a.md': '# A\n', 'b.md': '# B\n' }],
  ]
  let failed = 0
  for (const [kind, check, invalidFiles, validFiles] of cases) {
    const invalid = withFixtures(invalidFiles, (dir) => RUNNERS[kind](dir, check))
    const valid = withFixtures(validFiles, (dir) => RUNNERS[kind](dir, check))
    if (invalid.length === 0) {
      console.error(`FAIL ${kind}: invalid fixture was accepted`)
      failed += 1
    } else if (valid.length > 0) {
      console.error(`FAIL ${kind}: valid fixture was rejected: ${valid[0]}`)
      failed += 1
    } else {
      console.log(`PASS ${kind}: invalid rejected; valid accepted`)
    }
  }
  const covered = new Set(cases.map(([kind]) => kind))
  const uncovered = SUPPORTED_KINDS.filter((kind) => !covered.has(kind))
  if (uncovered.length > 0) {
    console.error(`FAIL kind-coverage: no negative control for ${uncovered.join(', ')}`)
    failed += 1
  } else {
    console.log(`PASS kind-coverage: all ${SUPPORTED_KINDS.length} kinds have a runner and a negative control`)
  }

  const empty = withFixtures({ 'unrelated.txt': 'nothing\n' }, (dir) => runChecks(dir, [{ id: 'self-empty', kind: 'budget', patterns: ['AGENTS.md'], maxLines: 10 }]))
  if (empty[0][1].length > 0) console.log('PASS empty-corpus: a check matching no file was rejected')
  else {
    console.error('FAIL empty-corpus: a check matching no file passed')
    failed += 1
  }

  const wordCheck = { id: 'self-words', kind: 'budget', patterns: ['NOTE.md'], maxWords: 10 }
  const overWords = withFixtures({ 'NOTE.md': 'one two three four five six seven eight nine ten eleven\n' }, (dir) => RUNNERS.budget(dir, wordCheck))
  const underWords = withFixtures({ 'NOTE.md': 'one two three\n' }, (dir) => RUNNERS.budget(dir, wordCheck))
  if (overWords.length > 0 && underWords.length === 0) console.log('PASS budget-words: word ceiling fires independently')
  else {
    console.error('FAIL budget-words: word ceiling did not fire or rejected a short file')
    failed += 1
  }

  const byteCheck = { id: 'self-bytes', kind: 'budget', patterns: ['NOTE.md'], maxBytes: 10 }
  const overBytes = withFixtures({ 'NOTE.md': 'x'.repeat(20) }, (dir) => RUNNERS.budget(dir, byteCheck))
  const underBytes = withFixtures({ 'NOTE.md': 'x' }, (dir) => RUNNERS.budget(dir, byteCheck))
  if (overBytes.length > 0 && underBytes.length === 0) console.log('PASS budget-bytes: byte ceiling fires independently')
  else {
    console.error('FAIL budget-bytes: byte ceiling did not fire or rejected a short file')
    failed += 1
  }

  const publishProbes = [
    ['public-glob', { public: ['docs/*.md'], internal: [] }, { 'docs/a.md': '# A\n' }],
    ['public-missing', { public: ['docs/a.md', 'docs/gone.md'], internal: [] }, { 'docs/a.md': '# A\n' }],
    ['ambiguous', { public: ['docs/a.md'], internal: [{ pattern: 'docs/*.md', reason: 'both shapes' }] }, { 'docs/a.md': '# A\n' }],
    ['internal-no-reason', { public: ['docs/a.md'], internal: [{ pattern: 'docs/b.md' }] }, { 'docs/a.md': '# A\n', 'docs/b.md': '# B\n' }],
  ]
  for (const [name, manifest, files] of publishProbes) {
    const fixture = withFixtures({ ...files, 'docs/publish.json': JSON.stringify(manifest) }, (dir) => checkPublishManifest(dir, {
      id: `self-${name}`,
      patterns: ['docs/*.md'],
      manifest: 'docs/publish.json',
    }))
    if (fixture.length > 0) console.log(`PASS publish-${name}: rejected`)
    else {
      console.error(`FAIL publish-${name}: accepted`)
      failed += 1
    }
  }
  if (failed > 0) {
    console.error(`self-test: ${failed} failure(s)`)
    return false
  }
  console.log(`self-test ok: ${cases.length} check kinds + empty corpus + extra negative controls`)
  return true
}
