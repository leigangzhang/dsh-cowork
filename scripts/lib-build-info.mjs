import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

export const BUILD_INFO_FORMAT = 'dsh-cowork-build-info-v1'
export const BUILD_INFO_FILE = 'lib/build-info.json'

/** Every source input that the build compiles, in stable order. */
export function sourceFiles(repoRoot = root) {
  const files = []
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const stat = statSync(path)
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) files.push(path)
    }
  }
  visit(resolve(repoRoot, 'src'))
  return files.sort()
}

/** Hash paths and bytes, not mtimes, so a checkout is reproducible. */
export function sourceDigest(repoRoot = root) {
  const hash = createHash('sha256')
  for (const path of sourceFiles(repoRoot)) {
    const name = relative(repoRoot, path).split(sep).join('/')
    hash.update(name)
    hash.update('\0')
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function buildInfoFor(repoRoot = root) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
  const files = sourceFiles(repoRoot)
  return {
    format: BUILD_INFO_FORMAT,
    packageVersion: pkg.version,
    sourceFileCount: files.length,
    sourceHash: sourceDigest(repoRoot),
  }
}

/** Return the drift reason, or null when lib was built from current src. */
export function buildInfoProblem(repoRoot = root) {
  let info
  let pkg
  try {
    info = JSON.parse(readFileSync(resolve(repoRoot, BUILD_INFO_FILE), 'utf8'))
    pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
  } catch (error) {
    return `cannot read ${BUILD_INFO_FILE} or package.json: ${error instanceof Error ? error.message : String(error)}`
  }
  if (info?.format !== BUILD_INFO_FORMAT) return `${BUILD_INFO_FILE} has an unknown format`
  if (info.packageVersion !== pkg.version) return `${BUILD_INFO_FILE} was built for ${String(info.packageVersion)}, package is ${String(pkg.version)}`
  const expected = buildInfoFor(repoRoot)
  if (info.sourceFileCount !== expected.sourceFileCount) {
    return `${BUILD_INFO_FILE} records ${String(info.sourceFileCount)} source files, current src has ${expected.sourceFileCount}`
  }
  if (info.sourceHash !== expected.sourceHash) return `${BUILD_INFO_FILE} sourceHash does not match current src; rerun npm run build`
  return null
}

export function writeBuildInfo(repoRoot = root) {
  return buildInfoFor(repoRoot)
}
