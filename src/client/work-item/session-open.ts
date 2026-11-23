/**
 * "Open in the owning session" for a cross-session work item.
 *
 * A work item opened from another session stays read-only; switching to the
 * topic that owns it is an explicit user action. The host exposes no awaitable
 * session switch (`uiWorkspace.openSession` is fire-and-forget), so the flow
 * writes the host's view preference, opens the session, then verifies through
 * the session catalog that the main area switched. A view preference written
 * before the session binds is read by the host on first paint; when the session
 * was already materialized the preference is ignored, and activating the tab in
 * the now-visible tab strip is the fallback.
 */
import {
  COWORK_VIEW_ID,
  type SessionsService,
  type UiWorkspaceService,
} from '../contracts.ts'
import { waitForMainSession, writeViewPreference, type ViewPreferenceStorage } from './session-preference.ts'
import { activateViewTab, type ViewTabOptions } from './view-tab.ts'

/** Why "open in the owning session" could not complete. */
export type OwnerSessionFailure =
  | 'no-workspace'
  | 'session-unverifiable'
  | 'session-not-switched'
  | 'tab-not-switched'

/** The outcome of one attempt; `message` is rendered verbatim next to the retry. */
export type OwnerSessionResult =
  | { readonly ok: true; readonly via: 'already' | 'tab' }
  | { readonly ok: false; readonly reason: OwnerSessionFailure; readonly message: string }

/** Dependencies of one "open in the owning session" attempt. */
export interface OpenOwnerSessionOptions {
  readonly ownerSessionId: string
  readonly uiWorkspace: UiWorkspaceService | undefined
  readonly sessions: SessionsService | undefined
  readonly storage?: ViewPreferenceStorage
  /** Overrides for the session poll and the tab click (tests pass both). */
  readonly wait?: (ms: number) => Promise<void>
  readonly tab?: ViewTabOptions
  readonly timeoutMs?: number
}

/** A short message from any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Switch to the owning session and make its Cowork view active.
 *
 * A failure is returned, never thrown: the caller keeps the read-only viewer on
 * screen and offers retry plus "stay here".
 *
 * @param options - owning session, host services, and timing overrides.
 * @returns the typed outcome of the attempt.
 */
export async function openOwnerSession(options: OpenOwnerSessionOptions): Promise<OwnerSessionResult> {
  const workspace = options.uiWorkspace
  if (workspace === undefined) {
    return {
      ok: false,
      reason: 'no-workspace',
      message: '当前宿主没有会话导航服务，无法切换到所属会话。',
    }
  }
  // Tolerate an archived owner session; the normal case needs no unarchive and
  // a refused unarchive must not block the switch attempt.
  if (typeof workspace.unarchiveSession === 'function') {
    await workspace.unarchiveSession(options.ownerSessionId).catch(() => {})
  }
  writeViewPreference(options.ownerSessionId, COWORK_VIEW_ID, options.storage)
  try {
    workspace.openSession(options.ownerSessionId)
  } catch (error) {
    return {
      ok: false,
      reason: 'session-not-switched',
      message: `切换会话失败：${messageOf(error)}`,
    }
  }
  const switched = await waitForMainSession(options.sessions?.list, options.ownerSessionId, {
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  if (!switched) {
    return {
      ok: false,
      reason: options.sessions === undefined ? 'session-unverifiable' : 'session-not-switched',
      message: options.sessions === undefined
        ? '当前宿主没有会话列表，无法确认已切换到所属会话，仍保持只读。'
        : '切换后没有进入所属会话，仍保持只读。',
    }
  }
  try {
    const activated = await activateViewTab(options.tab ?? {})
    return { ok: true, via: activated === 'already' ? 'already' : 'tab' }
  } catch (error) {
    return {
      ok: false,
      reason: 'tab-not-switched',
      message: `已切换到所属会话，但没有打开工作项标签：${messageOf(error)}`,
    }
  }
}
