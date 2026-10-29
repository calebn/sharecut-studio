# ShareCut design system (Direction C, "Stages")

Reconciles the three area specs into one system: spec-edit.md (shell, Edit, phone shell), spec-record.md (Record), spec-review-deliver.md (Home, Prepare, Review, Deliver, guest review). Where this file and a spec disagree, this file wins. Each spec has a note at its top listing the terms that changed.

Inputs: SPEC-BRIEF.md, rubric.md, the three specs, and the theme tokens in `gui/web/src/styles/theme/` (accent is the orange `--color-accent-*` family, failure is `--color-danger`, needs-you is `--color-warning`, and `--recording-red` exists). No new colors. Caleb's colors, IBM Plex and the wordmark stay.

The rules behind every decision below:
- One element per kind of thing, one icon per verb, one key per verb, one gesture per verb (rubric principles 10 and 11).
- Something persistent, like the Player, keeps the same keys in every stage. A key never changes meaning between stages.
- Position carries meaning. The negative choice is always on the left and the primary always on the trailing (right) end, and swipe direction matches: swipe left says no, swipe right says yes.
- Merge before inventing. Every element below replaces at least one term from the specs (section 2 lists them).

---

## 1. Stage model

### 1.1 Order and names

**Record · Prepare · Edit · Review · Deliver**, keys Mod+1 to Mod+5.

- Record comes first. That is the order of the work for a recorded show: audio comes in, Prepare processes it, you edit, you decide, you ship. Prepare's job ("turn raw audio into an editable episode") follows whatever brought the audio in. spec-record Q1 recommended this. spec-edit and spec-review-deliver used Prepare first only because the brief listed it that way.
- An import-first project skips Record. Import lives in Prepare (and on Home and in empty Edit), and the project opens on Prepare. Record stays one tap away for a later session.
- Edit, Review and Deliver keep Mod+3, Mod+4 and Mod+5 under either order, so the most used keys hold even if Caleb flips the first two (open-questions Q1).

**Home is not a stage.** It sits above a project: the project switcher and the front door. You reach it from the Project menu ("All projects"), with Mod+O from anywhere, and at launch with no project open. Home has no Stage bar.

### 1.2 Each stage: main surface and its one primary action

| Stage | Main surface (gets the most space) | The one primary action | Anticipated next action, closest at hand |
|---|---|---|---|
| Home | Project cards (recent), Start tiles | Open the most recent project (focus ring on load, Enter). With no projects: the Import Start tile | Its card chip says which stage it opens to |
| Record | The Room: a grid of Person tiles, with the right rail (Comments, Takes) | The Record button (start, hold to stop). Guest: Mute. Producer: Comment | After Stop: the hand-off "Edit Session 2" |
| Prepare | The Ready list (a Status list) in the center, Sources (Session groups) on the left, "Help the transcriber" on the right | None while processing. When done, the Stage hand-off becomes the primary ("Review 14 suggestions") | Name speakers while it runs. Tab moves between Source cards |
| Edit | Timeline and Script pane, one shared selection | None in chrome. Each selection has its own primary at the trailing end of the Action bar (Cut for words and ranges) | Selecting puts the verbs next to the object |
| Review | Decision card (center), Review queue (left) | The card's verb (Cut, Shorten, Lower, Resolve, Approve, Replace). Enter | The next undecided item arrives on its own |
| Deliver | Readiness, then Episode file, Listen link, Chapters, Clips | Export | After export: Reveal or Download, then Copy link |

### 1.3 Switching

- **Desktop and tablet:** the Stage bar is a segmented control centered in the App header. Click a stage or press Mod+1 to Mod+5. Clicking the active stage scrolls it to the playhead.
- **Phone:** the Stage bar is the bottom tab bar (56 px plus the safe area), always visible. The phone never hides it: free switching (Caleb 22:25Z) beats the Photos-style toolbar swap.
- **Deep links between stages** (each lands with the object selected):
  - E or the Edit-stage icon on a Decision card opens Edit, zoomed to that item.
  - Each fix button on a Readiness row opens that item in its stage.
  - "Go to Record" on a recording band.
  - The Record verb on an Edit selection opens Record with the target set to Replace.
  - The Stage hand-off button (Mod+Enter).
- **Nothing locks.** Review with no items shows its empty Cover. Deliver with open items still exports. Edit with no audio shows Start tiles.
- **Badges** (one glyph set, section 4.6), on the Stage bar segment or tab:
  - Record: a count of people waiting, a live red dot and take clock, "Paused", a saving ring, or an amber dot for an alert.
  - Prepare: a progress ring, or an amber dot when it needs you.
  - Review: the count of undecided items (suggestions, comments and checks together).
  - Deliver: a check when a current export exists, or an amber dot when the export is older than the latest edit.
- **Guests:**
  - Review-link Viewer and Commenter: Review only, with no Stage bar.
  - Review-link Editor: Edit and Review.
  - Record-link guest and producer: the Room only, with no Stage bar.
  - Prepare, Record (as host) and Deliver are host-only, because they touch the host's computer (models, files, the room).

### 1.4 What persists across stages

| Thing | Rule |
|---|---|
| Playhead | One per window, shared by every stage. Switching never moves it. Record has no playback, but the position is kept |
| Selection | One selection model. The selected object travels: a suggestion selected in Review is selected in Edit, and a comment opened in Edit is the current item in Review. A selection the target stage can't show (a clip, in Deliver) is kept, not shown, and comes back when you return |
| Player bar | On every stage except Record. In Record, the Record dock takes its place (no playback while people are on mics). Takes are heard from the Takes rows |
| Undo history | One stack for the project across all stages. Undo in Deliver can undo a cut made in Edit, and the toast says what it undid |
| Live take | Keeps recording on any stage. The Record badge shows the clock |
| Zoom and scroll | Kept per stage |
| Drafts | Composer drafts are kept per anchor. A Fix text field in progress commits when you leave |
| Open sheets | Close on switch, since a sheet belongs to its surface. Sheets re-open from the selection |

### 1.5 Recording sessions (first versus later)

One concept, the **Session**, shows up in three places with one look: the Session group (Prepare Sources, Record rail), the session band on the Timeline ruler, and the Session target chip.

| Case | Entry | Default target | Lands as |
|---|---|---|---|
| First recording of a new project | Home, Record Start tile. Project is created with default name and folder. Record opens with the room made and the Invite sheet open, Copy focused | "Starts the episode" | Applied directly |
| A later session | Stage bar, Record | "At the end · after 52:10" | Applied directly, one undo step "Added Session 2" |
| Pickup over a selection | Edit, Record verb (R) on words or a range | "Replaces 12:04 to 12:09" (the script of the selection is shown) | A Suggestion (Replace) in Review and Edit, with A/B and a take switcher |
| Insert at playhead | Edit, Record verb with nothing selected, or the "+" menu | "Inserts at 12:04" | A Suggestion (Insert) |

Where later sessions land is open-questions Q3. Track matching is decided here: match a returning person by display name, and correct it with a Person picker on each Source card of the Session group before you leave Record. Each change is undoable.

---

## 2. Shared element catalog

Counted from the specs: about 90 distinct element names across the brief and the three specs (54 formally declared: 9 in the brief, 18 NEW in spec-edit, 13 NEW in spec-record, 14 NEW in spec-review-deliver). After merging there are **43 shared elements** and 2 Edit-local ones. Primitives (Button, Icon button, Segmented control, Chip, Switch, Text field, Confirm in place) are the existing `Atoms/*` and `Molecules/*` and are not counted.

Storybook. Shared elements live under `System/<Element>`. Stage compositions live under `Stages/<Stage>/<Surface>`, where Stage is Frame, Home, Record, Prepare, Edit, Review, Deliver or Guest. Existing `Atoms/*` stay as primitives. Each existing `Templates/*`, `Organisms/*` or `Molecules/*` story that one of these elements replaces is deleted in the same change that adds its replacement. In the repo, Frame elements live under `System/`, so `Frame` is not a Stage title (the closed set is Home, Record, Prepare, Edit, Review, Deliver, Guest). That replaces the specs' mixed `Shell/`, `Edit/`, `Record/`, `Stages/Frame/` and `StageBar` prefixes.

### Frame

**1. App header**
- Anatomy: 48 px (phone: 44 px below the safe area).
  - Left: the Project menu button (wordmark symbol 20 px and the title, truncated last), the Save indicator, then Undo and Redo.
  - Center (desktop and tablet): the Stage bar.
  - Right: presence avatars (Person, 24 px, up to 3 then "+N"), Invite (`user-plus`) and the palette (`search`).
  - No other buttons.
- States: host, guest (the title gets a second line with the version and a Role chip; Invite is hidden for Viewer and Commenter), offline, loading (renders at once with the known title).
- Used: SCR-SHELL-DESKTOP, SCR-SHELL-TABLET, SCR-PHONE-*, SCR-GUEST-*, SCR-REC-ROOM-* (guest form with no Stage bar).
- Replaces: App header (edit), the rdp Stage-bar header with its "more" button, the rdp 56 px guest header, the Record room header.
- Story: `System/AppHeader`: Host, Guest, Offline, Phone, RecordGuest.

**2. Stage bar**
- Anatomy: desktop segments 96 × 32 (88 on tablet), each a 16 px icon and a 13/500 label. Below 1100 px the inactive segments show the icon only. Phone tab bar: 5 equal tabs, a 24 px icon over an 11 px label. Badges sit top-right. While live or paused the phone Record tab widens to fit the pill, which takes the label's row (the label stays in the accessible name) and the other tabs share the rest, none under 44 px at 320 to 390 px.
- Stage icons (each used only to mean "this stage"):
  - Record: filled circle, always neutral (`currentColor`); the red lives in the take clock pill beside it, never in the icon.
  - Prepare: `wand-sparkles`.
  - Edit: waveform with a text cursor (custom, built on `audio-waveform`).
  - Review: `inbox`.
  - Deliver: `send`.
- States: each badge kind (4.6), narrow, phone, guest Editor (2 tabs).
- Used: every stage. It replaces phone Listen, Timeline, Text and More, CHIP-REC-TRANSPORT and CMP-PIPELINE-CHIP.
- Replaces: Stage bar (edit and rdp), Room status pill compact form (record), Pipeline chip.
- Story: `System/StageBar`: Desktop, Narrow, Phone, AllBadges, DoneBadge, RecordIdle, RecordPeopleWaiting, RecordLive, RecordLivePhone, RecordLivePhoneHour, RecordPausedPhone, RecordPaused, RecordSaving, RecordReconnecting, RecordAlert, GuestEditor. Reconnecting shows the cloud-off (offline) glyph, with "Reconnecting" in the name, while the room socket is down during a take.

**3. Save indicator**
- An 8 px glyph after the title.
  - Saved: nothing, or a check for 2 s after a save.
  - Saving: hollow ring.
  - Offline: amber `cloud-off` with a count ("2 waiting").
  - Failed: red `octagon-alert`, with Retry and Download a copy.
- Used: CMP-SAVEDOT, SCR-GUEST-OFFLINE, BAN-GUEST-ATTENTION.
- Replaces: Save dot (edit), Save state dot with the offline cloud (rdp), the guest offline banner.
- Story: `System/SaveIndicator`.

**4. Player**
- Bar form: 56 px on every device, at the bottom of every stage except Record.
  - Left: time in Plex Mono 15, "/ 52:10" edited length, and the cuts Status pill ("−4:10").
  - Center: back 15 s, Play/Pause (a 40 px circle filled with ink, not accent), forward 15 s. Phone hides the skip buttons.
  - Right: A/B (hold to hear the original), Comment at playhead (`message-square`), and the solo and mix Status pills when they apply.
- Expanded form:
  - Phone: swipe up on the bar, or tap the time.
  - Guest Review: embedded at the top of the center column.
  - It shows a 64 px Overview strip with chapter ticks and comment dots, the title and current chapter, a 64 px Play, ±15 s, A/B, Comment, and the chapter list.
- States: no audio (hidden), loading (ring around Play), playing, mix updating, audio error, following someone (their ring on Play), guest.
- Used: CMP-TRANSPORT, CMP-TRANSPORT-PILLS, SCR-PHONE-LISTEN, the guest Player card, the phone mini player.
- Replaces: Transport, Player bar, Player sheet (edit); mini player, Player card (rdp).
- Story: `System/Player`: Ready, Playing, WithCuts, HearOriginalHeld, MixUpdating, AudioError, Soloed, Following, Phone, Expanded, ExpandedGuest.

**5. Overview strip**
- A whole-episode miniature with the playhead, viewport rectangle, selection band and ticks (suggestions, comments, find matches, chapters, session bands).
- Heights: 16 (phone Edit, Script focus), 32 (Review context, above the Player bar), 48 (Project card, static), 64 (expanded Player).
- Used: SCR-LAYOUT-TEXT, SCR-PHONE-TIMELINE, the SCR-REVIEW context strip, SCR-HOME cards, the expanded Player.
- Replaces: Overview strip (edit), Review context strip, Project card waveform strip, Player card scrubber (rdp).
- Story: `System/OverviewStrip`: Edit16, Review32, CardStatic48, Player64.

**6. Palette**
- A 560 px centered card at 20 % from the top. Phone: full-height sheet.
- Search first. Recent when empty. Rows show the verb icon, name, context and key caps.
- Groups: commands, stages, projects, people, chapters, gestures (touch), and Help (Report a problem, Guides).
- Opened with / or ? or the header `search`.
- Used: DLG-PALETTE, DLG-GESTURES, the DLG-HELP "Shortcuts" row.
- Replaces: palette (edit), the rdp Help "Shortcuts and gestures" row and the ? = Help key.
- Story: `System/Palette`.

### Selection and action

**7. Action bar.** The concrete form of the object selection model. It has three forms with one verb order.
- Verb order, always: [Scope chip] · Hear and A/B · Keep · Split · Comment · Fix text · Record · Export · Remove · More · Inspect · **primary** (trailing, accent filled, only when the object has a primary).
  - Keep (the "no") sits left and the primary (the "yes") sits right, matching swipe left and swipe right.
  - Verbs that don't apply are absent, never disabled.
- Primary per object: cut suggestion → Cut; pause → Shorten; sound → Lower; pickup → Replace or Insert; words or range → Cut; comment → Resolve; check or clip idea → Approve. Clip, seam, marker, track and envelope point have no primary.
- **Floating** (desktop and tablet): a 40 px pill (44 px on touch) beside the selection: below it by default so the ruler stays uncovered, above a selected word so the next Script line stays clickable, flipping when there is no room. Icon only, tooltip with name and key.
- **Dock** (phone): one 64 px row above the Player bar, a 48 px icon over a 10 px label, and it is the Sheet's first detent.
  - Phone Edit always shows the dock. With nothing selected it shows playhead verbs (Split, Add chapter, Record, Paste).
  - Phone Review always shows it (an item is always current): Keep (left), A/B (center), verb (right).
  - Record uses the dock in its transport layout, replacing the Player bar: centered round buttons, secondaries 48, primary 64, 16 px gaps, Leave or More set 24 px apart at the far right. Host: Mute, Comment, Record, Pause, More. Guest: Mute, Comment, Rail, Leave. Producer: Comment, Rail, Leave.
- **Inline:** the same row inside a Decision card or a Sheet footer.
- States: per object kind, multi-select (count in the leading slot), read-only guest (Hear and Comment only).
- Used: CMP-RANGE-ACTIONS, OVL-PENDING, INS-PEEK, SHEET-PHONE-INSPECTOR, MENU-CREATE (the playhead set), the Decision card action row, the Review phone thumb buttons, the SCR-REC-* dock, the SCR-REC-DECLINED peek bar (dock with one primary, Join recording).
- Replaces: Action bar and action dock (edit); Record dock (record); Decision card action row, phone Keep and verb buttons (rdp).
- Story: `System/ActionBar`: Words, Range, Clip, Seam, Suggestion, Comment, Multi, PhoneDock, PhoneDockPlayhead, ReviewDock, RecordHost, RecordGuest, RecordProducer, ReadOnly.

**8. Scope chip**
- The leading slot of the Action bar for ranges, words and Split: stacked track-colour dots (or "All"), plus a ripple glyph when time closes or a gap glyph when time is kept. Click to toggle tracks.
- Used: CMP-RANGE-ACTIONS, INT-SPLIT, INT-DELETE.
- Story: `System/ScopeChip`.

**9. Sheet.** Every non-modal surface that is not a menu.
- Anatomy: header 40 px (object icon, title or inline rename, close), body of rows (label left, control right), optional footer with one primary in the thumb zone.
- Desktop placements: Anchored card, 320 px, to a selection or button, at most 60 % of the box it is placed in (the Inspector). Side panel, 400 px, on the right (Settings). Centered card, 400 px (Join).
- Phone: a bottom sheet with detents (4.3).
- Values apply as they change. There are no Apply buttons.
- Instances:
  - Inspector: INS-CLIP, INS-CLIP-MULTI, INS-TRACK, INS-CHAPTER, INS-SOCIAL, INS-RANGE, INS-WORD, INS-BLEED, the Seam, CMP-WORDBAR, DLG-PRECISION.
  - Your own Person tile: CMP-REC-DEVICE, the Device sheet.
  - Join: SCR-REC-LOBBY-GUEST, -PRODUCER, CMP-REC-CONSENT.
  - Invite: MENU-PEOPLE invite, the Deliver Share section.
  - Person: presence, Follow, Go to.
  - View (the eye): MENU-VIEW.
  - History: PNL-HISTORY, INT-UNDO.
  - Mix: SHEET-PHONE-MIX.
  - Queue on phone.
  - Settings: DLG-MODELS, DLG-MCP, DLG-HELP, Project settings, PNL-PIPELINE Advanced, DLG-STEP-PARAMS.
  - Speaker: POP-SPEAKER.
- A sheet opened from a sheet pushes a step inside the same sheet. Sheets never stack.
- Replaces: Inspector sheet, Invite popover, eye popover, History popover, speaker popover, person popover (edit); Join sheet, Device sheet, Invite tile popover (record); Models sheet, Help sheet, Connect agent sheet, History sheet, Invite popover (rdp).
- Story: `System/Sheet`: AnchoredCard, SidePanel, CenteredCard, PhonePeek, PhoneHalf, PhoneFull, PushedStep; and per instance under its stage (for example `Stages/Record/JoinSheet`).

**9a. Inspector sheet**
- The frame every object inspector shares, built from plain data: an `icon`, a `name`, `sections` of rows (`label` and a `control` slot) and `onClose`. The host owns the values and the controls (Scrub field, Time field, A/B audition); the sheet owns the frame and the gestures. Values apply as they change, so there is no Apply button and no Expand or Collapse button.
- Card (desktop and tablet): 320 px wide, placed in the positioned box `bounds` by an `anchor` rect, 8 px below it when 60 % of the box fits there, otherwise 8 px above it, otherwise on the side with more room and shortened to it; 8 px from the box's edges, also when the anchor lies outside the box. It is at most 60 % of the box tall and the body scrolls inside. The header is 40 px, or 45 px under a coarse pointer, where Close grows to 44 px and the header's 1 px rule stays: the object icon, the name and Close. `onRename` makes the name an inline field: Enter or blur reports the trimmed name, Escape or an empty name puts it back. A titled section collapses by its heading, a button with `aria-expanded` and `aria-controls`; `defaultCollapsed` starts one closed. A row is a 12 px secondary label on the left and the control on the right (a row without a label gives the control the whole width). Escape closes unless a field inside took it: Escape in a Scrub field being typed ends that edit and puts the value back, the sheet stays open and a second Escape closes it, and Escape during a Scrub drag cancels the drag.
- Phone: a bottom sheet in the positioned box it is mounted in, with the detents of 4.3 as shares of that box: the dock (4 rem: 64 px at the default root size, and the sheet measures the real height for its detents and the dismiss line; the host's Action bar dock goes in `dock`), half (50 %) and full (92 %). The header and sections sit under the dock and are inert at the dock. Two props carry the detent (`detent`, `onDetentChange`) and `onDismiss` fires when the sheet is let go more than 24 px below the dock, or flicked down from the dock, which clears the selection. A flick down from half or full lands on the dock.
- Grip: a 36 by 5 px bar in a 44 by 44 px hit area that reaches 36 px above the sheet and 8 px into it, so it never covers the dock's 48 px verbs. A tap toggles half and dock (full steps down to half). A drag (3 px slop for a mouse and 8 px for a finger or pen, so a tap that drifts still toggles; along Y, `touch-action: none`) makes the sheet follow the pointer from the height it had, between nothing and full, and on release it settles on the detent nearest to where a flick would carry it 120 ms on (a finger that rested 80 ms before lifting carries nothing). Escape, a blur, a cancel, a lost capture or an unmount puts the sheet back and reports nothing; a second pointer is ignored. The grip is a vertical slider for the keyboard: Up and Right step up and Down and Left step down, as for any slider; Home and End go to the ends, Enter and Space toggle, and Escape closes.
- Motion: the phone height settles over `--motion-panel` and a section's chevron turns over `--motion-hover`; reduced motion turns both off. Forced colors draw the grip in `ButtonText`.
- Wiring prerequisite: the keys it handles (Escape from a control, the grip's keys) are stopped before the window keymap, so the listener must stay bubble-phase, as for 17a. A host mounts the card in a positioned box and the phone sheet in the box above the Player bar. Focus stays host-owned: on Inspect or I (W3) the host moves focus into the sheet and on close returns it to the opener. A real dock slotted into `dock` must leave Inspect out of its items, or its own grip stacks on the sheet's. Enter and Escape during an IME composition in the Name field belong to the input method: Chromium checks that with real CDP composition events for the card and for the phone at half, while the jsdom unit tests send synthetic composition keys only.
- Not built yet: wiring and removing the legacy inspector (W3), a word's waveform with one neighbour each side and draggable start and end handles, and the content for each object kind (the stories' bodies are demos; the Seam's Offset range is a fixed ±200 ms demo, and the host supplies the real allowed range).
- Used: SHEET-INSPECTOR, INS-CLIP, INS-TRACK, INS-RANGE, INS-WORD, CMP-WORDBAR, DLG-PRECISION (the Seam).
- Replaces: the Inspector sheet's frame, grip, Expand and Collapse (edit).
- Story: `System/InspectorSheet`: DesktopCard, TabletCard, PhoneDock, PhoneHalf, PhoneFull, LongContent, WordTiming, Seam, Range, Closing.

**10. Menu**
- A 280 px list of 36 px rows (44 on touch): verb icon, label, key caps. A header row names the anchor ("12:04.3 · Maya"). Rows that can't apply are absent.
- Phone: the same rows as a content-height Sheet.
- Instances: the Project menu (first row is the title as a rename field, then Recent 5, All projects, Settings, Connect agent, Help), More (⋯), Create here or long-press, the Session target chip menu, Person tile menu, row menus.
- Used: MENU-MAIN, MENU-CREATE, the Home "more" and Help buttons, the record ⋯.
- Replaces: Project menu (edit); Home more and Help buttons, the Stage-bar "more" (rdp); the room overflow (record).
- Story: `System/Menu`: Project, More, CreateHere, Phone.

**11. Scrub field**
- A numeric value with its unit in Plex Mono. Drag to change (Shift ×10, Alt ×0.1), click to type, ↑/↓ to step, Enter commits, Esc reverts, a reset dot shows when the value isn't the default, and one gesture is one undo step.
- Variants: plain, with track (allowed range), level bar.
- Used: every Inspector, CMP-TRACK-FADER, SHEET-PHONE-MIX, DLG-STEP-PARAMS, the Deliver Chapters time, Deliver Part In and Out.
- Story: `System/ScrubField`.

**12. Readout chip**
- A 22 px chip 12 px above the pointer during any drag: delta and resulting value.
- Used: CMP-CLIP trim, fade, move, roll, envelope, level, marker drag, Decision card handles.
- Story: `System/ReadoutChip`.

**13. Selection handles**
- Caret handles with 12 px knobs (44 px hit) at both ends of a text selection, adjusting by word.
- The handles are pointer-only: hidden from assistive tech, no role, no keys, not a tab stop. The keyboard does everything a drag does from the words, which are already one tab stop: Shift+arrows (Up and Down by line) extend the selection, and Alt+Shift+Left grows it at its start while Alt+Shift+Right shrinks it from its start. A screen reader announces the selection once a drag is let go, not at every word. A tap beside a grip is replayed on the word with its Shift, Ctrl, Alt and Meta keys, so a Shift-tap there still extends. A drag also ends when the browser takes the pointer capture away, and when the grips go away mid-drag the pane starts announcing again. Deferred: snapping is by the word under the caret, so growing an edge snaps at once and shrinking needs the grip to cross the edge word; a symmetric rule is a later change to `nearestStop`.
- A handle's hit region reaches only toward its knob: the start's above its line and the end's below it, 44 px square under a coarse pointer. It covers none of its own line's words. A press that never moves is passed to the button under the point, so a tap beside a handle still lands on that word.
- Not built yet: dragging the edge past the window edge does not scroll (edge autoscroll), and PageUp and PageDown do not move by a larger step.
- Used: PNL-TRANSCRIPT, CMP-WORDRANGE, the Decision card excerpt, guest transcript.
- Story: `System/SelectionHandles`.

### Content

**14. Script pane**
- The transcript as a document: a speaker margin (Person 20 px and first name), reading type (4.5), no modes.
  - Selection grammar (D-script-gestures). Selection is the pane's own: the browser's text selection is off in the body (`user-select: none`, no iOS callout, `touch-action: manipulation`), so a drag, a long press and a double tap never fight it.
    - Click or tap a word: selects that word at once, puts the caret before it and seeks. It never waits for a double-click.
    - Drag with a mouse or pen from a word (past 5 px): selects from that word to the word under the pointer, across turns. A cut pill or a suggested run in the way is taken whole, as with Shift and the arrows, and a drag cannot start on a pill, a run, a margin control or a handle (those are buttons of their own). The pane draws the selection while the pointer is down and tells the host only on release.
    - Shift-click extends from the caret or the selection's anchor; Shift-drag does the same live. Shift with the arrows (Up and Down by line) and the two handles select too.
    - Double-click or double-tap a word: Fix text on that word. Enter or F2 on a selected word: Fix text on the whole selection (F2 on an unselected word selects it first). Enter on an unselected word selects it. Typing never edits: every letter stays a shortcut.
    - Touch: a tap selects a word; a long press (500 ms, finger still within 10 px, so a little drift before the hold is fine) selects it and shows the 44 px handles, and moving on from the hold extends the selection under the finger until it lifts. A finger that moves before the hold scrolls the pane and selects nothing. Once the hold has armed the pane no longer scrolls under the finger. A second finger cancels the drag and keeps the earlier selection. The keyboard path to the same thing is Shift with the arrows or Enter on a word, and Alt+Shift+Left or Right for the start.
    - A drag near the top or bottom edge (56 px, or a quarter of a short pane) scrolls the pane by up to 14 px a frame and keeps selecting; a hand-driven scroll tells the host (`onUserScroll`) so Follow turns off. Autoscroll from a touch drag counts as a hand-driven scroll, and the host may hear `onUserScroll` more than once (turning Follow off is idempotent). The pane takes pointer capture, so a drag can leave the pane: it keeps selecting to the nearest word and commits on release outside.
    - Esc during a drag cancels it and leaves the earlier selection; a cancelled pointer, the body losing its capture, a window blur, a second finger and the pane going away end it the same way. A second pointer of another kind is ignored.
    - Copy: the pane handles the `copy` event and puts the selected words on the clipboard as text, a line to a turn, with collapsed cuts left out. Mod+C reaches the keymap first, so the host's copy command calls `selectionText(turns, selection, showCutText)` for the same text.
    - Word boundaries come from the pane's own words, never from a script's characters: a word is one button, so ligatures and combining marks are never split, and the pointer's place is found by where a word is drawn while the selection runs in reading order, so a right-to-left turn (`dir="auto"`) selects forward from its right edge.
  - Callbacks. Ids come first, then the flags: `onSelectionStart(anchor, gesture)` (return `false` to refuse; a refused start sends no `onSelectionEnd`, and the click that follows still selects the word), `onSelectionChange(anchor, head, gesture)` (a preview, never a store write) and `onSelectionEnd(anchor, head, { ...gesture, committed })`, where `gesture` is `{ source: "mouse" | "pen" | "touch", intent: "drag" | "extend" | "hold", shift, alt, mod }`. `committed` is false when Esc, a lost pointer, a blur, a second finger or unmounting ended it; on a commit `onSelect` follows with the same selection, and it stays the one call a host writes the store from (it also carries clicks, Shift-click, keys and the handles). The `selection` prop never changes during a drag, so a refused or cancelled gesture needs no undoing. `onFixText(span, "enter" | "f2" | "double-click" | "double-tap")` asks for Fix text; without it Enter on a selected word runs `onPrimary` and F2 reaches the keymap.
  - A selection across tracks. Word indices are the episode's word indices (the pane draws a window of turns), so a span can start in one speaker's turn and end in another's. The host turns `{ start, end }` into one store selection per track with `trackSpans(turns, span)`, which needs every turn the span touches: for each speaker id (the track) it gives the first and last word `key` of that track inside the span (`trackId:sourceId:wordIndex`), the window indices and the turns they sit in. A track's words in a span are contiguous on that track even when another speaker's turn sits between two of its turns. The range covers all of them, cut and suggested words included; a collapsed cut inside the span is part of it. The pane stores no track and the host's `key`s name the words, so the result does not depend on the window. The range is per track words; if a project needs the same time range on every track the span touches, the host maps to time instead of keys.
  - DOM anchors for the host: `data-stop` (window index), `data-word-key` (the word's `key`) and `data-turn-id`.
  - Backspace on a selection is Cut.
  - Esc clears the selection. Left from a turn's first word enters its margin (speaker name, then time; Up and Down walk them, Right returns to the words).
  - Esc order, innermost first: a Fix text or rename field, then the speaker popover, then the Find bar while focus is in it, then the selection, then Follow. The handles and the margin controls are not Esc stops.
  - Keys the pane handles are the pane's: it stops them (`preventDefault` and `stopPropagation`) so the window keymap never also nudges the playhead on an arrow, jumps to the start on Home, or takes a second Esc. The list is the arrows, Home and End (alone, with Shift, and Alt+Shift+Left or Right), Enter on a word, F2 on a word when `onFixText` is given, and Esc over a selection or a drag. Every other key and any Ctrl or Cmd chord reaches the keymap. The keymap rows stay as they are; the host must not bind a script-focused when-clause to a key in that list.
  - The window keymap listener does not read `defaultPrevented`; `stopPropagation` is the contract, and it works because React's root listener runs before the window's. A host that wants a key for itself must stop it, not only prevent it. The listener also skips a key while an IME composition is open, treats Space and Enter on a focused button as the browser's click except Shift+Space (Hear), and prevents the default of Shift+Space's keyup so Hear on a focused word, clip or bar button does not also click it.
  - The pane has the one polite live region of the script. It says the selection (on release while a handle is dragged), "Selection cleared", and the host's `findStatus`; the Find bar's count is plain text.
  - A cut that spans two turns is one pill in each: the turn where it begins shows the length, the later ones say "continued".
  - Fix text over a selection that spans turns is one field, drawn in the first turn, and the later turns show nothing in its place.
  - The host passes `() => pane.focusFind()` to the Find bar so focus lands on the header's Find button when the bar closes or finishes Cut all or Replace all.
- Its header holds `text-search` (find), the unsure-words "? 3" chip, the show-cut-text `eye` and the follow pin. Region notices are compact Status rows in that header.
- Read-only variant for guests and the Decision card excerpt (two sentences of context).
- Used: PNL-TRANSCRIPT, CMP-TURN, SCR-PHONE-TEXT, SCR-GUEST-COMMENTER transcript, the Decision card excerpt.
- Story: `System/ScriptPane` (states), `Stages/Edit/ScriptPane` (compositions).

**15. Timeline**
- Ruler 24 px, which also carries the **session bands** (alternating tint per session with an "S2" pill). Marker lane 24 px. Lanes fill the height (72 to 240 px each). Corner zoom cluster at the bottom-right of the lanes (Fit, −, +, `eye`). Playhead is a 2 px accent line.
- The live take band in the lanes becomes the session band on the ruler when it lands.
- Used: CMP-TIMELINE, CMP-RULER, CMP-MARKERS, OVL-RECORDING, OVL-RANGE, OVL-PRESENCE, SCR-PHONE-TIMELINE.
- Replaces: corner zoom cluster and marker lane (edit, now parts of this element), the Session marker in the marker lane (record).
- Story: `System/Timeline` (parts), `Stages/Edit/Timeline` (compositions).

**16. Track header**
- Person 28 px with the level ring, name, then on hover or when set: Mute (`volume-x`), Solo (`headphones`), a level Scrub field. Drag anywhere on the header except a control to reorder. The wide form (280 px) is the desktop mixer. The phone form is 56 px, avatar only, and its select button is a 44 x 44 target.
- Mute and Solo are toggles named for their track, 32 px on a desktop (4.4). In the 168 px form the level field shows its number without the dB unit (the unit stays in the accessible value), so a signed value down to -60.0 fits beside the 32 px toggles and the reset dot; the 280 px form shows the unit. A mute that comes only from another track being soloed (an implied mute) is a dashed, unpressed Mute that says why; muted for you alone is dashed and pressed. The controls stay in the accessibility tree while hidden and show on hover, on focus and whenever something is set. While hidden they take no pointer, so a press on the blank row does nothing. Under a coarse pointer the default form is one 44 px row so it fits the 72 px shortest lane: the select button, Mute and Solo are 44 px targets and always shown, and the level is not in the row (the Mix sheet owns it); the 280 px form keeps the level in that row. A guest cannot change the level or a mix mute and can still solo.
- Keys the header handles are its own: Shift with Up or Down on the select button reorders, and it stops them (`preventDefault` and `stopPropagation`) so the window keymap never also moves the selection. Every other key reaches the keymap. M and S for mute and solo on the focused track are host wiring, not part of the view (wiring prerequisite).
- Contract: the view takes the track's `id`, and every callback takes it first (`onSelect(id, additive)`, `onMute(id)`, `onLevel(id, db)`, `onMove(id, direction)`, `onDragStart(id, event)`), so a column passes one function to every header. The view is `memo`: a sibling's change does not draw it. `anchorProps` passes presence anchors to the header, Mute and Solo.
- Used: CMP-TRACK-HEADERS, CMP-TRACK-FADER, CMP-TRACK-MIX, SHEET-PHONE-MIX rows.
- Story: `System/TrackHeader`.

**17. Clip**
- A rounded 6 px block in the track colour. Its label shows only when the clip is wider than 80 px. Trim tabs and fade knobs appear on hover and while selected. A muted region is hatched grey with `volume-x`.
- The clip body is one tab stop and Enter selects it; a lane that walks focus itself passes `tabIndex={-1}` to all but one clip. The handles are never tab stops. Selected, Alt with Left or Right on the body walks focus along the four handles in left-to-right order (trim start, fade in, fade out, trim end), which are sliders with the edge as a timecode or the fade length in ms. Left and Right on a handle nudge the edge 10 ms (Shift 100 ms) for all four handles: the spec's step, not the legacy keymap's 1 ms fade step, so W3 deletes the legacy fade rows. The fade-out slider's value is where the fade starts, so Right raises it as on any slider; its text is the fade length. A held key reports `repeat` and the release reports `onNudgeEnd`, which closes one undo step. Each slider's range stops at the other edge: the fades never cross and a trim keeps the clip at least 50 ms long. Up and Down on the body or a handle report `onLaneStep`.
- Pointer: a drag starts after 3 px (any direction for a move, so a clip can change lane; across for a handle). `onDragStart` and `onDrag` carry client x and y, Shift (locks time, lane change only) and Alt (disables snapping), and `onDragStart` can return `false` to refuse. Escape from a document-level listener, a window blur, `pointercancel`, a lost capture or the clip unmounting mid-drag all end it as not committed, and a second pointer is ignored while one has hold. Selection reports `{ shift, mod }`. `ghost` draws the clip as the destination of a move, with no button or handles.
- Touch: an unselected clip never grabs a finger, so a swipe that starts on it pans the lane and a tap selects it; so does a guest's clip. Only a selected clip moves under one finger (select first, then drag, INT-MOVE). The handles' 44 px areas stay inside the clip: the trim zones own the edges, a fade knob sits in the half of the middle on its side, and on a clip narrower than 176 px the fade knobs keep their keyboard slider but drop their touch area. A guest sees no handles and cannot drag.
- Keys the clip handles are its own: Escape during a drag; on a handle the arrows (Left and Right nudge, Up and Down lane steps) and Alt with Left or Right; on the body Up and Down (bare) and Alt with Left or Right once selected. It stops them (`preventDefault` and `stopPropagation`, keyup too for a nudge) so the window keymap never also nudges the playhead. Every other key and any Ctrl or Cmd chord reaches the keymap, and the body hands the rest to `onKeyDown(id, event)`. The keymap rows stay as they are; the host must not bind a clip-focused when-clause to a key in that list.
- Contract: the view takes the clip's `id` and every callback takes it first (`onSelect(id, { shift, mod })`, `onDrag(id, grip, drag)`, `onNudge(id, handle, ms, { repeat })`), so a lane passes one function to every clip. The view is `memo`: a sibling's change does not draw it, and its peaks are folded to at most one bar per pixel of its width. `hitProps` (per grip) and `anchorProps` pass the `data-hit-*` attributes the hit routing and target chooser read and the presence anchor, so wiring keeps them.
- Used: CMP-CLIP, INT-MOVE, INT-TRIM, INT-FADE.
- Story: `System/Clip`.

**17a. Ruler**
- The 24 px time ruler of element 15, built as its own part from plain data: the window's `start` and `pxPerSecond`, its `width`, the `duration`, the `playhead`, an optional `selection` and the recording `sessions`. Labels are Plex Mono 11 px at the smallest nice interval whose ticks are at least 64 px apart and wider than the widest label, so zooming picks a coarser or finer step by itself; the steps run from 0.1 ms up to a day (2, 4, 6, 12 and 24 h after the hour), so a 10-hour episode fitted into 360 px reads 0:00, 2:00:00, 4:00:00 and on. Ticks are `index * step`, so a deep zoom does not drift. No minor ticks are drawn. The playhead is a 2 px accent line with a 10 px triangle. A selection is a 4 px accent band along the bottom with a 12 px knob at each end. Sessions are alternating tinted bands with a pill ("S2"). A guest (`readOnly`) gets no knobs.
- Pointer: a click seeks (`onSeek`). A drag scrubs after 3 px: `onScrubStart(seconds, pointer)` can return `false` to refuse, `onScrub(seconds, pointer)` carries the pointer's time, and `onScrubEnd(committed)` reports `false` for Escape from the document, a window blur, `pointercancel`, a lost capture or the ruler unmounting or turning read-only, so the host puts the playhead back. A second pointer is ignored while one has hold. A double-click fits (`onFit`). A knob drag reports `onSelectionDragStart(edge, pointer)` (return `false` to refuse), `onSelectionDrag(edge, drag)` with the seconds under the pointer, and `onSelectionDragEnd(edge, committed)`. The knob keeps the pointer's offset from the edge, so it does not jump on grab. When a drag starts the ruler takes the pointer on its own root, because a knob is not drawn once its edge is more than 6 px outside the window and would otherwise unmount while it holds the capture: a release anywhere (also below or beside the ruler) ends the drag with `onSelectionDragEnd(edge, true)`, a lost capture with `false`, and a bare mouse moving afterwards drags nothing. The body's slider text and value are both held to the episode, so a playhead past `duration` (or a zero `duration`) reads the episode's end.
- Touch: the body sets `touch-action: pan-y`, so one finger swiping along it scrubs (after 10 px; a vertical move is left to the browser) and a tap seeks. The knobs set `touch-action: none`. A mouse drags a knob after 3 px; a finger or pen needs 10 px (the same slop as the body, so a tap that drifts 4 px is still a tap and seeks), and the drag counts from where the finger passed the slop, so the first `onSelectionDrag` has `dx` 0 and the knob does not jump by it. Under a coarse pointer, or with the `touch` prop, each knob is 44 px wide and as tall as the ruler (24 px; a 44 px height would cover the marker lane under it). The knobs' areas never reach the ruler's neighbours. Pinch and pan belong to the lanes host.
- Keys: the ruler body is one tab stop and a slider named "Timeline position". Left and Right move the playhead one tick (Shift ten) with `onSeek`, Home and End go to the ends, and a move that changes nothing is not reported. Alt with Left or Right walks focus to the selection knobs, which are sliders (not tab stops) that Left and Right nudge by 10 ms (Shift 100 ms) with `onSelectionNudge(edge, seconds, { repeat })`; the release or a blur reports `onSelectionNudgeEnd(edge)`, which closes one undo step. The ruler stops the keys it handles (`preventDefault` and `stopPropagation`, keyup too for a nudge). Every other key and any Ctrl or Cmd chord reaches the keymap.
- Wiring prerequisite: the app's window key listener does not honour `defaultPrevented`, so the part relies on `stopPropagation` and the listener must stay a bubble-phase listener on `window` or `document`. The keymap rows stay as they are; the host must not bind a ruler-focused when-clause to a key in the list above.
- Contract: callbacks take the edge first, never an id, so one function serves both knobs. The view is `memo`. `anchorProps` passes presence anchors to the root and `hitProps` (per `scrub`, `start`, `end`) the `data-hit-*` attributes. Forced colors draw the playhead, band and knobs in system colors.
- Used: CMP-RULER, OVL-RANGE, SCR-PHONE-TIMELINE.
- Story: `System/Ruler`: Fit, Zoomed, WithSelection, ResizingSelection, LoggingSelectionDrag, WithSessions, Scrubbing, Keyboard, ReadOnly, AboveMarkers, Phone.

**18. Marker**
- One glyph family in the marker lane: chapter = `flag`; comment = `message-square` pin (span bar for a range); clip idea = bracket pair, hatched while proposed and solid once approved. "+3" stacks.
- The Marker is the drawing and its button. Its `onSelect` receives the click event so a lane can read the modifier keys, and the lane (18a) adds `dragging`, `rootStyle`, `buttonProps` and `children` for edges and layout.
- Used: CMP-MARKERS, INS-CHAPTER, INS-SOCIAL, OVL-COMMENT-BUBBLE, Record comments after landing.
- Replaces: social bracket and comment pin (edit), the record "Comment pin" marker, the rdp "Suggestion visual on the marker lane" for clips.
- Story: `System/Marker`.

**18a. Marker lane**
- The 24 px lane of element 15, built from plain data: `markers` (chapter, comment or clip idea, each with an `id` and times in seconds), the window (`start`, `pxPerSecond`, `width`), the `duration` and the `selected` ids. It draws element 18 and adds layout, selection, moving and adding.
- Layout: a chapter flag, a point pin and the bracket pair are each at least 16 px wide. Markers whose glyphs overlap fold into the earliest one and a "+N" chip right after it; the chip opens a list of the hidden ones, and zooming in unfolds them. A glyph is the flag, the pin (a range comment's bubble) or a bracket's start; a bracket's end glyph and the chip's own 40 px also fold what lands on them. A span (a clip idea or a range comment) is not a glyph: a chapter or comment inside one stands on it at any zoom, drawn above the span and reached by its own button, and a span whose start has scrolled off to the left keeps the markers inside it. A selected bracket's start edge gives way to its chip (its hit area is 18 px, the glyph, while a chip sits there) so both stay reachable. Positions are held to 512 px outside the lane (a clip spanning the episode is not a 20000 px box), and a marker is dropped or kept by its true footprint, so a lane of any width, 1500 px or more, draws every marker at the x the ruler gives its time. A chapter's title is cut at the next marker. A marker being dragged is never folded. Markers more than 64 px outside the window are not drawn. Every marker is exactly the lane's 24 px tall, so nothing spills into the ruler above or the lanes below.
- Pointer: a click selects (`onSelect(id, additive)`, additive for Shift, Ctrl or Cmd). A drag starts after 3 px for a chapter, a clip idea (whole) or either edge of a clip idea (`onDragStart(id, grip, pointer)` can return `false` to refuse, `onDrag(id, grip, drag)` with the delta and the seconds under the pointer, `onDragEnd(id, grip, committed)`), with the same not-committed endings and second-pointer rule as the Clip. A readout chip above the pointer shows the change and the marker's current time from its props, so a host that snaps shows the snapped time. The lane takes the pointer from the pressed marker when the drag starts, because a dragged marker can move in the DOM and a moved node loses its capture. A click that follows a drag is not a select, but only a pointer click (`detail` above 0) is swallowed: Enter or Space on a marker right after a mouse or touch drag selects at once. Comments never drag, and a guest (`readOnly`) cannot drag or add. A double-click on an empty part asks for a chapter (`onAdd(seconds)`); the host then passes `adding={{ at }}` and the lane draws a name field there: Enter commits (`onAddCommit(seconds, title)`, an empty name stays open), Escape cancels (`onAddCancel`) without reaching the keymap, and a blur commits what was typed or cancels if nothing was.
- Touch: under a coarse pointer, or with the `touch` prop (a coarse pointer does it by itself, in CSS), a marker's hit area is at most 44 px wide and exactly the lane tall (a 44 px height would cover the ruler and the lanes), and a selected bracket's edge zones are `min(44 px, 34%)` of the bracket. The area reaches at most 14 px past the marker and only half the gap to its neighbour, so two areas never overlap. This is the one place the 44 px rule of 4.4 gives way, on purpose: in a dense spot the reach is the half-gap, so a 16 px pin among stacked pins is 16 px wide and a pin with a neighbour 20 px away on each side is 36 px; the "+N" chip and its list are the reliable path to a crowded marker, and zooming in widens every gap. An isolated marker is 44 px wide (measured: 16 px plus 14 px each side). An unselected marker never grabs a finger, so a swipe over it pans the lane and a tap selects it; only a selected, movable marker moves under one finger, after 10 px (a mouse needs 3 px), counted from where the finger passed the slop so the marker does not jump, which keeps a tap that drifts a few px from becoming a drag and an undo step. The selected marker and a bracket's edges set `touch-action: none`. Adding a chapter by touch goes through the dock's "Add chapter" (a double-tap relies on `dblclick` and is not the primary path).
- Keys: each marker is one tab stop in time order; the edges are sliders and not tab stops. Enter and Space select. On a selected chapter or clip idea Left and Right nudge 0.1 s (Shift 1 s) with `onNudge(id, grip, seconds, { repeat })` and the release or a blur reports `onNudgeEnd(id, grip)`; on a selected bracket Alt with Left or Right walks focus to its edges, which nudge the same way and stay at least 0.1 s apart. An unselected marker, a comment and a guest's markers leave the arrows to the keymap. The lane stops only the keys it handles. A marker folded into a "+N" chip is reached through the chip's list; the chip is a button that reads pressed while a hidden marker is selected.
- Wiring prerequisite: the same as the Ruler. The app's window key listener does not honour `defaultPrevented`, so the lane relies on `stopPropagation` and the listener must stay a bubble-phase listener. The "+N" list is `ui/Menu`, which lets Escape and the Enter that opens it reach the window: the app's keymap holds every key while a menu is open (`keymapHandoff` in `ui/modalGate`), and a host with its own listener must do the same, or Escape in the list also clears the selection.
- Contract: every callback takes the marker's `id` first. The view and each marker are `memo`, and a marker compares by what it draws (its `marker` object, its placed pixels, its flags), not by the layout's fresh objects: moving one of six markers draws that marker and the one whose title it cuts off, and a new array of the same markers draws none. Keep the marker objects stable and change only the one that moved. The "Add chapter" name field is held inside the lane when its time is scrolled off to the left or right. Forced colors draw a clip idea's line and a range comment's bar and hatch in the system text color, and the selected marker's ring is drawn inside its 24 px (an inset outline) in light, dark and forced colors. `anchorProps` passes presence anchors to the lane and `hitProps(id, grip)` the `data-hit-*` attributes.
- Used: CMP-MARKERS, INS-CHAPTER, INS-SOCIAL, OVL-COMMENT-BUBBLE.
- Story: `System/MarkerLane`: AllKinds, Selecting, Dense, Selected, Dragging, Moving, AddingChapter, DoubleClickToAdd, TouchTargets, ReadOnly, Phone, Wide, Nested, NestedZoomed, FoldedOnRangeStart, AddingChapterScrolledAway.

**19. Suggestion.** One drawing for any proposed change, everywhere.
- Text: struck words in the cut token on a hatch background.
- Waveform: 45° hatch in the suggestion token with a 2 px outline, a 16 px kind glyph and edge handles.
- Rows: kind glyph and struck snippet.
- Pauses draw a hatched gap glyph. Pickups draw a hatched region with the Record glyph.
- Hatch means proposed. Solid strike or a Seam means applied.
- Used: OVL-PENDING, INS-PENDING, PNL-REVIEW-QUEUE results, guest suggestions, pickup and insert sessions, clip ideas, Decision card.
- Story: `System/Suggestion`: Text, Waveform, Row, Pause, Pickup, Guest.

**20. Seam**
- The boundary between two pieces of audio: an applied cut, a split, a join.
  - Timeline: a 6 px diamond, filled for a cut and hollow for a split.
  - Text: an 18 px pill with `scissors` and the removed length.
- Verbs: Hear across, Keep (cuts only), join type, Comment, Inspect.
- Used: POP-JOIN, CMP-EDITBOUNDARY, DLG-PRECISION, OVL-APPLIED, OVL-EDITMARKERS, INS-APPLIED, the Review "Decided" rows.
- Story: `System/Seam`.

**21. A/B audition**
- A two-segment control: "A" (before or original) and "B" (after or edited). Each plays 1.5 s pre-roll through 1.5 s post-roll (Review: 3 s). Press-and-hold A with nothing selected plays the original at the playhead (not built yet; W2).
- Adjusting a handle switches it to B.
- Used: Decision card, Seam, Suggestion, Player (Hear original), the Prepare align check, Source card voice check.
- Replaces: "Hear original" (edit, the O key) and Hear before and after (rdp).
- Story: `System/ABAudition`.

### Decisions and comments

**22. Review queue**
- A list container.
  - Header: progress ("6 of 14 decided · saves 7.8 s"), filter icons with counts (All, `scissors`, `message-square`, `triangle-alert`), and Find more (`wand-sparkles`).
  - Groups, each with a bulk primary in its header ("Cut all 11", plain "Cut" for one item, Shift+Enter; held items add "N to decide one by one" for editors; the Find bar's Cut all is Mod+Shift+Enter).
  - Sorts: by kind (default) or chronological.
- Placements: Review left 360 px; Record right rail (Comments filter, chronological, Composer at the bottom); guest Review left (Comments and Your suggestions); phone Queue sheet.
- Used: SCR-REVIEW, PNL-REVIEW-QUEUE, PNL-COMMENTS, CMP-REC-LIVECOMMENTS, SCR-GUEST-COMMENTER.
- Replaces: Review queue (rdp), Notes rail (record).
- Story: `System/ReviewQueue`: Groups, CommentsChronological, Guest, PhoneSheet, BulkRunning.

**23. Queue row**
- 56 px: kind glyph or author avatar, snippet (Suggestion drawing for proposals), time in mono, value (saved seconds, or reply count), unread 8 px accent dot, offline clock. Swipe right = primary, swipe left = Keep.
- Used: Review queue items, comment rows, Record comments and markers (a marker is a comment with no text).
- Replaces: Comment row (rdp), Notes rail rows (record).
- Story: `System/QueueRow`.

**24. Decision card.** The focus surface and inspector for one decidable thing.
- Anatomy: kind line (glyph, kind, time, speaker), plain title, Script excerpt with the Suggestion drawing, a 96 px ±6 s waveform with edge handles (snap to silence), why line, A/B, inline Action bar.
- Variants:
  - Suggestion.
  - Pickup (take switcher "Take 1 of 3").
  - Comment (thread, action items, Composer, Resolve).
  - Check (unsure words stepper, transcript check, conflict).
- Placements: Review center (max 760 px); Edit Inspect on a suggestion or comment (anchored Sheet, 320 px compact: 64 px waveform, no Open in Edit, no swipes; editors get Keep/Later/Cut in the inline bar with A/B in the body, a guest gets Comment with A/B in the bar; desktop and tablet only); phone Review full screen, with swipes.
- Used: SCR-REVIEW, INS-PENDING, INS-COMMENT, CMP-COMMENT-CARD, PNL-REVIEW-QUEUE-REFINE-GATE, FLOW-REC-LATER pickups.
- Replaces: Decision card and comment thread (rdp), comment popover and suggestion inspector (edit).
- Story: `System/DecisionCard`: Filler, Pause, Sound, Pickup, Comment, Check, Adjusting, CompactInEdit, CompactEmpty, CompactLoading, CompactError, Phone, PhoneSwipe. Built (S8b, #2294): `layout="compact"` (CompactInEdit, CompactComment, CompactGuest, CompactEmpty, CompactLoading, CompactError); not yet placed in an Edit Sheet.

**25. Composer**
- One field with a leading time chip, which pins when typing starts or takes the selection. Tap the chip to re-anchor, or clear it to make a whole-episode note.
- A send arrow sits inside the field. Enter posts and Shift+Enter adds a line.
- On a guest's first post, a name line appears above.
- Optional visibility chip (Record, open-questions Q6).
- Used: PNL-COMMENTS, CMP-GUEST-NAME, CMP-GUEST-COMMENT, CMP-REC-LIVECOMMENTS, the Decision card reply, INS-COMMENT reply, the expanded Player comment.
- Story: `System/Composer`.

### Status and feedback

**26. Status row.** One line about a state someone may need to act on, or a task that is running.
- Anatomy: status glyph (4.6), plain title, a detail with numbers, a 4 px progress bar while running, at most one action (Fix, Get with size, Try again, Cancel, Retry), and an optional Details disclosure. Rows can expand to child rows.
- Densities: 48 (lists), 44 (alert), 32 (inline in a region header).
- **Status list** is a container of Status rows: Readiness, Ready list, Takes.
- **Alert slot** is one 44 px slot under the App header on every stage. It shows the highest-priority row with "+N" for the rest. Record keeps its own priority table: mic lost, no audio, storage, saving failed, host offline, monitor failed, clipping.
- Used: the Readiness check, the Prepare Ready list, Model gates (DLG-MODEL-GATE, DLG-WHISPER), Setup card, SCR-SETUP-*, the Review Checks group, the Join sheet rows (name, mic, headphones), CMP-REC-NOTICES, CMP-REC-UPLOAD, CMP-REC-HOSTROSTER, CMP-REC-CLIPPING (take detail), Takes rows, the CMP-PIPELINE-CHIP popover, Script "Transcript out of date".
- Replaces: Job row, Check row, Model need row, Readiness check list (rdp); Room alert, Takes tray (record); Script header notice (edit).
- Story: `System/StatusRow`: Queued, Running, Done, NeedsYou, Failed, NeedsModel, Expandable, Alert, Inline; `System/StatusList`; `System/AlertSlot`.

**27. Status pill**
- 28 px (24 in the header): glyph, short text, optional ✕. One rendering for the room state and short persistent states.
- Used: Room status ("● 12:04 · Take 2", "Quiet please · 3", "Saving · 2 of 3", "Reconnecting…"), Following ("Following Rosa ×"), New version, the cuts delta in the Player, Solo (headphones, avatars, ✕), mix updating, Project card stage chip ("Review 6").
- Replaces: Room status pill (record); Solo chip, delta chip, mix ring (edit); Following pill, version pill, stage status chip (rdp).
- Story: `System/StatusPill`.

**28. Toast**
- One position: centered 12 px above the Player bar (above the dock on phone). Max 480 × 44. Icon, past-tense result, at most one action (Undo, or the next step).
- Lasts 6 s, paused on hover or touch, and 10 s for session-level undo (End session, Stop sharing). A new toast replaces the old one, and same-kind toasts merge ("3 cuts · Undo all").
- Used: TOAST-MAIN, every undoable action.
- Story: `System/Toast`.

**29. Coach tip**
- A one-line hint anchored to an element, shown once at the moment of first need, dismissed by any action.
- Used: DLG-GESTURES, CMP-RAIL-PEEK, the BAN-GUEST-ROLE first-visit hint, the Review keyboard footer hints, "Solo is just for your ears".
- Story: `System/CoachTip`.

**30. Cover.** The one "nothing to show here" layout.
- Anatomy: wordmark symbol 32 px (page size only), a 48 px case glyph, title 20/24, one sentence, at most one primary and one text button.
- Sizes: page and region.
- Phone: the text block starts at 30 % of the height and the primary is pinned in the thumb zone 16 px above the safe area.
- Kinds: empty (no tracks, no transcript, nothing to decide, no matches, no clip ideas), bad link, link ended, ended with a local recording (Save my recording), room full (occupant avatars, Try again), host asleep, not served here, region failed to load.
- Never server JSON.
- Used: SCR-ERROR, SCR-COVER, SCR-RECOVERY, SCR-GUEST-LINK-INVALID, BAN-LOADFAIL, SCR-REC-INVALID, SCR-REC-FULL, SCR-REC-ACCESS-ENDED, EMPTY-STATES, the empty Review.
- Replaces: Status cover (rdp), Room cover (record), Empty state pattern (edit).
- Story: `System/Cover`, one story per kind plus Phone and Region.

**31. Skeleton**
- Nothing for 300 ms, then static grey blocks in the destination's real layout (no shimmer until the animation pass), then at 4 s the line "Still loading…" with Retry.
- Used: SCR-SHELL-LOADING, SCR-LOADING, SCR-REC-LOADING, Home cards, queue.
- Story: `System/Skeleton` and each stage's `Loading` story.

### People and sharing

**32. Person.** One person, one colour (their track colour when they have a track), everywhere.
- Avatar sizes: 20 (Script margin), 24 (presence, comments), 28 (track header, listener row), 32 (Cover, Join header).
- The ring is the live level in the person's colour, with a 2 s red tick on a clip.
- The tile form (Record grid) is 4:3, radius 12, avatar at 40 %, with the name bottom-left and a glyph cluster bottom-right (`mic-off`, signal, `ear` for a listener). The top-right holds a clip count and an amber triangle for an alert. The ring becomes the saving ring after Stop.
- Host tile: a small Record glyph badge (no accent outline, since accent means selection).
- Empty tile: dashed, `user-plus`. It opens the Invite sheet at the record links.
- States: placeholder, joining, live, muted, speaking, clipping, weak, lost, saving, saved, failed, declined, left, empty.
- Used: MENU-PEOPLE, OVL-PRESENCE, CMP-TURN, CMP-TRACK-HEADERS, CMP-REC-ROSTER, all SCR-REC-ROOM-*, DLG-MCP (agent presence), BAN-FOLLOW.
- Replaces: Person tile (brief), Invite tile (record), presence avatars (edit, rdp).
- Story: `System/Person`: Avatar sizes, Tile states, Empty.

**33. Person picker**
- A row or list of Person avatars with names, a check on the current one, and Fix text to rename.
- Used: POP-SPEAKER, the INS-TRACK Person row, the INS-CLIP Track row, Session group track mapping, Source card speaker.
- Replaces: speaker popover (edit), track mapping menus (record).
- Story: `System/PersonPicker`.

**34. Role chip**
- A segmented control or a chip for a link role.
  - Can listen: `ear`.
  - Can comment: `message-square`.
  - Can edit: the Edit stage icon.
  - Can record: `mic`.
- Used: Link row, guest App header, Person sheet.
- Replaces: Role chip (rdp, where eye, pencil and headphones become ear, Edit icon and ear), the role segmented control in the Invite popover (edit).
- Story: `System/RoleChip`.

**35. Link row**
- 64 px: Role chip, link in mono truncated in the middle, opened-by avatars, Copy (`copy`; on phone, the system share sheet), More (QR code, pin to version, AI assistants, Replace link, Stop sharing).
- The link is minted on first Copy. When the clipboard is blocked, the text gets selected and the button reads "Press ⌘C".
- The **Invite sheet** is a Sheet of Link rows grouped Review links / Record links / Listen link, opened from the header Invite on every stage.
  - The Record empty tile opens it at Record links.
  - Deliver embeds the Listen link row in place.
- Used: the Deliver Share section, MENU-PEOPLE invite, INT-REC-INVITE, the Deliver listen link.
- Replaces: Link row (rdp), Invite popover (edit), Invite tile popover (record).
- Story: `System/LinkRow`, `Stages/Frame/InviteSheet`.

### Starting and sources

**36. Start tile**
- A large tap-and-drop target with a 32 px icon, a title and one line. Two kinds: Import audio (`file-plus`) and Record (filled circle).
- Sizes: 220 (empty Home), 160 (Home), 240 (empty Prepare), 160 × 96 (empty Edit), 80 (Prepare Sources footer), and on phone a 2-up bar of 72 in the thumb zone.
- States: rest, drag-hover, disabled with reason.
- Used: SCR-HOME, SCR-SHELL-INGEST, the SCR-PREPARE empty state and Sources column, the FLOW-REC-NEW entry.
- Replaces: Source tile (rdp), the Edit empty-state buttons (edit), the Home New sheet tiles (record). The New sheet itself is dropped.
- Story: `System/StartTile`.

**37. Project card**
- 240 × 152: Overview strip (48, static), name, "52:10 · edited 2 h ago", and a stage Status pill that says where the card opens. The phone form is a 72 px row.
- Used: SCR-HOME, the Project menu Recent rows (compact).
- Story: `System/ProjectCard`.

**38. Source card**
- One audio source: speaker swatch (Person), name field, file and duration, mini waveform, Hear (4 s of the voice), inline prompts (Split speakers, Replace audio by dropping on it), Person picker for mapping.
- States: uploading, probing, ready, needs name, failed, the split prompt ("One recording of several people?") and splitting ("Finding voices", plain progress, Cancel splitting).
- The voice-count stepper (2 to 8) and Split show only on the split prompt (`canSplit`); every other card is one voice. The stepper stops at its limits with a written reason and keeps focus.
- The More menu has Replace audio and Merge, plus Move up and Move down so reordering never depends on dragging; the ends of a session omit the one that cannot apply. Every control name carries the card's name, and two cards with one name read "Name, voice N".
- When the control that has focus goes away with a state change (Split, Cancel splitting, Try again), focus moves to the card; when the card itself is removed, to the next card, else the previous, else the Import tile.
- Section order on Prepare: at 60 rem and wider Sources comes first in the DOM, then Getting ready, Help the transcriber, Cleanup; on a phone the Getting ready summary comes before Sources (see item 39).
- Used: SCR-PREPARE, DLG-SPLIT, landed takes.
- Story: `System/SourceCard`.

**39. Session group**
- Header: session name (Fix text), Session target chip (locked after landing), stats ("3 people · 2 takes · 14:20"), Status ring. Body: Source cards (and, while recording, Take Status rows).
- Footer: the Stage hand-off ("Edit Session 2", or "Review pickup"). It is optional: Prepare omits it and draws the one Stage hand-off for the whole stage instead.
- Prepare order: at 60 rem and wider the DOM is Sources, Getting ready, Help the transcriber, Cleanup, hand-off, and the grid columns follow it. Below that it is one column and the Getting ready card moves to the top of the DOM behind a one-line summary button ("Getting ready: 2 of 3 done", `aria-expanded`) that opens the full card in place; the summary exists only at that width. The order in the DOM is the order drawn at every width, with no CSS reordering, so Tab, reading and visual order agree: summary, Sources, Help, Cleanup, hand-off.
- Used: the Prepare Sources column, the Record Takes rail.
- Replaces: Session summary card, Takes tray grouping (record); the Prepare session grouping (rdp).
- Story: `System/SessionGroup`.

**40. Drop overlay**
- A full-window overlay while dragging files, labelled with the outcome of the current target:
  - Anywhere: "New tracks".
  - Over a lane: "Add here on Maya's track", at the drop time.
  - Over a Source card: "Replace Maya's audio" (undo toast).
- Used: INT-IMPORT, SCR-SHELL-INGEST, SCR-HOME drop, the Prepare Sources column.
- Story: `System/DropOverlay`.

### Recording

**41. Record button**
- A 64 px round button with two faces. Idle or paused: a filled record-red circle (start or resume). Live: a square in a ring, hold 600 ms to stop, with the ring filling. Keyboard and assistive tech: Enter opens a Confirm-in-place with Keep recording (focused) and Stop take.
- Record red is reserved for recording app-wide.
- Used: DLG-RECORD, CMP-REC-STOP, INT-REC-START, INT-REC-STOP.
- Replaces: the record spec's three faces (the paused "resume notch" face is dropped) and the 72 px size.
- Story: `System/RecordButton`.

**42. Session target chip**
- 32 px: placement glyph and text ("Starts the episode", "Lands at the end · after 52:10", "Inserts at 12:04", "Replaces 12:04-12:09"; wording in `system/sessionTargetText.ts`). A Menu changes it before the first take: At the end, At the start, At the playhead (12:04) and Replace selection, the last two only when Edit has a playhead (and the timeline is not empty) or a selection (that ends inside the timeline) to read. A lock glyph replaces the menu once the first take has landed (the snapshot holds a take; `reducer.py` refuses SetTarget when takes exist). The chip is disabled while a command is in flight. Prepare keeps the two-value form (Starts the episode, At the end).
- Used: DLG-RECORD session header, FLOW-REC-LATER, FLOW-REC-PICKUP, Session group header.
- Story: `System/SessionTargetChip`.

### Navigation

**43. Stage hand-off button**
- The next stage's icon, a label with the reason ("Review 14 suggestions"), and `arrow-right`. Mod+Enter.
- Placement: desktop bottom-right of the stage content; phone directly above the Player bar.
- It is secondary weight until the stage's own work is done, then it becomes the primary, unless the stage already has its own primary (Deliver's Export).
- It appears in Record (after save), Prepare, Review (empty) and Deliver (when items are open). It never appears in Edit, where the Review badge does that job and the corner is the zoom cluster.
- Used: SCR-PREPARE, SCR-REVIEW, SCR-DELIVER, the Session group footer.
- Story: `System/StageHandoff`.

### Edit-local (not shared, listed so nobody re-invents them)

- **Target chooser** (POP-CHOOSER). A fan of 44 px object-kind chips on an ambiguous long-press. Story `Stages/Edit/TargetChooser`.
- **Find bar** (CMP-FINDREPLACE). 44 px under the Script header: field, "3 of 12", ↑/↓, Replace toggle, `Aa`, Cut all (its own button; Mod+Shift+Enter in the field, because Shift+Enter steps back as in every find box), Select all. Matching is the backend's: whole words, edge punctuation ignored, case folded. Muted words are skipped as the backend skips ignored ones. Cut words are skipped here although the backend does not skip them, so Cut all never cuts a cut again; a backend preview can therefore count more hits than the bar. For W2: (1) the backend matches over a transcript's whole word list, so a phrase that ends one turn and starts the next is replaced there but is not highlighted or counted by `findMatches`, which runs per turn (parity gap); (2) the host runs the backend preview and sends its `preview_token` with Replace all, and shows the skipped-word count ("N suppressed or ignored words skipped") that the legacy panel showed, since the bar has no props for either; (3) the backend drops a hit whose new words equal the old ones, so the host counts and replaces only `replacementChanges(turns, hits, replacement)`. Fix text refuses an empty field at Enter or Tab with "Text cannot be empty." and stays open, as the legacy editor did; leaving the empty field puts the words back. Replace waits for a replacement with a letter or a number. Story `Stages/Edit/FindBar`.

### Dropped as redundant

- The Blade tool and the Select/Blade tool toggle (CMP-TOOLRAIL). Modes are gone. Split is Mod+K at the playhead or Alt-click at the pointer, with a crosshair cursor and a 2 px guide (1 px ring) on the lanes the cut will land on, the targeted tracks else the dialogue tracks, while Alt is held over the lanes (W1a, #2294). Touch has no Alt: it splits with the Action bar's Split verb (the playhead, or both edges of a selection) or a long-press on a lane, whose Create-here menu opens with "Split here" (W1b, #2294).
- The Edit surface switch as its own element. It is a Segmented control instance: lanes (`chart-gantt`) and text (`text`).
- The Home New sheet (record FLOW-REC-NEW). Start tiles sit on Home directly, and name and folder default.
- The Re-record verb. It is the Record verb with a Replace target.
- The paused face of the Record button.
- Separate Marker and Notes controls in Record. Both are Comment: tap drops a marker, long-press or typing writes a note.
- The record-only Room alert, Room cover, Room status pill, Join sheet, Device sheet, Invite tile, Takes tray, Session summary card and Session marker. They are merged as listed above.
- The rdp Job row, Check row, Model need row, Readiness list, Player card, mini player, Review context strip, Status cover, History sheet and Home Help and more buttons. They are merged as listed above.
- The spec-edit Player sheet, Invite popover, eye popover, corner zoom cluster as an element, Empty state pattern and Coach tip duplicates. They are merged as listed above.
- The ? = Help key. ? opens the Palette.

---

## 3. Verb and icon language

Icons are Lucide where one fits (stroke 1.75, 16 px desktop, 20 px dock, 24 px tab bar). The filled variant means on or active, for example a filled `volume-x` on a muted track. Every verb has one icon, one key and one gesture. Keys never change meaning across stages, and single-letter keys are inactive while a text field has focus.

Decision (owner): `SystemIcon` stroke 2.1. Lucide draws on a 24 grid, so the 1.75 stroke of the 20 grid scales to 1.75 × 24 / 20 = 2.1 and keeps the on-screen weight of the existing `ui/Icon` set. Code and tests take the value from one exported constant, `SYSTEM_ICON_STROKE`.

| Verb | Icon | Key | Touch | Surfaces |
|---|---|---|---|---|
| Play / Pause | `play` / `pause` (ink-filled circle) | Space | Tap Play | Player (all stages), expanded Player |
| Shuttle | none | J back, K pause and return, L forward (repeat 1×, 2×, 4×) | Swipe the timeline | Player, every stage |
| Hear (play the selection) | `ear` | Shift+Space | Tap Hear | Action bar on any selection, Decision card, Take rows, Source card voice, Status rows (align move) |
| Hear before / after | "A" / "B" segmented | A / B (hold A with nothing selected = original; not built yet, W2) | Tap A or B, press-and-hold A | A/B audition: Decision card, Seam, Suggestion, Player |
| Cut | `scissors` | Backspace or Delete (Mod+X also copies) | Swipe right on a cut suggestion; dock button | Action bar (words, range, clip, cut suggestion), Decision card, queue group bulk, Find bar "Cut all", toast "Cut all" |
| Keep | `shield-check` | X | Swipe left | Action bar (suggestion, cut seam, cut words), Decision card, queue rows, auto-reduction region |
| Shorten | `fold-horizontal` | Enter (primary) | Swipe right | Pause suggestions |
| Lower | `volume-1` | Enter (primary) | Swipe right | Sound suggestions |
| Replace / Insert | `replace` / `between-horizontal-start` | Enter (primary) | Swipe right | Pickup and session suggestions in Review and Edit |
| Approve | `check` (word "Looks right" or "Use clip") | Enter (primary) | Swipe right | Check rows (align move, unsure word, transcript check), clip ideas in Deliver |
| Resolve | `message-square-check` | Enter (primary on a comment) | Swipe right | Decision card (comment), queue rows |
| Later | `chevron-down` | Tab or ↓ (moves on without deciding) | Swipe up | Decision card, Review dock |
| Next / Previous of the same kind | none | Tab / Shift+Tab (↓/↑ in the queue) | Swipe up / down on the card | Review queue, Edit after a cut (next occurrence), Fix text (next unsure word) |
| Apply to all like this | the verb's icon with a count | Shift+Enter | Group header button | Queue group bulk, Find "Cut all", toast "Cut all" |
| Split | `square-split-horizontal` | S or Mod+K: at the playhead, or at both edges of a range or words selection (one undo step); Alt-click at pointer | Action bar Split (at the playhead, or both edges of a selection); long-press a lane, then "Split here" | Action bar (range, clip, playhead), Create-here menu, phone dock |
| Comment (also marker, reply) | `message-square` | C | Tap Comment; long-press = compose with time pinned | Player (all stages), Action bar, Record dock, Decision card (reply), Marker, Review queue |
| Fix text (also rename) | `text-cursor-input` | Enter or F2 on a selection | Double-tap | Script, Decision card unsure word, marker titles, speaker, project title, session name |
| Remove (non-audio) | `trash-2` | Backspace or Delete on a non-audio object | Swipe left on list rows | Markers, comments (not by swipe: swipe left does nothing on a comment), tracks, envelope points, chapter rows, clip ideas, Home Recent ("Remove from list"), person in room (Confirm in place) |
| Mute | `volume-x` (track, words) / `mic-off` (your mic) | M | Tap | Track header, Mix sheet, Action bar More, Record dock, Person tile |
| Solo | `headphones` | Shift+S | Tap | Track header, Mix sheet, Solo Status pill |
| Inspect | `sliders-horizontal` | I (toggles) | Swipe the dock up; double-click the object | Action bar, Prepare Advanced. The Inspector opens only on Inspect, never because something is selected; Esc, Close or a new selection shuts it |
| More | `ellipsis` | . (period) | Long-press or right-click | Action bar, rows, cards |
| Record | filled circle | R: in Record, start or resume, and hold R 600 ms to stop. In Edit, opens Record with a Replace target (selection) or Insert target (playhead) | Tap; hold the Record button to stop | Stage bar, Start tile, Record button, Action bar (Edit, host only), "+" menu |
| Pause take | `pause` | P | Tap | Record dock (host) |
| Invite | `user-plus` | none (palette) | Tap | App header (every stage), empty Person tile, Deliver |
| Copy link | `copy` (phone: share sheet) | none | Tap | Link row |
| Export | `download` | Mod+E (with a range selected: export the range) | Tap | Deliver primary, Action bar on a range |
| Import | `file-plus` | Mod+I; drop files anywhere | Tap Start tile | Start tiles, Prepare, Edit "+" |
| Undo / Redo | `undo-2` / `redo-2` | Mod+Z / Mod+Shift+Z | Two-finger tap / three-finger swipe; long-press Undo = History | App header, every toast |
| Add chapter | `flag` | Shift+C | Double-tap the marker lane | Playhead menu, phone dock, Deliver Chapters |
| Find in transcript | `text-search` | Mod+F | Tap | Script header |
| Palette | `search` | / or ? | Tap | App header |
| Propose (find suggestions, clips) | `wand-sparkles` | none | Tap | Review queue header, Deliver Clips, Prepare |
| Go to stage / hand-off | stage icon + `arrow-right` | Mod+1..5; Mod+Enter (hand-off); E (open in Edit) | Tab bar; tap | Stage bar, hand-off, Readiness fixes, Decision card |
| Follow | `locate-fixed` | Esc stops | Tap in the Person sheet | Person sheet, Player ring |
| Leave room | `door-open` | none | Tap | Record guest and producer dock |
| Get model | `cloud-download` | none | Tap | Status rows (needs model), Settings |
| Split speakers | `split` | none | Tap | Source card |
| Show / hide | `eye` / `eye-off` | none | Tap | View sheet, Script show-cut-text |
| Zoom | none | = / − / \ (fit) / Z (to selection) | Pinch | Timeline |

Two glyphs carry a related second meaning on purpose:
- `ear` is both the Hear verb and the "Can listen" role. Both mean listening.
- `headphones` is both Solo and the Join-sheet "I'm wearing headphones" toggle. Both are about what reaches your ears.

Glyphs for controls that are not verbs, one meaning each:
- `skip-back-15` and `skip-forward-15` (custom: a rotate arrow with the number) for the Player's back and forward 15 s. They have no key; ←/→ are the fine moves.
- `chevron-left` is Back in a pushed Sheet step, `chevron-down` also collapses the expanded Player, and `x` closes or dismisses (Coach tip).
- Project menu rows: `history` (Recent), `folder-open` (All projects), `settings` (Settings), `plug` (Connect agent), `circle-help` (Help).

Everything else is one glyph for one meaning. Gesture grammar, in one line: tap selects, long-press opens a menu (or selects a range if you drag), swipe right does the primary, swipe left does the "no" (Keep or Remove), swipe up moves on, pinch zooms, two fingers undo.

Keys that browsers reserve are never used: Mod+N, Mod+T, Mod+W, Mod+R, Mod+D. F6 cycles regions (header, main surface, rail, Player) so Tab can rove inside a surface.

---

## 4. Layout tokens

### 4.1 Regions

| Region | Desktop / tablet | Phone |
|---|---|---|
| App header | Top, 48 | Top, 44 + safe area |
| Alert slot | Under the header, 0 or 44 | Under the header, 0 or 44 |
| Stage content | Fills | Fills |
| List rail (navigation lists: Review queue, Prepare Sources) | Left, 360 | Becomes a Sheet |
| Companion rail (Record Comments/Takes, Prepare "Help the transcriber") | Right, 360 | Becomes a Sheet with a peek |
| Script pane | Right split pane, 400 default (320 to 640), 480 at 1920. Stacked 50/50 on tablet portrait | Its own surface (segmented switch) |
| Action bar | Floating by the selection | Dock, 64, above the Player |
| Player bar / Record dock | Bottom, 56 / 80 | 56 / 80, above the tab bar |
| Stage bar | Header center | Bottom tab bar, 56 + safe area |

Phone bottom chrome is at most 176 px plus the safe area (dock 64, Player 56, tabs 56), and the on-screen keyboard hides all three. Record guests have no tab bar.

The Script measure caps at 68 characters in Script focus (Shift+T). Side by side at 400 px it holds about 44 characters. spec-edit claimed 68 at 400 px, which is not possible at 16 px type, so the claim is dropped.

### 4.2 Spacing

A 4 px grid. Use 4, 8, 12, 16, 24, 32, 48 only.
- 8 inside a cluster (icon buttons in one group).
- 16 between groups, and the phone side gutter.
- 24 between sections, and the desktop gutter.
- 48 above page titles on Home and Deliver.
- Content max widths: 1040 (Home, Deliver), 760 (Decision card, guest center column).

### 4.3 Sheet detents (phone)

- **Peek.** Content height, 64 to 120 px: the Action dock, the Record comments peek, the Prepare summary row.
- **Half.** 50 %.
- **Full.** 92 %, so the header and the status pill stay visible.
- The 88 % detent (record Join sheet) is dropped. The Join sheet opens at Full.
- The grip is 36 × 5 with a 44 px hit area. Tapping the grip toggles Peek and Half. Dragging below Peek dismisses (and clears the selection for the Inspector).

Desktop widths: Menu 280, anchored card 320, side panel 400, centered card 400, Palette 560.

### 4.4 Targets

| Thing | Size |
|---|---|
| Any touch target | at least 44 × 44 |
| Desktop icon button | 32 visual (44 hit under `pointer: coarse`) |
| Dock button | 48 |
| Dock primary and Record button | 64 round |
| Phone primary (sheet footer, Cover, hand-off) | 48 tall, full width, in the bottom thumb zone |
| Desktop primary | 36 inline, 40 page-level (Export, Join, hand-off promoted) |
| Edge handles (trim, suggestion) | 6 × 24 visual, 44 hit on touch |
| Selection handles | 12 px knob, 44 wide under touch and 44 tall toward the knob only, so no word on their own line is covered |
| Words and suggested runs in running text | the line pitch tall (26, phone 28) and as wide as the word. A 44 px square would cross into the lines above and below and take their presses. The cut pill, the speaker name and the turn time in the margin are real 44 px targets |

### 4.5 Type

- Plex Sans: 13/16 meta, 15/20 UI body, 20/24 card titles, 28/32 page titles.
- Reading (any transcript: Script, Decision card excerpt, guest transcript): 16/26 on desktop, 17/28 on phone.
- Plex Mono for every time and number: 13 in rows, 15 in the Player.
- Times always read "12:04". Ranges read "12:04 to 12:09".

### 4.6 One status glyph set

The same glyphs are used in Status rows, badges, the Save indicator, tiles and pills.

| State | Glyph and colour |
|---|---|
| Done | `circle-check` |
| Running | progress ring |
| Not yet | hollow `circle` |
| Needs you | amber `triangle-alert` (an 8 px amber dot in badges) |
| Failed | red `octagon-alert` |
| Offline / waiting to send | amber `cloud-off` |
| Live | record-red dot and clock |

### 4.7 The one primary-button rule

- Each context has at most one accent-filled button. A context is a stage's content, a Sheet, or a card.
- The Player's Play is ink-filled, not accent, so the stage primary is still the only accent fill on screen.
- Record red appears only on things that record.
- Danger red appears only on failures and on the confirm button of something Undo can't reverse.
- The Stage hand-off is secondary until the stage's work is done.
- Edit's chrome has no primary. A selection's primary sits at the trailing end of its Action bar.

### 4.8 How selection looks everywhere

| What | Look |
|---|---|
| Selected object (clip, seam, marker, tile, card) | 2 px accent outline, handles visible |
| Selected span (words, range, queue row, list row) | accent-subtle fill (about 12 %) with 2 px accent edges (rows: a left edge) |
| Current Review item | the same as a selected row; the Overview tick is accented |
| Multi-select | the same per item, and the count leads the Action bar |
| Remote person's selection | 1 px outline in their colour, no fill |
| Keyboard focus | 2 px accent ring offset 2 px, `:focus-visible` only |
| Proposed | hatch in the suggestion token |
| Applied cut | Seam (diamond or pill), or solid strike when show-cut-text is on |
| Muted | grey with `volume-x` |
| Speaking | ring and border in the person's colour |

Colour roles, all existing tokens:
- Accent: selection, primary, playhead, focus.
- Person colour: who.
- Record red: recording.
- Suggestion token: proposed.
- Cut token: removed.
- Amber: needs you.
- Danger: failed or irreversible.
- Ink: transport.

---

## 5. Conflicts resolved

Every place the specs disagreed or collided with each other or with themselves. E = spec-edit, R = spec-record, D = spec-review-deliver.

### Keys

| # | Conflict | Decision | Why |
|---|---|---|---|
| K1 | Mod+1..5: E has Prepare = 1, Record = 2 | Record = 1, Prepare = 2, then Edit 3, Review 4, Deliver 5 | Stage order (1.1). Edit, Review and Deliver keep their keys |
| K2 | Enter: E has Enter accept a suggestion and Enter select a focused clip. D has the primary verb. R has Enter on the Record button | Enter is the primary of the selected object. On a focused, unselected object it selects. In a field it commits. On the focused Record button it opens Keep/Stop | One rule ("do the default for what you're on") covers all four |
| K3 | J/K/L: E has shuttle. D has J/K next and previous and L Later | J/K/L are shuttle everywhere. Review moves with ↓/↑ or Tab/Shift+Tab. Later is Tab or ↓ | The Player persists across stages, so its keys must too. Later is "next without deciding" |
| K4 | C: today it is Blade, E makes it Comment, R uses M for Marker and N for notes | C is Comment everywhere: marker, note, reply | A marker is a comment without text. Reply is commenting on a comment |
| K5 | B: E moves Blade to B, while A/B uses B for "after" | The Blade tool is removed. B is "after". Alt-click splits at the pointer | Removes a mode (E removed modes from the Script for the same reason) and frees B |
| K6 | O (E: hold to hear the original) next to A/B | Hold A with nothing selected plays the original. O is unused | One audition control |
| K7 | M: E has Mute track, R has Marker, R has Mod+D mute self | M is Mute everywhere (track in Edit, your mic in Record). Mod+D is dropped | One key per verb. Mod+D is the browser's bookmark key |
| K8 | Shift+M add chapter (E) clashes with the M = Mute meaning | Shift+C | The C family pins things to the marker lane |
| K9 | R: D has reply, R has record start, D has Home ⌘R | R is Record everywhere. Reply is C | Recording is the higher-consequence verb and owns its letter |
| K10 | ⌘⇧C copy listen link (D) | Dropped (palette only) | Shift+C is Add chapter. The action is rare |
| K11 | ⌘N new, ⌘O open (E); ⌘N import, ⌘R record, ⌘O open other, ⌘⇧O Home (D) | Mod+O goes to Home from anywhere (and on Home it opens Open other…). Mod+I imports. R records on Home. Enter opens the focused card. No Mod+N | Browsers reserve Mod+N and Mod+R. Mod+I is already Import in D's Prepare |
| K12 | Mod+Shift+E (E) versus ⌘E (D) for export | Mod+E | One key. On a selected range it exports the range |
| K13 | ? as Help on Home (D) versus the palette (E) | ? opens the Palette, which holds a Help group | One discovery surface |
| K14 | G R chords (R) | Dropped | No other spec uses chords |
| K15 | Mod+B force mix refresh (E) | Palette only | The mix refreshes on its own |
| K16 | Tab: E uses it for clip focus, next occurrence, and next unsure word | Tab is "next of the same kind" inside a content surface. F6 moves between regions | Keeps one meaning for Tab and gives keyboard users a way out |
| K17 | Skip 5 s (E desktop) versus 15 s (E phone sheet, D Player card) | 15 s everywhere. Fine moves use ←/→ (1 s, Shift 5 s) | Podcast-app convention, for one Player |
| K18 | S: E has Solo track on S, and the Action bar's Split needs a visible key | S is Split (Caleb, 2026-10-28). Solo is Shift+S, still a button on the track header and in the Mix sheet | Split is the constant verb on a selection; Solo is a mix toggle with a button of its own |

### Icons

| # | Conflict | Decision | Why |
|---|---|---|---|
| I1 | Edit stage drawn as scissors (D) | Waveform with a text cursor | Scissors is Cut |
| I2 | Prepare stage drawn as sliders (D) | `wand-sparkles` | Sliders is Inspect. The wand already means "the app proposes" |
| I3 | Deliver stage drawn as an arrow out of a tray (D) | `send` | That arrow is Export. A stage icon means "go there" |
| I4 | Review stage drawn as a check in a bubble (E) | `inbox` | That glyph is Resolve |
| I5 | Keep as a U-turn arrow (E) versus shield over waveform (D) | `shield-check` | The U-turn arrow is Undo |
| I6 | Listen-only role as eye (D) versus ear (E); producer as headphones (D); Follow as eye (E) | Listen role = `ear`, producer = `ear`, Follow = `locate-fixed`, eye only for show and hide | There were three meanings on the eye. Headphones is Solo |
| I7 | Editor role as pencil, "Open in Edit" as pencil, speaker rename as pencil | Role and Open in Edit use the Edit stage icon. Rename is Fix text | One glyph per meaning. Going to a stage always uses the stage icon |
| I8 | Hear as speaker-wave (E) | `ear` | Speaker glyphs mean volume (Lower, Mute track, level) |
| I9 | Re-record as mic with a return arrow (R) | The Record glyph (and verb) with a Replace target | One verb |
| I10 | "Find more" as a magnifier (D) | `wand-sparkles` | The magnifier is the palette |
| I11 | Session marker drawn as a bracket (R) next to clip brackets (E) | A session band on the ruler | Two brackets in one lane read as one thing |
| I12 | Failed as a red triangle (E save) versus a red octagon (D) | Red octagon for failed, amber triangle for needs you | One glyph set (4.6) |
| I13 | Import as an arrow into a tray (D) next to the `inbox` Review stage | `file-plus` | Avoids two tray glyphs |
| I14 | Host tile accent outline (R) | Record-glyph badge | Accent means selection |
| I15 | Speaking ring in accent (R) | The person's colour | Accent means selection. Colour means who |
| I16 | Advanced (Prepare) as a gear (D) | `sliders-horizontal` (it opens an Inspector) | Gear is Settings |

### Elements and layout

| # | Conflict | Decision | Why |
|---|---|---|---|
| L1 | Header: E puts Undo/Redo left, with a Project menu, search, 24 px avatars and 32 px tabs. D puts Undo/Redo right, with a "more" button, 28 px avatars and 40 px tabs | E's layout | Undo sits by the save state (document state). People sit on the right. 32 px tabs leave air in 48 px |
| L2 | Click on the title: rename (D) versus menu (E) | Menu, whose first row is a rename field. Double-click the title renames directly | One button, both jobs, and nothing lost |
| L3 | Phone player: 56 px Player bar (E) versus a 64 px mini player with Comment (D) | 56 px, and Comment moves into the Player on every device | One Player. Comment at the moment is the listener's most likely act |
| L4 | Guest Player card (D) versus phone Player sheet (E) | One Player, expanded form | The same object |
| L5 | Review context strip at 56 (D) versus Overview strip (E) | Overview strip, 32 px, above the Player | One miniature |
| L6 | Status cover (D) versus Room cover (R) versus Empty state (E); glyph 48 versus 64; phone text in the lower half versus at 30 % | One Cover. 48 px glyph. Text from 30 %, primary pinned in the thumb zone | Reads well and reaches well |
| L7 | Loading: 4 s (E, R) versus 8 s (D) | 300 ms blank, then skeleton, then 4 s "Still loading…" with Retry | Two of the three specs agreed. Sooner honesty |
| L8 | Toast 5 s (E) versus 6 s (D) versus 10 s (R, End session) | 6 s, and 10 s for session-level undo | Enough to reach Undo. The long form only where the server's window applies |
| L9 | Stop sharing as an inline confirm (D) versus End session as an undo toast (R) | Both undo toasts (10 s). The server keeps the token restorable for 10 s. Confirm in place only for Remove person from the room | Confirm only when Undo is impossible (rubric) |
| L10 | Home: a New sheet with Record and Import (R) versus Start tiles on Home (D) | Start tiles on Home. No New sheet. Name and folder default | One click fewer. D removed the create form |
| L11 | Invites: header Invite (E), Review header Invite (D), Invite tiles (R), Deliver share card (E, D) | One Invite sheet of Link rows, from the header on every stage. The empty Person tile opens it at Record links. Deliver embeds the Listen row | One sharing object. D's Q4 is answered |
| L12 | Commenter guest: Edit in suggest mode (E) versus Review only with "Suggest a cut" (D) | Review only. The Commenter's Cut verb makes a Suggestion. No separate "Suggest cut" verb | Same verb, result by role |
| L13 | Editor guest: Prepare, Edit and Review (E) versus Edit and Review (D) | Edit and Review | Prepare touches the host's models and files |
| L14 | Guest header at 56 (D) | The 48 px App header with a two-line title | One header |
| L15 | Deliver badge: check when Readiness passes (E) versus check when a current export exists, amber when stale (D) | D | Delivered is the fact the badge reports |
| L16 | Review badge: suggestions and comments (E) versus all undecided (D) | All undecided, checks included | Matches the queue count |
| L17 | Record dock (R), phone action dock (E), Review thumb buttons (D), Decision card action row (D), all ordered differently | One Action bar with three forms and one verb order: Keep left, primary right | Thumb position and swipe direction agree everywhere |
| L18 | Record button 72 (R) versus dock primary 64 | 64 | One primary size |
| L19 | Join sheet: desktop 420 at the top (96 px), phone 88 % (R) | Sheet centered card 400, phone Full (92 %) | Standard widths and detents |
| L20 | Join rows (R) versus Check rows (D) | Status rows | Same anatomy |
| L21 | Device sheet (R) | The Inspector of your own Person tile | Tapping a thing selects it. Inspect shows its properties |
| L22 | Room alert (R) versus app-wide attention (none) versus Script notices (E) | Alert slot of Status rows on every stage. Region notices are inline Status rows | R asked for exactly this |
| L23 | Job row, Check row, Model need row (D); Takes rows (R) | One Status row | Same glyph, title, detail, one action |
| L24 | Session summary card (R) versus Prepare session grouping (D) | Session group, in both places | One Session object |
| L25 | Session marker in the marker lane (R) versus the recording band (E, R) | The live band lands as the ruler session band | No bracket collision (I11) |
| L26 | Hand-off at bottom-right (D) versus Edit's corner zoom cluster (E) | No hand-off in Edit | Avoids the collision. The Review badge does the job |
| L27 | Loudness in Prepare and Deliver (D) and in Project settings (E) | Deliver only | One setting, one place. Mastering is Deliver's |
| L28 | Vocabulary in Prepare (D) and Project settings (E) | Prepare only | Same rule |
| L29 | Help button and "more" on Home (D) versus Project menu rows (E) | The Project menu (app menu on Home) holds Settings, Connect agent and Help | One menu |
| L30 | Dropping on an existing track: add (E) versus replace (D, Source card) | Lane = add at the drop time. Source card = replace. The overlay names the outcome | Each surface does what its axis implies, and the result shows before you drop |
| L31 | Clip idea "Keep" means approve (D), opposite to Keep | Approve (`check`). Dismiss is Remove | Keep only ever means "leave the audio as it is" |
| L32 | Clip idea drawing: Suggestion (D) versus social bracket (E) | A bracket, hatched while proposed and solid once approved | Hatch means proposed everywhere |
| L33 | Decision card order "Later, Keep, Verb" (D) versus Action bar "Hear, Cut, Keep…" (E) | The universal order in element 7 | Same verbs in the same places |
| L34 | Comment popover in Edit (E) and suggestion inspector (E) versus Decision card (D) | Decision card, compact, in an anchored Sheet | E itself said "same component" |
| L35 | History: popover with preview (D) versus history popover (E) | A Sheet instance, with D's preview behaviour | Same thing |
| L36 | Following: ring, pill and a 2 px content frame (D) versus banner and a ring on Play (E) | Thicker avatar ring, a Following Status pill, and the ring on Play. No frame | A coloured frame competes with selection |
| L37 | Presence avatars 24 (E) versus 28 (D) | 24 | Fits the 48 px header |
| L38 | Swipe left on a comment row resolves (D) | Swipe right resolves (it is the primary). Left is Keep or Remove; swipe left does nothing on a comment | Gesture grammar |
| L39 | Phone Review: Keep and verb at 56, plus a 48 A/B row (two rows) | One 64 px dock row: Keep, A/B, verb | Saves 48 px. One dock height |
| L40 | Record "Notes" versus Review "Comments" | Comments. Record's rail is the Review queue (Comments, chronological) and Takes | One object before and after landing (R said the same) |
| L41 | Rails: Record 320 right, Prepare 360 left and 320 right, Review 360 left | List rails 360 on the left, companion rails 360 on the right | Two rail roles, one width |
| L42 | Phone playhead dock "Comment here" (E) | Comment lives in the Player. The playhead dock has Split, Add chapter, Record, Paste | One home per verb |
| L43 | E Q2: show suggestions inline in Edit? | Yes. They are decidable in place with the same verbs | One element per kind. Edit never hides pending work |
| L44 | E Q1: should a text cut remove time on every track? | Yes. A range scoped to fewer tracks leaves silence, and the Scope chip shows which before you act | Keeps speakers in sync. The outcome is visible first |
| L45 | E Q3 and Q4: bottom transport, and dropping the audition switch | Yes to both | Already implied by the Player |
| L46 | E Q5 and Q6: five phone tabs, and the key changes | Yes to both | One model across devices |
| L47 | D Q5: swipe on the phone Decision card on by default? | On, with an 80 px threshold and the verb icon growing while you drag. Every decision is undoable | Undo makes it safe |
| L48 | D Q7: Clips in Deliver? | Yes. The markers stay in Edit | Clips are an output |
| L49 | R Q8: matching returning guests to their tracks | Match by display name, corrected with the Person picker on each Source card in the Session group | No extra step before the first take |
| L50 | R Q9: room tone in the pre-roll | Yes. A one-minute "Stay quiet" countdown (End early / Cancel) on the first take of each session, with a fallback in your tile's Inspector | Removes a mandatory lobby step for every guest |
| L51 | E: the Script measure claim (68 characters at 400 px) | 68 characters in Script focus only | Physically about 44 at 400 px |
