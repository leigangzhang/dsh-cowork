# Documentation standard

The documentation rules for this repository. They are adapted from the agent-workflow-kit documentation harness and cut to one language (Chinese) and one tier (minimum).

## Document kinds

Every document gets one kind first, and the kind fixes its skeleton, its budget, and its reader. The kind follows from **mechanical facts** — which question it answers, and who reads it — never from the directory name.

| kind | It answers | Not its job |
|---|---|---|
| guide (`README.md`, this file, `docs/testing.md`) | One learning path, or one current rule | Restating what the homes it links to already say |
| index (`docs/README.md`) | Where to find what | Any rule or fact of its own |
| plan (`docs/PLAN.md`) | Product scope, architecture, milestones, acceptance | Implementation steps as prose |
| reference (`docs/glossary.md`, `docs/plain-language.md`) | A current fact looked up by name or term | Teaching paths, rationale |
| template (`*/TEMPLATE.md`) | What a record should look like | Real content |
| record (`.agents/notes/`) | One decision and its rejected alternatives | Current-state rules |
| switch (`docs/publish.json`) | Which files may ship | A second allow-list elsewhere |

To add a kind, supply all three at once: its skeleton, its home, and a check that maps documents to it. With one missing, no reader can say whether a document of that kind is acceptable.

**Names.** Uppercase is for names a tool or reader looks up by name: `README.md`, `AGENTS.md`, `TEMPLATE.md`. Every other file is lowercase kebab-case. A name is a label, never a kind signal.

## One home per fact

A fact lives in one home; everywhere else links there.

| One fact | Its home | Not its home |
|---|---|---|
| Standing rules | `AGENTS.md` | Stories, examples, flows |
| Product scope and milestones | `docs/PLAN.md` | Implementation code |
| Test strategy | `docs/testing.md` | Concrete commands (→ the changed surface's evidence) |
| Documentation rules | this file | Product contracts |
| Why a choice was made | `.agents/notes/implemented/` | Current-state rules |
| What a word means | `docs/glossary.md` | Translation or plain-language |
| What may be published | `docs/publish.json` | Any other allow-list |
| What a check runs | `tools/workflow.json` | A hand-copied checklist |

**Restatement is drift**: when a sentence appears twice, delete one copy and link the other.

## Tutorial or reference

Every document is one or the other, decided by **purpose**, not by path:

- **tutorial**: an ordered path to a result;
- **reference**: a lookup scope describing current behaviour.

Substantial in both → split it. Only a small part is the other form → label that section in place.

## Generated, mirrored, or linked

A fact enters documentation in exactly three ways, and the default is the third:

1. **link**: the fact lives in source or configuration, and the document says what it is and where to look.
2. **mirror**: when it must be shown verbatim, the block is registered and compared against its source; registration and paste update in the same change.
3. **generate**: a whole page exported by a generator from one source. A generated page is read-only; change the generator and re-run it, never patch the page.

`dsh-cowork` currently uses only links. Do not paste an interface into prose; link the source declaration.

## Budgets

A standing document is a budget, not a warehouse. Over budget, in this order:

1. **relocate**: the content belongs in another home → move it and leave a link;
2. **condense**: it does belong here, but it can be shorter;
3. **raise the number**: only when the words genuinely need the space, and say why in the commit.

The executable budget is `AGENTS.md` at 80 lines. Other standing documents stay short by review; a new hard budget needs a check in `tools/check-invariants.mjs`.

## Publication

**A file existing is not a file shipping.** [docs/publish.json](publish.json) is the only publication switch, and it classifies every Markdown file in the corpus as `public` or `internal`:

- `public` **names files one by one** and accepts no glob;
- `internal` may be declared by home and must state why the file stays in the repository;
- every file must hit **exactly** one declaration: no match is a silent omission, two matches are ambiguous — both are red;
- a `public` entry with no real file behind it is a broken link and red.

The manifest is the switch of the projection, not the projection itself.

## The slop checklist

Search for each of these before a documentation change lands:

- **duplicated rules**: keep one home, turn the rest into links;
- **history out of bounds**: "it used to be" inside a current-state document → move to a decision record;
- **implementation-status annotations**: "implemented", "will later…" — status rots;
- **hand-copied catalogs**: do not copy lists of tools, events, or checks into a document;
- **reasoning-trace leakage**: keep the conclusion, delete the path;
- **paragraph walls**: split or demote detail to its home;
- **emphasis inflation**: bold everywhere means nothing stands out;
- **prose restating code**: write the contract, failure modes, timing, and ownership instead.

## Known limits

- `publish-manifest` guarantees only that every file is classified once and that `public` names real files one by one. Whether a site build really ships those files is the build's job, not this gate.
- The checks here are path- and shape-shaped; semantic quality stays in review.
