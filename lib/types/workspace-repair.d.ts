/** Most session rows one repair may read. */
export declare const REPAIR_MAX_SESSIONS = 500;
/** Most distinct Cowork project roots one repair may handle. */
export declare const REPAIR_MAX_PROJECTS = 100;
/**
 * A project root inside the plugin's own `.dsh-cowork` store is test/probe
 * state, not a user project. Repair must never resurrect those workspaces after
 * the user has cleaned them up.
 */
export declare function isCoworkStorePath(root: string): boolean;
/** One session row the repair needs: the id and the cwd to resolve. */
export interface RepairSessionRow {
    sessionId: string;
    cwd?: string;
}
/** The host services the repair reads, injected so it runs without a host. */
export interface WorkspaceRepairPorts {
    listSessions(): Promise<readonly RepairSessionRow[]>;
    /** The Cowork project root at or above `cwd`; `null` for any other directory. */
    resolveProjectRoot(cwd: string): Promise<string | null>;
    resolveWorkspace(path: string): Promise<{
        id: string;
        path: string;
    } | undefined>;
    createWorkspace(path: string): Promise<{
        id: string;
        path: string;
    }>;
    attachSession(workspaceId: string, sessionId: string): Promise<void>;
}
/** Repair bounds; the defaults are the module constants. */
export interface WorkspaceRepairOptions {
    maxSessions?: number;
    maxProjects?: number;
}
/** What one repair pass did; every failure is reported, never thrown. */
export interface WorkspaceRepairResult {
    scannedSessions: number;
    scannedProjects: number;
    /** Project roots whose workspace record had to be created, in scan order. */
    createdWorkspaces: string[];
    attachedSessions: number;
    skippedSessions: number;
    failed: number;
    errors: string[];
    /** True when a bound stopped the repair before it saw every session/project. */
    truncated: boolean;
}
/**
 * Ensure a workspace exists for every Cowork project reached by the listed
 * sessions, and attach the sessions whose cwd is that project root.
 */
export declare function repairCoworkWorkspaces(ports: WorkspaceRepairPorts, options?: WorkspaceRepairOptions): Promise<WorkspaceRepairResult>;
