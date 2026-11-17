/**
 * Static scenario registry for the versioned E2E lane.
 *
 * The manifest owns scenario metadata (mode, summary, coverage); this module
 * owns the executable module for each id. A static registry keeps every
 * scenario reachable for dead-code analysis and lets the runner fail before it
 * boots a host when the manifest and the registry disagree. The guard test
 * proves both directions of that mapping.
 */

import { liveMasterChainId, runLiveMasterChain } from './live-master-chain.mjs'
import { masterChainId, runMasterChain } from './master-chain.mjs'
import { reviewMergeId, runReviewMerge } from './review-merge.mjs'
import { reviewRevisionId, runReviewRevision } from './review-revision.mjs'
import { topicPanelId, runTopicPanel } from './topic-panel.mjs'

/** Every scenario module, keyed by the id the manifest declares. */
export const SCENARIOS = new Map([
  [liveMasterChainId, { id: liveMasterChainId, run: runLiveMasterChain }],
  [masterChainId, { id: masterChainId, run: runMasterChain }],
  [reviewMergeId, { id: reviewMergeId, run: runReviewMerge }],
  [reviewRevisionId, { id: reviewRevisionId, run: runReviewRevision }],
  [topicPanelId, { id: topicPanelId, run: runTopicPanel }],
])
