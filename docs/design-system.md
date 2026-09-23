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
level. Library stories (`src/ui/*.stories.tsx`) are atoms, molecules or
organisms; domain screens are templates, colocated with their domain component
(`src/<area>/*.stories.tsx`, e.g. `src/record/`):

| Level | Contents | Examples |
| ----- | -------- | -------- |
| **Atoms** | Irreducible UI elements | Button, ToggleButton, Icon, Avatar, InlineError, LevelMeter |
| **Molecules** | Small groups doing one job | Menu, DefinitionList, Field, FieldRow |
| **Organisms** | Complex, generic, reusable components / sections | Dialog, BottomSheet |
| **Templates** | Assembled, context-specific domain screens built from the library, shown with static / representative content — no live app state | Declined, LiveComments (record room) |

**Organisms vs Templates:** an organism is generic and reusable anywhere in the
app; a template is one specific domain screen or panel (record room, review
page) assembled from atoms, molecules and organisms. Atoms → molecules →
organisms → templates is the traversal order: design the atom in isolation,
check it composed, then check it in a real screen.

### Domain surfaces (Templates)

Domain components that still need live app, session or sync context
(`timeline/`, `inspector/`, transport chrome) stay out of the catalog: they
compose the library (see `gui/web/docs/ui-library.md`), and stories for them
would couple the catalog to app state. A domain screen that renders fully
state-local from a **pure prop contract** — per the rules under
[Adding a story](#adding-a-story): state in the story, no store, sockets, audio
or app providers, no network (per #172/#173) — belongs under **Templates**, with
its story colocated in the feature folder (for example
`src/record/Declined.stories.tsx`, titled `Templates/Declined`, and
`src/record/LiveComments.stories.tsx`, titled `Templates/LiveComments`).

- Render the surface in its production shell and stylesheet so the story
  renders what ships. Record-room stories use `recordStoryDecorator`
  (`src/record/recordStoryDecorator.tsx`), which wraps the story in
  `cover review-shell record-shell` and loads
  `styles/partials/record-entry.css` (as `RecordApp.tsx` does); its
  `recordMobileViewport` gives a 360px phone view. A standalone full-screen
  surface may import the entry stylesheet directly instead.
- Full-viewport screens (`.cover`, `min-block-size: 100dvh`) set
  `parameters: { layout: "fullscreen" }`.
- Use made-up fixtures only — never real share tokens, guest names, or relay
  URLs. Build them from the shared factories in `src/test/fixtures.ts`
  (`recordParticipant`, `recordSnapshot`, `sampleComment`, …), not new literals.
- If a surface starts reading session or sync context, it needs a decorator
  that provides that context before its story can stay standalone.
- The story does not replace the component's own Vitest + axe test.

## Theme toolbar

The toolbar's paintbrush toggle switches `light` / `dark` / `system` by setting
`data-theme` on `<html>` — the same contract the app uses (`useTheme`). Review
every new component in both themes before merging.

## Adding a story

1. Colocate: `<Name>.stories.tsx` next to `<Name>.tsx` (`src/ui/` for the
   library, the feature folder for domain surfaces).
2. Title every story by Atomic Design level:
   `Atoms|Molecules|Organisms|Templates/<Name>`. Library components use the
   first three; state-local domain screens use `Templates/<Name>`. No
   per-feature top-level categories (not `Record/…`); `storySort` in
   `.storybook/preview.ts` orders Atoms → Molecules → Organisms → Templates —
   don't add new top-level groups without updating it and this doc.
3. Library stories import from `./index` (the public API), not deep paths.
   Feature folders without a barrel (for example `src/record/`) import the
   component module directly (`./Declined`).
4. Keep stories state-local (`useState` in the story) — no app providers, no
   network. Components that need DAW context don't get stories until they can
   render standalone. Use `fn()` from `storybook/test` for callbacks so they
   show in the Actions panel.
5. For Templates, follow the shell, stylesheet, layout and fixture rules under
   [Domain surfaces (Templates)](#domain-surfaces-templates).
6. Give stories that claim behavior a `play` function, and cover them with a
   `composeStories` Vitest test plus `expectNoA11yViolations` (see
   `src/record/LiveComments.stories.test.tsx`) so `make test-web` checks them.
7. Run `npm run build-storybook` before pushing; the Pages workflow rebuilds
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
- 2026-09-23 — Added a fourth Atomic Design level, **Templates**, for
  state-local domain screens with a pure prop contract and colocated stories
  (first: `Templates/Declined`); added import, stylesheet, layout and fixture
  rules for them. Domain components that need live app state remain excluded.
- 2026-09-23 — Added `Templates/LiveComments`, the `recordStoryDecorator`
  record-shell decorator with a 360px viewport, shared record fixture
  factories, and `play` + `composeStories` coverage for Template stories.
- 2026-09-23 — Added `Atoms/LevelMeter` and the `Molecules/ParticipantMeter`
  layout sketch (story-only). Both drive the meter through `audio/usePeakMeter`,
  the same loop `record/useInputPeakDb` uses, so they preview production code.
