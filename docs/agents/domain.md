# Domain Docs

This repository uses a single domain context.

## Before exploring, read these

- `CONTEXT.md` at the repository root.
- Relevant decisions under `docs/adr/`, when that directory exists.

If a file does not exist, proceed silently. The domain-modeling workflow creates glossary and decision records lazily.

## Use the glossary vocabulary

Use canonical terms from `CONTEXT.md` in specs, tickets, tests, and implementation. Avoid synonyms explicitly listed there.

If a needed concept is missing, reconsider the wording or resolve the gap through domain modeling instead of silently inventing a competing term.

## Flag ADR conflicts

Surface any conflict with an existing ADR explicitly rather than silently overriding it.
