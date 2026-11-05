# Decision records

dsh-cowork keeps one short record per non-trivial decision, borrowed in spirit from the agent-workflow-kit lifecycle but scoped down to the project.

## When to write one

Write a proposal when a change answers at least one of:

- it introduces a public tool, a stored format, or a preset contract;
- it changes the thread lifecycle or the handoff schema;
- it chooses one architecture over another (e.g. `sessionController` vs subagent);
- it changes what the next agent may or may not do.

Do not write a record for a routine bug fix or a documentation wording fix.

## Classes

The closed set: `feature` / `bug-fix` / `simplification` / `architecture` / `process` / `testing`.

## Flow

1. Create `.agents/notes/proposed/<class>/<yyyy-mm-dd>-<slug>.md` from `proposed/TEMPLATE.md`.
2. Review decides it lands. The same delivery that lands the work moves the file to `implemented/<class>/` and rewrites it in the present tense.
3. Moving is a skeleton rewrite, not a rename: `## Proposal` becomes `## Decision`, and `## Acceptance criteria` plus `## Risks` fold into `## Consequences`; criterion ids survive in `## Testing`. Both lifecycles require `## Problem` and a non-empty `## Alternatives considered`.
4. A decision is never edited in place after landing. To overturn it, write a new record and link the old one.
