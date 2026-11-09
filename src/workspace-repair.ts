/**
 * Startup repair for a lost Cowork workspace record.
 *
 * Transitional (KI-39): the target registration path is `cowork_project_init`
 * or session creation. This startup pass only repairs records already lost; it
 * must be removed when KI-39 closes and the registration path is reliable.
 *
 * The host workspace registry rebuilds its records from session headers only
 * while its domain is uninitialized (`state.initialized === false`). Once it is
 * initialized, a workspace record that went missing is not recreated on the
 * next start, so a Cowork project whose `.dsh-cowork/index.json` and sessions
 * still exist can disappear from the sidebar. Nothing in the plugin can rebuild
 * the registry from the inside, but it can re-create just the workspace the
 * existing sessions need and re-attach those sessions.
 *
 * The repair is deliberately narrow:
 *
 * - a project root is whatever {@link WorkspaceRepairPorts.resolveProjectRoot}
 *   returns, and that lookup only matches a directory holding
 *   `.dsh-cowork/index.json`, so a non-Cowork directory never gets a workspace;
 * - a root inside the plugin's own `.dsh-cowork` store (E2E/probe fixtures) is
 *   skipped, so cleanup of test workspaces is not undone on the next start;
 * - the project files are not read or written, and no index is repaired;
 * - only sessions whose own cwd is the project root are attached, because the
 *   host validates attachment against the workspace's exact canonical path;
 * - the scan and the project count are bounded, and every session/project step
 *   is caught on its own, so one bad row cannot stop the repair.
 *
 * The function returns a result instead of throwing: startup must log a failed
 * repair, never fail to start because of it.
 */
import { resolve, sep } from 'node:path'
import { describeError } from './checkout-teardown.js'

/** Most session rows one repair may read. */
export const REPAIR_MAX_SESSIONS = 500
/** Most distinct Cowork project roots one repair may handle. */
export const REPAIR_MAX_PROJECTS = 100

/**
 * A project root inside the plugin's own `.dsh-cowork` store is test/probe
 * state, not a user project. Repair must never resurrect those workspaces after
 * the user has cleaned them up.
 */
export function isCoworkStorePath(root: string): boolean {
  const normalized = resolve(root)
  return normalized.includes(`${sep}.dsh-cowork${sep}`) || normalized.endsWith(`${sep}.dsh-cowork`)
}

/** One session row the repair needs: the id and the cwd to resolve. */
export interface RepairSessionRow {
  sessionId: string
  cwd?: string
}

/** The host services the repair reads, injected so it runs without a host. */
export interface WorkspaceRepairPorts {
  listSessions(): Promise<readonly RepairSessionRow[]>
  /** The Cowork project root at or above `cwd`; `null` for any other directory. */
  resolveProjectRoot(cwd: string): Promise<string | null>
  resolveWorkspace(path: string): Promise<{ id: string; path: string } | undefined>
  createWorkspace(path: string): Promise<{ id: string; path: string }>
  attachSession(workspaceId: string, sessionId: string): Promise<void>
}

/** Repair bounds; the defaults are the module constants. */
export interface WorkspaceRepairOptions {
  maxSessions?: number
  maxProjects?: number
}

/** What one repair pass did; every failure is reported, never thrown. */
export interface WorkspaceRepairResult {
  scannedSessions: number
  scannedProjects: number
  /** Project roots whose workspace record had to be created, in scan order. */
  createdWorkspaces: string[]
  attachedSessions: number
  skippedSessions: number
  failed: number
  errors: string[]
  /** True when a bound stopped the repair before it saw every session/project. */
  truncated: boolean
}

/**
 * Ensure a workspace exists for every Cowork project reached by the listed
 * sessions, and attach the sessions whose cwd is that project root.
 */
export async function repairCoworkWorkspaces(
  ports: WorkspaceRepairPorts,
  options: WorkspaceRepairOptions = {},
): Promise<WorkspaceRepairResult> {
  const maxSessions = Math.max(0, options.maxSessions ?? REPAIR_MAX_SESSIONS)
  const maxProjects = Math.max(0, options.maxProjects ?? REPAIR_MAX_PROJECTS)
  const result: WorkspaceRepairResult = {
    scannedSessions: 0,
    scannedProjects: 0,
    createdWorkspaces: [],
    attachedSessions: 0,
    skippedSessions: 0,
    failed: 0,
    errors: [],
    truncated: false,
  }

  let rows: readonly RepairSessionRow[]
  try {
    rows = await ports.listSessions()
  } catch (error) {
    result.failed += 1
    result.errors.push(`listing sessions failed: ${describeError(error)}`)
    return result
  }

  const bounded = rows.slice(0, maxSessions)
  result.truncated = rows.length > bounded.length

  // Group by project root before touching the registry: one workspace write per
  // project, and no registry call at all for a session that belongs to no project.
  const sessionsByRoot = new Map<string, string[]>()
  for (const row of bounded) {
    result.scannedSessions += 1
    try {
      const cwd = row.cwd
      if (typeof cwd !== 'string' || cwd.trim() === '') {
        result.skippedSessions += 1
        continue
      }
      const root = await ports.resolveProjectRoot(cwd)
      if (root === null) {
        result.skippedSessions += 1
        continue
      }
      if (isCoworkStorePath(root)) {
        result.skippedSessions += 1
        continue
      }
      // The host rejects an attachment whose cwd is not the workspace's own
      // canonical path, so a session nested below the project root is skipped
      // instead of attempting an attachment that must fail.
      if (resolve(cwd) !== resolve(root)) {
        result.skippedSessions += 1
        continue
      }
      const group = sessionsByRoot.get(root)
      if (group === undefined) {
        if (sessionsByRoot.size >= maxProjects) {
          result.truncated = true
          result.skippedSessions += 1
          continue
        }
        sessionsByRoot.set(root, [row.sessionId])
      } else if (!group.includes(row.sessionId)) {
        group.push(row.sessionId)
      }
    } catch (error) {
      result.failed += 1
      result.errors.push(`session ${row.sessionId}: ${describeError(error)}`)
    }
  }

  for (const [root, sessionIds] of sessionsByRoot) {
    result.scannedProjects += 1
    try {
      let workspace = await ports.resolveWorkspace(root)
      if (workspace === undefined) {
        workspace = await ports.createWorkspace(root)
        result.createdWorkspaces.push(root)
      }
      for (const sessionId of sessionIds) {
        try {
          await ports.attachSession(workspace.id, sessionId)
          result.attachedSessions += 1
        } catch (error) {
          result.failed += 1
          result.errors.push(`session ${sessionId} -> workspace ${root}: ${describeError(error)}`)
        }
      }
    } catch (error) {
      // A project-scoped failure (resolve/create) leaves the other projects
      // unaffected; its sessions are reported through this one error.
      result.failed += 1
      result.errors.push(`workspace ${root}: ${describeError(error)}`)
    }
  }

  return result
}
