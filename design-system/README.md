# Design-system registry

The machine-readable design system for the platform dashboard
(`packages/frontend`). Agents and humans read it instead of guessing what the
CSS does; a generator keeps it true.

## Files

- `registry/components.json` — GENERATED. The cascade-resolved token tables
  (light + dark), every BEM block with its classes and source files, the
  primitives (`src/components/ui/`), the legacy→primitive migration map, the
  canonical rules and the ghost rules.
- `registry/llms.txt` — GENERATED. The same content in a compact text form for
  agent context.
- `generate-registry.mjs` (+ `lib/`) — the generator. Dependency-free; parses
  `src/styles` from the `theme.css` entry, follows `@import` depth-first, then
  appends the component-imported sheets, and resolves the cascade (selector
  specificity, then source order) exactly like the browser.
- `migration-map.json` — hand-kept. Legacy component → the primitive that
  replaces it. Filled as primitives are built.

## Commands

```
npm run design:registry          # regenerate registry/* (commit the result)
npm run design:registry:check    # exit 1 if registry/* is stale (pre-commit runs this)
```

## Vocabulary

- **Canonical rule** — when the same selector+property is declared twice with
  different values, the declaration that actually renders, with its source.
  Edit that one; never add a competing declaration.
- **Ghost rule** — a declaration that always loses to the canonical one. Dead
  weight, listed for the refactor project to delete.
- **Component-loaded sheet** — a stylesheet imported by a component instead of
  `theme.css`; it loads after the global styles.

Related pieces of the machine: `scripts/check-design-tokens.mjs` (the diff
check), the `.claude/settings.json` PostToolUse hook that runs it, and the
`manifest-design-system` team skill.
