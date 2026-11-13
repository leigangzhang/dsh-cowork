# Skills

Each directory here is one trigger layer: a single `SKILL.md` an agent loads only when its own condition matches. This page is a way in — which one to reach for — and deliberately not a list of when each one loads, because that is each skill's `description`, the text the loader reads.

## Using one

An agent loads a skill by name once its `description` matches the work. Skills are loaded, not read in order, so the table below is a way in rather than a sequence. Every skill carries the same four sections — `## When to use`, `## How`, `## Verification`, `## Anti-patterns` — and `npm run check` proves those sections exist and the description opens with a load trigger. Skills are agent inputs, not reader-facing pages, so they stay in one language.

## Which one to reach for

| The question you have | Skill | What it gives you |
|---|---|---|
| How do I write, restructure, budget, or publish a document? | [`write-docs`](write-docs/SKILL.md) | kinds, placement, link/mirror/generate, budgets, and the publication switch |
| Which contracts must this prose keep, and where does each kind belong? | [`prose-standard`](prose-standard/SKILL.md) | complete-proposition editing, required coverage by location, and borderline decisions |
| This prose reads like a leaked authoring session | [`trim-cot-leakage`](trim-cot-leakage/SKILL.md) | what to cut, and which factual clauses have to survive the cut |
| I need to review a change, prepare a PR, or judge whether findings are fixed | [`dsh-cowork-review`](dsh-cowork-review/SKILL.md) | scope report, evidence selection, review priorities, and finding format |

## Related

- Every home in this repository, and what each one owns: [docs/README.md](../../docs/README.md).
- The rules these skills apply: [docs/AGENTS.md](../../docs/AGENTS.md).
- The checks that keep the skill set honest: [tools/workflow.json](../../tools/workflow.json) and [tools/check-invariants.mjs](../../tools/check-invariants.mjs).
