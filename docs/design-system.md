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

Stories live next to their components (`src/ui/*.stories.tsx` for the shared
library, `src/<area>/*.stories.tsx` for domain components such as
`src/record/`) and are organized by Atomic Design level:

| Level | Contents | Examples |
| ----- | -------- | -------- |
| **Atoms** | Irreducible UI elements | Button, ToggleButton, Icon, Avatar, InlineError, LevelMeter |
| **Molecules** | Small groups doing one job | Menu, DefinitionList, Field, FieldRow |
| **Organisms** | Complex components / sections | Dialog, BottomSheet |
| **Templates** | Domain screens / sections with representative fixtures and locked copy | ConsentGate |

Domain components get stories only when they are **props in, UI out** (scope
rule from #172): renderable from props alone — no store, socket, AudioContext
or router. Components whose essence is live DAW state (timeline, inspector,
the full DAW page) stay out; integration is covered by Playwright. Atoms →
molecules → organisms → templates is the traversal order: design the atom in
isolation, then check it composed.

## Theme toolbar

The toolbar's paintbrush toggle switches `light` / `dark` / `system` by setting
`data-theme` on `<html>` — the same contract the app uses (`useTheme`). Review
every new component in both themes before merging.

## Adding a story

1. Colocate: `<Name>.stories.tsx` next to `<Name>.tsx` (`src/ui/` or the
   domain folder).
2. Title it `Atoms|Molecules|Organisms|Templates/<Name>`. **Organisms** are
   generic and reusable anywhere (Dialog, BottomSheet) and carry no
   domain-specific fixtures or copy. **Templates** are domain screens or
   sections (e.g. `src/record/`) assembled from the lower tiers, rendered with
   static representative content and locked domain copy, and kept state-local
   per step 4 — no live app state. Sidebar order is set by `storySort.order`
   in `.storybook/preview.ts`.
3. `src/ui/` stories import from `./index` (the public API), not deep paths.
   Domain stories import the component module directly (`./ConsentGate`) —
   domain folders have no barrel.
4. Keep stories state-local (`useState` in the story) — no app providers, no
   network. Components that need DAW context don't get stories until they can
   render standalone.
5. Render in production context: if the app mounts the component inside a
   shell class (e.g. `review-shell record-shell`), add a decorator with those
   classes so shell-scoped type and heading styles apply.
6. Reuse locked copy constants (e.g. `record/types.ts`) for fixture text next
   to the component; never invent UI copy the app doesn't show.
7. Callback args use `fn()` from `storybook/test` so clicks appear in the
   Actions panel.
8. Give fixture element ids a story-unique value — autodocs renders every
   story on one page.
9. Stories with `play` functions are executed in Vitest via `composeStories`
   + `Story.run()` in the component's `*.test.tsx` (see
   `src/record/ConsentGate.test.tsx`); CI does not otherwise render stories.
10. Run `npm run build-storybook` before pushing; the Pages workflow rebuilds
   from `main` anyway.

## Governance

- Fixtures are static placeholders. The built Storybook is published, so never
  copy real project, share, or guest data (tokens, names) into a story.
- App code never imports `*.stories.tsx` or globs them (`import.meta.glob`);
  stories must stay out of the production bundle.
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
- 2026-09-23 — First domain story (`record/ConsentGate`): documented domain
  colocation, direct imports, shell decorators, locked-copy fixtures, `fn()`
  callbacks, and running `play` functions through `composeStories` in Vitest.
  Added the **Templates** tier for domain screens.
- 2026-09-23 — Added `Atoms/LevelMeter` and the `Molecules/ParticipantMeter`
  layout sketch (story-only). Both drive the meter through `audio/usePeakMeter`,
  the same loop `record/useInputPeakDb` uses, so they preview production code.
