#!/usr/bin/env node
/**
 * Build the browser half into `lib/client.js`.
 *
 * The host's client module loader (`window.__ModuleLoader__`) expects one
 * pre-bundled CJS closure per plugin, with `react` / `react/jsx-runtime` left to
 * the host's module table. The repository has no client bundler dependency of
 * its own, so this script reuses the esbuild binary that ships inside the DSH
 * source checkout (the same checkout `scripts/build/build.sh` uses for types).
 *
 * Output shape:
 *
 *   window.__ModuleLoader__.load({ id: "@dsh-external/dsh-cowork", factory: (require) => { var module = { exports: {} }; var exports = module.exports; … });
 *
 * Idempotent: it always rewrites `lib/client.js` (+ source map) from `src/client`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ENTRY = join(ROOT, 'src', 'client', 'index.tsx')
const OUTFILE = join(ROOT, 'lib', 'client.js')
const PACKAGE_NAME = '@dsh-external/dsh-cowork'

const CHECKOUT_CANDIDATES = [
  process.env.DSH_CHECKOUT,
  join(process.env.HOME ?? '', 'Workspace', 'deepseek-harness'),
  join(process.env.HOME ?? '', 'deepseek-harness'),
  join(process.env.HOME ?? '', 'dsh-harness'),
  join(process.env.HOME ?? '', 'dsh'),
  join(process.env.HOME ?? '', '.dsh', 'dsh-harness'),
]

const BANNER = `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`
const FOOTER = '\n    return module.exports;\n  }\n});'

/** Locate a DSH source checkout that can provide esbuild. */
function findCheckout() {
  for (const candidate of CHECKOUT_CANDIDATES) {
    if (candidate === undefined || candidate === '') continue
    if (existsSync(join(candidate, 'packages'))) return candidate
  }
  return undefined
}

/** Compare two dotted version strings numerically. */
function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Find the newest esbuild binary inside the checkout's pnpm store. */
function findEsbuild(checkout) {
  const store = join(checkout, 'node_modules', '.pnpm')
  if (!existsSync(store)) return undefined
  const candidates = readdirSync(store)
    .map(name => /^esbuild@(\d+\.\d+\.\d+)$/.exec(name))
    .filter(match => match !== null)
    .map(match => match[1])
    .sort(compareVersions)
    .reverse()
  for (const version of candidates) {
    const binary = join(store, `esbuild@${version}`, 'node_modules', 'esbuild', 'bin', 'esbuild')
    if (existsSync(binary)) return { binary, version }
  }
  return undefined
}

function fail(message) {
  console.error(`build-client: ${message}`)
  process.exit(1)
}

const checkout = findCheckout()
if (checkout === undefined) {
  fail('找不到 DSH 源码 checkout（含 packages/）。设置 DSH_CHECKOUT 指向它，例如 DSH_CHECKOUT=~/Workspace/deepseek-harness npm run build:client')
}
const esbuild = findEsbuild(checkout)
if (esbuild === undefined) {
  fail(`在 ${join(checkout, 'node_modules', '.pnpm')} 下找不到 esbuild@*（需要 node_modules/.pnpm/esbuild@x.y.z/node_modules/esbuild/bin/esbuild）`)
}

console.log(`=== build-client: ${ENTRY} → ${OUTFILE} (esbuild ${esbuild.version}) ===`)
const result = spawnSync(esbuild.binary, [
  '--bundle',
  ENTRY,
  '--format=cjs',
  '--platform=browser',
  '--target=es2022',
  '--jsx=automatic',
  '--charset=utf8',
  '--legal-comments=none',
  '--external:react',
  '--external:react/jsx-runtime',
  '--external:react-dom',
  '--external:@deepseek-ai/*',
  `--outfile=${OUTFILE}`,
  '--sourcemap',
  `--banner:js=${BANNER}`,
  `--footer:js=${FOOTER}`,
  '--log-level=warning',
], { cwd: ROOT, stdio: 'inherit' })

if (result.error !== undefined) fail(`esbuild 启动失败：${result.error.message}`)
if (result.status !== 0) fail(`esbuild 退出码 ${result.status ?? 'null'}`)

// Verify the loader contract the host checks before injecting the plugin.
const output = readFileSync(OUTFILE, 'utf8')
const firstLine = output.split('\n', 1)[0] ?? ''
const problems = []
if (!firstLine.includes(`window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}`)) {
  problems.push('首行不是 window.__ModuleLoader__.load({ id: "@dsh-external/dsh-cowork" … 的加载器形态')
}
if (!/inject\s*=\s*\[[^\]]*['"]slots['"]/.test(output)) problems.push('产物里找不到 inject = ["slots"] 声明（host 静态预检会拒绝注入）')
if (!/name:\s*["']sidebar\.right\.pane\.tab["']/.test(output)) problems.push('产物里找不到字面量 slot 名 sidebar.right.pane.tab')
if (!/name:\s*["']sidebar\.footer\.action["']/.test(output)) problems.push('产物里找不到字面量 slot 名 sidebar.footer.action')
if (/require\(["']node:/.test(output)) problems.push('产物包含 require("node:*")（客户端不能使用 node 内置模块）')
if (!output.includes('require("react")')) problems.push('react 没有被保留为外部 require("react")')
if (!output.includes('require("react/jsx-runtime")')) problems.push('react/jsx-runtime 没有被保留为外部 require')
if (problems.length > 0) {
  for (const problem of problems) console.error(`build-client: ${problem}`)
  process.exit(1)
}

const size = statSync(OUTFILE).size
console.log(`=== build-client: 完成 ${OUTFILE} (${Math.round(size / 1024)} KB) ===`)
