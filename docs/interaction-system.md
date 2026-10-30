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
| Edit marker kind (join, pending and applied: type, label, and the join glyph paths, mode options and the join label with its length; the chip plan and the tier, label and label-room of each glyph in `timeline/editMarkers/plan.ts`). A new type adds its `EDIT_MARKERS` row (the `satisfies Record<EditMarkerKind, ...>` makes a missing row a type error) and a `--color-mark-<type>` token in each theme block, plus the CSS rule of each surface that draws it (`.edit-mark--<type>`; `.pending-overlay.<variant>`; `.applied-tick--<variant>`): colors and shapes are CSS, not registry data. These are hand-wired and the compiler checks only the `Record<JoinMode, ...>` keys of `EDIT_GLYPH_PATH`, so a missed one is caught by review: a new `EditType` member; for a pending type, its `PENDING_KIND_OF_TYPE` entry (without it the type draws as a cut); for a join type, `joinKind`, `JOIN_KINDS` and its `EDIT_GLYPH_PATH` entry (keyed by the server's `JoinMode`); for an applied tick, `appliedKind` | `gui/web/src/utils/editMarkerRegistry.ts` (`EDIT_MARKERS`) | `utils/editMarkerRegistry.test.ts`, `timeline/editMarkers/plan.test.ts`, `edit/joinRender.test.ts` |
| Selection kind and its surface | `gui/web/src/inspector/selectionSurface.tsx` (`SelectionKind`, `SELECTION_SURFACES` with `body`, `screens`, `peek`, `related` and `more`) | `selectionSurface` tests, `stage/edit/useInspectorOpen.test.tsx` |
| Capability (GUI, command, keys, touch, MCP, CLI, skill) | `contracts/capabilities.manifest.json` | `make generated-check`, `commands/manifestSurfaces.test.ts` |
| Term | `docs/communication-philosophy.md` § Terminology | review (advisory docs-sync row `user-facing-copy-and-controls`) |
| Token (color, space, type, z role) | `gui/web/src/styles/theme/`, `deploy/brand/brand-tokens.css` | Stylelint, `tests/test_css_policy.py` |

## Selection

1. **One store.** The selection is one value with one `kind` and one `id` set.
   Track focus, clip focus and range are views over it, not sibling stores.
2. **One kind per target.** A tapped word is one kind. Extending it to a range
   changes the kind once. Two kinds for one target means two inspectors, two
   sheets and two sets of Related commands for the same thing.
3. **One table.** `SELECTION_SURFACES` is the only map from kind to inspector
   body, sheet screens, peek actions and Related commands. Peek and Related
   derive from it. Phone and tablet read the same `screens`; a kind that opens
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
The Script keeps an open Fix text field when the shell remounts (a held pin, per project), so rotating across the phone and tablet shells keeps the word and its field (#1870); a tablet-to-phone remount that blurs the field is a known follow-up.
In a word's Inspector body, the correction fields and Apply precede the
secondary word controls and metadata. The full word remains the accessible
heading even when its visible title is shortened to one line. The range's verbs live on the Action bar (floating beside the selection on desktop and tablet, docked above the Player on a phone); the Range fields keep In and Out and the word handles, first in Select mode.
Reordering these sections preserves their component identity and local drafts
(`#2163`, `stage/edit/selectionSurface.test.tsx`).
The tracks ticked for a range not yet formed live in `rangeScopeTrackIds`; they
are draft UI state, not a selection.
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
   choose and on Escape, and returns focus to its anchor.
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
   Doing controls never sit in the top zone.
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

1. **One channel.** `announceStatus` (`state/uiSlice.ts`) is the only way to
   tell the person what happened. It renders the toast
   (`feedback/FeedbackToast.tsx`) and speaks through the one shell live
   region (`ui/StatusLiveRegion.tsx`). A panel does not mount its own toast or
   its own `aria-live` region. The comment Undo toast and the Needs attention
   banner speak through it too. Floating placement uses the card's horizontal
   footprint. Visible comment and guest-name fields that intersect it take
   protection priority when a clear position fits (`feedback/toastDock.ts`,
   #2199, #2221). If no clear position fits, the existing fallback can cover a
   control. See [Feedback toast](gui-mobile.md#feedback-toast) for the measured
   320x300 limit and the Dismiss or resize workaround.
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
8. **A toast clears itself.** It stays 8 seconds (60 with Undo) and waits
   while hovered, focused, or with Undo unable to act. A card the browser
   reports as clipped waits at most 8 seconds more, so a short viewport or
   an expanded Safari toolbar never strands it. A ratio of 0.95 or more counts
   as fully shown.

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
   ring is never removed; focus returns to the opener after an overlay closes.
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
   tool or control that exists on one has a route on the other (the eye sheet
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
   `aria-selected`, arrow-key movement.

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
      and peek and Related derive from that row.
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
- [ ] Its controls meet 44 px on coarse pointers or are a named dense-target
      exception.
- [ ] It has a manifest row with every GUI surface it appears on.
- [ ] A new noun is in the Terminology table; a new gesture is in
      `commands/gestures.ts` and the gestures sheet.
- [ ] Tests lock the command, the key, the gesture, the surface row and the
      feedback. For UI under `gui/web/`, Vitest with axe; for shells and
      overlays, Playwright in `gui/web/e2e/`.

## Enforcement

Locked by a test or a check today:

- Every Locked by cell in the [Registries](#registries) table.
- Shared buttons disable only with a reason (`ui/Button.test.tsx`,
  `ui/disabledReason.tsx`); `useDisabledReasonNote` there adds the visible
  note and `aria-describedby` where touch has no hover.
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
| `commands/manifestSurfaces.test.ts` | Every control that renders a command (a `CommandButton` or `CommandMenuItem` with a literal `commandId`, a literal `commandLabel`) has its surface in the manifest `gui` row, a shared control group is listed per parent, and `gates` equal the catalog `when`. | A new file that renders a command adds its surface ids to `FILE_SURFACES`, and a new surface id to the manifest row; a second parent of `HistoryControls` or `ZoomControls` adds a line to `WRAPPER_MOUNTS`. |
| `keymap/sharedKeys.test.ts` | A key two rows can match runs them in `SHARED_KEY_ORDER`: Backspace tries the inspector track, then the clip; M drops a marker while the Record stage is active and otherwise mutes. | A new row on a taken key, or a new shared key, adds one `SHARED_KEY_ORDER` entry with its reason. |
| `timeline/gestureGovernance.test.ts` (src scan) | A file outside `timeline/` that owns a pointer press, touch, slider or drag handle is a surface that keeps its own gesture, with the decision it keeps. | A new such file adds a `SURFACE_GESTURES` line, or its gesture goes through the router and `commands/gestures.ts`. |
| `commands/controlSetters.test.ts` | A `.tsx` control changes the tab, phone mode, More destination, playhead, zoom or fit through `execute`, so the follow break, gate and argument checks run. | A control needing a follow-breaking setter for a non-user action adds a waiver with its reason; a new follow-breaking setter adds one entry to `COMMAND_OWNED_SETTERS`. |
| `ui/dialogSheet.test.ts` | A `Dialog` that stays a panel instead of a sheet on phone and tablet writes `anchor.reason` as a literal at the call site. | Each anchored Dialog writes one sentence. |

## Shipped gaps

The 2026-10-19 audit measured these against the rules above. The UI
consistency epic tracks them.

| Rule | Shipped today |
| --- | --- |
| Menus: one primitive, context menus from one descriptor | `timeline/CreateMenu.tsx` and `timeline/TargetChooser.tsx` hand-roll `role="menu"` (in the top layer). The create menu now opens on right click and on the Menu key or Shift+F10 over a focused target (`hitRouting.ts` `openCreate`, #1793); a lane, clip or marker is not focusable, so a keyboard user with no focused target reaches the create actions through the palette and keys only. |
| Confirms: one primitive | The model download is a row (`stages/prepare/ReadyList.tsx`) or the model gate, not an `askConfirm`; hand fixes are asked on the Re-transcribe row. |
| Confirms: model not downloaded | `ModelGate` (`models/gate/ModelGate.tsx`, `useModelGate`) asks before an action that needs a model, then continues after **Download**. It shows as `ModelGateDialog`, as `ModelGatePanel` in a Deliver section (Episode file, Bounce) or the body and footer inside a host dialog (Split swaps its own body, never a dialog over a dialog), as `ModelGateHint` after **Not now**, and as `JobModelDownload` beside a job that failed for a model. Focus moves to **Cancel download** while it downloads and back to the primary button when it stops. |
