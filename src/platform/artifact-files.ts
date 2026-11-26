/**
 * Filesystem adapter for registered work-item files.
 *
 * The routes and tools never touch `node:fs` for a work-item file: they call
 * this port, which speaks project-relative POSIX paths and returns opaque
 * version tokens. The production adapter delegates content and version to the
 * host's `ctx.fs` (so a save guards on the host's freshness token) and uses the
 * local filesystem only to prove the resolved path is a regular file inside the
 * repository — the symlink escape check `ctx.fs` cannot express for us.
 *
 * The port stays small and structural so a unit test can stand in for it; the
 * adapter itself is exercised against a fake host service.
 */
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ArtifactFileV1 } from '../panel/artifact-contract.js'
import { isTextMediaType, normalizeArtifactPath } from '../domains/artifact/paths.js'
import { ArtifactDomainError } from '../domains/artifact/errors.js'

/** One observation of a registered file. */
export interface ArtifactFileStat {
  readonly exists: boolean
  readonly regular: boolean
  readonly size: number
  readonly version: string | null
}

/** One text read. */
export interface ArtifactTextRead {
  readonly content: string
  readonly size: number
  readonly version: string | null
}

/** One guarded text write. */
export interface ArtifactWriteResult {
  readonly version: string | null
  readonly before: string | null
}

/**
 * The work-item file port.
 *
 * `expectedVersion` is the opaque `ctx.fs` token the record held; null means
 * "no guard" (a first write or a host without a version token). Implementations
 * throw {@link ArtifactDomainError} with `file-missing`, `path-not-allowed`,
 * `version-conflict`, `file-too-large`, or `io-error`.
 */
export interface ArtifactFilePort {
  stat(path: string): Promise<ArtifactFileStat>
  readText(path: string): Promise<ArtifactTextRead>
  writeText(path: string, content: string, expectedVersion: string | null): Promise<ArtifactWriteResult>
}

/** One host `ctx.fs` target, narrowed to what this adapter reads. */
export interface HostFileTarget {
  readonly targetKey: string
  readonly displayPath: string
}

/** The mutation modes a sandboxing host filesystem can enforce. */
type HostSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** The per-call mutation policy a sandboxing host filesystem enforces. */
interface HostSandboxPolicy {
  readonly mode: HostSandboxMode
  readonly workspaceRoot: string
}

/** The host `ctx.fs` service slice the adapter uses. */
export interface HostFileSystem {
  /**
   * The backend's default mutation mode; undefined when it does not confine.
   * A sandboxing backend reads it so the adapter can pass a project-scoped
   * policy instead of inheriting the deployment-wide fallback root.
   */
  readonly sandboxMode?: HostSandboxMode
  resolve(path: string, options?: { readonly cwd?: string }): Promise<HostFileTarget>
  stat(target: HostFileTarget): Promise<
    { readonly version: unknown; readonly type: 'file' | 'directory' | 'other'; readonly size?: number } | undefined
  >
  readText(target: HostFileTarget): Promise<string>
  writeText(
    target: HostFileTarget,
    content: string,
    expected?: { readonly kind: 'replaceIfVersion'; readonly version: unknown },
    signal?: AbortSignal,
    sandboxPolicy?: HostSandboxPolicy,
  ): Promise<{ readonly version: unknown; readonly before?: string | null }>
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** SHA-256 of raw bytes; uploads must hash the bytes, never a lossy decode. */
export function sha256HexBytes(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

/** The local filesystem error code, when the error has one. */
function fsCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Map a host/local filesystem failure onto the shared artifact error type. */
export function mapFsError(error: unknown, path: string): ArtifactDomainError {
  if (error instanceof ArtifactDomainError) return error
  const code = fsCode(error)
  if (code === 'FS_STALE_VERSION') {
    return new ArtifactDomainError('artifact/version-conflict', `file changed since it was read: ${path}`, path)
  }
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'FS_NOT_FOUND') {
    return new ArtifactDomainError('artifact/file-missing', `file does not exist: ${path}`, path)
  }
  if (code === 'FS_TOO_LARGE') {
    return new ArtifactDomainError('artifact/file-too-large', `file is larger than the work-item limit: ${path}`, path)
  }
  return new ArtifactDomainError(
    'artifact/io-error',
    `filesystem operation failed for ${path}: ${error instanceof Error ? error.message : String(error)}`,
    path,
  )
}

/**
 * Prove a project-relative path resolves to a regular file inside the
 * repository. Returns the target's absolute path, or null when it is absent.
 *
 * `realpath` follows the final symlink, so a link pointing outside the
 * repository is rejected before any content is read.
 */
export async function resolveInsideRepo(repoPath: string, path: string): Promise<string | null> {
  const absolute = resolve(repoPath, path)
  const root = await realpath(repoPath)
  let real: string
  try {
    real = await realpath(absolute)
  } catch (error) {
    const code = fsCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw new ArtifactDomainError(
      'artifact/io-error',
      `cannot resolve ${path}: ${error instanceof Error ? error.message : String(error)}`,
      path,
    )
  }
  const relativePath = relative(root, real)
  if (relativePath === '' || relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
    throw new ArtifactDomainError('artifact/path-not-allowed', `path escapes the project: ${path}`, path)
  }
  // The lexical check at the wire boundary saw the registered path, not the
  // link target. A symlink such as `docs/note.md -> .git/config` stays inside
  // the repository yet resolves into a forbidden location, so the resolved
  // path must pass the same rules.
  const resolvedPath = normalizeArtifactPath(relativePath.split(sep).join('/'))
  if (!resolvedPath.ok) {
    throw new ArtifactDomainError(
      'artifact/path-not-allowed',
      `path resolves into a forbidden location: ${path} (${resolvedPath.reason})`,
      path,
    )
  }
  const info = await stat(real)
  if (!info.isFile()) {
    throw new ArtifactDomainError('artifact/path-not-allowed', `path is not a regular file: ${path}`, path)
  }
  return real
}

/**
 * Read the raw bytes of one project file after proving where it resolves.
 *
 * Binary content (a generated PNG, for instance) cannot ride `ctx.fs.readText`,
 * so the local filesystem supplies the bytes. The path is first proven inside
 * the repository by {@link resolveInsideRepo}; `stat` runs before the read so an
 * oversized file is refused without being loaded.
 *
 * @param repoPath - absolute repository root.
 * @param path - project-relative POSIX path.
 * @param maxBytes - hard byte cap; a larger file is `artifact/file-too-large`.
 * @returns the file's bytes.
 */
export async function readBytesInsideRepo(
  repoPath: string,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const real = await resolveInsideRepo(repoPath, path)
  if (real === null) {
    throw new ArtifactDomainError('artifact/file-missing', `file does not exist: ${path}`, path)
  }
  let handle: FileHandle | undefined
  try {
    // The resolved path is the real file, so O_NOFOLLOW only rejects a file
    // swapped for a symlink between the check and this open.
    handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const info = await handle.stat()
    if (info.size > maxBytes) {
      throw new ArtifactDomainError('artifact/file-too-large', `file is larger than the attachment limit: ${path}`, path)
    }
    return await handle.readFile()
  } catch (error) {
    throw mapFsError(error, path)
  } finally {
    if (handle !== undefined) await handle.close()
  }
}

/**
 * Build the production port over one host filesystem service.
 *
 * Every call first proves the real path stays inside the repository (the
 * lexical check already ran at the wire boundary), then delegates content and
 * version to the host service.
 */
export function createHostArtifactFiles(fs: HostFileSystem, repoPath: string): ArtifactFilePort {
  // The host's default policy roots workspace-write at the deployment cwd, not
  // at the project holding this work item. A user-initiated panel save must be
  // fenced by the project itself, or it is denied whenever the two differ.
  const sandboxPolicy: HostSandboxPolicy | undefined = fs.sandboxMode === undefined
    ? undefined
    : { mode: fs.sandboxMode, workspaceRoot: repoPath }
  return {
    async stat(path) {
      const real = await resolveInsideRepo(repoPath, path)
      if (real === null) return { exists: false, regular: false, size: 0, version: null }
      try {
        const target = await fs.resolve(real)
        const info = await fs.stat(target)
        if (info === undefined) return { exists: false, regular: false, size: 0, version: null }
        return {
          exists: true,
          regular: info.type === 'file',
          size: info.size ?? 0,
          version: String(info.version),
        }
      } catch (error) {
        throw mapFsError(error, path)
      }
    },
    async readText(path) {
      const real = await resolveInsideRepo(repoPath, path)
      if (real === null) {
        throw new ArtifactDomainError('artifact/file-missing', `file does not exist: ${path}`, path)
      }
      try {
        const target = await fs.resolve(real)
        const info = await fs.stat(target)
        const content = await fs.readText(target)
        return { content, size: Buffer.byteLength(content, 'utf8'), version: info === undefined ? null : String(info.version) }
      } catch (error) {
        throw mapFsError(error, path)
      }
    },
    async writeText(path, content, expectedVersion) {
      const real = await resolveInsideRepo(repoPath, path)
      if (real === null) {
        throw new ArtifactDomainError('artifact/file-missing', `file does not exist: ${path}`, path)
      }
      try {
        const target = await fs.resolve(real)
        const outcome = expectedVersion === null
          ? await fs.writeText(target, content, undefined, undefined, sandboxPolicy)
          : await fs.writeText(
            target,
            content,
            { kind: 'replaceIfVersion', version: expectedVersion },
            undefined,
            sandboxPolicy,
          )
        return { version: String(outcome.version), before: outcome.before ?? null }
      } catch (error) {
        throw mapFsError(error, path)
      }
    },
  }
}

/** One reconcile result: the updated file entry, whether it moved, and its text. */
export interface FileReconcile {
  readonly file: ArtifactFileV1
  readonly changed: boolean
  /** The text this reconcile read, when the entry is text; used for snapshots. */
  readonly text: string | null
}

/**
 * Reconcile one recorded file against the filesystem.
 *
 * A vanished file is marked `missing` and keeps its record. A changed text file
 * gets a fresh sha/size/version and a bumped revision, because comments and
 * anchors refer to the revision they were written against. A failed read is
 * reported as `missing` rather than throwing: the viewer must still open.
 */
export async function reconcileArtifactFile(
  files: ArtifactFilePort,
  file: ArtifactFileV1,
): Promise<FileReconcile> {
  let observed: ArtifactFileStat
  try {
    observed = await files.stat(file.path)
  } catch {
    return { file: file.missing ? file : { ...file, missing: true }, changed: !file.missing, text: null }
  }
  if (!observed.exists) {
    return file.missing
      ? { file, changed: false, text: null }
      : { file: { ...file, missing: true }, changed: true, text: null }
  }
  if (!isTextMediaType(file.mediaType)) {
    const versionChanged = observed.version !== null && observed.version !== file.fsVersion
    const sizeChanged = observed.size !== file.size
    if (!versionChanged && !sizeChanged && !file.missing) return { file, changed: false, text: null }
    return {
      changed: true,
      text: null,
      file: {
        ...file,
        missing: false,
        size: observed.size,
        fsVersion: observed.version ?? file.fsVersion,
        revision: versionChanged || sizeChanged ? file.revision + 1 : file.revision,
      },
    }
  }
  let read: ArtifactTextRead
  try {
    read = await files.readText(file.path)
  } catch {
    return { file: file.missing ? file : { ...file, missing: true }, changed: !file.missing, text: null }
  }
  const sha256 = sha256Hex(read.content)
  const contentChanged = sha256 !== file.sha256
  const versionChanged = read.version !== null && read.version !== file.fsVersion
  if (!contentChanged && !versionChanged && !file.missing) return { file, changed: false, text: read.content }
  return {
    changed: true,
    text: read.content,
    file: {
      ...file,
      missing: false,
      size: read.size,
      sha256,
      fsVersion: read.version ?? file.fsVersion,
      revision: contentChanged ? file.revision + 1 : file.revision,
    },
  }
}
