/**
 * The owning session's view preference, and how the viewer tells whether the
 * session catalog now shows it.
 *
 * The host reads `dsh.conversation.<sessionId>.view` when it binds a session,
 * so selecting the Cowork view in another session is a preference write plus a
 * catalog-verified switch. Neither helper touches React or the DOM.
 */
import {
  COWORK_VIEW_ID,
  type SessionListSource,
  type SessionListSnapshot,
} from '../contracts.ts'

/** The host's per-session conversation store key (`dsh.conversation.<id>`). */
const VIEW_PREFERENCE_PREFIX = 'dsh.conversation.'
/** How long the session catalog may take to show the owner session as main. */
const SWITCH_TIMEOUT_MS = 1_500
/** One verification poll step. */
const POLL_MS = 100

/** A storage surface with only the two operations the preference write needs. */
export interface ViewPreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The storage key the host reads the session's view preference from. */
function viewPreferenceKey(sessionId: string): string {
  return `${VIEW_PREFERENCE_PREFIX}${sessionId}`
}

/**
 * Merge one view id into a stored conversation record.
 *
 * The record also carries the host draft and other session state; it is merged,
 * never replaced, and a malformed record is rebuilt as a bare view preference.
 *
 * @param raw - current storage value, or null.
 * @param viewId - view id to select.
 * @returns the serialized record to store.
 */
function withViewPreference(raw: string | null, viewId: string): string {
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return JSON.stringify({ ...(parsed as Record<string, unknown>), view: viewId })
      }
    } catch {
      // A broken record is replaced by the minimal preference below.
    }
  }
  return JSON.stringify({ view: viewId })
}

/**
 * Write the session's view preference for the next bind.
 *
 * @param sessionId - owning session.
 * @param viewId - view to preselect.
 * @param storage - storage override; production uses `localStorage`.
 * @returns whether the preference was stored; a refused write is not an error.
 */
export function writeViewPreference(
  sessionId: string,
  viewId: string = COWORK_VIEW_ID,
  storage: ViewPreferenceStorage | undefined = typeof window === 'undefined' ? undefined : window.localStorage,
): boolean {
  if (storage === undefined) return false
  try {
    const key = viewPreferenceKey(sessionId)
    storage.setItem(key, withViewPreference(storage.getItem(key), viewId))
    return true
  } catch {
    // Storage may be full or disabled; the DOM tab fallback still works.
    return false
  }
}

/** The session the main area is showing, according to the retention ledger. */
function mainSessionId(snapshot: SessionListSnapshot): string | null {
  for (const id of snapshot.ids) {
    if ((snapshot.byId[id]?.retainedBy?.mainView ?? 0) > 0) return id
  }
  return null
}

/**
 * Poll the session catalog until `sessionId` holds the main view.
 *
 * @param list - live session catalog, or undefined on a host without one.
 * @param sessionId - session the switch must land on.
 * @param options - wait and timeout overrides (tests use a synchronous wait).
 * @returns whether the session became the main view before the timeout.
 */
export async function waitForMainSession(
  list: SessionListSource | undefined,
  sessionId: string,
  options: { readonly wait?: (ms: number) => Promise<void>; readonly timeoutMs?: number } = {},
): Promise<boolean> {
  if (list === undefined) return false
  if (mainSessionId(list.getSnapshot()) === sessionId) return true
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const timeoutMs = options.timeoutMs ?? SWITCH_TIMEOUT_MS
  let waited = 0
  while (waited < timeoutMs) {
    await wait(POLL_MS)
    waited += POLL_MS
    if (mainSessionId(list.getSnapshot()) === sessionId) return true
  }
  return false
}
