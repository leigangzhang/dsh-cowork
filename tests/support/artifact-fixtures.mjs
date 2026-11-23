/**
 * Shared fixtures for the artifact suites: a temporary repository, a fake host
 * filesystem with opaque version tokens, a record builder, and a panel harness
 * that registers the real artifact routes over the real runtime manager.
 *
 * The fake host fs implements the same port the production adapter consumes
 * (`resolve`/`stat`/`readText`/`writeText`) so route tests exercise the real
 * adapter and store against real files, without a running DSH host.
 */
import './ts-hook.mjs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const artifactContract = await import('../../src/panel/artifact-contract.ts')
export const artifactPaths = await import('../../src/domains/artifact/paths.ts')
export const artifactAnchor = await import('../../src/domains/artifact/anchor.ts')
export const artifactState = await import('../../src/domains/artifact/state.ts')
export const artifactSchema = await import('../../src/store/artifact-schema.ts')
export const artifactStore = await import('../../src/store/artifact-store.ts')
export const artifactFiles = await import('../../src/platform/artifact-files.ts')
export const artifactErrors = await import('../../src/domains/artifact/errors.ts')
export const artifactEvents = await import('../../src/platform/artifact-events.ts')
export const artifactRuntime = await import('../../src/platform/artifact-runtime.ts')
export const artifactApi = await import('../../src/panel/artifact-api.ts')
export const api = await import('../../src/panel/api.ts')

/** A fixed clock for every recorded timestamp. */
export const NOW = new Date('2026-02-01T12:00:00.000Z')

/** The fake project id the seeded document carries. */
export const PROJECT_ID = 'example.com/acme/repo'

/** The session id every harness resolves through the fake session listing. */
export const SESSION = 'session-1'

/** Lowercase hex SHA-256 of one UTF-8 string. */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Create a temporary repository with the given files (project-relative POSIX
 * paths). Returns helpers to read, write, and remove it.
 */
export async function makeRepo(files = {}) {
  const repoPath = await mkdtemp(join(tmpdir(), 'cowork-artifacts-'))
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(repoPath, path)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, content)
  }
  return {
    repoPath,
    async read(path) {
      return readFile(join(repoPath, path), 'utf8')
    },
    async write(path, content) {
      const absolute = join(repoPath, path)
      await mkdir(join(absolute, '..'), { recursive: true })
      await writeFile(absolute, content)
    },
    async remove() {
      await rm(repoPath, { recursive: true, force: true })
    },
  }
}

/**
 * A host fs double with opaque version tokens derived from content.
 *
 * `failures` maps a target path to the error code `stat`/`readText`/
 * `writeText` should throw, so the adapter's error mapping is exercised.
 */
export function fakeHostFs(options = {}) {
  const calls = []
  const failures = options.failures ?? new Map()
  const staleOnFirstWrite = new Set(options.staleOnFirstWrite ?? [])
  const staleAlways = new Set(options.staleAlways ?? [])
  const writeFailures = options.writeFailures ?? new Map()
  let staleServed = false
  const tokenOf = async (path) => {
    try {
      return sha256(await readFile(path, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      if (error.code === 'EISDIR') {
        const info = await stat(path)
        return `dir:${info.mtimeMs}`
      }
      throw error
    }
  }
  const fail = async (path) => {
    const real = await realpath(path).catch(() => path)
    const code = failures.get(path) ?? failures.get(real)
    if (code === undefined) return
    throw Object.assign(new Error(`forced ${code} for ${path}`), { code })
  }
  return {
    calls,
    async resolve(path) {
      calls.push(['resolve', path])
      return { targetKey: path, displayPath: path }
    },
    async stat(target) {
      calls.push(['stat', target.targetKey])
      await fail(target.targetKey)
      try {
        const info = await stat(target.targetKey)
        const token = await tokenOf(target.targetKey)
        return {
          version: token ?? `ino:${info.ino}`,
          type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          size: info.size,
        }
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
        throw error
      }
    },
    async readText(target) {
      calls.push(['readText', target.targetKey])
      await fail(target.targetKey)
      return readFile(target.targetKey, 'utf8')
    },
    async writeText(target, content, expected) {
      calls.push(['writeText', target.targetKey, content, expected])
      await fail(target.targetKey)
      const before = await readFile(target.targetKey, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      const matches = (entry) => target.targetKey === entry || target.targetKey.endsWith(`/${entry}`)
      for (const [entry, code] of writeFailures) {
        if (matches(entry)) throw Object.assign(new Error(`forced ${code}`), { code })
      }
      if ([...staleAlways].some(matches)) {
        throw Object.assign(new Error('stale version'), { code: 'FS_STALE_VERSION' })
      }
      const staleTarget = [...staleOnFirstWrite].some(matches)
      if (staleTarget && !staleServed) {
        staleServed = true
        await writeFile(target.targetKey, `${before ?? ''}concurrent-model-line\n`)
        throw Object.assign(new Error('stale version'), { code: 'FS_STALE_VERSION' })
      }
      if (expected !== undefined) {
        const current = await tokenOf(target.targetKey)
        if (current !== expected.version) {
          throw Object.assign(new Error('stale version'), { code: 'FS_STALE_VERSION' })
        }
      }
      await writeFile(target.targetKey, content)
      return {
        version: await tokenOf(target.targetKey),
        before,
        after: content,
      }
    },
  }
}

/** One artifact file entry, valid against the schema. */
export function makeFile(overrides = {}) {
  return {
    path: 'docs/spec.md',
    mediaType: 'text/markdown',
    editable: true,
    size: 10,
    sha256: 'a'.repeat(64),
    revision: 1,
    fsVersion: 'v1',
    missing: false,
    ...overrides,
  }
}

/** One artifact record, valid against the schema. */
export function makeRecord(overrides = {}) {
  return {
    version: 1,
    artifactId: 'artifact-11111111-1111-4111-8111-111111111111',
    projectId: PROJECT_ID,
    ownerSessionId: SESSION,
    title: 'Spec',
    type: 'text',
    status: 'pending-view',
    files: [makeFile()],
    primaryPath: 'docs/spec.md',
    revision: 1,
    commentCount: 0,
    attachmentCount: 0,
    activeDispatch: null,
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  }
}

/** One published-attachment row, valid against the schema. */
export function makeAttachmentPublish(overrides = {}) {
  return {
    version: 1,
    attachmentId: 'attachment-11111111-1111-4111-8111-111111111111',
    name: 'chart.png',
    mediaType: 'image/png',
    size: 12,
    sha256: 'a'.repeat(64),
    source: 'model',
    publishedAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  }
}

/** One comment event, valid against the schema. */
export function makeComment(overrides = {}) {
  return {
    version: 1,
    eventId: 'comment-event-1',
    artifactId: 'artifact-11111111-1111-4111-8111-111111111111',
    commentId: 'comment-1',
    threadId: 'comment-1',
    type: 'create',
    author: 'user',
    body: 'please tighten this paragraph',
    createdAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Build one Request for a registered route. */
export function request(path, { method = 'GET', query = {}, body, headers = {} } = {}) {
  const url = new URL(`http://127.0.0.1:3080${path}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const requestHeaders = new Headers({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', ...headers })
  const init = { method, headers: requestHeaders }
  if (body !== undefined) {
    requestHeaders.set('content-type', 'application/json')
    init.body = JSON.stringify(body)
  }
  return new Request(url, init)
}

/** Build one raw-body Request (upload) for a registered route. */
export function rawRequest(path, { query = {}, bytes = new Uint8Array(), contentType = 'application/octet-stream' } = {}) {
  const url = new URL(`http://127.0.0.1:3080${path}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return new Request(url, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'content-type': contentType,
    },
    body: bytes,
  })
}

/** Read one JSON route response. */
export async function jsonOf(response) {
  return JSON.parse(await response.text())
}

/**
 * Register every panel route (including the artifact routes) over a temporary
 * repository, a fake session listing, and the real runtime manager.
 */
export async function createHarness(options = {}) {
  const repoPath = options.repoPath ?? (await makeRepo(options.files ?? {})).repoPath
  const { fakePorts, makeDocument } = await import('./api-fixtures.mjs')
  const logs = []
  const manager = new artifactRuntime.ArtifactRuntimeManager({
    hostFs: options.hostFs === null ? undefined : (options.hostFs ?? fakeHostFs(options.fsOptions)),
    log: (message) => logs.push(message),
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
  })
  const { ports } = fakePorts({
    root: repoPath,
    sessions: [{ sessionId: SESSION, cwd: repoPath, ...(options.sessionTitle === undefined ? {} : { title: options.sessionTitle }) }],
    ...(options.openWorkspacePath === undefined ? {} : { openWorkspacePath: options.openWorkspacePath }),
    ...(options.listFailsAfterCalls === undefined ? {} : { listFailsAfterCalls: options.listFailsAfterCalls }),
    document: options.document ?? makeDocument({ projectId: PROJECT_ID }),
    now: options.now ?? (() => new Date(NOW)),
  })
  ports.artifact = { runtimeFor: (path) => manager.runtimeFor(path) }
  ports.log = (message) => logs.push(message)
  const routes = new Map()
  const connection = {
    fetch: {
      register(route) {
        routes.set(route.path, route.fetch)
        return async () => {}
      },
    },
  }
  const ctx = {
    get: (name) => (name === 'connection' ? connection : undefined),
    effect: (callback) => callback(),
    logger: { warn() {} },
  }
  api.registerCoworkApi(ctx, ports)
  return {
    repoPath,
    ports,
    manager,
    logs,
    routes,
    request: (path, init) => routes.get(path)(request(path, init)),
    runtime: () => manager.runtimeFor(repoPath),
    cleanup: async () => {
      manager.dispose()
      // A dispatch timer or in-flight state write may land just after dispose;
      // give it a beat and retry the removal instead of racing it.
      await new Promise((resolve) => setTimeout(resolve, 30))
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await rm(repoPath, { recursive: true, force: true })
          return
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
      }
    },
  }
}

/** Create a symlink inside the repo pointing at `target`; helper for escape tests. */
export async function linkInside(repoPath, linkPath, target) {
  const absolute = join(repoPath, linkPath)
  await mkdir(join(absolute, '..'), { recursive: true })
  await symlink(target, absolute)
}
