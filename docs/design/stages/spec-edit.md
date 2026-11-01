> **Reconciled by design-system.md** (that file wins where they differ). Terms changed here:
> - Stage order: Record, Prepare, Edit, Review, Deliver. Mod+1 is Record and Mod+2 is Prepare.
> - Player bar, Player sheet, solo chip, delta chip and mix ring became **Player** (bar and expanded) plus **Status pill**. Play is ink-filled, not accent. Skip is 15 s. Comment at playhead moves into the Player.
> - Action bar and action dock became **Action bar** (floating, dock, inline), with the verb order Hear, Keep, …, primary at the trailing end.
> - Inspector sheet, Invite popover, eye popover, History popover, speaker popover and person popover became **Sheet** instances. Project menu, Create here and More became **Menu** instances.
> - Script header notices became inline **Status rows**. The Empty state pattern became **Cover**. The corner zoom cluster and marker lane are parts of **Timeline**. The Edit surface switch is a Segmented control (`chart-gantt` / `text`).
> - Comment popover and suggestion inspector became a compact **Decision card**.
> - The Blade tool and the Select/Blade toggle are removed. Split is a visible Action bar verb on S (and Mod+K), or Alt-click at the pointer; on touch it is the bar's Split or a long-press on a lane ("Split here"). Solo moves to Shift+S. B now means Hear after.
> - Keys: hold O became hold A. Shift+M chapter became Shift+C. Mod+Shift+E became Mod+E. Mod+B is palette only. Mod+N is dropped. Tab is "next of the same kind" and F6 moves between regions.
> - Icons: Keep is `shield-check` (not the U-turn arrow). Hear is `ear`. Follow is `locate-fixed`. The listen role is `ear`. Review stage is `inbox`. Prepare stage is `wand-sparkles`. Deliver stage is `send`. Failed is `octagon-alert`.
> - Commenter guests get Review only (their Cut makes a Suggestion). Editor guests get Edit, Review and Deliver (the Podcast listing only), not Prepare.
> - The Script 68-character measure applies in Script focus only (about 44 characters at 400 px).
> - Storybook titles: `System/*` and `Stages/Edit/*` replace `Shell/*` and `Edit/*`.

# Spec: app shell, stage bar and the Edit stage

Area owner: spec-edit. Scope: the shell every stage sits in (header, stage bar, player, toasts, palette), and the Edit stage (timeline, Script pane, selection, action bar, inspector sheet, every editing interaction) on desktop, tablet and phone. Record, Prepare, Review and Deliver contents belong to their own specs. This file defines the frame they plug into and the shared elements they reuse.

Inputs read: SPEC-BRIEF.md, rubric.md, inventory.md, ui-directions.html (Today critique and Directions A, B, C), docs/ui-philosophy.md, docs/editor-interactions.md, ux/pages/shortcuts.md, ux-audit-2026-10-22/SUMMARY.md, and the shots named per item below.

---

## 1. Area summary

### What the shell is for

One frame for every stage. It answers four questions at a glance, with no text required: which episode am I in, is it saved, which job am I doing (stage), and where is the audio (player). Everything else belongs to a stage or to a selection.

The shell has exactly four persistent regions. Nothing else is permanent.

| Region | Desktop and tablet | Phone | Holds |
|---|---|---|---|
| App header | Top, 48 px | Top, 44 px below the safe area | Project menu (wordmark symbol + title), save indicator, Undo/Redo, presence avatars and invite, search |
| Stage bar | Centered in the app header | Bottom tab bar, 56 px + safe area | Prepare, Record, Edit, Review, Deliver with badges |
| Stage content | Between header and player bar | Between header and player bar | The stage's own layout |
| Player bar | Bottom, 56 px, full width | Above the stage tab bar, 56 px | The one transport for the window, edited length, hear-original, solo chip |

Today's status bar, transport bar, Menu, View menu, bottom dock tabs, layout presets and phone More hub are removed. Section 2 gives each of their items a new home (table under MENU-MAIN).

### Stage model in the shell

- Five stages, always switchable in one click or tap, in any order, at any time, including during a live recording. Switching never discards a selection, draft, playhead position or zoom; each stage keeps its own scroll and zoom, and the playhead is shared.
- Keys: Mod+1 Prepare, Mod+2 Record, Mod+3 Edit, Mod+4 Review, Mod+5 Deliver. These replace today's Mod+1..4 layout presets.
- Opening a project lands on the stage you last used for that project. First open: no audio lands on Prepare; audio present lands on Edit.
- Badges carry state so you know where work is waiting without visiting: Prepare shows a progress ring while a job runs and an amber dot when a step needs you; Record shows a red dot and elapsed time while a take is live; Review shows the count of open suggestions plus open comments; Deliver shows a check when the readiness list passes.
- Guests see only the stages their link allows (Viewer: Review; Commenter: Review and Edit in suggest mode; Editor: Edit, Review and Deliver, where Deliver shows the Podcast listing only). Record room guests never see this shell; they use the Record room (spec-record).

### What the Edit stage is for

Making precise changes to the episode: cutting words and ranges, trimming, fading, joining, balancing levels and fixing transcript text. Review is where you decide on many suggestions quickly; Edit is where you make or adjust changes by hand. Edit must make both text editing and waveform editing first-class.

**Main surface decision.** Edit is a linked pair: the timeline (Direction B's calm multitrack) and the Script pane (the transcript as a readable document), showing one shared selection.

- Desktop and tablet landscape (viewport width 1000 px or more): side by side. Timeline on the left, flexible. Script pane on the right, default 400 px, drag range 320 to 640 px, collapses to 0 with T. Both use the full height between header and player bar. Reason: tracks need height and width only for time, while text needs a readable measure (about 68 characters) and height. Today's bottom dock gives text 1400 px lines and three visible rows (shots SCR-SHELL-DESKTOP--shell1280-light.png).
- Tablet portrait (768 to 999 px): stacked. Timeline above, Script below, 50/50, horizontal divider.
- Phone: one surface at a time, switched with the Edit surface switch (waveform icon / text icon) at the top of the stage. Selection and playhead carry across the switch.
- Selecting words selects the same time range on the timeline, and the reverse. The other surface scrolls to reveal it without changing zoom.
- Shift+T collapses the timeline to its overview strip so the Script fills the stage (writer focus). T toggles the Script pane. These two keys replace the four layout presets.

**Object selection model.** Anything you can click is an object: word run, range, clip, seam, suggestion, marker (chapter, social clip, comment), envelope point, track. Selecting an object shows the action bar next to it (desktop and tablet) or docks it above the player (phone). The verbs are the same everywhere, drawn with the same icons, in the same order.

| Verb | Icon | Key | Words | Range | Clip | Seam | Suggestion | Marker | Nothing selected (playhead) |
|---|---|---|---|---|---|---|---|---|---|
| Hear | speaker-wave | Shift+Space | plays the words | plays the range | plays the clip | plays 2 s across the seam | A/B: A before, B after | plays from it | n/a (Space plays) |
| Cut | scissors | Backspace / Delete | removes them | removes time | removes clip | n/a | accepts the cut (Enter also) | n/a | n/a |
| Keep | arrow-uturn (restore) | X | restores cut words | n/a | n/a | restores the cut at this seam | rejects the suggestion | n/a | n/a |
| Split | blade | S | splits at both selected-word edges in one undo step | splits at both edges | splits at playhead | n/a | n/a | n/a | splits at playhead |
| Comment | speech bubble | C | comment on words | comment on range | comment on clip span | comment at seam | comment on it | reply (comment) | comment at playhead |
| Fix text | text-cursor | Enter, F2 or double-click | inline correction | n/a | n/a | n/a | n/a | rename (chapter, social) | n/a |
| Remove | trash | Backspace | n/a | n/a | n/a | n/a | n/a | deletes the marker | n/a |
| More | ellipsis | . (period) opens | Mute or Restore ignored words, Move to speaker, Copy | Mute, Fill room tone, Move to speaker, Export selection | Mute, Gain, Fade, Move to track | Join type, Precision | Adjust bounds | n/a | Add chapter, Add volume point, Paste |
| Inspect | sliders | I | timing | In/Out/Length | properties | offset, join | why, bounds | time, title | n/a |

Rules. Cut always removes audio and is drawn as struck text plus a hatched waveform. Remove deletes a non-audio object and is never called Cut. Keep undoes a cut or rejects a proposal. Verbs that do not apply are absent, never disabled. When nothing is selected the verbs act at the playhead.

For the host, the words More menu shows **Restore ignored words** only when every selected word is ignored. It clears Ignore on that selection. A mixed selection keeps **Mute**. Editor links keep **Mute**, which affects the range instead of Ignore. Commenter links stay in Review and do not expose the Edit words toolbar.

**How you enter and leave Edit.** Click the Edit stage (Mod+3) from anywhere; tap Edit in the phone tab bar; press E ("Adjust in Edit") on a suggestion in Review, which opens Edit with that suggestion selected and zoomed to it; tap a comment's time in Review, which opens Edit at that time. Leave by any stage tab. Nothing in Edit blocks leaving; an in-progress drag is cancelled, an open Fix text field is committed.

---

## 2. Items

### Shell

### SCR-SHELL-DESKTOP · Desktop shell

- **Today:** SCR-SHELL-DESKTOP--shell1280-light.png, --desktop-dark.png. Hierarchy: about twenty equal-weight boxed controls in the top bar with no primary; the title truncates at 1280. Hierarchy: 210 px of empty grey under two tracks while the transcript gets three lines. Interaction cost: Export, Share, Record live in a hamburger menu. Bar: status bar of six unrelated items reads as noise.
- **Fate:** replace with App header + Stage bar + Edit stage layout + Player bar.
- **Spec:**
  - Grid at 1280 × 800: header 48 px; stage content 696 px; player bar 56 px. Stage content for Edit: timeline column (track header column 168 px + lanes, flexible) | 1 px divider with an 8 px hit area | Script pane 400 px.
  - App header, left to right. Project menu button: ShareCut symbol 20 px + project title (IBM Plex Sans 15/600, truncates with ellipsis only after the stage bar has its 480 px; full title in tooltip) + chevron. Save indicator 8 px dot directly after the title. Undo and Redo icon buttons (32 px, 44 px hit on touch). Center: Stage bar, 480 px. Right: presence avatars (24 px, max 3 then +N), invite button (person-plus icon), search button (magnifier).
  - Header has no other buttons. The one primary action per stage lives in the stage content (Edit: none, the content is the interface; Deliver: Export).
  - Tracks fill the timeline height: lane height = (available height − ruler − marker lane) / track count, clamped to 72 to 240 px; beyond what fits, the lanes scroll and the clamp holds.
  - 1920 × 1080: Script pane grows to 480 px default; lanes widen.
- **Primary action:** none in chrome; play is the most prominent control (player bar).
- **Anticipated next action:** after opening, play or select. Space plays from anywhere; clicking a word or clip selects it.
- **Keyboard:** Mod+1..5 stages; Mod+Z / Mod+Shift+Z; / or ? palette; T toggles Script; Shift+T script focus.
- **States:** loading (SCR-SHELL-LOADING), empty (SCR-SHELL-INGEST), offline (save indicator shows the cloud-off state; editing continues), guest (stages filtered, invite hidden for Viewer/Commenter).
- **Shared elements used:** Stage bar, Transport (as NEW: Player bar), NEW: App header, NEW: Project menu, NEW: Script pane.
- **Story to build:** `Shell/EditStage` stories `Desktop1280`, `Desktop1920`, `DesktopDark`, `GuestCommenter`, `Offline`.

### SCR-SHELL-TABLET · Tablet shell

- **Today:** SCR-SHELL-TABLET--tablet-light.png, SHEET-INSPECTOR--tablet-light.png. Hierarchy: a second tool row (Select range, + Track, Import, zoom, undo) floats between timeline and dock. Consistency: track headers truncate role to "d..". Hierarchy: the activity line in a bordered box looks like a button. Touch: Shorter/Taller/Reset text buttons duplicate the splitter.
- **Fate:** replace with the same shell as desktop, adapted.
- **Spec:**
  - Portrait 820 × 1180: header 48 px with the stage bar showing icons + labels (5 × 88 px). Stage content: timeline top 50 %, Script bottom 50 %, horizontal divider (drag, double-tap resets to 50/50). Player bar 56 px.
  - Landscape 1180 × 820: identical to desktop with Script at 360 px.
  - Selection shows the action bar above the object (as desktop) with 44 px buttons. Inspector opens as an anchored popover card, not a bottom sheet; tablet has the room.
  - Track header column 120 px: avatar with level ring, name, mute and solo icons. Fader appears in the track sheet.
- **Touch:** every control 44 px; pinch zooms the timeline; two-finger tap undoes; long-press on empty lane opens Create here.
- **Shared elements used:** same as desktop; NEW: Action bar sizing "touch".
- **Story to build:** `Shell/EditStage` stories `TabletPortrait`, `TabletLandscape`, `TabletClipSelected`.

### SCR-SHELL-LOADING · Shell while loading

- **Today:** SCR-SHELL-LOADING--desktop-light-story.png (story only). Feedback: three different loading strings at once ("Loading episode…", "Loading project…", "Loading timeline…"). Hierarchy: play button shown enabled-looking while nothing can play. Language: the status bar repeats the title text.
- **Fate:** restyle.
- **Spec:**
  - Header renders at once with the title from the URL or recent list and the stage bar (stages switchable; each shows its own skeleton).
  - Timeline skeleton: one grey block per expected track (count from the project file when known, else 2) at the final lane height, with the track header showing avatar initials. No text.
  - Script skeleton: 6 grey lines of varying length, 16 px tall, 12 px apart.
  - Player bar: play button drawn at 40 % opacity with a 2 px progress ring around it showing audio load progress. Play enables the moment the first track's audio decodes; transcript and waveform peaks continue loading without blocking.
  - One sentence appears only after 4 s: "Still loading audio…" under the player timecode. On failure: "Couldn't load the audio. Retry" with Retry as a text button in the player bar; the rest stays usable.
  - No animation (skeletons static until the animation pass).
- **Shared elements used:** NEW: Player bar, NEW: Script pane, Track header.
- **Story to build:** `Shell/EditStage` stories `Loading`, `LoadingSlow`, `LoadFailedAudio`.

### SCR-SHELL-INGEST · Empty project, import by drop

- **Today:** SCR-SHELL-INGEST--desktop-light.png, --phone-light.png. Hierarchy: the drop zone, a second coach card, a disabled transport, an empty dock ("No combined transcript.") and an empty status bar all compete. Language: "Drop stems here… Split speakers… Import is also under Menu (Ctrl+I)" is a paragraph. Phone: empty state is the Listen hero with "Import audio to play." and a comment box for audio that doesn't exist.
- **Fate:** replace. Empty-project home is Prepare (spec-prepare owns the full page). Edit with zero tracks shows this compact empty state.
- **Spec:**
  - Edit content area becomes one centered drop target, max 560 × 320 px, dashed 2 px border in the border token, 16 px radius. Inside: a static waveform glyph 48 px, then two equal buttons side by side, each 160 × 96 px with icon above label: "Import audio" (tray-arrow-down icon) and "Record" (record dot icon, goes to the Record stage). Below in secondary text, one line: "One file per person works best."
  - Dropping files anywhere in the window works (NEW: Drop overlay). Each file becomes a track named from the file, speaker guessed from the name.
  - After import the anticipated next step is transcription; it starts automatically (Prepare badge shows progress). Edit shows the waveforms immediately and the Script pane shows "Transcribing… 12 %" in its header with lines appearing as they arrive.
  - Player bar is hidden while there is no audio. Script pane is hidden while there are no tracks.
  - Phone: the same two buttons stacked full width, 64 px tall each, centered vertically; "Import audio" opens the system file picker.
- **Copy:** "Import audio", "Record", "One file per person works best."
- **Shared elements used:** EMPTY state pattern (restyled), NEW: Drop overlay, Stage bar badge.
- **Story to build:** `Edit/EmptyProject` stories `Desktop`, `Phone`, `DragOver`, `Importing`.

### SCR-LAYOUT-TIMELINE · Maximize timeline

- **Today:** SCR-LAYOUT-TIMELINE--desktop-light.png. Hierarchy: maximizing still leaves 500 px of empty grey below two tracks. Interaction cost: reachable only through the View menu or Mod+Shift+2; the escape hatch is a "Restore" chip next to the timecode.
- **Fate:** remove. Lanes always fill height; collapsing the Script (T) gives the timeline the full width.
- **Spec:** T toggles the Script pane open/closed. When closed, a 24 px wide edge tab with the text-lines icon sits on the right edge of the timeline; click or drag it to reopen. State is remembered per project.
- **Shared elements used:** NEW: Script pane.
- **Story to build:** `Shell/EditStage` story `ScriptCollapsed`.

### SCR-LAYOUT-TEXT · Maximize transcript

- **Today:** SCR-LAYOUT-TEXT--desktop-light.png. Hierarchy: "maximize transcript" crops the guest track header mid-row and still shows long full-width lines. Consistency: the layout chip says "Restore" without naming what changed.
- **Fate:** replace with Script focus (Shift+T).
- **Spec:** Script fills the stage content; the timeline collapses to a 32 px overview strip pinned at the top of the stage (whole-episode miniature with playhead, selection band and suggestion ticks; drag to seek). Text measure stays at 68 characters, centered. Shift+T or clicking the overview strip's expand icon returns.
- **Shared elements used:** NEW: Overview strip, NEW: Script pane.
- **Story to build:** `Edit/ScriptPane` story `ScriptFocus`.

### SCR-LAYOUT-REVIEW · Review layout

- **Today:** SCR-LAYOUT-REVIEW--desktop-light.png. Purpose: the "review layout" is just the Comments tab made taller. Hierarchy: comment cards are full-width forms with Reply and Resolve buttons on every card.
- **Fate:** remove; replaced by the Review stage (spec-review).
- **Spec:** Mod+4 goes to Review. Nothing in Edit simulates review.
- **Story to build:** none (covered by Review stories).

### CMP-TRANSPORT · Transport bar (and CMP-TRANSPORT-PILLS)

- **Today:** SCR-SHELL-DESKTOP--shell1280-light.png, MENU-MAIN--desktop-light.png, SCR-PHONE-TIMELINE--phone-light.png. Hierarchy: play, stop, a 28 px timecode, a three-way audition switch, a mix pill, undo/redo, zoom, three tools, three fit buttons, View and Menu at one weight. Hierarchy: Stop is as large as Play. Language: "No mix yet", "Edited stems" are system words. Consistency: phone transport has comment and fit buttons but no zoom.
- **Fate:** replace with NEW: Player bar (bottom of every stage, every device).
- **Spec:**
  - Height 56 px, full width, surface-raised token, 1 px top border.
  - Left zone (desktop 240 px): current time in IBM Plex Mono 15 px, then "/ 52:10" edited length in secondary text, then a delta chip "−4:10" (scissors glyph + removed time) when cuts exist. Clicking the time turns it into an input: type 12:04 or 12m4s, Enter seeks.
  - Center: skip back (rewind-5 icon), Play/Pause 40 px circle in the accent fill (the only filled control in the shell), skip forward (forward-5 icon). Stop is removed; K pauses and returns to where play started (current Stop behavior), shown on hover of Play as the shortcut hint.
  - Right zone: Hear original (A/B icon) as a press-and-hold button; while held, playback switches to the unedited original at the same source time and the icon fills. Click (not hold) toggles a latched state shown by the filled icon. Then the solo chip (CMP-SOLO-CHIP) when any track is soloed. Then mix status only when not fresh: a 16 px ring around a waveform icon, filled to the progress fraction, while the mix updates; tapping it shows "Updating mix · plays edited stems meanwhile". Stale mix refreshes automatically; there is no Refresh button in normal use. Mod+B still forces it.
  - "Edited stems" audition mode moves into the player's long-press/right-click menu as "Hear without mix processing". The three-way switch is removed.
  - Importing and audio-error pills move: import progress shows as the Prepare badge ring and a toast on completion; an audio error shows in the left zone as a red dot + "Audio error" text button that opens the details popover.
  - Phone: same bar, 56 px; time left, play centered, Hear original right; skip buttons hidden (swipe the timeline instead); swipe up on the bar opens the Player sheet (SCR-PHONE-LISTEN replacement).
- **Primary action:** Play.
- **Anticipated next action:** while playing, the next likely action is cut the thing you just heard. Pressing Backspace while playing with nothing selected pauses and selects the word under the playhead (on a transcribed track); a second Backspace cuts it. The cut toast offers Undo.
- **Keyboard:** Space play/pause; K pause and return; J and L shuttle back/forward (1×, 2×, 4× on repeat); ← → nudge 1 s (Shift 5 s); Home/End; O hold to hear original.
- **States:** no audio (bar hidden), loading (ring), playing, mix updating, audio error, following someone (play button shows their avatar ring; Esc stops following).
- **Shared elements used:** Transport, A/B audition, NEW: Player bar, CMP-SOLO-CHIP.
- **Story to build:** `Shell/PlayerBar` stories `Ready`, `Playing`, `WithCuts`, `HearOriginalHeld`, `MixUpdating`, `AudioError`, `Soloed`, `Following`, `Phone`, `TimeInputOpen`.

### MENU-MAIN · Menu (hamburger)

- **Today:** MENU-MAIN--desktop-light.png, --phone-light.png. Purpose: the four most important outcomes of the product (Export, Share, Record, Import) hide inside a hamburger beside "Remove track" rows disabled with grey hints. Language: disabled items explain themselves in 10 px grey ("No track selected in inspector"). Touch: phone menu is a 470 px long list over the Listen card.
- **Fate:** remove. Contents redistributed as follows; a small NEW: Project menu (title dropdown) keeps the few project-level items.

| Today (Menu) | New home | Why |
|---|---|---|
| New project…, Open project… | Project menu (title dropdown): "Recent" list (5) + "Open…" + "New project"; Mod+N, Mod+O | Project switching is project-level |
| Bounce… | Range action bar ⋯ "Export selection…"; Deliver | Bounce is always of a selection |
| Export deliverables… | Deliver stage (Mod+5, Mod+Shift+E still works) | Stage C |
| Share… | Header invite button (person-plus) for review links; Deliver "Share for review" card | Inviting happens mid-edit too |
| Record room… | Record stage (Mod+2) | Stage C |
| Connect agent… | Project menu "Connect agent" | Rare, project-level |
| Import audio…, New track | Prepare; in Edit, the "+" under the last track header (Import audio / Empty track / Record a take); drop anywhere | Next to the tracks it creates |
| Remove track, Move track up/down | Track header: drag to reorder; track action bar Remove (trash) | Act on the object |
| Add chapter at playhead | Playhead action (More, Shift+C); double-click the marker lane | Direct |
| Select a range | Drag on empty lane; text selection; R toggles range dragging on touch | Direct |
| Audition (collapsed) | Player bar Hear original | One transport |
| Mix status (collapsed) | Player bar mix ring | One transport |
| Session, People | Header avatars | Presence |
| View (collapsed) | See MENU-VIEW | |
| Export diagnostics… | Project menu "Help and feedback" | Rare |
| Commands and shortcuts | Header search button; / or ? | Discoverable |

- **Spec (Project menu):** popover 280 px from the title. Rows 36 px (44 px touch): Recent projects (5, each with relative time), Open…, New project, separator, Project settings (vocabulary, loudness target: owned by spec-prepare), Connect agent, Appearance (System / Light / Dark segmented), Help and feedback, Keyboard shortcuts. No disabled rows.
- **Shared elements used:** NEW: Project menu, Stage bar, NEW: Player bar.
- **Story to build:** `Shell/ProjectMenu` stories `Open`, `Phone`, `NoRecents`.

### MENU-VIEW · View menu (and CMP-LEGEND layers)

- **Today:** MENU-VIEW--desktop-light.png, SCR-PHONE-MORE--phone-light.png. Hierarchy: nine checkboxes, three radio groups and "Amplitude −/+" text buttons in one dropdown. Language: "Waveform scale: Auto/Linear/Log (dB)", "Snap points", "Prosody" are engine words. Touch: on phone the same checkboxes sit in More with 100 px vertical gaps.
- **Fate:** remove the menu. Redistribute.

| Today (View) | New home |
|---|---|
| Layers: Pending edits, Comments, Markers | Always on. Suggestions, comments and markers are the product; they are never hidden in Edit |
| Layers: Volume envelope | Shown on a track when its envelope has points or when "Volume" is chosen from the clip/track ⋯ |
| Layers: Silence shading, Snap points | Silence shading on by default and drawn lightly; snap points drawn only during a drag (where they matter) |
| Layers: Prosody | Eye popover (below) |
| Waveform scale, amplitude ±, post-fader | Eye popover; plus Shift+scroll or vertical pinch over a lane changes amplitude directly |
| Zoom in/out, Fit | Corner zoom cluster |
| Track height ± | Drag a lane's bottom edge; Alt+= / Alt+- ; Fit is the default |
| Fit tracks to window height | Default behavior |
| Layout radios | Removed (T, Shift+T, stages) |
| Theme | Project menu > Appearance |

- **Spec (eye popover):** eye icon in the corner zoom cluster opens a 240 px popover: icon toggle chips 44 px each for Prosody, Silence shading, Envelope; a 3-way segmented for waveform scale (icons: linear ramp, log curve, auto "A"); amplitude scrub field (×0.5 to ×8). Popover closes on outside click.
- **Shared elements used:** NEW: Corner zoom cluster, NEW: Scrub field.
- **Story to build:** `Edit/CornerControls` stories `Default`, `EyePopoverOpen`, `Phone`.

### MENU-PEOPLE · People menu and avatar stack

- **Today:** MENU-PEOPLE--desktop-light.png, --phone-light.png. Hierarchy: the guest avatar is a 20 px "G" wedged between fit and View in the toolbar. Reach: on compact shells People is a section inside the overflow menu. Consistency: presence also appears as "Presence: You + 1 guest" text in the status bar.
- **Fate:** restyle into header avatars + NEW: Invite popover.
- **Spec:**
  - Header right: up to 3 avatars, 24 px, each with a 2 px ring in that person's presence color; an avatar for someone in a different stage shows that stage's 10 px icon at its corner. "+N" overflow chip.
  - Click an avatar: popover 260 px with name, role, where they are ("Review · 23:14"), buttons Follow (eye icon) and Go to (arrow icon, jumps your playhead and stage to theirs once, no follow). Following shows the BAN-FOLLOW bar (spec owned elsewhere) and a ring of their color around the play button.
  - Invite button (person-plus): popover 320 px: role segmented (Can listen / Can comment / Can edit, icons ear, bubble, pencil), "Copy link" primary button, list of people with this link. Same component as Deliver's share card.
  - Phone: one avatar max in the header plus the count; tap opens the same content as a sheet.
- **Shared elements used:** Person tile (24 px avatar form), NEW: Invite popover (shared with Deliver).
- **Story to build:** `Shell/People` stories `Solo`, `TwoPeople`, `Overflow`, `PersonPopover`, `InvitePopover`, `Phone`.

### Stage bar (shared vocabulary element; spec owned here)

- **Today:** no equivalent; today's phone nav is Listen / Timeline / Text / More (SCR-PHONE-*--phone-light.png).
- **Fate:** new shell element.
- **Spec:**
  - Desktop/tablet: segmented control centered in the header, 5 segments of 96 px × 32 px (88 px on tablet), each icon 16 px + label 13/500. Icons: Prepare = wand-and-tray, Record = filled circle, Edit = waveform-with-cursor, Review = check-in-bubble, Deliver = paper-plane. Active segment: raised surface with a 2 px accent underline. Below 1100 px width, inactive segments drop labels (icon + tooltip with name and key).
  - Badges at the segment's top right: count pill 16 px (Review), red dot + "12:04" elapsed (Record live), progress ring around the icon (Prepare running), amber dot (Prepare needs you), check (Deliver ready).
  - Phone: bottom tab bar 56 px + safe area, 5 equal tabs, icon 24 px over label 11 px, badges as above. It replaces Listen / Timeline / Text / More:

| Phone today | Phone tomorrow |
|---|---|
| Listen | Player bar on every stage; swipe up for the Player sheet. Guests and passive listening land in Review |
| Timeline | Edit, waveform surface |
| Text | Edit, text surface |
| More | Removed; contents redistributed (SCR-PHONE-MORE) |

  - Keys Mod+1..5. Switching is instant; content of the target stage renders from cache.
  - Clicking the active stage scrolls that stage to the playhead.
- **Shared elements used:** Stage bar.
- **Story to build:** `Shell/StageBar` stories `Desktop`, `DesktopNarrow`, `Phone`, `AllBadges`, `RecordingLive`, `GuestCommenter`, `GuestViewer`.

### CMP-TOOLRAIL · Editing tool rail (and CMP-RAIL-PEEK)

- **Today:** SCR-SHELL-TABLET--tablet-light.png, SCR-PHONE-TIMELINE--phone-light.png, SCR-SHELL-DESKTOP shots. Hierarchy: tools are split between the transport (desktop) and a second row (tablet/phone). Interaction cost: ten tools (Select, Blade, Comment mode, Range, Undo, Redo, Zoom ±, Add track, Import, Cut at playhead). Consistency: phone shows Select range as a dashed box, tablet as the words "Select range".
- **Fate:** replace. Tools collapse to a two-state tool toggle; the rest become verbs, header buttons or the corner zoom cluster.
- **Spec:**
  - There is no tool toggle (W1a, #2294). The tool rail, the Select/Blade modes, V, C and the spring-loaded Blade are gone; the corner box keeps the zoom cluster, the Script toggle, the eye and, on touch, the range toggle. Split is the Action bar's Split (S, or Mod+K at the playhead), or Alt-click at the pointer (mouse only); touch has the bar and the long-press menu.
  - Comment mode removed (W1a): the ruler no longer pins a comment, `Mod+Shift+C` and the Comments panel mode button are gone. Comment is a verb on any selection and at the playhead (C, bound by the action bar in W1b; until then the Player bar and the Comments panel compose).
  - Range tool removed on desktop: drag on empty lane area (or Shift-drag over clips) selects a range. Touch: long-press on a lane then drag selects a range; a range toggle (bracket icon, `range.arm`, 44 px) sits in the corner box on touch devices only (W1a: moved from the old tool strip into `EditCorner`, story `Stages/Edit/Corner` `TouchWithRange`).
  - Undo/Redo move to the header. Zoom moves to the corner zoom cluster. Add track and Import move under the track headers ("+"). Cut at playhead is the Split verb at the playhead (Mod+K).
  - CMP-RAIL-PEEK is replaced by the standard tooltip: name + key, 500 ms delay, shown on hover and keyboard focus, and once on first touch use as a NEW: Coach tip.
- **Shared elements used:** Icon language, NEW: Coach tip.
- **Alt-click Split (W1a):** with Alt held a 2 px guide with a 1 px ring follows the pointer over the lanes the split will cut (the targeted tracks, else the dialogue tracks, exactly what Mod+K cuts; a clip selection does not narrow it) and the cursor becomes a crosshair. Alt-click runs `edit.bladeCut` at that time, with the permission gate unchanged and no confirm on phone or tablet (Undo is on the toast). A plain click never splits, a click on a control in the lane is left alone, and an Alt press that travels more than a drag threshold (5 px) before release is a drag, not a split. A refused or failed split (a gap with no clip, no permission) is announced as an error in plain words, never silent. Under forced colors the guide paints in Highlight with a CanvasText ring. Alt held while the pointer is outside the lanes shows nothing, and a viewer or a guest who cannot suggest edits gets neither the guide nor the crosshair; releasing Alt, a window blur or a hidden tab clears the guide. Alt-press on a clip body does not start a drag or a range. The OS can intercept Alt-click (some Linux window managers use it to move windows); that is a note, not a fallback. Touch has no Alt, so the Split verb for touch arrives with the action bar in W1b; until then touch splits through the palette or the create menu.
- **Story to build:** `Stages/Edit/Corner` stories `TouchWithRange`, `RangeArmed`, `RangeUnavailable` (built in W1a).

### CMP-STATUSBAR · Status bar

- **Today:** SCR-SHELL-DESKTOP--shell1280-light.png, SCR-SHELL-TABLET--tablet-light.png. Hierarchy: presence, save dot, "1 pending edit", "Cut 0:00 of 1:00", "1 social clip", "Transcript needs sync", an activity log in a bordered box and "Open comments" share one row. Language: "Activity finished · Reconciled transcript · 3/3 steps · 0:02". Consistency: the activity box looks like a button.
- **Fate:** remove. Items move: presence to header avatars; save dot to header; pending edits and Open comments to the Review badge; Cut X of Y to the player bar delta chip; social clips to Deliver; "Transcript needs sync" to the Script pane header notice; pipeline activity to the Prepare badge.
- **Story to build:** none.

### CMP-SAVEDOT · Save indicator

- **Today:** SCR-SHELL-DESKTOP shots (status bar dot), SCR-PHONE-* (floating dot top left at 0,0). Feedback: the phone dot floats unlabeled above the content. Language: states are color only.
- **Fate:** restyle and move to the header after the title.
- **Spec:** 8 px glyph, 24 px hit area, tooltip and accessible name carry the words. Saved: no glyph after 2 s (absence means saved), a check for 2 s after each save. Saving: hollow ring. Waiting to send (offline): cloud with slash, amber. Save failed / unreadable: red triangle; clicking opens a popover with the reason and "Retry" and "Download a copy". Project unavailable: red triangle plus the header title dims.
- **Shared elements used:** Icon language.
- **Story to build:** `Shell/SaveIndicator` stories `Saved`, `JustSaved`, `Saving`, `WaitingToSend`, `Failed`, `Unavailable`.

### CMP-PIPELINE-CHIP · Pipeline status chip

- **Today:** SCR-SHELL-TABLET (status bar box), SCR-PHONE-LISTEN--phone-light.png (full-width bordered box). Language: step counts and job names. Hierarchy: completed jobs keep occupying space.
- **Fate:** merge into the Prepare stage badge.
- **Spec:** ring around the Prepare icon shows overall progress; amber dot when stalled or failed; clicking the badge while not in Prepare opens a 300 px popover listing running jobs (icon, plain name such as "Transcribing", percent, Cancel) with "Open Prepare". Completed jobs disappear and post one toast with their next action ("Transcript ready · Review 12 suggestions").
- **Shared elements used:** Stage bar badge, TOAST.
- **Story to build:** `Shell/StageBar` story `PrepareRunningPopover`.

### CMP-TABS · Bottom panel tabs (and CMP-SPLITTER, CMP-DRAWER-HANDLE, CMP-LAYOUT-CHIP)

- **Today:** SCR-SHELL-DESKTOP--shell1280-light.png. Purpose: six tabs hold four unrelated jobs (text, collaboration, reports, setup). Interaction cost: "Shorter", "Taller", "Reset panel size" text buttons duplicate the drag grip. Consistency: the layout chip "Restore" appears in the transport.
- **Fate:** remove. Transcript becomes the Script pane; Comments, Impact, Tighten go to Review; History becomes the Undo history popover (long-press or right-click Undo); Pipeline goes to Prepare. The splitter becomes the plain divider between timeline and Script (drag; double-click resets; keyboard: focus it, ←/→ 16 px, Shift 64 px, Enter resets). No text buttons. Drawer handle and layout chip are removed.
- **Story to build:** `Edit/Divider` stories `SideBySide`, `Stacked`, `Focused`.

### Timeline

### CMP-TIMELINE · Timeline canvas

- **Today:** SCR-SHELL-DESKTOP--shell1280-light.png, SCR-PHONE-TIMELINE--phone-light.png. Hierarchy: three unlabeled rows (chapters, a blue bar, orange blobs) take 95 px above the tracks. Hierarchy: half the timeline height is empty. Touch: phone lanes are 200 px tall but the clip label and edges are small.
- **Fate:** restyle.
- **Spec:**
  - Stack top to bottom: ruler 24 px; marker lane 24 px; lanes filling the rest. On phone and when Script focus is on, the NEW: Overview strip (16 px) sits above the ruler showing the whole episode with a draggable viewport rectangle.
  - Lane: track color as a 3 px edge on the lane's own inline start (System/Lane draws it, not the header) and a 6 % tint behind the lane. Clips draw as rounded 6 px rectangles in the track color with the waveform at 70 % contrast.
  - Playhead: 2 px accent line across ruler and lanes with a 10 px triangle on the ruler; on phone it is fixed at the horizontal center (existing fixed-playhead behavior) and content scrolls under it.
  - Suggestions draw in-lane as hatched regions (shared Suggestion element); applied cuts draw as Seam marks.
  - Corner zoom cluster: bottom-right of the lanes, floating 8 px inside, a 3-button pill: Fit (arrows-out), Zoom out, Zoom in; plus the eye button. 32 px buttons, 44 px on touch.
  - "+" row under the last lane in the header column: 32 px button opening Import audio / Empty track / Record a take (goes to Record with "add to this project" preselected).
- **Primary action:** select (click) on content.
- **Anticipated next action:** after selecting, a verb; the action bar is already beside the object.
- **Keyboard:** Tab moves focus through clips in time order on the focused lane; ↑/↓ moves between lanes; Enter selects; arrow keys on a focused handle trim; = / - / \ zoom; Z zooms to the selection.
- **Touch:** one-finger horizontal swipe pans; pinch zooms about the fingers; tap selects; long-press empty opens Create here; long-press then drag selects a range.
- **States:** empty (SCR-SHELL-INGEST), loading peaks (flat center line in track color until peaks arrive), recording (OVL-RECORDING), guest read-only (no handles; tap selects for Comment/Hear only).
- **Shared elements used:** Suggestion, NEW: Seam, NEW: Overview strip, NEW: Corner zoom cluster, Action bar.
- **Story to build:** `Stages/Edit/Timeline` stories `ThreeTracks`, `DeepZoom`, `PhoneFixedPlayhead` (built from the parts, S7b-1a) and `WithEnvelope` (S7b-1b); `System/Lane` stories `Empty`, `ThreeTracks`, `PeaksLoading`, `Muted`. Still to build, with the parts they need: `TwelveTracks`, `WithSuggestions`, `WithCuts`, `ReadOnlyGuest`. A guest's read-only look is the clip's, not the lane's.

### CMP-RULER · Time ruler

- **Today:** SCR-SHELL-DESKTOP shots, PNL-TRANSCRIPT shots. Interaction cost: dragging the ruler does not scrub. Hierarchy: the ruler and its comment anchors visually merge with the marker rows.
- **Fate:** restyle.
- **Spec:** 24 px. Labels in Plex Mono 11 px at adaptive intervals (never closer than 64 px). Click seeks; drag scrubs with audio (short grains, 1× speed cap); double-click fits; the current selection draws as a 4 px accent band along the bottom of the ruler with 12 px drag handles at both ends (resize the selection from the ruler). Comment anchors move to the marker lane.
- **Shared elements used:** Transport (playhead), OVL-RANGE band.
- **Built (design-system element 17a, `System/Ruler`):** the stories are `Fit`, `Zoomed`, `WithSelection`, `Scrubbing`, `Phone` and more, under `System/Ruler`, not `Edit/Ruler`. The part reports the scrub as seconds with commit or not; scrub audio (the grains and the 4x silent pan of INT-SCRUB) is the host's and is not built here. No minor ticks are drawn. A finger swipe scrubs after 10 px on the ruler body, and the selection knobs are 44 px wide and 24 px tall under a coarse pointer, since a taller area would cover the marker lane.

### CMP-MARKERS · Marker lane

- **Today:** SCR-SHELL-DESKTOP--shell1280-light.png. Hierarchy: chapters, the social clip bar and comment blobs each get their own unlabeled row (direction doc problem 3). Language: nothing names what the blue bar and orange blobs are.
- **Fate:** restyle into one NEW: Marker lane.
- **Spec:** one 24 px lane. Chapter: 12 px flag in the chapter token with its title inline (truncated at the next marker). Comment: 16 px speech-bubble pin in the comment token with the author's initial; a span comment draws a 3 px bar in the same color from start to end. Social clip: bracket pair "[ ]" in the social token connected by a 2 px line, title on hover. Hover any marker: label tooltip with time. Click: select (action bar). Drag a chapter or bracket edge: move with a readout chip. Double-click empty lane: add chapter at that time and open its name for typing. Overlapping markers stack into a "+3" chip that opens a list.
- **Shared elements used:** Icon language, Action bar, NEW: Readout chip.
- **Built (design-system element 18a, `System/MarkerLane`):** the stories are `AllKinds`, `Dense`, `Selected`, `AddingChapter`, `Phone` and more, under `System/MarkerLane`, not `Edit/MarkerLane`. A whole bracket drags as well as its edges, and a comment pin is selectable but never drags. A touch area is 44 px wide for an isolated marker and exactly the lane's 24 px tall; in a dense spot it shrinks to the half-gap to each neighbour (design-system 18a), and the "+N" list is the reliable path. A double-tap on touch relies on `dblclick`, so the phone's primary way to add a chapter is the dock's "Add chapter". A marker folded into a "+N" chip is reached through the chip's list, also from the keyboard.

### CMP-CLIP · Clip block

- **Today:** INS-CLIP--desktop-light.png, POP-JOIN--desktop-light.png. Direct manipulation: trim handles and fade corners are invisible until you know where to hover; numbers live in a form. Language: "reference · 1m 0s" label repeats the track name on every clip.
- **Fate:** restyle.
- **Spec:**
  - Label only when useful: take name or source file, top-left 11 px, hidden when the clip is 80 px wide or narrower (design-system element 17: shown only when wider than 80 px).
  - Hover (pointer): 8 px trim zones at both edges show a ↔ cursor; fade knobs (10 px circles) appear at the top corners. Selected: 2 px accent outline, trim handles become visible 6 × 24 px tabs, fade knobs stay visible; on touch the handles' hit areas grow to 44 px.
  - Fades draw as a curve in the top corners with the faded area at 40 % opacity.
  - Seams between adjacent clips draw as NEW: Seam marks (6 px diamond on the lane's top edge).
  - Muted region: diagonal grey hatch with a speaker-off glyph at its start. Cut regions are gone from the timeline (time removed) and leave a Seam.
  - During any drag a NEW: Readout chip floats 12 px above the pointer: "−120 ms · 12:04.340".
- **Shared elements used:** NEW: Seam, NEW: Readout chip, Action bar.
- **Story to build:** `Edit/Clip` stories `Idle`, `Hover`, `Selected`, `Trimming`, `FadeDrag`, `Muted`, `Narrow`, `Touch`, `ReadOnly`.

### POP-JOIN · Join popover

- **Today:** POP-JOIN--desktop-light.png. Interaction cost: a popover with a segmented Cut/Fade/Crossfade, a slider and a sentence of explanation, plus separate Seek and Audition buttons. Consistency: the same seam is called "join" here and "boundary" in the transcript.
- **Fate:** merge into the Seam action bar and Seam inspector.
- **Spec:** clicking a Seam selects it. Action bar: Hear (plays 2 s before to 2 s after, Shift+Space), join type as a 3-icon segmented (hard edge, fade, crossfade), Keep (only when the seam is a cut: restores it), Comment, Inspect. Inspect opens the sheet with a length Scrub field (0 to 500 ms), A/B Hear before/after, and the roll offset (DLG-PRECISION content). Changes apply on release; Hear replays automatically after each change while the sheet is open (anticipating "did that fix it?").
- **Shared elements used:** NEW: Seam, Action bar, Inspector sheet, A/B audition, NEW: Scrub field.
- **Story to build:** `Edit/Seam` stories `Selected`, `CrossfadeInspector`, `CutSeamWithKeep`, `Blocked` (crossfade impossible: segment hidden, reason in sheet), `Phone`.

### POP-CHOOSER · Touch target chooser

- **Today:** not reached (no shot, no story). Interaction cost: needed only when a finger covers several targets.
- **Fate:** keep, restyle.
- **Spec:** on long-press over overlapping targets, a fan of 44 px round chips appears 56 px above the finger (to the chip's centre; the outer chips bend back so their lower edge stays 28 px above it), each with the object-kind icon (clip, seam, comment, suggestion, envelope point, word) and its track color ring. A caption on the far side of the arc from the press point names the chip the finger is over. Slide to a chip and lift to select; lift elsewhere cancels, and the gesture is owned by the hit router, not by the chooser. The chips are 8 px apart, the outer ones sag 6 px, and the fan keeps 16 px from the box edges. At most five chips are drawn; a longer list is paged by the host. Never shown when one target is unambiguous. Keyboard fallback: a menu of the same chips, Left and Right to move, Enter to pick, Escape to cancel.
- **Shared elements used:** Icon language.
- **Story to build:** `Stages/Edit/TargetChooser` stories `TwoTargets`, `FourTargets`, `NearEdge`, `NearTop`, `Phone`, `PhoneEdge`, `Gesture`.

### CMP-RANGE-ACTIONS · Range actions bar

- **Today:** INS-RANGE--desktop-light.png, --phone-light.png, INS-WORD--desktop-light.png. Hierarchy: a full-width toolbar pushes the timeline down 68 px (152 px with word controls). Hierarchy: "Fill room tone" shows disabled with a sentence explaining why. Interaction cost: seven text buttons plus "Add word before / after / Drop first / last word / Ignore".
- **Fate:** merge into the Action bar (range variant).
- **Spec:** action bar over the range: Hear, Cut, Split, Comment, More (Mute, Fill with room tone only when the range contains a gap, Move to speaker only when lanes are speaker-split, Export selection…, Copy), Inspect (In, Out, Length Scrub fields). Left of the verbs: NEW: Scope chip showing which tracks are affected as stacked track-color dots ("All" when all) and a ripple glyph when time will close. Clicking the scope chip opens track toggles. The range edges are dragged directly on the lane or ruler; word-range adjustments are drag handles on the text selection (CMP-WORDRANGE).
- **Built (W1b, #2294):** `stage/edit/EditActionBar.tsx` draws the bar from `editFacts` and `resolveBar`, worded and gated by `commands/editVerbs.ts` (`barModelOf`, `runEditVerb`): floating by the selection on desktop and tablet (below the selection so the ruler stays uncovered, flipping above when there is no room; hides while its anchor is scrolled or zoomed out of view), the dock above the Player on a phone. `timeline/RangeActions` shrank to `timeline/RangeFields`: the In and Out fields with the track scope and the agent range, the choice between audible occurrences, and the word-range handles. Its verb buttons, summary line and Clear range (Esc) are gone; Move to speaker is a More row per sibling lane. The gates carried over: busy, a join in flight, a stale range, "Suggest cut" and "Suggest mute" for a suggest link, host-only Export, the guest's "Play full mix" and its stale-mix refusal. A refusal of any verb is announced; only the primary shows a disabled reason in place. A selection across tracks covers the range on every one of them (W2 reads this for words). The Inspector opens only on Inspect (I, the verb, a double-click on a clip), never because something is selected.
- **Anticipated next action:** after Cut, the next similar range. See INT-WORD-CUT and INT-RANGE.
- **Shared elements used:** Action bar, NEW: Scope chip, Inspector sheet.
- **Story to build:** `Edit/ActionBar` stories `Range`, `RangeWithGap`, `RangeScopeOneTrack`, `RangePhoneDock`.

### CMP-SOLO-CHIP · Solo chip

- **Today:** no shot (phone header only). Feedback: soloed playback is easy to forget and silently changes what you hear.
- **Fate:** keep; move to the player bar on all devices.
- **Spec:** when any track is soloed, a 28 px chip appears in the player bar right zone: headphones icon + avatars of soloed tracks + ✕. ✕ clears all solos. Hidden otherwise.
- **Shared elements used:** NEW: Player bar.
- **Story to build:** `Shell/PlayerBar` story `Soloed`.

### Overlays

### OVL-PENDING · Pending edit regions

- **Today:** INS-PENDING--desktop-light.png. Hierarchy: a card with "Edit timing / Approve / Reject" sits over the guest lane, unrelated to the reference lane it belongs to. Language: "pending edit", "Approve/Reject" vs "suggestion" elsewhere.
- **Fate:** restyle into the shared Suggestion element.
- **Spec:** suggestion regions draw as 45° hatching in the suggestion token over the affected lanes, 2 px outline, with a 16 px kind glyph at top-left (filler, pause, false start, guest suggestion avatar). Click selects; the action bar shows Hear (A before / B after), Cut (accept, Enter), Keep (reject, X), Comment, Inspect. After Enter or X the selection moves to the next suggestion in time order and the timeline scrolls to it (anticipating the next decision); Shift+Tab goes back. Edge handles (6 × 24 px, 44 px touch) drag bounds directly.
- **Shared elements used:** Suggestion, Action bar, A/B audition.
- **Story to build:** `Edit/Suggestion` stories `Kinds`, `Selected`, `DragEdge`, `GuestSuggestion`, `Phone`.

### OVL-APPLIED · Applied edit ticks

- **Today:** not reached (index note: ticks never rendered). Purpose: users can't see where cuts landed.
- **Fate:** merge into NEW: Seam marks.
- **Spec:** every applied cut leaves a Seam mark with the removed length in the tooltip ("2.4 s cut · filler"). Selecting it gives Keep to restore.
- **Story to build:** `Edit/Seam` story `AppliedCuts`.

### OVL-EDITMARKERS · Edit marker layer

- **Today:** no shot of my own; storied (EditMarkerLayer AllTypes). Consistency: three glyph families (cut, ripple, blade) plus chips.
- **Fate:** merge into NEW: Seam marks (cut seam diamond filled; split seam diamond hollow).
- **Story to build:** `Edit/Seam` story `SeamKinds`.

### OVL-STALE · Stale render bands

- **Today:** storied only. Feedback: bands flag regions the user can't act on.
- **Fate:** remove. Mix freshness shows only in the player bar ring; playback uses edited stems until the mix catches up.
- **Story to build:** none.

### OVL-PRESENCE · Remote playheads and selections

- **Today:** MENU-PEOPLE--desktop-light.png (G avatar pinned on the lane). Consistency: avatar sits on the clip label.
- **Fate:** restyle.
- **Spec:** remote playhead: 1 px line in the person's color with a 16 px flag on the ruler (a circle in their color with their first initial, drawn by System/Presence; it is not a Person avatar size, see design-system element 32). Remote selection: 1 px outline in their color, no fill (dashed under forced colors). Hidden for the person you follow. One overlay over ruler, marker lane and lanes in the time column, taking no pointer. The remote pointer cursor in the lanes was dropped by the wiring slice (the local cursor is still published); a follow-up adds it to System/Presence.
- **Built (#2294 S7b W2):** `timeline/TimelinePresence.tsx` mounts the leaf in the ruler's own window (`timeline/useRulerWindow.ts`) as the last child of the time column, one step above the sticky ruler and marker lane. It owns the join/leave announcer and a rAF ticker that moves a playing remote playhead, and widens point selections to 2 px (5 px for an envelope point) and spans to at least 2 px. The line stops at the bottom of the last lane (`--sys-presence-end`, set from the lane rows) and runs the full height when there are no lanes. People and selections keep their objects and arrays while their values are equal (`presence/useStableList.ts`), so a cursor-only roster change redraws nothing. Under vertical scroll the flag and the marker-row part of the line move with the lanes, not with the pinned ruler.
- **Shared elements used:** Person tile (avatar form).
- **Story to build:** `System/Presence` stories `TwoRemote`, `RemoteSelection`, `FollowedHidden`; the phone form is `PhoneFixedPlayhead` in `Stages/Edit/Timeline`.

### OVL-ENVELOPE · Volume envelope

- **Today:** INS-ENVELOPE--desktop-light.png. Interaction cost: Show, Edit, then "Select a point" dropdown and "Add point" button. Language: "1.00× is unchanged, 0 is silent, 1.50× is the maximum".
- **Fate:** restyle; points created directly.
- **Spec:** shown from track or clip More > Volume, or when points exist. Line in the track color, 2 px, values in dB on a scale from -60 dB to +3.52 dB (the stored gain's ceiling), with a labelled 0 dB guide (design-system element 15b). Click the line adds a point; drag moves it (readout chip "−3.0 dB · 12:04.3"); select shows action bar (Hear, Remove, Inspect: Time and Level Scrub fields); Backspace removes. Hide envelope from the eye popover.
- **Shared elements used:** Action bar, NEW: Scrub field, NEW: Readout chip.
- **Story to build:** `System/Envelope` stories `Empty`, `Points`, `PointSelected`, `Dragging`, `Tall`, `ReadOnly`, `Phone` (built, S7b-1b), `Fade`, `Wired` (leaf fix, W3a: gain-space line, one-axis drags, `hitProps`); `WithEnvelope` in `Stages/Edit/Timeline`.

### OVL-BLEED · Automatic reduction regions

- **Today:** storied only (INS-BLEED--desktop-light-story.png). Purpose: niche inspection.
- **Fate:** keep, shown only while the clip's "Auto reduction" section is open in its inspector.
- **Spec:** regions draw as a 20 % wash with a downward-arrow glyph; selecting one shows Hear (A/B), Keep (restore original audio), Inspect.
- **Story to build:** `Edit/AutoReduction` stories `Regions`, `Selected`.

### OVL-PROSODY · Prosody overlay

- **Today:** no shot, no story. Purpose: unclear to non-experts.
- **Fate:** keep behind the eye popover, off by default.
- **Story to build:** `Edit/CornerControls` story `ProsodyOn`.

### OVL-RECORDING · Recording overlay

- **Today:** no shot. Feedback: the only in-Edit sign of a live take.
- **Fate:** keep; coordinate with spec-record.
- **Spec:** while a take records, each recording lane shows a red-tinted band growing from the take start to the live edge with a live waveform; the Record stage badge pulses (static dot until the animation pass). Clips under the band can't be edited until the take lands; tapping the band offers "Go to Record".
- **Story to build:** `Stages/Edit/Timeline` story `RecordingLive`.

### OVL-RANGE · Range and comment span overlay

- **Today:** INS-RANGE--desktop-light.png (two thin red lines). Feedback: the selected range is two hairlines; hard to see.
- **Fate:** restyle.
- **Spec:** selected range: 12 % accent fill over the scoped lanes only, 2 px accent edges with drag tabs, mirrored as the ruler band. Comment span: same shape in the comment token.
- **Shared elements used:** OVL-RANGE as the one selection drawing.
- **Story to build:** `Edit/Range` stories `AllTracks`, `OneTrack`, `FromText`.

### OVL-COMMENT-BUBBLE · Playback comment bubble

- **Today:** storied only. Purpose: surface comments while listening.
- **Fate:** keep, restyle.
- **Spec:** during playback past a comment, a 240 px bubble appears above its pin in the marker lane for 4 s: avatar, first 80 characters. Click opens the comment popover (INS-COMMENT). Never covers the action bar.
- **Story to build:** `Edit/MarkerLane` story `PlaybackBubble`.

### MENU-CREATE · Create here menu

- **Today:** MENU-CREATE--desktop-light.png. Before W1: disabled "Add envelope point · Show the volume envelope before adding a point". Consistency: verbs here (Blade cut, Add comment) use different names than the toolbar. Built (W1b, superseded by the next sentence): the long-press menu opened with Split here, then Add chapter and Add comment, then the lane's Add envelope point. Built (#2294 S7b W1): the menu is the Create here part `Stages/Edit/CreateMenu`, mounted by `timeline/TimelineCreateMenu.tsx`: Split here, Comment here, Add chapter here, Record here (host only), then Add volume point on a lane (picking it turns the volume layer on) and Paste while the clipboard has audio; rows the link cannot run are absent, not disabled.
- **Fate:** restyle as the playhead/point variant of the verbs.
- **Spec:** right-click, Shift+F10 or long-press on an empty point opens a 220 px menu headed by the time and track ("12:04.3 · Maya", a 32 px row): Split here (no key cap: its chord cuts at the playhead, and the keymap is held while the menu is open; the row carries the note "Cuts at this time, not the playhead" as its accessible description and tooltip, never visible text, with no change to the row's height) first, Comment here (C), Add chapter here (Shift+C), Record here (host only), Add volume point (the `spline` icon; on any lane, and picking it turns the volume layer on), Paste (when the clipboard has audio). Rows are 36 px, 44 on touch. Same icons as the action bar. Rows that can't apply are absent, so there are no disabled rows and no reasons. Escape closes the menu without clearing the selection, and Tab out closes it. Phone: the same rows in a content-height Sheet. When the menu closes and focus would otherwise be lost, it returns to the press target (its focusable, else the held lane, else the Timeline position slider); after a Paste that ran it lands on the held lane, named for its track and ringed, only if focus is still free.
- **Shared elements used:** Icon language, Action bar verbs, Menu (220 px instance).
- **Built (S7b-2a, #2294):** `Stages/Edit/CreateMenu` stories `Lane`, `WithNote`, `WithPaste`, `NearEdge`, `Phone` (design-system Edit-local list). Superseded by #2294 S7b W1, which wired the host: it maps `onPick(id)` to commands at the held time (Split here is `edit.bladeCut` with `atTime`), announces the menu, and adds the portal and top layer; Add volume point shows on any lane.

### Tracks

### CMP-TRACK-HEADERS · Track header column

- **Today:** SCR-SHELL-DESKTOP--shell1280-light.png, SCR-SHELL-TABLET--tablet-light.png, SCR-PHONE-TIMELINE--phone-light.png. Hierarchy: name, role, M, S, FX chip, a tiny fader and a grip in 180 px. Language: M/S letters, "FX 1", "Out 0.0 dB". Touch: phone headers are a circle and an unlabeled slider.
- **Fate:** restyle.
- **Spec:**
  - Desktop 168 px. Row 1: 28 px avatar (Person tile avatar form: photo or initials in the track color) with a level ring that lights during playback; name 13/600 (click to rename inline); a stale-stem glyph as a hollow ring on the avatar while rebuilding. Row 2 (shown on hover, focus or when set): mute (speaker-slash icon) and solo (headphones icon) toggles, 32 px (design-system 4.4; 44 px on touch); level as a thin 64 px bar showing gain, drag horizontally to set (readout chip), double-click resets to 0 dB.
  - Set states stay visible without hover: muted shows a filled speaker-slash and greys the lane; soloed shows a filled headphones icon.
  - Effects count and role leave the header (track inspector).
  - Drag anywhere on the header (not on a control) to reorder. The drag starts from the whole header; only its controls refuse it.
  - Widen the column by dragging its right edge to 280 px: rows then show the full fader with dB and a meter (desktop mixer view).
  - Phone: 56 px column, avatar only with level ring; tap selects the track (action bar: Mute, Solo, Hear, Inspect); mix controls in SHEET-PHONE-MIX.
- **Keyboard:** M mute, Shift+S solo on the focused or targeted track; Shift+↑/↓ reorder.
- **Shared elements used:** Person tile (avatar + live level), NEW: Scrub field (level bar), Icon language.
- **Story to build:** `System/TrackHeader` stories `Default`, `Hover`, `Muted`, `Soloed`, `ImpliedMute`, `Rebuilding`, `Wide`, `Phone`, `Reordering`.

### CMP-TRACK-FADER · Track fader

- **Today:** SHEET-PHONE-MIX--phone-light.png, INS-TRACK shots. Language: "Staging gain 0.0 dB; plays at 0.0 dB with the volume envelope at 0.0 dB at the playhead / Balance not measured".
- **Fate:** restyle as a NEW: Scrub field (level variant).
- **Spec:** horizontal bar, 0 dB tick, −60 to +12 dB, value text "−3.0 dB" right-aligned; drag, arrow keys 0.5 dB (Shift 3 dB), double-click or double-tap resets. One sentence of help appears only in the track inspector on first open.
- **Story to build:** `Edit/ScrubField` story `Level`.

### CMP-TRACK-MIX and SHEET-PHONE-MIX · Mix sheet

- **Today:** SHEET-PHONE-MIX--phone-light.png. Hierarchy: a paragraph explains which controls save. Touch: M/S 88 px boxes, fader thin; the sheet is full height for two rows.
- **Fate:** restyle.
- **Spec:** phone: mixer icon in the Edit sub-bar opens a sheet sized to content (max 70 %). Each row 64 px: avatar with level ring, name, mute and solo icon toggles 44 px, level Scrub field filling the rest. Solo shows the headphones glyph only (listening-only status is in the tooltip and first-use coach tip "Solo is just for your ears"). Desktop: the wide header column is the mix view.
- **Shared elements used:** Person tile avatar, NEW: Scrub field, Inspector sheet (phone sheet form).
- **Story to build:** `Edit/MixSheet` stories `TwoTracks`, `ManyTracks`, `Soloed`, `ReadOnly`.

### Script pane (transcript as an editing surface)

### PNL-TRANSCRIPT · Transcript panel

- **Today:** PNL-TRANSCRIPT--desktop-light.png, SCR-PHONE-TEXT--phone-light.png, INS-WORD shots. Hierarchy: three visible lines at the bottom; every word is a button with button spacing. Interaction cost: five modes (Annotate, Correct, Select, Find and replace, Follow) change what a click does. Language: permanent help sentence. Touch: on phone the mode buttons wrap to two rows and the help takes three lines.
- **Fate:** replace with NEW: Script pane.
- **Spec:**
  - Header 40 px: search (magnifier, opens CMP-FINDREPLACE inline), low-confidence stepper chip "? 3" (only when > 0; click or Alt+↓ jumps to next), show-cut-text eye toggle, follow-playhead pin toggle. Inline notices (transcribing %, "Transcript out of date · Update") sit at the right of this header.
  - Body: turns (CMP-TURN). Text IBM Plex Sans 16/26, words as plain text runs with normal word spacing, max 68 characters measure, 24 px side padding.
  - No modes. One grammar:
    - Click a word: places the caret before it and seeks the playhead there.
    - Drag across words, Shift-click, or double-click (word) / triple-click (sentence): selects; the action bar appears above the selection. Built so far: Shift-click, Shift with the arrows and the two handles. Mouse drag, double-click, triple-click and long-press are deferred.
    - Enter, F2 or double-click on a word: Fix text on that selection. Typing never starts it.
    - Backspace with a selection: Cut. Backspace with only a caret: nothing (protects against accidental cuts).
  - Rendering of state: playing word gets a 2 px accent underline; cut words collapse into an Edit boundary pill (CMP-EDITBOUNDARY) unless the eye is on, then they show struck in the cut token; suggested cuts show struck with hatch background (Suggestion); muted words show greyed with a speaker-slash glyph before the run; low-confidence words get a dotted underline.
  - Follow: pin on by default. Scrolling by hand turns it off and shows a "Back to playhead" pill at the bottom center; clicking it scrolls and re-pins.
- **Primary action:** select words.
- **Anticipated next action:** after selecting, Cut; after cutting, the next occurrence (INT-WORD-CUT).
- **Keyboard:** ↑/↓ moves the caret by line, ←/→ by word; Shift extends; Mod+F find; Esc clears selection.
- **Touch:** see SCR-PHONE-TEXT.
- **States:** loading (skeleton lines), transcribing (lines appear progressively; untranscribed time shows as a grey "Not transcribed yet · 12:00 to 52:10" row), no transcript (empty state "Transcribe this episode" button that starts the job), stale ("Transcript out of date · Update" notice), guest (select, Hear and Comment only; Fix text and Cut hidden for Viewer and Commenter; Commenter's Cut creates a suggestion).
- **Shared elements used:** NEW: Script pane, Action bar, Suggestion, NEW: Seam (as boundary pill), NEW: Selection handles.
- **Story to build:** `Edit/ScriptPane` stories `Reading`, `Playing`, `WordsSelected`, `WithCuts`, `ShowCutText`, `WithSuggestions`, `LowConfidence`, `Transcribing`, `NoTranscript`, `OutOfDate`, `GuestCommenter`, `Phone`.

### CMP-TURN · Speaker turn

- **Today:** PNL-TRANSCRIPT--desktop-light.png. Hierarchy: speaker name, a bracketed "[2.4s]" and text run on one line with equal weight. Language: "[35.4s]" timestamps.
- **Fate:** restyle.
- **Spec:** two-column turn: left margin 88 px holds the speaker (20 px avatar + first name 12/600 in the track color); time "12:04" appears in the margin under the name on hover. Text column right. Turns separated by 16 px. Consecutive turns by the same speaker merge (no repeated name) when the gap is under 2 s.
- **Shared elements used:** Person tile avatar.
- **Story to build:** `Edit/ScriptPane` story `Turns`.

### CMP-GHOST · Restored word chips

- **Today:** storied only. Consistency: a separate chip style for restored words.
- **Fate:** merge. Restored words render as normal text with a 1 s fade-free flash of the keep token behind them (static highlight that clears on next action). No chips.
- **Story to build:** `Edit/ScriptPane` story `JustRestored`.

### POP-SPEAKER · Speaker popover

- **Today:** POP-SPEAKER--desktop-light.png. Hierarchy: a dropdown, "All turns on reference.", Save speaker and Cancel push the turn text sideways. Language: "Save speaker".
- **Fate:** replace with a speaker popover anchored to the margin name.
- **Spec:** 260 px popover: list of speakers (avatar + name, 44 px rows) with a check on the current one; choosing another moves this turn to that speaker's lane (Move to speaker); a pencil on each row renames the speaker everywhere (applies on Enter; Esc cancels; leaving the field changes nothing; an empty or duplicate name stays in the field with the reason); an "Add speaker" row takes a new name the same way. The arrows move the focus ring and picking is click, Space or Enter. No Save button. Undo covers both.
- **Shared elements used:** Person tile avatar, Action bar verb Move to speaker.
- **Story to build:** `Edit/SpeakerPopover` stories `Open`, `Renaming`, `Phone`.

### POP-WORD-EDIT · Inline word correction

- **Today:** POP-WORD-EDIT--desktop-light.png. Feedback: a fixed-width box with system-blue selection that clips the word. Language: "Correct word".
- **Fate:** restyle as Fix text.
- **Spec:** the selected words become an inline text field sized to content (min 48 px), 1 px accent outline, same font. Enter or click outside commits; Esc reverts; Tab commits and moves to the next low-confidence word (anticipating a correction pass). Text changes never move audio; the field's placeholder-free design relies on the outline. On commit, a toast "Text fixed · Undo".
- **Shared elements used:** Action bar verb Fix text, TOAST.
- **Story to build:** `Edit/ScriptPane` stories `FixTextOpen`, `FixTextMultiWord`.

### CMP-FINDREPLACE · Find and replace

- **Today:** CMP-FINDREPLACE--desktop-light.png. Hierarchy: Find and Replace fields render clipped inside the three-line dock. Interaction cost: Preview replacements then Replace all.
- **Fate:** restyle.
- **Spec:** opening search (Mod+F or magnifier) inserts a 44 px bar under the Script header: Find field (with "3 of 12" count and ↑/↓), a toggle to show Replace (second field + "Replace" and "All" icon buttons), match-case toggle (Aa). Enter steps to the next hit, Shift+Enter to the previous one, Mod+Shift+Enter cuts all. Matches follow the backend: whole words, edge punctuation ignored, case folded, muted words skipped; cut words are also skipped here so Cut all does not repeat. Phrases spanning two turns are a W2 parity gap (design-system, Find bar element). Matches highlight in the text and as ticks on the overview strip. Two more verbs here anticipate the common case: "Cut all 12" (scissors) which creates 12 cuts as one undo step, and "Select all 12". Esc closes.
- **Shared elements used:** NEW: Overview strip ticks, Action bar verbs.
- **Story to build:** `Edit/FindBar` stories `Find`, `FindReplace`, `NoMatches`, `CutAll`, `Phone`.

### CMP-WORDBAR · Word timing bar

- **Today:** no shot (inspector region). Interaction cost: handles, numeric fields, Apply timing, Cancel draft, Preview, Reload timing.
- **Fate:** merge into the word Inspector sheet.
- **Spec:** Inspect on a word or word run shows a 120 px zoomed waveform of the word with one neighbor each side, start and end handles (drag), Start/End Scrub fields, and Hear. Changes save on release. No Apply or Cancel; Esc during a drag cancels.
- **Shared elements used:** Inspector sheet, NEW: Scrub field.
- **Story to build:** `Edit/InspectorSheet` story `WordTiming`.
- **Built (design-system element 9a, `System/InspectorSheet`):** the story `WordTiming` shows the frame with Start and End Scrub fields and Hear under a static waveform. The waveform and its two draggable handles are not built: the handles move with the fields only.

### CMP-WORDRANGE · Words-in-range controls

- **Today:** INS-WORD--desktop-light.png. Interaction cost: five large buttons (Add word before/after, Drop first/last, Ignore).
- **Fate:** replace with NEW: Selection handles.
- **Spec:** text selection shows 2 px accent caret handles at both ends with 12 px knobs (44 px touch hit). Drag to extend or shrink by word. Keyboard: Shift+←/→ extends by word; Alt+Shift+→ shrinks from the start and Alt+Shift+← grows it at the start (design-system 13). The handles are pointer-only and not tab stops. Ignore becomes Mute (More).
- **Story to build:** `Edit/ScriptPane` story `SelectionHandles`.

### CMP-EDITBOUNDARY · Edit boundary mark

- **Today:** DLG-PRECISION--desktop-light.png (red "¦" boxes in the text). Language: the glyph has no meaning without the Annotate mode. Consistency: called "boundary", "roll join", "trim edge".
- **Fate:** restyle as the text form of NEW: Seam.
- **Spec:** a cut inside the text renders as an 18 px tall pill inline: scissors glyph + removed length ("2.4 s"). Hover shows the cut words in a tooltip. Click selects the Seam: same action bar as on the timeline (Hear across, Keep, join type, Inspect). Drag the pill's left or right edge to roll the seam (readout chip shows ms). With the eye on, the pill is replaced by the struck words.
- **Shared elements used:** NEW: Seam, Action bar.
- **Story to build:** `Edit/Seam` stories `TextPill`, `TextPillHover`, `TextPillRolling`.

### DLG-PRECISION · Precision boundary dialog

- **Today:** DLG-PRECISION--desktop-light.png. Interaction cost: modal over the timeline with ±1/±10 ms buttons, a text field and Apply. Language: "Current source position / Current timeline seam / Proposed source position".
- **Fate:** merge into the Seam Inspector sheet.
- **Spec:** Seam inspector: Offset Scrub field (ms, drag 1 px = 1 ms, Shift 10 ms, Alt 0.1 ms), allowed range drawn as the field's track, A/B Hear before/after the change, join type and length. Applies live on release. No dialog.
- **Story to build:** `Edit/InspectorSheet` story `Seam`.
- **Built (design-system element 9a, `System/InspectorSheet`):** the story `Seam` has the Offset Scrub field (the track variant, 200 ms either way), the A/B Hear before and after, the join type and its length, each in a collapsible section. The allowed range is the field's track; Hear replaying after each change is the host's.

### Inspector

### SHEET-INSPECTOR · Inspector sheet (and CMP-SEEK-FOOTER)

- **Today:** SHEET-INSPECTOR--tablet-light.png, SHEET-PHONE-INSPECTOR-HALF/-FULL--phone-light.png, INS-CLIP--desktop-light.png. Interaction cost: every value has its own Apply button and four step buttons. Hierarchy: header carries Undo, Redo, Expand, Collapse and Close. Touch: phone sheet's grip is inert; "Expand" is a text link.
- **Fate:** replace with the shared Inspector sheet.
- **Spec:**
  - Opened by the action bar's Inspect (sliders), the I key, or double-click on an object. Never open by default on selection.
  - Desktop/tablet: a 320 px card anchored to the action bar, below or above it whichever has room, max height 60 % of the box it is placed in, scrolls inside. Header 40 px: object icon + name (rename inline where applicable) + close ✕. Body: rows of label (12 px secondary, left) and Scrub field (right). Sections collapse by heading.
  - Phone: the action dock (4 rem: 64 px at the default root size) is the sheet's first detent. Drag up to half (50 %) and full (92 %); drag down past the dock clears the selection. Working grip, 36 × 5 px with a 44 px hit. No Expand/Collapse buttons; tapping the grip toggles half/dock.
  - Values apply as they change (live preview), committing one undo step on release or Enter. No Apply buttons anywhere.
  - CMP-SEEK-FOOTER's Seek/Play/A-B buttons are removed from the footer; Hear and A/B live in the action bar at the top, always visible.
- **Shared elements used:** Inspector sheet, NEW: Scrub field, Action bar.
- **Story to build:** `Edit/InspectorSheet` stories `DesktopCard`, `TabletCard`, `PhoneDock`, `PhoneHalf`, `PhoneFull`, `LongContent`.
- **Built (design-system element 9a, `System/InspectorSheet`):** the stories are under `System/InspectorSheet`, not `Edit/InspectorSheet`, with the names above plus `WordTiming`, `Seam`, `Range` and `Closing`. The card takes an `anchor` rect and `bounds` as data and does not read the action bar; the phone sheet takes the host's dock as a slot. The header and sections sit under the dock and are inert at the dock detent. The grip's hit area (44 by 44 px) reaches 36 px above the sheet and 8 px into it. Letting go more than 24 px below the dock, or flicking down from the dock, calls `onDismiss` and the host clears the selection; a flick down from half or full lands on the dock. The demo bodies (Clip, Track, Range, Word timing and Seam sections, used by the stories above) are built on the existing Scrub field, Time field and A/B audition and wired to nothing; there are no separate `ClipReadOnly` or `ClipPhone` stories; the wiring is partly built (W3a, #2294): `stage/edit/InspectorHost.tsx` mounts the card on the desktop and the tablet, anchored beside the selection (hidden, state kept, while the anchor is out of view), and the phone sheet with the Edit action bar as its dock, without Inspect among its verbs. The open state is still `inspectorKey` (I, `edit.inspect`, a double-click); the host moves focus into the first control on open, or onto the dialog's focus anchor (`[data-inspector-anchor]`, a zero-size element inside the dialog) when that control takes text, or when the body has no focusable control (the keymap ignores a typing target, so a field would swallow the shortcuts), and returns it to the opener on Esc, Close, a new selection and the phone dismiss. Each kind's body is still the legacy one, bridged as one section of the frame; the phone keeps its peek strip for timeline targets, and a range armed with Select range still opens the sheet. What remains: the per-kind content (W3b), the compact Decision card for a suggestion or a comment (W3b2), and the legacy bodies, the peek strip and their CSS, stories and e2e rows (W3c; the envelope point is built, W3c1).

### SHEET-PHONE-INSPECTOR and INS-PEEK · Phone compact inspector and peek

- **Today:** INS-PEEK--phone-light.png, SHEET-PHONE-INSPECTOR--phone-light.png. Hierarchy: the peek shows "reference clip" and a time range, but no actions. Interaction cost: undo, redo and expand icons in a peek strip.
- **Fate:** merge into the phone action dock (dock detent of the Inspector sheet).
- **Spec:** action dock 64 px above the player bar: object icon + short name on the left (max 96 px), then up to 5 verb buttons 48 px with icon over 10 px label (labels shown on phone because they are small and help first use; icons alone must still read), then More. Swipe up for inspector content.
- **Story to build:** `Edit/ActionBar` stories `PhoneDockClip`, `PhoneDockWords`, `PhoneDockSuggestion`, `PhoneDockPlayhead`.

### INS-EMPTY · Nothing selected

- **Today:** INS-EMPTY--desktop-light.png. Purpose: an empty column or a heading with an unmapped-edits list.
- **Fate:** remove. No inspector without a selection. Unmapped pending edits move to Review.
- **Built (W1b, #2294):** `inspector/views/EmptyInspector*` is deleted; the Inspector opens only on Inspect for a selection. Unmapped pending edits stay in the Review queue (`review/ReviewQueue.tsx`).
- **Story to build:** none.

### INS-CLIP · Clip inspector

- **Today:** INS-CLIP--desktop-light.png, --phone-light.png, SHEET-PHONE-INSPECTOR-FULL--phone-light.png. Interaction cost: four Apply buttons and sixteen step buttons. Language: "Source start 0", "Inspect automatic audio reduction". Hierarchy: Move clip is a full-width button above the timing.
- **Fate:** restyle.
- **Spec:** header: clip icon + track avatar + "Maya · 12:04 to 12:23". Rows: Start, End, Length (Scrub fields, timeline time, mono); Source in (Scrub field with a 40 px source mini-map showing used portion); Fade in, Fade out (Scrub fields with a curve-shape picker: linear, equal-power, S); Gain (dB Scrub field); Track (row of track avatars, tap to move the clip to that track at the same time); Auto reduction (toggle + "Show regions" which reveals OVL-BLEED). Delete lives on the action bar (Cut / Backspace).
- **Story to build:** `Edit/InspectorSheet` stories `Clip`, `ClipPhone`, `ClipReadOnly`.

### INS-CLIP-MULTI · Several clips

- **Today:** INS-CLIP-MULTI--desktop-light.png. Feedback: shows the first clip's form only; no sign that several are selected.
- **Fate:** restyle.
- **Spec:** header "3 clips" with stacked track avatars. Rows: Fade in, Fade out, Gain (relative, shows "Mixed" until changed; scrub applies the delta to all). Action bar verbs apply to all selected.
- **Story to build:** `Edit/InspectorSheet` story `MultiClip`.

### INS-PENDING · Suggestion inspector (in Edit)

- **Today:** INS-PENDING--desktop-light.png, --phone-light.png. Interaction cost: Approve/Reject plus two source fields with eight step buttons, "Apply timing" and "Snap to silence". Language: "Review required", "Boundary inaudible".
- **Fate:** restyle; full decision flow is the Review stage (spec-review).
- **Spec:** header: kind glyph + "Filler · Jon · 0.8 s". Rows: Why (one sentence from the suggester), Start and End Scrub fields with snap-to-silence as the default behavior (Alt disables while dragging), Confidence as a 5-dot meter. Verbs on the action bar (Hear A/B, Cut, Keep). After Cut or Keep, the sheet follows the selection to the next suggestion.
- **Built (#2294 W3b2b steps 1 and 2a):** a pending edit, and a comment linked to a still-pending edit, open as an Inspector sheet section (`stage/edit/pendingSections.tsx`, `PendingEditBody.tsx`). The header is a kind line from `system/decisionKinds.ts` (glyph, kind, track, length) with a Why row. Start and End are Scrub fields (`Source start`, `Source end`) that save once per commit (Enter, blur, arrow key or drag end); Snap to silence is a row. Where the Action bar offers Cut (the suggestion has a cut, shorten or lower action) the sheet drops its own verb buttons and the bar's Cut and Keep reach the open sheet, so its queued-timing lock, Still sending notice and refine recovery still apply. A split, an exact range proposal, a suggestion with no accept action and the phone peek sheet keep Approve and Reject in the sheet. Start and End accept seconds or m:ss.mmm. The nudge buttons and Apply timing are gone; a split keeps its Cut time field and Apply. The timeline overlay bar keeps Approve and Reject until step 2b. Hear A/B on the Action bar, the preview footer removal, Suggested bounds restyle and the Ask thread on the system comment card are steps 2b and 2c. Story `System/InspectorSheet` `Suggestion` is a static demo.
- **Story to build:** `Edit/InspectorSheet` stories `Suggestion`, `SuggestionLowConfidence`.

### INS-APPLIED · Applied edit

- **Today:** not reached. Purpose: inspect and restore an applied cut.
- **Fate:** merge into the Seam inspector (cut seam): "2.4 s cut · filler · applied by cleanup 12 min ago", Keep restores.
- **Story to build:** `Edit/InspectorSheet` story `CutSeam`.

### INS-TRACK · Track inspector

- **Today:** INS-TRACK--desktop-light.png, --phone-light.png. Language: "Staging gain… Balance not measured", "Clear clip light". Interaction cost: Show and Edit volume envelope as two buttons; Track actions in a sub-menu; Remove track with a confirm dialog.
- **Fate:** restyle.
- **Spec:** header: avatar + name (inline rename). Rows: Person (speaker picker: avatars), Kind (segmented icons: voice, music, other), Level (Scrub field), Mute/Solo toggles, Effects (list rows with on/off toggles), Volume envelope (toggle shows it on the lane), Split speakers (only when the track holds more than one voice; opens DLG-SPLIT owned by spec-prepare), Replace audio. Remove is the action bar's trash verb; it removes at once with an Undo toast (no confirm, since Undo restores it).
- **Story to build:** `Edit/InspectorSheet` stories `Track`, `TrackMusic`, `TrackPhone`.

### INS-CHAPTER · Chapter

- **Today:** INS-CHAPTER--desktop-light.png. Interaction cost: Title field and Time field with Apply.
- **Fate:** restyle; editing is direct on the marker.
- **Spec:** select chapter: action bar Hear (from here), Fix text (rename inline on the marker), Remove. Inspect: Title field, Time Scrub field. Dragging the flag moves it.
- **Story to build:** `Edit/InspectorSheet` story `Chapter`.

### INS-SOCIAL · Social clip

- **Today:** INS-SOCIAL--desktop-light.png. Interaction cost: two time fields and Apply. Language: "Score 0.77", "Approved no", "Review required".
- **Fate:** restyle; export of clips is in Deliver.
- **Spec:** action bar: Hear, Fix text (title), Comment, Remove. Inspect: Title, Start/End Scrub fields, Quality as a 5-dot meter. Bracket edges drag on the marker lane.
- **Story to build:** `Edit/InspectorSheet` story `SocialClip`.

### INS-COMMENT · Comment

- **Today:** INS-COMMENT--desktop-light.png, --phone-light.png. Hierarchy: comment body sits below Time, Author, Status and Tracks metadata. Interaction cost: Resolve is a large red primary.
- **Fate:** replace with a comment popover in place (thread UI owned by spec-review; same component).
- **Spec:** clicking a comment pin opens a 320 px popover anchored to it: author avatar + name + relative time, body, replies, reply field (Enter sends), resolve check icon in the header. Edit shows it in place; Review shows it in the queue. Same component.
- **Story to build:** `Edit/CommentPopover` stories `Open`, `WithReplies`, `Resolved`, `Phone`.
- **Built (#2294 W3b2a):** a bare comment opens as Inspector sheet sections (`stage/edit/commentSections.tsx`, story `System/InspectorSheet` `Comment`): Time (seek), author, status, tracks, body, action items, replies, Reply and Resolve or Reopen. The 320 px popover form with the header resolve check and Enter-to-send is not built; a comment with a linked pending edit opens the pending sheet section (W3b2b).

### INS-WORD · Words

- **Today:** INS-WORD--desktop-light.png, --phone-light.png. Hierarchy: Range actions and words-in-range buttons fill 150 px above the timeline; on phone the sheet covers the text being edited.
- **Fate:** restyle.
- **Spec:** action bar above the words, clear of the Script header. If it would cover that header, move the whole bar beside or above the header within the Edit content area. Flip below only when the whole bar cannot fit above or beside. Order: Hear, Keep when available, Split, Comment, Fix text for one word, Re-record for the host, More, Inspect, then Cut as the trailing primary. Split cuts both selected-word edges in one undo step. More offers Mute or the host's contextual Restore ignored words, Move to speaker and Copy. Inspect: text, confidence meter, timing (CMP-WORDBAR content). On phone the dock leaves the selected line visible by scrolling the text so the selection sits above the dock; Fix text folds into More ahead of Record when space is short.
- **Story to build:** `Edit/InspectorSheet` story `Words`; `Edit/ActionBar` story `Words`.

### INS-RANGE · Range

- **Today:** INS-RANGE--desktop-light.png, --phone-light.png. Language: "27.79–60.00 s · reference". Hierarchy: disabled Fill room tone with explanation.
- **Fate:** restyle (see CMP-RANGE-ACTIONS). Inspect: In, Out, Length Scrub fields; Scope track toggles.
- **Story to build:** `Edit/InspectorSheet` story `Range`.

### INS-ENVELOPE · Volume envelope workspace

- **Today:** INS-ENVELOPE--desktop-light.png. Interaction cost: Done, Show, "Select a point" dropdown, Add point.
- **Fate:** merge into OVL-ENVELOPE direct editing plus point Inspect (Time, Level).
- **Story to build:** `Edit/InspectorSheet` story `EnvelopePoint`.
- **Built (#2294 W3c1):** the workspace is gone. A selected envelope point opens **Time** and **Level** (seconds and ×, kept from what shipped; the dB values in OVL-ENVELOPE are not built) as Scrub fields in the Inspector (`stage/edit/envelopePointSections.tsx`, story `System/InspectorSheet` `EnvelopePoint`), each gesture one save and one undo step through `setEnvelopePoint` in `commands/envelopes.ts`; **Remove** and Delete or Backspace share `removeEnvelopePoint`. A failed save stays in the sheet as an alert (**Reload points** on a stale baseline, **Select the point there** for a taken time). The track-level `envelope` selection opens the track's sheet, whose Show and Hide button stays; Add point is the lane's create menu. The phone still shows the peek strip for a lane point and its fields in the drawer until the strip goes (W3c2).

### INS-BLEED · Automatic reduction

- **Today:** INS-BLEED--desktop-light-story.png. Language: technical terms ("attenuation", "evidence").
- **Fate:** keep content, restyle into an Inspector sheet section opened from the clip's Auto reduction row; region verbs Hear A/B and Keep.
- **Story to build:** `Edit/InspectorSheet` story `AutoReduction` (reuse the existing state set: Loading, Empty, FailedLoad, Saving, Guest).

### Palette, gestures, feedback

### DLG-PALETTE · Commands and shortcuts

- **Today:** DLG-PALETTE--desktop-light.png, --phone-light.png. Hierarchy: a help sentence and a "Show remaps" checkbox above the results. Language: "K alone stops playback; Mod+K splits at the playhead".
- **Fate:** keep, restyle.
- **Spec:** opened by the header magnifier, /, ? or Mod+Shift+P. 560 px centered card at 20 % from the top (phone: full-height sheet, search field at the top with the keyboard up). Search field first; below it "Recent" (5) when empty, else ranked results. Rows 36 px: verb icon, name, context ("in Edit"), key caps right. Enter runs; Tab shows the row's key so it can be remapped. Results include stages, projects, people, speakers and chapters ("Go to Chapter: Intro"). Gestures are a result group ("Gestures") on touch devices.
- **Story to build:** `Shell/Palette` stories `Empty`, `Search`, `NoMatch`, `Remap`, `Phone`.

### DLG-GESTURES · Gestures cheatsheet

- **Today:** DLG-GESTURES--phone-light.png. Language: a paragraph about Move clip that reads as documentation. Purpose: teaches gestures after the fact.
- **Fate:** remove as a dialog. Replaced by NEW: Coach tips at first use (one per gesture, once) and the palette's Gestures group.
- **Spec (coach tips):** after the first tap on a clip on touch: "Drag the edges to trim" pointing at the handle; first text selection on touch: "Drag the handles to adjust"; first undo need (after the first Cut): "Two-finger tap to undo". 1 line, 240 px max, dismiss on any action, never repeats.
- **Story to build:** `Shell/CoachTip` stories `TrimHint`, `UndoHint`.

### TOAST-MAIN · Feedback toast

- **Today:** no shot of my own; Toast stories exist. Feedback: toasts dock above sheets and rails in different places per device.
- **Fate:** restyle.
- **Spec:** one position: centered, 12 px above the player bar (phone: above the action dock if open). Max 480 px, 44 px tall, one line: icon + past-tense result + up to one action ("Undo" for every edit, or the next step such as "Review"). 5 s, paused on hover. A new toast replaces the old one; consecutive same-kind edits merge ("3 cuts · Undo all").
- **Shared elements used:** TOAST.
- **Story to build:** `Shell/Toast` stories `Cut`, `MergedCuts`, `NextStep`, `Error`, `Phone`, `AboveDock`.

### EMPTY-STATES · Empty states in this area

- **Fate:** restyle to one pattern: 48 px icon, one line of plain text, one primary button. Instances: Edit with no tracks (SCR-SHELL-INGEST), Script with no transcript ("Transcribe this episode"), Find with no matches ("No matches"), Mix sheet with no tracks (not reachable; sheet hidden).
- **Story to build:** `Shell/EmptyState` stories `NoTracks`, `NoTranscript`, `NoMatches`.

### DLG-ASK-CONFIRM · Confirms in Edit

- **Today:** DLG-ASK-CONFIRM--phone-light.png ("Remove the reference track?"). Feedback: confirm for an undoable action. Touch: Split no longer asks; the toast carries Undo.
- **Fate:** remove both Edit confirms (Remove track, touch blade). Undo toast instead. Confirms stay only for actions Undo can't reverse (none in Edit).
- **Story to build:** none for Edit.

### Phone screens

### SCR-PHONE-LISTEN · Listen

- **Today:** SCR-PHONE-LISTEN--phone-light.png, MENU-MAIN--phone-light.png. Hierarchy: a dark card on a light page holds the title and hamburger. Hierarchy: −15s/+15s are as large as play. Language: "1 pending edit" underlined link, the activity log box.
- **Fate:** replace with the Player bar and NEW: Player sheet.
- **Spec:** swipe up on the player bar (or tap its time) opens the Player sheet at full height: episode title, chapter name at the playhead, a 64 px whole-episode waveform scrubber with chapter ticks and comment dots, timecode, transport (back 15, play 72 px, forward 15), Hear original hold button, a "Comment at 12:04" button that opens a one-line composer at the bottom, and the chapter list below. Swipe down to close. Status (pending edits, jobs) shows as stage badges, not here.
- **Shared elements used:** NEW: Player bar, NEW: Player sheet, A/B audition.
- **Story to build:** `Shell/PlayerSheet` stories `Paused`, `Playing`, `Commenting`, `Chapters`, `Guest`.

### SCR-PHONE-TIMELINE · Phone timeline

- **Today:** SCR-PHONE-TIMELINE--phone-light.png. Hierarchy: 700 px of grey below two lanes. Touch: tool row (select/blade, range, zoom ±, undo, redo) sits above the nav. Language: lanes show a circle "R" and an unlabeled slider.
- **Fate:** replace with Edit stage, waveform surface.
- **Spec (390 × 844):**
  - Header 44 px: title (truncates), save dot, Undo, Redo, avatars, search.
  - Edit sub-bar 44 px: surface switch segmented (waveform icon / text icon, 2 × 56 px) centered; left: scope of zoom "Fit" icon; right: mixer icon (Mix sheet) and eye.
  - Overview strip 16 px, ruler 24 px, marker lane 24 px.
  - Lanes fill the remaining height (2 tracks: about 230 px each), header column 56 px.
  - Fixed playhead at center. Swipe pans and scrubs (audio while finger moves slowly, under 1× speed).
  - With nothing selected the action dock shows playhead verbs: Split here, Comment here, Add chapter; this replaces Blade on phone.
  - Player bar 56 px, stage tabs 56 px + safe area.
- **Touch:** tap clip selects; drag selected clip edges trims; drag fade knobs; long-press then drag on a lane selects a range; pinch zooms; two-finger tap undoes; three-finger swipe left/right undo/redo.
- **Story to build:** `Edit/PhoneEdit` stories `Wave`, `WaveClipSelected`, `WaveRange`, `WaveDeepZoom`, `WaveNothingSelected`.

### SCR-PHONE-TEXT · Phone text

- **Today:** SCR-PHONE-TEXT--phone-light.png, INS-WORD--phone-light.png. Touch: mode buttons wrap to two rows and the help sentence takes three lines; the inspector sheet covers the text being edited. Hierarchy: words are spaced like buttons.
- **Fate:** replace with Edit stage, text surface.
- **Spec:** same header, sub-bar and player. Script pane full width, text 17/28, speaker shown as a 20 px avatar + name above each turn. Tap a word: caret + seek. Long-press a word: selects it with Selection handles; drag handles to extend. Double-tap: Fix text. Action dock: Hear, Cut, Fix, Comment, More. The text auto-scrolls so the selection stays visible above the dock. Find opens from the eye/search in the sub-bar right.
- **Story to build:** `Edit/PhoneEdit` stories `Text`, `TextSelected`, `TextFixing`, `TextWithCuts`, `TextFind`.

### SCR-PHONE-MORE and SCR-PHONE-MORE-PANEL · More hub

- **Today:** SCR-PHONE-MORE--phone-light.png, SCR-PHONE-MORE-PANEL--phone-light.png. Purpose: catch-all of panels, buttons, nine checkboxes and Gestures. Interaction cost: two taps plus "← More" back to reach anything.
- **Fate:** remove.

| More item | New home |
|---|---|
| Command search | Header magnifier |
| Mix | Edit sub-bar mixer icon |
| Comments | Review stage |
| History | Long-press Undo in the header |
| Impact | Review stage summary |
| Tighten | Review stage (suggestions) and Prepare (run detection) |
| Pipeline | Prepare stage |
| Import audio, New track | Prepare; "+" under the track column in Edit |
| Layers | Eye popover in the Edit sub-bar |
| Add chapter at playhead | Playhead verbs in the action dock |
| Gestures | Coach tips; palette Gestures group |
| Home-screen hint | Project menu, once, on iOS Safari |
| People | Header avatars |

- **Story to build:** none.

### Interactions

Each interaction uses the object selection model above. Every edit is one undo step and posts a toast with Undo.

### INT-PLAY · Play, pause, stop, seek

- **Today:** SCR-SHELL-DESKTOP shots. Hierarchy: Stop is as big as Play. Consistency: phone uses ±15 s, desktop has none.
- **Fate:** restyle.
- **Spec:** Space play/pause (any focus except text fields and the Fix text field); K pauses and returns to the play start; J/L shuttle; click ruler or word seeks; ← → 1 s (Shift 5 s); Home/End. Playback always follows the playhead in the timeline and the Script while Follow is on.
- **Story to build:** `Shell/PlayerBar` (states).

### INT-AUDITION · Audition mode

- **Today:** CMP-TRANSPORT shots. Language: "Full mix / Edited stems / Original".
- **Fate:** replace with Hear original (hold A or the A/B button) and A/B on any change.
- **Spec:** hold A with nothing selected: hear original at the playhead (not built yet; W2); release returns. A and B on a selected suggestion or seam: hear before / after with 1.5 s pre-roll.
- **Story to build:** `Shell/PlayerBar` story `HearOriginalHeld`.

### INT-SCRUB · Scrub

- **Today:** no continuous scrub on desktop ruler drag (editor-interactions.md).
- **Fate:** new behavior.
- **Spec:** drag on ruler or the playhead triangle scrubs with audio; phone swipe scrubs under the fixed playhead. Scrub audio off when the pointer moves faster than 4× real time (silent pan).
- **Story to build:** `Edit/Ruler` story `Scrubbing`.

### INT-SELECT · Select

- **Today:** INS-CLIP, INS-CLIP-MULTI shots. Feedback: the selected clip shows a thin red outline; the inspector column then reflows the timeline.
- **Fate:** restyle.
- **Spec:** click selects one object and shows its action bar; Shift-click extends to a contiguous run (clips on one lane, words); Mod-click toggles; Esc clears; click empty space clears. Selecting never reflows layout (inspector is a floating card). Mod+A selects all clips on the targeted track. In the Script, Mod+A selects all words (the whole episode as one range).
- **Story to build:** covered by `Edit/ActionBar` stories.

### INT-MOVE · Move clip

- **Today:** INS-CLIP--desktop-light.png ("Move clip" button). Interaction cost: a form for a drag.
- **Fate:** restyle.
- **Spec:** drag the clip body; ghost on destination lane; snapping to seams, playhead, word boundaries and other clip edges within 8 px (snap lines draw only during drag); Shift locks time (lane change only); Alt disables snapping; Esc cancels. Touch: select first, then drag the body. Exact time via Inspect Start.
- **Story to build:** `Edit/Clip` story `Moving`.

### INT-TRIM · Trim

- **Today:** storied TrimPreview. Direct manipulation: handles invisible until hovered.
- **Fate:** restyle per CMP-CLIP.
- **Spec:** drag edge; readout chip shows delta and new time; ←/→ on a focused handle 10 ms (Shift 100 ms); trimming a dialogue clip offers snap to word boundaries (magnet). Anticipation: after trimming an edge, the action bar shows Hear (plays 2 s across the new edge) as its first verb.
- **Story to build:** `Edit/Clip` story `Trimming`.

### INT-SPLIT · Split and blade

- **Today:** CMP-TOOLRAIL shots; touch blade asked for confirmation (removed in #2294).
- **Fate:** restyle.
- **Spec:** Mod+K splits at the playhead on the targeted tracks (scope chip; default all); Alt-click at the pointer splits at that time on the same targeted tracks (W1a; no Blade tool). Phone: Split here in the playhead dock. No confirm. After a split, the right-hand piece is selected (anticipating trim, move or Cut).
- **Story to build:** `Edit/PhoneEdit` story `WaveNothingSelected`.

### INT-DELETE and INT-RIPPLE · Delete and ripple

- **Today:** INS-CLIP shots (no visible delete), shortcuts.md.
- **Fate:** restyle under the Cut verb.
- **Spec:** Cut on words or an all-track range removes the time on all tracks (ripple, keeps speakers in sync). Cut on a range scoped to fewer tracks lifts the audio and leaves silence (time kept); the scope chip shows a gap glyph instead of the ripple glyph so the outcome is visible before you act. Cut on a clip (Backspace) removes the clip and leaves a gap; Mod+Backspace removes it and closes the gap on that track. Each posts "Cut 2.4 s · Undo".
- **Story to build:** `Edit/ActionBar` stories `RangeScopeOneTrack`, `ClipRippleHint`.

### INT-RANGE · Range select and act

- **Today:** INS-RANGE shots.
- **Fate:** restyle.
- **Spec:** drag on empty lane area (desktop) or long-press-drag (touch); range covers the lanes the drag crosses, Alt-drag limits to one lane; drag edges to adjust; Shift+←/→ moves the edge nearest the playhead by 100 ms. Anticipation: after a range Cut, the playhead parks 2 s before the new seam and Shift+Space hears the seam; Z zooms to the selection.
- **Story to build:** `Edit/Range` stories.

### INT-FADE and INT-JOIN, INT-ROLL · Fades, crossfades, joins, rolls

- **Today:** POP-JOIN--desktop-light.png, DLG-PRECISION--desktop-light.png.
- **Fate:** restyle via CMP-CLIP fade knobs and the Seam.
- **Spec:** drag a fade knob horizontally; detents at 10, 50, 200 ms; Alt fine. Drag a Seam diamond left or right to roll the seam; Alt fine; readout chip. Join type in the Seam action bar. Every change on a seam replays it once automatically if the Seam inspector is open.
- **Story to build:** `Edit/Seam`, `Edit/Clip` stories `FadeDrag`.

### INT-WORD-SELECT, INT-WORD-CUT, INT-WORD-CORRECT, INT-WORD-TIMING · Words

- **Today:** INS-WORD, POP-WORD-EDIT shots. Interaction cost: a mode switch (Select or Correct) before any word action. Language: "Mod+X cuts their audio… Ignore strikes through and mutes the selection at render, non-destructively".
- **Fate:** restyle; modes removed.
- **Spec:**
  - Select: per PNL-TRANSCRIPT grammar.
  - Cut: Backspace or the Cut verb. After a cut the caret sits at the seam and two next actions are one key away: Tab selects the next occurrence of the same words (or the next suggestion when the cut matched a suggestion kind such as a filler), so Tab, Backspace, Tab, Backspace clears every "you know"; Shift+Space hears the new seam. The toast says "Cut "you know" · 6 more · Cut all" when more occurrences exist (anticipation in one click).
  - Correct: Fix text per POP-WORD-EDIT.
  - Timing: Inspect (CMP-WORDBAR).
- **Story to build:** `Edit/ScriptPane` stories `WordsSelected`, `AfterCutNextOccurrence`, `FixTextOpen`.

### INT-WORD-IGNORE, INT-LOWCONF, INT-FINDREPLACE, INT-SPEAKER · Text utilities

- **Fate:** Ignore becomes Mute (More menu; muted words greyed with a speaker-slash glyph). Low-confidence stepping becomes the "? 3" chip and Alt+↓ / Alt+↑; Tab from a Fix text field goes to the next one. Find per CMP-FINDREPLACE. Speaker per POP-SPEAKER.
- **Story to build:** `Edit/ScriptPane` stories `LowConfidence`, `MutedWords`.

### INT-MUTE-SOLO, INT-FADER, INT-REORDER · Track controls

- **Fate:** per CMP-TRACK-HEADERS. Reorder by dragging the header (Shift+↑/↓ keyboard). Phone: drag the avatar in the Mix sheet.
- **Story to build:** `System/TrackHeader` stories.

### INT-ZOOM, INT-PINCH, INT-PAN · Zoom and pan

- **Today:** CMP-TRANSPORT zoom buttons, View menu.
- **Fate:** restyle via the corner cluster.
- **Spec:** = / - zoom at playhead; \ fit; Z zoom to selection; Mod+wheel or pinch zooms at the pointer/fingers; wheel scrolls lanes vertically, Shift+wheel or horizontal trackpad pans; Shift+scroll over a lane with Alt held changes waveform amplitude; vertical pinch on touch changes amplitude. Double-click the ruler fits.
- **Story to build:** `Edit/CornerControls` stories.

### INT-LAYERS and INT-LAYOUT

- **Fate:** layers per MENU-VIEW eye popover; layouts removed (T, Shift+T, divider).
- **Story to build:** covered above.

### INT-CLIPBOARD · Copy, cut, paste

- **Fate:** keep, extend to words.
- **Spec:** Mod+C copies the selection (clips, range or words as audio with transcript); Mod+X is Cut plus copy; Mod+V inserts at the playhead on the scoped tracks, ripple on all-track scope; on phone, Paste appears in the playhead dock when the clipboard holds audio. Toast "Pasted 2.4 s · Undo".
- **Story to build:** `Edit/ActionBar` story `PlayheadWithPaste`.

### INT-IMPORT · Import by drop

- **Today:** SCR-SHELL-INGEST shots.
- **Fate:** restyle with NEW: Drop overlay.
- **Spec:** dragging files over the window shows a full-window overlay with two targets: "New tracks" (default, the whole overlay) and, when hovering a lane, "Add to Maya's track" (that lane highlights). Drop imports; replacing audio on a track with audio is a separate track action (Replace audio) and is undoable.
- **Story to build:** `Edit/DropOverlay` stories `NewTracks`, `OntoLane`.

### INT-CREATE, INT-TOUCH-CHOOSE, INT-INSPECT-LONGPRESS

- **Fate:** Create per MENU-CREATE. Chooser per POP-CHOOSER. Long-press on an object selects it (same as tap) and, if ambiguous, opens the chooser; long-press no longer opens the inspector directly (Inspect is a verb).
- **Story to build:** covered above.

### INT-PALETTE · Palette

- **Fate:** per DLG-PALETTE.

### INT-UNDO · Undo and redo

- **Today:** CMP-TOOLRAIL, phone inspector header (Undo, Redo inside the sheet).
- **Fate:** restyle.
- **Spec:** header Undo/Redo icons on every stage and device; Mod+Z / Mod+Shift+Z; two-finger tap; three-finger swipe. Long-press or right-click Undo opens the History popover (steps with plain names "Cut "you know"", time ago; click restores to that point). Every toast has Undo.
- **Story to build:** `Shell/History` stories `Popover`, `Phone`.

### INT-ENVELOPE, INT-PENDING-EDGE, INT-FOLLOW

- **Fate:** envelope per OVL-ENVELOPE; pending edges per OVL-PENDING; follow per MENU-PEOPLE.

---

## 3. Shared vocabulary proposals

Existing vocabulary used: Stage bar (spec'd here), Transport (as Player bar), Object selection model and its action bar, Suggestion, Inspector sheet, A/B audition, Person tile, Icon language.

**NEW: App header.** 48 px (44 px phone) top bar on every stage. Left: Project menu button (symbol + title) and Save indicator; Undo/Redo; center (desktop/tablet): Stage bar; right: presence avatars, Invite, Search. No other controls. Reused by every stage.

**NEW: Project menu.** Popover from the title: recent projects, Open, New, Project settings, Connect agent, Appearance, Help and feedback, Shortcuts. The only menu in the shell.

**NEW: Player bar.** The single transport, 56 px at the bottom of every stage on every device: time and edited length with cut delta, back / Play (only filled control) / forward, Hear original (hold), solo chip, mix ring. Swipe up on phone opens the Player sheet. Reused by Edit, Review, Deliver and Prepare; Record replaces it with its own record control while live (spec-record decides).

**NEW: Player sheet.** Phone full-height listening view opened from the Player bar: big transport, whole-episode scrubber with chapters and comments, comment-at-time composer, chapter list. Replaces Listen.

**NEW: Action bar** (the concrete form of the object selection model). Desktop/tablet: a 40 px (44 px touch) pill floating beside the selected object, horizontally centered on its visible part: below it by default so the ruler stays uncovered, above a selected word so the next line of the Script stays clickable, and on the other side when there is no room; never covers the selection. Anatomy: optional Scope chip, verbs in fixed order (Hear, Cut, Keep, Split, Comment, Fix text, Remove), More (ellipsis), Inspect (sliders). Icons only with tooltip (name + key). Phone: the 64 px action dock above the Player bar with icon over a small label; it is also the Inspector sheet's first detent. With nothing selected, it shows playhead verbs (phone always; desktop on Create here). Reused in Edit, Review (suggestion verbs), Deliver (social clips).

**NEW: Scope chip.** Leftmost element of the action bar for ranges, words and Split: stacked track-color dots for affected tracks ("All" when all) and a glyph for the outcome (ripple arrows = time closes; gap bracket = time kept). Click opens track toggles. Replaces lane checkboxes and ripple modifiers.

**NEW: Scrub field.** Numeric value with unit in Plex Mono. Drag horizontally to change (1 px = 1 unit step; Shift ×10; Alt ×0.1), click to type, ↑/↓ step, Enter commits, Esc reverts. Live preview on the canvas; one undo step per gesture. Optional track (shows allowed range) and level variant (bar). Used in every Inspector sheet, the track level bar, the Mix sheet, the eye popover, Deliver loudness target.

**NEW: Seam.** The one object for a boundary between two pieces of audio: a split, a join, an applied cut. Timeline: 6 px diamond on the lane's top edge (filled = cut, hollow = split). Script: inline pill with scissors + removed length. Verbs: Hear across, Keep (cuts only), join type, Comment, Inspect (offset, join length, A/B). Replaces join markers, edit boundary marks, edit marker glyphs, applied ticks and the Precision dialog.

**NEW: Script pane.** The transcript as a document: speaker margin, 68-character measure, no modes, one selection grammar shared with the timeline. Reused read-only in Review (context around a suggestion) and in Deliver (captions preview).

**NEW: Edit surface switch.** Phone-only 2-segment icon control (waveform / text lines) at the top of Edit. Remembers the last choice; selection carries across.

**NEW: Overview strip.** 16 px whole-episode miniature with playhead, viewport rectangle (drag to pan), selection band, and ticks for suggestions (suggestion token), comments and find matches. Shown on phone and in Script focus; reused in Review as its progress map.

**NEW: Marker lane.** One 24 px lane for chapters (flag), comments (bubble pin), social clips (bracket span). Replaces three unlabeled rows.

**NEW: Corner zoom cluster.** Floating pill at the timeline's bottom-right: Fit, zoom out, zoom in, eye (view popover).

**NEW: Readout chip.** 22 px chip above the pointer during any drag: delta and resulting value. Used for trim, fade, move, roll, envelope, level, marker drag.

**NEW: Selection handles.** iOS-style caret handles at both ends of a text selection, draggable by word. Used in the Script pane and Review text.

**NEW: Drop overlay.** Full-window overlay while dragging files: "New tracks" or "Add to <name>'s track". Reused in Prepare.

**NEW: Invite popover.** Role segmented (listen, comment, edit) + Copy link + who has it. Same component as Deliver's share card.

**NEW: Coach tip.** One-line hint anchored to an element, shown once at the first moment it is needed, dismissed by any action. Replaces permanent help text and the Gestures dialog.

**NEW verb: Remove (trash).** Deletes a non-audio object (marker, comment, track, envelope point). Keeps "Cut" reserved for removing audio. Proposed addition to the shared verb list.

**Icon language proposals (coordinate with all specs):** Cut = scissors; Split = blade (vertical blade glyph), so the Split verb and the Alt-click guide share it; Keep = restore arrow; Hear = speaker-wave; Comment = speech bubble; Fix text = text cursor; Remove = trash; Mute = speaker-slash; Solo = headphones; Inspect = sliders; Hear original = A/B.

**Keyboard map changes** (from ux/pages/shortcuts.md): Mod+1..5 now switch stages (were layouts). The Blade tool is removed (W1a): C is Comment (W1b), V is unbound, and B is Hear after. S is Split and Solo is Shift+S. / opens the palette (? kept). Shift+Space hears the selection. X is Keep. Enter applies a selected suggestion. Tab after a cut selects the next occurrence. I opens Inspect. T toggles the Script pane; Shift+T Script focus. Z zooms to selection. J/L shuttle. Hold-A hear-original is not built yet (A is Hear before on a suggestion). Shift+C adds a chapter at the playhead. Mod+K stays Split at playhead; K stays pause.

---

## 4. Open product questions for Caleb

1. **Cut scope for text.** Should cutting words always remove that time from every track (keeps everyone in sync), with one-track cuts leaving silence? Recommended default: yes.
2. **Suggestions inside Edit.** Show suggestions inline in Edit (hatched, decidable in place) as well as in Review? Recommended default: yes, so Edit never hides pending work; Review stays the fast queue.
3. **Transport at the bottom on desktop.** One Player bar at the bottom on every device (matches phone, Descript, music apps) rather than a top transport like Logic. Recommended default: bottom.
4. **Audition modes.** Drop the "Full mix / Edited stems / Original" switch for hold-to-hear-original, with "edited stems" in the player's long-press menu? Recommended default: yes.
5. **Phone tab bar with five stages.** Keep all five (Prepare included) on phone for one model across devices? Recommended default: yes; Prepare on phone mostly shows job progress and import.
6. **Key changes.** Move Blade from C to B and make C Comment; Mod+1..5 for stages. Recommended default: yes (breaks muscle memory for current testers only).
7. **Fixing words.** Fix text corrects transcript text only and never synthesizes audio. Recommended default: yes; no voice regeneration. Decided 2026-10-28: typing never starts a correction, because every letter is a shortcut; Fix text starts on Enter, F2, or a double-click or double-tap on a word (design-system element 14, D-script-gestures).
8. **Drag words to reorder audio.** Not in this round. Recommended default: defer.
9. **Recordings in Edit.** "+" under the tracks offers "Record a take", which opens Record set to add a new session to this project (initial vs later sessions is spec-record's call). Recommended default: yes.
