/**
 * Stable entry point of the request-inbox service.
 *
 * The implementation is split by responsibility so no module carries the whole
 * feature:
 *  - `src/domains/requests/request-lifecycle.ts` — creation, resolution, wake-up prompt and the
 *    authorization bridge;
 *  - `src/domains/requests/authorization-decision.ts` — the one authorization decision core and
 *    the legacy route's card settlement;
 *  - `src/domains/requests/request-open.ts` — file opening and path guards;
 *  - `src/domains/requests/request-support.ts` — the shared error, store port and member guard.
 *
 * Callers keep importing from here, so the split did not move the public names.
 */
export { PanelServiceError } from './request-support.js'
export type { RequestServiceStorePort } from './request-support.js'

export { createRequest, promptRequestTopic, resolveRequest } from './request-lifecycle.js'
export type {
  CreateRequestInput,
  PromptRequestTopicInput,
  PromptRequestTopicOutcome,
  ResolveRequestInput,
  ResolveRequestOutcome,
} from './request-lifecycle.js'

export {
  resolveAuthorizationDecision,
  settleAuthorizationRequestRecord,
} from './authorization-decision.js'
export type {
  AuthorizationDecisionInput,
  AuthorizationDecisionOutcome,
  SettleAuthorizationOutcome,
  SettleAuthorizationRecordInput,
} from './authorization-decision.js'

export { openRequestTarget } from './request-open.js'
export type { OpenRequestTargetInput } from './request-open.js'
