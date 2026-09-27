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
| **Atoms** | Irreducible UI elements | Button, ToggleButton, Icon, Avatar, InlineError, LevelMeter, ClipLed, Pill, Timecode, EmptyState, SurfaceLadder (token reference), CloseButton |
| **Molecules** | Small groups doing one job | Menu, DefinitionList, Field, FieldRow, SegmentedControl, UndoToast, FocusPull |
| **Organisms** | Complex, generic, reusable components / sections | Dialog, BottomSheet, CoverScreen, LoadingScreen, ErrorScreen |
| **Templates** | Assembled, context-specific domain screens and their shipped chrome, shown with static / representative content and locked domain copy — no live app state | ConsentGate, DeviceCheck, Lobby, RecIndicator, Declined, FullRoom, LiveComments, HostUploadRoster (record room), Transport, TransportPlayControls, PipelineStatusChip, ListenHero, TimelineRange, TimeRuler, AppliedEditOverlay, StaleInvalidationOverlay, TrackHeader, CommentCard, CommentCompose, GhostWordChips, TranscriptTurn, InspectorSeekFooter, HostMcpDialog, GesturesSheet |

**Organisms vs Templates:** an organism is generic and reusable anywhere in the
app; a template is one specific domain screen or panel (record room, review
page) assembled from atoms, molecules and organisms. Atoms → molecules →
organisms → templates is the traversal order: design the atom in isolation,
check it composed, then check it in a real screen.

### Domain surfaces (Templates)

Domain components get stories only when they are **props in, UI out** (scope
rule from #172/#173): renderable from a pure prop contract alone — no store,
socket, AudioContext or router. Domain components that still need live app,
session or sync context (the live `TimelineView`, `inspector/`, the live
`TransportBar`, the full DAW page) stay out of the catalog: they compose the library (see
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
- Record previews keep hardware and time fixed: `DeviceCheck` and `Lobby` pass
  `stream: null`, `Lobby` supplies a static `storageHeadroomNotice` instead of
  querying browser storage, and `RecIndicator` supplies `clockNowMs` instead of
  running its wall clock. The live components use their normal defaults.
- If a surface starts reading session or sync context, it needs a decorator
  that provides that context before its story can stay standalone.
- The story does not replace the component's own Vitest + axe test.

A live surface can still get a template when its chrome is split into a
presentational frame that the live component renders. `Templates/Transport`
(`src/layout/TransportFrame.stories.tsx`) assembles `TransportFrame` /
`TransportZone` with `Timecode`, `SegmentedControl`, `Pill`, `Button`, and
`Icon`; `TransportBar` renders the same frame and adds command wiring, the
store-driven tool cluster, avatars, and menus. Templates that render a page
banner also render a `<main>` region beside it, so the story harness does not
nest the banner inside its fallback main landmark.

`Templates/TransportPlayControls` shows the shipped Play/Pause and Stop
controls in the wide `TransportFrame` and the phone `ListenHero`, including
the empty-project disabled state. `Templates/PipelineStatusChip` shows the
shipped status chip in the desktop footer and the phone Listen status row
with fictional pipeline and activity jobs. Both accept props and callbacks
alone; the live `TransportBar` and `StatusBar` remain outside Storybook because
they read DAW state. The live chip omits `nowSec` and ticks its stall copy
once a second; most running-chip examples omit a progress timestamp entirely
so the catalog does not depend on a moving clock, and the `Stalled` example
instead passes a fixed `nowSec` so its "last update Ns ago" copy renders
deterministically without ticking.

`Templates/TimelineRange` previews the shipped audition range, selected
comment span and point pin, and playhead needle in a 360px timeline well.
The range overlays already take props alone. `PlayheadNeedle` is the
prop-only paint used by the live `Playhead`, which retains its direct DAW
store subscription and transform updates without React rerenders. The story
uses fictional comments and a fixed zoom; it does not mount the live timeline
or subscribe to the DAW store.
`Templates/TimeRuler` renders the production `TimeRulerView` with fixed
position and visible-chunk props at desktop and 360px widths, plus comment
anchor mode. The live `TimeRuler` adapter reads those values from DAW state
and supplies the store-driven `Playhead`, preserving its per-frame transform.
Storybook supplies `PlayheadNeedle` at a fixed position instead.
`Templates/AppliedEditOverlay` renders the shipped applied-edit ticks in a
production timeline lane. Fictional prop records cover visible and selected
edits, densely spaced short cuts, and filtered and empty 360px lanes. The
ticks remain decorative and non-interactive; selection belongs to the live
Impact panel. The story does not mount the DAW store or alter edit behavior.
`Templates/StaleInvalidationOverlay` renders the same diagnostic bands used in
the live track lane. Fictional regional, overlapping, short, clipped, filtered,
and empty states show how render invalidations appear at desktop and 360px
widths. Whole-track invalidations have no regional band. The bands remain
decorative and hidden from the accessibility tree; the live stale-status
controls communicate render state. Both overlay stories share the production
lane shell through `timelineLaneStoryDecorator` so desktop and phone widths
stay aligned while retaining each surface's accessible landmark name.

`Templates/CommentCard`, `Templates/CommentCompose`, and
`Templates/GhostWordChips` preview the production transcript comment card,
comment form, and restored-word preview with fictional data. Their stories
show open and resolved comments, action items, replies, read-only and busy
states, editable drafts, empty ghost output, and 360px phone layouts. The
callbacks update only story-local state; the live comment panel remains outside this catalog slice. The restored-word preview
uses the theme's unmapped text color at full opacity so its ghost styling
remains readable in both themes.
Open, Resolved, and Empty stay fixed for visual comparison. ResolveAndReopen
and DraftAndPost exercise the controls separately; Empty passes an explicit
disabled prop rather than adding validation to the shared form. GuestFeedback
and MobileGuestFeedback use the same review shell and compose classes as the
public review page in a fullscreen canvas. DraftAndPost clears its draft after
the story-local successful submit; ActionsAndReplies ignores blank replies
and displays trimmed successful replies, as the public review page does.

`Templates/TranscriptTurn` renders the same `TranscriptTurnView` used by the
live `TranscriptPanel`. The panel owns seeking, selection, touch gestures,
presence anchors, edit-boundary placement and virtualization; the view paints
props for mapped, active/selected, suppressed/low-confidence, cut-away, and
360px long-turn examples. Story callbacks use local state only. Applied edit
boundaries may appear in the live row, but there is no pending-edit row state
to preview yet.

`Templates/InspectorSeekFooter` renders the production `InspectorSeekFooterView`
that every modifier inspector's footer uses. Fixed props cover the quiet-link
and full-button actions, seek-only footers, the Current/Suggested/A/B preview
modes, the blocked-skip reason, and a 360px phone footer. The live
`InspectorSeekFooter` adapter reads the DAW store and chooses the audition
(timeline range, suggested skip or A/B) on Play; the story's callbacks only
update local preview-mode state.

`Templates/HostMcpDialog` and `Templates/GesturesSheet` preview the shipped
agent-connection and mobile gesture dialogs. The agent dialog's story supplies
a fixed loopback URL so its fields and client snippet do not depend on the
Storybook server port; the live dialog still derives its URL from the host.
Standalone Canvas stories open their dialogs for visual review. Autodocs
examples start with launchers so the previews remain independently inspectable
and closable. They cover an open episode, the no-episode warning, the
gesture sheet's callback handoff to keyboard shortcuts, and a 360px phone
viewport without app or network context.

### Catalog boundary (store-bound components)

Per sync rule 6 (#172/#173), a component that cannot render from props alone
gets a refactor issue, not a story. These remaining store-bound surfaces are
tracked as grouped follow-up issues, one per cluster, each component its own
checkbox so it can ship as its own PR:

- **A** ([#608](https://github.com/calebn/sharecut-studio/issues/608)) — share
  and bounce dialogs: `ShareDialog`, `BounceDialog`
- **B** ([#609](https://github.com/calebn/sharecut-studio/issues/609)) —
  follow and guest-attention banners: `FollowBanner`,
  `GuestAttentionBanner`
- **C** ([#610](https://github.com/calebn/sharecut-studio/issues/610)) —
  status-bar chrome: `StatusBar`, `AvatarStack`, `OverlayLegend`
- **D** ([#611](https://github.com/calebn/sharecut-studio/issues/611)) — tool
  rail, tool mode toggle and command palette: `EditingToolRail`,
  `ToolModeToggle`, `CommandPalette`
- **E** ([#612](https://github.com/calebn/sharecut-studio/issues/612)) —
  tabs splitter: `BottomTabsSplitter`
- **F** ([#614](https://github.com/calebn/sharecut-studio/issues/614)) —
  timeline editing surfaces: `ClipBlock`, `MarkerLane`,
  `PendingEditOverlay`, `EditBoundaryMark`
- **G** ([#615](https://github.com/calebn/sharecut-studio/issues/615)) — live
  timeline overlays: `EnvelopeOverlay`, `PresenceOverlay`,
  `CommentPlaybackBubble`
- **H** ([#616](https://github.com/calebn/sharecut-studio/issues/616)) —
  fixture-composed `MobileShell` and `StudioShell` chrome at 360px and
  desktop, blocked by C, D and the remaining `TransportBar` pieces

`CommandButton` and `CommandMenuItem` are command-bus adapters over `Button`
and `MenuItem`, which already have stories; they are not on this list and get
no separate refactor issue. A component leaves this list only once its
production view is extracted into a props-only `XView` rendered by the live
adapter, the way `TrackHeaderView`, `TimeRulerView` and `TranscriptTurnView`
already were.

`Atoms/SurfaceLadder` renders the five ladder rungs, fields, the selected chip,
stage, transport, accent, and danger from the live tokens — iterate on the
palette there and flip the theme toolbar before touching components.

## Theme toolbar

The toolbar's paintbrush toggle switches `light` / `dark` / `system` by
setting `data-theme` on `<html>` through the app's `applyTheme`
(`hooks/useTheme.ts`) — the same contract the app uses. **System** removes
the attribute, so tokens follow `prefers-color-scheme` with a dark baseline.

Docs (autodocs and standalone MDX) pages render inside `StudioDocsContainer`
(`src/storybook/StudioDocsContainer.tsx`). The preview applies Storybook's
globals update before the docs page mounts, so the toolbar choice reaches
the document even when no story decorator runs. The container resolves the effective
theme (`resolvedDocumentTheme`) and builds the Storybook docs theme from the
live `--color-bg-canvas`, `--color-text-primary` and `--color-border`
tokens, so docs pages and story mode match. Those three tokens must stay
valid hex in `brand-tokens.css` (Storybook's theme helpers need real
colours); `tests/test_brand_color_roles.py` checks all three theme selectors.
Review every new component in
both themes, in story mode and on its docs page, before merging.

`Templates/TrackHeader` renders the production `TrackHeaderView` and
`TrackMuteSoloButtonsView` from fixed, fictional props. It covers selected,
saved/listen/implied mute, solo, stale stem, empty lane, reorder/drop, and
360px phone states. The live `TrackHeader` and `TrackMuteSoloButtons` adapters
continue to read DAW state and dispatch commands; catalog stories do not mount
that store or simulate command execution.

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
9. Give stories that claim behavior a `play` function. The generic
   `src/test/allStories.test.tsx` suite discovers every colocated `.stories.ts`
   and `.stories.tsx` module, runs
   its `play` function, and checks the rendered DOM with axe in CI. Keep
   colocated component tests for behavior that needs specific assertions.
10. Run `npm run build-storybook` before pushing; the Pages workflow rebuilds
    from `main` anyway.

## Governance

- Every `src/**/*.stories.ts(x)` file must default-export a local `const`
  metadata object with a literal `title` of the form
  `Atoms|Molecules|Organisms|Templates/<Name>` (one nonempty name segment).
  `gui/web/src/test/storyGovernance.test.ts` parses the metadata and checks
  every story in the Vitest suite; computed, missing, blank, and later
  overridden titles fail. Keep the exported metadata object local and do not
  mutate or alias it after declaration. Local bindings named `meta` inside
  functions, catch clauses, and `for…in`/`for…of` loops are separate values;
  writes to the exported object before or after those scopes still fail.
  Computed object-method keys run before method parameters are bound, so
  direct metadata writes in those keys also fail.
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
  existing story-negation rules apply to each call. For both checks,
  non-literal specifiers (variables, template or concatenated strings) and
  path aliases are not detected, so keep story-adjacent imports literal and
  relative.
- `npm run build` inspects Vite's resolved module IDs as it builds the app
  and rejects stories, Storybook packages, and story-support modules. This
  checks the shipped build graph even when minification removes import text;
  ordinary Storybook-related app copy is unaffected. Storybook's own build
  does not use the production-app guard. The app build also rejects JavaScript
  under `gui/web/public/`, which Vite would copy without module inspection;
  add scripts to `src/` so the build can inspect them. Symlinks in `public/`
  are rejected because Vite follows their targets when copying assets.
- Stories render production code — never a copy. If a story needs a tweak to
  the component, the component changes, with its Vitest/axe tests.
- a11y addon runs wcag2a/wcag2aa checks per story; the repo's axe posture
  (shared `ui/` changes need axe checks) applies to Storybook-visible changes
  too.
- Token naming system: [design-tokens.md](design-tokens.md) defines the naming
  tiers and usage rules. The primitive palette
  (`primitives.css`) is the raw-value tier stories ultimately resolve to.

## Changelog

- 2026-09-27 — Added `Templates/InspectorSeekFooter` over the extracted
  props-only `InspectorSeekFooterView` (#612).
- 2026-09-27 — Closed #172: added the fixed-`nowSec` pipeline stall preview,
  the `LoadingScreen` / `ErrorScreen` / `CloseButton` cover-screen stories,
  the `UndoToast` and `FocusPull` stories, and the Catalog boundary section
  above tracking follow-up refactor issues A–H for the remaining store-bound
  surfaces.

- 2026-09-27 — Added `Templates/TimeRuler` with a prop-driven production
  ruler view, desktop and 360px fixtures, and comment-anchor mode.

- 2026-09-27 — Added `Templates/TimelineRange` with production audition,
  comment selection, and prop-only playhead paint at a 360px viewport.

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
- 2026-09-23 — Added `Molecules/SegmentedControl`, `Atoms/Pill`,
  `Atoms/Timecode`, `Atoms/EmptyState`, the `Atoms/SurfaceLadder` token
  reference, `Templates/Transport` (presentational `TransportFrame`) and
  `Templates/ListenHero` (the phone Listen card); `Molecules/Menu` gained
  section labels and shortcut rows (#20).
- 2026-09-24 — Transport and Listen templates render the shipped
  `TransportPlayControls` and pill markup instead of re-authored copies; the
  `Menu` WithShortcuts story opens in `play`; `CloseButton` is the shared
  Dialog / BottomSheet close (#20 review).
- 2026-09-23 — Docs pages follow the theme toolbar (System on a dark OS no
  longer renders a white docs canvas): StudioDocsContainer builds the docs
  theme from Studio tokens; the toolbar decorator reuses useTheme's
  applyTheme (#209).
- 2026-09-25 — Added `Atoms/ClipLed`, the clip LED shared by `LevelMeter`
  and the REC indicator (#174). Clipping is sample peak only.
- 2026-09-26 — Added standalone transport Play/Stop and pipeline status chip
  stories with production chrome, fixture-only state, and interaction checks.
