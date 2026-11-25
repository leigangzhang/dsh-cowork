#!/usr/bin/env node
/**
 * Validate the publish artifact without writing a tarball.
 *
 * Git owns source and devDependencies; the npm package must contain only the
 * prebuilt host/client output and the files needed to mount the plugin. The
 * check fails on source, tests, source maps, dev-only files, or a dependency
 * graph that would make consumers install build-time packages.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PACKED_BUDGET = 6 * 1024 * 1024
const UNPACKED_BUDGET = 20 * 1024 * 1024
const CLIENT_BUDGET = 16 * 1024 * 1024

const required = [
  'package.json',
  'lib/index.js',
  'lib/client.js',
  'lib/types/index.d.ts',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
]

const forbidden = [
  /^src\//,
  /^tests\//,
  /^scripts\//,
  /^docs\//,
  /^node_modules\//,
  /^\.dsh-cowork\//,
  /(^|\/)\.env(\.|$)/,
  /\.map$/,
  /\.tgz$/,
  /\.tsbuildinfo$/,
]

function fail(message) {
  console.error(`pack-check: ${message}`)
  process.exit(1)
}

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const runtimeDeps = Object.keys(packageJson.dependencies ?? {})
if (runtimeDeps.length > 0) {
  fail(`runtime dependencies must stay empty or be reviewed: ${runtimeDeps.join(', ')}`)
}
if (packageJson.private === true) fail('package.json still has private: true')

const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: ROOT,
  encoding: 'utf8',
})
if (result.error !== undefined) fail(`npm pack failed to start: ${result.error.message}`)
if (result.status !== 0) fail(`npm pack exited ${result.status ?? 'null'}: ${result.stderr.trim()}`)

let packed
try {
  packed = JSON.parse(result.stdout)[0]
} catch (error) {
  fail(`npm pack did not return JSON: ${error instanceof Error ? error.message : String(error)}`)
}
if (packed === undefined) fail('npm pack returned no package record')

const files = new Map((packed.files ?? []).map(entry => [entry.path, entry.size]))
for (const path of required) {
  if (!files.has(path)) fail(`missing required artifact: ${path}`)
}
for (const path of files.keys()) {
  if (forbidden.some(pattern => pattern.test(path))) fail(`forbidden artifact: ${path}`)
}

if (packed.size > PACKED_BUDGET) {
  fail(`packed size ${(packed.size / 1024 / 1024).toFixed(1)} MiB exceeds ${PACKED_BUDGET / 1024 / 1024} MiB`)
}
if (packed.unpackedSize > UNPACKED_BUDGET) {
  fail(`unpacked size ${(packed.unpackedSize / 1024 / 1024).toFixed(1)} MiB exceeds ${UNPACKED_BUDGET / 1024 / 1024} MiB`)
}
const clientSize = files.get('lib/client.js')
if (clientSize > CLIENT_BUDGET) {
  fail(`lib/client.js is ${(clientSize / 1024 / 1024).toFixed(1)} MiB, over ${CLIENT_BUDGET / 1024 / 1024} MiB`)
}

console.log(`PASS pack-check: ${packed.filename}`)
console.log(`  files: ${files.size}`)
console.log(`  packed: ${(packed.size / 1024 / 1024).toFixed(1)} MiB`)
console.log(`  unpacked: ${(packed.unpackedSize / 1024 / 1024).toFixed(1)} MiB`)
console.log(`  client.js: ${(clientSize / 1024 / 1024).toFixed(1)} MiB`)
