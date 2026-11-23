/**
 * Conversation tab activation for the right-rail work-item list.
 *
 * The host selects a conversation view only through its own tab strip: there is
 * no `selectView` service on the client context, and `openView` is injected
 * into the view itself, not into a right-rail consumer. So opening the work
 * item from the list registers the view and then clicks the `Cowork` tab.
 *
 * The click is bounded and observable: only tabs inside `[data-conversation-tabs]`
 * are considered (the host renders other `role="tab"` buttons elsewhere), the
 * result is verified through `aria-selected`, and a failure is a typed error the
 * list shows instead of leaving the user on Chat with no explanation.
 */
import { COWORK_VIEW_LABEL } from '../contracts.ts'

/** The host tab strip, narrowed so a tab elsewhere in the app is never clicked. */
const TAB_SELECTOR = '[data-conversation-tabs] button[role="tab"]'
/** One activation poll step; ten steps per click are about one second. */
const POLL_MS = 100
/** Polls per click before the activation re-clicks. */
const POLLS_PER_CLICK = 10
/** Clicks before the activation is declared failed (first click + 2 retries). */
const MAX_CLICKS = 3
/** Budget for the registration to paint the tab, in milliseconds. */
const TAB_RENDER_BUDGET_MS = 2_500

/** Why the tab strip could not be switched. */
type ViewTabFailure = 'tab-missing' | 'tab-not-selected'

/** A bounded, user-presentable tab activation failure. */
class ViewTabError extends Error {
  readonly code: ViewTabFailure

  /**
   * @param code - stable failure identity the list branches on.
   * @param message - Chinese explanation rendered next to the retry action.
   */
  constructor(code: ViewTabFailure, message: string) {
    super(message)
    this.name = 'ViewTabError'
    this.code = code
  }
}

/** Injected timing surface; production omits it and tests pass a synchronous wait. */
export interface ViewTabOptions {
  /** Document to search; defaults to the global document. */
  readonly document?: Document
  /** Exact tab text; defaults to the registered Cowork label. */
  readonly label?: string
  /** Wait for one poll step; defaults to a `setTimeout` promise. */
  readonly wait?: (ms: number) => Promise<void>
  /** Maximum clicks before failing; exposed for tests of the retry bound. */
  readonly maxClicks?: number
}

/** One tab button's text, with the host's rendered whitespace collapsed. */
function tabText(element: Element): string {
  return (element.textContent ?? '').trim()
}

/** The matching tab in the host tab strip, or null while it is not rendered. */
function findTab(doc: Document, label: string): HTMLElement | null {
  for (const element of doc.querySelectorAll(TAB_SELECTOR)) {
    if (tabText(element) !== label) continue
    const tab = element as HTMLElement
    if (typeof tab.click === 'function') return tab
  }
  return null
}

/** Whether the host marks one tab as the active view. */
function isSelected(tab: HTMLElement): boolean {
  return tab.getAttribute('aria-selected') === 'true'
}

/** Default poll wait; a host without a timer fails the activation instead of hanging. */
function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Click the registered conversation view tab and verify it became active.
 *
 * @param options - document, label, wait, and click budget overrides.
 * @returns `already` when the tab was active, `activated` after a successful click.
 * @throws {ViewTabError} `tab-missing` when the tab never renders, and
 *   `tab-not-selected` when clicks exhausted the budget without `aria-selected`.
 */
export async function activateViewTab(options: ViewTabOptions = {}): Promise<'already' | 'activated'> {
  const doc = options.document ?? (typeof document === 'undefined' ? undefined : document)
  if (doc === undefined) {
    throw new ViewTabError('tab-missing', '当前环境没有浏览器文档，无法切换会话标签。')
  }
  const label = options.label ?? COWORK_VIEW_LABEL
  const wait = options.wait ?? defaultWait
  const maxClicks = options.maxClicks ?? MAX_CLICKS

  // Registration is synchronous, but the host paints the tab on the next
  // render; wait for it before deciding it does not exist.
  let waited = 0
  let tab = findTab(doc, label)
  while (tab === null && waited < TAB_RENDER_BUDGET_MS) {
    await wait(POLL_MS)
    waited += POLL_MS
    tab = findTab(doc, label)
  }
  if (tab === null) {
    throw new ViewTabError('tab-missing', `没有找到「${label}」会话标签：当前宿主可能不支持工作项标签。`)
  }
  if (isSelected(tab)) return 'already'

  for (let click = 0; click < maxClicks; click += 1) {
    tab.click()
    for (let poll = 0; poll < POLLS_PER_CLICK; poll += 1) {
      await wait(POLL_MS)
      const current = findTab(doc, label)
      if (current !== null && isSelected(current)) return 'activated'
    }
    tab = findTab(doc, label) ?? tab
  }
  throw new ViewTabError('tab-not-selected', `点击「${label}」标签后没有切换到工作项视图。`)
}
