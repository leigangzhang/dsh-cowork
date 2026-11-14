import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUSINESS_TOOLS,
  TOOL_DOMAINS,
} from '../support/public-surface.mjs'

/**
 * The source layers, import directions, and tool ownership, as executable
 * structure.
 *
 * `src/index.ts` is the only entry and re-exports `app/`; the composition root
 * (`app/`) may use every layer; `tools`/`panel`/`dev` sit above `platform`,
 * `domains`, and `store`; `store` may use domain rules but not platform
 * adapters; and a domain may import only another domain or one of the
 * enumerated pure leaves. Each rule is proven to reject a synthetic bad graph,
 * not just to accept this one. The tool → domain mapping and public names come
 * from `tests/support/public-surface.mjs`, so a rename cannot leave this file
 * green while the public-surface snapshot goes stale.
 */
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

/** Wire contracts the browser bundle and every layer may import. */
const CONTRACT_MODULES = new Set([
  'src/panel/api-contract.ts',
  'src/panel/inbox-contract.ts',
  'src/panel/notice-contract.ts',
])

/**
 * Pure leaves: modules with no host, filesystem, or clock dependency that any
 * layer may import without creating a direction edge. `store/schema.ts` is the
 * on-disk type/validation contract; `platform/tool-model.ts` is the model-facing
 * tool protocol. Both import nothing outside themselves.
 */
const PURE_LEAVES = new Set([...CONTRACT_MODULES, 'src/store/schema.ts', 'src/platform/tool-model.ts'])

/** The only entry module and the only composition root. */
const ENTRY = 'src/index.ts'
const APP_DIR = 'src/app/'
const TOOLS_ASSEMBLY = 'src/app/tools.ts'
const APPLY = 'src/app/apply.ts'

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

/** Non-relative specifiers imported or re-exported by one source text. */
function bareSpecifiers(text) {
  const specs = []
  for (const match of text.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    if (!match[1].startsWith('.')) specs.push(match[1])
  }
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (!match[1].startsWith('.')) specs.push(match[1])
  }
  return specs
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
function entrySinkProblems(graph, entry = ENTRY) {
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
 * The only modules outside `src/domains/` a domain may import: the pure leaves
 * plus the two request/activity read models the request domain composes. Those
 * two stay until their callers accept an injected port; they are the deliberate
 * exceptions recorded in docs/handoff/TOOL_DOMAIN_MODULES_RECON.md.
 */
const DOMAIN_STORE_LEAVES = new Set([
  'src/store/schema.ts',
  'src/store/activity.ts',
  'src/store/request-store.ts',
])
const DOMAIN_EXTRA_ALLOWED = new Set([...PURE_LEAVES, ...DOMAIN_STORE_LEAVES])

/** Files that own raw filesystem or subprocess access by design. */
const FILESYSTEM_DOMAIN_OWNERS = new Set([
  'src/domains/isolation/checkout.ts',
  'src/domains/requests/request-open.ts',
])

/** Domain modules that import an implementation module or a host package. */
function domainImportProblems(graph, texts, domainFiles) {
  const problems = []
  for (const file of domainFiles) {
    for (const dep of graph.get(file) ?? []) {
      if (dep.startsWith('src/domains/') || DOMAIN_EXTRA_ALLOWED.has(dep)) continue
      problems.push(`${file} imports ${dep}`)
    }
    for (const spec of bareSpecifiers(texts.get(file) ?? '')) {
      if (!spec.startsWith('node:')) problems.push(`${file} imports host package ${spec}`)
    }
  }
  return problems
}

/** Domain modules that reach for raw filesystem or subprocess access outside the two owners. */
function domainFilesystemProblems(texts, domainFiles) {
  const problems = []
  for (const file of domainFiles) {
    if (FILESYSTEM_DOMAIN_OWNERS.has(file)) continue
    for (const spec of bareSpecifiers(texts.get(file) ?? '')) {
      if (spec === 'node:fs' || spec === 'node:fs/promises' || spec === 'node:child_process') {
        problems.push(`${file} imports ${spec}`)
      }
    }
  }
  return problems
}

/** Whether an import from `file` to `dep` moves upward into a layer it must not see. */
function layerViolation(file, dep) {
  if (file === ENTRY) return dep.startsWith(APP_DIR) ? null : `${file} imports outside the composition root`
  if (dep === ENTRY) return `${file} imports the entry`
  if (dep.startsWith(APP_DIR) && !file.startsWith(APP_DIR)) return `${file} imports the composition root`
  if (file.startsWith('src/tools/') || file.startsWith('src/panel/') || file.startsWith('src/dev/')) {
    return dep.startsWith(APP_DIR) ? `${file} imports the composition root` : null
  }
  if (file.startsWith('src/platform/')) {
    if (dep.startsWith('src/tools/') || dep.startsWith('src/panel/') || dep.startsWith('src/dev/')) {
      return `${file} imports a layer above platform`
    }
    return null
  }
  if (file.startsWith('src/store/')) {
    if (dep.startsWith('src/platform/') || dep.startsWith('src/tools/') || dep.startsWith('src/panel/') || dep.startsWith('src/dev/')) {
      return `${file} imports a layer above store`
    }
    return null
  }
  return null
}

/** Every upward import between the layers that are not covered by a narrower rule. */
function layerImportProblems(graph) {
  const problems = []
  for (const [file, deps] of graph) {
    if (file.startsWith('src/domains/') || file.startsWith('src/client/')) continue
    for (const dep of deps) {
      if (PURE_LEAVES.has(dep)) continue
      const problem = layerViolation(file, dep)
      if (problem !== null) problems.push(problem)
    }
  }
  return problems
}

/** Only the assembly may import a tool module; tool modules may not reach it back. */
function assemblyProblems(graph, toolModules, toolsFile = TOOLS_ASSEMBLY, assemblyFile = APPLY) {
  const problems = []
  const importers = [...graph]
    .filter(([, deps]) => deps.has(toolsFile))
    .map(([file]) => file)
  if (importers.length !== 1 || importers[0] !== assemblyFile) {
    problems.push(`${toolsFile} must be imported only by ${assemblyFile}; importers: ${importers.join(', ') || 'none'}`)
  }
  for (const file of toolModules) {
    for (const forbidden of [toolsFile, ENTRY, assemblyFile]) {
      if ((graph.get(file) ?? new Set()).has(forbidden)) problems.push(`${file} imports ${forbidden}`)
    }
  }
  return problems
}

/**
 * Registration mapping from name to owning module, register-function calls, and
 * the assembly entry call. `sources` is a Map of repo-relative path to text.
 */
function registrationProblems(sources, toolDomains, toolsFile = TOOLS_ASSEMBLY, assemblyFile = APPLY) {
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
  if (!(sources.get(assemblyFile) ?? '').includes('registerCoworkTools(')) {
    problems.push(`${assemblyFile} does not call registerCoworkTools`)
  }
  return problems
}

const files = sourceFiles(join(root, 'src'))
const texts = new Map(files.map((file) => [file, readFileSync(join(root, file), 'utf8')]))
const { graph, unresolved } = buildGraph(new Set(files), texts)
const toolModules = TOOL_DOMAINS.map(([file]) => file)
const domainModules = sourceFiles(join(root, 'src/domains'))

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

test('the host entry is a sink and only the assembly imports the tool modules', () => {
  assert.deepEqual(entrySinkProblems(graph), [])
  assert.deepEqual(assemblyProblems(graph, toolModules), [])
  // Negative control: entry imports and assembly imports are both rejected.
  const bad = new Map([
    ['src/index.ts', new Set()],
    ['src/app/apply.ts', new Set()],
    ['src/app/tools.ts', new Set()],
    ['src/platform/tool-runtime.ts', new Set([ENTRY, TOOLS_ASSEMBLY])],
    ['src/domains/routing/routing.ts', new Set([APPLY, TOOLS_ASSEMBLY])],
  ])
  assert.ok(entrySinkProblems(bad).length > 0)
  assert.ok(assemblyProblems(bad, ['src/platform/tool-runtime.ts', 'src/domains/routing/routing.ts']).length > 0)
  assert.deepEqual(entrySinkProblems(new Map([['src/app/apply.ts', new Set([ENTRY])]])), ['src/app/apply.ts imports src/index.ts'])
})

test('the browser half imports only client modules and shared contracts', () => {
  assert.deepEqual(clientBoundaryProblems(graph), [])
  const bad = new Map([
    ['src/client/api.ts', new Set(['src/client/model.ts', 'src/store/project-store.ts', 'src/panel/api-contract.ts'])],
  ])
  assert.ok(clientBoundaryProblems(bad).some((problem) => problem.includes('src/store/project-store.ts')))
})

test('contract modules do not import host runtime modules', () => {
  assert.deepEqual(contractProblems(graph), [])
  const bad = new Map([
    ['src/panel/api-contract.ts', new Set(['src/panel/inbox-contract.ts', 'src/store/schema.ts'])],
    ['src/panel/inbox-contract.ts', new Set()],
    ['src/panel/notice-contract.ts', new Set()],
  ])
  assert.ok(contractProblems(bad).some((problem) => problem.includes('src/store/schema.ts')))
})

test('domains import only domains and the declared pure leaves', () => {
  assert.ok(domainModules.length > 0, 'no domain modules found')
  assert.deepEqual(domainImportProblems(graph, texts, domainModules), [])

  // Negative control: an implementation module and a host package are rejected,
  // while the declared pure leaves stay green.
  const badGraph = new Map([
    ['src/domains/topic/topic.ts', new Set(['src/platform/tool-runtime.ts', 'src/store/project-store.ts', 'src/tools/topic.ts'])],
    ['src/domains/requests/request-schema.ts', new Set(['src/domains/routing/routing.ts'])],
  ])
  const badTexts = new Map([
    ['src/domains/topic/topic.ts', "import type { Context } from '@deepseek-ai/cordis'\n"],
    ['src/domains/requests/request-schema.ts', ''],
  ])
  const badProblems = domainImportProblems(badGraph, badTexts, [...badGraph.keys()])
  assert.ok(badProblems.some((problem) => problem.includes('src/platform/tool-runtime.ts')))
  assert.ok(badProblems.some((problem) => problem.includes('src/store/project-store.ts')))
  assert.ok(badProblems.some((problem) => problem.includes('src/tools/topic.ts')))
  assert.ok(badProblems.some((problem) => problem.includes('@deepseek-ai/cordis')))
  assert.ok(!badProblems.some((problem) => problem.includes('src/domains/routing/routing.ts')))

  const goodGraph = new Map([
    ['src/domains/topic/topic.ts', new Set([
      'src/store/schema.ts',
      'src/store/activity.ts',
      'src/store/request-store.ts',
      'src/platform/tool-model.ts',
      'src/panel/api-contract.ts',
      'src/panel/inbox-contract.ts',
      'src/panel/notice-contract.ts',
      'src/domains/routing/routing.ts',
    ])],
  ])
  assert.deepEqual(domainImportProblems(goodGraph, new Map(), [...goodGraph.keys()]), [])
})

test('only the isolation and request domains own node:fs and node:child_process', () => {
  assert.deepEqual(domainFilesystemProblems(texts, domainModules), [])

  const badTexts = new Map([
    ['src/domains/topic/topic.ts', "import { readFileSync } from 'node:fs'\n"],
    ['src/domains/isolation/checkout.ts', "import { execFile } from 'node:child_process'\n"],
  ])
  const problems = domainFilesystemProblems(badTexts, [...badTexts.keys()])
  assert.ok(problems.some((problem) => problem.includes('src/domains/topic/topic.ts')))
  assert.ok(!problems.some((problem) => problem.includes('src/domains/isolation/checkout.ts')))
})

test('layer imports point downward into platform, domains, and store', () => {
  assert.deepEqual(layerImportProblems(graph), [])
  const bad = new Map([
    ['src/index.ts', new Set(['src/platform/tool-runtime.ts', 'src/app/apply.ts'])],
    ['src/tools/topic.ts', new Set([APPLY, 'src/tools/project.ts'])],
    ['src/panel/api.ts', new Set(['src/platform/tool-runtime.ts'])],
    ['src/platform/tool-runtime.ts', new Set(['src/tools/topic.ts'])],
    ['src/store/project-store.ts', new Set(['src/platform/tool-runtime.ts'])],
  ])
  const problems = layerImportProblems(bad)
  assert.ok(problems.some((problem) => problem.includes('src/index.ts imports outside the composition root')))
  assert.ok(problems.some((problem) => problem.includes('src/tools/topic.ts imports the composition root')))
  assert.ok(problems.some((problem) => problem.includes('src/platform/tool-runtime.ts imports a layer above platform')))
  assert.ok(problems.some((problem) => problem.includes('src/store/project-store.ts imports a layer above store')))
  assert.deepEqual(layerImportProblems(new Map([['src/panel/api.ts', new Set(['src/platform/tool-runtime.ts', 'src/store/project-store.ts', 'src/panel/api-contract.ts'])]])), [])
})

test('every registered tool has exactly one domain module and one assembly call', () => {
  assert.deepEqual(registrationProblems(texts, TOOL_DOMAINS), [])
  const badSources = new Map([
    [TOOLS_ASSEMBLY, 'export function registerCoworkTools() {}\nregisterRouteTools(host)\n'],
    [APPLY, 'export function apply() { registerCoworkTools(ctx) }\n'],
    ['src/tools/route.ts', "export function registerRouteTools() { name: 'cowork_route' }\nexport function registerExtraTools() {}\n"],
    ['src/tools/topic.ts', "export function registerTopicTools() { name: 'cowork_route' }\n"],
  ])
  const problems = registrationProblems(badSources, TOOL_DOMAINS)
  assert.ok(problems.some((problem) => problem.includes('cowork_route')))
  assert.ok(problems.some((problem) => problem.includes('registerExtraTools')))
  assert.ok(problems.some((problem) => problem.includes('does not register')))
})
