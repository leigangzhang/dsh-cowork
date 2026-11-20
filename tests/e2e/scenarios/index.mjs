/**
 * Static scenario registry for the versioned E2E lane.
 *
 * The manifest owns scenario metadata (mode, summary, coverage); this module
 * owns the executable module for each id. A static registry keeps every
 * scenario reachable for dead-code analysis and lets the runner fail before it
 * boots a host when the manifest and the registry disagree. The guard test
 * proves both directions of that mapping.
 */

import { artifactChainId, runArtifactChain } from './artifact-chain.mjs'
import { artifactRecoveryId, runArtifactRecovery } from './artifact-recovery.mjs'
import { liveArtifactChainId, runLiveArtifactChain } from './live-artifact-chain.mjs'
import { liveMasterChainId, runLiveMasterChain } from './live-master-chain.mjs'
import { masterChainId, runMasterChain } from './master-chain.mjs'
import { reviewMergeId, runReviewMerge } from './review-merge.mjs'
import { reviewRevisionId, runReviewRevision } from './review-revision.mjs'
import { topicBashId, runTopicBash } from './topic-bash.mjs'
import { topicPanelId, runTopicPanel } from './topic-panel.mjs'

/** Every scenario module, keyed by the id the manifest declares. */
export const SCENARIOS = new Map([
  [artifactChainId, { id: artifactChainId, run: runArtifactChain }],
  [artifactRecoveryId, { id: artifactRecoveryId, run: runArtifactRecovery }],
  [liveArtifactChainId, { id: liveArtifactChainId, run: runLiveArtifactChain }],
  [liveMasterChainId, { id: liveMasterChainId, run: runLiveMasterChain }],
  [masterChainId, { id: masterChainId, run: runMasterChain }],
  [reviewMergeId, { id: reviewMergeId, run: runReviewMerge }],
  [reviewRevisionId, { id: reviewRevisionId, run: runReviewRevision }],
  [topicBashId, { id: topicBashId, run: runTopicBash }],
  [topicPanelId, { id: topicPanelId, run: runTopicPanel }],
])
