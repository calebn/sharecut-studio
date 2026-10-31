# ShareCut Studio frontend (`gui/web`)

React + TypeScript + Vite UI for the podcast ShareCut Studio viewer and guest review app.

## Scripts

```bash
npm install
npm run dev         # Vite on :5173 (proxy /api → :8765)
npm run build
npm run storybook  # component catalog on :6006
npm run build-storybook  # static catalog under storybook-static/
npm run test:e2e:storybook  # build catalog, then check Chromium geometry on :6010
npm run typecheck   # tsc -b (strict; includes e2e/, e2e-compat/, and e2e-storybook/)
npm test            # vitest run (unit + component a11y)
npm run test:watch  # vitest watch mode
npm run test:e2e    # Playwright smoke (needs built dist + `podcast gui` / uv; isolated port and post-server fixture cleanup)
npm run lint        # oxlint (JS/TS + jsx-a11y + hygiene) + Stylelint (tokens, rem, no viewport-size @media; !important/@layer consent-gated)
npm run lint:css    # Stylelint only
npm run format      # Biome format + organize imports
npm run format:check
```

Repo root:
- `make test-web` — lint + format:check + typecheck + vitest + build (CI `frontend` job)
- `make test-web-e2e` — E2E-flagged build + Playwright against `aligned_dialogue`, then the Chromium/WebKit compat matrix (CI runs the main shards and each complete compatibility engine concurrently on separate runners behind the `frontend-e2e` gate). Ordinary `npm run build` rejects emitted E2E hooks.
- `npm run test:e2e:compat` — focused Chromium/WebKit compatibility matrix only (`npm run test:e2e:install` installs both engines)

The seven direct compat axe owners and shared touch-affordance and Mix helpers
assign compat scans to WebKit. Main Chromium and reading scans remain enabled. Shared helpers require `StudioAxeOwnership` from
`e2e/studioAxeOwnership.ts`, with `{ suite: "main" }` for main or
`{ suite: "compat", engine: browserName }` for compat. Direct compat scans
use `ownsStudioAxe`. Touch collectors retain owned results until their original
assertion points, after geometry and action evidence. Branded Chrome reports
`browserName: "chromium"`, so it follows the same conditional scan policy.
It keeps its full inventory, including the unchanged comment-undo and wordbar
helper scans.
Only compat Chromium's comment-undo and transcript-wordbar specs are omitted.
Their exact main helper/profile owners and the complete WebKit inventory are
guarded in `tests/test_browser_acceptance_matrix.py`. The actual inherited Chromium
viewport and media profiles are compared in `e2e/mainAxeProfiles.test.ts`. See the
[browser ownership map](../../docs/testing-ci.md#browser-acceptance-matrix).

The `e2e-compat/phone-mix.spec.ts` core flow runs in both engines. Alongside
native mix edits and touch geometry, it checks pointer opening Mix after Search
commands has keyboard focus, initial Close focus, focus return after Close,
Escape, and scrim dismissal, and keyboard navigation that invalidates Mix.
The navigation check uses Tab in Chromium and Alt/Option-Tab in WebKit.

Storybook uses the real `src/ui/` components and theme tokens. See
[`docs/design-system.md`](../../docs/design-system.md) for story conventions and
the GitHub Pages publishing setup. Pull requests build the catalog without
deploying it. The workflow runs `test:e2e:storybook` against the built catalog,
including production boundary stories with restored-word fixtures. Real mouse
trajectories cover
1440px and 360px widths in both themes, stable neighboring text and row geometry,
bounded previews, and Escape cleanup. Install Chromium with
`npx playwright install chromium` before running this focused suite locally.
The suite also checks opened menu and avatar panels in Canvas and Docs,
fixed popovers, and modal and shell isolation at desktop and phone widths.
Use `src/storybook/storyLayout.tsx` for menu spacing and isolated Docs
viewports. Fixed overlays, body portals, and viewport shells render in
separate `40rem` Docs frames that follow the Docs theme toolbar. Previews
keep a `22.5rem` minimum width, or `70rem` for desktop chrome, with horizontal
scrolling inside the Docs canvas. Ordinary components stay inline.
Use standalone Canvas Controls for isolated examples; Storybook does not
connect Docs Controls to iframe stories.
Begin with **Style guide → Start here** for live type/spacing samples,
interactive control states, and links to the component docs and design rules.
The `Templates/TimelineRange` story shows the production audition and comment
selection overlays with the prop-only `PlayheadNeedle` in a 360px timeline
well. The live `Playhead` keeps the DAW store subscription and moves its needle
through a direct transform update during playback.
`Templates/TrackHeader` previews the production track gutter and mute/solo
controls with fictional track data, including stale and empty lanes, reorder
cues, and a 360px phone rail. The live adapters retain DAW state, drag
allowlisting, and command dispatch; stories pass props and action callbacks.
`System/Ruler` is the ruler the live timeline mounts, at 360px, at a deep
zoom and with a host-drawn needle. Its live host (`timeline/TimelineRuler`)
supplies the DAW position, scroll and zoom; the story supplies fixed values
without mounting DAW state.
`Templates/AppliedEditOverlay` previews the production applied-edit ticks in
the timeline lane with fictional visible, selected, dense, filtered and empty
records, including 360px variants. The ticks are decorative and cannot select
an edit; the live Review Queue (`stage/hosts/ReviewHost.tsx`) owns selection.
`Templates/StaleInvalidationOverlay` previews the production stale-render
regions, including overlapping causes, minimum-width spans, right-edge clipping,
and filtered or empty 360px lanes. These bands are decorative; the live stale
status controls explain the render state.
`Templates/PendingEditOverlay` previews the production `PendingEditOverlayView`
with fictional remove, mute and split suggestions, a selected edit, an
end-handle drag, and filtered and 360px lanes. The live adapter commits
`UpdatePendingEdit`.
`Templates/MarkerLaneHost` previews the production `MarkerLaneHost` with
fictional chapters, a social clip, comments and a clipping flag, plus
selected, read-only, empty and 360px variants. The live adapter commits
`UpdateChapter` / `UpdateSocialClip` on host projects only.
`Templates/ClipBlock` previews the production `ClipBlockView` in the shared
lane shell: an editable clip with fade ramps, corner fade handles and
regions, a selected crossfade
join, a trim preview with its ghost, a fade readout, a read-only clip and a
360px clip with its track name. The live `ClipBlock` (memo over
`ClipBlockLive`) owns the gestures and commits; the catalog omits the
store-bound waveform.
`Templates/EditMarkerLayer` previews the production `EditMarkerLayer` and the
real-scale `JoinBlend` in the shared lane shell: every join type and a
blocked crossfade, the narrow (4.8 px), middle (18 px) and wide (48 px)
tiers of a 120 ms crossfade (the wide one with its "Crossfade 120 ms" label), a
label-room lane where a cut's label fits and a longer one would not, and a
count chip with its phone-width twin. The live `TrackLane` plans the lane's joins (`timeline/editMarkers/plan.ts`) and decides
which draw as glyphs and which fold into a chip.
`Templates/EnvelopeOverlay` and `Templates/CommentPlaybackBubble` preview the
shipped live-timeline overlays as props-only views (`EnvelopeOverlayView`,
`CommentPlaybackBubbleView`); the live adapters keep the store, API and
timeline-metrics reads. Each has a 360px story alongside its desktop ones, and a guard
test keeps the views themselves free of direct store/API imports.
`Templates/CommentCard`, `Templates/CommentCompose`, and
`Templates/GhostWordChips` show the shipped comment and transcript preview
components with fictional, local-only state, including 360px phone variants.
They do not mount the live comment panel.
`System/ScriptPane` is the production Script pane; `Stages/Edit/ScriptHost`
runs `stage/edit/script/ScriptHost` over fixture store data for mapped,
selected, cut and 360px long-turn examples. The host retains DAW state,
gestures and the word window; the pane takes props and local callbacks only.
`Templates/TrackMix` renders the production `TrackMixView` with controlled six,
many, long-name, saved/implied mute, read-only, loading, and empty fixtures.
`TrackMix` owns one non-hot selector and projects rows outside it; the view owns
only list composition and shared control presentation.

`Templates/TrackFader` uses the production `TrackFaderView` shared with the
inspector and compact Mix rows. Controlled fixtures cover Reset and focus return, read-only saved
volume, stale Balance, non-dialogue tracks, and a 360px frame. The view keeps
range drafts and their output notes together. The live `TrackFader` adapter
retains capability checks and dispatches native-change commits through
`track.setVolume`; stories use local saved dB state and callback spies.
`Templates/InspectorSeekFooter` shows the production `InspectorSeekFooterView`
shared by the modifier inspectors: seek and play actions, seek-only footers,
preview modes with a blocked-skip reason, and a 360px footer. The live
`InspectorSeekFooter` keeps the DAW store and audition wiring; stories pass
props and local callbacks.
`Stages/Edit/Divider` shows the Script divider with keyboard resize; stories
use local state only.
`Templates/FollowBanner` and `Templates/GuestAttentionBanner` use the
production `FollowBannerView` and `GuestAttentionBannerView` shared with the
live `FollowBanner` and `GuestAttentionBanner` adapters, which keep the
roster/store lookups, IndexedDB polling, and share-vs-host token resolution.
Both stories share the `frameStoryDecorator` `.stage-frame` at desktop
and 360px widths.
`Templates/AvatarStack` and `Templates/OverlayLegend`
show the production `AvatarStackView` and `OverlayLegendView`
used by the live `AvatarStack` and `OverlayLegend` adapters,
including header-hosted and overflow states built from the same
fixtures as the app.
`Templates/EditBoundaryMark` previews the production `EditBoundaryMarkView`
inline in a transcript row, with a roll join, a live roll drag, a
single-clip trim edge and a 360px row. The live adapter commits
`RollClipJoin` / `TrimClipEdge`.
`Templates/HostMcpDialog` and `Templates/GesturesSheet` show the shipped
agent-connection and mobile gesture dialogs. The MCP story passes a fixed
loopback URL so its preview is independent of Storybook's port; the live
dialog derives its local URL as before.
Standalone Canvas stories and isolated autodocs frames open their dialogs
through Canvas play functions, so each can be inspected independently.
Play functions share
`openDialogViaLauncher` from `src/storybook/openDialog.ts`. The gesture callback closes its sheet and
hands off to the live shortcuts owner; the story does not render that owner.
`Stages/Edit/Corner` and `Templates/CommandPalette` show the production
`EditCornerView` and `CommandPaletteView`, each driven by a local-state
preview so toggling the touch range-arm button, or
searching commands and remap fields behaves like the live surface
without mounting the DAW store; the palette story uses fixed command rows
rather than the live catalog and keymap registry, and `commandPaletteRows.test.ts` checks
them against the registry and catalog so the copy cannot drift; the live
`EditCorner` and `CommandPalette` adapters keep reading
DAW state and dispatching through `execute`.

`Stages/Deliver/Share` renders the props-only `ShareSection` of the Deliver
stage. `ShareFlowProvider` in `DawApp` (`stage/hosts/shareFlow.tsx`) lists,
makes, copies and stops the links and runs record rooms; `deliverShare.ts` maps
its state to the section. The link is made and its copy started from the same
click, so the clipboard keeps its user gesture.
`Stages/Deliver/Bounce` renders the props-only `BounceSection` of the Deliver
stage. The Deliver host (`stage/hosts/DeliverStage.tsx`) hands it the project's
selected tracks, solo set, session region and fixed range, and
`BounceFlowProvider` in `DawApp` starts and follows the bounce job, so leaving
Deliver does not stop it.

`Organisms/LoadingScreen` and `Organisms/ErrorScreen` show the shared cover
screens, and `Atoms/CloseButton` shows the one close affordance `Dialog` and
`BottomSheet` both use. `Molecules/Toast` shows the undo/dismiss toast
with a launcher that replays it, including the disabled-Undo (paused timer)
state, a toast with nothing to undo, and a 360px phone variant;
`Organisms/AskDialog` shows the app's confirm and text prompt; `Molecules/FocusPull` shows its initial view
and the exit/enter transition. See
[design-system.md § Catalog boundary](../../docs/design-system.md#catalog-boundary-store-bound-components)
for how store-bound components get hydrated stories.

`Stages/Edit/Frame` composes the app-wired `StageFrame`: header, banners,
the stage body slot, the Player and, on a phone, the tab bar. Its stories
cover desktop, tablet, phone, guest, loading, empty and error states, and
Chromium checks in `e2e-storybook/coverage.spec.ts` cover fit at 360 and 1280
in both themes.

Full-viewport loading, error, and record entry screens share `ui/CoverScreen`.
It supplies the `main.cover` shell and centered content; callers provide an
optional heading, body content, and any existing shell classes. Keep status or
alert roles on the caller's content so each screen retains its own semantics.

## API adapters

`src/api.ts` is the stable named export facade used by components and tests. Domain adapters live in `src/api/`: project and media, waveform, document edits, pipeline and export jobs, shares and recording, bootstrap and diagnostics, comments, and session media. Internal adapters import each other directly rather than importing the facade. Files outside `src/api/` import the facade, not an `api/*` module; `state/readmeRuleGovernance.test.ts` fails a new direct import and allowlists today's 26 file and adapter pairs (24 files). Document commands pass through `src/services/commandQueue.ts` and `src/api/documentTransport.ts` so host and guest queue semantics stay shared.

`src/commands/register.ts` is the stable DAW command registration facade. It calls focused registrars for navigation, editing, view, history, host operations, and project/media in the original order. Each registrar adds handlers to the one map in `src/commands/execute.ts`; `src/keymap/listener.ts` remains the only window shortcut listener. The Edit stage's Action bar verbs (Hear, Split, Keep, Mute, Inspect, More, Cut) are registered by `src/commands/editVerbs.ts`, which also holds the bar's wording and gates (`barModelOf`); `src/stage/edit/EditActionBar.tsx` only renders them. The track/clip mutation queue is shared through `src/commands/trackMutation.ts`. `src/commands/singleFlight.ts` supplies one-slot guards for transcript ignore, Tighten mutations, and deliverables export. Each registrar keeps its own validation order and busy result. Project open/new retain their bespoke guards because they return success while busy and New holds its guard through a retry window. Tests reset the shared guards through the registration facade.

Pointer handlers use `runPointerCommand(id, args)` from `src/commands/pointer.ts`.
It dispatches without keyboard `when` gates and returns `void`.
Use `executePointerCommand(id, args)` when a pointer handler needs to await a
result or clear busy state after completion. It returns the command's original
`ExecuteResult` promise, including rejections. Both helpers share one gate policy.
`CommandButton` and `useCommand` retain their configurable gate policy.
The keymap listener evaluates keyboard gates before dispatch. DAW WebMCP play
returns the original `execute` result through its agent adapter. The `play_pause`
reply is `{ status: "ok" }` on success, `{ status: "disabled", reason }` on refusal,
or `{ status: "unknown" }` when the command is unavailable. Disabled replies
preserve command metadata such as `announced`, and command errors reject the
tool promise unchanged. DAW transport seeking uses
`src/commands/seek.ts`, which returns the pointer command result for callers
that need to await it. Listen skip math stays in `src/stage/frame/listenSeek.ts`;
timeline callers keep their selection and blade actions after the seek
dispatch, and WebMCP awaits the shared helper.
`commands/governance.test.ts` rejects inline `skipWhen: true` outside the pointer
helper, keymap listener, and WebMCP adapter.

## Testing

Run GUI browser tests through `npm run test:e2e` or `npm run test:e2e:compat`.
The wrapper owns private registry and identity files under its cleanup manifest.
Direct Playwright GUI startup without that manifest is refused.
`make ux-demo-screens` copies the existing showcase project and seeds guest shares
through the same launcher and registry. It leaves caller fixture and token files
unchanged. `UX_DEMO_SCREENS_DIR` can place generated PNGs outside the UX assets.

<table>
<thead>
<tr>
<th>Kind</th>
<th>Where</th>
<th>Notes</th>
</tr>
</thead>
<tbody><tr>
<td>Unit</td>
<td><code>src/**/*.test.ts</code></td>
<td>Pure utils, session dedupe, share mode, theme init/resolution</td>
</tr>
<tr>
<td>Component + a11y</td>
<td><code>src/**/*.test.tsx</code></td>
<td>React Testing Library + Deque <code>axe-core</code> via <code>expectNoA11yViolations</code></td>
</tr>
<tr>
<td>E2E smoke + a11y</td>
<td><code>e2e/*.spec.ts</code></td>
<td>Playwright + <code>@axe-core/playwright</code> via shared <code>expectPageAxeClean</code> (dense DAW) or <code>expectReadingSurfaceAxeClean</code> (Home / marketing HTML; required for green CI). Timeline helpers: <code>e2e/timelineZoom.ts</code> (<code>zoomTimelineIn</code>: focus the timeline, then bounded <code>=</code> presses; the first press must widen the ruler, optional scroll-range threshold or zoom ceiling) and <code>e2e/scroll.ts</code> (<code>scrollTimelineBy</code>). Layout cells (viewport, orientation, root text size) get one theme and motion setting each from <code>withAppearance</code> in <code>e2e/theme.ts</code>, never the cross-product; a new loop over a theme, motion or text-size list fails <code>e2e/gridBoundary.test.ts</code> unless it is the subject of the check (<a href="../../docs/testing.md#appearance-grids">docs/testing.md § Appearance grids</a>).</td>
</tr>
<tr>
<td>Browser compatibility</td>
<td><code>e2e-compat/*.spec.ts</code></td>
<td>Cross-browser matrix for playback progress and stable Pause, IndexedDB comment queue persistence and command-identity replay, document update delivery after WebSocket reconnect, phone layout, synthetic-media recording consent, deep-zoom geometry at the 15 M px content ceiling (<code>e2e/deepZoom.ts</code>; <code>e2e/deepZoom.test.ts</code> validates the stretched fixture with the episode schema and malformed clip/envelope values), and a core-flow walk on both engines (<code>e2e-compat/core-flow.spec.ts</code>: keeper capture → upload → landing with a non-silent peak, transcript hydrate and word correct/undo, Tighten empty state, viewer-share MP3 proxy playback, host Bounce (WebKit full-page axe with the dialog open) to a non-silent WAV; #704 turned WebKit on, via <code>e2e/keeperContexts.ts</code>&#39;s <code>RECORDER_CONTEXT</code> microphone grant and <code>keeperContextSource</code>&#39;s <code>launchPersistentContext(&quot;&quot;)</code> for WebKit&#39;s OPFS gap); runs Chromium and Playwright WebKit with one retry in CI and zero locally. Shared helpers: <code>e2e/queuedComment.ts</code> (comment route interception and host posting), <code>e2e/recordRoom.ts</code> (record rooms, E2E flag, record links, <code>openHostRecordRoom</code>, <code>ensureHostRecordCommand</code>, <code>clickHostTransport</code>, <code>landParticipant</code>, <code>joinAsGuest</code>, <code>fillGuestDisplayName</code>, <code>joinAsProducer</code>, <code>fillDisplayNameField</code>), <code>e2e/keeperContexts.ts</code> (<code>RECORDER_CONTEXT</code>, <code>keeperContextSource</code>), <code>e2e/keeperOpfs.ts</code> (keeper OPFS inspection), <code>e2e/wavPeak.ts</code> (landed and bounced WAV peaks), <code>e2e/playback.ts</code> (<code>expectPlaybackAdvancesThenHolds</code>), <code>e2e/transcriptEdit.ts</code> (<code>openScript</code>, <code>withDocumentCommandTypes</code>), <code>e2e/exportFiles.ts</code> (<code>bouncedWavs</code>), <code>e2e/launchOptions.ts</code> (<code>withLaunchArgs</code> on top of the base launch options; <code>CHROMIUM_FAKE_MEDIA_ARGS</code>, the fake-media flags shared by the compat Chromium projects and the main suite&#39;s record specs), <code>e2e/shareNavigation.ts</code> (<code>createReviewShare</code> for guest review shares), <code>e2e/syntheticMicrophone.ts</code> (oscillator mic stub) and <code>e2e/scroll.ts</code> (<code>scrollToEnd</code>, re-applied until the end is reachable; <code>scrollTimelineBy</code>, a clamped relative scroll). Set <code>E2E_BRANDED_CHROME=1</code> locally to also use installed Chrome. Per-engine results (Chromium, WebKit, Firefox) and what stays manual (Apple Safari and Private Browsing, native microphone prompts, hardware capture): <a href="../../docs/testing-ci.md#browser-acceptance-matrix">docs/testing.md § Browser acceptance matrix</a>, guarded by <code>tests/test_browser_acceptance_matrix.py</code>.</td>
</tr>
<tr>
<td>Static a11y</td>
<td>oxlint <code>jsx-a11y</code></td>
<td>Interaction + media rules are <strong>errors</strong> — fix the markup; do not add lint suppressions</td>
</tr>
<tr>
<td>TS hygiene</td>
<td>oxlint + <code>oxlint-tsgolint</code> (see <code>.oxlintrc.json</code>)</td>
<td>No explicit <code>any</code> / <code>@ts-*</code> escapes; <code>===</code>; <code>const</code>; no <code>var</code>; no <code>console</code> in <code>src/</code> (allowed in <code>scripts/</code>); no <code>alert</code> / <code>confirm</code> / <code>prompt</code> anywhere (<code>no-alert</code>, no per-file exceptions: ask with <code>feedback/ask</code> instead); type-aware promise + stringification hygiene (<code>options.typeAware</code>)</td>
</tr>
<tr>
<td>Models import path</td>
<td>oxlint <code>no-restricted-imports</code></td>
<td>Code outside <code>src/models/</code> (and tests, stories, <code>src/test/</code>) imports the controller, hooks and rows from <code>models</code>, never from a file inside it</td>
</tr>
<tr>
<td>Theme tokens</td>
<td>Stylelint + pytest</td>
<td>Color, padding, margin, gap, font-size, radius outside <code>src/styles/theme/</code> must use <code>var(--…)</code>; the five timeline partials also require <code>--z-*</code> roles for positive z-index values. Hex only in theme files. Chrome rem (<code>meowtec/no-px</code>); canvas <code>px</code> needs <code>-- user-approved:</code>. Inline JS styles and Python-authored CSS colors: <code>tests/test_css_policy.py</code></td>
</tr>
<tr>
<td>Motion</td>
<td>Stylelint + pytest</td>
<td>In partials, <code>transition*</code> / <code>animation*</code> time with <code>--motion-*</code> tokens, never a literal <code>ms</code>/<code>s</code> (<code>declaration-property-unit-disallowed-list</code>; stop motion with <code>none</code>); <code>tests/test_css_policy.py</code> also requires every one, loops included, inside <code>@media (prefers-reduced-motion: no-preference)</code></td>
</tr>
<tr>
<td><code>!important</code> / <code>@layer</code> / viewport <code>@media</code></td>
<td>Stylelint + pytest</td>
<td>Default-off; allowed only with <code>stylelint-disable</code> + <code>-- user-approved:</code>. <code>tests/test_css_policy.py</code> does <strong>not</strong> strip comments. <code>font-size: 62.5%</code> is a hard ban</td>
</tr>
<tr>
<td>Format</td>
<td>Biome</td>
<td><code>format:check</code> in CI; commit hook runs lint-staged (<code>biome check --write</code> on staged files; <code>make hooks</code>). Biome linter is off (oxlint + Stylelint own lint)</td>
</tr>
</tbody></table>


`e2e-compat/timeline-scroll-end.spec.ts` checks that short desktop lanes can
reach the horizontal end with a rem-sized classic scrollbar on Chromium and
WebKit. `e2e/scroll.ts` permits only 2 px of fractional scroll rounding.
`e2e-compat/phone-mix.spec.ts` checks phone Mix focus restoration after a
pointer opening from keyboard focus, Escape, and scrim dismissal, plus keyboard
navigation that invalidates the sheet, in Chromium and WebKit. The same core
flow retains the native mix edit and touch geometry checks.

`e2e-compat/browser-matrix.spec.ts` gives offline comment replay and socket
reconnect separate projects through `withShareableProject`, then asserts the
suite project's persisted comments are unchanged. The reachability sweep keeps
its actual clip midpoint tap and exact `Clip` assertion. Its comment-pin
selectors use `ReachScan.sizeExempt` to waive only size on the matching element.
Viewport, containment, and midpoint hit-test checks still run, and ordinary
controls retain the 44 px floor. `e2e/reachability.test.ts` checks this contract
through the real scanner callback with explicit jsdom geometry.

Keep component state, validation and mocked error recovery in Vitest. Browser
specs should protect layout/native input/media/storage/network seams or complete
user outcomes. Before pruning a browser case, name its remaining coverage owner.
See [Browser test scope and runtime](../../docs/testing.md#browser-test-scope-and-runtime)
for placement rules and the CI `playwright-reports-<name>` timing artifacts
(`main-1of4` ... `main-4of4`, `compat-chromium`, `compat-webkit`; PRs run
`compat-webkit-1of2` and `compat-webkit-2of2` instead of the two compat
engines). Each suite's live project is shared, so Playwright requires one
worker. CI shards the main suite and, on `main` and nightly, runs the full
compatibility suite once per engine on separate runners. Both suites retry a
failed test once in CI. The required `frontend-e2e` check requires every
planned suite to succeed, and PRs that change nothing GUI-facing skip the
browser suites and Vitest
([Which jobs a run needs](../../docs/testing.md#which-jobs-a-run-needs)).

Transcript word lookup and inclusive timeline ranges for clipboard, inspector, and
remote presence live in `src/utils/transcript.ts`. Ranges prefer mapped timeline
times and fall back to source times when absent; zero-length spans remain valid
for remote point selections but clipboard extraction requires a positive span.
Mix-minus sidetone uses the shared `src/utils/audio.ts` dB conversion.

Mobile transcript touch E2E should wait for an indexed word chip
(`data-transcript-word` with `data-word-index`) before measuring its box for
CDP touch events. The first unindexed chip can be a temporary turn-level
placeholder while the transcript hydrates.

The post-reload drag in `edit-boundary-precision.spec.ts` also waits for the
fixture's restored `dissatisfied` word. Detail hydration can replace a nearby
boundary mark, so this check precedes scrolling or measuring that mark.

Vitest's `node` project runs 17 explicitly listed pure edit and timeline utility
test files without DOM setup. Its `jsdom` project runs the remaining tests with
[`src/test/setup.ts`](src/test/setup.ts). Both projects inherit four worker
threads from [`vitest.config.ts`](vitest.config.ts).

`src/utils/useStableCallback.test.tsx` scans production `.ts` and `.tsx` files
and proves detection by inserting a direct call after each of the ten current
stable callback declarations in memory. The pure test helper accepts
`SourceInput` with `rel` and `text` and returns ordered `RenderCall` diagnostics
with file, one-based line and column, and callback name. Parse errors fail the
test. `src/test/stableCallbackGovernance.test.ts` contains execution-boundary
fixtures with literal diagnostics and valid deferred or shadowed uses.
Mutation discovery filters for the current hook spelling before parsing; the
separate production scan still parses and checks every production source file.

The check follows direct, unreassigned local variables initialized by the actual imported
`useStableCallback`, including import aliases and namespace imports. Babel's
typed AST and scope bindings handle lexical shadowing and TypeScript expression
wrappers, including `satisfies`. Calls during the owner's evaluation include
JSX expressions, optional calls, `.call`, `.apply`, synchronous inline IIFEs,
and React's imported `useMemo`, lazy `useState`, and `useReducer` initializers.
React default imports include the equivalent `{ default as React }` form.
Member names must be noncomputed identifiers or computed string literals.
Computed keys, class heritage, static fields, and static blocks are eager.
Creating methods, getters, or instance fields does not execute their bodies.

Parameter handling is deliberately syntactic. For synchronous inline functions,
default expressions are checked for omitted arguments, unshadowed `undefined`,
and `void` of a numeric literal. Supplied non-undefined literal arguments do not
activate those defaults. Shallow destructuring defaults are checked with empty
object or array literals, supplied directly or through a parameter default.
`useMemo` and lazy `useState` supply no arguments. A `useReducer` initializer
receives its initial argument. Dynamic arguments, spreads before the parameter,
nonempty destructuring arguments, and nested destructuring are outside this
parameter policy. There is no value evaluator or branch-reachability analysis.

The check does not enter async or generator functions, follow callback aliases,
reassignments, named helper calls, child props, or arbitrary callback APIs.
Passing the check covers these local forms only. Enforcement runs in tests and
adds no runtime guard. The executable hook and its callers remain unchanged.
The runtime suite checks stable identity, latest arguments, child layout effects,
StrictMode, a same-state render bailout, and an uncommitted Suspense transition
followed by commit.

`@babel/traverse` 7.29.8, `@babel/types` 7.29.8, and
`@types/babel__traverse` 7.28.0 are direct dev dependencies for this test helper
and its independent mutation traversal. They replace a partial custom scope
resolver and keep parser nodes typed. Production modules do not import the
policy or these test dependencies. See the [Babel traversal documentation](https://babeljs.io/docs/babel-traverse).

### Lint suppressions

Do **not** add `eslint-disable`, `oxlint-disable`, `biome-ignore`, or `stylelint-disable` without **explicit user approval**. Default is fix the code (or add a theme token). Stylelint exceptions must be `/* stylelint-disable-next-line RULE -- user-approved: reason */`. See [.agents/rules/gui-styling.md](../../.agents/rules/gui-styling.md).

### Adding an axe check

Component (Vitest):

```tsx
import { render } from "@testing-library/react";
import { expectNoA11yViolations } from "../test/a11y";
import { Button } from "./Button";

it("is axe-clean", async () => {
  const { container } = render(<Button>Save</Button>);
  await expectNoA11yViolations(container);
});
```

Full-page (Playwright): call `expectPageAxeClean(page)` from `e2e/axe.ts` after the dense DAW shell is visible. Reading surfaces (Home without `?project=`, static marketing HTML) use `expectReadingSurfaceAxeClean` so color-contrast and region stay on. Do not copy-paste `AxeBuilder` setup.

Resize tests: `stubResizeObserver()` from `src/test/resizeObserver.ts` installs the shared `FakeResizeObserver` (records `targets`, reports every watched target on `fire()`, or one with `fire(el)`, or at once on `observe()` with `{ reportOnObserve: true }`); `FakeResizeObserver.of(el)` returns the observer watching `el` or throws; do not declare a local ResizeObserver class (`ui/useResizeObserver.test.tsx` enforces this).

Store helpers for inspector/footer tests: `src/test/fixtures.ts` + `useDawStore.getState().hydrate(...)`. For typed recording models in new tests and stories, prefer `recordParticipant({ ... })` and `recordSnapshot({ ... })` from that file, overriding fields relevant to each scenario. Raw transport payloads can stay explicit.

## Theme tokens

Semantic CSS variables live under `src/styles/theme/`:

| File               | Role                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `brand-tokens.css` | Shared scale + brand `--color-*` (sync-copy from `deploy/brand/`; self-contained — see below)                                     |
| `primitives.css`   | **Primitive tier:** raw `--primitive-*` literals, theme-invariant; never `var()`, never consumed by components                    |
| `tokens.css`       | ShareCut Studio-only scales (`--space-*`, `--font-size-*`, `--motion-*`, `--z-*`), layout dimensions, and composite paint recipes |
| `theme-dark.css`   | **Semantic tier:** dark `--color-*` roles mapped onto primitives                                                                  |
| `theme-light.css`  | **Semantic tier:** light `--color-*` roles + `prefers-color-scheme` when no `data-theme`                                          |
| `../theme.css`     | Imports bundled IBM Plex fonts, brand-tokens, primitives, then the three above                                                    |

Timeline stacking roles and their layer order are documented in
[`docs/design-tokens.md`](../../docs/design-tokens.md#elevation).

Naming system (tiers, patterns, state modifiers, minting rules):
[docs/design-tokens.md](../../docs/design-tokens.md).

The timeline consumes its own `--color-timeline-*` stage roles: a dark well in
the dark theme and a light stage in the light theme (the transport strip stays
dark in both, via `theme/theme-fixed.css`). Chrome uses the five-rung semantic
surface ladder (`canvas`, `base`, `raised`, `overlay`, `sunken`, each with a
`text-on-*` partner) and named shadow levels. Press, hover, toggle, panel,
and state motion, and the three status loops, share `--motion-*` tokens and
run only when reduced motion is not requested. Playwright's `e2e/design-polish.spec.ts` checks both themes and
the reduced-motion path.

The light ladder uses a sage canvas (`#fbfdfc`), near-white pane
(`#f7f9f8`), and recessed well (`#eef1f0`); its timeline muted lane
(`#e9edeb`) has a separate semantic role. The dark palette remains warm
stone. Edit shared brand values in `deploy/brand/brand-tokens.css` and sync
its four copies; `tests/test_public_sites.py` enforces identical content.

Root switching (same CSS contract as marketing):
- `document.documentElement.dataset.theme = "light" | "dark"` overrides OS
- No `data-theme` → follow `prefers-color-scheme` on `:root:not([data-theme])`
- Preference persisted in `localStorage` key `daw_theme` via `hooks/useTheme.ts`
- The Project menu's Appearance row picks System, Light or Dark

### Adding a token

1. **Shared brand / scale:** edit `deploy/brand/brand-tokens.css`, copy to public dirs and `src/styles/theme/brand-tokens.css`.
2. **ShareCut Studio-only:** declare scales, layout dimensions, motion values, and composite paint recipes in `theme/tokens.css`. Define semantic color roles in `theme-dark.css`, `theme-light.css`, or `theme-fixed.css`. For a new **color**, add its raw value to `theme/primitives.css` (`--primitive-<family>-<step>`), then map it onto a `--color-*` semantic role in both themes using the same selectors as brand-tokens. Never put raw hex in the theme files; never consume `--primitive-*` directly from components. See [docs/design-tokens.md](../../docs/design-tokens.md).
3. Use `var(--…)` in partials / components — **never** invent one-off hex/`rgb` outside `src/styles/theme/`. Stylelint enforces this in CI.

Domain CSS is split into `@import` partials from `src/styles/daw.css`, in cascade order: `partials/base.css`, `reading.css`, `layout.css` (shell grid, tabs, track headers), `timeline.css`, `inspector.css`, `panels.css`, `bottom-sheet.css`, `command-palette.css`, `ui.css` (library atoms), `transport.css` (the fixed-dark transport strip and the phone Listen card that shares its paint), `presence.css`, `ingest.css`, `responsive.css` (shells and breakpoints), and `stage.css` (timeline lighting and row interaction depth). Keep transport paint in `transport.css` only: it must import after `ui.css` and before `responsive.css`, so phone rules still override the strip.

## Responsive shells

See [`docs/gui-mobile.md`](../../docs/gui-mobile.md). Breakpoints: phone `<768`, tablet `768–1194`, desktop `>1194` (`hooks/useViewportClass.ts`). Every viewport renders the `StageFrame` adapter over `StageFrameView` (`src/stage/frame/`): a header with the Stage bar (a bottom tab bar on a phone: Record, Prepare, Edit, Review, Deliver on `Mod+1`–`5`), the stage host, and the Player bar; tablet uses a peek `BottomSheet` inspector; desktop Edit shows Timeline, Script (`T`) and an Inspector column.

## UI library (`src/ui/`)

ShareCut Studio chrome library — see [`docs/ui-library.md`](docs/ui-library.md) for charter, command-bus bridge, and catalog. Domain folders (`inspector/`, `panels/`, `timeline/`) stay and **compose** the library.

| Export                          | Use for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                        | `default` / `primary` / `danger` / `link`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ToggleButton`                  | Toolbars / mode strips (`aria-pressed` + `.active`) — not exclusive tab panels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `CommandButton` / `useCommand`  | Pointer → `execute(commandId)` (default `skipWhen`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Menu` / `CommandMenuItem`      | Popup menus (Escape, arrows, outside click); closing returns focus to the opener unless focus already moved elsewhere (for example to a sibling menu's trigger)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Dialog` / `useDialogModal`     | Modal scrim+panel; trap + inert chrome; Escape closes the innermost layer (an open `Menu`, then an open `InlineConfirm`'s Keep, then the dialog)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `useResizeObserver`             | Resize → callback (one observer, latest callback, `enabled`); never `new ResizeObserver` inline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `BottomSheet`                   | Phone/tablet peek sheet (non-modal)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Field` / `FieldRow`            | Labeled control + hint + error; horizontal nudge row. `Field` owns the ids: its children are a function that receives `control` (`id`, `aria-describedby`, `aria-invalid`) to spread on the control, so the hint and error always reach it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `InlineError`                   | Error lines. `origin="action"` (default) is `role="alert"`, announced when the error appears. `origin="state"` is for an error kept in loaded or background state (a job, a settings load): announced politely (`role="status"`) only when it arrives while the line is mounted, so a tab switch does not repeat it; mount it unconditionally                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Toast`                         | Short-lived message with optional Undo and Dismiss; retains remaining time through hover, focus, disabled Undo and clipped presentation pauses. The app toast is `feedback/FeedbackToast` (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `LoadingScreen` / `ErrorScreen` | App boot states                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DefinitionList` / `DefItem`    | Inspector `<dl>` rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `InspectorSeekFooter`           | Seek + play-around footers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `LevelMeter`                    | Peak input meter (dBFS zones, peak hold, latching clip LED); drive it with `record/useInputPeakDb`. Concurrent input meters share one reference-counted metering `AudioContext` and one rAF scheduler; an individual processor stops when its meter leaves, and a failed frame reader is logged and removed without freezing other meters. The keeper capture graph retains its fixed-rate context. The silent AudioWorklet graph inspects every mic render block, including while the tab is hidden. Routine reports hold the latest level for at least two eight-block report intervals at the context's sample rate. Clip clear uses an audio-clock frame cutoff and worklet acknowledgement: a hot sample processed at or after that cutoff re-latches even if the clear command arrives later. The cutoff represents the AudioContext clock observed by the UI, not exact physical click time. The worklet is emitted as a file for CSP-compatible loading, and `audio/usePeakMeter.ts` handles visible level and peak hold. |
| `TrackPlaybackMeter`            | Track-output sample peaks during local and guest proxy playback, using `LevelMeter`. Clip lights persist across transport stops until cleared. Silent host monitors preserve premix audio; proxy taps follow the track gain. Missing monitor media and premix-only guest fallback readings are unavailable. Reduced motion freezes bars and peak markers while retaining clip detection. Sampling stops when playback stops.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ClipLed`                       | Clip indicator LED shared by `LevelMeter` and the REC indicator; sample peak only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The command palette lists a catalog command only when `paletteRunnable` is not
`false`. Mark commands that need arguments or a timeline/transcript target as
non-runnable there. This flag controls palette visibility, not command
permissions. Contextual controls perform their actions through their own
gesture or API paths; argument-taking commands can still run through the
command bus with the required input. A command's `keywords` are the other
words people search for it by (file types, synonyms); add them in
`commands/catalog.ts`, not in the palette.

Each palette option's accessible name contains its full visible text in order:
command label, category while searching, shortcut, and collision note or
unavailable reason. Spaces separate these fragments. The command label stays
first, and the shortcut and note are not repeated as an accessible description.
Search keeps focus while the arrow keys move through every option, including
unavailable commands; Enter runs only an available command.

Store reads: read the DAW store only through `useDaw(selector)` (`state/useDaw.ts`, which wraps `useDawStore(useShallow(selector))`) or `useDawStore(selector)`. Use `pickDaw("projectPath", "isPlaying")` at module scope for plain field selectors. Pass literal key arguments; governance rejects computed arguments and checks literal hot-field keys against its allowlist. Use a custom `useDaw` selector for conditional projections of store values. Select exactly the values the component uses. Build derived arrays and objects outside the selector with `useMemo`; fresh nested values defeat the one-level `useShallow` comparison. Fresh top-level projections of unchanged store values keep their selected reference. The governance test fails on whole-store reads: `useDaw()` / `useDawStore()` with no selector, or an inline arrow identity selector such as `(s) => s` / `(s: DawState) => s` (also inside `useShallow(...)`). In tests, mock `useDaw` as `(sel) => sel(mockState)`.

Hot fields (`playheadSec`, `scrollLeft`, `sessionClients`, `pointerTrackId`, `splitHoverSec`) change every playhead/scroll/presence frame; only a memoized leaf may select one directly (e.g. a leaf under `stage/frame/`), and a handler that only needs the value at call time reads `useDawStore.getState()` inside the callback instead. `state/storeGovernance.test.ts`'s `HOT_FIELD_ALLOWLIST` names every file allowed to select one, each with a reason; a whole-source scan fails on any other file that does (any `s.<field>` read, or a selector that reads one off its parameter under any name or destructures it, nested patterns included: an arrow or `function` (with or without a return-type annotation) passed inline to `useDaw`/`useDawStore`/`useShallow`, or a hoisted one whose parameter's type names `DawState`; brackets inside strings, template literals and comments are ignored). See `docs/gui-integration.md` § Render isolation for the full leaf list, the per-lane overlay slices (`timeline/laneOverlaySlices.ts`), and `document/reuseUnchanged.ts`.

The DAW state is one Zustand store (`state/dawStore.ts`) composed from project, transport, presence, and UI slice creators. Cross-slice actions such as `hydrate()` and `applyAgentSession()` use one store update so subscribers see a consistent snapshot. Mounted timeline and lane elements and the fixed-playhead lead pad live in `state/timelineViewportRegistry.ts`, outside reactive state; timeline mount/unmount code registers and clears them. Keep new DOM refs out of store slices, and keep `timelineViewportWidth` as the reactive measured/estimated value. Create no other Zustand store; `state/readmeRuleGovernance.test.ts` allows `state/dawStore.ts` plus the two stores that exist today (`feedback/ask.ts`, `record/hostStore.ts`). Only `document/` and `state/projectSlice.ts` call `setProject(`; `state/setProjectGovernance.test.ts` allowlists the two calls in two other files (`inspector/useNudgeRun.ts`, `timeline/precision/precisionDrivers.ts`). Queued envelope, track metadata, track reorder and clip move edits show through the pending drafts instead: the queue begins the draft before its first await, and the writer calls `redisplayDrafts()` (`document/applyDocumentUpdate.ts`). Layer order and back edges are pinned by `test/importDirection.test.ts`. The editor reaches `record/` only through `record/index.ts` (store, wire, transport chip, helpers); `record/boundary.test.ts` fails any other import from outside `record/` (tests, stories, `test/` support and the `api/sharesRecord.ts` leaf types are exempt).

Mutations: prefer `hooks/useProjectMutation()` (`busy` / `error` / `run` / `refresh`) over local try/catch boilerplate. A file that declares its own `[error, setError] = useState` and also calls the API fails `state/readmeRuleGovernance.test.ts` unless it is one of the 13 allowlisted files.

Double-submit guards: use `hooks/useSingleFlight()` (`busy` / `run`) instead of a hand-written ref + state pair; it drops a second `run` before `busy` re-renders (used by keeper recovery actions and Pipeline **Re-time words**).

For caught values, use `utils/apiError.errorMessage(error, fallback)` when the caller has a specific fallback for non-`Error` values. Omit the fallback only when showing the string form of any thrown value is intentional.

Comments: shared `src/comments/` (`CommentCard`, `CommentCompose`, `useCommentActions`).

Feedback: `src/feedback/`. `announceStatus(message, { undo })` speaks in the shell's live region and shows the same string in `FeedbackToast`. Pass `{ toast: false }` only when a persistent control already shows the status (the job chip, presence avatars). For Undo, pass the history entry the command's own reply names (`replyHistoryHead(reply)`, or `historyHead` from `approveEdits` / `rejectEdits`); the toast shows Undo while that entry is the tab's `history.head_id`, runs `history.undo` with it as the expected head, and drops Undo once anything else moves history. While this tab's own edit is saving the Undo stays pressable and the toast says "Undo ready after save" (`Toast` `undoNote`); a press is held by `commands/undoWait.ts` and runs when the save settles. If another edit landed first, the server refuses (`history_stale`) and the toast says nothing was undone ([docs/history.md § Guarded undo and redo](../../docs/history.md#guarded-undo-and-redo-expected-head)). Ask before an action with `await askConfirm({ title, message, keepLabel, actionLabel, danger })`; `AskDialog` renders the question in the shared `Dialog` (a bottom sheet on phones). Never call `window.confirm` / `alert` / `prompt`; in tests, answer with `test/ask.answerQuestions(reply)`.

## Layout constants

`utils/layout.ts` holds the default layout dims (`--ruler-height`, `--marker-lane-height`, lane height). At runtime `TimelineView` measures the stage and provides the live lane and marker-lane heights through `timeline/timelineMetrics.ts` (`useTimelineMetrics`), and sets `--lane-height` / `--marker-lane-height` on `.timeline-area`; overlays and headers read the context, never the constants. Presence `lane_pos` stays in lane units so viewers with different lane heights agree.

The Wordbar (`transcript/TranscriptWordbar.tsx`) edits exact source-word timing through the document command bus. It uses native range/number controls, the shared waveform with an explicit local viewport, and an owned source-preview descriptor consumed by the existing audio transport. Draft pointer movement does not publish session state or write document commands.

## GUI surface verification

The [full GUI audit](../../docs/gui-surface-audit.md) separates source, catalog
and live-route coverage. `e2e/gui-surfaces.spec.ts` checks responsive panels,
long content and modal/menu keyboard behavior with contrast enabled. Recording
room and upload/recovery states are available in Storybook as prop-driven
examples. Run browser wrappers sequentially with fixture/environment unit tests
so their shared workspace-marker lifecycle does not overlap.

The live `e2e/edit-boundary-archive.spec.ts` regression cuts a disposable episode, drags the resulting transcript boundary, verifies the restored word after reload, and exercises undo/redo. Run `npm run test:e2e -- e2e/edit-boundary-archive.spec.ts` after `VITE_SHARECUT_E2E=1 npm run build`.

### Profile editor responsiveness

Part of #879. Build the production frontend with `npm run build`, then use the
[large-project browser profile](../../docs/testing-e2e.md#large-project-browser-profile-opt-in)
recipe with a fresh generated project for each repetition. Set `DAW_PROFILE_OUT`
to retain `report.json` and a separate diagnostic `chrome-trace.json`. Keep the
`large-project.spec.ts` filter, disable retries, and use `--trace=off` for primary
repetitions. The separate Chrome trace covers a diagnostic action.

The report separates driver wall time, page-local rAF intervals, long tasks,
individual CDP duration counters, and post-GC heap checkpoints. It records
measurement availability, actual served asset hashes, environment, input labels,
and actual prebuilt waveform content identity. Native zoom, horizontal wheel
scroll, and ruler click retain visible outcomes; other scrolling is explicitly
programmatic. Synthetic progress remains not run because its real bar stayed
zero-height after ordinary panel resizing; no width-transition result is claimed.
Failed actions retain partial evidence and still fail the test. Traced diagnostic samples and primary samples have different phases.
Read the testing guide before comparing runs. These measurements have no timing
CI threshold and make no physical-device, audio-quality, or speedup claim.

Compact inspector feedback uses one body scroller below pinned chrome.
`BottomSheet.bodyHeader` is the first body child, and the feedback portal moves
there without replacing its card. `FeedbackToast` observes actual intersection;
`Toast` owns the remaining visible lifetime. Compact native focus uses the same
label-aware reveal helper and removes nested inspector overflow. Floating
feedback retains its existing dock and command authority.
