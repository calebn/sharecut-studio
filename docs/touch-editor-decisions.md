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

The Clip inspector now has **Move clip** beside Timeline. It opens a local
placement preview with a native **Target track** select and exact **Timeline
start (seconds)** field. **Earlier 10 ms**, **Later 10 ms**, and **Use playhead**
provide a time path without typing or dragging. **Apply move** saves through
`edit.moveClips` and the existing `MoveClips` History operation. **Cancel**, or
Escape inside the form, discards the draft. An unchanged Apply sends no command.
Selected clips move together through `computeClipMoves`, including its independent
zero-time and outer-lane clamps. Exact input bypasses drag magnets.

The local owner has idle, preview, and committing phases. Its token captures the
project path, epoch, edit basis, selection, anchor, and track order. The timeline
reads its placements through a local subscription and `laneMovePreview`; preview
never patches the project or creates a document delivery draft. The preview stays
visible while Apply waits for an earlier track save to finish. Invalidation,
unmount, backgrounding, permission loss, or a competing edit cancels only the
owned session. Apply rechecks the capture inside the track mutation queue before
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
creates no project write or document History. Phone retains Expand and Collapse
and has no Script divider. Coarse-pointer controls have a 2.75rem target floor.

Focused Vitest coverage lives in `edit/clipPlacement.test.ts`,
`inspector/views/ClipPlacementControls.test.tsx`, and the Script divider tests.
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
- #1337: the shown flat envelope line is a vertical target in the same grammar; long-press arms it, one-finger movement before arming scrolls, and a second finger cancels its unsubmitted draft
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
- gui/web/src/timeline/CreateMenu.test.tsx::says Split here cuts the selected tracks, not the held lane, and sets it apart from the lane's entry
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
- A tap selects and opens the peek strip. On a crowded spot it picks the most
  likely target.
- A long press arms a target, through the fan-out chooser when the spot is
  crowded. Only an armed target drags, and only along its own axes: an
  envelope point moves in time and level, an edge moves in time, and a clip
  body moves its clip in time.
- A long press on empty space opens a create menu: envelope point, split,
  marker, comment.
- This grammar is for touch. A mouse acts on press: it selects and drags at
  once with no arming, and a right click on a lane or target opens the same
  create menu, so desktop editing does not change by accident (#1793). The
  Menu key and Shift+F10 (`create.menu`) open it too: over the focused target,
  else at the playhead on the selected track, so a keyboard user needs no
  focusable lane or clip (#1877).
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
  command. `make generated-check` keeps its vocabulary equal to
  `TOUCH_GESTURES`, and `inputContract.manifest.test.ts` derives each
  command's column from the grammar (the create menu, the kinds' commands
  and the Gestures sheet).

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

The visible equivalent is Range actions' **Add word before**, **Add word
after**, **Drop first word** and **Drop last word**, which repeat while held, as
a strip nudge does (`transcript.extendRange`).

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
- A double-click or double-tap on a word, and Enter or F2 on a selected word,
  start Fix text. Typing never does: every letter stays a shortcut.
- On touch, a long press selects the word and shows the 44 px grips; moving
  on from the hold extends it under the finger, and it commits when the
  finger lifts. A finger that moves before the hold scrolls and selects
  nothing. A second finger cancels the drag and keeps the earlier selection.
- Esc, a cancelled or lost pointer or a window blur ends a drag without
  committing it. Leaving the pane does not: the pane holds the pointer, so the
  drag goes on selecting to the nearest word and commits on release.
- The browser's own text selection is off in the pane; the pane's copy event
  copies the selected words.

Changed from the rule above: a hold that does not move selects the word
instead of opening word correction, because Fix text now has its own gestures.
A finger may drift a few pixels, inside the 10 px slop, before the hold arms
without losing the drag.

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
trim. A touch trim drag commits like a mouse one. Both carry trusted manual intent
under D-manual-cut-intent, while structural limits remain mandatory
(`e2e-compat/touch-grammar.spec.ts`, #1154, #1403).

### Proposed decision: Edit chips zoom, join glyphs act, applied ticks stay inert

<!-- decision
id: D-edit-chip-zooms
status: proposed
date: 2026-10-22
decided-by: calebn
evidence:
- #2076: every edit type stays visible at any zoom, and joins that crowd each other fold into a count
- WCAG 2.5.8 Target Size (Minimum), the Equivalent exception: the 12 px glyph is under the 24 px target and its hit box is 24 px wide but only as tall as the gutter, so the same function (a join's mode and length) is also offered by the inspector's Join control at full size
- WCAG 1.4.11 Non-text Contrast: a glyph is the only visual identity of its button, so every type's hue must reach 3:1 against the tag face at every tier in both themes; the tiers shrink size and stroke weight and never dim
- WCAG 2.5.3 Label in Name and 2.4.3 Focus Order: the visible text leads the accessible name, Tab follows time, and focus survives a zoom that removes the focused mark
- The shipped rule in AppliedEditOverlay.tsx and gui-viewer.md: applied ticks are decorative because dense stacks cannot meet 2.5.8 as 24 px buttons
enforced-by:
- gui/web/src/timeline/editMarkers/plan.test.ts::keeps adjacent placed marks at least 24 px apart across zooms
- gui/web/src/timeline/editMarkers/EditMarkerLayer.test.tsx::names the group by count and type, and zooms to its span on click
- gui/web/src/timeline/editMarkers/EditMarkerLayer.test.tsx::draws a chip that cannot split as a count with no button to press
- gui/web/src/timeline/editMarkers/markContrast.test.ts::keeps every mark hue at 3:1 or better on the tag face in both themes
- gui/web/src/timeline/editMarkers/EditMarkerLayer.test.tsx::renders glyphs and chips in one time-ordered sequence so Tab follows time
- gui/web/src/timeline/editMarkers/EditMarkerLayer.test.tsx::moves focus to the chip a focused glyph merges into on zoom out
- gui/web/src/timeline/editMarkers/EditMarkerLayer.test.tsx::moves focus to the nearest remaining mark when a focused chip goes inert
- gui/web/src/timeline/editMarkers/EditMarkerLayer.test.tsx::shows 'Crossfade 120 ms' beside a wide glyph, hidden from assistive tech and leading the glyph's name
- gui/web/src/timeline/timelineStyles.test.ts::shrinks the tag as the real overlap grows, keeping the hit box, and motion respects reduced-motion
- gui/web/src/timeline/hitRouting.grammar.test.ts::stays a seek in the lane above, where the mark's box would reach
- gui/web/e2e/edit-markers.spec.ts::a touch in the lane above a glyph seeks
- gui/web/e2e/edit-markers.spec.ts::a tap beside a glyph delivered in Mobile Safari's event order opens the join and does not seek
- gui/web/src/timeline/hitRouting.grammar.test.ts::opens the join from the browser's click when a finger lands 20 px beside it
- gui/web/src/timeline/AppliedEditOverlay.test.tsx::has no axe violations with a selected seam tick
-->

Two touch targets join the timeline: a join glyph and an edit chip. Both
cover joins only. The plan (`timeline/editMarkers/plan.ts`) folds any joins
whose centres sit closer than 24 px (`CLUSTER_PX`) into one chip, so every
glyph and chip centre is at least 24 px from the next. A glyph tap acts the
same at every zoom: it opens the join popover (hit kind `join`). A chip tap
zooms to its joins (hit kind `edit-chip`, `zoomToSpan`) until the closest two
sit 30 px apart, centred on the chip, and the chip splits into glyphs. A chip
no zoom can split (the zoom ceiling, or joins an instant apart) is a plain
count, not a button. One target never has two meanings by zoom: a glyph's tag
may shrink as its crossfade draws at real scale (the wide tier), by size and
stroke weight only and never by opacity, so its hue keeps 3:1 against the tag
face in both themes; its button and 24 px hit area stay the same size and a
tap does the same. Glyphs and chips share one time-ordered tab sequence. When
a zoom merges the focused glyph into a chip, or a chip goes inert at the zoom
ceiling, focus moves to the chip now holding it, else the nearest remaining
mark. A glyph that draws a label is named with that text first ("Crossfade
120 ms join at 0:05.0"). The touch chooser names a chip "Edit
group".

A finger's tap that lands on no target (a bare lane or a non-movable clip) goes
to a glyph or chip within 22 px beside it and 44 px down from its top. It
never reaches the lane above, never applies to a clip that cannot move, never applies to a pending region or the envelope lane (they own their tap), and a
tap on any target (a trim handle, fade corner, roll seam or clip body) is
ranked as before, with a focused glyph no longer counting as selected. The
mark opens from the browser's own click, not from replayed pointer events
(#2148). A tap that has no target under the finger and is sent to a mark
(`tap` differs from `winner`) waits for the browser's click, which the iPhone
Simulator delivers on the lane after the press layer's press:
the router then replays one click on the mark, and the lane's seek ignores
that browser click once (`HitRouter.claimsClick`, a claim window of
`GHOST_CLICK_MS`). A browser click on the mark itself is left to the mark.
If no click arrives within `GHOST_CLICK_MS` the mark opens anyway, and a
browser click that comes after that window opens nothing more but does seek.
A new press within the window drops the pending open. A tap on a target (a
trim handle, fade corner, roll seam or clip body) keeps the pointer replay.

Applied ticks stay as the earlier decision left them: inert, `aria-hidden`,
and never inside a chip. Counting applied edits in a chip would make a count
that looks tappable and answers to nothing, so chips show joins only. The
owner can still ask for an inert "+n applied" count. Pending regions keep
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
- gui/web/src/ui/GesturesSheet.test.tsx::describes two-finger Undo as an optional ShareCut shortcut
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
| Select range: `useRangeGesture.ts`, `EditCorner` (was `EditToolStrip`, `EditingToolRail`) | Armed range drag; visible Select range mode, In/Out, lane controls and action card | Explicitly arm before drag. Draft is local until Cut/Mute/Comment/Bounce. Existing Cancel/Escape and permission paths own cancellation/failure; one accepted document operation uses existing History. The corner's Range arm (touch only, 44 px) and the numeric controls remain. | **Keep and clarify armed state through existing UI.** `contextual-range.spec.ts` covers exact targets and policy; phone dispatched events are synthetic as recorded in #878. |
| Clip move: `ClipBlockView.tsx`, clip move owner | Drag visible clip body/grip; click selects and modifier click extends selection | Owner previews destination before `MoveClips`; accepted changed release commits once; Escape, capture loss, blur, unmount cancel. Existing command permission and Undo apply. Move clip in the inspector previews time and track placement through native fields and pointer step buttons before Apply move or Cancel. | **Keep drag and add inspector placement.** `ClipBlock.test.tsx`, `edit/clipMove.test.ts`, and `inventory-audit.spec.ts` are the cited coverage. Exact 7/27-second persistence remained failed in the #878 record. |
| Trim, fade, roll and crossfade: clip handles, join controls, inspector | Drag visible edge/seam; native numeric/range fields and keyboard nudges | Local preview follows the active owner. Accepted changes use existing commands; Escape/cancel does not save. Save failures stay in current inspector error routes; accepted edits use document History. Touch and dense-target behavior vary by timeline width. | **Keep.** `fade-curves.spec.ts`, `crossfade-length.spec.ts`, `transitions-acceptance.spec.ts`, and `edit-boundary-precision.spec.ts` retain existing evidence. Do not add another gesture system. |
| Pending range, chapter, social markers: `MarkerLane`, pending inspector | Drag eligible visible handles/body; inspector numeric timing and Edit timing | Draft remains local before the existing command. Escape, lost ownership, blur, and unmount cancel owned previews. Host/guest permissions remain at current command boundaries; accepted edits are undoable. Phone dense pending handles can give way to Edit timing. | **Keep.** `pending-edge-controls.spec.ts`, `MarkerLane.test.tsx`, and #878 inventory cover named paths; not every interruption combination. |
| Join endpoint / transition length: join glyph and inspector | Select join; numeric transition length | Endpoint row is separated from neighboring actions. Numeric field is the exact visible equivalent; preview/save/failure follow current inspector command. Existing History applies to accepted edit. | **Keep.** `transitions-acceptance.spec.ts` checks saved bounds and Undo. Do not add rotate or hidden pinch. |
| Envelope points and creation: envelope overlay / #950 inspector | Existing point editing; creation is missing | Point selection/edit behavior remains in #950's ownership. Its future edit contract must define preview, apply/cancel, save failure, permission, History and narrow responsive behavior at that boundary. | **Keep point editing; route creation to #950.** This patch touches none of the #950-owned files or claims. |
| Script divider: `stage/edit/ScriptDivider.tsx` (replaced `BottomTabsSplitterView.tsx` and its Shorter/Taller/Reset buttons in #2292) | Drag separator; Arrow keys (Shift for 4 rem), Home/End, Enter or double-click reset | Existing separator owns preview and Escape cancellation; accepted view sizing may persist its preference but creates no document History. It remains a desktop/tablet surface with a 10 CSS-pixel measured pointer strip in #878. | **Keep drag and add native size buttons.** Keyboard resizing is the non-drag route; `ScriptDivider.test.tsx` is the evidence now that `splitter-recovery.spec.ts` and the size buttons are gone. |
| Track order and gutter: `RelatedCommands`, track reorder controller | Existing Move up/down buttons; reorder grip drag remains available where permitted | Move up/down are single-pointer buttons that invoke current track-order commands; command permission and Undo paths remain authoritative. If a selection has no related or overflow command, `RelatedCommands` renders no empty command region. The reorder grip owns drag preview/drop. No new gutter drag ownership, auto-scroll, or selection model. | **Keep Move up/down as the non-drag route and keep the reorder grip.** Source confirms the alternate action already exists; task-path comparison between the buttons and drag remains open. |
| Mix: `MixSheet`, native controls, `useCommitRange` | Native volume range and M/S controls; More → Mix | Volume follows the existing preview/commit lifecycle and permission reason; M/S and local/shared listening distinctions remain. Accepted host/editor volume writes use the existing document command. Sheet layout supports row scrolling and text wrapping. | **Keep.** Do not add swipe-to-mix. Existing `phone-mix.spec.ts` covers its current path; failure/cancel combinations not asserted there remain unverified. |
| Transcript words: transcript views and correction flow | Tap seeks; double tap or long press opens correction; visible Correct/Select modes | First tap seeks immediately. Correction opens only for a host with hydrated words; current sheet lifecycle restores mode on close. Submission uses `submitWordCorrection`; failure/permission behavior stays there. Phone uses the sheet for keyboard room; desktop has its current inline path. | **Keep.** `transcript-wordbar.spec.ts` and `edit-boundary-touch.spec.ts` are retained evidence. No delayed tap-to-seek recognizer. |
| Comment rows: Review queue | Visible Resolve/Reopen and Undo toast | Swipe-to-resolve was removed with the Comments panel (a queue row swipes right for its verb, left for Keep). Resolve is the card button, host only; latest-only Undo toast remains. | **Removed.** |
| BottomSheet: `ui/BottomSheet.tsx` | **Only the compact inspector's drawer drags and flicks** (its header, round 4b); every other sheet has no drag gesture. Expand/Collapse and Close are visible single-pointer actions on all of them | Controlled `expanded` updates half/full view state only (peek/half/full for the #1051 compact inspector, which also stows during a timeline drag). There is no command/failure/History path for resize. Close and Escape dismiss; the interactive inspector scrim never takes a touch, and it is clear at the strip and dims the timeline at half and full; confirmation scrim dismisses. Shell CSS keeps phone nav and tablet chrome clear. | **Remove inert grip; retain and enlarge the resize button.** `BottomSheet.test.tsx` and new touch E2E exercise the existing callback and layout. No global button changes. |
| Transport, Gestures help and History: phone More hub (removed in #2292), command catalog | Two-finger tap is an optional ShareCut Undo shortcut; visible command routes remain | Existing recognizer dispatches `history.undo` and reports failure through the shared status path. It runs only when enabled by current project/command availability. It does not make a platform convention or modal-body guarantee. History is an Edit sheet and Gestures is in the Project menu. | **Modify attribution only.** `useTwoFingerTap.test.tsx` stays unchanged; `GesturesSheet.test.tsx` asserts the rendered optional ShareCut copy. |

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
| Cancel/unmount/background/rotation/failure leave no stuck gesture; history cardinality is correct | **Scoped browser recovery passed** for native fade cancel, 403/422/409 rejection, abort/replay and Undo. Sheet actions send no document commands and leave project bytes and preferences unchanged. A long-press clip move interrupted by pointer cancel, lost capture, window blur, Escape or unmount saves nothing (`ClipBlock.test.tsx`), and rotating a phone mid-move ends it with no write while the same move left alone saves one `MoveClips` (`touch-move-rotation.spec.ts`, CDP touch, not hardware). A Mix volume drag cancelled or backgrounded (visibilitychange hidden, pagehide) returns the thumb to the saved value and sends nothing, and the change that follows is ignored; a drag blurred with no change returns to the saved value too, while a change right after a blur still commits (`useCommitRange.test.tsx`; jsdom, not hardware). iPhone Simulator proof of #1034 found WebKit committing the half-dragged value on backgrounding; the fix awaits a Simulator re-run. A rejected save restores the saved value in the store, which the thumb follows (`trackMix.test.ts`). Exact saved destinations: a mouse or pen drag of a clip from 7 s to 27 s saves one `edit.moveClips` with `timeline_start` exactly 27 (`TimelineView.test.tsx`, "saves the exact 7 s to 27 s destination"), a touch long-press move reports a `deltaSec` of exactly 20 (`ClipBlock.test.tsx`, "saves the exact 7 s to 27 s delta from a touch long press"), and the native non-drag 7/27 placement is unchanged (`non-drag-placement.spec.ts`). A second finger lifting after a saved touch move adds no second save (`ClipBlock.test.tsx`, "ignores a second finger lifting after the move saved"). Extra pointers: a second pointer on the clip body during a trim drag leaves the first pointer's single trim save intact (`ClipBlock.test.tsx`, "ignores a second pointer on the clip body during a trim drag"); a second finger during an armed range select cannot take, move, end or cancel the first finger's range (`useRangeGesture.test.tsx`, "range select with a second pointer"); a second pointer landing and lifting on a Mix slider mid-drag still commits the dragged value once, and a cancel from any pointer returns the thumb to the saved value and ignores its change (`useCommitRange.test.tsx`, "with a second pointer"). A trim drag cancelled by pointercancel, Escape or unmount saves nothing and ignores the lift (`ClipBlock.test.tsx`, "saves nothing when a trim drag ends in"). All jsdom, not hardware. Rotation and backgrounding of trim and range select, a second finger landing on the same trim handle, and other interruption combinations remain open (#1034). |
| 360 portrait, short landscape, tablet, desktop, themes, reduced motion and 200% text | **Automated cases passed** for 360×800 and 667×360 (the compact drawer's strip and half geometry), 820×1180 (the tablet card, a no-legacy-sheet case) and 1440×900 (no sheet), both themes and motion preferences. The 200% case doubles computed root font size and proves title/control geometry and half-height body scrolling. This is CSS emulation; native keyboard, safe-area, OS text scaling and physical reflow remain pending #301. |
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

A search of the source finds one gesture package, `@react-aria/interactions`
3.28.1 (Apache-2.0), in two files:

- `timeline/useTouchPress.ts`: `usePress` and `useLongPress` own a deferred
  touch until `HitRouter` decides what it was. `useLongPress` calls
  `HitRouter.longPress` after `LONG_PRESS_MS`; `usePress` ends the press on
  `pointercancel` and keeps the browser's click from reaching targets.
  `TimelineView` and `JoinEditor` use it.
- `timeline/TargetChooser.tsx`: `usePress` on the chooser's chip buttons, for
  the picked `pointerType`.

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
- gui/web/src/timeline/gestureGovernance.test.ts::adopts no gesture package beyond the React Aria press layer (#1078)
- gui/web/src/hooks/gestureConstants.test.ts::holds between Android's 400 ms default and iOS's 500 ms
- gui/web/src/hooks/gestureConstants.test.ts::is at least Android's 8 dp touch slop and at most iOS's 10 pt
- gui/web/src/hooks/gestureConstants.test.ts::holds for iOS's 0.5 s, a little above Android's 400 ms default
-->

Timeline touch recognition stays on native Pointer Events with the shared
constants in `hooks/gestureConstants.ts`. No gesture package is added:
`@use-gesture/react`, `@dnd-kit`, Hammer.js and Motion are not used for
gestures. The governance guard is a denylist of known gesture and pointer
libraries (`@use-gesture/*`, `react-use-gesture`, `@dnd-kit/*`, Hammer.js,
`react-swipeable`, `interactjs`, Motion, React Aria's other packages). It scans
every dependency field of `gui/web/package.json` and every import in non-test
source. A library not on the list passes, so add its name when a new one
appears. The one existing package, React Aria's press hooks in
`useTouchPress.ts` and the chooser chips, stays for now. It is 1.6% of the
bundle, and the approved phone behavior (#1051 rounds 4b to 6) was tuned with
it. Whether the router can own the press layer itself is a follow-up, because
moving it needs a phone check, which stays in #960. A library may still suit
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
envelope points, fade corners, trim strips, roll seams, join glyphs, edit chips, pending
edit edges and split flags, and chapter markers. Plain hit areas behind them
(lane seek, envelope lane, wide pending region, and the body of a clip that
cannot move) carry `HIT_SURFACE_PROPS`; the wide pending region and the
envelope lane carry `OWN_TAP_HIT_SURFACE_PROPS`, so a finger's tap on them stays
theirs and never redirects to a join glyph beside it. A movable clip's body is the `clip`
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
- **Stacks.** Pins whose dots overlap at the current zoom draw one dot with the
  stack's count (`data-stack-count`). A long press fans them out in the
  chooser, each chip named for its author and its time; a mouse click on a
  stack steps to the next pin after the selected one. A keyboard activation or
  a chooser pick opens exactly the pin it named.
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
`stage/edit/useCompactInspector.ts` decides this for both shells. Where the
Inspector is a [column](#decision-the-inspector-is-a-column-on-a-short-wide-touch-screen),
at least 40rem wide on a coarse pointer, there is no strip: the measurements
below for 800×360 and 844×390 sideways are the strip's, before the column.

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
  at a 32 px root font), so a folded frame's compact sheet drops its half
  detent where half the slot cannot hold the one-row chrome and a touch row
  (R-short-11, `halfDetentFits`): it opens at full, and a stored half shows as
  full. Expand, Collapse and Close stay on screen. The drawer has one bounded body scroller. Native focus reveal
  brings the active field and its complete label below the pinned header when
  the label fits; the sheet scrolls within its own content instead of measuring
  a dynamic scroll-padding value (`focusAndReveal`, `revealBelowChrome`).
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
peek strip below describe where it opens, not when.

On a coarse primary pointer at most 40rem tall and at least 40rem wide, the
selection Inspector is a column on the inline end of the shell, not a bottom
sheet. One hook (removed in #2294 W3a) owned the three conditions; below 40rem
wide, in portrait, and with a fine pointer the sheet or compact strip stays.
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
the phone upright shows the full Inspector, not the peek strip.
This replaces the lane band and the compact strip on those screens, and no
other. A gesture that needs the compact strip's Undo header does not exist
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
- gui/web/src/stage/edit/useInspectorOpen.test.tsx::peeks only on the phone's lanes
- gui/web/e2e/inspector-sheet-drag.spec.ts::a 667x375 phone shell gets the Inspector sheet and no column
supersedes: D-inspector-column
-->

On the phone shell (up to 767 px wide, `PHONE_MAX_PX`) the Inspector is the
Inspector sheet (dock, half, full) whatever the orientation; the tablet and
desktop shells, which include a wider phone held sideways, get the card beside
the selection.
A timeline target on the phone still opens the peek strip until the legacy
bodies are replaced.

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

The strip covers the Player bar again. Its header keeps the shared Undo and
Redo controls visible at peek, half and full height. The rail and header use
one authorization check, one unavailable-action message and the existing
`history.undo` / `history.redo` command bus path, including its wait for this
tab's edit saves (it queues behind a save that is still out, says "Undo runs after save", and never refuses for the wait). History controls stay
at least 44 CSS pixels square and do not overlap the resize or Close controls.

The blade confirmation sheet this round fitted was removed in #2294: Split cuts at once and the toast carries Undo.

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
with a finger at 360×800 and 636×390 (the 844×390 it used moved to the column, #1696) and checks that the finger lands on the
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
636×390 (844×390 before #1696). On the round 3 build the row covered the strip's bottom edge.

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
  back. A successful manual trim sends once with trusted interactive intent
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
360×800 and 636×390 (844×390 before the column, #1696) in both themes the pending and envelope rows have 44 px
targets in view and no axe violations.

### Touch grammar round 4b (#1051)

Round 4b builds the grammar on the 4a branch. It shipped behind the touch
chooser lab until the owner made it the default (2026-10-07).

- **Arming.** A long press (`LONG_PRESS_MS`) on one target arms it, if its
  contract gives it an axis, or selects it (a join glyph, a pending split).
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
  ("00:30.000 · Avery"). Entries: **Split here** first, then **Add
  chapter** and **Add comment**, then, below a divider, **Add envelope point**
  (with the level it adds at, on the held lane) (#2294 W1b: the menu is how a
  touch user splits on a lane, and Split heads it). Split here cuts the
  selected tracks, else every dialogue track, so it carries a line saying
  which ("Cuts all dialogue tracks", "Cuts Avery, Blair") and does not sit
  with the held lane's entry.
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
and every chooser chip rest-to-grab keep the existing touch grammar drag (no
jog pad). `decidePrecision` chooses **direct** drag (with pointer ballistics:
slower finger motion moves finer steps) when one step is at least 4 px on
screen, or when the target and its neighbours are wider than a finger;
otherwise it opens the **jog pad** in the drawer's place. The pad maps finger
travel to timeline steps; sliding up while dragging slows the gain. **Done**
or a tap outside commits; a second finger cancels. Clip bodies, crossfade
grips and other targets keep the existing touch grammar drag.
