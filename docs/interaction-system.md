# Interaction system

This document is the grammar for how a person acts on ShareCut Studio and how
the UI answers. It names one path for each kind of interaction, where that path
is declared, and the checklist a new interaction passes before it ships. It
governs `gui/web/` on every shell (desktop, tablet, phone) and every input
(pointer, touch, keyboard, assistive technology).

It sits under three documents and does not repeat them. The
[UI philosophy](ui-philosophy.md) states the trust requirements and wins on
conflict. The [communication philosophy](communication-philosophy.md) owns
voice, the Terminology table, control placement and the mobile checklist. The
[touch editor decisions](touch-editor-decisions.md) own the touch input grammar
and the visible-equivalents rule. Styling lives in
[design tokens](design-tokens.md) and
[`.agents/rules/gui-styling.md`](../.agents/rules/gui-styling.md).

Each rule below is a **requirement**. Where the code already does it, the rule
names the file. Where it does not, the rule names the gap under
[Shipped gaps](#shipped-gaps).

## The path of an intention

Every interaction travels the same path. A rule applies at each step.

```
input  →  target  →  command  →  mutation  →  feedback
```

1. **Input** is a key, a pointer press, a touch gesture, a menu item, a palette
   row or a button. Input never changes the project. It resolves to a target
   or runs a command.
2. **Target** is what the command acts on. It comes from an explicit argument,
   then from the selection, then from focus. A command that needs a target and
   finds none is disabled with a reason. It never guesses and never runs
   silently.
3. **Command** is the one place an action is defined. Buttons, menu items,
   palette rows, keys, gestures and status chips all call the same command.
4. **Mutation** goes through the document command path and History. One user
   gesture is one undoable step.
5. **Feedback** says what happened, in one channel, with Undo beside it when
   the step can be undone, and leaves with the surface that raised it.

## Registries

Each thing is declared once. A second map from the same key is a bug.

| Thing | Declared in | Locked by |
| --- | --- | --- |
| Command (`id`, `label`, `shortLabel`, `variants`, `category`, `when`, `paletteRunnable`, `breaksFollow`) | `gui/web/src/commands/catalog.ts` (`COMMANDS`), types in `commands/types.ts`, predicates in `commands/context.ts`, names read through `commands/labels.ts` | `commands/governance.test.ts`, `commands/labelParity.test.ts` |
| Shortcut | `gui/web/src/keymap/registry.ts` (`KEYMAP_COMMANDS`, and `SHARED_KEY_ORDER` for a key more than one row binds); the only window `keydown` listener is `keymap/listener.ts` | `commands/governance.test.ts` (second listener fails), `keymap/sharedKeys.test.ts`, `make cheatsheet-check` |
| Touch hit kind and gesture | `gui/web/src/timeline/inputContract.ts` (`HIT_KINDS`, `TOUCH_GESTURES`), routing in `timeline/hitRouting*.ts`, thresholds in `hooks/gestureConstants.ts` | `timeline/gestureGovernance.test.ts`, `inputContract.conformance.test.ts`, `inputContract.manifest.test.ts` |
| Edit marker kind (join, pending and applied: type, label, mode options and the join label with its length). A new type adds its `EDIT_MARKERS` row (the `satisfies Record<EditMarkerKind, ...>` makes a missing row a type error) and a `--color-mark-<type>` token in each theme block, plus the CSS rule of each surface that draws it (`.sys-seam-diamond`; `.pending-overlay.<variant>`; `.applied-tick--<variant>`). These are hand-wired, so a missed one is caught by review: a new `EditType` member; for a pending type, its `PENDING_KIND_OF_TYPE` entry (without it the type draws as a cut); for a join type, `joinKind`; for an applied tick, `appliedKind` | `gui/web/src/utils/editMarkerRegistry.ts` (`EDIT_MARKERS`) | `utils/editMarkerRegistry.test.ts`, `edit/joinRender.test.ts` |
| Selection kind and its surface | `gui/web/src/inspector/selectionSurface.tsx` (`SelectionKind`, `SELECTION_SURFACES` with `body`, `screens`, `related` and `more`) | `selectionSurface` tests, `stage/edit/useInspectorOpen.test.tsx` |
| Capability (GUI, command, keys, touch, MCP, CLI, skill) | `contracts/capabilities.manifest.json` | `make generated-check`, `commands/manifestSurfaces.test.ts` |
| Term | `docs/communication-philosophy.md` § Terminology | review (advisory docs-sync row `user-facing-copy-and-controls`) |
| Job result feedback | `state/uiSlice.ts` owns unidentified start tokens and one tagged feedback record per real ID. `runAnnouncedJob` binds and hands off owned outcomes. One shell transaction observes, publishes and consumes feedback. | `state/runAnnouncedJob.test.ts`, `hooks/useJobStatusAnnouncement.test.tsx`, `stage/hosts/DeliverHostAnnouncements.test.tsx` |
| Deliver loudness | Episode file uses the shared toggle buttons and the host export provider holds the next choice. Export snapshots it. Feed repair always uses Project default. | `stage/hosts/DeliverHostLoudness.test.tsx` |
| Token (color, space, type, z role) | `gui/web/src/styles/theme/`, `deploy/brand/brand-tokens.css` | Stylelint, `tests/test_css_policy.py` |

## Selection

1. **One store.** The selection is one value with one `kind` and one `id` set.
   Track focus, clip focus and range are views over it, not sibling stores.
2. **One kind per target.** A tapped word is one kind. Extending it to a range
   changes the kind once. Two kinds for one target means two inspectors, two
   sheets for the same thing.
3. **One table.** `SELECTION_SURFACES` is the only map from kind to inspector
   body and sheet screens. Phone and tablet read the same `screens`; a kind that opens
   on tablet opens the same way on phone.
4. **Selection survives mode and shell changes.** Switching Timeline to Text or
   rotating the device keeps the selection. Only an explicit clear or a new
   selection replaces it.
5. **Selection is visible.** Every selected target shows its state on the
   canvas and names itself in the inspector header or sheet title using the
   Terminology table word.
6. **Completed review releases its target.** A completed single-edit Approve or
   Reject clears its captured selection when the reply reports an affected edit,
   even if document adoption follows later. It also clears when the target is
   already absent. Queued work and a zero-effect reply with the target still
   present keep selection. A newer selection or document lifetime is untouched.

Shipped: `state/selectionSlice.ts` is the only writer of `selection`, and
`state/selection.ts` derives the clip and track sets from it. `selectionSurface.tsx`
is the one table for phone, tablet and desktop (#1792).
The Script keeps an open Fix text field when the shell remounts (a held pin, per project), so rotating across the phone and tablet shells keeps the word and its field (#1870). A blur saves the correction and leaves focus on the destination the user chose. Enter and Escape return focus to the edited word while the field still owns focus. Tab advances focus and selection to the next unsure word only when it saves a change; unchanged Tab keeps the existing close-to-current-word behavior. `ScriptHost.fix.test.tsx` covers these focus rules.
In a word's Inspector body, the correction fields and Apply precede the
secondary word controls and metadata. The full word remains the accessible
heading even when its visible title is shortened to one line. The range's verbs live on the Action bar (floating beside the selection on desktop and tablet, docked above the Player on a phone); a verb with options (`BarItem.split`) gets a chevron that opens an anchored popover on desktop and tablet, and on the phone dock a More row that opens the same options in a content-height sheet; the Range fields keep In and Out and the word handles, first.
Reordering these sections preserves their component identity and local drafts
(`#2163`, `stage/edit/selectionSurface.test.tsx`).
The span and tracks typed for a range not yet formed live in `rangeDraft`; it is
draft UI state, not a selection, and `commitRange` turns it into one.
`utils/pendingReviewPass.ts` owns single-review completion for the inspector and
timeline overlay. `timeline/PendingEditOverlay.test.tsx` covers delayed document
adoption and reply-head Undo through both entry points.

## Targets

1. `resolveTrackId` in `commands/targets.ts` is the pattern: explicit argument,
   then selection, then focused track, then nothing.
2. A command whose `when` is false renders disabled with a `disabledReason`
   that says what to select or open. `Button`, `ToggleButton` and
   `CommandButton` have no native `disabled` (#1444). A control that cannot
   say why it is off does not ship.
3. A target picked by touch is **armed** first (the long press), then acted on.
   The armed state is announced (`timeline/touchGrammar.ts` `announceArmed`)
   and cleared when the gesture ends or the surface changes.
4. Mouse acts on press. That is the current desktop grammar and a decision in
   `docs/touch-editor-decisions.md` must say so before any change to it.

## Actions and menus

1. **A visible action is a command.** `CommandButton` and `CommandMenuItem`
   take a command id. A plain `Button` with an inline handler is for local UI
   state only (open, close, expand) and never for a project change.
2. **One menu primitive.** `ui/Menu` with `MenuItem` and `MenuSection` is the
   menu primitive; the two hand-built menus left are listed under Shipped
   gaps. It lives in the top layer (`ui/topLayerFloor.ts`),
   supports arrow keys, Home and End (`ui/useMenuKeyboard.ts`), closes on
   choose and on Escape, and returns focus to its anchor. A one-of-many
   choice passes `checked` to `MenuItem`, which makes it a `menuitemradio` with
   `aria-checked` (the Session target chip's menu); a plain action leaves it out.
3. **Context menus come from one descriptor.** The create menu a long press
   opens on touch and the context menu a right click opens on desktop render
   the same descriptor. A touch gesture that opens a menu has a right-click
   twin, and both have a keyboard route (Menu key or Shift+F10, the `create.menu`
   command: over the focused target, else at the playhead on the selected
   track).
4. **Menu items name the command.** The item label is `CommandDef.label` and
   the item shows the shortcut from the keymap outside the phone shell. Phone
   menus hide the visible keyboard hint while keeping the shortcut available
   to keyboard users. A disabled item carries its reason the same way a button
   does.
5. **Menus hold choices, not state.** A menu does not host inputs or
   long-lived toggles. Those are a sheet or a panel.

## Dialogs, sheets and confirms

There are three overlay primitives.

| Primitive | Use | Desktop | Phone and tablet |
| --- | --- | --- | --- |
| `Menu` | Transient choice | Anchored popover in the top layer | Same, with the touch item height |
| `Dialog` | A task with inputs and a primary action | Centered modal | Bottom sheet with the primary pinned above the home bar |
| `InlineConfirm` | A destructive step confirmed beside its control | In place, Keep first, danger last | Same |

1. **One at a time.** A sheet closes before another opens. Stacking is a bug.
   `askConfirm` (`feedback/ask.ts`) renders through `Dialog`, so
   it obeys the same rule.
2. **Sheets have three zones** on phone: a header with the title and Close, a
   scrolling body, and a footer with the primary and secondary actions
   ([`docs/gui-mobile.md` § Selection sheet: three zones](gui-mobile.md#selection-sheet-three-zones)).
   Doing controls never sit in the top zone. A pushed step's Back is
   navigation, not doing: it sits before the title (`Dialog` `headerStart`,
   the Help sheet's report step).
3. **One gate for shortcuts.** `overlayOpen()` in `ui/modalGate.ts` is the
   only predicate. While a menu is open the keymap runs nothing; while a
   dialog is open it runs only the handoff list the dialog declared with
   `modalGate` (`shortcuts`), and Escape belongs to the overlay. The listener
   does not keep its own list of dialogs.
4. **Dismissal is the same everywhere.** Escape, the Close button and a tap on
   the scrim all cancel. Focus returns to the control that opened the overlay.
   Closing a selection Inspector leaves layout intent unchanged. Current intent
   and viewport determine whether editor panels return or remain stowed.
5. **One confirm primitive each.** `askConfirm` is the confirm dialog and
   `InlineConfirm` the in-place confirm; the one confirm-shaped dialog that
   is not `askConfirm` is listed under Shipped gaps. Split cuts at once
   on every shell, with Undo on the toast. A dialog anchored beside its
   control (the join editor) passes `anchor`; it is non-modal, in the top
   layer, and closes when a modal opens.
6. **Confirms say the consequence.** The primary names the outcome ("Remove
   track"), the secondary is "Keep", and the body names what is lost. A
   `window.confirm` fails lint (`no-alert`).

## Feedback

1. **One channel.** `announceStatus` (`state/uiSlice.ts`) owns ordinary
   feedback. Job result batches use the same private feedback writer. It renders the toast
   (`feedback/FeedbackToast.tsx`) and speaks through the one shell live
   region (`ui/StatusLiveRegion.tsx`). A panel does not mount its own toast or
   its own `aria-live` region. The comment Undo toast and the Needs attention
   announcement speak through it too. Floating placement uses the card's horizontal
   footprint. Visible comment and guest-name fields that intersect it take
   protection priority when a clear position fits (`feedback/toastDock.ts`,
   #2199, #2221). If no clear position fits, the existing fallback can cover a
   control. See [Feedback toast](gui-mobile.md#feedback-toast) for the measured
   320x300 limit and the Dismiss or resize workaround.
   Export (Deliver and in place) reserves result ownership before their start POST. Generic
   success waits only on the original potentially matching starts. Exact-ID
   binding replaces that generic candidate with an owned follow; only a verified
   result can then announce success for that ID.
   Released external successes keep their observed copy after chip movement.
   Fresh chip copy and ready outcomes share one live-region write. A receipt
   failure replaces progress for its own job, while unrelated copy survives.
   Only verified result fragments enter the success toast. A job's `summarizeResult` may add a toast action (Reveal, Download); the toast carries it only when exactly one verified outcome reaches it; results combined into one toast carry none. Receipt failures
   use the existing failure row while mounted and reach the shell live region
   even away from Deliver. Each distinct owned outcome is delivered even when its text matches
   the previous outcome. Resource changes do not replay an unchanged chip.
   Bound abort and follower failure keep the exact ID unverified until project
   reset. Spoken-history eviction cannot make that ID eligible for success.
2. **Undo rides with the result.** Every mutating command passes `undo` to
   `announceStatus`. The toast's Undo is the same History step the Undo button
   runs. A change History does not record (a comment resolve) passes `reverse`
   instead, and the toast's Undo runs it. `commands/undoToast.test.ts` walks
   every catalog command flagged `mutates` and fails on one with no proof.
3. **Status and error are two styles of one component.** An error names the
   failure and the next step. A status names what changed. They never share one
   look. `announceStatus` takes `tone: "error"`; the toast replaces an
   environment variable name, a path or an id in the message with the next
   step.
   `ui/Toast` takes an optional decorative `icon` before the message and an
   `undoLabel` when "Undo" alone is unclear ("Undo all" on a merged toast).
4. **Feedback belongs to its surface.** A message about a gesture, a selection
   or a panel clears when that gesture ends, that selection changes or that
   panel closes. A gesture's message passes `gesture: true`, and ending the
   gesture or changing the mode clears it. Only job progress and save state persist across modes, and
   they live in the status row.
5. **Empty states carry the action.** `ui/EmptyState` shows what the area is
   for and the one control that fills it. It never tells the person to go
   somewhere else.
6. **A recovery action does the thing.** A button named "Inspect History"
   opens History on every shell.
7. **Internals stay out of copy.** No environment variable names, ids, file
   paths or stack text in a toast, banner or empty state. A truncated sentence
   is a bug.
8. **A toast clears itself.** It stays 6 seconds (10 with Undo) and waits
   while hovered, focused, or with Undo unable to act. A card the browser
   reports as clipped waits at most 6 seconds more, so a short viewport or
   an expanded Safari toolbar never strands it. A ratio of 0.95 or more counts
   as fully shown.

### Proposed decision: Coach tips

<!-- decision
id: D-coach-tips
status: proposed
date: 2026-11-10
decided-by: issue #2294 implementation
evidence:
- #2294 G2, survey row D-16: spec-edit DLG-GESTURES gives each touch gesture one line, 240 px at most, dismissed by any action, never repeated
- Undo tip trigger broadened from the first Cut to the first undoable edit (D-late-12, a default the owner can override)
- #3554 trim tip: a fixed overlay at the clip's start, not a CoachTip around the anchor and with no arrow, because inside the clip it spilled under neighbours, was spent unseen when the start was scrolled off and overflowed at 200% text (D-late-18)
enforced-by:
- gui/web/src/utils/coachTip.test.ts::holds the four lines the spec names
- gui/web/src/system/useCoachTip.test.tsx::goes on the next press elsewhere and is remembered
- gui/web/src/stage/frame/StageFrame.test.tsx::says nothing on a tablet, where two-finger tap does not undo
- gui/web/src/system/ScriptPane.select.test.tsx::draws the hint beside the grips, hung off the pane
- gui/web/src/system/handleHintPlace.test.ts::flips above the start grip when the end sits near the foot of the view
- gui/web/src/system/handleHintPlace.test.ts::returns null when the tip is taller than what is on screen
- gui/web/src/timeline/ClipBlock.test.tsx::shows beside the start handle when a touch selects the clip, and stays through the press
- gui/web/src/timeline/ClipBlock.test.tsx::says nothing when the touch lands on a clip that was already selected
- gui/web/src/timeline/ClipBlock.test.tsx::does not raise, and is not spent, where no spot shows all of it
- gui/web/src/timeline/ClipBlock.test.tsx::lets go, unseen, when the clip starts to move, and stays gone after the drop
- gui/web/src/timeline/trimHintPlace.test.ts::returns null when no spot shows the whole tip
- gui/web/src/timeline/trimHintPlace.test.ts::fits exactly against each edge of the view
- gui/web/src/timeline/TrimHint.test.tsx::is placed again when the lanes scroll or the window resizes
- gui/web/e2e/coach-tips-real-app.spec.ts::selecting a clip shows the tip clear of its handle, a press clears it, it never returns
-->

A touch user sees each gesture hint once, at the moment of first need.
`utils/coachTip.ts` owns the copy (`COACH_TIPS`), the seen flag and the one slot;
`system/useCoachTip.ts` is how a surface raises its tip.

| Tip | Raised by | Shown at |
| --- | --- | --- |
| Drag the edges to trim | the first touch that selects an editable clip | drawn on the screen and portaled to `main`, not inside the clip: at the selected clip's start, above it, else below it, else over it past the handle, held inside the lanes' visible window |
| Drag the handles to adjust | the first touch selection in the Script | beside the end grip, in the pane's text |
| Two-finger tap to undo | the first toast that offers history Undo, on the phone shell only | at the header's inline end, below the stage's control bar, so no header control or the surface switch is covered |
| Drag across a lane to select | the first press that arms the Select range toggle, on the tablet and desktop shells | over the toggle |

1. **Touch only.** `show()` does nothing unless the store's `pointerKind` is
   `coarse`. A mouse or pen never sees a tip.
2. **One at a time.** The slot holds one tip and the instance that raised it. A
   raise while the slot is taken is dropped. The range and handles tips come
   again at the next qualifying event; the Undo tip is raised once per toast, so
   a refused raise waits for the next undoable toast. The handles tip frees the
   slot, unseen, when its selection clears without a press. The trim tip frees it,
   unseen, when its clip starts to move or no spot shows all of it. The Undo tip also
   waits while a guest's Role chip hint is up, since both sit at the header's
   edge.
3. **Dismissed by any action.** The next pointer press or key outside the bubble
   (a modifier or Tab on its own does not count) dismisses it, as does its close button and a press on its anchor. The hook
   listens in the capture phase so the press that raised the tip does not
   dismiss it.
4. **Never repeats, per browser.** The flag is `sharecut.coachTipSeen.<id>` in
   `localStorage`, not synced. Blocked storage costs a reload, never a repeat in
   the same session.
5. **Teaches only where the gesture works.** The Undo tip needs the phone shell
   and an editor, the same gate as `useTwoFingerTap`. It anchors to the header,
   never to the toast, so the toast dock can move without touching it.
6. **Within 15 rem.** Every tip caps at `min(15rem, 90vw)`, the Undo tip
   included. At large text the line wraps rather than overflow the frame.
7. **Covering no control or handle.** On a phone, arming the range toggle opens the
   docked Range sheet over the corner, so the range tip is not raised there and
   is not spent. The Undo tip covers no control (`e2e-storybook/coach-tip.spec.ts`).
   The trim tip is drawn on the screen, outside the clip, so no lane or the
   ruler hides it. It never lies over the start handle and wraps inside the
   lanes' window at large text, but it can cover part of a neighbouring lane's
   clip, and the window ignores the floating action bar and bottom sheets. It is
   not raised, nor spent, when no spot shows all of it. Its close button hands
   focus back to the clip. A press on the bubble stops there and never reaches
   the clip.

The owner can still narrow the Undo tip to the first Cut by changing
`undoTipMoment`; toasts now carry a `kind`.

Back-to-back plain edits of one kind (cut, delete, split) fold into one toast.
A producer passes `kind` to `announceStatus`, and `mergedEdits` in
`state/uiSlice.ts` (called from `feedbackPatch`) folds the new edit into the
standing toast when both are status toasts of that kind, the new edit follows
the standing one in History, and neither carries an action, a gesture or a
`reverse`. The same entry never folds twice, and the 25th edit is the last: the
next one starts a new toast. A fresh toast id restarts the Undo lifetime. The
live region speaks the new edit's own message; the visible text is the count.

## Keyboard and touch equivalents

1. **Every command reachable by a gesture is reachable by a key or a visible
   control.** This is `D-touch-visible-equivalents`. The visible control is in
   the bottom zone on phone and tablet.
2. **Every key is in the keymap.** No component adds a `keydown` listener on
   `window` outside the modules `commands/governance.test.ts` allowlists
   (`ui/useMenuKeyboard.ts` is one). Component-local keys (arrow keys inside a
   menu, Escape inside a field) stay inside that component.
3. **Dispatch order is declared.** When two commands share a key, the keymap
   declares the order in `SHARED_KEY_ORDER` and the listener runs it; a new
   shared key fails `keymap/sharedKeys.test.ts` until it is placed. A comment
   is not a declaration.
4. **One touch grammar.** `HIT_KINDS` and `TOUCH_GESTURES` cover every
   draggable in `gui/web/src/`, not only the timeline. A surface that keeps a
   different gesture (splitter, reorder grip, fader, Listen
   scrub) is a line in `SURFACE_GESTURES` in
   `timeline/gestureGovernance.test.ts` naming the decision it keeps.
5. **Focus is visible and ordered.** Tab order follows reading order; the focus
   ring is never removed; Close and Escape return focus to the opener. An
   anchored dialog may opt into preserving an outside control's focus when
   that control dismisses it.
6. **Targets are 44 px** on coarse pointers. The dense-target exceptions are the
   ones `gui/web/e2e/touch-floor.spec.ts` names and no others.

## Names

1. **One label per command.** `CommandDef.label` is the visible name on the
   button, the menu item, the palette row and the manifest. A short form for a
   narrow control is `shortLabel` on the same `CommandDef`, declared once. A
   name a control takes when its state or target changes (Ignore turns into
   Restore) is a `variants` entry on the same `CommandDef`. `CommandButton` and
   `CommandMenuItem` render the label by default and the short form with
   `short`; chrome that is neither reads `commandLabel(id)`.
2. **The accessible name is the visible name.** `aria-label` only adds what the
   visible text omits (an icon-only button says the label; a toggle says its
   state).
3. **Nouns come from the Terminology table.** A new noun lands in
   `docs/communication-philosophy.md` § Terminology in the same PR.
4. **Status reads as a sentence, not a `Label: value` chip.** "Saved to
   project", not "Save: ok".

## Shells and placement

1. **One frame, one command set.** `StageFrame` renders the desktop, tablet and
   phone shells from the same stage hosts and exposes the same commands. A
   shell may hide a command behind a menu or a sheet; it never lacks a route
   to it. The palette (`?` or `/`) reaches every command.
2. **Phone stages** are Record, Prepare, Edit, Review and Deliver, in the
   bottom tab bar. Edit switches between a Timeline and a Script surface; a
   tool or control that exists on one has a route on the other (the eye popover
   or the Project menu).
3. **Bottom zone for doing, top zone for context.** The Player bar, the tab bar,
   selection sheet and primary actions sit at the bottom on phone and tablet.
   Instructions for an armed gesture sit in the sheet, not in a card at the top.
4. **Icon-only controls are named.** Every icon-only control in the Edit corner
   and the Player bar has an accessible name and a tooltip, and its reason when
   it is unavailable. The touch long-press label peek (`useRailLabelPeek`,
   #1878) went with the tool rail. The long-press on Hear original opens the
   hear menu instead.
5. **Panel tabs are a tablist.** `role="tablist"`, `role="tab"`,
   `aria-selected`, arrow-key movement. The list has `tabindex=-1`, so direct focus adds no sequential Tab stop.
   Focusing or clicking its padding forwards focus to the selected enabled tab,
   or the first enabled tab if no selected enabled tab exists. Focus alone does not select or
   run a command; arrows still select, and Tab continues to the next control.

## Where primitives and tokens live

| Need | Use | Not |
| --- | --- | --- |
| A button that runs a command | `ui/CommandButton` | `<button onClick={() => store.set…}>` |
| A toggle with state | `ui/ToggleButton` with `aria-pressed` | two buttons |
| A menu | `ui/Menu`, `ui/MenuItem`, `ui/MenuSection`, `ui/CommandMenuItem` | a `<div role="menu">` |
| A dialog or sheet | `ui/Dialog` (sheet on phone and tablet) | `ui/BottomSheet` directly, a custom popover |
| A destructive confirm | `ui/InlineConfirm` | `askConfirm` for an in-place choice, `window.confirm` |
| A question with text input | `ui/Field` in a `ui/Dialog`, or a popover on its surface (Home's Open other…) | a bespoke dialog |
| A disabled control | `disabledReason` | `disabled` |
| A form field | `ui/Field`, `ui/FieldRow`, `ui/InlineError` | a bare `<input>` with a sibling `<span>` |
| Feedback | `announceStatus` with `undo` or `reverse` | `ui/Toast` in a panel, a local `role="status"`, a second `StatusLiveRegion` |
| An empty area | `ui/EmptyState` with its `action` | a paragraph |
| A drag | a hit kind in `timeline/inputContract.ts` and `useLongPress` | an ad-hoc `pointerdown` handler |
| A color, space, size or z value | `var(--…)` from `styles/theme/` | a literal |

### Marker lane gestures

`system/MarkerLane` owns a marker's press through its actual rendered hit button. `timeline/MarkerLaneHost` supplies authoritative source times separately from preview geometry. Pointer input and held arrows cancel if the source span, duration, zoom, window start or editability changes. An identical source refresh and the host's own preview preserve the gesture. Arrow release and ordinary keyboard blur commit once. A held pointer drag cancels when its marker loses focus. Escape, invalidation and unmount cancel. Keyboard movement uses the same whole-span bounds as pointer movement and reverses immediately at a boundary.

Inline chapter naming executes `edit.addChapter` with `{ atTime, title }`. Menu and playhead additions keep the generated title when `title` is absent. Invalid explicit names produce no pending flag, visibility change or request. One command owns pending state, undo feedback and project-lifetime checks. Markers visibility also controls clipping rendering and reserved row height; comments remain independent.

| Marker contract | Owner | Enforcement |
| --- | --- | --- |
| Captured gesture source, bounded movement and cancellation | `system/MarkerLane.tsx`, `timeline/MarkerLaneHost.tsx` | `system/MarkerLane.test.tsx`, `timeline/MarkerLaneRegression.test.tsx` |
| Shared named and generated chapter addition | `commands/chapters.ts` | `commands/addChapter.test.ts`, `timeline/MarkerLaneRegression.test.tsx` |
| Rendered marker hit ownership | `timeline/MarkerLaneHost.tsx` | `timeline/inputContract.conformance.test.ts` |

## Checklist

A new interaction, or a change to one, passes every line. A line that does
not apply is answered "n/a" with the reason in the PR.

- [ ] It is a `CommandDef` in `commands/catalog.ts` with `label`, `category`
      and a typed `when`.
- [ ] Its label is the one visible name on every surface; a `shortLabel` is
      declared on the same entry if a narrow control needs one.
- [ ] It has a keymap entry, or the PR says why it has none.
- [ ] It has a touch gesture in `inputContract.ts`, or the PR says why it has
      none. A gesture has a visible equivalent in the bottom zone.
- [ ] If it selects, the kind is in `SelectionKind` and `SELECTION_SURFACES`,
      and Related derives from that row.
- [ ] If it needs a target, it resolves target → selection → focus and is
      disabled with a reason otherwise.
- [ ] If it opens an overlay, it uses `Menu`, `Dialog` or `InlineConfirm`;
      the overlay is a sheet on phone and tablet; one overlay at a time.
- [ ] If it opens a menu on touch, the same descriptor opens on right click
      and on the keyboard.
- [ ] If it mutates, it goes through the document command path and
      `announceStatus` with `undo`.
- [ ] Its feedback clears with its surface. Its error copy names the next
      step and contains no internals.
- [ ] A caller-owned job result reserves ownership before start, binds only the
      returned ID, and cannot announce generic success before verification,
      including after abort, follower failure and spoken-history rollover.
- [ ] A job batch retains fresh chip copy and unrelated ready outcomes, replaces
      same-job progress with receipt failure, and toasts only verified results.
- [ ] Its controls meet 44 px on coarse pointers or are a named dense-target
      exception.
- [ ] It has a manifest row with every GUI surface it appears on.
- [ ] A new noun is in the Terminology table; a new gesture is in
      `commands/gestures.ts` (the palette's Gestures rows read it).
- [ ] Marker gestures cover pending refusal, source changes before threshold, held-arrow cancellation, identical-source continuity, exact hidden-comment selection and isolated 44 px horizontal targets in the 24 px row.
- [ ] Tests lock the command, the key, the gesture, the surface row and the
      feedback. For UI under `gui/web/`, Vitest with axe; for shells and
      overlays, Playwright in `gui/web/e2e/`.

Episode file's Loudness buttons set local export intent. They use native
keyboard and touch activation and have no dedicated command, gesture or undo
step. The existing Export command starts the job, and the existing job
announcement carries the verified publication. The named file actions belong
to the receipt and are available only after the current listing resolves all
its IDs.

## Enforcement

Locked by a test or a check today:

- Every Locked by cell in the [Registries](#registries) table.
- Shared buttons disable only with a reason (`ui/Button.test.tsx`,
  `ui/disabledReason.tsx`); `useDisabledReasonNote` there adds the visible
  note and `aria-describedby` where touch has no hover. A control reached by
  key or touch uses `aria-disabled`, stays focusable and refuses activation
  (`stages/edit/FindBar.test.tsx`,
  `tracks/TrackPlaybackMeter.test.tsx`, `system/Seam.test.tsx`).
- One label per command: the written name on every `CommandButton` and
  `CommandMenuItem`, the palette rows and the manifest equal the catalog entry
  (`commands/labelParity.test.ts`).
- The manifest `gui` column lists every surface that renders a command, and
  each row's `gates` equal the catalog `when`
  (`commands/manifestSurfaces.test.ts`).
- Keymap order per shared key (`keymap/sharedKeys.test.ts`, and the Backspace
  and M cases in `keymap/listener.test.tsx`).
- Every file outside `timeline/` that owns a pointer press, touch, slider or
  drag handle is a declared surface with its decision
  (`timeline/gestureGovernance.test.ts`).
- A `.tsx` control reaches a follow-breaking setter (`setActiveTab`,
  `setMobileMode`, `setMoreDestination`, `setPlayheadSec`,
  `applyAnchoredZoom`, `fitToWindow`) through `execute`, not the store
  (`commands/controlSetters.test.ts`).
- A `Dialog` leaves the sheet only with an inline `anchor.reason`
  (`ui/dialogSheet.test.ts`).
- `no-alert` (oxlint), axe in Vitest and Playwright, the 44 px sweep
  (`gui/web/e2e/touch-floor.spec.ts`), overlay reachability
  (`gui/web/e2e/overlayReachability.ts`).

Review checks the rest: one live region, feedback
lifetime, menu descriptors shared between touch and right click, tablet and
phone reading the same `screens`. Each of those becomes a test as the
matching phase of the UI consistency epic lands.

### Enforcement tests

Each new check passes on today's tree and was mutated to prove it fails. Run them with
`cd gui/web && npx vitest run src/commands/manifestSurfaces.test.ts src/keymap/sharedKeys.test.ts src/timeline/gestureGovernance.test.ts src/commands/controlSetters.test.ts src/ui/dialogSheet.test.ts`.
The setter scan reads `.tsx` controls only; hooks such as `useFixedPlayheadScroll` run the gesture and are out of its scope.

| Suite | Protects | Recurring cost |
| --- | --- | --- |
| `commands/manifestSurfaces.test.ts` | Every control that renders a command (a `CommandButton` or `CommandMenuItem` with a literal `commandId`, a literal `commandLabel`) has its surface in the manifest `gui` row, and `gates` equal the catalog `when`. | A new file that renders a command adds its surface ids to `FILE_SURFACES`, and a new surface id to the manifest row. |
| `keymap/sharedKeys.test.ts` | A key two rows can match runs them in `SHARED_KEY_ORDER`: Backspace tries the inspector track, then the clip; M mutes your mic while a room is open and otherwise mutes the selection. | A new row on a taken key, or a new shared key, adds one `SHARED_KEY_ORDER` entry with its reason. |
| `timeline/gestureGovernance.test.ts` (src scan) | A file outside `timeline/` that owns a pointer press, touch, slider or drag handle is a surface that keeps its own gesture, with the decision it keeps. | A new such file adds a `SURFACE_GESTURES` line, or its gesture goes through the router and `commands/gestures.ts`. |
| `commands/controlSetters.test.ts` | A `.tsx` control changes the tab, phone mode, More destination, playhead, zoom or fit through `execute`, so the follow break, gate and argument checks run. | A control needing a follow-breaking setter for a non-user action adds a waiver with its reason; a new follow-breaking setter adds one entry to `COMMAND_OWNED_SETTERS`. |
| `ui/dialogSheet.test.ts` | A `Dialog` that stays a panel instead of a sheet on phone and tablet writes `anchor.reason` as a literal at the call site. | Each anchored Dialog writes one sentence. |

## Shipped gaps

The 2026-10-19 audit measured these against the rules above. The UI
consistency epic tracks them.

| Rule | Shipped today |
| --- | --- |
| Result ownership and coincident feedback | Export, in Deliver and in place, retains original start blockers, bind the returned ID, and keep bound unverified outcomes through abort or follower failure until reset. One shell transaction joins fresh chip copy and ready outcomes. Receipt failure is live-only; verified fragments alone enter the toast. Unclaimed outcomes keep their observed copy. |
| Menus: one primitive, context menus from one descriptor | `stages/edit/CreateMenu.tsx` (hosted by `timeline/TimelineCreateMenu.tsx`) and `stages/edit/TargetChooser.tsx` (hosted by `timeline/TimelineChooser.tsx`) hand-roll `role="menu"` (in the top layer). The create menu now opens on right click and on the Menu key or Shift+F10 over a focused target (`hitRouting.ts` `openCreate`, #1793); marker buttons are focusable, while a keyboard user without a focused target reaches the create actions through the palette and keys. |
| Confirms: one primitive | The model download is a Model need row (`stages/prepare/ReadyList.tsx`, the Deliver Episode file section, the Review Queue's job slot, `JobModelBanner`), not an `askConfirm`; hand fixes are asked on the Re-transcribe row. |
| Confirms: model not downloaded | No modal. `ModelNeedRow` (`models/ModelNeedRow.tsx`) shows in place inside the job that needs the model: "Needs {what} · {size}" with **Get**, a progress bar with **Cancel**, a plain failure with **Try again**, and **Manage** for the Models sheet. It appears in the Review Queue's job slot (Find more), the Deliver Episode file section, and under the header for a job that failed for a model (`JobModelBanner`). `useModelResume` runs the stopped step again once, by itself, when the model lands; a model refused again after it landed fails the step instead of looping. In the Models sheet the same row is the 64 px list row. Focus moves to the row's Get when it appears on Deliver and stays on the row's control as Get gives way to Cancel. |
