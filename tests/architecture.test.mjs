import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUSINESS_TOOLS,
  TOOL_DOMAINS,
} from './support/public-surface.mjs'

/**
 * The current flat module graph, pinned as executable structure.
 *
 * The tool-domain proposal will move modules later; until that migration is
 * approved, these tests are the minimal executable version of its direction
 * rules: the host entry is a sink, the browser half sees only shared contracts,
 * the tool assembly is one-way, and every registered tool has exactly one
 * owning domain module. Pure helpers keep the negative controls cheap: each
 * rule is proven to reject a synthetic bad graph, not just to accept this one.
 */
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** Modules the browser bundle may import from the host half. */
const CONTRACT_MODULES = new Set(['src/api-contract.ts', 'src/inbox-contract.ts', 'src/notice-contract.ts'])

/** Every `.ts`/`.tsx` file under `dir`, as repo-relative POSIX paths. */
function sourceFiles(dir) {
  const found = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        found.push(relative(root, full).split(sep).join('/'))
      }
    }
  }
  visit(dir)
  return found.sort()
}

/** Relative specifiers imported or re-exported by one source text. */
function relativeSpecifiers(text) {
  const specs = []
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    if (match[1].startsWith('.')) specs.push(match[1])
  }
  return specs
}

/** Resolve one relative specifier against the known source file set. */
function resolveSpecifier(fromFile, spec, files) {
  const clean = spec.split('?')[0]
  const base = join(dirname(fromFile), clean).split(sep).join('/')
  const candidates = clean.endsWith('.js')
    ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]
    : clean.endsWith('.ts') || clean.endsWith('.tsx')
      ? [base]
      : [`${base}.ts`, `${base}.tsx`]
  return candidates.find((candidate) => files.has(candidate)) ?? null
}

/** The import graph restricted to source files; unresolved relative edges are reported separately. */
function buildGraph(files, texts) {
  const graph = new Map()
  const unresolved = []
  for (const file of files) {
    const deps = new Set()
    for (const spec of relativeSpecifiers(texts.get(file))) {
      const target = resolveSpecifier(file, spec, files)
      if (target === null) unresolved.push(`${file} -> ${spec}`)
      else deps.add(target)
    }
    graph.set(file, deps)
  }
  return { graph, unresolved }
}

/** Directed cycles in a graph, each as a node path ending at its start node. */
function findCycles(graph) {
  const cycles = []
  const state = new Map()
  const stack = []
  const visit = (node) => {
    state.set(node, 1)
    stack.push(node)
    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue
      const depState = state.get(dep) ?? 0
      if (depState === 1) cycles.push([...stack.slice(stack.indexOf(dep)), dep])
      else if (depState === 0) visit(dep)
    }
    stack.pop()
    state.set(node, 2)
  }
  for (const node of graph.keys()) if ((state.get(node) ?? 0) === 0) visit(node)
  return cycles
}

/** Files that import the host entry; the entry must be a sink. */
function entrySinkProblems(graph, entry = 'src/index.ts') {
  return [...graph]
    .filter(([, deps]) => deps.has(entry))
    .map(([file]) => `${file} imports ${entry}`)
}

/** Browser modules may import only client modules and the shared contracts. */
function clientBoundaryProblems(graph, allowed = CONTRACT_MODULES) {
  const problems = []
  for (const [file, deps] of graph) {
    if (!file.startsWith('src/client/')) continue
    for (const dep of deps) {
      if (dep.startsWith('src/client/') || allowed.has(dep)) continue
      problems.push(`${file} imports ${dep}`)
    }
  }
  return problems
}

/** Only the host entry may import the tool assembly, and domain modules must not import it back. */
function assemblyProblems(graph, domainFiles, toolsFile = 'src/tools.ts', entry = 'src/index.ts') {
  const problems = []
  const importers = [...graph]
    .filter(([, deps]) => deps.has(toolsFile))
    .map(([file]) => file)
  if (importers.length !== 1 || importers[0] !== entry) {
    problems.push(`${toolsFile} must be imported only by ${entry}; importers: ${importers.join(', ') || 'none'}`)
  }
  for (const file of domainFiles) {
    for (const forbidden of [toolsFile, entry]) {
      if ((graph.get(file) ?? new Set()).has(forbidden)) problems.push(`${file} imports ${forbidden}`)
    }
  }
  return problems
}

/** Contract modules stay free of host runtime imports. */
function contractProblems(graph, contracts = CONTRACT_MODULES) {
  const problems = []
  for (const file of contracts) {
    for (const dep of graph.get(file) ?? []) {
      if (!contracts.has(dep)) problems.push(`${file} imports ${dep}`)
    }
  }
  return problems
}

/**
 * Registration mapping from name to owning module, register-function calls, and
 * the assembly entry call. `sources` is a Map of repo-relative path to text.
 */
function registrationProblems(sources, toolDomains, toolsFile = 'src/tools.ts', entry = 'src/index.ts') {
  const problems = []
  const owners = new Map()
  for (const [file, text] of sources) {
    for (const match of text.matchAll(/name:\s*'((?:cowork_)[a-z_]+)'/g)) {
      if (!owners.has(match[1])) owners.set(match[1], new Set())
      owners.get(match[1]).add(file)
    }
  }
  for (const [file, names] of toolDomains) {
    for (const name of names) {
      const files = owners.get(name)
      if (files === undefined) {
        problems.push(`${file} does not register ${name}`)
        continue
      }
      if (files.size !== 1 || !files.has(file)) {
        problems.push(`${name} is registered by ${[...files].join(', ')}; expected only ${file}`)
      }
    }
  }
  const mapped = new Set(toolDomains.flatMap(([, names]) => names))
  assert.deepEqual([...mapped].sort(), BUSINESS_TOOLS, 'TOOL_DOMAINS must cover exactly the public tool set')

  const toolsText = sources.get(toolsFile) ?? ''
  for (const [file, text] of sources) {
    if (file === toolsFile) continue
    for (const match of text.matchAll(/^export function (register\w+Tools)\(/gm)) {
      const fn = match[1]
      const calls = (toolsText.match(new RegExp(`\\b${fn}\\(`, 'g')) ?? []).length
      if (calls !== 1) problems.push(`${file} exports ${fn}, expected exactly one call in ${toolsFile}, found ${calls}`)
    }
  }
  if (!/\bregisterCoworkTools\(/.test(toolsText)) problems.push(`${toolsFile} does not define registerCoworkTools`)
  if (!(sources.get(entry) ?? '').includes('registerCoworkTools(')) {
    problems.push(`${entry} does not call registerCoworkTools`)
  }
  return problems
}

const files = sourceFiles(join(root, 'src'))
const texts = new Map(files.map((file) => [file, readFileSync(join(root, file), 'utf8')]))
const { graph, unresolved } = buildGraph(new Set(files), texts)
const domainFiles = TOOL_DOMAINS.map(([file]) => file)

test('every relative import in src resolves to a source file', () => {
  assert.deepEqual(unresolved, [])
})

test('the host source graph has no import cycles', () => {
  assert.deepEqual(findCycles(graph), [])
  // Negative control: the detector must see a cycle when one exists.
  const cyclic = new Map([
    ['src/a.ts', new Set(['src/b.ts'])],
    ['src/b.ts', new Set(['src/a.ts'])],
  ])
  assert.deepEqual(findCycles(cyclic), [['src/a.ts', 'src/b.ts', 'src/a.ts']])
})

test('the host entry is a sink and only it imports the tool assembly', () => {
  assert.deepEqual(entrySinkProblems(graph), [])
  assert.deepEqual(assemblyProblems(graph, domainFiles), [])
  // Negative control: entry imports and assembly imports are both rejected.
  const bad = new Map([
    ['src/index.ts', new Set()],
    ['src/tools.ts', new Set()],
    ['src/route-tools.ts', new Set(['src/index.ts', 'src/tools.ts'])],
    ['src/other.ts', new Set(['src/index.ts', 'src/tools.ts'])],
  ])
  assert.ok(entrySinkProblems(bad).length > 0)
  assert.ok(assemblyProblems(bad, ['src/route-tools.ts']).length > 0)
})

test('the browser half imports only client modules and shared contracts', () => {
  assert.deepEqual(clientBoundaryProblems(graph), [])
  const bad = new Map([
    ['src/client/api.ts', new Set(['src/client/model.ts', 'src/store/project-store.ts', 'src/api-contract.ts'])],
  ])
  assert.ok(clientBoundaryProblems(bad).some((problem) => problem.includes('src/store/project-store.ts')))
})

test('contract modules do not import host runtime modules', () => {
  assert.deepEqual(contractProblems(graph), [])
  const bad = new Map([
    ['src/api-contract.ts', new Set(['src/inbox-contract.ts', 'src/store/schema.ts'])],
    ['src/inbox-contract.ts', new Set()],
    ['src/notice-contract.ts', new Set()],
  ])
  assert.ok(contractProblems(bad).some((problem) => problem.includes('src/store/schema.ts')))
})

test('every registered tool has exactly one domain module and one assembly call', () => {
  assert.deepEqual(registrationProblems(texts, TOOL_DOMAINS), [])
  const badSources = new Map([
    ['src/tools.ts', 'export function registerCoworkTools() {}\nregisterRouteTools(host)\n'],
    ['src/index.ts', 'export function apply() { registerCoworkTools(ctx) }\n'],
    ['src/route-tools.ts', "export function registerRouteTools() { name: 'cowork_route' }\nexport function registerExtraTools() {}\n"],
    ['src/topic-tools.ts', "export function registerTopicTools() { name: 'cowork_route' }\n"],
  ])
  const problems = registrationProblems(badSources, TOOL_DOMAINS)
  assert.ok(problems.some((problem) => problem.includes('cowork_route')))
  assert.ok(problems.some((problem) => problem.includes('registerExtraTools')))
  assert.ok(problems.some((problem) => problem.includes('does not register')))
})
