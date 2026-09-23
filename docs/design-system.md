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
| **Templates** | Assembled, context-specific domain screens built from the library, shown with static / representative content and locked domain copy — no live app state | ConsentGate, Declined, LiveComments, HostUploadRoster (record room) |

**Organisms vs Templates:** an organism is generic and reusable anywhere in the
app; a template is one specific domain screen or panel (record room, review
page) assembled from atoms, molecules and organisms. Atoms → molecules →
organisms → templates is the traversal order: design the atom in isolation,
check it composed, then check it in a real screen.

### Domain surfaces (Templates)

Domain components get stories only when they are **props in, UI out** (scope
rule from #172/#173): renderable from a pure prop contract alone — no store,
socket, AudioContext or router. Domain components that still need live app,
session or sync context (`timeline/`, `inspector/`, transport chrome, the full
DAW page) stay out of the catalog: they compose the library (see
`gui/web/docs/ui-library.md`), stories for them would couple the catalog to app
state, and their integration is covered by Playwright. A domain screen that
renders fully state-local — per the rules under [Adding a story](#adding-a-story):
state in the story, no app providers, no network — belongs under **Templates**,
with its story colocated in the feature folder (for example
`src/record/Declined.stories.tsx` → `Templates/Declined`,
`src/record/ConsentGate.stories.tsx` → `Templates/ConsentGate`,
`src/record/LiveComments.stories.tsx` → `Templates/LiveComments`,
`src/record/HostUploadRoster.stories.tsx` → `Templates/HostUploadRoster`).

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

The toolbar's paintbrush toggle switches `light` / `dark` / `system` by
setting `data-theme` on `<html>` through the app's `applyTheme`
(`hooks/useTheme.ts`) — the same contract the app uses. **System** removes
the attribute, so tokens follow `prefers-color-scheme` with a dark baseline.

Docs (autodocs) pages render inside `StudioDocsContainer`
(`src/storybook/StudioDocsContainer.tsx`), which resolves the same effective
theme (`resolvedDocumentTheme`) and builds the Storybook docs theme from the
live `--color-bg-canvas`, `--color-text-primary` and `--color-border`
tokens, so docs pages and story mode match. Those three tokens must stay
valid hex in `brand-tokens.css` (Storybook's theme helpers need real
colours); `tests/test_brand_color_roles.py` checks all three theme selectors.
Review every new component in
both themes, in story mode and on its docs page, before merging.

## Adding a story

1. Colocate: `<Name>.stories.tsx` next to `<Name>.tsx` (`src/ui/` for the
   library, the feature folder for domain surfaces).
2. Title every story by Atomic Design level:
   `Atoms|Molecules|Organisms|Templates/<Name>`. Library components use the
   first three; **Organisms** are generic and reusable anywhere (Dialog,
   BottomSheet) and carry no domain-specific fixtures or copy. State-local
   domain screens use `Templates/<Name>`. No per-feature top-level categories
   (not `Record/…`); `storySort` in `.storybook/preview.ts` orders Atoms →
   Molecules → Organisms → Templates — don't add new top-level groups without
   updating it and this doc.
3. Library stories import from `./index` (the public API), not deep paths.
   Feature folders without a barrel (for example `src/record/`) import the
   component module directly (`./ConsentGate`, `./Declined`).
4. Keep stories state-local (`useState` in the story) — no app providers, no
   network. Components that need DAW context don't get stories until they can
   render standalone.
5. Render in production context: if the app mounts the component inside a
   shell class (e.g. `review-shell record-shell`), use a decorator with those
   classes so shell-scoped type and heading styles apply. For Templates, follow
   the shell, stylesheet, layout and fixture rules under
   [Domain surfaces (Templates)](#domain-surfaces-templates).
6. Reuse locked copy constants (e.g. `record/types.ts`) for fixture text next
   to the component; never invent UI copy the app doesn't show.
7. Callback args use `fn()` from `storybook/test` so clicks appear in the
   Actions panel.
8. Give fixture element ids a story-unique value — autodocs renders every
   story on one page.
9. Give stories that claim behavior a `play` function. Stories with `play`
   functions are executed in Vitest via `composeStories` + `Story.run()` plus
   `expectNoA11yViolations` in a colocated test (see
   `src/record/ConsentGate.test.tsx`, `src/record/LiveComments.stories.test.tsx`);
   CI does not otherwise render stories.
10. Run `npm run build-storybook` before pushing; the Pages workflow rebuilds
    from `main` anyway.

## Governance

- Fixtures are static placeholders. The built Storybook is published, so never
  copy real project, share, or guest data (tokens, names) into a story.
- App code never imports `*.stories.tsx` or globs them (`import.meta.glob`),
  never imports Storybook packages, never imports a story-support module
  (e.g. `record/recordStoryDecorator.tsx`, `storybook/docsTheme.ts`,
  `storybook/StudioDocsContainer.tsx`), and never imports a test-only
  module (anything under `src/test/` or a `*.test.*` file); stories must stay
  out of the production bundle. `gui/web/src/test/storyGovernance.test.ts`
  enforces all of this for `src/` and for the root build configs
  (`gui/web/*.config.*`); only `.storybook/` may glob stories. New
  story-support modules must be added to `STORY_SUPPORT_MODULES` in
  `gui/web/src/test/storyGovernance.ts`. The check parses TypeScript and JSX
  syntax for literal `import`, `export … from`, `import()`, and `require()`
  specifiers and real `import.meta.glob` calls, so comments and ordinary
  strings cannot look like imports or glob calls. Literal glob arguments may
  be one quoted string, a static backtick string, or an array of those;
  existing story-negation rules apply
  to each call. For both checks,
  non-literal specifiers (variables, template or concatenated strings) and
  path aliases are not detected, so keep story-adjacent imports literal and
  relative.
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
- 2026-09-23 — Added `Templates/ConsentGate` (`record/ConsentGate`): documented
  shell decorators, locked-copy fixtures, `fn()` callbacks, and running `play`
  functions through `composeStories` in Vitest.
- 2026-09-23 — Added `Templates/LiveComments`, the `recordStoryDecorator`
  record-shell decorator with a 360px viewport, and shared record fixture
  factories.
- 2026-09-23 — Enforced the "stories stay out of the production bundle" rule
  with gui/web/src/test/storyGovernance.test.ts (#206).
- 2026-09-23 — Added `Atoms/LevelMeter` and the `Molecules/ParticipantMeter`
  layout sketch (story-only). Both drive the meter through `audio/usePeakMeter`,
  the same loop `record/useInputPeakDb` uses, so they preview production code.
- 2026-09-23 — Added `Templates/HostUploadRoster` (`record/HostUploadRoster`):
  post-Stop upload states per participant, with a 360px long-name stress
  fixture.
- 2026-09-23 — Docs pages follow the theme toolbar (System on a dark OS no
  longer renders a white docs canvas): StudioDocsContainer builds the docs
  theme from Studio tokens; the toolbar decorator reuses useTheme's
  applyTheme (#209).
