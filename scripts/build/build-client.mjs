#!/usr/bin/env node
/**
 * Build the browser half into `lib/client.js`.
 *
 * The host's client module loader (`window.__ModuleLoader__`) expects one
 * pre-bundled CJS closure per plugin, with `react` / `react/jsx-runtime` left to
 * the host's module table. The esbuild binary comes from this repository's
 * devDependencies, so the build is reproducible without a DSH source checkout.
 *
 * Source maps are development-only. Release builds omit them so the packed
 * artifact stays small; set DSH_COWORK_SOURCEMAP=1 to emit `lib/client.js.map`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ENTRY = join(ROOT, 'src', 'client', 'index.tsx')
const OUTFILE = join(ROOT, 'lib', 'client.js')
const ESBUILD_BIN = join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild')
const PACKAGE_NAME = '@dsh-external/dsh-cowork'

const BANNER = `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`
const FOOTER = '\n    return module.exports;\n  }\n});'

function fail(message) {
  console.error(`build-client: ${message}`)
  process.exit(1)
}

if (!existsSync(ESBUILD_BIN)) {
  fail('找不到本地 esbuild；先运行 npm install')
}

console.log(`=== build-client: ${ENTRY} → ${OUTFILE} ===`)
const args = [
  '--bundle',
  ENTRY,
  '--format=cjs',
  '--platform=browser',
  '--target=es2022',
  '--jsx=automatic',
  '--charset=utf8',
  '--legal-comments=none',
  // Excalidraw's stylesheet is mounted as one <style> tag; the host loads a
  // single CJS closure and never requests a sibling CSS file.
  '--loader:.css=text',
  // Excalidraw publishes the same entry under development/production
  // conditions; its CSS export has no `default`, so the build must ask for the
  // production condition explicitly.
  '--conditions=production',
  '--define:process.env.NODE_ENV="production"',
  '--external:react',
  '--external:react/jsx-runtime',
  '--external:react-dom',
  '--external:react-dom/client',
  '--external:@deepseek-ai/*',
  `--outfile=${OUTFILE}`,
  `--banner:js=${BANNER}`,
  `--footer:js=${FOOTER}`,
  '--log-level=warning',
]
if (process.env.DSH_COWORK_SOURCEMAP === '1') args.push('--sourcemap')

const result = spawnSync(ESBUILD_BIN, args, { cwd: ROOT, stdio: 'inherit' })
if (result.error !== undefined) fail(`esbuild 启动失败：${result.error.message}`)
if (result.status !== 0) fail(`esbuild 退出码 ${result.status ?? 'null'}`)

// Verify the loader contract the host checks before injecting the plugin.
const output = readFileSync(OUTFILE, 'utf8')
const firstLine = output.split('\n', 1)[0] ?? ''
const problems = []
if (!firstLine.includes(`window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}`)) {
  problems.push('首行不是 window.__ModuleLoader__.load({ id: "@dsh-external/dsh-cowork" … 的加载器形态')
}
// Bundled dependencies may also export a binding named `inject`, so esbuild
// can rename ours (for example to `inject2`). The entry is the only module
// exported as `index_exports`; assert its export map rather than a matching
// line anywhere in the bundle.
const exportAt = output.lastIndexOf('__export(index_exports')
const entryBlock = exportAt === -1 ? '' : output.slice(exportAt, exportAt + 2048)
const entryExports = /__export\(index_exports,\s*\{([\s\S]*?)\}\);/.exec(entryBlock)
const entryMap = entryExports?.[1] ?? ''
if (!/inject:\s*\(\)\s*=>/.test(entryMap) || !/apply:\s*\(\)\s*=>/.test(entryMap) || !output.includes('["slots"]')) {
  problems.push('产物入口导出里找不到 inject → ["slots"] 与 apply（host 注入前会读取这两个导出）')
}
if (!/name:\s*["']sidebar\.right\.pane\.tab["']/.test(output)) problems.push('产物里找不到字面量 slot 名 sidebar.right.pane.tab')
if (!/name:\s*["']sidebar\.footer\.action["']/.test(output)) problems.push('产物里找不到字面量 slot 名 sidebar.footer.action')
if (/require\(["']node:/.test(output)) problems.push('产物包含 require("node:*")（客户端不能使用 node 内置模块）')
if (!output.includes('require("react")')) problems.push('react 没有被保留为外部 require("react")')
if (!output.includes('require("react/jsx-runtime")')) problems.push('react/jsx-runtime 没有被保留为外部 require')
if (!output.includes('require("react-dom")')) problems.push('react-dom 没有被保留为外部 require')

if (problems.length > 0) {
  for (const problem of problems) console.error(`build-client: ${problem}`)
  process.exit(1)
}

const size = statSync(OUTFILE).size
console.log(`=== build-client: 完成 ${OUTFILE} (${Math.round(size / 1024)} KB) ===`)
