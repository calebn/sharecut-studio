# Touch editor decisions

The [touch input grammar](#decision-one-touch-input-grammar-for-timeline-editing)
(#1051) is the current rule for every timeline touch interaction. The original
#951 decision below records the touch affordance repair shipped
in #958, before the #950 envelope controls landed in #959. It retains the #878
interaction inventory in `docs/editor-interactions.md` and its qualified evidence.
The [#961 follow-up](#responsive-inspector-follow-up-961) records the later
inspector layout and focus repair. Neither change adds a sheet gesture owner or
alters controlled `half`/`full` state. Physical mobile and assistive-technology
acceptance for the repaired envelope workflow remains #960; named-device
profiling remains #879.

## Decision: One touch input grammar for timeline editing

<!-- decision
id: D-touch-input-grammar
status: accepted
date: 2026-10-06
decided-by: calebn
evidence:
- #1051 owner: "The input grammar is approved" and "Swipeable drawer approved"
- #1051 owner: "Envelopes for edit guests: default applied, pending owner override."
- #1051 phone test, round 3: pinch also moved a clip edge, dense clusters were guesswork, and the inspector covered the timeline
- #1051 owner asked for one input framework "so the input language becomes familiar"
- #1051 round 1: candidate A (fan-out chooser) chosen; the offset loupe and hold-to-zoom cannot separate targets at one time position
enforcement: pending #1096
supersedes: D-sheet-no-drag
-->

The owner tested the timeline on a phone and approved one input grammar for
all timeline editing. Portrait phone is the primary target.

- One finger moving scrolls and never edits.
- A tap selects and opens the peek strip. On a crowded spot it picks the most
  likely target.
- A long press arms a target, through the fan-out chooser when the spot is
  crowded. Only an armed target drags, and only along its own axes: an
  envelope point moves in time and level, an edge moves in time.
- A long press on empty space opens a create menu: envelope point, split,
  marker, comment.
- A second finger means pinch or pan. It cancels and rolls back any
  uncommitted single-finger action, so a pinch never edits.
- Nudges in the strip repeat while held.

Hard limits always stop a change: source bounds, a fade longer than its clip,
and envelope points passing each other in time. Soft boundaries are neighbour
clip edges, adjacent pending edges, markers and the playhead. A held nudge
stops at one with a visible, accessible bump, and a fresh press crosses it. A
drag pauses briefly at a soft boundary. The bottom strip is a swipeable drawer
with peek, half and full heights, and it keeps its buttons. The grammar lets
`edit` guests edit envelopes on the timeline by default; today the Studio shows
a shared project's envelopes view-only. If the owner overrides that default,
envelopes stay locked for guests. This grammar replaces the #951 deferral of
global gesture changes below.

#1096 builds the checks: a governance test that only the shared router attaches
pointer or touch listeners to timeline targets, one `HIT_KINDS` table of each
target's axes, limits and actions, generated touch conformance tests for every
kind, and a touch column in `contracts/capabilities.manifest.json` checked by
`make capabilities-check`. None of them is on `main` yet.

### Superseded decision: Sheets have no drag gesture

<!-- decision
id: D-sheet-no-drag
status: superseded
date: 2026-10-04
decided-by: calebn
evidence:
- #951, shipped in #958: remove the inert grip; Expand, Collapse and Close are the only sheet size controls
superseded-by: D-touch-input-grammar
-->

#951 removed the sheet grip that had no drag handler and left the visible
buttons as the only way to resize a sheet (the BottomSheet row below). The
grammar above replaces that rule with a swipeable drawer that keeps the
buttons. Until the drawer ships, sheets still resize only through the buttons.

## Decision: Pair each touch gesture with a visible control

<!-- decision
id: D-touch-visible-equivalents
status: accepted
date: 2026-10-04
decided-by: calebn
evidence:
- #951: "familiar gestures paired with visible controls"
- #958 and #963 (#961) shipped the repair; physical device acceptance stays in #960 and #301
- docs/gui-audit-decisions.tsv: the 2026-09-30 audit trail for edit-boundary touch drag (reflow, cancel, precision)
enforced-by:
- gui/web/src/ui/GesturesSheet.test.tsx::describes two-finger Undo as an optional Sharecut shortcut
- gui/web/src/ui/BottomSheet.test.tsx::keeps fixed sheets closable without a resize action or drag cue
- gui/web/e2e/touch-affordances.spec.ts::sheet affordances remain available at 200% text scale
- docs-sync: decision-touch-input
-->

Remove the inert BottomSheet grab element and its selector. It had no pointer
handler, while the controlled Expand/Collapse action already changes the
inspector sheet between its two supported heights. Keep those buttons, Close,
the interactive inspector background, the dismissible confirmation background,
Escape, focus restoration, and nested body scrolling. In the sheet, override
the modifier inspector's inherited percentage height with `height: auto` so its
flex layout can allocate space to the fields. Give the
resize action `min-inline-size` and `min-block-size: var(--touch-min)`. Rebalance
the remaining header with existing `--space-3` and `--space-4` tokens. Fixed
sheets without `onExpandedChange` remain fixed and show no resize affordance.

The command catalog says **"Undo the last action. Optional Sharecut shortcut."**
The inaccurate hook comment is removed. The implementation still calls
`execute("history.undo")`. The recognizer and its tests are unchanged. No help copy claims an iOS convention or a
particular visible Undo route. Source confirms More contains a History route in
`gui/web/src/layout/MobileShell.tsx`; help copy does not depend on it.
Apple's [iPhone Undo and redo guide](https://support.apple.com/en-au/guide/iphone/iph1a9cae52c/ios)
documents the three-finger text editing gesture. That system convention does
not establish Sharecut's separate two-finger shortcut.

Exact seek remains outside this patch. `layout/TransportTimecode.tsx` uses
`ui/Timecode.tsx` for the text readout. `commands/seek.ts` dispatches existing
seek commands. Arbitrary timestamp entry remains a precision candidate for
follow-up.

## Surface decisions and interaction contracts

The inventory uses the same fields for every surface: owner, input, visible
equivalent, initiation, preview, commit, cancellation, failure, History,
permission, and responsive behavior. "Existing" means the current implementation
or named test owns that behavior; it does not certify unrun combinations.

| Surface and owner | Gesture and visible equivalent | Initiation, preview, commit, cancel, failure, History, permission, responsive contract | Decision and evidence |
|---|---|---|---|
| Timeline navigation: `timelineZoomGestures.ts`, `TimelineView` | One-finger pan and pinch zoom; visible zoom controls and Fit | Timeline gesture handlers own navigation and focal zoom. Pan/zoom are view changes, not document commits; no document History. Existing navigation is shared by shell role policy. Phone keeps fixed-center playhead; tablet/desktop retain their timeline layout. | **Keep.** #878 documents tested bounds and known residual combinations. No global gesture rewrite. |
| Ruler seek and comment-span draft: `TimeRulerView.tsx`, `commentAnchorSession.ts`, comment composer | Tap ruler to seek; visible time/playhead; comment span can be drafted by dragging | Tap seeks immediately. Comment-mode pointer capture previews an anchor draft; a span must reach 4 CSS pixels (`COMMENT_SPAN_MIN_PX`) at the current zoom to get an end time. Pointer cancel, capture loss, unmount, or leaving comment mode calls `cancelDrag`; project/comment-state invalidation is owned by `beginCommentAnchorSession`. Accepted release finishes the local draft. Explicit comment submission persists it. The existing comment composer owns submission failure and permission feedback; no new History entry occurs until comment creation. No new sheet or seek input. | **Keep.** `TimeRulerView.tsx`, `commentAnchorSession.ts`, and `ruler-recovery.spec.ts` identify these paths; #878 evidence covers only its named cases. Arbitrary exact seek remains an open precision gap, while ruler tap is an existing single-pointer navigation path. |
| Select range: `useRangeGesture.ts`, `EditingToolRail` | Armed range drag; visible Select range mode, In/Out, lane controls and action card | Explicitly arm before drag. Draft is local until Cut/Mute/Comment/Bounce. Existing Cancel/Escape and permission paths own cancellation/failure; one accepted document operation uses existing History. Phone/tablet rail and numeric controls remain. | **Keep and clarify armed state through existing UI.** `contextual-range.spec.ts` covers exact targets and policy; phone dispatched events are synthetic as recorded in #878. |
| Clip move: `ClipBlockView.tsx`, clip move owner | Drag visible clip body/grip; click selects and modifier click extends selection | Owner previews destination before `MoveClips`; accepted changed release commits once; Escape, capture loss, blur, unmount cancel. Existing command permission and Undo apply. Touch movement competes with scrolling and remains an open single-pointer alternative gap. | **Keep current behavior; gap stays open.** `ClipBlock.test.tsx`, `edit/clipMove.test.ts`, and `inventory-audit.spec.ts` are the cited coverage. Exact 7/27-second persistence remained failed in the #878 record. |
| Trim, fade, roll and crossfade: clip handles, join controls, inspector | Drag visible edge/seam; native numeric/range fields and keyboard nudges | Local preview follows the active owner. Accepted changes use existing commands; Escape/cancel does not save. Save failures stay in current inspector error routes; accepted edits use document History. Touch and dense-target behavior vary by timeline width. | **Keep.** `fade-curves.spec.ts`, `crossfade-length.spec.ts`, `transitions-acceptance.spec.ts`, and `edit-boundary-precision.spec.ts` retain existing evidence. Do not add another gesture system. |
| Pending range, chapter, social markers: `MarkerLane`, pending inspector | Drag eligible visible handles/body; inspector numeric timing and Edit timing | Draft remains local before the existing command. Escape, lost ownership, blur, and unmount cancel owned previews. Host/guest permissions remain at current command boundaries; accepted edits are undoable. Phone dense pending handles can give way to Edit timing. | **Keep.** `pending-edge-controls.spec.ts`, `MarkerLane.test.tsx`, and #878 inventory cover named paths; not every interruption combination. |
| Join endpoint / transition length: join badge and inspector | Select join; numeric transition length | Endpoint row is separated from neighboring actions. Numeric field is the exact visible equivalent; preview/save/failure follow current inspector command. Existing History applies to accepted edit. | **Keep.** `transitions-acceptance.spec.ts` checks saved bounds and Undo. Do not add rotate or hidden pinch. |
| Envelope points and creation: envelope overlay / #950 inspector | Existing point editing; creation is missing | Point selection/edit behavior remains in #950's ownership. Its future edit contract must define preview, apply/cancel, save failure, permission, History and narrow responsive behavior at that boundary. | **Keep point editing; route creation to #950.** This patch touches none of the #950-owned files or claims. |
| Desktop/tablet editor splitter: `BottomTabsSplitterView.tsx` | Drag separator; Arrow keys, Home/End, Enter reset | Existing separator owns preview and Escape cancellation; accepted view sizing may persist its preference but creates no document History. It remains a desktop/tablet surface with a 10 CSS-pixel measured pointer strip in #878. | **Keep; touch comfort gap stays open.** `splitter-recovery.spec.ts` is current cancellation evidence. This #951 patch does not widen or relabel it. |
| Track order and gutter: `RelatedCommands`, track reorder controller | Existing Move up/down buttons; reorder grip drag remains available where permitted | Move up/down are single-pointer buttons that invoke current track-order commands; command permission and Undo paths remain authoritative. If a selection has no related or overflow command, `RelatedCommands` renders no empty command region. The reorder grip owns drag preview/drop. No new gutter drag ownership, auto-scroll, or selection model. | **Keep Move up/down as the non-drag route and keep the reorder grip.** Source confirms the alternate action already exists; task-path comparison between the buttons and drag remains open. |
| Mix: `MixSheet`, native controls, `useCommitRange` | Native volume range and M/S controls; More → Mix | Volume follows the existing preview/commit lifecycle and permission reason; M/S and local/shared listening distinctions remain. Accepted host/editor volume writes use the existing document command. Sheet layout supports row scrolling and text wrapping. | **Keep.** Do not add swipe-to-mix. Existing `phone-mix.spec.ts` covers its current path; failure/cancel combinations not asserted there remain unverified. |
| Transcript words: transcript views and correction flow | Tap seeks; double tap or long press opens correction; visible Correct/Select modes | First tap seeks immediately. Correction opens only for a host with hydrated words; current sheet lifecycle restores mode on close. Submission uses `submitWordCorrection`; failure/permission behavior stays there. Phone uses the sheet for keyboard room; desktop has its current inline path. | **Keep.** `transcript-wordbar.spec.ts` and `edit-boundary-touch.spec.ts` are retained evidence. No delayed tap-to-seek recognizer. |
| Comment rows: comment list/controller | Swipe left resolves; visible Resolve/Reopen and Undo toast | Only enabled for eligible open host comments in the list. Preview reveals a cue; threshold release uses `comment.resolve`; vertical movement, cancel, or hold restores the row. Existing command failures and latest-only Undo toast remain. Embedded threads do not opt in. | **Keep.** Existing comment recovery browser coverage includes Chromium/WebKit phone; physical device verification remains pending. |
| BottomSheet: `ui/BottomSheet.tsx` | **No drag gesture.** Expand/Collapse and Close are visible single-pointer actions | Controlled `expanded` updates half/full view state only (peek/half for the #1051 compact inspector, which also stows during a timeline drag). There is no preview/cancel/command/failure/History path for resize. Close and Escape dismiss; interactive inspector scrim stays transparent; confirmation scrim dismisses. Shell CSS keeps phone nav and tablet chrome clear. | **Remove inert grip; retain and enlarge the resize button.** `BottomSheet.test.tsx` and new touch E2E exercise the existing callback and layout. No global button changes. |
| Transport, Gestures help and History: `MobileShell` More hub, command catalog | Two-finger tap is an optional Sharecut Undo shortcut; visible command routes remain | Existing recognizer dispatches `history.undo` and reports failure through the shared status path. It runs only when enabled by current project/command availability. It does not make a platform convention or modal-body guarantee. Phone More lists History and Gestures. | **Modify attribution only.** `useTwoFingerTap.test.tsx` stays unchanged; `GesturesSheet.test.tsx` asserts the rendered optional Sharecut copy. |

## Explicit disposition

- **Keep:** current timeline navigation and anchored zoom, ruler tap seek, range
  mode, clip/edge editing, join endpoint controls, track action buttons, native
  Mix controls, transcript correction routes, comment resolve/reopen and visible
  sheet sizing buttons.
- **Modify:** remove only the nonfunctional sheet grip; give the existing
  Expand/Collapse header action a sheet-scoped 44 CSS-pixel minimum; wrap the title within its column and let the sheet inspector use automatic
  height for nested scrolling; rebalance header padding with current spacing
  tokens; correct the two-finger Undo
  attribution.
- **Remove:** `.bottom-sheet-grab` markup and its unused style selector.
- **Defer:** chrome drag resize, exact seek, a general input library, global
  gesture changes, and all #950 envelope creation work.

The inventory does not claim keyboard operation alone meets WCAG 2.5.7. Existing
visible actions are credited only where the same operation has a single-pointer
non-drag path. Clip movement and desktop/tablet splitter resizing remain open
gaps. Track order already has Move up/down buttons; how well those buttons and
drag support the task is an open comparison. Ruler tap supports navigation, but
arbitrary exact timestamp entry remains a separate precision gap. See the
[W3C dragging movements criterion](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements).

## Task paths for the remaining comparison

Use the same project, role, starting selection, viewport, and target values for
both routes. Count deliberate activations and record saved accuracy, unintended
commands, cancellation recovery, and Undo recovery separately. These paths
identify the comparison to run. They are not measured efficiency results.

| Task | Routes to compare | Observable result and remaining evidence |
|---|---|---|
| Seek | Ruler tap versus existing navigation/seek controls | Playhead error against a specified target time; playback must stay stopped. Arbitrary timestamp entry is absent. Comparative precision and activation counts are open. |
| Range cut | Arm Select range and drag versus visible In/Out and lane controls, then Cut | Saved cut bounds and affected tracks; cancel saves nothing and one Undo restores the cut. Comparative counts and recovery are open. |
| Trim/fade | Select clip and drag the handle versus inspector timing/value controls | Saved boundary or fade value against the same target; cancellation and rejected delivery must not save. Existing browser recovery cases are retained; comparative counts and precision are open. |
| Envelope edit | Use the final landed #950 creation/edit controls versus its supported point gesture | Saved point identity, time/value, permission, and Undo behavior. This route waits for #950's final contract; no competing implementation is defined here. |
| Reorder | Select track and use Move up/down versus the existing reorder grip | Identical final track order, canceled drop, and Undo restoration. Both routes exist; comparative counts and recovery are open. |
| Mix adjustment | More, Mix, then native volume range versus any future precise field/stepper | Saved gain and local-listening distinctions by role. Current host/viewer/edit-guest regression evidence exists; comparative precision and Mix-specific failure-thumb behavior are open. |
| Comment resolve/Undo | Visible Resolve and Undo versus enabled swipe-left and Undo | Same comment becomes resolved and then reopens; accidental resolve, vertical-scroll conflict, and recovery counts remain open for comparison. |

Sheet sizing retains one visible button activation per size change. Removing
the inactive grip does not reduce that action count. The measured change is the
resize target size and the removal of an affordance with no drag behavior.

## Acceptance status

Status is scoped to this patch. "Existing evidence" points to the current #878
inventory or named source/tests; it does not imply every profile was run here.

| #951 acceptance row | Status |
|---|---|
| Reconcile each surface with owner, input, visible equivalent, threshold, preview, commit, cancel, failure, History, permission and responsive behavior | **Documented here** from source and test references. Residual controller/profile combinations remain open. |
| Correct the false iOS Undo attribution and keep the shortcut optional | **Implemented; focused Vitest passed** for rendered catalog wording. Recognizer tests remain unchanged. |
| Resolve sheet grip mismatch with a bounded decision | **Implemented and verified.** Controlled unit/axe coverage and 17 Chromium browser cases plus 2 Chromium/WebKit compatibility cases passed. |
| Every drag has a single-pointer non-drag equivalent; keyboard alone does not count | **Partly existing, partly open.** Visible sheet buttons, numeric/step controls, and track Move up/down remain. Clip move and desktop/tablet splitter resizing remain open gaps; exact seek remains an input precision gap. Track task comparison is open. |
| Keyboard operation, visible focus, labels, values, errors and roles | **Scoped checks passed.** Component/recognizer/mobile-shell tests cover keyboard and focus; browser sheet cases restore focus after Close and Escape. Mix browser cases cover host/viewer/edit-guest restrictions. VoiceOver/TalkBack and global profile coverage remain pending. |
| Scroll, seek, selection and editing do not collide; pointer transitions are safe | **Existing limited evidence** in source and #878. Uncovered intersections remain open; this patch adds no recognizer. |
| Cancel/unmount/background/rotation/failure leave no stuck gesture; history cardinality is correct | **Scoped browser recovery passed** for native fade cancel, 403/422/409 rejection, abort/replay and Undo. Sheet actions send no document commands and leave project bytes and preferences unchanged. Mix-specific cancel/failure-thumb behavior, rotation, backgrounding and other interruption combinations remain open. |
| 360 portrait, short landscape, tablet, desktop, themes, reduced motion and 200% text | **Automated cases passed** for 360×800, 667×360, 820×1180 and 1440×900, both themes and motion preferences. The 200% case doubles computed root font size and proves title/control geometry and expanded-body scrolling. This is CSS emulation; native keyboard, safe-area, OS text scaling and physical reflow remain pending #301. |
| Native browser zoom/Back and normal nested scrolling remain available | **Nested scrolling verified** with browser mouse-wheel input while the sheet stays expanded at 200% root text size. Native zoom/Back and physical scroll behavior remain open; this patch adds no gesture listener or touch-action override. |
| Define task paths for seek, range, trim/fade, envelope, reorder, Mix and comment resolve/Undo | **Comparison paths defined** above. Named-task activation count, precision and recovery comparison remains open. Sheet sizing keeps one button activation per size change; no efficiency improvement is claimed. |
| #879 named-device response/frame/long-task profiles | **External pending.** No performance budget or improvement is claimed. |
| Browser regressions exercise initiation, intermediate state, saved state and recovery | **Real-app browser cases passed** for sheet initiation, half/full geometry, dismissal, focus restoration, nested scrolling, project bytes, storage and document commands. The wheel check is browser mouse input. Existing mobile cases use CDP touch or synthetic events as documented; neither is physical hardware evidence. Other editor-controller combinations remain open. |
| Physical iOS Safari, Android Chrome, stylus, trackpad, OS gestures and assistive tech | **External pending #301.** Browser automation is not hardware evidence. |
| Gesture library comparison and independent adoption review | **Research recorded below.** No dependency adopted; runtime adapter spike remains required before future adoption. |

## Measured browser result

At 360×800 with the normal 16px root font, Expand measured 54.67×25.59 CSS
pixels on main at `8d9226f9a`. The patch gives it a 44 CSS-pixel minimum block
size and retains the same sheet sizing commands. At doubled root font size,
the resize action and Close measure 88 CSS pixels high. The title wraps rather
than painting over the resize action.

The frozen main build had a zero-height clip field region even after expansion
at doubled root font size. The sheet-only height override gives the expanded
region a 45 CSS-pixel viewport for 898 CSS pixels of content. The regression
proves its wheel scroll offset advances. This is a narrow viewport, so the
result establishes access through scrolling, not physical-device usability.
The half sheet remains a compact preview; Expand exposes the field scroller.
Before/after screenshots, geometry and original failures are retained in the
run's local audit. The browser helper attaches the same observations to its
Playwright report for CI review.

## Gesture-library source review

The primary-source review compared native Pointer Events, `@use-gesture/react`,
Motion for React and dnd-kit. The [Pointer Events specification](https://www.w3.org/TR/pointerevents3/)
defines pointer capture and cancellation contracts. Apple's guide above
documents a three-finger text-editing undo gesture. The official
[@use-gesture docs](https://use-gesture.netlify.app/docs/gestures/) describe
pan/pinch recognition; its [options](https://use-gesture.netlify.app/docs/options/)
cover threshold and axis behavior. Its [React package manifest](https://github.com/pmndrs/use-gesture/blob/main/packages/react/package.json)
declares MIT and React `>=16.8`, which is not a runtime compatibility test for
this repository. Official [Motion gesture docs](https://motion.dev/docs/react-gestures)
cover hover, tap, pan, drag, focus, and in-view animation; the overview does not
document a first-class pinch recognizer. The [dnd-kit React quickstart](https://dndkit.com/react/quickstart/)
covers `DragDropProvider` integration for draggable, droppable, and sortable
content. Those are source-document comparisons; neither package owns Sharecut
command, permission, history, or stale-update behavior.

No package was installed. No bundle delta, runtime compatibility, maintenance
advantage, responsiveness, or performance improvement is claimed. A future
representative native-versus-`@use-gesture/react` adapter spike must measure
bundle delta, actual responsiveness, Strict Mode listener cleanup, compatibility,
license, and maintenance before adoption.

### Proposed decision: Native pointer events with platform constants for the timeline

<!-- decision
id: D-timeline-native-pointer-events
status: proposed
date: 2026-10-06
decided-by: calebn
evidence:
- #1078 owner, after the #1051 phone test: "are we not using a library for these gestures?"
- #1078 React Aria prototype: +6,923 B gzip, no pointer code removed, router grew from 503 to 571 lines
- #1078: the library could not express movement slop, second-finger cancel, sliding onto a chip, or tap on release
-->

The leading option is native Pointer Events with shared platform constants
for timeline gestures: the UIKit 10 pt slop and 0.5 s long press, and the
Android 8 dp slop and 400 to 500 ms long press. A library may still suit
ordinary buttons. No gesture package is adopted until #1078 concludes.

## Responsive inspector follow-up #961

The current-main baseline retained the #958 fixes and reproduced the remaining
track-entry, clipping, and offscreen-focus failures. The [#961 evidence
record](https://github.com/calebn/sharecut-studio/pull/963#issuecomment-5998148488) preserves selected pixels and receipt geometry.
Historical center hit-testing is not full-control visibility.

Independent designs and a cross-review chose one scroll owner for inspector
sheets, including chrome and all modifier content, with natural-height fields.
The shared modifier styles also put desktop fields and errors in natural flow;
the desktop inspector aside owns their scrolling. The retained inner-scrollport
alternative adds two positions to coordinate and
cannot guarantee a complete enlarged field group in short landscape. Focus
reveal stays inside the current sheet or desktop inspector. Track identity and
clear-clip entry need disjoint regions sized through the common lane geometry.
The existing interactive background, controlled Expand/Collapse, modal policy,
permission and envelope commit/cancel contracts remain the boundaries. Physical
mobile and assistive-technology acceptance remains #960.

## Shared hit resolver (#1051)

Dense timeline targets no longer compete by CSS z-index and DOM order. Each
small target marks itself with `hitTargetProps` (`timeline/hitTargets.ts`):
envelope points, fade corners, trim strips, roll seams, join badges, pending
edit edges and split flags, and chapter markers. Plain hit areas behind them
(clip body, lane seek, envelope lane, wide pending region) carry
`HIT_SURFACE_PROPS`.

The resolver's data shape is `HitCandidate` in `timeline/hitCandidates.ts`:
`{kind, id, x, y, distance, priority, selected}`, in viewport pixels. A touch
reaches every target whose box is within 22 px (`TOUCH_HIT_RADIUS_PX`); mouse
and pen reach only the boxes under the pointer. Candidates rank selected
first, then by distance to the target's core (a square's centre, a thin
strip's centre line), then by the kind priority in `HIT_KINDS`.

`attachHitRouting` (`timeline/hitRouting.ts`) listens for `pointerdown` at the
document in the capture phase. When the press lands on a marked target and
two or more targets are in reach, it stops the original event and replays an
identical press on the winner, so the winner's own capture, drag, commit,
cancel and History paths run unchanged. The browser's following click is
replaced with a click on the winner. One target in reach, or a press on a
surface, passes through untouched.

## Touch target chooser prototype (#1051, lab)

Candidate A from the #1051 research ships as a prototype behind the
`touchChooser` lab flag. It is off by default. Turn it on from View › Labs ›
Touch target chooser (the phone Menu carries the same View sections) or by
opening the app with `?lab=touch-chooser`; `?lab=-touch-chooser` turns it
off. The choice persists per browser in `localStorage` (`sharecut.labs`,
`utils/labFlags.ts`) and is not project state.

With the lab on, every touch on a timeline target or surface that is not
already selected goes to a press layer (`timeline/useTouchPress.ts`, React
Aria's `usePress` and `useLongPress`), and no target sees it until the layer
decides. Timing comes from `hooks/gestureConstants.ts`: a 500 ms long press
and a 10 px slop, after the iOS and Android long-press defaults it cites.

- **Scroll.** A finger that moves is a pan. The browser scrolls, the press
  ends without a tap, and no target is selected, opened or edited. A tap or
  hold whose finger slid past the slop is dropped even where the timeline has
  no room left to scroll.
- **Tap.** Lifting within the slop before the long press taps the resolver's
  winner, or the surface itself when the finger is on no target. A quick tap on
  a crowded spot picks the obvious target and never opens the chooser.
- **Select first, then drag.** A selected target under the finger (a selected
  clip's fade, trim and roll handles, a selected envelope point or pending
  edit's edges) takes the touch at once and drags, as before. Unselected
  targets let the finger scroll (`touch-action: pan-x pan-y`).
- **Hold still.** After the long press, two or more targets in reach open the
  chooser (`timeline/TargetChooser.tsx`); one target, or a surface, is grabbed
  and the drag continues on it, and released in place it is a slow tap. Chips
  of `--touch-min` fan out on an arc 64 px above the finger, below it when
  there is no room above, and swing away from side edges
  (`timeline/chooserLayout.ts`). Chips and caption stay inside the timeline's
  visible box, clear of the transport bar, tabs and sheets. Each chip draws its
  target's glyph at twice its size on the clip colour under it, with a leader
  line and ring at the real position. Chips read left to right by real x; more
  than five page through "More". One caption names the chip under the finger,
  else the focused chip, else the best-ranked one; envelope chips also show
  their gain.
- **Commit.** Lifting on a chip replays a tap on its target at the target's own
  position and focuses it. A chip under the held finger shows it is about to
  grab: an accent ring closes in on it over the long press (shown at once
  under reduced motion), and the caption names what the finger can do there,
  "Slide sideways to drag · lift to select" for a time-only target. A slide
  along the target's drag axis grabs it at once (see
  [Drag from a chip](#drag-from-a-chip-1051-round-3)); resting the long press,
  within the slop, still grabs as a fallback. A grab replays the press on the
  target and forwards the rest of the drag offset by the chip-to-target
  distance, so the target moves without jumping to the finger. Chips take taps
  through `usePress`, so touch, mouse, keyboard and assistive-technology
  presses pick.
- **Cancel.** Lifting anywhere but a chip leaves the chips open to tap. A tap
  on the dimmed timeline, Escape, a second finger before the hold ends, or
  `pointercancel` closes the chooser or drops the hold with no change; the
  closing tap's click is swallowed.

The marker lane and lanes set `user-select: none` and
`-webkit-touch-callout: none` with the lab on or off, so a held or sliding
finger starts no text selection or iOS callout over the timeline.

The chooser is a `role="menu"` of `menuitemradio` chips (checked marks the
currently selected target, with an accent edge and corner notch). It announces
"N targets here", moves with Left/Right/Home/End, and Escape returns focus.
`ui/useMenuKeyboard.ts` owns that keyboard and focus contract for every popup
menu, so the chooser adds no keydown listener.

Motion follows the repo's motion rules rather than the research spec's exact
times: chips fly out from the finger on `--motion-hover` (150 ms; the spec
asked for 160 ms) and the chooser fades out on `--motion-press` (80 ms; the
spec asked for 100 ms). Under reduced motion the chips appear in place with no
animation, because reduced motion may only stop motion here; the spec's 100 ms
fade in place is not used.

Open questions for physical testing: whether the platform hold (500 ms) feels
slow for the chooser and the rest-to-grab, and whether the lab's
scroll-first rule should replace today's select-on-press for every touch.
With the lab off, a touch dragged across a clip still selects it on the way
(the #1051 round-two repro found this on `main`).

### Drag from a chip (#1051 round 3)

On a phone, picking a target and then dragging it meant two gestures, with
the inspector in the way of the second. With the lab on, a finger on a chip
can drag the target from there.

The chooser runs idle → open → over-chip → dragging or selecting. The
router (`timeline/hitRouting.ts`) owns idle, open and dragging. A pure model,
`timeline/chipGesture.ts`, decides each move of a finger that is down on the
open chips:

- **Away.** No hit chip is under the finger. Lifting leaves the chips open.
- **Over a chip, unarmed.** The finger slid onto it. Each move past
  `TOUCH_SLOP_PX` re-anchors it there, so a finger passing over chips never
  grabs one.
- **Over a chip, armed.** The finger came down on the chip (after lifting at
  the origin), or a finger that slid there has stayed within the slop for
  `CHIP_SETTLE_MS` (100 ms, Android's tap timeout). The chip shows chevrons
  pointing the ways its target moves.
- **Dragging.** An armed chip grabs on the first move past the slop that runs
  along its target's axis. The drag is measured from where the finger
  came to rest on the chip (not where it first crossed its edge), so that
  first move already moves the target.
- **Selecting.** Lifting on a chip without grabbing picks it.

Each target kind declares its drag axis in `HIT_KINDS`: `x` (time) for fade,
trim, roll, pending edges and chapters, `xy` for envelope points, and `none`
for joins and pending split flags, which only take taps. A move runs along `x`
when it is at least twice as wide as it is tall (within about 27° of
horizontal). An off-axis move past the slop disarms the chip. Resting
`LONG_PRESS_MS` on a chip still grabs, whatever the axis. No drag magnifier
exists yet, so a grab from a chip has none.

### Compact inspector (#1051 round 3)

With the lab on, a timeline selection on a phone-sized screen opens a peek
strip instead of the half sheet. Phone-sized means the phone shell in
Timeline mode, or the tablet shell on a screen at most 40rem tall (a phone
held sideways). Taller tablets and desktop keep their inspector.
`layout/useCompactInspector.ts` decides this for both shells.

- **The strip.** `BottomSheet` gains a `peek` size: a content-height strip
  with the target's name in the header, then its key value
  (`inspector/peekTarget.ts`), for example "Fade in" and "300 ms", or a trim's
  source time. A clip's fade or trim adds four nudge buttons of at least
  `--touch-min` at the keyboard's steps (1 and 10 ms; 0.01 and 0.1 s,
  `edit/clipHandleSteps.ts`). Each nudge saves at once through the same save
  the handle drag uses (`edit/clipEdgeSave.ts`). Pending edits, envelope
  points and chapters show their value without nudges; their fields stay in
  the full inspector.
- **Expand and Collapse.** One tap on Expand opens the full inspector, one
  tap on Collapse returns to the strip. Both are visible buttons; the sheet
  still has no drag gesture. The last choice opens the next selection
  (`compactInspectorView`, persisted per browser at
  `sharecut.compactInspector`). Expanded, the sheet is at most half its slot
  and leaves room for the transport, ruler, marker lane and one coarse lane.
- **Keep the selection in view.** The timeline scroller gets bottom padding as
  deep as the strip or sheet covers it, and scrolls the selected target above
  it. Sideways, the sheet takes the bottom tabs' place while it is open, so
  the timeline keeps their row.
- **Out of the way.** Any timeline drag stows the strip or sheet: it slides
  off screen, click-through but still mounted. It returns on release with the
  new value. `timeline/dragWatch.ts` reports a drag: a pointer that started in
  the timeline, is captured there (or is the router's own replay), and has
  moved `HANDLE_DRAG_MIN_PX`. A scroll never counts.

Measured in Playwright with the #1051 fixture (the same in Chromium and WebKit; a lone envelope point on lane 1), as px of timeline lanes left
visible above the inspector:

| Viewport | Round 2 sheet | Strip | Expanded |
|---|---|---|---|
| 360×800 portrait | 136 (second lane covered) | 542 | 274 |
| 390×844 portrait | 180 (second lane covered) | 586 | 296 |
| 800×360 sideways | none (timeline covered) | 125 | 107 |
| 844×390 sideways | none (timeline covered) | 155 | 107 |

### Pinch never edits (#1051 round 4)

On a phone, a pinch to zoom also moved a clip edge: the first finger had
started a trim, the second finger zoomed, and the trim saved on release. The
rule now holds for every target, in the router (`timeline/hitRouting.ts`),
not per target.

The moment a second finger lands anywhere on the timeline (ruler and headers
included), the router sends each finger's press a `pointercancel`. Every drag
owner already treats that as "drop the draft, save nothing": trims, fades,
rolls, clip moves, envelope points, pending edges, chapters, ranges, a chip
grab and a press the press layer is still deciding. A press the router replayed
on another target is cancelled there too. The selection goes back to what it
was before the first finger, so a press that selected a clip on the way down
is undone. Until every finger lifts, their pointer events stop at the router,
and the pinch (touch events, `timelineZoomGestures.ts`) owns the gesture. An
open chooser closes. Mouse and pen pointers are not affected.

CDP drives two real touch points in `e2e/touch-pinch.spec.ts`: one finger
drags a fade corner, a trim handle or presses a clip body, a second lands and
both spread. On the round 3 build the same cases saved `TrimClipEdge`,
`MoveClips` or `RollClipJoin`; now they send no document command, the saved
clip is unchanged, the selection is what it was, and the zoom grows by about
2.3× (portrait and sideways, lab on; portrait, lab off).

### Collapse stays in reach (#1051 round 4)

With the inspector expanded on a phone held sideways, picking another target
opened it expanded (as asked) and revealed its first field by scrolling the
sheet, which carried Collapse and Close out of view above the timeline. The
owner's Collapse never reached the button, so the next selection still opened
expanded. The compact sheet's chrome (name, Expand or Collapse, Close) is now
pinned at the top of the sheet's single scroller, and `ui/focusAndReveal.ts`
reveals a field below pinned chrome rather than under it. The sheet still has
one scroll owner. `e2e-compat/touch-peek.spec.ts` taps Expand and Collapse
with a finger at 360×800 and 844×390 and checks that the finger lands on the
button; the sideways case failed on the round 3 build.
