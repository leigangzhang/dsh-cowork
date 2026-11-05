# Glossary

One concept, one word. This table is normative for new prose: it says what each word means here, which spelling to use, and where the host uses a different word.

## How to use this glossary

- Read it before naming a new concept, a new check, or a new document kind.
- Link a term by its anchor instead of restating its definition.
- A term earns an entry when a second document needs the same concept, when two words compete for one meaning, or when one word carries two meanings.

## Product terms

### master

The project's main session. It routes user requirements, records decisions, and accepts or rejects thread deliveries. Write `master`; do not write `主会话` and `master` interchangeably.

### thread

One persistent feature conversation, implemented as an ordinary DSH session created by `sessionController.create`. Write `thread`; `讨论串` is only for reader-facing explanation, not for architecture prose.

### handoff

The structured record a thread writes when it finishes, blocks, or needs a decision from master. Write `handoff`; `交接单` is the plain-language form.

### project memory

The per-project store under `<repo>/.dsh-cowork/` that keeps constraints, decisions, and facts. Write `project memory`; it is not a conversation log.

### preset

A DSH agent preset: `cowork-master` or `cowork-thread`. A preset sets persona, tools, and rules; it does not own session topology.

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

### thread checkout

An isolated local clone at `<repo>/.dsh-cowork/threads/<threadId>` with branch `cowork/<threadId>`, owned by one thread and merged by master. Write `thread checkout` (or `checkout` when the thread is clear); the implementation is a `git clone --local`, not a `git worktree`.

### record

A decision record under `.agents/notes/`; its lifecycle is `proposed` or `implemented`.
