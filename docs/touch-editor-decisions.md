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
profiling remains #879. The [interaction system](interaction-system.md) places
the touch grammar inside the one path every input follows and lists the
surfaces that still keep their own gesture.

## Non-drag placement and panel sizing #1033

The Clip inspector has a **Start** Scrub field and a **Track** row of toggles
(`stage/edit/clipPlacementFields.tsx`). A drag on Start drives the local
placement preview; the arrow keys and a typed value step or set it. Releasing,
Enter or a key press saves through `edit.moveClips` and the existing `MoveClips`
History operation, and Escape drops the preview. A track toggle moves the clip to
that track at the same time. There is no Apply or Cancel, and an unchanged value
sends no command. Selected clips move together through `computeClipMoves`,
including its independent zero-time and outer-lane clamps. Exact input bypasses
drag magnets.

The local owner has idle, preview, and committing phases. Its token captures the
project path, epoch, edit basis, selection, anchor, and track order. The timeline
reads its placements through a local subscription and `laneMovePreview`; preview
never patches the project or creates a document delivery draft. The preview stays
visible while the save waits for an earlier track save to finish. Invalidation,
unmount, backgrounding, permission loss, or a competing edit cancels only the
owned session. The save rechecks the capture inside the track mutation queue before
patching or delivery. Settlement cannot clear a replacement session. A refused
save preserves a current draft and inline error for correction or retry. The
server's existing concurrency policy is unchanged; this client check is not an
atomic remote revision guard. Drag, long-press arming, immediate transcript seek,
armed ranges, track Move up/down, Mix, and the fixed phone playhead keep their
existing owners.

Desktop and tablet have native **Shorter**, **Taller**, and **Reset panel size**
buttons outside the separator. Each step starts at the rendered panel height,
including when a saved preference exceeds the available space. Buttons request
a 1 rem step or the remaining distance to a bound. When passive layout changes
leave the retained preference outside fresh bounds, the next step can clamp by
more than 1 rem. Buttons, keyboard, drag clamps, and separator values share
measured panel geometry and fresh viewport policy. The desktop grid
floor comes from `--shell-main-min-height`, used by CSS and read by the view.
Banner and root-font changes refresh bounds through `useResizeObserver` without
rewriting the saved preference. Props-only stories use explicit policy bounds
and their rendered panel height, or the prop height when layout is unavailable.
A clamped no-op creates no preference; Reset clears it.
A button press during a drag cancels that drag without also stepping. Sizing
creates no project write or document History. Phone uses the Inspector sheet's grip and has no Script divider. Coarse-pointer controls have a 2.75rem target floor.

Focused Vitest coverage lives in `edit/clipPlacement.test.ts`,
`stage/edit/clipPlacementFields.test.tsx`, and the Script divider tests.
`e2e/non-drag-placement.spec.ts` defines pointer initiation, intermediate geometry,
exact 7/27-second placements and lanes, refusal/recovery, Undo, preferences, and
role/shell/appearance cells. Browser touch automation is not physical-device
proof; its receipts identify native pointer input and synthetic native-select
assistance. Real-device and human listening acceptance remains in #1695.
Editor moves retain the private guest History contract; the host can undo the
saved edit from the full project view.
Arbitrary exact timestamp seek remains a separate precision gap.

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
- #1337: the shown flat envelope line was a vertical target in the same grammar; the whole-track drag was removed with the legacy overlay (#2294 S7b W3b), and the line now only adds a point on a tap, with one-finger movement along its strip scrolling and a second finger cancelling a point's unsubmitted draft
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
- gui/web/src/timeline/inputContract.conformance.test.ts::has a reachable touch path: an element that marks it owns the drag
- gui/web/src/timeline/inputContract.conformance.test.ts::starts no drag on a plain surface, where a long-press opens the create menu
- gui/web/src/timeline/ClipBlock.test.tsx::arms the body on a long press and moves the clip in time only
- gui/web/src/timeline/inputContract.manifest.test.ts::lists, for each command, exactly the touch gestures the grammar derives
- gui/web/src/timeline/hitRouting.grammar.test.ts::holds an armed drag at a soft boundary, then follows a push past it
- gui/web/src/timeline/hitRouting.grammar.test.ts::closes, with the selection put back, when a second finger lands
- gui/web/src/timeline/hitRouting.grammar.test.ts::picks nothing when the finger lifts without moving onto an item, whatever is under it
- gui/web/src/timeline/hitRouting.fingers.test.ts::cancels the armed target and puts the selection back, so the chip's lift saves nothing
- gui/web/src/timeline/createMenuMapping.test.ts::cuts at the held time with edit.bladeCut, never at the playhead with edit.split
- gui/web/src/stages/edit/createMenuLayout.test.ts::falls back to the viewport when the box is shorter than the menu, below the point rather than over it
- gui/web/src/stages/edit/createMenuLayout.test.ts::never covers the point, in any geometry that has a free side
- gui/web/src/stages/edit/createMenuLayout.test.ts::reads the content height plus the border, not a capped height
- gui/web/src/timeline/hitRouting.fingers.test.ts::counts as a first finger: a second finger's long press arms nothing and its lift saves nothing
- gui/web/e2e-compat/touch-grammar.spec.ts::the create menu reaches every item and stays off the finger at every text size and screen height
- gui/web/e2e-compat/touch-grammar.spec.ts::a create menu taller than 90% of the screen, with room beside the finger, is not cut to 90%
- gui/web/src/timeline/hitRouting.grammar.test.ts::arms from its body near an end whose trim and fade targets are click-through, as on an unselected clip
- gui/web/src/timeline/hitCandidates.test.ts::is still the one candidate when every target in reach is out of reach
- gui/web/e2e-compat/compact-history-persistence.spec.ts::Undo and Redo stay reachable in the App header with the Inspector sheet open
- gui/web/e2e-compat/touch-grammar.spec.ts::in a short viewport the create menu stays in view off the finger, and lifting without moving saves nothing
- gui/web/src/timeline/ClipBlock.test.tsx::stops a held arrow at a soft boundary with a bump and a note (#1115)
- gui/web/src/ui/BottomSheet.test.tsx::opens fully on a quick flick and lands a slow drag at the nearest detent
- gui/web/src/ui/BottomSheet.test.tsx::follows the finger by transform, a frame at a time, with no render
- gui/web/src/ui/drawerMotion.test.ts::sends a quick flick all the way, however short the drag
- tests/test_guest_document_gate.py::test_an_editor_edits_volume_envelopes_and_other_roles_cannot
- make generated-check
supersedes: D-sheet-no-drag
-->

The owner tested the timeline on a phone and approved one input grammar for
all timeline editing. Portrait phone is the primary target.

- One finger moving scrolls and never edits.
- A tap selects. On a crowded spot it picks the most likely target.
- A long press arms a target, through the fan-out chooser when the spot is
  crowded. Only an armed target drags, and only along its own axes: an
  envelope point moves in time and level, an edge moves in time, and a clip
  body moves its clip in time.
- A long press on empty space opens a create menu: Split here, Comment here,
  Add chapter here, (host) Record here, Add volume point on a lane, and Paste
  when the clipboard has audio.
- This grammar is for touch. A mouse acts on press: it selects and drags at
  once with no arming, and a right click on a lane or target opens the same
  create menu, so desktop editing does not change by accident (#1793). The
  Menu key and Shift+F10 (`create.menu`) open it too: over the focused target,
  else at the playhead on the selected track, so a keyboard user needs no
  focusable lane or clip (#1877).
- A second finger means pinch or pan. It cancels and rolls back any
  uncommitted single-finger action, so a pinch never edits.
- The Inspector sheet has no nudge buttons (retired, #2294 yf); its Scrub fields type, drag and step with the arrow keys.

Hard limits always stop a change: source bounds, a fade longer than its clip,
envelope points passing each other in time, and a clip moving before the
session start. Soft boundaries are neighbour
clip edges, adjacent pending edges, markers and the playhead. A held keyboard
step stops at one with a visible, accessible bump, and a fresh press crosses it. A
drag pauses briefly at a soft boundary. The phone Inspector is a swipeable
sheet with dock, half and full heights. Editor links edit
envelopes on the timeline as the host does (the owner confirmed it on
2026-10-06); Commenter and Viewer links see them view-only. This grammar
replaces the #951 deferral of global gesture changes below.

The checks (#1096) live with the code:
- **One contract.** `HIT_KINDS` in `gui/web/src/timeline/inputContract.ts`
  is the typed table of each target kind's axes, whether a long press arms
  it, whether soft boundaries apply, its keys, its
  catalog command, the kinds it outranks and whether it is a body (a clip
  body, which counts only when nothing else is in reach). The router, the
  chooser, the sheet, the keys and the tests read it.
- **Generated conformance.** `inputContract.conformance.test.ts` runs every
  kind in the table through a tap, a long press, an armed drag, a second
  finger, its soft boundaries and its keys. It also scans the
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
  command. `make generated-check` keeps its vocabulary equal to
  `TOUCH_GESTURES`, and `inputContract.manifest.test.ts` derives each
  command's column from the grammar (the create menu, the kinds' commands
  and the palette's Gestures rows).

### Superseded decision: Transcript word ranges follow the touch grammar

<!-- decision
id: D-transcript-longpress-range
status: superseded
date: 2026-10-13
decided-by: calebn
evidence:
- #1029 and #1363 shipped the rule for the transcript's Select mode
- Operator approval, 2026-10-13: keep #1363's rule and record it as a decision extending the owner-approved touch grammar
superseded-by: D-script-gestures
-->

Select mode in the transcript applies the same grammar to word ranges, with no
new gesture:

- A long press on a word that moves selects a range. Hold, then drag over the
  words; the range extends under the finger and commits when it lifts.
- A long press that does not move opens word correction (host).
- A move before the hold scrolls and selects nothing.
- A second finger cancels the drag and restores the earlier selection.

The equivalents are the selection handles at both ends of the range and
Shift+Arrow (Alt+Shift+Arrow shrinks from the start), which extend or shrink it
by a word (`transcript.extendRange`). There are no step buttons.

The Script pane (`system/ScriptPane`) replaces the transcript panel's Select
mode, so the rule changes in one place: a long press that does not move no
longer opens word correction (it selects the word), and there is no Select
mode to hold. See the next decision. The legacy panel keeps its tests until
it is deleted.

### Decision: The Script pane selects by click, drag and long press

<!-- decision
id: D-script-gestures
status: accepted
date: 2026-10-28
decided-by: calebn
supersedes: D-transcript-longpress-range
evidence:
- "Operator decisions, 2026-10-28: Fix text starts only on Enter, F2 or a double-click or double-tap on a word, and typing never edits; a word selection across tracks covers the range on both tracks; in-text joins stay until the Seam inspector lands"
- "#2294 W2-gestures: the Script pane could not start a selection by mouse drag, double-click or long press"
enforced-by:
- gui/web/src/system/ScriptPane.gestures.test.tsx::selects from the pressed word across turns, previews while it runs and commits once on release
- gui/web/src/system/ScriptPane.gestures.test.tsx::a long press selects the word and a drag extends it, committing on lift
- gui/web/src/system/ScriptPane.gestures.test.tsx::a finger that moves before the hold scrolls and selects nothing
- gui/web/src/system/ScriptPane.gestures.test.tsx::a second finger cancels the drag and leaves the earlier selection
- gui/web/src/system/ScriptPane.gestures.test.tsx::typing never edits: letters on a selected word reach the keymap untouched
- gui/web/e2e-storybook/script-gestures.spec.ts::on a phone a swipe scrolls the pane and selects nothing
- gui/web/e2e-storybook/script-gestures.spec.ts::on a phone a long press selects the word and a drag extends it without scrolling, then the grips show
- gui/web/e2e-storybook/script-gestures.spec.ts::on a phone a finger that drifts 8 px before the hold still drags the selection out, and the pane does not scroll
- gui/web/src/system/ScriptPane.gestures.test.tsx::a finger that drifts before the hold keeps the drag when Chrome moves its capture from the word to the body
- gui/web/src/system/ScriptPane.gestures.test.tsx::never carries the swallow over: a click that arrives later with no pointerdown selects
- docs-sync: decision-touch-input
-->

The Script pane has no modes, so one grammar covers mouse, touch and keys
(design-system element 14):

- A click or tap selects the word at once and seeks. It never waits for a
  second click.
- A mouse or pen drag from a word selects to the word under the pointer,
  across turns. A pill or a suggested run in the way is taken whole.
  Shift-click and Shift-drag extend from the selection's anchor.
- A triple-click on a word selects its sentence. A double-tap on a word (touch
  or pen), and Enter or F2 on a selected word, start Fix text. Typing never does: every letter stays a shortcut.
- On touch, a long press selects the word and shows the 44 px grips; moving
  on from the hold extends it under the finger, and it commits when the
  finger lifts. A finger that moves before the hold scrolls and selects
  nothing. A second finger cancels the drag and keeps the earlier selection.
- Esc, a cancelled or lost pointer, a window blur, pagehide or a hidden tab
  ends a drag without committing it. Leaving the pane does not: the pane holds the pointer, so the
  drag goes on selecting to the nearest word and commits on release.
- The browser's own text selection is off in the pane; the pane's copy event
  copies the selected words.

Changed from the rule above: a hold that does not move selects the word
instead of opening word correction, because Fix text now has its own gestures.
A finger may drift a few pixels, inside the 10 px slop, before the hold arms
without losing the drag.

### Superseded decision: A plain grab at a join rolls it

<!-- decision
id: D-join-grab-rolls
status: superseded
date: 2026-10-07
decided-by: calebn
evidence:
- #1135 reproduction: on the 4a branch the 8 px trim strip covers the 24 px roll seam, the resolver ranked the strip nearest, and a grab at a join ripple-trimmed the right clip's head; on main the same grab rolls the join
- Coordinator default, roll as on main with ripple trims through the chooser, which the owner approved: a grab at a join rolls the join
superseded-by: D-seam-diamond-rolls
-->

A roll strip on each clip's start outranked the trim strips, so a plain grab
at a join rolled it. The Seam diamond replaced that strip (see the next
decision), which leaves the trim strips as the only handles on a clip edge.

### Proposed decision: The Seam diamond rolls its seam

<!-- decision
id: D-seam-diamond-rolls
status: proposed
date: 2026-11-10
decided-by: calebn
evidence:
- docs/design/stages/spec-edit.md INT-JOIN and INT-ROLL: "Drag a Seam diamond left or right to roll the seam; Alt fine; readout chip"
- #2294 (C3b): one Seam object on the timeline, so the clip-edge roll strip, the join glyph and the applied tick are gone
enforced-by:
- gui/web/src/system/Seam.test.tsx::rolls with the drag at the timeline's pixels per second and saves once on release
- gui/web/src/system/Seam.test.tsx::a held Alt arrow rolls once, not once per key repeat
- gui/web/src/timeline/SeamLayer.test.tsx::previews a drag on the lane's clips and saves one roll through the sheet's command on release
- gui/web/src/timeline/SeamLayer.test.tsx::registers as the roll hit target of its right clip for touch
- gui/web/src/timeline/SeamLayer.test.tsx::takes no roll from an unarmed touch drag and rolls once the long press has armed it
- gui/web/src/commands/seamRoll.test.ts::does not save a roll when its partners change during boundary loading
supersedes: D-join-grab-rolls
-->

The diamond is the one roll target (`HIT_KINDS.roll`, command
`edit.rollClipJoin`). A mouse drag on it, or a touch long press and then a
drag, previews the roll on both clips and the diamond, shows the ms readout,
and saves one roll on release through `rollSeam`, the command the Seam
sheet's Offset field uses. Alt drags at a twelfth and a half of the pace (a
tenth of a millisecond at the finest), Escape drops the roll, and Alt with an
arrow key rolls 1 ms. A press that does not move selects the seam. A one-finger
touch drag on an unarmed diamond rolls nothing: the diamond refuses a touch
press the hit router has not replayed after its long press. The clip-edge roll
handle is gone, so the keyboard and the sheet cover it: each diamond is a tab
stop that rolls 1 ms with Alt and an arrow key, and the sheet's Offset field
rolls by any amount. A touch long press on a clip edge still offers each side's ripple trim in the
chooser, and a trim strip is a trim handle only.

### Superseded decision: Edit chips zoom, join glyphs act, applied ticks stay inert

<!-- decision
id: D-edit-chip-zooms
status: superseded
date: 2026-10-22
decided-by: calebn
evidence:
- #2076: every edit type stays visible at any zoom, and joins that crowd each other fold into a count
- WCAG 2.5.8 Target Size (Minimum), the Equivalent exception: the 12 px glyph is under the 24 px target and its hit box is 24 px wide but only as tall as the gutter, so the same function (a join's mode and length) is also offered by the inspector's Join control at full size
superseded-by: D-seam-diamond
-->

A join glyph per seam and a count chip for crowded joins were replaced by the
Seam diamond. The join type no longer shows on the timeline; it lives in the
Seam action bar. Applied cuts are diamonds too, so the inert applied tick for
a cut is gone and only mute edges keep a tick.

### Proposed decision: Every seam is a Seam diamond on the lane's top edge

<!-- decision
id: D-seam-diamond
status: proposed
date: 2026-11-10
decided-by: calebn
evidence:
- docs/design/stages/spec-edit.md INT-JOIN and the Seam element: "6 px diamond on the lane's top edge (filled = cut, hollow = split)"
- #2294 (C3b): the join glyph, the edit chip and the applied seam tick are one object now
- WCAG 2.5.8 Target Size (Minimum), the Equivalent exception: the diamond's button is 24 px wide and as tall as the 12 px gutter under a fine pointer, and 44 px square under a coarse pointer; the Seam sheet is the full-size equivalent for selecting and rolling a seam
enforced-by:
- gui/web/src/timeline/SeamLayer.test.tsx::draws a hollow diamond per touching pair at the seam's time
- gui/web/src/timeline/TrackLane.test.tsx::draws a filled diamond where a cut left the clips touching
- gui/web/src/timeline/timelineStyles.test.ts::draws seam marks at the top of the seam, above the clips
- gui/web/src/timeline/AppliedEditOverlay.test.tsx::draws no tick for a cut, which is a Seam diamond
- gui/web/src/timeline/hitRouting.grammar.test.ts::stays a seek in the lane above, where the mark's box would reach
- gui/web/src/timeline/hitRouting.grammar.test.ts::opens the Seam from the browser's click when a finger lands 20 px beside it
- gui/web/src/timeline/hitRouting.grammar.test.ts::keeps a fade corner under the diamond's box grabbable at the clip top
- gui/web/src/timeline/hitRouting.grammar.test.ts::resolves the midpoint between two seams 12 px apart to exactly one of them
supersedes: D-edit-chip-zooms
-->

The "Join" and "Edit group" entries of the touch chooser are gone with the
glyph and the count chip: the join type is chosen in the Seam action bar and
sheet. Every pair of touching clips, and every pair a cut separated, draws one
diamond (`timeline/SeamLayer.tsx`, the shared `system/Seam.tsx` in its
diamond form): filled for a cut, hollow for a split. A tap or click selects
the seam and opens the Seam action bar and sheet; the join type is in the bar.
Diamonds are not folded into counts; where several sit closer than their hit
areas, zoom in. A finger's tap that lands on no target (a bare lane or a
non-movable clip) goes to a diamond within 22 px beside it and 44 px down from
its top. It never reaches the lane above, never applies to a pending region or
the envelope lane (they own their tap), and a tap on any target (a trim
handle, fade corner or clip body) is ranked as before. The mark opens from the
browser's own click, not from replayed pointer events (#2148). A tap that has
no target under the finger and is sent to a mark waits for the browser's
click, which the iPhone Simulator delivers on the lane after the press
layer's press: the router then replays one click on the mark, and the lane's
seek ignores that browser click once (`HitRouter.claimsClick`, a claim window
of `GHOST_CLICK_MS`). If no click arrives within `GHOST_CLICK_MS` the mark
opens anyway. A new press within the window drops the pending open.

Applied mute edges stay inert, `aria-hidden` ticks. Pending regions keep
their real scale and their 0.75rem floor at every zoom and their own touch
chooser (#1051).

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
- #2294 (W1a): Alt-click Split is mouse only; touch has no Alt, so its visible Split equivalent is the palette and create menu until the action bar's Split verb (W1b)
enforced-by:
- gui/web/src/stage/dialogs/CommandPaletteView.test.tsx::lists two-finger Undo as an optional ShareCut shortcut among the gesture rows
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

The command catalog says **"Undo the last action. Optional ShareCut shortcut."**
The inaccurate hook comment is removed. The implementation still calls
`execute("history.undo")`. The recognizer and its tests are unchanged. No help copy claims an iOS convention or a
particular visible Undo route. Source confirms More contains a History route in
the phone More hub (`layout/MobileShell.tsx`); since #2292 the hub is gone and History is an Edit sheet. Help copy does not depend on either.
Apple's [iPhone Undo and redo guide](https://support.apple.com/en-au/guide/iphone/iph1a9cae52c/ios)
documents the three-finger text editing gesture. That system convention does
not establish ShareCut's separate two-finger shortcut.

Amended by #2294 (W1a): the Select/Blade tool strip and the ruler comment mode are gone. Alt-click at the pointer splits with a mouse and a touch user has no Alt, so the visible equivalent for touch is the Split verb in the Action bar (the playhead, or both edges of a range or words selection, in one undo step) and the create menu's Split here (W1b, decided by calebn, 2026-10-28). The touch Select range toggle is a 44 px button in the Edit corner.

Amended by #2294 (E3): Alt also inverts snapping for one drag or commit, and a touch user has no Alt, so the visible equivalent is the Snap toggle in the Edit corner (`view.toggleSnap`), shown on every pointer and kept per browser (decided by calebn, 2026-11-10).

Exact seek remains outside this patch. the transport timecode (now the Player bar's time, `System/Player`) uses
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
| Ruler seek: `system/Ruler.tsx` (mounted by `timeline/TimelineRuler.tsx`; the comment-span draft by dragging and `commentAnchorSession.ts` were removed in #2294) | Tap ruler to seek; visible time/playhead | Tap seeks immediately. A finger never scrubs from the ruler: a swipe starting on it pans the timeline like one on the lanes (`touch-action: pan-x pan-y` under a coarse pointer). A mouse or pen drag scrubs the playhead (Escape or a lost pointer puts it back). The ruler has no comment mode (removed in #2294), so there is no span draft; a comment is composed from the Comments panel or the Player bar. No new sheet or seek input. | **Keep.** `system/Ruler.tsx` and `ruler-recovery.spec.ts` identify the seek path. Arbitrary exact seek remains an open precision gap, while ruler tap is an existing single-pointer navigation path. |
| Select range: `useRangeGesture.ts`, `EditCorner` (was `EditToolStrip`, `EditingToolRail`) | Armed range drag; visible Select range mode, In/Out/Length Scrub fields, Scope toggles (also settable before an agent range is adopted) and action card | Explicitly arm before drag. Draft is local until Cut/Mute/Comment/Export. Existing Cancel/Escape and permission paths own cancellation/failure; one accepted document operation uses existing History. The corner's Range arm (touch only, 44 px) and the Scrub fields remain. | **Keep and clarify armed state through existing UI.** `contextual-range.spec.ts` covers exact targets and policy; phone dispatched events are synthetic as recorded in #878. |
| Clip move: `ClipBlockView.tsx`, clip move owner | Drag visible clip body/grip; click selects and modifier click extends selection | Owner previews destination before `MoveClips`; accepted changed release commits once; Escape, capture loss, blur, pagehide, a hidden tab and unmount cancel. Existing command permission and Undo apply. The inspector's Start Scrub field and Track row preview and save the move; there is no Apply or Cancel. | **Keep drag and add inspector placement.** `ClipBlock.test.tsx`, `edit/clipMove.test.ts`, and `inventory-audit.spec.ts` are the cited coverage. Exact 7/27-second persistence remained failed in the #878 record. |
| Trim, fade, roll and crossfade: clip handles, join controls, inspector | Drag visible edge/seam; native numeric/range fields and keyboard nudges | Local preview follows the active owner. Accepted changes use existing commands; Escape/cancel does not save. Save failures stay in current inspector error routes; accepted edits use document History. Touch and dense-target behavior vary by timeline width. | **Keep.** `fade-curves.spec.ts`, `crossfade-length.spec.ts`, and `transitions-acceptance.spec.ts` retain existing evidence. Do not add another gesture system. |
| Pending range, chapter, social markers: `MarkerLane`, pending inspector | Drag eligible visible handles/body; inspector numeric timing and Edit timing | Draft remains local before the existing command. Escape, lost ownership, blur, and unmount cancel owned previews. Host/guest permissions remain at current command boundaries; accepted edits are undoable. Phone dense pending handles can give way to Edit timing. | **Keep.** `pending-edge-controls.spec.ts`, `MarkerLaneHost.test.tsx`, `system/MarkerLane.test.tsx`, and #878 inventory cover named paths; not every interruption combination. |
| Join endpoint / join length: Seam diamond and inspector | Select join; numeric join length | Endpoint row is separated from neighboring actions. Numeric field is the exact visible equivalent; preview/save/failure follow current inspector command. Existing History applies to accepted edit. | **Keep.** `transitions-acceptance.spec.ts` checks saved bounds and Undo. Do not add rotate or hidden pinch. |
| Envelope points and creation: envelope overlay / #950 inspector | Existing point editing; creation is missing | Point selection/edit behavior remains in #950's ownership. Its future edit contract must define preview, apply/cancel, save failure, permission, History and narrow responsive behavior at that boundary. | **Keep point editing; route creation to #950.** This patch touches none of the #950-owned files or claims. |
| Script divider: `stage/edit/ScriptDivider.tsx` (replaced `BottomTabsSplitterView.tsx` and its Shorter/Taller/Reset buttons in #2292) | Drag separator; Arrow keys (Shift for 4 rem), Home/End, Enter or double-click reset | Existing separator owns preview and Escape cancellation; accepted view sizing may persist its preference but creates no document History. It remains a desktop/tablet surface with a 10 CSS-pixel measured pointer strip in #878. | **Keep drag and add native size buttons.** Keyboard resizing is the non-drag route; `ScriptDivider.test.tsx` is the evidence now that `splitter-recovery.spec.ts` and the size buttons are gone. |
| Track order and gutter: track Action bar More, track reorder controller | Move track up and Move track down rows in the track bar's More; reorder grip drag remains available where permitted | Move up/down are single-pointer menu rows that invoke current track-order commands, disabled with a reason at the ends of the list; command permission and Undo paths remain authoritative. The reorder grip owns drag preview/drop. No new gutter drag ownership, auto-scroll, or selection model. | **Keep Move up/down as the non-drag route and keep the reorder grip.** Source confirms the alternate action already exists; task-path comparison between the buttons and drag remains open. |
| Mix: `MixSheet`, native controls, `useCommitRange` | Level Scrub field and M/S controls; More → Mix | Volume follows the existing preview/commit lifecycle and permission reason; M/S and local/shared listening distinctions remain. Accepted host/editor volume writes use the existing document command. Sheet layout supports row scrolling and text wrapping. | **Keep.** Do not add swipe-to-mix. Existing `phone-mix.spec.ts` covers its current path; failure/cancel combinations not asserted there remain unverified. |
| Transcript words: transcript views and correction flow | Tap seeks; double tap opens Fix text; a hold then drag selects a range | First tap seeks immediately. Correction opens only for a host with hydrated words. Submission uses `submitWordCorrection`; failure/permission behavior stays there. | **Keep.** `transcript-wordbar.spec.ts` is the retained evidence. No delayed tap-to-seek recognizer. |
| Comment rows: Review queue | Visible Resolve/Reopen and Undo toast | The Comments panel's own swipe-to-resolve is gone, but a phone queue row swipes right for its verb, which resolves a comment; swipe left does nothing on a comment. Resolve is also the action-bar verb, host only; latest-only Undo toast remains. | **Panel swipe removed; queue-row swipe kept.** |
| BottomSheet: `ui/BottomSheet.tsx` | **Only the phone Inspector sheet drags and flicks** (its grip; the drawer header was removed in #2294 W3c2b); every other sheet has no drag gesture. Expand/Collapse and Close are visible single-pointer actions on all of them | Controlled `expanded` updates half/full view state only (dock/half/full for the phone Inspector sheet; the grip toggles dock and half; it no longer stows during a timeline drag). There is no command/failure/History path for resize. Close and Escape dismiss; the interactive inspector scrim never takes a touch, and it no longer dims the timeline (retired with the drawer, #2294 W3c2b); confirmation scrim dismisses. Shell CSS keeps phone nav and tablet chrome clear. | **Remove inert grip; retain and enlarge the resize button.** `BottomSheet.test.tsx` and new touch E2E exercise the existing callback and layout. No global button changes. |
| Transport, Gestures help and History: phone More hub (removed in #2292), command catalog | Two-finger tap is an optional ShareCut Undo shortcut; visible command routes remain | Existing recognizer dispatches `history.undo` and reports failure through the shared status path. It runs only when enabled by current project/command availability. It does not make a platform convention or modal-body guarantee. History is an Edit sheet and Gestures is a touch-only result group in Commands and shortcuts. | **Modify attribution only.** `useTwoFingerTap.test.tsx` stays unchanged; `CommandPaletteView.test.tsx` asserts the rendered optional ShareCut copy on the Undo gesture row. |

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
- **Defer:** exact seek, a general input library, global
  gesture changes, and all #950 envelope creation work.

The inventory does not claim keyboard operation alone meets WCAG 2.5.7. Existing
visible actions are credited only where the same operation has a single-pointer
non-drag path. Clip movement and Script divider resizing now have native non-drag
controls described in #1033 above. Automated Chrome and WebKit cases cover their
preview, commit, cancellation, recovery and local-preference contract. Physical
acceptance stays separate. Track order already has Move up/down buttons; how well those buttons and
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
| Comment resolve/Undo | Visible Resolve and Undo | Same comment becomes resolved and then reopens. |

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
| Every drag has a single-pointer non-drag equivalent; keyboard alone does not count | **Partly existing, partly open.** Visible sheet buttons, numeric/step controls, and track Move up/down remain. Clip move and desktop/tablet splitter resizing have native non-drag controls in #1033; their executable browser matrix and input provenance are in `non-drag-placement.spec.ts`. Exact seek remains an input precision gap. Track task comparison is open. |
| Keyboard operation, visible focus, labels, values, errors and roles | **Scoped checks passed.** Component/recognizer/mobile-shell tests cover keyboard and focus; browser sheet cases restore focus after Close and Escape. Mix browser cases cover host/viewer/edit-guest restrictions. VoiceOver/TalkBack and global profile coverage remain pending. |
| Scroll, seek, selection and editing do not collide; pointer transitions are safe | **Existing limited evidence** in source and #878. Uncovered intersections remain open; this patch adds no recognizer. |
| Cancel/unmount/background/rotation/failure leave no stuck gesture; history cardinality is correct | **Scoped browser recovery passed** for native fade cancel, 403/422/409 rejection, abort/replay and Undo. Sheet actions send no document commands and leave project bytes and preferences unchanged. A long-press clip move interrupted by pointer cancel, lost capture, window blur, pagehide, a hidden tab, Escape or unmount saves nothing (`ClipBlock.test.tsx`), and rotating a phone mid-move ends it with no write while the same move left alone saves one `MoveClips` (`touch-move-rotation.spec.ts`, CDP touch, not hardware). A Mix volume drag cancelled or backgrounded (visibilitychange hidden, pagehide) returns the thumb to the saved value and sends nothing, and the change that follows is ignored; a drag blurred with no change returns to the saved value too, while a change right after a blur still commits (`useCommitRange.test.tsx`; jsdom, not hardware). iPhone Simulator proof of #1034 found WebKit committing the half-dragged value on backgrounding; the fix awaits a Simulator re-run. A rejected save restores the saved value in the store, which the thumb follows (`trackMix.test.ts`). Rotation of trim and range select, and backgrounding on hardware, remain open (#1034); the jsdom backgrounding cases are in the next row. |
| Exact destinations, extra pointers and trim cancels (#1034 follow-up) | **Jsdom cases passed, not hardware.** Mouse or pen drag of a clip from 7 s to 27 s saves one `edit.moveClips` with `timeline_start` exactly 27 (`TimelineView.test.tsx`, "saves the exact 7 s to 27 s destination"). A touch long press over the same 20 s reports a `deltaSec` of exactly 20 (`ClipBlock.test.tsx`, "reports a deltaSec of exactly 20"). The native non-drag controls keep their own browser cases in `non-drag-placement.spec.ts`; no 7/27-specific native case is added here. A second finger lifting after a saved touch move adds no second save (`ClipBlock.test.tsx`, "ignores a second finger lifting after the move saved"). A second pointer on the clip body during a trim drag leaves the first pointer's single trim save intact (`ClipBlock.test.tsx`, "ignores a second pointer on the clip body during a trim drag"). A second finger during an armed range select cannot take, move, end or cancel the first finger's range (`useRangeGesture.test.tsx`, "range select with a second pointer"). A pointer lifting on a Mix slider mid-drag still leaves one commit of the dragged value (`useCommitRange.test.tsx`, "with a second pointer"; the hook keeps no pointer identity). A trim drag cancelled by pointercancel or Escape, or unmounted mid-drag, saves nothing, checked against a following full drag as a positive control (`ClipBlock.test.tsx`, "saves nothing when a trim drag"). Range selection (`useRangeGesture`) and trim-edge handles (`useClipEdgeHandles`) cancel on window blur, hidden and pagehide through `useInterruptCancel`; a clip move (`ClipBlock`) cancels on window blur, pagehide and a hidden tab the same way (`ClipBlock.test.tsx`). Drags owned by `useGrab` (envelope points, marker handles, the overview strip, the ruler and the inspector sheet) cancel on pagehide and a hidden tab as well as window blur, and commit nothing (`useGrab.test.tsx`; jsdom, not hardware). A second finger landing on the same trim handle replaces the first drag and is untested. |
| 360 portrait, short landscape, tablet, desktop, themes, reduced motion and 200% text | **Automated cases passed** for 360×800 and 667×360 (the compact drawer's open and full geometry), 820×1180 (the tablet card, a no-legacy-sheet case) and 1440×900 (no sheet), both themes and motion preferences. The 200% case doubles computed root font size and proves title/control geometry and half-height body scrolling. This is CSS emulation; native keyboard, safe-area, OS text scaling and physical reflow remain pending #301. |
| Native browser zoom/Back and normal nested scrolling remain available | **Nested scrolling verified** with browser mouse-wheel input while the sheet stays expanded at 200% root text size. Native zoom/Back and physical scroll behavior remain open; this patch adds no gesture listener or touch-action override. |
| Define task paths for seek, range, trim/fade, envelope, reorder, Mix and comment resolve/Undo | **Comparison paths defined** above. Named-task activation count, precision and recovery comparison remains open. Sheet sizing keeps one button activation per size change; no efficiency improvement is claimed. |
| #879 named-device response/frame/long-task profiles | **External pending.** No performance budget or improvement is claimed. |
| Browser regressions exercise initiation, intermediate state, saved state and recovery | **Real-app browser cases passed** for sheet initiation, half/full geometry, dismissal, focus restoration, nested scrolling, project bytes, storage and document commands. The wheel check is browser mouse input. Existing mobile cases use CDP touch or synthetic events as documented; neither is physical hardware evidence. Other editor-controller combinations remain open. |
| Physical iOS Safari, Android Chrome, stylus, trackpad, OS gestures and assistive tech | **External pending #301.** Browser automation is not hardware evidence. |
| Gesture library comparison and independent adoption review | **Compared and decided (#1078).** Native Pointer Events stay and no new dependency is adopted; see the comparison below. |

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
The half sheet remains a compact preview; the grip raises it to full to expose the field scroller.
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
content. Those are source-document comparisons; neither package owns ShareCut
command, permission, history, or stale-update behavior.

The sections below record the later comparison that settled this.

## Gesture-library comparison (#1078)

The bounded comparison the source review required ran on 2026-10-12. The
throwaway harness is not in the repo: one Vite page with three variants of a
single press target, each driven through the #1051 cases with Playwright in
Chromium (touch emulation and CDP touch events) and WebKit (synthetic touch
pointer events; Playwright's WebKit has no touch-move API). The page rendered in
`StrictMode` under the Vite dev server.

### What is used today

No gesture package is in use. Since #1312 the two places that used React Aria's
press hooks are native Pointer Events:

- `timeline/useTouchPress.ts`: native pointer code owns a deferred touch until
  `HitRouter` decides what it was. It calls `HitRouter.longPress` after
  `LONG_PRESS_MS`, ends the press on `pointerup` or `pointercancel`, turns
  text selection off while pressed, blocks the long-press context menu, and
  keeps the browser's click from reaching targets for a second after a
  release. `TimelineView` and `JoinEditor` use it.
- `timeline/TimelineChooser.tsx`: the chooser's chip buttons pick on click,
  with the `pointerType` taken from the pointerdown that pressed inside the fan
  (`virtual` for a click with no such pointer).

What the native layer does not do that React Aria's hooks did (#1312, to check
on a phone in #960): it does not focus the target on a long press, ignore
virtual (VoiceOver, TalkBack) pointer events, release implicit touch capture,
cancel a press on `dragstart`, or fire a synthetic click 80 ms after a release
that has none. Its context-menu block covers touch contextmenu events inside
the root from touch start to 1 s after a long press, not the pressed element
alone. Its pointerup and pointercancel listeners sit on `window`, ahead of the
router's document listeners, which stop a finger's release once a second finger
has taken the gesture.

Everything else is native Pointer Events: `hitRouting.ts` (slop, second-finger
cancel, chip settle, tap on release), `chipGesture.ts`,
`timelineZoomGestures.ts` (pinch and pan), `useRangeGesture.ts`,
`hooks/useLongPress.ts` and the drawer. All of them
read `hooks/gestureConstants.ts`. `gestureGovernance.test.ts` pins this list.

### Results

| | Native + constants | `@use-gesture/react` 10.3.1 | React Aria `usePress` + `useLongPress` |
| --- | --- | --- | --- |
| Gzip added to a bare React page (Vite, minified) | +0.7 kB | +8.5 kB (`useDrag` + `usePinch`) | +7.0 kB |
| Real app, both React Aria call sites stubbed out | | | 6.5 kB gzip of 397.1 kB (1.6%) |
| Long press at 500 ms with 6 px drift | arms | arms (own timer) | arms |
| Drift past the 10 px slop before 500 ms | pans, never arms | pans, never arms | still arms |
| Pan then lift is not a tap | yes | yes | reports a tap (see notes) |
| Second finger cancels a pending or armed press | yes | no | no |
| `pointercancel` before arming | cancels | no signal | cancels |
| `pointercancel` after arming | cancels | no signal | no signal |
| Tap | tap on release | no event for a stationary press | tap |
| Pinch | own code (`timelineZoomGestures.ts`) | `usePinch` recognizes it | none |
| Handler runs after pointerdown | 0.1 ms | 0.1 ms | 0.1 ms |
| Long press fires at (median of 15, Chromium) | 501.5 ms | 501.4 ms | 501.7 ms |
| Pointerdown to painted feedback, median / p95 (Chromium, 40 runs) | 9.5 / 16.4 ms | 10.3 / 18.6 ms | 16.6 / 24 ms |
| Same, WebKit | 8 / 16 ms | 9 / 17 ms | 28 / 31 ms |
| `StrictMode` (dev double effect) | 2 mounts, 1 cleanup, one tap per tap | one press per press | one press per press |

Notes on reading the table:

- The latency rows time a double `requestAnimationFrame` after the handler's
  state change, so they are quantized to 16.7 ms frames. Native and
  `@use-gesture/react` paint within a frame of each other. React Aria paints
  about one frame later in Chromium and two in WebKit in this spike. That is
  one run of 40 on one machine, not a measured regression in the app.
- The harness set `touch-action: none`, so the browser never took a pan to
  scroll. In the app a scroll ends the touch in `pointercancel`, which the
  router already handles. The "pan then lift reports a tap" row for React Aria
  is why the router replays its own tap at release.
- The `@use-gesture/react` adapter is minimal. The library has no long press,
  no tap for a stationary press, no cancel signal and no multi-pointer
  rollback, so each case that #1051 depends on needed hand-written pointer
  code, the same code the native router already has. A deeper adapter could
  close some rows, but it would still carry that code. Only pinch recognition
  came from the library, and `timelineZoomGestures.ts` already has it.
- Maintenance: `@use-gesture/react` was last published 2024-03-21 (MIT,
  repository last pushed 2024-07-15, 58 open issues, React peer `>= 16.8.0`).
  `@react-aria/interactions` is current (Apache-2.0, `adobe/react-spectrum`
  pushed on the day of the review). `@dnd-kit/react` 0.5.0 (MIT) is pre-1.0 and
  covers drag and drop only, not press, long press or pinch. Hammer.js is
  unmaintained.
- Platform values. Android: `DEFAULT_LONG_PRESS_TIMEOUT = 400` ms in
  [`ViewConfiguration.java`](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/view/ViewConfiguration.java);
  the touch slop is the resource `config_viewConfigurationTouchSlop`, which
  [`core/res/res/values/config.xml`](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/res/res/values/config.xml)
  sets to `8dp` (the `TOUCH_SLOP = 8` in `ViewConfiguration.java` is only the
  fallback for legacy apps). Apple documents `UILongPressGestureRecognizer`
  [`minimumPressDuration`](https://developer.apple.com/documentation/uikit/uilongpressgesturerecognizer/minimumpressduration)
  as 0.5 s and
  [`allowableMovement`](https://developer.apple.com/documentation/uikit/uilongpressgesturerecognizer/allowablemovement)
  as 10 pt. CSS px and dp are the same size on mobile browsers (the
  device pixel ratio scales both), so comparing `TOUCH_SLOP_PX` to dp is
  sound. `LONG_PRESS_MS` (500) is iOS's value and 100 ms above Android's
  default. `TOUCH_SLOP_PX` (10) is iOS's value and 2 px above Android's, so a
  finger that drifts 8 to 10 px still counts as holding where Android would
  have started a scroll; the browser's own scroll slop takes over first on a
  scrollable surface. No constant changes. `gestureConstants.test.ts` now pins
  both ranges.

### Decision: Native pointer events with platform constants for the timeline

<!-- decision
id: D-timeline-native-pointer-events
status: accepted
date: 2026-10-12
decided-by: calebn
evidence:
- #1078 owner, after the #1051 phone test: "are we not using a library for these gestures?"
- #1078 React Aria prototype (2026-10-06): +6,923 B gzip, no pointer code removed, router grew from 503 to 571 lines
- #1078: the library could not express movement slop, second-finger cancel, sliding onto a chip, or tap on release
- #1078 bounded comparison (2026-10-12), results table: neither library supplies slop, second-finger rollback or both cancel paths; @use-gesture/react adds 8.5 kB gzip, has not been released since 2024-03-21 and needs the same hand-written long press, tap and cancel code
- #1078 platform check (2026-10-12): the constants sit at iOS's 0.5 s and 10 pt, 100 ms above Android's 400 ms long press and 2 px above its 8 dp touch slop (sources in the results notes)
- Decided under the operator's autonomous grant for #1078; the owner can still override
enforced-by:
- gui/web/src/timeline/gestureGovernance.test.ts::adopts no gesture package (#1078, #1312)
- gui/web/src/hooks/gestureConstants.test.ts::holds between Android's 400 ms default and iOS's 500 ms
- gui/web/src/hooks/gestureConstants.test.ts::is at least Android's 8 dp touch slop and at most iOS's 10 pt
- gui/web/src/hooks/gestureConstants.test.ts::holds for iOS's 0.5 s, a little above Android's 400 ms default
-->

Timeline touch recognition stays on native Pointer Events with the shared
constants in `hooks/gestureConstants.ts`. No gesture package is added:
`@use-gesture/react`, `@dnd-kit`, Hammer.js and Motion are not used for
gestures. The governance guard is a denylist of known gesture and pointer
libraries (`@use-gesture/*`, `react-use-gesture`, `@dnd-kit/*`, Hammer.js,
`react-swipeable`, `interactjs`, Motion, React Aria). It scans
every dependency field of `gui/web/package.json` and every import in non-test
source. A library not on the list passes, so add its name when a new one
appears. React Aria's press hooks, the one package that was in use, were replaced by
native code in #1312 (the approved phone behavior of #1051 rounds 4b to 6 was
tuned with them, so the real-phone check stays in #960). A library may still suit
ordinary buttons and controls outside the timeline.

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
envelope points, fade corners, trim strips, Seam diamonds, pending
edit edges and split flags, and chapter markers. Plain hit areas behind them
(lane seek, envelope lane, wide pending region, and the body of a clip that
cannot move) carry `HIT_SURFACE_PROPS`; the wide pending region and the
envelope lane carry `OWN_TAP_HIT_SURFACE_PROPS`, so a finger's tap on them stays
theirs and never redirects to a Seam diamond beside it. A movable clip's body is the `clip`
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
layer (`timeline/useTouchPress.ts`, native pointer
code), and no target sees it until the layer
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
  chooser (`stages/edit/TargetChooser.tsx`, hosted by
  `timeline/TimelineChooser.tsx`); one target, or a surface, is grabbed and the
  drag continues on it, and released in place it is a slow tap. Chips of
  `--touch-min` fan out on an arc 56 px above the finger, below it when there
  is no room above, and swing away from side edges
  (`stages/edit/chooserMath.ts`). Chips and caption stay inside the timeline's
  visible box, clear of the transport bar, tabs and sheets. Each chip shows its
  object kind's icon (clip, seam, comment, suggestion, envelope point, chapter,
  social clip) in a ring of its track's colour, with no leader line to the real
  position; trims, fades and the crossfade end share the clip icon, and the
  the seam target shares the seam icon, so the caption and the chip's
  spoken name tell them apart. Chips read left to right by real x. The fan
  draws five: when more crowd the spot it keeps the selected target and the
  best-ranked of each kind before a second of one kind, and says "showing 5 of
  N". Press a little nearer or zoom in to reach the others; a stack of six or
  more same-time comment pins cannot be told apart on touch. One caption names
  the chip under the finger, else the focused chip (the first chip when the fan
  opens); an envelope point's caption includes its gain, a comment's its author
  (cut to 16 characters), and the selected target's ends ", selected".
- **Commit.** Lifting on a chip replays a tap on its target at the target's own
  position and focuses it. A slide along the target's drag axis grabs it at
  once (see [Drag from a chip](#drag-from-a-chip-1051-round-3)). Resting on a
  chip never grabs, however long (Caleb, 2026-11-04: pausing to read the fan
  must not change what lifting does), so the fan needs no closing ring or
  hint line. A grab replays the press on the target and forwards the rest of the drag offset
  by the chip-to-target distance, so the target moves without jumping to the
  finger. Chips take taps on click, so touch, mouse, keyboard and
  assistive-technology presses pick.
- **Cancel.** Lifting anywhere but a chip leaves the chips open to tap. A tap
  on the dimmed timeline, Escape, a second finger before the hold ends, or
  `pointercancel` closes the chooser or drops the hold with no change; the
  closing tap's click is swallowed. Focus leaving the fan (an app switch, the
  on-screen keyboard, a screen reader's cursor) closes it too, and a right
  click on the dimmed timeline opens no native menu. That ghost-click window only covers the
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

The chooser is a `role="menu"` of `menuitem` chips named "<Kind>, <label>",
for example "Clip, Trim start at 00:03.000". The selected target is no longer
marked on its chip; its label ends ", selected" instead. It announces "N
targets here" ("N targets here, showing 5 of N" past five), moves with
Left/Right/Home/End, and Escape or Tab out closes it.
`ui/useMenuKeyboard.ts` owns that keyboard and focus contract for every popup
menu, so the chooser adds no keydown listener.

The chooser has no motion: it appears and disappears at once, with or without
reduced motion, and a chip under the finger scales without a transition.

Open question for physical testing: whether the platform hold (500 ms) feels
slow for the chooser. The scroll-first rule replaced
select-on-press for every timeline touch, so a touch dragged across a clip no
longer selects it on the way (the #1051 round-two repro on `main`).

### Comment pins (#1742)

A comment pin is a hit kind, `comment` (select only, no drag), so the resolver
and the chooser treat it like any other small timeline target.

- **Width.** On touch a pin is `--touch-min` wide around its 10 px dot,
  centred on its time, and stays one marker row tall: growing the row would
  cost every phone with comments 20 px of lane. Its height is the named
  dense-target exception (`e2e/touch-floor.spec.ts`); `e2e/comment-pins-touch.spec.ts`
  holds its width to the floor.
- **Row reach.** A comment reaches sideways along its own row only
  (`reach: "row"` in `inputContract.ts`). A finger on the ruler above or a
  clip below is never taken by a pin, selected or not, so the pin's reach adds
  no collision with the ruler's seek or a clip tap.
- **Stacks.** Markers whose glyphs overlap at the current zoom fold into the
  earliest one plus a `+N` chip (system marker lane); the chip opens a list
  naming each by author and time, and a pick opens exactly the pin it named.
  (The older long-press fan-out and click-to-step were removed with the
  three-row lane, #2294 W4a.)
- **No toast.** The chooser's "N targets here" is spoken by the live region
  only. Its toast sat over the chips whenever the inspector had shortened the
  timeline, which hid the second pick of a stack.

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
  `CHIP_SETTLE_MS` (100 ms, Android's tap timeout).
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
on a chip never grabs, whatever the axis. No drag magnifier
exists yet, so a grab from a chip has none.

### Compact inspector (#1051 round 3)

Retired by #2294 yf (2026-11-05): the compact drawer is gone, with the peek
strip (W3c2b), the Expand and Collapse buttons, the header Undo and Redo, the
stow slide, the nudge buttons and the stored `sharecut.compactInspector`
detent. A timeline selection on the phone now opens the Inspector sheet with
the Action bar as its dock (see gui-mobile.md). What follows is the round 3
record, kept as history.

A timeline selection on a phone-sized screen opens the compact drawer, a
half-height sheet, instead of a taller one that covers the timeline.
Phone-sized means the phone shell in
Timeline mode, or the tablet shell on a screen at most 40rem tall (a phone
held sideways). Taller tablets and desktop keep their inspector.
`stage/edit/useCompactInspector.ts` (now `keepTargetClear.ts`) decided this for both shells. Where the
Inspector was a [column](#superseded-decision-the-inspector-is-a-column-on-a-short-wide-touch-screen),
at least 40rem wide on a coarse pointer, there was no strip: the measurements
below for 800×360 and 844×390 sideways are the strip's, before the column.

- **The drawer.** The target's name is in the header (`stage/edit/compactTarget.ts`),
  for example "Fade in" or "Pending cut"; the body is the inspector's own
  sections. A clip's trim and fade fields, a pending edit's Source start and
  end and an envelope point's Time and Level were Scrub fields with four nudge
  buttons each (retired, #2294 yf: the fields keep typing, dragging and arrow
  stepping at the keyboard's steps in `edit/clipHandleSteps.ts`).
- **Expand and Collapse.** One tap on Expand opens the full height, one
  tap on Collapse returns to half. Both stay visible buttons beside the
  drawer swipe of round 4b. The last choice opens the next selection
  (`compactInspectorView`, persisted per browser at
  `sharecut.compactInspector`, half by default). At half the sheet is at most half its slot
  and leaves room for the transport, ruler, marker lane and one coarse lane.
  A selection the open plain sheet's own form makes, such as a point saved
  from a track's envelope form, stays in that sheet until it closes, so the
  form keeps its layout and focus instead of turning into the drawer. Only the
  inspector's own forms count (`selectFromInspector`, compared by identity in
  `inspectorSelection`): a tap on the timeline while a track's sheet is open
  opens the drawer, as always, and ends the hold. At large text, on a phone
  held sideways, the leave-room share of the slot can shrink to nothing (1 px
  at a 32 px root font), so a folded frame's compact sheet drops its half
  detent where half the slot cannot hold the one-row chrome and a touch row
  (R-short-11, `halfDetentFits`): it opens at full, and a stored half shows as
  full. Expand, Collapse and Close stay on screen. The drawer has one bounded body scroller. Native focus reveal
  brings the active field and its complete label below the pinned header when
  the label fits; the sheet scrolls within its own content instead of measuring
  a dynamic scroll-padding value (`focusAndReveal`, `revealBelowChrome`).
- **Dim.** Half and full dim the timeline with the sheet scrim, without taking
  a touch. The clear scrim the strip had (`bottom-sheet-scrim--clear`) stays in
  `BottomSheet.tsx` for the generic peek detent that other sheets use.
- **Keep the selection in view.** The timeline scroller gets bottom padding as
  deep as the sheet covers it, and scrolls the selected target above
  it. Sideways, the sheet takes the bottom tabs' place while it is open, so
  the timeline keeps their row.
- **Out of the way.** Any timeline drag stows the sheet: it slides
  off screen, click-through but still mounted. It returns on release with the
  new value. `timeline/dragWatch.ts` reports a drag: a pointer that started in
  the timeline, is captured there (or is the router's own replay), and has
  moved `HANDLE_DRAG_MIN_PX`. A scroll never counts.

Measured in Playwright with the #1051 fixture (the same in Chromium and WebKit; a lone envelope point on lane 1) before the strip was removed, as px of timeline lanes left
visible above the inspector (the Strip column is the retired peek detent; Expanded is the half drawer):

| Viewport | Round 2 sheet | Strip | Expanded |
|---|---|---|---|
| 360×800 portrait | 136 (second lane covered) | 542 | 274 |
| 390×844 portrait | 180 (second lane covered) | 586 | 296 |
| 800×360 sideways | none (timeline covered) | 125 | 107 |
| 844×390 sideways | none (timeline covered) | 155 | 107 |

### Superseded decision: The Inspector is a column on a short wide touch screen

<!-- decision
id: D-inspector-column
status: superseded
date: 2026-10-18
decided-by: calebn
evidence:
- #1696: owner request (calebn, 2026-10-17, project chat) to present the selection Inspector as a side column on a phone held sideways
- #1694 and #1714: the lane band kept the lane and the form on screen, but they shared a short vertical space and the keypad squeezed both
superseded-by: D-inspector-sheet-no-column
-->

Amended by #2294 (W1b, calebn, 2026-10-28): the Inspector opens only on Inspect
(I, the Inspect verb, a double-click on a clip) and never because something is
selected; Esc, Close or a new selection shuts it. The column, the sheet and the
compact drawer below describe where it opens, not when.

On a coarse primary pointer at most 40rem tall and at least 40rem wide, the
selection Inspector is a column on the inline end of the shell, not a bottom
sheet. One hook (removed in #2294 W3a) owned the three conditions; below 40rem
wide, in portrait, and with a fine pointer the sheet or compact drawer stays.
The column is `clamp(16rem, 32vw, 22rem)` wide and a cell of `.daw-shell`. It
portals into the same host element as the sheet, and only that host's parent
changes, so turning the phone keeps the Inspector's drafts and focus. The
timeline keeps the whole main row, and the tablet's tabs row and the phone's mode nav give way while it is open. It keeps
the title, **Close**, Escape and focus restore, and drops the scrim, drawer,
Expand and Collapse, and the slide-up. It carries none of the sheet classes, so
the keep-clear helpers do nothing for it, and with the keyboard up it takes the
visible band of the viewport (`--visual-viewport-top` and
`--visual-viewport-height`), not the layout height minus the keyboard, and it
ends above the tablet's status strip. Turning
the phone upright shows the full Inspector, not the compact drawer.
This replaces the lane band and the compact drawer on those screens, and no
other. A gesture that needs the compact drawer's Undo header does not exist
there: Undo and Redo are in the app header, which the column leaves usable.

Superseded by #2294 (W3a, calebn, 2026-10-30): the spec's Inspector sheet is a
bottom sheet on the phone in either orientation (design-system 9a), so the
column, `useInspectorColumn` and the side-column placement of the Edit stage's
Inspector are gone. The generic `BottomSheet` still has a column placement that
nothing in the Edit stage uses; it goes with the legacy bodies (W3c).

### Decision: The phone Inspector is the sheet in either orientation

<!-- decision
id: D-inspector-sheet-no-column
status: accepted
date: 2026-10-30
decided-by: calebn
evidence:
- #2294 W3a owner decision g6 (2026-10-30): the phone-landscape column is deleted and the Inspector is the bottom sheet only, as design-system 9a and spec-edit SHEET-INSPECTOR say
enforced-by:
- gui/web/src/stage/edit/InspectorHost.test.tsx::carries the Action bar as its dock without Inspect, and opens at half
- gui/web/src/stage/edit/InspectorHost.test.tsx::steps through its detents from the grip and closes from Close
- gui/web/src/system/InspectorSheet.test.tsx::dismisses when let go more than 24 px below the dock
- gui/web/src/stage/edit/useInspectorOpen.test.tsx::clears the selection when the phone sheet is dismissed
- gui/web/src/stage/edit/useInspectorOpen.test.tsx::opens the same sheet for a timeline target on every shell
- gui/web/e2e/inspector-sheet-drag.spec.ts::a 667x375 phone shell gets the Inspector sheet and no column
supersedes: D-inspector-column
-->

On the phone shell (up to 767 px wide, `PHONE_MAX_PX`) the Inspector is the
Inspector sheet (dock, half, full) whatever the orientation; the tablet and
desktop shells, which include a wider phone held sideways, get the card beside
the selection.
At the dock detent the sheet's header and sections are inert and one grip tap
away; the sheet opens at half (full when the box is too short for the dock),
not at the dock.
A timeline target on the phone opens the Inspector sheet at its Action bar dock
(dock, half and full detents); the compact drawer and its peek strip are gone
(#2294 W3c2b).

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
handle, a clip body or the volume envelope line, drags it, lands a second
finger and spreads both: Chromium with two real CDP touch points, WebKit (no
touch input in Playwright) with touch-typed pointer events plus the touch
events a pinch fires. On the round 3 build the fade, trim and body cases saved
`TrimClipEdge`, `MoveClips` or `RollClipJoin`; now every start sends no
document command, the saved clip is unchanged, the selection is what it was, and the zoom grows by about 2.3×
(portrait and sideways).

### Decision: Undo and Redo stay in the App header on the phone

<!-- decision
id: D-compact-inspector-history
status: accepted
date: 2026-10-09
decided-by: calebn
evidence:
- #1205: at 844x390 with 32 px text, a tap on the rail Undo hit the envelope nudge and saved an unintended edit
- #1205 design synthesis: the same history controls move into the compact header while lane space returns
enforced-by:
- gui/web/e2e-compat/compact-history-persistence.spec.ts::Undo and Redo stay reachable in the App header with the Inspector sheet open
-->

The phone Inspector sheet has no header and carries no history controls (the
compact drawer that did is retired, #2294 yf). Undo and Redo stay in the App
header, which the sheet never covers at the dock, half or full detent, at any
text size. The header controls use one authorization check, one
unavailable-action message and the existing `history.undo` / `history.redo`
command bus path, including its wait for this tab's edit saves (it queues
behind a save that is still out, says "Undo runs after save", and never
refuses for the wait). History controls stay at least 44 CSS pixels square and
are never covered by the sheet.

The blade confirmation sheet this round fitted was removed in #2294: Split cuts at once and the toast carries Undo.

### Collapse stays in reach (#1051 round 4)

With the inspector expanded on a phone held sideways, picking another target
opened it expanded (as asked) and revealed its first field by scrolling the
sheet, which carried Collapse and Close out of view above the timeline. The
owner's Collapse never reached the button, so the next selection still opened
expanded. The compact sheet's chrome (name, Expand or Collapse, Close) is now
pinned at the top of the sheet's single scroller, and `ui/focusAndReveal.ts`
reveals a field below pinned chrome rather than under it. The compact header keeps one vertical spacing at every detent, so its
wrapped actions leave room for enlarged fade fields on a short screen. Native
focus also reveals the complete field label when it fits below that header.
The sheet still has one scroll owner. `e2e-compat/touch-drawer.spec.ts` taps Expand and Collapse
with a finger at 360×800 and 636×390 (the 844×390 it used moved to the column, #1696) and checks that the finger lands on the
button; the sideways case failed on the round 3 build.

### The drawer over shell rows (#1051 round 4)

Sideways, the status row (where the Pipeline chip sits) floated over the
drawer (then the peek strip) and moved as the page scrolled. iOS rubber-bands the page when a scroll
reaches an edge: in-flow rows move while the fixed sheet stays, and the
status and nav rows (`--z-shell-chrome`) drew over the sheet
(`--z-sheet`). Two changes:

- The editor no longer scrolls as a page: `html[data-shell]` and its body
  set `overscroll-behavior: none`, and the timeline scroller sets `contain`.
- The compact sheet's root stacks at `--z-sheet-docked`, above the shell rows,
  and clips its own slot, so neither the row draws over the drawer nor the
  drawer's slide (entering, stowing) over the row.

`e2e-compat/touch-strip-stacking.spec.ts` moves the shell as a bounce does
and freezes the stow slide halfway, in Chromium and WebKit at 360×800 and
636×390 (844×390 before #1696). On the round 3 build the row covered the strip's bottom edge.

### Nudge buttons and hold-to-repeat (#1051 round 4)

Retired by #2294 yf (2026-11-05, the design docs are the spec). The Inspector
sheet draws no nudge buttons: `inspector/NudgeRow.tsx`, `SheetNudge.tsx`,
`useNudgeRun.ts` and `e2e-compat/touch-nudge.spec.ts` are deleted. A
clip's Source start, Source end, Fade in and Fade out, a pending edit's Source
start and end and an envelope point's Time and Level are Scrub fields only:
type a value, drag it, or step it with the arrow keys at the keyboard's steps
(`edit/clipHandleSteps.ts`; hard limits and soft boundaries as before in
`edit/nudge.ts` and `edit/nudgeBoundaries.ts`). The cost is that the phone has
no one-tap quick nudge; the keyboard nudge paths and the timeline's own
handles remain.

### Touch grammar round 4b (#1051)

Round 4b builds the grammar on the 4a branch. It shipped behind the touch
chooser lab until the owner made it the default (2026-10-07).

- **Arming.** A long press (`LONG_PRESS_MS`) on one target arms it, if its
  contract gives it an axis, or selects it (a Seam diamond, a pending split).
  Over two or more targets the chooser opens, and a chip arms its target as
  before. An armed target wears an accent halo, the screen
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
  envelope layer, the body of a clip that cannot move, as on a
  view-only link) opens a menu above the finger (below it near the top
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
  ("00:30.000 · Avery"). The rows are the Create here menu's
  (`stages/edit/CreateMenu`, hosted by `timeline/TimelineCreateMenu`): **Split
  here** first, then **Comment here** and **Add chapter here**, then **Record here** (host
  only; opens Record with an Insert target at the held time), then, below a
  divider, **Add volume point** (on a lane; picking it turns the volume layer
  on if it is hidden), then **Paste** while the clipboard has audio
  (#2294 W1b: the menu is how a touch user splits on a lane, and Split heads
  it). Split here cuts the selected tracks, else every dialogue track, as it
  always did; the menu no longer says which. Paste lands at the held time on
  the copied track, not on the held lane.
  Each runs a catalog command at the held
  time (`edit.bladeCut`, `comment.draftAt`, `edit.addChapter`,
  `envelope.addPoint`, `edit.paste`, `record.here`, each with `atTime`); a row the link
  cannot run is not in the menu, and a command that refuses says why in the
  live region. Slide onto an item and lift to pick it, or lift anywhere and
  tap one; on a phone the rows are a bottom Sheet, which shows no highlight
  under a sliding finger but still picks on that lift. A lift that never moved past
  `TOUCH_SLOP_PX` picks nothing, whatever lies under the finger: round 8's
  live proof found that at 844x390 the menu opened under the finger and a
  lift saved Add chapter. The scrim, Escape and a second finger close it.
- **Detents.** An armed drag that reaches a soft boundary holds there until
  the finger pushes `DRAG_DETENT_PX` (16 px) past it, with a line and an
  "At the playhead" caption. The boundaries come from `softBoundaries`, the
  query held nudges use; a boundary the drag starts on does not catch it.
- **Drawer (retired).** The #1051 compact drawer (half/full swipe, stow during
  a timeline drag, timeline dim, Expand/Collapse, "Inspector height" range) was
  replaced by the phone Inspector sheet with an Action bar dock as its first
  detent (#2294 W3c2b); the sheet has no stow or dim. Its swipe motion
  (`ui/drawerMotion.ts`) still coasts on release as Apple's "Designing Fluid
  Interfaces" (WWDC 2018) describes: a deceleration of 0.998 per ms, settling
  at the nearest detent, with speed read over the last 100 ms of moves.
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
  found no other kind without a touch path. The crossfade endpoint grip was
  once such a kind; the grip and its rail are gone (the seam sheet's Length
  field sets the overlap). The conformance test also fails when any kind with an axis drags
  on touch before a long press arms it, selected or not.
- **The crossfade rail on a phone held sideways.** Opening a crossfade join
  opens its popover, which in a 390 px tall screen covers the rail's grip
  (round 8's live proof hit the popover's icon at the grip's centre). The
  popover's Length slider is the visible, full-size equivalent of the grip, so
  there the popover owns the edit and the pinch-from-the-grip case cannot
  arise; in portrait the grip is reachable and its pinch rule is pinned live.
  A toast no longer covers the grip there either: the phone toast docks above
  an open crossfade rail as it does above the Player bar.

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
- gui/web/src/ui/BottomSheet.test.tsx::keeps the draft, the elements and the focus when the phone rotates and back
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

Feedback does not override half or full detent geometry. Bottom-sheet controls
paint focus outlines inside their border boxes; primary controls use
`--color-accent-on-solid` so the inset ring contrasts with their solid fill.
The visually hidden detent range keeps the grabber as its visible focus
indicator. Visibility observation follows
the same feedback card through compact and floating hosts, so both presentations
pause the single remaining lifetime when the whole card is clipped.

## Decision: Auto precision jog pad on touch

<!-- decision
id: D-touch-precision-jog
status: accepted
date: 2026-10-15
decided-by: calebn
evidence:
- #1184 owner phone test: Auto precision with the jog pad
- #1184 owner decision: remove lens and grip variants and the precision lab
enforced-by:
- gui/web/src/timeline/precision/precisionDecision.test.ts::goes into precision for a target narrower than the finger
- gui/web/src/timeline/precision/precisionSession.test.ts::moves one 10 ms step for 1 px at full speed
- gui/web/e2e-compat/precision-drag.spec.ts::jog: moves a trim end exactly one 10 ms step and saves it
-->

On the phone shell only (`daw-shell--phone`), a direct long press arms a fade
or trim handle on the timeline. Envelope points, pending start/end handles,
and every chooser chip grab keep the existing touch grammar drag (no
jog pad). `decidePrecision` chooses **direct** drag (with pointer ballistics:
slower finger motion moves finer steps) when one step is at least 4 px on
screen, or when the target and its neighbours are wider than a finger;
otherwise it opens the **jog pad** in the drawer's place. The pad maps finger
travel to timeline steps; sliding up while dragging slows the gain. **Done**
or a tap outside commits; a second finger cancels. Clip bodies, crossfade
grips and other targets keep the existing touch grammar drag.

Amended by #2294 (W3b2b, calebn, 2026-10-31): a suggestion's verbs are Cut and Keep on the Action bar, not Approve and Reject, and where the sheet has the Action bar and the suggestion has a cut, shorten or lower action (not a split or an exact range) the sheet drops its own Approve and Reject buttons; the verbs come from the Action bar (the dock on the phone), and a Cut (for a cut action) or Keep chosen there runs through the open sheet so its queued-timing lock and refine recovery still apply; a shorten or lower Cut applies the suggestion's own action after checking the sheet's busy reason. A split, an exact range proposal, a suggestion with no accept action, a comment-linked pending edit and a phone sheet with no dock (the compact drawer, the full sheet at a tight height) keep Approve and Reject in the sheet; the compact drawer's body shows no verbs (the review card sits at the top of the drawer body and does). The bar's primary verb follows the accept action alone, so a split or exact range that carries one still shows it on the bar. Amended again by #2294 (step 2b): the timeline overlay bar and the phone pinned chrome name the verbs Cut (Shorten or Lower) and Keep by `pendingOffersCut` (so on a phone sheet with no dock the card says Cut and Keep while the sheet body says Approve and Reject), and a shorten or lower Cut applies the suggestion's own action there as on the bar; a split, an exact range proposal and a suggestion with no or a leave action keep Approve and Reject. Hear before, Hear after and Seek to start come from the Action bar and the sheet's preview footer is dropped where the bar renders; the bar of a guest link with neither edit nor suggest capability (a Viewer link) has a plain Hear that plays the suggestion and no Seek row, while a Commenter with suggest capability has Hear before, Hear after and a Seek row.

### Proposed decision: The touch Select range toggle stays and teaches itself once

<!-- decision
id: D-range-toggle-tip
status: proposed
date: 2026-11-10
decided-by: issue #2294 implementation
evidence:
- #2294 G2, survey row D-39: keep the toggle, add the coach tip, remove nothing
- spec-edit corner-box hint, once on first touch use; the copy "Drag across a lane to select" is the lane owner's pick and not yet approved
enforced-by:
- gui/web/src/stage/edit/EditCorner.test.tsx::shows when the toggle arms and goes with the next press
- gui/web/src/stage/edit/EditCorner.test.tsx::stays quiet when the toggle disarms
- gui/web/src/stage/edit/EditCorner.test.tsx::raises nothing on a phone, where the Range sheet opens over the corner
-->

A finger cannot drag on an empty lane, so the Select range toggle in the Edit
corner stays. The first time a touch user on a tablet arms it, a one-line coach
tip says what the next drag does. On a phone the docked Range sheet opens over
the corner when it arms, so no tip is raised there. Disarming never raises it, and a second mounted corner
shows no duplicate because only the instance that raised a tip renders it.
The tip follows the rules in [Coach tips](interaction-system.md#proposed-decision-coach-tips).
