# Documentation standard

The documentation rules for this repository, adapted from the agent-workflow-kit harness to this repository's one-tier shape. Every command named here runs.

A **skill** is the one kind whose reader is a model: its `description` is a load condition (`Use when …`), not a summary; its body carries the decision logic; and its `## Verification` section names the gate to run. No validation logic lives in a skill. The host owns the loader, and the skill guard in `npm run check` proves only that the description still reads as a trigger, never that the skill was loaded. The writing procedures live in [write-docs](../.agents/skills/write-docs/SKILL.md), [prose-standard](../.agents/skills/prose-standard/SKILL.md), and [trim-cot-leakage](../.agents/skills/trim-cot-leakage/SKILL.md).

## Document kinds

Every document gets one kind first, and the kind fixes its skeleton, its budget, and its reader. The kind follows from **mechanical facts** — which question it answers, and who reads it — never from the directory name.

| kind | It answers | Not its job |
|---|---|---|
| guide ([README.md](../README.md), this file, [testing.md](testing.md), [routing.md](routing.md), [context.md](context.md), [decision-and-handoff.md](decision-and-handoff.md), [AGENTTEAM.md](AGENTTEAM.md)) | One learning path, or one current rule | Restating what the homes it links to already say |
| standing-rules ([AGENTS.md](../AGENTS.md)) | The rules an agent must obey in every task | Explanations and examples |
| index ([docs/README.md](README.md), [docs/archived/README.md](archived/README.md), [docs/handoffs/README.md](handoffs/README.md), [design index](design/cowork-sidebar/README.md), [skills README](../.agents/skills/README.md)) | Where to find what | Any rule or fact of its own |
| plan ([PLAN.md](PLAN.md), [PLAN-V0.2.md](PLAN-V0.2.md)) | Product scope, architecture, milestones, acceptance | Implementation steps as prose |
| reference ([glossary.md](glossary.md), [plain-language.md](plain-language.md), [KNOWN_ISSUES.md](KNOWN_ISSUES.md)) | A current fact looked up by name or term | Teaching paths, rationale |
| record ([.agents/notes/](../.agents/notes/README.md), [docs/archived/](archived/README.md), [docs/handoffs/](handoffs/README.md), [design records](design/cowork-sidebar/README.md)) | One decision, design, review, delivery, or handoff | Current-state rules |
| skill ([.agents/skills/](../.agents/skills/README.md)) | When to do what | Validation logic and contracts |
| template (`*/TEMPLATE.md`) | What a record should look like | Real content |
| switch ([docs/publish.json](publish.json)) | Which files may ship | A second allow-list elsewhere |

To add a kind, supply its skeleton, home, and a check that maps documents to it, then declare it in [docs/kinds.json](kinds.json). With one missing, no reader can say whether that kind is acceptable. `contract` and `generated` are not kinds here: interfaces live in source, and no page is generated. Introducing either requires its skeleton, home, and check in the same change.

**Names.** For new files, uppercase is reserved for names a tool or reader looks up by name: `README.md`, `AGENTS.md`, `SKILL.md`, `TEMPLATE.md`, `PLAN.md`, `PLAN-V0.2.md`, `KNOWN_ISSUES.md`. Every other new file is lowercase kebab-case. Existing uppercase names remain for link stability and are not a precedent. A name is a label, never a kind signal: the kind follows from the mechanical facts, so a change of kind renames the file.

## Directory layout

`docs/` root holds the index, general rules, project-wide plans, guides, references, and standalone documents outside a semantic family. A file moves into a subdirectory when it joins an existing family; directories group record families, not document kinds.

| Path | Holds | Does not hold |
|---|---|---|
| `docs/` | index, general rules, project plans/guides/references, standalone pages | a second file in an existing record family |
| `docs/design/<feature>/` | design proposals, decisions, research, verification, and the demo index for one feature | current product rules |
| `docs/handoffs/` | current implementation handoffs and their index | historical phase handoffs |
| `docs/archived/handoffs/` | historical implementation handoffs | current handoffs |
| `docs/archived/results/` | historical delivery and probe results | handoffs or current rules |
| `docs/archived/recon/` | historical reconnaissance records | results or handoffs |
| `docs/discussion/` | demo assets and raw discussion data | durable rules or facts |

Do not create `guides/`, `references/`, or `plans/` directories: those are document kinds, not semantic families. When a standalone file gains a second document of the same family, move both into the family directory and update links and `docs/publish.json` in the same change. The `docs-layout` guard rejects a handoff, result, or reconnaissance file outside its family directory; semantic fit remains a review call.

## One home per fact

A fact lives in one home; everywhere else links there.

| One fact | Its home | Not its home |
|---|---|---|
| Standing rules | [AGENTS.md](../AGENTS.md) | Stories, examples, situational flows |
| Product scope, architecture, and milestones | [PLAN.md](PLAN.md) and [PLAN-V0.2.md](PLAN-V0.2.md) | Implementation code |
| Test strategy | [testing.md](testing.md) | Concrete commands (→ the changed surface's evidence) |
| Documentation rules | this file | Product contracts |
| Why a choice was made, and what it gave up | [.agents/notes/](../.agents/notes/README.md) | Current-state rules |
| What a word means | [glossary.md](glossary.md) | Reader-facing wording (→ [plain-language.md](plain-language.md)) |
| How to say a term to someone who has not read the glossary | [plain-language.md](plain-language.md) | Term definitions (→ [glossary.md](glossary.md)) |
| Interfaces, types, config keys | The declaration in source | A copy in a document, unless it is registered as a mirror |
| When to use a writing procedure | [.agents/skills/](../.agents/skills/README.md) | The rules the procedure applies |
| What a check runs | [tools/workflow.json](../tools/workflow.json) | A hand-copied checklist |
| What may be published | [publish.json](publish.json) | Any second allow-list |
| Deferred issues and re-evaluation triggers | [KNOWN_ISSUES.md](KNOWN_ISSUES.md) | A second issue list |

**Restatement is drift**: when a sentence appears twice, delete one copy and link the other. A restatement a machine can catch is pinned as a check in [tools/check-invariants.mjs](../tools/check-invariants.mjs).

## Tutorial or reference

Every document is one or the other, decided by **purpose**, not by path:

- **tutorial**: an ordered path to a result, introducing only the concepts each step needs right then;
- **reference**: a lookup scope describing current behaviour, with no teaching order.

Substantial in both → split it into two documents. Only a small part is the other form → label that section in place. Write the reader's starting point, the observable result, and the most likely failure and recovery path before the details. Order a tutorial by prerequisite, not by implementation order.

## Generated, mirrored, or linked

A fact enters documentation in exactly three ways, and the default is the first:

1. **link**: the fact lives in source, configuration, or a generator, and the document says what it is and where to look.
2. **mirror**: when it must be shown verbatim, a fenced block in the document plus a registry entry, compared byte for byte against the source region marked `begin`/`end`. Registration and paste update in the same change. This repository has no mirror registry today; a mirror cannot be added without its registry and its check in the same change.
3. **generate**: a whole page exported by a generator from one source. A generated page is read-only: change the generator, re-run the generation command, and never patch the page. Ask "is a link or a mirror enough?" before reaching for this one.

A generated page's authority comes from **the generator plus a freshness gate**, never from the text itself. Every generated page declares a `--check` command on its surface in `tools/workflow.json`. This repository has no generated page today; introducing one requires the generator and its `--check` command before the page lands. Do not paste an interface into prose; link the source declaration.

## Budgets

A standing document is a budget, not a warehouse. Over budget, in this order:

1. **relocate**: the content belongs in another home → move it there and leave a one-line link;
2. **condense**: it does belong here, but it can be shorter;
3. **raise the number**: only when the words genuinely need the space, and say why in the commit.

The checks count lines (`maxLines`), whitespace-separated words (`maxWords`), or bytes (`maxBytes`). Chinese pages use line ceilings because word counts undercount them; English pages use word ceilings. `AGENTS.md` is capped at 120 lines; this file at 1850 words, [testing.md](testing.md) at 1900, and [glossary.md](glossary.md) and [plain-language.md](plain-language.md) at 1500 each. Other standing docs stay short by review; a new hard budget needs a check. Within 5%, relocate or condense rather than adding words.

## Publication

**A file existing is not a file shipping.** [docs/publish.json](publish.json) is the only publication switch, and it classifies every Markdown file in the corpus as `public` or `internal`:

- `public` **names files one by one** and accepts no glob: publication is a promise about a file, not about a directory, and a new page must be added explicitly;
- `internal` may be declared by home and must state why the file stays in the repository; being empty for now is fine, because it is not a promise;
- every file must hit **exactly** one declaration: a file nobody matches is a **silent omission** and a file matching two is ambiguous — both are red;
- a `public` entry with no real file behind it is a broken link, and red.

The manifest is the switch of the projection, not the projection itself: consumers build from these `public` files, and the repository Markdown stays the only editable source.

## The slop checklist

What a machine can decide is pinned as a check; what it cannot is left to review. Search for each of these:

- **duplicated rules**: search the whole text for one distinctive phrase, keep one home, and turn the rest into links; what can be pinned as a check, pin.
- **history out of bounds**: "it used to be" or "this version changed it" inside a current-state document → move it into a decision record.
- **implementation-status annotations**: "implemented", "will later…". Status rots; the repository layout and the manifests are the status.
- **hand-copied catalogs**: when source or a generator is authoritative, do not copy a list of tools, events, packages, or checks into a document.
- **reasoning-trace leakage**: step-by-step implementation narration, proof of an obvious branch, test walk-throughs, rejected local alternatives. Keep the conclusion, delete the path.
- **paragraph walls**: one paragraph carrying several rules and parenthetical asides. Split it, or demote the detail to its home.
- **emphasis inflation**: bold and "critically" everywhere means nothing stands out.
- **prose restating code**: comments and documents restating control flow instead of writing down the contract, the failure modes, the timing, and the ownership.

## Known limits

- `publish-manifest` guarantees only that every file is classified once, that `public` names real files one by one, and that `internal` states a reason. Whether a site build really picks those files up is the build command on the `docs` surface, not this gate.
- The budget measures length, not density: a short file can still carry two rules or a restatement of another home.
- Checks are declared in [tools/workflow.json](../tools/workflow.json) and run by [tools/doc-gate-engine.mjs](../tools/doc-gate-engine.mjs); every kind has an invalid/valid self-test.
- Checks are path- and shape-shaped; semantic quality stays in review.
- There is no generated-page freshness check while there is no generated page. The first generated page must arrive with its `--check` command and a workflow surface that runs it.
- `npm run check` proves a skill has front matter, a trigger-shaped `description`, and its four sections. It cannot prove the host loaded the skill when the work happened.
