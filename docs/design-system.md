# Design system — Storybook source of truth

The visual catalog for Sharecut Studio's component library. Storybook is
**dev-only**: it renders the real production components (`src/ui/`) against the
real theme tokens, and publishes to GitHub Pages. It is never bundled into the
app or desktop builds.

- **Run locally:** `cd gui/web && npm run storybook` (http://localhost:6006)
- **Static build:** `npm run build-storybook` → `gui/web/storybook-static/`
- **Published:** GitHub Pages, deployed from `main` by
  [`.github/workflows/storybook.yml`](../.github/workflows/storybook.yml) on
  every push that touches `gui/web/`. Matching pull requests build Storybook
  without deploying it.

Before the first deployment, enable Pages for this repository with **GitHub
Actions** as the publishing source in Settings → Pages. The workflow uses a
read-only token for building and grants Pages deployment permission only to its
`main` deploy job. After merging, check the `storybook` workflow's deploy job
and open the URL it reports.

## What's in it

Stories live next to their components (`src/ui/*.stories.tsx`) and are
organized by Atomic Design level:

| Level | Contents | Examples |
| ----- | -------- | -------- |
| **Atoms** | Irreducible UI elements | Button, ToggleButton, Icon, Avatar, InlineError |
| **Molecules** | Small groups doing one job | Menu, DefinitionList, Field, FieldRow |
| **Organisms** | Complex components / sections | Dialog, BottomSheet |

Domain components (`timeline/`, `inspector/`, transport chrome) are intentionally
out — they compose the library (see `gui/web/docs/ui-library.md`), and stories
for them would couple the catalog to app state. Atoms → molecules → organisms
is the traversal order: design the atom in isolation, then check it composed.

## Theme toolbar

The toolbar's paintbrush toggle switches `light` / `dark` / `system` by setting
`data-theme` on `<html>` — the same contract the app uses (`useTheme`). Review
every new component in both themes before merging.

## Adding a story

1. Colocate: `src/ui/<Name>.stories.tsx` next to `<Name>.tsx`.
2. Title it `Atoms|Molecules|Organisms/<Name>`.
3. Import from `./index` (the public API), not deep paths.
4. Keep stories state-local (`useState` in the story) — no app providers, no
   network. Components that need DAW context don't get stories until they can
   render standalone.
5. Run `npm run build-storybook` before pushing; the Pages workflow rebuilds
   from `main` anyway.

## Governance

- Stories render production code — never a copy. If a story needs a tweak to
  the component, the component changes, with its Vitest/axe tests.
- a11y addon runs wcag2a/wcag2aa checks per story; the repo's axe posture
  (shared `ui/` changes need axe checks) applies to Storybook-visible changes
  too.
- Token naming system: canonical doc is [issue
  #81](https://github.com/calebn/sharecut-studio/issues/81) until
  `docs/design-tokens.md` lands with it. The primitive palette
  (`primitives.css`) is the raw-value tier stories ultimately resolve to.

## Changelog

- 2026-09-21 — Scaffolded Storybook 10 (react-vite) with theme toolbar, 11
  story files across Atoms/Molecules/Organisms, and GitHub Pages deploy
  workflow.
