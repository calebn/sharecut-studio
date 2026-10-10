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
- 2026-10-06 owner, relayed by the coordinator: Editor links edit volume envelopes as the host does; Commenter and Viewer links cannot
- #1051 phone test, round 3: pinch also moved a clip edge, dense clusters were guesswork, and the inspector covered the timeline
- #1051 owner asked for one input framework "so the input language becomes familiar"
- #1051 round 1: candidate A (fan-out chooser) chosen; the offset loupe and hold-to-zoom cannot separate targets at one time position
- #1051 round 4a phone test (2026-10-06): pinch never edits, collapse is remembered, hold-to-repeat and soft stops work
- #1051 round 4b fix (2026-10-07): the first 4b cut made the clip body a create-menu surface, so touch clip moves were lost; the coordinator restored them under the approved grammar, since a clip body drags in time
- #1051 owner phone test (2026-10-07): the crossfade grip "still drags at once, without a long press"
- #1181 round 8 live proof (2026-10-07): at 844x390 a long press in empty space opened the create menu under the finger, and lifting without moving saved Add chapter; a first finger on a chooser chip or the crossfade rail did not count toward a pinch
- #1181 round 9 live proof (2026-10-08): the create menu clipped its last item with no scroll at large text and a short screen, and could sit over the finger; the peek strip covered the rail's Undo, and a tap meant for it nudged a pending edit; the blade confirmation's Cut sat under the tab bar at 844x390; a finger on the drawer did not count toward the two-finger rule
- #1181 round 10 audit (2026-10-08): a held strip nudge saved when a second finger landed, and a long press near an unselected clip's ends opened the create menu instead of arming the clip
- #1051 owner phone test (2026-10-07, round 5): a long press past the last clip still started iOS text selection; the drawer "follows the finger but feels laggy", and the owner asked for a flick to open or close it
- 2026-10-07 owner, relayed by the coordinator: the grammar is the rule, so it is on by default and the touch chooser lab is retired
enforced-by:
- gui/web/src/timeline/gestureGovernance.test.ts::keeps touch-specific handling in the router
- gui/web/src/timeline/gestureGovernance.test.ts::puts every pointerdown handler on an element the router can see
- gui/web/src/timeline/gestureGovernance.test.ts::routes arrow-key edits through the focused-handle commands
- gui/web/src/timeline/inputContract.conformance.test.ts::one finger moving never edits it
- gui/web/src/timeline/inputContract.conformance.test.ts::drags on touch only once a long press arms it, selected or not
- gui/web/src/timeline/JoinEditor.test.tsx::a long press arms the grip, which then drags and saves on lift
- gui/web/src/timeline/inputContract.conformance.test.ts::has a reachable touch path: an element that marks it owns the drag
- gui/web/src/timeline/inputContract.conformance.test.ts::starts no drag on a plain surface, where a long-press opens the create menu
- gui/web/src/timeline/ClipBlock.test.tsx::arms the body on a long press and moves the clip in time only
- gui/web/src/timeline/inputContract.manifest.test.ts::lists, for each command, exactly the touch gestures the grammar derives
- gui/web/src/timeline/hitRouting.grammar.test.ts::holds an armed drag at a soft boundary, then follows a push past it
- gui/web/src/timeline/hitRouting.grammar.test.ts::closes, with the selection put back, when a second finger lands
- gui/web/src/timeline/hitRouting.grammar.test.ts::picks nothing when the finger lifts without moving onto an item, whatever is under it
- gui/web/src/timeline/hitRouting.fingers.test.ts::cancels the armed target and puts the selection back, so the chip's lift saves nothing
- gui/web/src/timeline/hitRouting.fingers.test.ts::rolls an armed grip back when a second finger lands on the lanes
- gui/web/src/timeline/CreateMenu.test.tsx::says Blade cut cuts the selected tracks, not the held lane, and sets it apart from the lane's entry
- gui/web/src/timeline/chooserLayout.test.ts::falls back to the viewport when the timeline box is shorter than the menu, below the finger rather than over it
- gui/web/src/timeline/chooserLayout.test.ts::never covers the finger, in any geometry that has a free side
- gui/web/src/timeline/CreateMenu.test.tsx::measures the menu's natural height, not the height its own cap leaves, so a menu the cap clips scrolls
- gui/web/src/timeline/hitRouting.fingers.test.ts::counts as a first finger: a second finger's long press arms nothing and its lift saves nothing
- gui/web/e2e-compat/touch-grammar.spec.ts::the create menu reaches every item and stays off the finger at every text size and screen height
- gui/web/e2e-compat/touch-grammar.spec.ts::a create menu taller than 90% of the screen, with room beside the finger, is not cut to 90%
- gui/web/src/inspector/InspectorPeek.test.tsx::rolls a held run back, saving nothing, when the router cancels it for a second finger
- gui/web/src/timeline/hitRouting.grammar.test.ts::arms from its body near an end whose trim and fade targets are click-through, as on an unselected clip
- gui/web/src/timeline/hitCandidates.test.ts::is still the one candidate when every target in reach is out of reach
- gui/web/e2e-compat/compact-history-persistence.spec.ts::compact history ${name} root${rootPx} ${theme}
- gui/web/e2e-compat/compact-form-scroll.spec.ts::scrolled fades and pinned actions retain pointer and keyboard ownership
- gui/web/e2e-compat/touch-chrome-reach.spec.ts::the Cut button of the blade confirmation can be tapped at 32px text: landscape
- gui/web/e2e-compat/touch-grammar.spec.ts::in a short viewport the create menu stays in view off the finger, and lifting without moving saves nothing
- gui/web/src/timeline/ClipBlock.test.tsx::stops a held arrow at a soft boundary with a bump and a note (#1115)
- gui/web/src/ui/BottomSheet.test.tsx::opens fully on a quick flick and lands a slow drag at the nearest detent
- gui/web/src/ui/BottomSheet.test.tsx::follows the finger by transform, a frame at a time, with no render
- gui/web/src/ui/drawerMotion.test.ts::sends a quick flick all the way, however short the drag
- tests/test_guest_document_gate.py::test_an_editor_edits_volume_envelopes_and_other_roles_cannot
- make capabilities-check
supersedes: D-sheet-no-drag
-->

The owner tested the timeline on a phone and approved one input grammar for
all timeline editing. Portrait phone is the primary target.

- One finger moving scrolls and never edits.
- A tap selects and opens the peek strip. On a crowded spot it picks the most
  likely target.
- A long press arms a target, through the fan-out chooser when the spot is
  crowded. Only an armed target drags, and only along its own axes: an
  envelope point moves in time and level, an edge moves in time, and a clip
  body moves its clip in time.
- A long press on empty space opens a create menu: envelope point, split,
  marker, comment.
- A second finger means pinch or pan. It cancels and rolls back any
  uncommitted single-finger action, so a pinch never edits.
- Nudges in the strip repeat while held.

Hard limits always stop a change: source bounds, a fade longer than its clip,
envelope points passing each other in time, and a clip moving before the
session start. Soft boundaries are neighbour
clip edges, adjacent pending edges, markers and the playhead. A held nudge
stops at one with a visible, accessible bump, and a fresh press crosses it. A
drag pauses briefly at a soft boundary. The bottom strip is a swipeable drawer
with peek, half and full heights, and it keeps its buttons. Editor links edit
envelopes on the timeline as the host does (the owner confirmed it on
2026-10-06); Commenter and Viewer links see them view-only. This grammar
replaces the #951 deferral of global gesture changes below.

The checks (#1096) live with the code:
- **One contract.** `HIT_KINDS` in `gui/web/src/timeline/inputContract.ts`
  is the typed table of each target kind's axes, whether a long press arms
  it, its strip nudge rows, whether soft boundaries apply, its keys, its
  catalog command, the kinds it outranks and whether it is a body (a clip
  body, which counts only when nothing else is in reach). The router, the
  chooser, the strip, the keys and the tests read it.
- **Generated conformance.** `inputContract.conformance.test.ts` runs every
  kind in the table through a tap, a long press, an armed drag, a second
  finger, its strip rows, its soft boundaries and its keys. It also scans the
  timeline's components: every kind with an axis must be marked on an element
  that owns its drag, so it has a reachable touch path, and no drag may sit
  behind a plain surface, where a long press opens the create menu instead.
- **One router.** `gestureGovernance.test.ts` fails when a `timeline/`
  component adds its own touch handling, puts a pointerdown handler on an
  element the router cannot see, or handles arrow keys outside the
  focused-handle commands. It found the social clip markers unrouted; they
  are now the `social-clip` kind.
- **A touch column.** `surfaces.touch` in
  `contracts/capabilities.manifest.json` names the gestures that run each
  command. `make capabilities-check` keeps its vocabulary equal to
  `TOUCH_GESTURES`, and `inputContract.manifest.test.ts` derives each
  command's column from the grammar (the create menu, the kinds' commands
  and the Gestures sheet).

### Decision: A plain grab at a join rolls it

<!-- decision
id: D-join-grab-rolls
status: accepted
date: 2026-10-07
decided-by: calebn
evidence:
- #1135 reproduction: on the 4a branch the 8 px trim strip covers the 24 px roll seam, the resolver ranked the strip nearest, and a grab at a join ripple-trimmed the right clip's head; on main the same grab rolls the join
- Coordinator default, roll as on main with ripple trims through the chooser, which the owner approved: a grab at a join rolls the join
enforced-by:
- gui/web/src/timeline/inputContract.conformance.test.ts::takes a plain mouse grab though the other is nearer
- gui/web/src/timeline/inputContract.conformance.test.ts::leaves the other in the chooser for a long press
- gui/web/e2e-compat/touch-grammar.spec.ts::#1135: a plain mouse grab at a join rolls it, as on main
-->

`HIT_KINDS.roll.outranks` names the trim strips, so the resolver puts the
roll first wherever both are in reach, however near the strip is. The grabbed
edge moves, the neighbour's edge follows, and nothing later shifts. A touch
long press at a join still opens the chooser, which offers each side's ripple
trim. A touch trim drag commits like a mouse one: a ripple over another
speaker's speech saves nothing and opens `CutSpeechDialog` (a bottom sheet on
a phone), and Leave a gap resends it in gap mode
(`e2e-compat/touch-grammar.spec.ts`, #1154).

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
buttons. Round 4b ships the drawer on the compact inspector; other sheets
still resize only through their buttons.

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
| BottomSheet: `ui/BottomSheet.tsx` | **Only the compact inspector's drawer drags and flicks** (its header, round 4b); every other sheet has no drag gesture. Expand/Collapse and Close are visible single-pointer actions on all of them | Controlled `expanded` updates half/full view state only (peek/half/full for the #1051 compact inspector, which also stows during a timeline drag). There is no command/failure/History path for resize. Close and Escape dismiss; the interactive inspector scrim never takes a touch, and it is clear at the strip and dims the timeline at half and full; confirmation scrim dismisses. Shell CSS keeps phone nav and tablet chrome clear. | **Remove inert grip; retain and enlarge the resize button.** `BottomSheet.test.tsx` and new touch E2E exercise the existing callback and layout. No global button changes. |
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
(lane seek, envelope lane, wide pending region, and the body of a clip that
cannot move) carry `HIT_SURFACE_PROPS`. A movable clip's body is the `clip`
kind, a body that counts only when no other target is in reach (round 4b).

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

## Touch target chooser (#1051)

Candidate A from the #1051 research. It started behind a `touchChooser` lab
flag; the owner made the grammar the rule on 2026-10-07, so it is on for every
browser and the lab, its View › Labs entry and its `?lab=` link are gone.

Every touch on a timeline target or surface, selected or not, goes to a press
layer (`timeline/useTouchPress.ts`, React
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
- **No drag on contact.** A selected target takes no touch at once either:
  a finger moving on it starts no drag, and only a long press arms it
  (round 4b). Unselected targets let the finger scroll
  (`touch-action: pan-x pan-y`).
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
  closing tap's click is swallowed. That ghost-click window only covers the
  finger that just lifted: the next press anywhere clears it, so a tap on a
  dialog the drag opened (the cut-speech question) clicks at once.

The whole timeline scroller (headers, ruler, marker lane, lanes, the pads
past either end and the well under the last lane) sets `user-select: none`
and `-webkit-touch-callout: none`, so a held or sliding finger starts no text
selection or iOS callout over the timeline.
On the phone's fixed-playhead timeline each lane's surface reaches across the
pads (`::before` / `::after` on `.lane-seek`), so a long-press past the last
clip opens that lane's create menu at the session's end, and one before 0 at
0. The owner's phone test found that spot selecting text when the rule sat on
the lanes alone.

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

Open question for physical testing: whether the platform hold (500 ms) feels
slow for the chooser and the rest-to-grab. The scroll-first rule replaced
select-on-press for every timeline touch, so a touch dragged across a clip no
longer selects it on the way (the #1051 round-two repro on `main`).

### Drag from a chip (#1051 round 3)

On a phone, picking a target and then dragging it meant two gestures, with
the inspector in the way of the second. A finger on a chip
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
trim, roll, pending edges, chapters and the crossfade end, `xy` for envelope points, and `none`
for joins and pending split flags, which only take taps. A move runs along `x`
when it is at least twice as wide as it is tall (within about 27° of
horizontal). An off-axis move past the slop disarms the chip. Resting
`LONG_PRESS_MS` on a chip still grabs, whatever the axis. No drag magnifier
exists yet, so a grab from a chip has none.

### Compact inspector (#1051 round 3)

A timeline selection on a phone-sized screen opens a peek
strip instead of the half sheet. Phone-sized means the phone shell in
Timeline mode, or the tablet shell on a screen at most 40rem tall (a phone
held sideways). Taller tablets and desktop keep their inspector.
`layout/useCompactInspector.ts` decides this for both shells.

- **The strip.** `BottomSheet` gains a `peek` size: a content-height strip
  with the target's name in the header, then its key value
  (`inspector/peekTarget.ts`), for example "Fade in" and "300 ms", or a trim's
  source time. A clip's fade or trim adds four nudge buttons of at least
  `--touch-min` at the keyboard's steps (1 and 10 ms; 0.01 and 0.1 s,
  `edit/clipHandleSteps.ts`). Round 4 adds nudge rows for pending edits and
  envelope points, hold-to-repeat, and one save per run; see
  [Strip nudges](#strip-nudges-and-hold-to-repeat-1051-round-4). Chapters
  show their value without nudges; their fields stay in the full inspector.
- **Expand and Collapse.** One tap on Expand opens the full inspector, one
  tap on Collapse returns to the strip. Both stay visible buttons beside the
  drawer swipe of round 4b. The last choice opens the next selection
  (`compactInspectorView`, persisted per browser at
  `sharecut.compactInspector`). Expanded, the sheet is at most half its slot
  and leaves room for the transport, ruler, marker lane and one coarse lane.
  A selection the open plain sheet's own form makes, such as a point saved
  from a track's envelope form, stays in that sheet until it closes, so the
  form keeps its layout and focus instead of turning into the strip. Only the
  inspector's own forms count (`selectFromInspector`, compared by identity in
  `inspectorSelection`): a tap on the timeline while a track's sheet is open
  opens the strip, as always, and ends the hold. At large text, on a phone
  held sideways, the leave-room share of the slot can shrink to nothing (1 px
  at a 32 px root font), so half never takes less than 9rem of its slot (the
  header's 4.3rem plus a few lines of the inspector) or all of a slot that
  small; half and full then share a height and Expand, Collapse and Close stay
  on screen. The drawer's scroll padding equals its pinned header, so Tab
  focus lands below it; WebKit does not scroll a partly covered field into
  view, so the sheet also scrolls it clear on focus (`revealBelowChrome`).
- **No dim at the strip.** The strip leaves the timeline undimmed (a clear,
  touch-transparent scrim, `bottom-sheet-scrim--clear`), since its job is to
  show the selection instead of covering the timeline. Half and full dim it
  with the sheet scrim, still without taking a touch. This is a default; the
  owner may choose the dim back at the strip (drop the class in
  `BottomSheet.tsx`).
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
and the pinch (touch events, `timelineZoomGestures.ts`) owns the gesture. No
click comes of it either: a finger that lifts before the other is not a tap.
An open chooser closes. Mouse and pen pointers are not affected.

A target that cannot take the press (click-through, hidden or under other
chrome) is dropped before the router decides whether a clip body stands
alone (`rankHitTargets`' `reachable` test), so the unselected clip's
invisible trim and fade targets never hide its body from a long press near
its ends.

`e2e-compat/touch-pinch.spec.ts` puts one finger on a fade corner, a trim
handle or a clip body, drags it, lands a second finger and spreads both:
Chromium with two real CDP touch points, WebKit (no touch input in
Playwright) with touch-typed pointer events plus the touch events a pinch
fires. On the round 3 build the same cases saved `TrimClipEdge`, `MoveClips`
or `RollClipJoin`; now they send no document command, the saved clip is
unchanged, the selection is what it was, and the zoom grows by about 2.3×
(portrait and sideways).

### Decision: Undo and Redo stay in the compact inspector header

<!-- decision
id: D-compact-inspector-history
status: accepted
date: 2026-10-09
decided-by: calebn
evidence:
- #1205: at 844x390 with 32 px text, a tap on the rail Undo hit the envelope nudge and saved an unintended edit
- #1205 design synthesis: the same history controls move into the compact header while lane space returns
enforced-by:
- gui/web/e2e-compat/compact-history-persistence.spec.ts::compact history ${name} root${rootPx} ${theme}
- gui/web/e2e-compat/compact-form-scroll.spec.ts::scrolled fades and pinned actions retain pointer and keyboard ownership
-->

The strip covers the tool rail again. Its header keeps the shared Undo and
Redo controls visible at peek, half and full height. The rail and header use
one authorization check, one unavailable-action message and the existing
`history.undo` / `history.redo` command bus path, including its wait for this
tab's edit saves and refusal when one is still saving. History controls stay
at least 44 CSS pixels square and do not overlap the resize or Close controls.

The blade confirmation is a `fit` sheet, as tall as its question and its
actions and no taller, with Cancel and Cut pinned to the bottom of its scroll
area. On a phone held sideways its slot lies above the bottom tabs, and the
half height it had left Cut scrolled out of a 49 px body, under the tab bar.

### Collapse stays in reach (#1051 round 4)

With the inspector expanded on a phone held sideways, picking another target
opened it expanded (as asked) and revealed its first field by scrolling the
sheet, which carried Collapse and Close out of view above the timeline. The
owner's Collapse never reached the button, so the next selection still opened
expanded. The compact sheet's chrome (name, Expand or Collapse, Close) is now
pinned at the top of the sheet's single scroller, and `ui/focusAndReveal.ts`
reveals a field below pinned chrome rather than under it. The compact header keeps the strip's vertical spacing at every detent, so its
wrapped actions leave room for enlarged fade fields on a short screen. Native
focus also reveals the complete field label when it fits below that header.
The sheet still has one scroll owner. `e2e-compat/touch-peek.spec.ts` taps Expand and Collapse
with a finger at 360×800 and 844×390 and checks that the finger lands on the
button; the sideways case failed on the round 3 build.

### The strip over shell rows (#1051 round 4)

Sideways, the status row (where the Pipeline chip sits) floated over the
strip and moved as the page scrolled. iOS rubber-bands the page when a scroll
reaches an edge: in-flow rows move while the fixed sheet stays, and the
status and nav rows (`--z-shell-chrome`) drew over the sheet
(`--z-sheet`). Two changes:

- The editor no longer scrolls as a page: `html[data-shell]` and its body
  set `overscroll-behavior: none`, and the timeline scroller sets `contain`.
- The compact sheet's root stacks at `--z-sheet-docked`, above the shell rows,
  and clips its own slot, so neither the row draws over the strip nor the
  strip's slide (entering, stowing) over the row.

`e2e-compat/touch-strip-stacking.spec.ts` moves the shell as a bounce does
and freezes the stow slide halfway, in Chromium and WebKit at 360×800 and
844×390. On the round 3 build the row covered the strip's bottom edge.

### Strip nudges and hold-to-repeat (#1051 round 4)

The owner asked for the strip's nudges as "a pattern worth repeating for a
consistent visual language", and for press-and-hold to repeat them.

- **One row per value.** `inspector/InspectorPeek.tsx` draws the same row for
  every value a target has: four buttons of at least `--touch-min`, smaller
  steps inside, earlier or shorter on the left. A clip's fade (1 and 10 ms)
  or trim (0.01 and 0.1 s) has one row beside its key value. A pending edit
  gets Start and End rows (0.01 and 0.1 s of source time) and an envelope
  point gets Time (0.01 and 0.1 s) and Level (0.01 and 0.1) rows, each row
  labelled with its value. On a phone the rows stack; sideways they share a
  line. `edit/nudge.ts` holds what each field steps, its hard limits, its
  preview and its save. Envelope rows show for the host and Editor links,
  which edit envelopes as the host does (owner decision, 2026-10-06);
  Commenter and Viewer links get none.
- **Hold to repeat.** A held finger, pen or mouse steps again after the
  long-press hold (500 ms), then every 100 ms, and every 50 ms after four
  repeats (`nudgeRepeatDelayMs` in `hooks/gestureConstants.ts`, after
  Android's key-repeat timing). Release, a cancel the system sends, sliding
  off the button or blur stop it and save the run. A second finger landing
  elsewhere stops it too, but the router's cancel for it rolls the preview
  back and saves nothing, as for every other uncommitted action ([Pinch
  never edits](#pinch-never-edits-1051-round-4)). A held Enter or Space
  follows the system's own key repeat, and an assistive-technology click
  steps once.
- **One edit per run.** Each step previews in the project, so the timeline
  draws it, and the run saves once when it ends: one document command and
  one Undo (`inspector/useNudgeRun.ts`). A failed save puts the saved value
  back, and so does a ripple trim the host asks about first: it opens
  `CutSpeechDialog`, whose Cut anyway or Leave a gap sends the trim again
  ([Edit modes](daw-editing.md#edit-modes-ripple-and-gap)).
- **Boundaries.** Hard limits always stop a run: source bounds, a fade's
  room in its clip, envelope points keeping their order (1 ms apart) and the
  level's 0 to 1.5 range. Soft boundaries (`edit/nudgeBoundaries.ts`) are the
  playhead, chapter markers, and the clip and pending-edit edges on the
  target's track; a ripple trim leaves out what it carries along. A held step
  that would reach or cross one stops exactly on it: the value gets an accent
  ring and a short bump (the ring alone under reduced motion), and the live
  region says, for example, "Envelope point stopped at a clip edge", then
  "Envelope point saved at a clip edge" on release. The first step of a
  fresh press, a tap or a key press, crosses it. A trim's start has no moving
  point on the timeline (a ripple trim keeps the clip's start), so only its
  hard limits apply. An armed drag detents at the same soft boundaries
  ([round 4b](#touch-grammar-round-4b-1051), **Detents**).

`e2e-compat/touch-nudge.spec.ts` holds a finger on the strip in Chromium and
WebKit: the value moves during the hold, the run sends one `SetEnvelope`, and
one Undo restores it; a held point stops at the clip edge at 50 s and a held
pending start at the previous cut's end, and a fresh press crosses each; at
360×800 and 844×390 in both themes the pending and envelope rows have 44 px
targets in view and no axe violations.

### Touch grammar round 4b (#1051)

Round 4b builds the grammar on the 4a branch. It shipped behind the touch
chooser lab until the owner made it the default (2026-10-07).

- **Arming.** A long press (`LONG_PRESS_MS`) on one target arms it, if its
  contract gives it an axis, or selects it (a join badge, a pending split).
  Over two or more targets the chooser opens, and a chip arms its target as
  before. An armed target wears the chooser's about-to-grab halo, the screen
  reader hears "Fade in armed: drag sideways to move it, lift to finish",
  and Android gives a haptic tick. It drags along its own axes only: the
  router holds an edge's y, and an envelope point moves freely. Lifting
  commits. A touch on a selected target no longer drags at once.
- **Clip moves.** A movable clip's body is a target, the `clip` kind. With
  the finger on it and no other target in reach, a long press arms the clip
  ("Clip armed: drag sideways to move it") and the drag moves it in time
  only, in its own lane, through `edit.moveClips`. Either end of the clip
  detents at a soft boundary, so it holds where it meets a neighbour. Pressed
  against the session start, its hard limit, the clip takes the bump tint
  and "Clip is at its limit" is read out. A tap on the body still selects
  the clip, but a target in reach takes the long press.
- **Create menu.** A long press with no target in reach (an empty lane, the
  envelope layer, the body of a clip that cannot move, as in blade mode or
  on a view-only link) opens a menu above the finger (below it near the top
  of the timeline, beside it in a short viewport such as a phone held
  sideways, where the timeline's box is shorter than the menu, so it uses the
  screen), never over it, beside the fixed playhead when there is room, with a
  dashed mark at the held time on its lane. A menu taller than the screen
  caps its height and scrolls: it measures its natural height (the shared
  menu cap hid the overflow, so round 8 clipped the last item), then sits
  beside the finger at the screen's height or, where neither side has room
  for its width (large text), above or below the finger, whichever has more
  room, capped to that room. Either way a 24 px gap stays between the menu
  and the finger. Its title is the time and lane
  ("00:30.000 · Avery"). Entries: **Add envelope point** (with the level it
  adds at, on the held lane), then, below a divider, **Blade cut**, **Add
  chapter** and **Add comment**. Blade cut cuts the selected tracks, else
  every dialogue track, so it carries a line saying which ("Cuts all dialogue
  tracks", "Cuts Avery, Blair") and does not sit with the held lane's entry.
  Each runs a catalog command at the held
  time (`envelope.addPoint`, `edit.bladeCut`, `edit.addChapter` with
  `atTime`, `comment.draftAt`); an entry the link cannot run stays, disabled,
  with the command's reason beside it. Slide onto an item and lift to pick
  it, or lift anywhere and tap one. A lift that never moved past
  `TOUCH_SLOP_PX` picks nothing, whatever lies under the finger: round 8's
  live proof found that at 844x390 the menu opened under the finger and a
  lift saved Add chapter. The scrim, Escape and a second finger close it.
- **Detents.** An armed drag that reaches a soft boundary holds there until
  the finger pushes `DRAG_DETENT_PX` (16 px) past it, with a line and an
  "At the playhead" caption. The boundaries come from `softBoundaries`, the
  query held nudges use; a boundary the drag starts on does not catch it.
- **Drawer.** The compact inspector swipes between peek (the strip), half
  and full. Its covered editing rail stays inert while the drawer is visible;
  closing or stowing restores the rail without changing its layout height.
  The stowed sheet is inert until it returns, so native keys reach only the
  visible controls.
  Expand and Collapse step between detents, and the visually hidden
  "Inspector height" range does it for keys and screen readers. The owner's
  round-5 phone test found the swipe followed the finger but lagged: each
  move set a React state height, so the inspector re-rendered and laid out
  again every frame. Now the sheet fills its slot when the finger lands and
  a `translateY`, written once per animation frame, shows the part the finger
  holds up (`ui/useDrawerSwipe.ts`); nothing re-renders until the release.
  The release coasts on the finger's momentum as Apple's "Designing Fluid
  Interfaces" (WWDC 2018) describes: at a deceleration of 0.998 per ms the
  sheet would travel speed × 499 ms further, and it settles at the detent
  nearest that point (`ui/drawerMotion.ts`). Speed is read over the last
  100 ms of moves, and a finger that rested 40 ms before lifting has none,
  so a quick flick opens or closes the drawer fully and a slow drag lands
  where it was left. The settle slides over `--motion-state`; under reduced
  motion the sheet lands at once, while the drag itself still tracks the
  finger, since it is the user's own motion.
- **Second finger.** It cancels and rolls back arming, a detent drag, a clip
  move and the create menu, as it does any one-finger action. A first finger
  on a chooser chip (which sits outside the timeline's scroller) or on the
  crossfade rail counts like one on the lanes: the router treats fingers on
  chips, create items, the drawer and adopted parts as its own. Round 8
  found that a second finger landing after one on a chip armed a target and
  saved; round 9 found the same for a finger resting on the drawer, and the
  owner's rule is that two fingers never edit.
- **Touch paths.** The first 4b cut made the clip body a plain surface, so a
  long press there opened the create menu and touch clip moves were lost
  without a failing test. The conformance test now fails when a kind with an
  axis has no element that owns its drag, or when a drag sits behind a plain
  surface. The scan reads `onPointerDown` props and spread handler bags. It
  found no other kind without a touch path. The crossfade endpoint grip, in
  its own rail below the lanes, dragged at once without a long press. It is
  now the `crossfade-end` kind, and the timeline's one router adopts its rail
  (`HitRouter.adopt`, reached through `useHitRouter`), so a finger arms it
  before it drags and a second finger on the lanes rolls it back; a mouse
  drags it as before. The rail first ran a second router, whose finger count
  could not see the lanes'. The conformance test also fails when any kind with an axis drags
  on touch before a long press arms it, selected or not.
- **The crossfade rail on a phone held sideways.** Opening a crossfade join
  opens its popover, which in a 390 px tall screen covers the rail's grip
  (round 8's live proof hit the popover's icon at the grip's centre). The
  popover's Length slider is the visible, full-size equivalent of the grip, so
  there the popover owns the edit and the pinch-from-the-grip case cannot
  arise; in portrait the grip is reachable and its pinch rule is pinned live.
  A toast no longer covers the grip there either: the phone toast docks above
  an open crossfade rail as it does above the tool rail.

### Decision: Compact feedback and fields share one body scroller

<!-- decision
id: D-compact-feedback-one-scroll
status: accepted
date: 2026-10-09
decided-by: calebn
evidence:
- #1205 consolidated owner directive selects corrected Architect seat 2
- 667 by 360 with root 32 has a 256px sheet slot; full labels and long feedback cannot coexist
enforced-by:
- gui/web/src/ui/BottomSheet.test.tsx::puts supplied flow content and fields in one body below chrome
- gui/web/src/ui/Toast.test.tsx::preserves remaining time while clipped and through presentation changes
- make test-web-e2e
-->

The header stays outside the compact content scroller. Feedback and native
fields share ordinary scroll order. A saved edit preserves the focused or
just-pressed control, even when browser scroll anchoring leaves feedback
clipped. Ordinary body scroll exposes the message and actions. Field focus
reveals its full fitting native label and control. The single Toast retains its
remaining visible lifetime while clipped and through host movement. Initial
header reachability is asserted before any recovery scroll. No short-height
rule may make those header controls scroll away.

Feedback does not override half or full detent geometry. Compact controls paint
focus outlines inside their border boxes. The visually hidden detent range
keeps the grabber as its visible focus indicator. Visibility observation follows
the same feedback card through compact and floating hosts, so both presentations
pause the single remaining lifetime when the whole card is clipped.
