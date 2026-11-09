# Glossary

One concept, one word. This table is normative for new prose: it says what each word means here, which spelling to use, and where the host uses a different word.

## How to use this glossary

- Read it before naming a new concept, a new check, or a new document kind.
- Link a term by its anchor instead of restating its definition.
- A term earns an entry when a second document needs the same concept, when two words compete for one meaning, or when one word carries two meanings.

## Product terms

### master

The project's main session. It routes user requirements, records decisions, decides merges, and accepts deliveries. It does not implement: its preset has no `fs`, `bash`, or search tools. Write `master`; do not write `主会话` and `master` interchangeably.

### topic

One project subject with its own DSH session, created by `cowork_route` / `cowork_topic_create` with the `cowork-topic` preset. A topic owns its work items, requests its own reviews, and reports through `cowork_handoff`. The topic id is the session id. Write `topic` (主题会话 only as the reader-facing expansion), never `thread` for the current model. Source: [TopicRecordV2](../src/store-schema.ts#L118-L140).

### thread (deprecated)

The 0.1.0 name for what 0.2.0 calls a [topic](#topic). In 0.2.0 `cowork-thread` remains only as a deprecated preset alias for sessions created before the rename; new sessions use `cowork-topic`. Do not use `thread` to describe current behaviour.

### work item

One isolated execution scope of a topic: a local clone at `<repo>/.dsh-cowork/workitems/<workItemId>` on branch `cowork/<workItemId>`. Parallel work items are merged serially by master. Write `work item` (工作项). Source: [WorkItemRecordV2](../src/store-schema.ts#L142-L153), [checkout.ts](../src/checkout.ts#L45-L58).

### review request

One request defining one review range: `purpose`, `baseCommit`, `headCommit`, `path`, `verification`, optional `workItemId`/`changedPaths`. It is stored as `reviews/<topicId>-<requestId>.json`; the request id binds the reviewer's verdict. Write `review request` (评审请求). Source: [ReviewRequestRecord](../src/review-request.ts#L121-L140).

### reviewer

An independent session created per review request with the `cowork-reviewer` preset. It reads the requested range, runs the verification itself, and records exactly one verdict; it is archived after the verdict. Its read-only property is a tool-surface constraint, not a sandbox ([KI-15](KNOWN_ISSUES.md)). Write `reviewer`.

### handoff

The structured report a topic writes when it finishes or blocks. Only `blocked` and `done` are legal in 0.2.0: `done` records the digest and delivery confirmation, `blocked` sets the flag and wakes master through the inbox. Write `handoff`; `交接单` is the plain-language form. Source: [topic-tools.ts](../src/topic-tools.ts#L477), [handoff.ts](../src/handoff.ts#L214).

### project memory

The per-project store under `<repo>/.dsh-cowork/memory/` that keeps constraints, decisions, and facts. It is a pull-based snapshot, not a conversation log. Write `project memory`.

### preset

A DSH agent preset that sets persona, tools, and rules; it does not own session topology. The four ids are `cowork-master`, `cowork-topic`, `cowork-thread` (deprecated alias), and `cowork-reviewer`. Source: [presets.ts](../src/presets.ts#L121-L199).

### inbox

The master-only decision queue at `<repo>/.dsh-cowork/inbox.json`. Only `merge-needed`, `blocked`, `review-reject`, and `cross-topic-conflict` enter it; delivery is batched and marked with `deliveredAt`. Write `inbox` (收件箱). Source: [InboxItem](../src/store-schema.ts#L193-L205), [inbox.ts](../src/inbox.ts#L17-L30).

### activity

The append-only event stream at `<repo>/.dsh-cowork/activity.jsonl`: state changes, routes, reviews, merges, and errors. It is evidence, not a state source; readers take the tail. Write `activity` (活动流). Source: [ActivityEvent](../src/store-schema.ts#L172-L185), [activity.ts](../src/activity.ts#L31).

### resolved / reopen

`resolved` is the third topic state: set manually by the user, or automatically when the topic is not awaiting review, not blocked, its latest review is not `needs_revision`, it has no active work item, it has a digest and delivery confirmation, and it has been silent past `resolveAfterMs`. There is no undo. `reopen` is the explicit user action that returns a resolved topic to `active` and clears `resolvedAt` / `resolvedBy`. Source: [topic.ts](../src/topic.ts#L61-L118), [PLAN-V0.2 §5.1](PLAN-V0.2.md#51-主题生命周期与已解决).

### route correction

The panel action that re-targets an intent: append the intent's tokens to the target topic's `aliases` and record `route-corrected`. It changes future routing only; it does not rewrite history. Write `route correction` (改投). Source: [routing.ts](../src/routing.ts#L382).

### work item checkout

An isolated local clone at `<repo>/.dsh-cowork/workitems/<workItemId>` with branch `cowork/<workItemId>`, owned by one topic and merged by master. Write `work item checkout` (or `checkout` when the work item is clear); the implementation is a `git clone --local`, not a `git worktree`.

## Engineering terms

### surface

One entry in `tools/workflow.json`: a named group of paths plus the evidence commands that group requires.

### evidence

Two senses: the **evidence commands** declared on a surface, and the **evidence record** a delivery leaves behind. Write the qualified form whenever a sentence could mean either.

### check

One declared executable convention run by `tools/check-invariants.mjs`. Name a check by its rule; do not call it "the gate".

### empty corpus

The state of a check whose patterns match no file. It is a violation, never a pass.

### self-test

`npm run check:self-test`: the run that proves guards reject invalid fixtures.

### seam

A swappable capability with three roles: a service definition, one or more providers, and one or more consumers. dsh-cowork's `memory` adapter is an intended seam; do not call it a seam until all three roles exist.

### provider

The implementation of a seam, e.g. the default file memory provider.

### consumer

The code that uses a seam through its definition, never through a provider's private type.

### sidecar

A small state file beside the main artifact, e.g. `index.json` beside the repository. Write `sidecar`; do not use it for generated session logs.

### record

A decision record under `.agents/notes/`; its lifecycle is `proposed` or `implemented`.
