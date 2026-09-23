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

Stories live next to their components and are organized by Atomic Design
level. Library stories live in `src/ui/*.stories.tsx`; Templates live next to
their domain component (`src/<area>/*.stories.tsx`, e.g. `src/record/`).

| Level | Contents | Examples |
| ----- | -------- | -------- |
| **Atoms** | Irreducible UI elements | Button, ToggleButton, Icon, Avatar, InlineError, LevelMeter |
| **Molecules** | Small groups doing one job | Menu, DefinitionList, Field, FieldRow |
| **Organisms** | Complex, generic, reusable components / sections | Dialog, BottomSheet |
| **Templates** | Assembled, context-specific domain screens built from the library, with static content | LiveComments (record room) |

**Organisms vs Templates:** an organism is generic and reusable anywhere in the
app; a template is one specific domain screen or panel (record room, review
page) assembled from atoms, molecules and organisms. Templates render from a
**pure prop contract** with static fixture content — nothing that needs the
store, sockets, audio or app providers (per #172/#173). Domain components that
need DAW context (`timeline/`, `inspector/`, transport chrome) stay out until
they can render standalone (they compose the library — see
`gui/web/docs/ui-library.md`); stories for them would couple the catalog to app
state. Atoms → molecules → organisms → templates is the traversal order: design
the atom in isolation, then check it composed.

## Theme toolbar

The toolbar's paintbrush toggle switches `light` / `dark` / `system` by setting
`data-theme` on `<html>` — the same contract the app uses (`useTheme`). Review
every new component in both themes before merging.

## Adding a story

1. Colocate: `src/ui/<Name>.stories.tsx` next to `<Name>.tsx`, or for a
   Template `src/<area>/<Name>.stories.tsx` next to the domain component.
2. Title it `Atoms|Molecules|Organisms|Templates/<Name>`. Top-level groups must
   appear in `storySort.order` in `.storybook/preview.ts`; don't add new ones
   without updating this doc.
3. Library stories import from `./index` (the public API), not deep paths.
   Template stories import the component module directly (`./<Name>`), since
   domain areas have no barrel.
4. Keep stories state-local (`useState` in the story) — no app providers, no
   network. Components that need DAW context don't get stories until they can
   render standalone. Use `fn()` from `storybook/test` for callbacks so they
   show in the Actions panel.
5. Render Templates inside their production shell classes. Record-room stories
   use `recordStoryDecorator` (`src/record/recordStoryDecorator.tsx`), which
   wraps the story in `cover review-shell record-shell` and loads
   `record-entry.css`; its `recordMobileViewport` gives a 360px phone view.
6. Build fixtures from the shared factories in `src/test/fixtures.ts`
   (`recordParticipant`, `recordSnapshot`, `sampleComment`, …), not new literals.
7. Give stories that claim behavior a `play` function, and cover them with a
   `composeStories` Vitest test plus `expectNoA11yViolations` (see
   `src/record/LiveComments.stories.test.tsx`) so `make test-web` checks them.
8. Run `npm run build-storybook` before pushing; the Pages workflow rebuilds
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
- 2026-09-23 — Added the **Templates** level (context-specific domain screens
  with a pure prop contract) after Organisms in `storySort.order`, colocated
  domain stories under `src/<area>/`, the record-shell decorator and 360px
  viewport, and the first Template: `Templates/LiveComments`.
- 2026-09-23 — Added `Atoms/LevelMeter` and the `Molecules/ParticipantMeter`
  layout sketch (story-only). Both drive the meter through `audio/usePeakMeter`,
  the same loop `record/useInputPeakDb` uses, so they preview production code.
