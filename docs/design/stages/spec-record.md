> **Reconciled by design-system.md** (that file wins where they differ). Terms changed here:
> - Stage order adopted as Q1 recommends: Record, Prepare, Edit, Review, Deliver (Mod+1 is Record). The G R chord is dropped.
> - The Record dock is the **Action bar** in its dock (transport) form. The dock primary and the Record button are 64 px, not 72. The paused "resume notch" face is dropped, leaving two faces.
> - Room cover became **Cover**. Room alert became the **Alert slot** of Status rows. Room status pill became **Status pill**. Join sheet and Device sheet became **Sheet** instances: Join is a centered card 400 px or phone Full at 92 % (not 88 %), and Device is the Inspector of your own Person tile. Join rows are Status rows.
> - Invite tile became an empty **Person** tile that opens the shared Invite sheet of **Link rows**. Takes tray became a Status list. Session summary card became **Session group** (shared with Prepare). Session marker became a session band on the Timeline ruler (not a bracket in the marker lane).
> - Notes rail became the **Review queue** (Comments, chronological) in the right rail. Notes are "comments". Marker is the Comment verb: tap drops a pin, long-press writes a note.
> - Re-record became the **Record** verb with a Replace target. Record here is the Record verb with an Insert target.
> - Keys: Marker M became C, notes N became C, mute Mod+D became M, and hold R stops a take.
> - Host tile uses a Record-glyph badge, not an accent outline. The speaking ring is in the person's colour, not accent. The producer and listener glyph is `ear` (headphones is Solo).
> - End session stays an undo toast (10 s). Q8 (track matching) and Q9 (room tone pre-roll) are decided in design-system.md.
> - Storybook titles: `System/*` and `Stages/Record/*` replace `Record/*`, `StageBar` and `Timeline/RecordingOverlay`.

# Record stage: design spec

Area worker: Record. Inputs read: SPEC-BRIEF.md, rubric.md, inventory.md (sections 4, 10, 11, 12), ui-directions.html (Direction C and critique), every SCR-REC-* and DLG-RECORD* shot, `gui/web/src/record/` (RecordApp, Room, Lobby, RecordPanel, StopTakeControl, RecordTransportChip, types, hostControls), `timeline/RecordingOverlay.tsx`, `ux/pages/guest-journeys.md` sections 6 and 7, `docs/recording-session.md` (vocabulary, roles, clock and landing, takes), `src/podcast_mcp/services/record/landing.py` and `landing_math.py`.

Facts from the code that shape this spec (each one checked in the files above):
- A room is one `session_id` with a guest link and a producer link. A take is one Start to Stop. Cap is 4 recorded people (host included) and 2 producers.
- Audio only. No video capability ships (`video` is a "later" cap).
- Guests see only their own level meter today. Remote audio already arrives at every client through the mix-minus mesh, so remote levels can be metered locally with no server change (inferred from `docs/recording-session.md` mix-minus section).
- Guests see only their own live notes before landing. Host and producers see all.
- Start is blocked until at least one guest has joined (`no_guest` blocker in `services/record/state.py`). A host cannot record alone today.
- Landing is automatic after the file ACK, and the Land button is a manual duplicate.
- Landing places a room's takes from timeline 0:00, takes in order with a 2 s gap (`take_offsets_s` starts its accumulator at 0). Tracks are keyed by `participant_id` and labelled with the display name. In a project that already has content, a second room's takes land on top of the existing episode at 0:00, on new tracks. This is the root problem the "later sessions" design below fixes.
- `/rec/<bad token>` and a revoked link both answer raw JSON `{"detail":"not found"}` (shots SCR-REC-INVALID, SCR-REC-ACCESS-ENDED). The designed ErrorScreen and access-ended cover never render on those paths.

---

## 1. Area summary

**What Record is for.** Record is where audio enters a project from people: the first conversation, a second guest a week later, a pickup line, an intro. It is one shared room. The host, recorded guests and producers all look at the same surface: one tile per person with a live level, who is speaking, their connection and saving state, and the session notes. Waiting and recording are two phases of that one room, not two apps.

**Main surface.** The **Room**: a grid of Person tiles over a bottom Record dock, with a Notes rail on the right (desktop) or a Notes sheet (phone). The room is the same component for every role. Role only removes controls: guests have no Record button and no invite tiles. Producers have no mic.

**Entering.**
- Host from any stage: the **Record** item of the Stage bar (first position: Prepare, Record, Edit, Review, Deliver is the brief's order; I recommend Record, Prepare, Edit, Review, Deliver for a project born from a recording, see question Q1). Keyboard `G R` (if the stage-bar spec adopts G-chords) or the Stage bar shortcut that spec defines.
- Host from Home: New, then **Record** (section 2, FLOW-REC-NEW).
- Host from Edit with a selection: the **Re-record** verb on the floating action bar (FLOW-REC-PICKUP). From the playhead (the Action bar) or the Plus menu under the last track: **Record here**, which parks an Insert target at the playhead (over an empty timeline it opens Record with its default target). The empty-timeline long-press menu is not wired to it yet.
- Guest or producer: their `/rec/<token>` link opens the Room directly with the Join sheet on top. There is no other stage for them. They never see the Stage bar.

**Leaving.** The host switches stage at any time, including during a take. Recording continues. The Record item in the Stage bar turns into the Live badge (red dot and take clock) so the take is never out of sight, and one click returns. Ending the session is a separate, explicit action in the room's overflow menu. Leaving the stage never ends it. Guests leave with the Leave button, which is held back only while their recording is still saving.

**What the stage replaces.** DLG-RECORD (the Record room dialog), CHIP-REC-TRANSPORT, the Menu > Project > Record room… entry, the record half of the old Share dialog, and the separate `/rec` lobby, waiting, room and dead-end pages.

**Data shape (Model the Domain).** Today the guest page (now GuestRoomApp, formerly RecordApp) switches between four views and RecordPanel carries a dozen booleans. The redesign drives one `RoomView` from one discriminated union:

```ts
type Role = "host" | "guest" | "producer";
type RoomPhase =
  | { kind: "loading" }
  | { kind: "cover"; reason: "invalid" | "full" | "accessEnded"; localRecording: boolean }
  | { kind: "joining"; step: "name" | "mic" | "ready" }      // Join sheet open over the room
  | { kind: "declined"; canRejoin: boolean }
  | { kind: "waiting" }                                       // no take running
  | { kind: "countdown"; secondsLeft: 3 | 2 | 1 }             // pre-roll, room tone captured
  | { kind: "live"; take: number; clockMs: number }
  | { kind: "paused"; take: number; clockMs: number; reason: "host" | "hostReconnect" }
  | { kind: "saving"; take: number; savedPeople: number; totalPeople: number }
  | { kind: "saved"; summary: SessionSummary };

type SessionTarget =
  | { kind: "start" }                                         // first session of a new project
  | { kind: "end" }                                           // default for later sessions
  | { kind: "insert"; atSec: number }
  | { kind: "replace"; fromSec: number; toSec: number; trackIds: string[] };

type RecordingSession = {
  id: string; name: string; createdAt: string;               // "Session 2 · Sat 25 Oct"
  target: SessionTarget; takes: TakeState[]; ended: boolean;
};

type PersonTileState = {
  person: RecordParticipant; isMe: boolean; level: number;    // 0..1, local meter
  speaking: boolean; connection: "good" | "weak" | "lost";
  capture: "ok" | "micLost" | "noAudio" | "storage" | "none";
  clipped: number; saving: { done: number; total: number } | "saved" | "failed" | null;
};
```

Alerts are a priority-ordered list derived from this state, not separate notice components (see NEW: Room alert).

---

## 2. Items

### SCR-REC-LOADING · Loading the room
- **Today:** SCR-REC-LOADING--desktop-light/dark.png, --phone-light/dark.png. Feedback and state: one centred line "Loading project…" on a blank page, which names the wrong thing (a guest is joining a room, not loading a project). Bar: a blank screen is the first impression for every guest. Consistency: the loading copy differs from the review-link loading copy.
- **Fate:** replace with Room skeleton.
- **Spec:** render the Room shell immediately: guest header (wordmark 20 px, project name placeholder bar), 2×2 grid of tile placeholders (avatar circle and name bar, no shimmer since no animation work yet), dock with disabled buttons. If bootstrap takes over 4 s, show a single line in the alert slot: "Still connecting…" with **Retry**. No text in the normal case.
- **Shared elements used:** Person tile (placeholder state), Record dock (disabled), NEW: Room alert.
- **Story to build:** `Record/Room` › `Loading`, `LoadingSlow`, `LoadingPhone`.

### SCR-REC-INVALID · Link does not open a room
- **Today:** SCR-REC-INVALID--desktop-light/dark.png, --phone-light/dark.png show raw JSON `{"detail":"not found"}` with the browser's Pretty-print checkbox. Feedback and state: a dead end with no next step and no product identity. Language: server words. Bar: the worst screen in the app, and it is the one a mistyped link hits.
- **Fate:** replace with NEW: Room cover. Server fix: `/rec/<token>` must always serve the app shell to `Accept: text/html`, and the app renders the cover from the bootstrap 404.
- **Spec:** centred column max 360 px. A 64 px glyph (a door outline with a slash), headline "This link doesn't open a room", one line "Ask the person who invited you for a new link." No buttons except **Open ShareCut** as a quiet text link to the marketing site (decision for marketing; omit if none). Phone: glyph at 30% height so the text sits in the reading zone.
- **Shared elements used:** NEW: Room cover.
- **Story to build:** `Record/RoomCover` › `Invalid`, `InvalidPhone`.

### SCR-REC-FULL · Room full
- **Today:** SCR-REC-FULL--phone-light/dark.png. Language: "This room is full (4 recorded / 2 producers)." uses internal caps and role names. Feedback and state: no next step. Hierarchy: headline sits at 45% height with no glyph or brand, so it reads as a broken page.
- **Fate:** replace with NEW: Room cover.
- **Spec:** glyph is the 2×2 tile grid with all four tiles filled. Headline "The room is full". Line: "Ask Maya to make space or send you a new link." (host display name from bootstrap). One button **Try again** (secondary weight, 44 px) that re-requests the join, since someone may have left. The cover shows the occupants' avatars (32 px) under the line so the guest sees it is a real room.
- **Shared elements used:** NEW: Room cover, Person tile (avatar only, 32 px).
- **Story to build:** `Record/RoomCover` › `Full`, `FullPhone`.

### SCR-REC-DECLINED · Declined to be recorded
- **Today:** SCR-REC-DECLINED--*-story.png (story only; live path unreachable per index.json). Purpose: the guest is ejected to a text page and loses sight of the room. Feedback: "the host can invite you as a producer" asks the guest to explain a product role to the host. No action.
- **Fate:** replace with the Room's `declined` phase (no separate page).
- **Spec:** the room stays visible behind a dim scrim (tiles at 40% opacity, no audio). A peek bar docks at the bottom (72 px, safe-area aware): mic-slash glyph, "You're not being recorded." and a primary **Join recording** button. While a take is live or paused the button is disabled with the reason "You can join after this take." (today's rule: no join during REC or PAUSED). When the room returns to `waiting`, the button enables and opens the Join sheet at the consent step. The host's tile for that person shows the mic-slash and "Declined" under the name.
- **Shared elements used:** Person tile, NEW: Join sheet, NEW: Room status pill.
- **Story to build:** `Record/Room` › `GuestDeclinedDuringTake`, `GuestDeclinedCanRejoin`, `GuestDeclinedPhone`.

### SCR-REC-ACCESS-ENDED · Access ended or invite closed
- **Today:** SCR-REC-ACCESS-ENDED--desktop-light/dark.png, --phone-light/dark.png. The capture shows the raw JSON 404 on a revoked link, so the designed cover (Recover, Download full-quality recording) is unreachable in the reopen case. Feedback and state: the one case where the guest may still hold an unsaved recording gets the least help.
- **Fate:** replace with NEW: Room cover (server fix as for SCR-REC-INVALID: a revoked token must still bootstrap far enough to say "ended" and let the device check its local copy).
- **Spec:** two variants decided by `localRecording`.
  - No local copy: glyph is a closed door, headline "This session has ended", line "Thanks for recording." No button.
  - Local copy on this device: headline "Your recording didn't finish saving", line "It's safe on this device. Save it and send it to Maya." Primary **Save my recording** (downloads the ZIP of retained segments plus room tone). Secondary **Try saving again** when the host still accepts uploads (today's Recover). After a download, the primary turns to a check and "Saved to Downloads".
- **Shared elements used:** NEW: Room cover.
- **Story to build:** `Record/RoomCover` › `Ended`, `EndedWithLocalRecording`, `EndedDownloaded`, `EndedPhone`.

### SCR-REC-LOBBY-GUEST · Guest lobby (also -PRE and the device, consent and room-tone parts)
- **Today:** SCR-REC-LOBBY-GUEST-PRE--desktop-light.png, SCR-REC-LOBBY-GUEST--desktop-light.png, --phone-light.png.
  - Interaction cost: five stacked sections (name, headphones checkbox, microphone, room tone, consent) each with its own buttons. On phone the page is 2,548 px tall and Accept is at the bottom.
  - Hierarchy: three red primaries compete (Allow microphone, Record room tone, Accept), and two are disabled-looking pink.
  - Language: "Optional quiet bed for filler pads", "-∞ dBFS", "Clear clip light", "Producers/listeners may be present and are shown in the roster." are engineer words.
  - Purpose: the guest cannot see who else is in the room or that the host is there. The lobby feels like a form, not arriving at a studio.
  - Feedback and state: a red-bordered input picker and "Clipped" before the guest has spoken.
- **Fate:** replace with NEW: Join sheet over the live Room.
- **Spec:**
  - **Layout.** The room renders behind (tiles of people already here, status pill "Waiting for Maya to start" or "Recording · 04:12"). The Join sheet sits on top. Desktop: centred card 420 px wide, top at 96 px, room visible around it. Phone: bottom sheet at the large detent (88% height). The top 12% shows the room's avatars in a row with "Maya and Jon are here".
  - **Rows**, each 56 px, each with a status glyph on the left that turns into a check:
    1. Name field, prefilled from the last name used on this device. Autofocus on desktop, not on phone (keyboard would cover the sheet).
    2. Mic row. Before permission: the row is the primary button **Allow microphone** (full width, 48 px). After: a live self level bar (same meter as the Person tile), the input name as a chip that opens a menu of inputs, and a 24 px headphone glyph toggle. Denied: the row turns amber with "Microphone blocked" and **How to allow** (opens platform steps in a popover: Safari iOS, Chrome Android, macOS, Windows). Lost input, missing saved input and no input map to the same row with one sentence and **Retry**.
    3. Headphones: a toggle chip with the headphone glyph, "I'm wearing headphones". Preset to on when the input or output label contains a known headphone name (AirPods, Buds, headset, headphones). Required to join (today's rule; see Q6).
  - **Consent.** Above the primary, two lines: "You'll be recorded in full quality on this device. It saves to Maya's project when the take ends." plus a **Details** disclosure with the current full consent text and the list of listeners ("Rosa is listening and won't be recorded").
  - **Primary.** **Join and record** (filled accent, full width, 52 px, bottom of sheet in the thumb zone). Pressing it is the consent act. It stays disabled with an inline reason under it naming the first unmet row ("Allow your microphone first").
  - **Secondary.** **Not now** text button under the primary (declines).
  - **Room tone** is removed from joining. It is captured for everyone at once in the pre-roll countdown (INT-REC-START). The per-person capture survives in the Device sheet for late joiners.
  - **Clip light.** The meter shows a red tick at the right end for 2 s after a clip, then clears itself. No "Clear clip light" button. A clip during the check shows one line under the meter: "Too loud. Move back a little."
  - **Storage warning.** Shown only when headroom is low, as one amber line in the mic row ("Low space on this device. Close other tabs.").
  - **Keyboard.** Enter on the name moves to the mic row. Enter on a ready sheet joins.
  - **States.** Pre-permission, prompting (row shows "Waiting for your browser…" next to the button), granted, denied, input lost, ready, joining (primary shows a spinner glyph and stays in place), room full on submit (sheet closes and the Room cover appears).
- **Shared elements used:** NEW: Join sheet, Person tile meter, Icon language (mic, mic-slash, headphones, check), Sheet detents.
- **Story to build:** `Record/JoinSheet` › `GuestPreMic`, `GuestPrompting`, `GuestDenied`, `GuestInputLost`, `GuestReady`, `GuestClippedDuringCheck`, `GuestLowStorage`, `GuestJoining`, `GuestPhone`, `GuestPhoneReady`.

### SCR-REC-LOBBY-PRODUCER · Producer lobby
- **Today:** SCR-REC-LOBBY-PRODUCER--desktop-light.png, --phone-*.png. Language: "Producer (not recorded)" as an H1 plus "Not recorded" in bold below repeats itself. Purpose: no sign of who is in the room.
- **Fate:** merge into NEW: Join sheet (producer variant).
- **Spec:** same sheet with one row (name) and the headphone glyph in the header. Line: "You'll listen and take notes. You won't be recorded." Primary **Join to listen**. No mic, consent or headphones rows.
- **Shared elements used:** NEW: Join sheet.
- **Story to build:** `Record/JoinSheet` › `Producer`, `ProducerPhone`.

### SCR-REC-WAITING-GUEST · Guest waiting for the host
- **Today:** SCR-REC-WAITING-GUEST--desktop-light.png, --phone-light.png. Hierarchy: "Waiting for host 0:00" in small type beside a grey dot is the only sign of state. The roster shows an empty "Not recorded" heading. A disabled Marker button, an empty Note field and an Add note button take more space than the people. Mute is a checkbox. Purpose: the guest cannot tell if the host is even there.
- **Fate:** becomes the Room `waiting` phase.
- **Spec:** see SCR-REC-ROOM (same surface). Waiting-specific: the status pill reads "Waiting for Maya to start". The host's tile has a 2 px accent outline so the guest knows who will press Record. Guests can talk (the monitor is live), so tiles show live levels and speaking rings in waiting too. That is the green-room check and replaces "Hearing the room." copy. Marker is hidden until a take is live. The Notes rail is available (notes in waiting attach to the session, landing at the session start).
- **Shared elements used:** Person tile, NEW: Room status pill, NEW: Record dock.
- **Story to build:** `Record/Room` › `GuestWaiting`, `GuestWaitingPhone`.

### SCR-REC-ROOM-GUEST · Guest in the room
- **Today:** SCR-REC-ROOM-GUEST--desktop-light.png, --phone-light.png.
  - Purpose: the guest sees a bulleted list of names with "· consented" and no levels for anyone else, so the room does not feel shared.
  - Hierarchy: on phone the REC indicator has scrolled off the top. The guest cannot see they are recording while reading the roster.
  - Interaction cost: Mute is a checkbox at the bottom, and Leave is the same weight as Clear clip light.
  - Feedback and state: a clipping notice and the clip report repeat the same sentence twice ("Your mic clipped…").
  - Consistency: Marker is a text button here and a key elsewhere.
- **Fate:** replace with the Room (guest role).
- **Spec:**
  - **Desktop (≥1024 px).** Header 48 px: wordmark 20 px left, "Field Notes · Ep. 14" and "with Maya" centred, Room status pill right. Alert slot under the header (0 or 44 px). Tile grid centred in the remaining area minus the 320 px Notes rail on the right. Tiles 4:3, 200 to 360 px wide: 1 person 360, 2 in a row, 3 or 4 in a 2×2. Listener row (producers) under the grid: 28 px avatars with the headphone glyph. Record dock bottom, 80 px tall, controls centred.
  - **Phone (<600 px).** Header 44 px with the status pill always visible (never scrolls). Tiles 2×2, each (viewport − 32 − 8) / 2 wide, square. Self tile always top-left. Listener avatars row 28 px. Dock pinned bottom, 88 px including safe area. The Notes peek (one line, the latest note) sits directly above the dock. Swipe up or tap opens the Notes sheet. The page never scrolls in the live phase. Landscape phone: tiles in one row of 4, dock on the right edge as a vertical bar (thumb side).
  - **Guest dock:** Mute (64 px round, the primary for a guest: the most frequent in-take action is muting a cough), Marker (48 px, Comment-pin glyph), Notes (48 px, opens rail or sheet, badge with unread count), Leave (48 px, door glyph, far right, separated by 16 px).
  - **Mute.** Toggling turns the button and the self tile mic glyph into mic-slash, and the tile ring stops. Cmd/Ctrl+D. Muted while live shows a quiet line in the alert slot after 10 s of speech detected while muted: "You're muted."
  - **Marker.** Tap drops a pin at the current recording time. It appears immediately in the Notes list as "Marker · 12:04" and a 600 ms tick on the pill clock (no animation work: a static tick glyph next to the clock for 2 s). M key. Long-press on phone opens the Notes composer with the time pinned.
  - **Leave.** Immediate when nothing is unsaved. While saving, Leave shows the reason "Your recording is still saving" in a tooltip or press-feedback line and stays disabled; the browser's native leave guard stays as today.
  - **States** (all as alert-slot rows, one at a time, highest priority first): mic lost (**Reconnect mic**), no audio reaching the recorder (**Check mic**), device storage failed (**Retry recording**), host offline ("Maya dropped. You're still recording on this device."), paused by host (pill reads "Paused"), monitor failed ("You can't hear the room. Recording is fine." **Retry**).
- **Shared elements used:** Person tile, NEW: Record dock, NEW: Room status pill, NEW: Room alert, NEW: Notes rail, Icon language.
- **Story to build:** `Record/Room` › `GuestLive`, `GuestLiveMuted`, `GuestMicLost`, `GuestNoAudio`, `GuestStorageFailed`, `GuestHostOffline`, `GuestPaused`, `GuestMonitorFailed`, `GuestLivePhone`, `GuestLivePhoneLandscape`, `GuestLiveFourPeople`.

### SCR-REC-ROOM-PRODUCER · Producer in the room
- **Today:** SCR-REC-ROOM-PRODUCER--desktop-light.png. Same list layout as the guest. A producer's job is to watch levels and mark moments, and they get no levels at all.
- **Fate:** replace with the Room (producer role).
- **Spec:** same room. Producer's own tile is not in the grid. They appear in the listener row as "You". Dock: Marker (64 px, the producer's primary), Notes (48 px), Leave (48 px). The Notes rail opens by default on desktop. Producers see every tile's clip count badge and connection state (as the host does), since flagging "Jon is clipping" is their job.
- **Shared elements used:** Person tile, NEW: Record dock, NEW: Notes rail.
- **Story to build:** `Record/Room` › `ProducerLive`, `ProducerWaiting`, `ProducerPhone`.

### DLG-RECORD · Host Record room panel (also DLG-RECORD-ACTIVE, DLG-RECORD-STOPPED)
- **Today:** DLG-RECORD--desktop-light.png, --phone-light.png, DLG-RECORD-ACTIVE--desktop-light.png, DLG-RECORD-STOPPED--desktop-light.png.
  - Interaction cost: recording is a modal over the editor. The host has to open a menu to reach it and close it to edit. Creating a room is a separate step with its own button.
  - Hierarchy: in the active shot, Stop (small outlined red) is on its own row above Pause and Land, so the most consequential control is the smallest. Land is a disabled button with no reason visible.
  - Purpose: the host's own tile, the guests' levels and the session notes are absent. The roster is a bulleted list.
  - Feedback and state: the stopped shot shows an inline confirm sentence plus two buttons inside a modal, a confirm inside a dialog.
  - Consistency: the phone version is a bottom sheet over Listen with one sentence and one button.
- **Fate:** replace with the Record stage (host role of the Room).
- **Spec:**
  - **Layout desktop 1280 × 800.** Stage bar 48 px. Session header 48 px: session name left ("Session 2 · Sat 25 Oct", click to rename in place), Session target chip centre-left ("Lands at the end · after 52:10"), Room status pill right, overflow ⋯ far right (Invite links, Devices, End session). Alert slot. Tile grid with the host's own tile first. Empty slots (up to the cap of 4 recorded) render as NEW: Invite tile. Listener row. Right rail 320 px with segmented control Notes | Takes. Dock 80 px.
  - **Host dock**, left to right: Mute (48), Marker (48), the Record button (72 px, the one primary), Pause (48, visible only while live or paused), Notes (48). Rail toggle on desktop is the Notes button itself.
  - **The Record button** (NEW: Record button) is a single control with three faces: red filled circle (idle: start a take), red square inside a ring (live: hold to stop), red circle with a "resume" notch (paused: resume). Stop is press-and-hold for 600 ms: the ring fills clockwise, release early cancels and shows "Hold to stop" under the button for 2 s. Keyboard and screen readers: Enter or Space on the focused button in the live face opens a two-button popover anchored to it (**Keep recording** focused, **Stop take**), the existing InlineConfirm moved into a popover. R starts or resumes. P pauses.
  - **Start blockers** render on the tiles, not in a list under the button: a consent-pending guest's tile shows "Joining…" and a dashed outline. The Record button disabled reason reads "Waiting for Jon to join". With no guests at all, Record still starts (solo take, see Q3).
  - **Pre-roll.** First take of a session: Record runs a one-minute quiet countdown shown in every participant's status pill and as a large numeral over each tile ("Stay quiet · 1:00", then 0:59 and down, mm:ss). Room tone is captured on every device during it, and each capturing device shows the same countdown with a progress bar and two controls: **End early** (keeps the take when it is at least 10 s; a shorter one is discarded with "Too short, record at least 10 seconds") and **Cancel** (discards it and returns to idle). Tapping Record again during the countdown skips it and starts at once; neither control blocks joining or going live. Later takes skip the countdown (room tone is per session). A tile whose room tone was too loud shows an amber wave glyph. The host can redo it from ⋯ Devices, where room tone lives in the Device sheet.
  - **Mic and device:** tapping the host's own tile opens the Device sheet (same as a guest's). Host mic denied or missing shows in the alert slot with **Retry**.
  - **During a take** the Takes segment of the rail shows the current take row growing. Each tile shows the saving ring after Stop.
  - **After Stop** the phase is `saving` then `saved`. Landing is automatic. The manual Land button is removed. A land failure shows in the take row and the alert slot with **Retry**.
  - **Phone.** Same layout as the guest phone room, plus the Record button in the dock centre (72 px) with Mute and Marker to its left and Notes and ⋯ to its right. The session header collapses into the status pill, with the target chip under the pill as a 32 px row.
  - **Copy:** pill texts "Waiting", "Stay quiet · 0:42", "● 12:04 · Take 2", "Paused · 12:04", "Saving · 2 of 3", "Saved", "Reconnecting…".
- **Shared elements used:** Stage bar, Person tile, NEW: Record button, NEW: Record dock, NEW: Invite tile, NEW: Session target chip, NEW: Room status pill, NEW: Room alert, NEW: Notes rail, NEW: Takes tray, NEW: Device sheet, Icon language.
- **Story to build:** `Record/Room` › `HostEmpty`, `HostWaitingTwoGuests`, `HostWaitingConsentPending`, `HostCountdown`, `HostLive`, `HostLiveHoldingStop`, `HostStopPopoverKeyboard`, `HostPaused`, `HostPausedHostReconnect`, `HostSaving`, `HostSaved`, `HostLandFailed`, `HostMicDenied`, `HostSolo`, `HostPhone`, `HostPhoneLive`.

### CMP-REC-DEVICE · Microphone check
- **Today:** shots under SCR-REC-LOBBY-GUEST. Language: "-∞ dBFS", "Clear clip light". Hierarchy: input picker with a red error border in the normal state.
- **Fate:** merge into NEW: Join sheet (mic row) and NEW: Device sheet (later changes).
- **Spec:** Device sheet opens by tapping your own tile, or from ⋯ Devices. Contents: input menu, level meter 8 px tall with a clip tick, a headphone toggle (guests only; the host has none until the wire carries a host headphone ack), **Record room tone** (1 minute, for someone who joined after the countdown; while it runs the row counts "Stay quiet · 0:42" with a bar, **End early** and **Cancel**), and a **Speaker** menu (the system default, then each audio output) only where the browser can route the room's audio, that is when `AudioContext.setSinkId` exists; otherwise the row is absent, not disabled. The pick applies to the room's playback at once, is remembered in this browser (`record:output`, host and guest alike) and falls back to the default with a note when the device is gone or will not open. Changes apply instantly with no Apply button. Same states as the Join sheet mic row.
- **Shared elements used:** NEW: Device sheet, Inspector sheet conventions (no Apply).
- **Story to build:** `Record/DeviceSheet` › `Ready`, `Denied`, `InputLost`, `NoInput`, `RoomToneTooLoud`, `RoomToneCapturing`, `Phone`, `WithSpeaker`, `SpeakerFellBack`, `NoSpeakerMenu`.

### CMP-REC-CONSENT · Recording consent
- **Today:** paragraph of text, Accept disabled pink, Decline. Language: "Producers/listeners may be present and are shown in the roster."
- **Fate:** merge into NEW: Join sheet (consent lines and **Join and record**).
- **Spec:** see SCR-REC-LOBBY-GUEST. The server-side consent check per take is unchanged. Blockers name the first unmet row under the primary.
- **Story to build:** covered by `Record/JoinSheet` stories.

### CMP-REC-ROOMTONE · Room tone capture
- **Today:** a mandatory decision per guest before consent ("Record or skip room tone before accepting"), with a primary button that competes with Accept.
- **Fate:** replace with the pre-roll countdown (INT-REC-START), with the per-person fallback in NEW: Device sheet.
- **Spec:** the host's first Record press per session captures one minute on every recorded device (End early keeps 10 s or more). Per-tile result: check, or amber wave glyph "Too loud". Uploaded after consent, which every participant in the take has already given. Data dependency: a host command that triggers room-tone capture on all clients (today capture is client-initiated in the lobby).
- **Story to build:** `Record/Room` › `HostCountdown`, `CountdownOneTooLoud`.

### CMP-REC-INDICATOR · REC indicator
- **Today:** "● REC 0:04 ●" with two dots, small type, scrolls away on phone. Eight states share one text slot.
- **Fate:** replace with NEW: Room status pill.
- **Spec:** see the shared vocabulary. Capture-health states move to the person's tile and the alert slot, so the pill only says what the room is doing.
- **Story to build:** `Record/RoomStatusPill` › one story per phase plus `Reconnecting`, `Compact` (stage-bar badge form).

### CMP-REC-ROSTER · Participant roster
- **Today:** bulleted list split into "Recording" and "Not recorded" with "· consented" suffixes.
- **Fate:** replace with the tile grid and the listener row.
- **Spec:** recorded people are tiles. Producers are avatars in the listener row. Consent shows only when pending (dashed outline, "Joining…"). Removed people disappear. Disconnected people keep their tile at 50% with the "lost" signal glyph and "Reconnecting…" for 30 s, then show "Left".
- **Story to build:** `Record/PersonTile` stories, `Record/Room` › `GuestDisconnected`.

### CMP-REC-LIVECOMMENTS · Live comments
- **Today:** "No live comments yet." then a Marker button, a labelled Note field and a full-width Add note button. Interaction cost: three controls for one act.
- **Fate:** replace with NEW: Notes rail.
- **Spec:** see the shared vocabulary. Composer is one field with the send glyph inside it. Enter sends. The note is pinned to the recording time at the moment typing began, shown as a time chip at the field's left ("12:04") that can be cleared to make a session-level note.
- **Story to build:** `Record/NotesRail` › `Empty`, `WithNotesAndMarkers`, `Drafting`, `Paused`, `PrivateToHost` (see Q5), `Phone`, `PhoneSheetHalf`.

### CMP-REC-UPLOAD · Saving status and recovery
- **Today:** text lines "Saving to project… N of M chunks" and per-segment lines. Language: "chunks", "full-quality recording", "keeper" leak into status.
- **Fate:** merge into the Person tile saving ring, the guest dock status line, and NEW: Room alert for failures.
- **Spec:** guest after Stop: the self tile ring fills by saved bytes. The dock shows "Saving · 64% · keep this page open" in place of Marker. On completion the dock becomes **Done** (primary), which closes the page or shows "You can close this page". Failure: alert row "Saving stopped." with **Resume saving** (primary) and **Save a copy** (download). Partial recovery after a crash: alert row "We found part of your recording." with **Finish saving**.
- **Story to build:** `Record/Room` › `GuestSaving`, `GuestSaved`, `GuestSaveFailed`, `GuestRecoverPartial`.

### CMP-REC-CLIPPING · Take clipping report
- **Today:** a notice during the take and the same sentence again under the meter, then a post-take report.
- **Fate:** merge into Person tile (clip badge) and the Takes tray row detail. Clipped spans already land on clips (`clipping_regions`), so Edit and Review show them.
- **Spec:** live: a red tick on the tile's level ring for 2 s per clip, and a count badge (host and producer see it on every tile, a guest on their own). One alert row after the third clip in 30 s: "You're clipping. Move back a little." Post-take: the take row lists "Jon clipped 3 times" with time chips that jump to Edit.
- **Story to build:** `Record/PersonTile` › `Clipping`, `Record/TakesTray` › `WithClipping`.

### CMP-REC-HOSTROSTER · Host upload roster
- **Today:** a separate list of per-participant segment states inside the dialog.
- **Fate:** merge into the Person tile saving ring and NEW: Takes tray.
- **Spec:** each take row expands to one line per person: ring, "Saved", "Saving 40%", "Waiting for Jon to come back online", or "Couldn't add to the timeline · Retry". Twelve takes scroll inside the rail. Long names truncate with the full name in the tooltip.
- **Story to build:** `Record/TakesTray` › `Saving`, `MultipleSegments`, `LandFailed`, `TwelveTakes`, `LongNamesPhone`.

### CMP-REC-NOTICES · Mic loss, no audio, storage, alert, save announcer
- **Today:** five components that each render their own paragraph, stacked when several apply.
- **Fate:** replace with NEW: Room alert. SaveAnnouncer stays (screen-reader announcements only).
- **Spec:** one alert slot, one row at a time, priority: mic lost > no audio > storage failed > saving failed > a notice (recovery result) > recovery > host offline > monitor failed > room tone for a late joiner (**Record room tone**, **Skip**) > clipping > muted > connecting > generic room error (**Dismiss**). Recovery, muted and connecting come from SCR-REC-ROOM and CMP-REC-UPLOAD. Each row: 20 px glyph, one sentence, at most one action (the late-joiner room tone row also offers **Skip**). The highest-priority unresolved row shows. A count chip "+1" opens the rest.
- **Story to build:** `Record/RoomAlert` › one story per kind, `Stacked`.

### CMP-REC-STOP · Stop take with inline confirm
- **Today:** not in the shots as a separate item; DLG-RECORD-STOPPED shows its confirm sentence inside the dialog.
- **Fate:** replace with NEW: Record button hold-to-stop, with the InlineConfirm popover for keyboard and assistive tech.
- **Story to build:** `Record/RecordButton` › `Idle`, `Countdown`, `Live`, `Holding`, `Paused`, `Busy`, `DisabledWithReason`, `KeyboardConfirm`.

### CHIP-REC-TRANSPORT · Recording chip in the transport
- **Today:** "● REC 0:04 ●" chip in the top bar, visible in DLG-RECORD-ACTIVE. Consistency: a third rendering of the same state, beside the dialog's indicator and the guest's indicator.
- **Fate:** replace with NEW: Room status pill (compact) on the Stage bar's Record item.
- **Spec:** on the Stage bar, Record shows: nothing when idle, a count badge when people are waiting in the room ("2"), the compact pill (red dot and clock) during a take, "Paused" text, a progress ring while saving, the cloud-off (offline) glyph while the room connection is down during a take, an amber dot when any alert is active. Click returns to Record. On phone the same badge is on the Record item of the stage switcher and stays visible above sheets (today's rule for the chip).
- **Story to build:** `StageBar` › `RecordIdle`, `RecordPeopleWaiting`, `RecordLive`, `RecordPaused`, `RecordSaving`, `RecordReconnecting`, `RecordAlert`.

### OVL-RECORDING · Provisional take band and needle
- **Today:** no shot of it. Code: a band and a needle on the timeline from the take origin to now.
- **Fate:** restyle.
- **Spec:** in Edit while a take records, the band draws at the session target position (end of the episode for an append; the replace range for a pickup) in the session colour with a label "Recording · Take 2" at its left edge. The needle is the record red. After landing, the band becomes the NEW: Session marker in the marker lane.
- **Shared elements used:** NEW: Session marker, marker lane (Edit spec).
- **Story to build:** `Timeline/RecordingOverlay` › `AppendAtEnd`, `Pickup`, `Paused`, `Phone`.

### FLOW-REC-NEW · First recording: Home, New, Record
- **Today:** SCR-HOME-NEW (inventory) asks for a Name and a Workspace directory and creates an empty project. Recording needs Menu > Project > Record room…, Create record room, copy the link, wait, and the host cannot start alone.
- **Fate:** new flow.
- **Spec:** Home's New opens a sheet with two large choices (160 px tiles, glyph and one word): **Record** (mic glyph) and **Import** (file-arrow glyph). Name defaults to "Untitled episode · 25 Oct" and the folder to the default workspace. Both are editable under a **Name and location** disclosure, not required. Record creates the project and opens the Record stage with the room created and the Invite popover open on the guest link (the anticipated next act is sending it), Copy focused, and on phone the system share sheet button first. Target chip reads "Starts the episode". Edit, Review and Deliver stay switchable, with empty states that point back ("Nothing recorded yet").
- **Story to build:** `Home/NewSheet` › `Choices`, `Phone`. `Record/Room` › `HostFirstSessionInviteOpen`.

### FLOW-REC-LATER · Adding a session to an existing project
- **Today:** a new room's takes land at 0:00 on new tracks keyed by participant, overlapping the existing episode (landing_math.py). Nothing names the session.
- **Fate:** new flow. Recommended default with alternatives in Q2.
- **Spec (recommended default):**
  1. Host presses Record in the Stage bar. If no session is open, the stage shows the previous session's summary card at the top of the Takes rail and a fresh room for **Session N+1** with Invite tiles. The guest link is new for each session.
  2. The Session target chip defaults to **Lands at the end** (after the current last clip, plus 2 s). Its menu: At the end, At the start, At the playhead (12:04), Replace selection (only when Edit had a selection). Entering from Edit's Re-record or Record here presets it.
  3. Takes land as they save. **End and Start** (no existing audio moves except by a ripple that the user can see): applied directly as one undo entry "Added Session 2". **Insert and Replace** (existing audio would move or be covered): land as a Suggestion in Review, "Insert Session 2 at 12:04" or "Replace 12:04–12:09 with pickup", with Hear before and Hear after. Accept, Skip, Adjust in Edit. Several takes for one pickup show as a take switcher on that suggestion (Take 1 of 3).
  4. Tracks: the host goes to the host's track. A guest whose display name matches an existing track's person goes to that track. Anyone else gets a new track named after them. The saved summary card lists the mapping ("Ava → Ava", "Sam → new track") with a menu on each to change it before the user leaves Record (changing it re-places clips, undoable).
  5. Alignment: within a session, clocks align as today (join offsets). Between sessions there is nothing to align. The drift hint (`align_fallback`) triggers Prepare's align step for that session only.
  6. Naming: "Session 2 · Sat 25 Oct" (editable). Takes "Take 1…". Clips "Ava · S2 T1".
  7. Prepare runs on its own: transcription, speaker labels from track names, the alignment hint, loudness analysis, for the new clips only. The Prepare item in the Stage bar shows progress. Nobody has to visit Prepare. The transcript for the new session fills in when ready.
  8. Next action: the saved summary card's primary is **Edit Session 2**, which opens Edit with the playhead at the session start and the Session marker selected.
- **Shared elements used:** NEW: Session target chip, NEW: Session marker, NEW: Session summary card, Suggestion, A/B audition, Stage bar badge.
- **Story to build:** `Record/Room` › `HostSecondSessionAppend`, `HostPickupFromSelection`, `HostSavedSummaryTrackMapping`. `Review/Suggestion` › `PickupReplace`, `PickupTakeSwitcher`, `InsertSession`.

**Previous session card (read-only part shipped; also INT-REC-END).** After End session, or whenever the host opens Record with no room, the newest ended session that has takes or has landed shows read-only above the empty state: heading `Session N · date` (`Last session` while unnumbered), `3 takes · 12:04`, and each participant as `name → track` (`New track` for an unmapped landed participant; just the name if never landed). A failed lookup shows nothing. Still to come (HostSavedSummaryTrackMapping, HostSecondSessionAppend): the per-participant track-mapping menu, rename, and the Edit Session N hand-off.

### FLOW-REC-PICKUP · Re-record from Edit
- **Spec:** select words or a range in Edit, and the floating action bar (phone: bottom sheet) offers **Re-record** (NEW verb: mic glyph with a return arrow). It opens Record with target Replace 12:04–12:09 and the selected words shown under the target chip as a script ("…the reason we didn't ship it…") so the speaker can read the line. Host-only, solo allowed. After Stop the take lands as a Review suggestion (FLOW-REC-LATER step 3) and Record's summary card's primary becomes **Review pickup**. A range that does not cover a span on a track, or that ends past the timeline, hides the verb (there is no Insert fallback); Record here on the playhead is the way in then.
- **Story to build:** `Record/Room` › `HostPickupWithScript`, `HostPickupPhone`.

### INT-RECORD · Record interactions (inventory row INT-RECORD and the rest)

| ID | Interaction | Old cost | New cost | Keys | Touch |
|---|---|---|---|---|---|
| INT-REC-OPEN | Open recording | Menu, Record room…, Create record room | One tap on Stage bar Record (room auto-created, idempotent) | Stage bar key | Stage switcher |
| INT-REC-INVITE | Send the guest link | Deliver Share section or Copy guest link | Tap an Invite tile, Copy (or share sheet, or QR for a phone guest beside the host) | none | Share sheet |
| INT-REC-JOIN | Guest joins | 5 sections, 6+ presses | Allow mic, Join and record (name prefilled) | Enter | Thumb-zone primary |
| INT-REC-START | Start a take | Start (blocked without a guest) | Record; one-minute pre-roll with group room tone on the first take | R | Tap |
| INT-REC-PAUSE | Pause or resume | Pause, Resume buttons | Pause button; Record button resumes | P, R | Tap |
| INT-REC-STOP | Stop a take | Stop, confirm sentence, Stop take | Hold Record 600 ms | Enter opens Keep/Stop popover | Hold |
| INT-REC-LAND | Put takes on the timeline | Land button | Automatic; Retry only on failure | none | none |
| INT-REC-MARK | Mark a moment | Marker button | Marker in dock | M | Tap; long-press adds text |
| INT-REC-NOTE | Write a note | Note field, Add note | Composer in rail or sheet | N focuses, Enter sends | Notes sheet |
| INT-REC-MUTE | Mute self | Checkbox | Dock button | Cmd/Ctrl+D | Tap |
| INT-REC-DEVICE | Change mic | Lobby and after Stop; held while a take is live, paused or still flushing | Tap own tile, Device sheet | none | Tap own tile |
| INT-REC-END | End the session | End room confirm in Share | ⋯ End session, undoable for 10 s: the Record notices row shows "Ending this session in 10 seconds" with Undo, and the links are revoked only when the window passes (Undo changes nothing; leaving Record inside the window still ends it; disabled with a reason until a running take is stopped and every take is saved and landed and no live notes wait, since ending revokes the guests' links; once pressed the button leaves the sheet until the end is undone or done) | none | ⋯ |
| INT-REC-RETURN | Return from another stage | Record chip | Stage bar Record (Live badge) | Stage bar key | Stage switcher |
| INT-REC-REMOVE | Remove a person | Record stage | Tile menu (right-click or long-press) Remove, InlineConfirm since it can't be undone | none | Long-press tile |

---

## 3. Shared vocabulary proposals

**Person tile** (exists in the brief's vocabulary; this spec defines its anatomy). A rounded rectangle 4:3, radius 12, surface token. Centre: avatar circle (40% of tile width) with initials on a colour derived from the person (the same colour that person's track uses in Edit, so a face, a track and a transcript speaker read as one person). The avatar's ring is the live level: 3 px at silence, up to 8 px at peak, accent colour. A steady ring above the speech threshold for 150 ms is "speaking" (ring turns solid and the tile border lights). Bottom-left: name (truncate). Bottom-right glyph cluster, each 16 px: mic-slash when muted, three-bar signal (good, weak, lost), headphone glyph for listeners. Top-right: clip count badge (red), amber triangle when that person has an active alert. After Stop the level ring becomes the saving ring (fills by saved bytes, check when saved, amber with "!" when failed). States: placeholder, joining (dashed outline, "Joining…"), live, muted, speaking, clipping, weak, lost, saving, saved, failed, declined, left. Self tile adds an 8 px meter bar under the name. Tap own tile opens the Device sheet; host tap on another tile opens a popover with that person's details (input name, clip times, saving lines) and Remove. Reused in: Record grid, listener row (avatar only, 28 px), Join sheet header (32 px), Room cover (Full), and the presence avatars in Edit and Review (avatar only, same colour).

**NEW: Record dock.** A bottom bar 80 px (phone 88 px with safe area), centred cluster with one 64 to 72 px round primary and 48 px round secondaries, 16 px gaps, Leave or ⋯ separated by 24 px at the far right. Role decides the set (host: Mute, Marker, Record, Pause, Notes, ⋯; guest: Mute, Marker, Notes, Leave; producer: Marker, Notes, Leave). It also hosts a one-line status ("Saving · 64%") in place of the secondaries after Stop. Reused as the pattern for Review's phone Accept/Skip bar (same heights and spacing), so thumb positions match across stages.

**NEW: Record button.** One control with three faces (idle circle, live square in ring, paused resume), hold-to-stop for 600 ms with a filling ring, and a keyboard/AT popover confirm. Its red is reserved app-wide for "recording": nothing else in the app uses the record red (Stop in Edit transport stays neutral). The idle face is also the Home New sheet's Record tile glyph.

**NEW: Room status pill.** 28 px pill, glyph and text: Waiting (hollow circle), Stay quiet · 0:42 (countdown), ● 12:04 · Take 2 (record red), Paused (two bars), Saving · 2 of 3 (ring), Saved (check), Reconnecting… (cloud-off). Compact form (glyph and clock only) is the Stage bar's Record badge. One rendering for every role and place.

**NEW: Room alert.** A single 44 px row under the header with a glyph, one sentence and at most one action. Priority-ordered, one visible, "+N" chip for the rest. If the shell spec defines an app-wide attention row, this should be that component with a record-specific priority table, not a second one.

**NEW: Join sheet.** The pre-join sheet over a live room: header with who is here, rows that check themselves off (name, mic, headphones), consent lines, one thumb-zone primary (**Join and record** or **Join to listen**), **Not now**. Desktop card 420 px, phone bottom sheet at the large detent. Reused shape for the review-link guest's first visit if the Review spec adds a name step (a review guest naming themselves is audit finding phone/F08).

**NEW: Device sheet.** Input menu, live meter with clip tick, headphone toggle (guests only), room tone (1 minute, with End early and Cancel while it runs), speaker menu where the browser supports it. No Apply. Opened by tapping your own Person tile (host and guest alike).

**NEW: Invite tile.** An empty grid slot (dashed outline, plus glyph, "Invite"). Tap opens a popover: guest link with **Copy** (primary), **Share…** on devices with the system share sheet, a QR code (160 px) for a phone in the same room, and the producer link behind a "Listen-only link" disclosure. Replace link lives here too.

**NEW: Session target chip.** A 32 px chip with a placement glyph and text ("Lands at the end · after 52:10", "Starts the episode", "Replaces 12:04-12:09", "Inserts at 12:04"). Menu to change it before the first take. Locked (no menu, lock glyph) after the first take lands (`reducer.py` refuses SetTarget once the session has takes). Built on the host Record room header: the menu reads the playhead and the selection from Edit state, and omits At the playhead on an empty timeline and Replace selection without a selection that covers a span on at least one track and ends inside the timeline. The chip is disabled while a command is in flight. Edit's entry points are built: the Action bar's Record verb is labelled **Re-record** over words or a range that covers a span on a track and ends inside the timeline (host only; hidden otherwise), and **Record here** on the playhead. Both park the target in the store (`pendingRecordTarget`) and open Record, whose host stage sends it as SetTarget once, when the room is in the lobby with no take; a room that is past that drops it silently, and leaving Record, a project switch or a reload drops it too. Over selected words, the words are parked with the target and shown as a quiet script line under the chip ("…the reason we didn't ship it…") while the room's target is that Replace, locked or not; the line is cut to 140 characters and clamped to two lines, and picking another target, leaving Record, switching project or a reload drops it. Host only. **Session N+1:** the empty state's create button reads **Start Session N+1** once an ended session has a number (otherwise **Create record room**). Not yet built: showing the session name in the open room's header, because the open session has no number until it lands.

**NEW: Session marker.** In Edit's marker lane, a bracket spanning a session's extent in the session colour, label "S2" (full name on hover or long-press). Selecting it selects all of that session's clips, so the user can drag the whole session as a unit. Same shape as the provisional OVL-RECORDING band, so the band visibly becomes the marker.

**NEW: Notes rail.** Desktop 320 px rail (phone: bottom sheet with peek, half and full detents). A chronological list of markers (Comment-pin glyph and time chip) and notes (author avatar, text, time chip), composer at the bottom with a time chip that pins when typing starts. These are the same comment objects Review and Edit show after landing (`TimelineComment`), drawn with the same row component as the Review comment row, so a note looks the same before and after landing.

**NEW: Takes tray.** The Takes segment of the rail: one row per take (number, length, people avatars, status ring), expandable to per-person lines with Retry, clip times, and **Hear** (plays the take once landed). Prior sessions collapse above as Session summary cards.

**NEW: Session summary card.** After a session saves: "Session 2 saved · 3 people · 2 takes · 14:20", where it landed, the track mapping with change menus, Prepare progress, and one primary (**Edit Session 2**, or **Review pickup** for a replace target).

**NEW: Room cover.** The dead-end page for Record (and the shape for review-link dead ends): 64 px glyph, one headline, one line, at most one primary. Variants: invalid, full, ended, ended with local recording. Never server JSON.

**NEW verb: Re-record.** Mic glyph with a return arrow. Appears in the object selection model for transcript ranges and clip ranges (host only), beside Cut, Keep, Comment, Hear, Fix text, Split.

**Icon language additions:** record (filled circle), stop (filled square), pause (two bars), mic, mic-slash, headphones (listener and headphone check), signal bars, door (leave and ended), Comment pin (marker, same as comment), wave-flat (room tone), placement glyph (target). Each used only for its verb.

---

## 4. Open product questions for Caleb

- **Q1. Where Record sits in the Stage bar.** Recommend Record first: Record, Prepare, Edit, Review, Deliver. It is the order of the work for a recorded show, and Prepare reads as "what happens to a recording". Alternative: Prepare first (the brief's list) with Record second, which suits import-first projects. Either way every stage stays switchable.
- **Q2. Where a later session's takes go.** Recommend: they land at the session's target, default "at the end" applied directly, while inserts and replacements become Review suggestions with before/after listening. Alternatives: (a) always append and let the user move it in Edit (simplest, no Review involvement, pickups need manual cutting); (b) land unplaced in a Takes bin and the user drags them onto the timeline (Descript-style, safest but adds a step every time); (c) a session becomes its own composition or version of the episode (heaviest).
- **Q3. Recording alone.** Today Start is blocked until a guest joins. Recommend allowing a solo take (intros, pickups, solo shows). The cost is a server rule change.
- **Q4. One invite link per session or one standing link per project.** Recommend a new link per session (a link from last month can't drop someone into today's room, and the existing expiry and recovery rules stay simple). Alternative: a standing "studio door" link per project that always opens the current session, easier for repeat co-hosts.
- **Q5. Who sees notes during the session.** Today guests see only their own notes until landing. A shared room suggests sharing. Recommend: markers are visible to everyone; text notes default to host and producers only, with an "Everyone" toggle in the composer (producer notes such as "Jon's level is low" stay private by default, as in Descript's Control Room). Alternative: everything visible to everyone.
- **Q6. Headphones as a hard gate.** Today a guest cannot consent without ticking headphones. Recommend keeping the gate on desktop and making it a strong warning on phones, where the phone earpiece and echo cancellation make speaker use workable for a guest who has no headphones. Alternative: keep the hard gate everywhere.
- **Q7. Video.** Tiles are avatar-only because no video capability ships. Recommend audio-first now with tiles shaped 4:3 so video can fill them later without a layout change. Question: is video on the roadmap for recording, and is it recorded or only a monitor?
- **Q8. Matching a returning guest to their track.** Recommend matching by display name with the summary card's menu to correct it. Alternative: ask the host to assign each new person to a track before the first take (more reliable, one more step).
- **Q9. Room tone in the pre-roll.** Recommend capturing everyone's room tone in a one-minute "Stay quiet" countdown on the first take of each session, instead of a per-guest lobby step. It needs a new host-to-all command. Alternative: keep the per-guest lobby capture.
