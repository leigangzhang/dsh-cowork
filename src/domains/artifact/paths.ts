/**
 * Pure path and type rules for work-item files.
 *
 * A work item registers files inside the project only: the record stores a
 * project-relative POSIX path, never an absolute one, and every route/tool
 * resolves it against the session's repository. These functions decide the
 * lexical rules without touching a filesystem; the platform layer adds the
 * realpath/regular-file check that only a live filesystem can answer.
 */
import {
  MAX_ARTIFACT_PATH_CHARS,
  type ArtifactType,
} from '../../panel/artifact-contract.js'

/** Outcome of a lexical path check. */
export type ArtifactPathCheck =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string }

/** Segments that are never a registered work-item file. */
const FORBIDDEN_SEGMENTS = new Set(['.git', '.dsh-cowork'])

/**
 * Credential-carrying basenames and prefixes a work item must not expose.
 * Matching is case-insensitive and deliberately small: it blocks the common
 * secrets a repository holds, not every file whose name contains "key".
 */
const FORBIDDEN_BASENAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.git-credentials',
  'credentials',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
])

/** Extension to artifact type; unknown extensions are `other`. */
const TYPE_BY_EXTENSION: Readonly<Record<string, ArtifactType>> = {
  '.md': 'text',
  '.markdown': 'text',
  '.mdx': 'text',
  '.txt': 'text',
  '.rst': 'text',
  '.html': 'html',
  '.htm': 'html',
  '.csv': 'table',
  '.tsv': 'table',
  '.xlsx': 'table',
  '.xls': 'table',
  '.mmd': 'diagram',
  '.mermaid': 'diagram',
  '.puml': 'diagram',
  '.plantuml': 'diagram',
  '.dot': 'diagram',
  '.excalidraw': 'canvas',
  '.pdf': 'pdf',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.doc': 'doc',
  '.docx': 'doc',
}

/** Extension to media type; unknown extensions are `application/octet-stream`. */
const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.txt': 'text/plain',
  '.rst': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.mmd': 'text/plain',
  '.mermaid': 'text/plain',
  '.puml': 'text/plain',
  '.plantuml': 'text/plain',
  '.dot': 'text/vnd.graphviz',
  '.excalidraw': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

/** Types whose file is text the viewer may edit and save. */
const EDITABLE_TYPES: ReadonlySet<ArtifactType> = new Set([
  'text',
  'doc',
  'table',
  'diagram',
  'canvas',
  'html',
])

/** The lower-cased final extension of a path, including the dot; '' when none. */
export function artifactExtension(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/**
 * Check one project-relative path lexically.
 *
 * Rejects absolute paths, Windows separators and drive letters, `.`/`..`
 * segments, empty or trailing segments, control characters, the two internal
 * directories, and the small credential-file set. It does not prove the file
 * exists or stays inside the repository after symlink resolution; that is the
 * platform layer's job.
 */
export function normalizeArtifactPath(raw: unknown): ArtifactPathCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'path must be a string' }
  const path = raw.trim()
  if (path === '') return { ok: false, reason: 'path must not be empty' }
  if (path.length > MAX_ARTIFACT_PATH_CHARS) {
    return { ok: false, reason: `path must be at most ${MAX_ARTIFACT_PATH_CHARS} characters` }
  }
  if (path.startsWith('/') || path.startsWith('\\')) return { ok: false, reason: 'path must be project-relative' }
  if (path.includes('\\')) return { ok: false, reason: 'path must use POSIX separators' }
  if (/^[A-Za-z]:/.test(path)) return { ok: false, reason: 'path must be project-relative' }
  // Control characters (including NUL and newlines) cannot appear in a filename.
  if (/[\u0000-\u001f\u007f]/.test(path)) return { ok: false, reason: 'path must not contain control characters' }
  const segments = path.split('/')
  if (segments[segments.length - 1] === '') return { ok: false, reason: 'path must not end with a separator' }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false, reason: 'path must not contain empty, "." or ".." segments' }
    }
    if (FORBIDDEN_SEGMENTS.has(segment.toLowerCase())) {
      return { ok: false, reason: `path must not enter ${segment}` }
    }
  }
  const base = segments[segments.length - 1].toLowerCase()
  if (FORBIDDEN_BASENAMES.has(base) || base.startsWith('.env.')) {
    return { ok: false, reason: 'path must not expose a credential file' }
  }
  return { ok: true, path }
}

/** Infer the artifact type from the path's extension. */
export function inferArtifactType(path: string): ArtifactType {
  return TYPE_BY_EXTENSION[artifactExtension(path)] ?? 'other'
}

/** Infer the media type from the path's extension. */
export function inferMediaType(path: string): string {
  return MEDIA_TYPE_BY_EXTENSION[artifactExtension(path)] ?? 'application/octet-stream'
}

/** Whether a type is text the viewer may edit and save. */
export function isEditableArtifactType(type: ArtifactType): boolean {
  return EDITABLE_TYPES.has(type)
}

/**
 * Whether a media type is UTF-8 text this surface can read and save. The
 * viewer only offers editing for text media; binary files stay read-only.
 */
export function isTextMediaType(mediaType: string): boolean {
  if (mediaType.startsWith('text/')) return true
  return mediaType === 'application/json' || mediaType === 'text/vnd.graphviz'
}
