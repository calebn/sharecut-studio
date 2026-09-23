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

Stories live next to their components (`src/ui/*.stories.tsx` for the UI kit,
`src/<area>/*.stories.tsx` for domain templates) and are organized by Atomic
Design level:

| Level | Contents | Examples |
| ----- | -------- | -------- |
| **Atoms** | Irreducible UI elements | Button, ToggleButton, Icon, Avatar, InlineError |
| **Molecules** | Small groups doing one job | Menu, DefinitionList, Field, FieldRow |
| **Organisms** | Complex components / sections | Dialog, BottomSheet |
| **Templates** | Assembled, context-specific domain screens rendered from representative fixture content (no live app state) | HostUploadRoster |

Domain components are in scope only when they are **props in, UI out**: they
render from fixture props alone, with no store, socket, AudioContext, or router
(scope rule from issue #172). Those state-local domain screens are titled under
**Templates** — they assemble atoms, molecules, and organisms into a
context-specific screen shown with static, representative content. The record
upload roster (`src/record/HostUploadRoster.stories.tsx`,
`Templates/HostUploadRoster`) is the first template. The generic tiers (Atoms,
Molecules, Organisms) stay reserved for the domain-agnostic UI kit in `src/ui/`.
Components that read the DAW store or live session state (`timeline/`,
`inspector/`, transport chrome today) stay out until they can render
standalone — stories for them would couple the catalog to app state. Atoms →
molecules → organisms → templates is the traversal order: design the atom in
isolation, then check it composed.

## Theme toolbar

The toolbar's paintbrush toggle switches `light` / `dark` / `system` by setting
`data-theme` on `<html>` — the same contract the app uses (`useTheme`). Review
every new component in both themes before merging.

## Adding a story

1. Colocate: `<Name>.stories.tsx` next to `<Name>.tsx` (`src/ui/` or the
   domain folder, e.g. `src/record/`).
2. Title it `Atoms|Molecules|Organisms/<Name>` for UI-kit components, or
   `Templates/<Name>` for state-local domain screens.
3. UI-kit stories import from `./index` (the public API), not deep paths.
   Domain stories import the production component module directly.
4. Build fixtures with the shared factories in `src/test/fixtures.ts`
   (`sampleParticipant`, `sampleComment`, …) and call them per story so stories
   never share mutable objects.
5. Keep stories state-local (`useState` in the story) — no app providers, no
   network. Components that need DAW context don't get stories until they can
   render standalone.
6. Run `npm run build-storybook` before pushing; the Pages workflow rebuilds
   from `main` anyway.

## Governance

- Stories render production code — never a copy. If a story needs a tweak to
  the component, the component changes, with its Vitest/axe tests.
- a11y addon runs wcag2a/wcag2aa checks per story; the repo's axe posture
  (shared `ui/` changes need axe checks) applies to Storybook-visible changes
  too.
- Token naming system: [design-tokens.md](design-tokens.md) defines the naming
  tiers and usage rules. The primitive palette
  (`primitives.css`) is the raw-value tier stories ultimately resolve to.

## Changelog

- 2026-09-21 — Scaffolded Storybook 10 (react-vite) with theme toolbar, 11
  story files across Atoms/Molecules/Organisms, and GitHub Pages deploy
  workflow.
- 2026-09-23 — First domain organism: `HostUploadRoster` (record upload
  states, 360px stress fixture); scope widened to props-in/UI-out organisms.
