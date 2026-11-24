/**
 * The work-item list route: one project scan, the merged rail-status filter,
 * the server-side `q` search, and the bounded newest-first response.
 *
 * The route lives apart from `artifact-api.ts` so that module stays under the
 * 50 KiB read budget. It owns only the list projection: it imports the shared
 * contract values and the record plumbing, and never imports the route module
 * (that would be a cycle).
 */
import type { ArtifactApiPorts, ArtifactRouteKit } from './artifact-route-kit.js'
import {
  ARTIFACT_LIST_MAX_LIMIT,
  ARTIFACT_TYPE_LABELS,
  MAX_ARTIFACTS_PER_PROJECT,
  MAX_ARTIFACT_SEARCH_CHARS,
  addArtifactToCounts,
  artifactStatusMatches,
  artifactSummaryOf,
  emptyArtifactCounts,
  isArtifactStatus,
  type ArtifactCounts,
  type ArtifactListResponse,
  type ArtifactRecordV1,
  type ArtifactStatus,
} from './artifact-contract.js'
import { queryParam, requireQuery } from './artifact-records.js'

/**
 * Owner-session titles for one list response.
 *
 * One call per request builds the whole map, so the route never resolves a
 * title per record. A host without the port, or a failing listing, degrades to
 * no titles: the list and its counts still answer, the cards fall back to
 * 「未命名会话」 and the search matches title/type only. The failure is logged
 * once because it is a host capability issue, not user data.
 */
async function sessionTitlesOf(ports: ArtifactApiPorts): Promise<ReadonlyMap<string, string>> {
  if (ports.sessionTitles === undefined) {
    ports.log?.('artifact list: host exposes no session-title listing; titles omitted')
    return new Map()
  }
  try {
    return await ports.sessionTitles()
  } catch (error) {
    ports.log?.(`session titles lookup failed: ${error instanceof Error ? error.message : String(error)}`)
    return new Map()
  }
}

/**
 * Whether one work item matches the server-side search.
 *
 * The haystack is the title, the type's display label, and the owning
 * session's title; a project-relative path is never searched, so the list does
 * not leak file names through search. Matching is a case-insensitive substring
 * over the joined fields; the join separator stops a query from spanning two
 * fields.
 */
function matchesListSearch(record: ArtifactRecordV1, sessionTitle: string | null, needle: string): boolean {
  const haystack = `${record.title}\n${ARTIFACT_TYPE_LABELS[record.type]}\n${sessionTitle ?? ''}`.toLowerCase()
  return haystack.includes(needle)
}

/** The validated `status`/`q` filters of one list request. */
interface ListQueryFilters {
  readonly status: ArtifactStatus | null
  readonly search: string | null
}

/** Read and validate the list request's optional filters. */
function listQueryOf(request: Request, kit: ArtifactRouteKit): ListQueryFilters {
  const status = queryParam(request, 'status')
  if (status !== null && !isArtifactStatus(status)) {
    throw kit.fail('request/invalid-query', `unknown artifact status: ${status}`)
  }
  const search = queryParam(request, 'q')
  if (search !== null && search.length > MAX_ARTIFACT_SEARCH_CHARS) {
    throw kit.fail(
      'request/invalid-query',
      `search query is longer than ${MAX_ARTIFACT_SEARCH_CHARS} characters`,
    )
  }
  return { status, search }
}

/** The per-status counts of one project scan. */
function countProjectRecords(records: readonly ArtifactRecordV1[]): ArtifactCounts {
  let counts = emptyArtifactCounts()
  for (const record of records) counts = addArtifactToCounts(counts, record.status)
  return counts
}

/** Whether one record passes the status and search filters. */
function listRecordMatches(
  record: ArtifactRecordV1,
  filters: ListQueryFilters,
  titles: ReadonlyMap<string, string>,
  needle: string | null,
): boolean {
  if (filters.status !== null && !artifactStatusMatches(filters.status, record.status)) return false
  if (needle === null) return true
  return matchesListSearch(record, titles.get(record.ownerSessionId) ?? null, needle)
}

/** The project records that pass the list filters. */
function matchingListRecords(
  records: readonly ArtifactRecordV1[],
  filters: ListQueryFilters,
  titles: ReadonlyMap<string, string>,
): ArtifactRecordV1[] {
  const needle = filters.search?.toLowerCase() ?? null
  return records.filter((record) => listRecordMatches(record, filters, titles, needle))
}

/** The store's newest-first order with the artifact id as the tie-break. */
function newestFirst(left: ArtifactRecordV1, right: ArtifactRecordV1): number {
  const order = right.updatedAt.localeCompare(left.updatedAt)
  return order !== 0 ? order : left.artifactId.localeCompare(right.artifactId)
}

/** The bounded list rows of one response, newest first. */
function listItemsOf(records: readonly ArtifactRecordV1[], titles: ReadonlyMap<string, string>): ArtifactListResponse['items'] {
  return records
    .slice()
    .sort(newestFirst)
    .slice(0, ARTIFACT_LIST_MAX_LIMIT)
    .map((record) => ({ ...artifactSummaryOf(record), sessionTitle: titles.get(record.ownerSessionId) ?? null }))
}

/** Log the work items a scan could not parse; they stay out of the list. */
function logCorruptRecords(ports: ArtifactApiPorts, corrupt: readonly string[]): void {
  for (const artifactId of corrupt) {
    ports.log?.(`artifact list: skipping unreadable work item ${artifactId}`)
  }
}

/**
 * `GET /api/cowork.artifact.list` — the right-rail list and its counts.
 *
 * The whole project is scanned (not just the first page) so a search can reach
 * a work item past position 200; `status` and `q` then filter that scan. The
 * per-state `counts` always describe the full project, never the filtered view.
 * The newest 200 matches are returned, and `truncated` reports both a capped
 * scan and a longer match set.
 */
export async function handleList(
  request: Request,
  ports: ArtifactApiPorts,
  kit: ArtifactRouteKit,
): Promise<Response> {
  const sessionId = requireQuery(request, 'sessionId', kit, 'request/session-required')
  const filters = listQueryOf(request, kit)
  const opened = await kit.openProject(sessionId)
  const runtime = ports.runtimeFor(opened.repoPath)
  const scan = await runtime.store.listRecords(MAX_ARTIFACTS_PER_PROJECT)
  logCorruptRecords(ports, scan.corrupt)
  const projectRecords = scan.records.filter((record) => record.projectId === opened.projectId)
  const titles = await sessionTitlesOf(ports)
  const matches = matchingListRecords(projectRecords, filters, titles)
  const response: ArtifactListResponse = {
    ok: true,
    items: listItemsOf(matches, titles),
    counts: countProjectRecords(projectRecords),
    truncated: scan.total > scan.records.length || matches.length > ARTIFACT_LIST_MAX_LIMIT,
  }
  return kit.jsonResponse(200, response)
}

