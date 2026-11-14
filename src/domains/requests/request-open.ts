/**
 * File opening of the request inbox: resolve a stored plan/proposal to one real
 * file inside the repository and hand it to the host's file browser.
 *
 * The browser sends an id, never a path: the caller passes the repo-relative
 * value an already-validated record or activity carries, and this module
 * refuses absolute paths, `..` segments, Windows separators, a symlink that
 * leaves the repository, a non-regular file and a file over the open cap.
 */
import { realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { OPEN_FILE_MAX_BYTES } from '../../panel/inbox-contract.js'
import { noticeIdOf } from '../notices/notices.js'
import { isRepoRelativePosixPath } from './request-schema.js'
import { RequestStore } from '../../store/request-store.js'
import { ACTIVITY_MAX_EVENTS } from '../../store/schema.js'
import type { ProjectIndexV2 } from '../../store/schema.js'
import { PanelServiceError, assertMember, messageOf } from './request-support.js'
import type { RequestServiceStorePort } from './request-support.js'

/** What one open call needs. */
export interface OpenRequestTargetInput {
  readonly store: Pick<RequestServiceStorePort, 'readActivity'>
  readonly repoPath: string
  /**
   * The index the member check reads. The caller is the session that opened the
   * project, so the same "master or the owning topic" rule as resolve applies:
   * a repository session may not reveal another topic's file by guessing an id.
   */
  readonly document: ProjectIndexV2
  readonly sessionId: string
  readonly requestId?: string
  readonly noticeId?: string
  /** Host file-browser port; absent means the host cannot open files. */
  readonly openWorkspacePath?: (path: string) => Promise<void>
}

/** The file one open call targets, plus the topic that owns it. */
interface OpenTarget {
  readonly topicId: string | null
  readonly relativePath: string
}

/** Resolve one request id to its stored plan file and owning topic. */
async function planTargetOfRequest(repoPath: string, requestId: string): Promise<OpenTarget> {
  const store = new RequestStore({ repoPath })
  const record = await store.read(requestId)
  if (record === null) {
    throw new PanelServiceError('inbox/request-not-found', `no request ${requestId}`)
  }
  if (record.kind !== 'plan') {
    throw new PanelServiceError('inbox/path-missing', `request ${requestId} carries no openable file`)
  }
  const payload = record.payload as { planPath?: unknown }
  if (typeof payload.planPath !== 'string') {
    throw new PanelServiceError('inbox/path-missing', `request ${requestId} carries no planPath`)
  }
  return { topicId: record.topicId, relativePath: payload.planPath }
}

/** Resolve one notice id to the proposal file its event carries, plus its topic. */
async function proposalTargetOfNotice(
  store: Pick<RequestServiceStorePort, 'readActivity'>,
  noticeId: string,
): Promise<OpenTarget> {
  const { events } = await store.readActivity(ACTIVITY_MAX_EVENTS)
  for (const event of events) {
    if (noticeIdOf(event) !== noticeId) continue
    const details = event.details as Record<string, unknown>
    if (typeof details.proposalPath === 'string' && details.proposalPath.trim() !== '') {
      return { topicId: event.topicId, relativePath: details.proposalPath }
    }
  }
  throw new PanelServiceError('inbox/path-missing', `notice ${noticeId} carries no openable file`)
}

/**
 * Resolve a repository path to a real file inside the repository.
 *
 * The browser never names a path: the caller passes the repo-relative value an
 * already-validated record or activity carries. Absolute paths, `..`
 * segments, Windows separators, a symlink that leaves the repository, a
 * non-regular file and a file over {@link OPEN_FILE_MAX_BYTES} are all
 * `inbox/path-missing`.
 */
async function resolveOpenableFile(repoPath: string, relative: unknown): Promise<string> {
  if (!isRepoRelativePosixPath(relative, 500)) {
    throw new PanelServiceError('inbox/path-missing', 'the stored path is not a repo-relative POSIX path')
  }
  let root: string
  try {
    root = await realpath(repoPath)
  } catch (error) {
    throw new PanelServiceError('inbox/path-missing', `the repository root is unreachable: ${messageOf(error)}`)
  }
  const candidate = resolve(root, relative)
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new PanelServiceError('inbox/path-missing', `the stored path leaves the repository: ${relative}`)
  }
  let real: string
  let info: Awaited<ReturnType<typeof stat>>
  try {
    real = await realpath(candidate)
    info = await stat(real)
  } catch {
    throw new PanelServiceError('inbox/path-missing', `the stored file does not exist: ${relative}`)
  }
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new PanelServiceError('inbox/path-missing', `the stored path escapes the repository: ${relative}`)
  }
  if (!info.isFile()) {
    throw new PanelServiceError('inbox/path-missing', `the stored path is not a regular file: ${relative}`)
  }
  if (info.size > OPEN_FILE_MAX_BYTES) {
    throw new PanelServiceError(
      'inbox/path-missing',
      `the stored file is ${info.size} bytes; the limit is ${OPEN_FILE_MAX_BYTES}`,
    )
  }
  return real
}

/**
 * `POST /api/cowork.inbox.open`: reveal the plan or proposal file of one
 * request or notice through the host's file browser. The browser sends an id,
 * never a path; a host without the desktop capability is
 * `inbox/open-unsupported`, never a faked success.
 */
export async function openRequestTarget(input: OpenRequestTargetInput): Promise<string> {
  if ((input.requestId === undefined) === (input.noticeId === undefined)) {
    throw new PanelServiceError('inbox/path-missing', 'exactly one of requestId and noticeId is required')
  }
  const target = input.requestId !== undefined
    ? await planTargetOfRequest(input.repoPath, input.requestId)
    : await proposalTargetOfNotice(input.store, input.noticeId as string)
  // Membership first: a stranger must not learn whether the file exists, and
  // the host opener is never called for a row the caller does not own.
  assertMember(input.document, input.sessionId, target.topicId)
  const absolute = await resolveOpenableFile(input.repoPath, target.relativePath)
  if (input.openWorkspacePath === undefined) {
    throw new PanelServiceError(
      'inbox/open-unsupported',
      'this host exposes no desktop file browser, so the file cannot be revealed',
    )
  }
  try {
    await input.openWorkspacePath(absolute)
  } catch (error) {
    throw new PanelServiceError(
      'inbox/open-unsupported',
      `the host refused to open ${target.relativePath}: ${messageOf(error)}`,
    )
  }
  return absolute
}
