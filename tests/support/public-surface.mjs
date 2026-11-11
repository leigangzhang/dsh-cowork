/**
 * The one definition of the plugin's public surface used by the suite.
 *
 * The panel routes and the business tools are pinned here, once, so adding a
 * route or a tool cannot leave one test green and another stale. The lists are
 * built from the contract constants at load time (never copied literals), and
 * the loader hook is registered first so the contracts can be imported from
 * source.
 */
import './ts-hook.mjs'

const contract = await import('../../src/api-contract.ts')
const inbox = await import('../../src/inbox-contract.ts')

/** Every panel route in registration order, with its HTTP method. */
export const PANEL_ROUTES = [
  [contract.OVERVIEW_PATH, 'GET'],
  [contract.ACTIVITY_PATH, 'GET'],
  [contract.TOPIC_PATH, 'GET'],
  [contract.RESOLVE_PATH, 'POST'],
  [contract.REOPEN_PATH, 'POST'],
  [contract.ROUTE_MOVE_PATH, 'POST'],
  [contract.AUTHORIZATION_RESOLVE_PATH, 'POST'],
  [inbox.INBOX_PATH, 'GET'],
  [inbox.INBOX_RESOLVE_PATH, 'POST'],
  [inbox.INBOX_OPEN_PATH, 'POST'],
]

/** The panel route paths, in registration order. */
export const PANEL_PATHS = PANEL_ROUTES.map(([path]) => path)

/** Every business tool in registration order (the public surface, §5.7). */
export const BUSINESS_TOOL_ORDER = [
  'cowork_project_init',
  'cowork_project_status',
  'cowork_route',
  'cowork_topic_create',
  'cowork_thread_create',
  'cowork_topic_list',
  'cowork_thread_list',
  'cowork_handoff',
  'cowork_topic_resolve',
  'cowork_topic_report',
  'cowork_decision_propose',
  'cowork_authorization_request',
  'cowork_notices',
  'cowork_user_review_request',
  'cowork_request_question',
  'cowork_request_plan',
  'cowork_work_item_create',
  'cowork_review_request',
  'cowork_review_verdict',
  'cowork_memory_write',
  'cowork_memory_search',
  'cowork_checkout_merge',
]

/** The business tools as a sorted set (order-insensitive assertions). */
export const BUSINESS_TOOLS = [...BUSINESS_TOOL_ORDER].sort()

/** Which domain module registers which tool, for the ownership tests. */
export const TOOL_DOMAINS = [
  ['src/project-tools.ts', ['cowork_project_init', 'cowork_project_status']],
  ['src/topic-tools.ts', [
    'cowork_topic_create',
    'cowork_thread_create',
    'cowork_topic_list',
    'cowork_thread_list',
    'cowork_handoff',
    'cowork_topic_resolve',
    'cowork_topic_report',
    'cowork_decision_propose',
    'cowork_authorization_request',
    'cowork_notices',
  ]],
  ['src/route-tools.ts', ['cowork_route']],
  ['src/request-tools.ts', [
    'cowork_user_review_request',
    'cowork_request_question',
    'cowork_request_plan',
  ]],
  ['src/memory-tools.ts', ['cowork_memory_write', 'cowork_memory_search']],
  ['src/checkout-tools.ts', ['cowork_work_item_create', 'cowork_checkout_merge']],
  ['src/review-tools.ts', ['cowork_review_request', 'cowork_review_verdict']],
]
