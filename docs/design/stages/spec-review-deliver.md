> **Reconciled by design-system.md** (that file wins where they differ). Terms changed here:
> - Stage order: Record, Prepare, Edit, Review, Deliver. Header layout follows spec-edit: Undo and Redo on the left, the Project menu instead of "more", 32 px tabs, 24 px avatars. Clicking the title opens the menu, whose first row renames.
> - Stage icons: Prepare is `wand-sparkles` (not sliders), Edit is waveform with cursor (not scissors), Deliver is `send` (not the export arrow). Import is `file-plus`.
> - Mini player and Player card became **Player** (56 px bar, expanded form). Review context strip became **Overview strip** (32 px).
> - Job row, Check row, Model need row and the Readiness list became **Status row** and Status list. Status cover became **Cover**. History sheet, Models, Help and Connect agent sheets became **Sheet** instances. Source tile became **Start tile**. Comment row became **Queue row**. Following, version and stage chips became **Status pill**.
> - Keys: J/K/L are transport everywhere. Review moves with ↓/↑ or Tab, and Later is Tab or ↓ (not L). Reply is C (not R). ⌘⇧C is dropped. ⌘N and ⌘R on Home became Mod+I and R. ⌘O and ⌘⇧O became Mod+O. ? opens the Palette. ⌘E stays as Mod+E.
> - Icons: the listen role is `ear` (not eye). Editor role and "Open in Edit" use the Edit stage icon (not pencil). Producer is `ear` (not headphones). "Find more" is `wand-sparkles`. Keep stays `shield-check`.
> - Swipe left on a comment row no longer resolves: swipe right is the primary (Resolve), and left is Keep or Remove. The phone Review buttons are one 64 px dock row (Keep, A/B, verb).
> - Clip ideas use Approve (`check`), not Keep. Dismissing one is Remove.
> - Stop sharing is an undo toast (10 s), not an inline confirm.
> - Loudness lives in Deliver only. Vocabulary lives in Prepare only. Home's Help and "more" buttons fold into the app menu.
> - Invites: one Invite sheet from the header on every stage, with Deliver embedding the Listen row (answers Q4). Guest header is the 48 px App header. Guest Editor gets Edit and Review.
> - Toast lasts 6 s, or 10 s for session-level undo. Loading shows "Still loading…" at 4 s (not 8).
> - Storybook titles: `System/*` and `Stages/<Stage>/*`.

# Spec: Home, Prepare, Review and Deliver

Area worker spec for the Direction C "Stages" redesign. Scope: Home and onboarding, the Prepare stage, the Review stage (host and guest), and the Deliver stage, desktop and phone. Record and Edit are specced by other workers. Where this spec touches them it names the shared element and the hand-off, not their layout.

Inputs read: SPEC-BRIEF.md, rubric.md, inventory.md, the Direction C section of ui-directions.html, the 10-22 audit (desktop, narrow, phone, real-recording findings), shots for every item below (light theme, desktop 1440x900 and phone 390x844, viewed as side-by-side contact sheets), and repo docs (`docs/ui-philosophy.md`, `docs/pipeline.md`, `docs/share-tokens.md`, `docs/social-clips.md`, `ux/pages/guest-journeys.md`, `inspector/TranscriptRefineRecovery.tsx`, `layout/exportSettings.ts`, `ingest/ingestFiles.ts`).

Sizes assume the 4 px spacing grid, IBM Plex Sans 15/20 body, 13/16 meta, 20/24 card titles, 28/32 page titles. "Primary button" means the filled accent button, the one per context. Phone means < 768 px, tablet 768 to 1180, desktop > 1180 (the existing breakpoints).

---

## 1. Area summary

### What this area is for

ShareCut's story in Direction C is "the app suggests, you decide, then you publish." This area owns three of those beats plus the front door.

- **Home** is the first impression and the project switcher. It answers "what was I working on?" and "start something new" in one screen, and it absorbs the setup wizard so a new user never sees a model list before their first project.
- **Prepare** turns raw audio into an editable episode: sources, speakers, transcript, cleanup. It runs by itself after import. The user's job here is to watch it finish, name speakers, and add names and terms the transcriber should know. Today's Pipeline tab (24 steps, gates, raw ids) collapses into a five-row progress list with an "Advanced" door.
- **Review** is one queue of everything that needs a human decision: suggested cuts, comments, and checks (unsure words, transcript gate, sync conflicts). The user works it one item at a time with before/after listening, keyboard or thumb. Guests land in a reduced Review.
- **Deliver** replaces the Export, Bounce and Share dialogs with one page: a readiness check, the episode files, chapters, clips, and a listen link for the final.

### The stage frame (shared with Record and Edit)

- **Desktop and tablet:** a 48 px Stage bar at the top. Left: project name (truncates last, never before the stage tabs), Save state dot. Center: five stage tabs, icon + word, each 40 px tall: Prepare (sliders icon), Record (filled circle), Edit (scissors over waveform), Review (inbox-check), Deliver (arrow out of tray). Right: presence avatars (Person tiles at 28 px), Undo/Redo, a "more" button (three dots) for project-level items (Connect agent, Models, Help, Project settings, Close project). Tabs carry badges: Prepare shows a 12 px progress ring while processing and an amber dot when something needs the user; Review shows the count of undecided items; Deliver shows a check once a current export exists and an amber dot if the export is older than the latest edit.
- **Phone:** the same five stages become the bottom tab bar (56 px + safe area), replacing Listen / Timeline / Text / More. A 64 px mini player (play, time, a 4 px progress scrubber, comment button) sits directly above the tab bar in every stage except Record. Proposal for the Edit worker to confirm; this spec assumes it.
- **Free switching.** Every stage is reachable at every moment, by click, ⌘1 to ⌘5, or a phone tab tap. Nothing locks: Review with zero suggestions shows its empty state, Deliver with open items still exports. Switching keeps the playhead, the selection and the transport state. The selected object travels: a suggestion selected in Review is still selected in Edit.
- **Anticipation across stages.** Each stage ends with a **Stage hand-off button** (NEW, see section 3) at the bottom right of its content (desktop) or above the mini player (phone): "Review 14 suggestions", "Deliver", "Back to Review (2 new comments)". It names the next stage and why, and it is the one secondary-weight accent button on the page when the stage's own work is done.

### How users enter and leave

- Enter Home: launch with no project, ⌘⇧O from anywhere, or the project name menu > "All projects".
- Home to a project: a click on a Project card opens the stage that project needs next (Prepare while processing, Review if anything is undecided, otherwise Edit). New project by import opens Prepare. New project by recording opens Record.
- Guests enter at `/r/<token>` straight into Review (Viewer, Commenter) or Review plus Edit (Editor). They never see Home, Prepare, Record or Deliver.
- Leave: project name > All projects, or close the window. Nothing to save; the Save state dot already says so.

### Icon language used in this area

One icon per verb, everywhere (principle 10, 11). Labels stay as accessible names and as the visible word on primary buttons; nothing depends on reading them.

| Verb / object | Icon | Where it appears in this area |
|---|---|---|
| Cut (accept a cut) | scissors | Decision card primary, queue group bulk, Edit action bar |
| Keep (reject a cut, keep audio) | shield over a waveform | Decision card secondary, action bar |
| Shorten (pause) | two arrows pointing inward | Decision card primary for pause suggestions |
| Lower (sound) | speaker with minus | Decision card primary for sound suggestions |
| Later (move on undecided) | chevron down | Decision card, J key |
| Hear before / Hear after | "A" and "B" in rounded squares inside one segmented control | A/B audition everywhere |
| Comment | speech bubble | queue, mini player, action bar |
| Resolve | speech bubble with check | Decision card for comments |
| Fix text | text cursor | unsure-word check, transcript |
| Split speakers | one waveform forking into two | Prepare source card |
| Import / add audio | arrow into tray | Home, Prepare |
| Record | filled circle (accent) | Home, Prepare, stage bar |
| Export / download a file | arrow out of tray, down | Deliver, Bounce replacement |
| Link / share | two chain links | Deliver, Review header |
| Get (download a model) | cloud with down arrow | Model need row |
| Check status | filled check (done), amber triangle (needs you), hollow circle (not yet), red octagon (failed) | Check rows, job rows |
| Role: Viewer / Commenter / Editor | eye / speech bubble / pencil | Role chip |

---

## 2. Items

### Home and onboarding

### SCR-HOME · Home

- **Today:** `SCR-HOME--desktop-light.png`, `SCR-HOME--phone-light.png`.
  - Purpose: no recent projects, so a returning host retypes paths or hunts in Finder. The most frequent action (reopen yesterday's episode) has no surface at all.
  - Hierarchy: five same-weight outlined buttons in a column; "Models · setup incomplete" and "Connect agent…" compete with "New project…" for the first screen. Squint test fails; Direction C critique calls it "a placeholder".
  - Anticipation: "New" doesn't say how the episode will start (file or recording), which is the user's real first decision.
  - Reach: phone puts all five buttons in the top half, nothing in the thumb zone.
- **Fate:** replace with NEW Home (recent projects + two Source tiles + folded setup).
- **Spec:**
  - Layout desktop (1280+): content column max 1040 px, centered, 48 px top padding. Row 1 (64 px): ShareCut wordmark left; right a Help button (question mark, 40 px) and the more button (Models, Connect agent, Settings). Row 2: two **Source tiles** side by side, each 50% width, 160 px tall: "Import audio" (arrow-into-tray icon 32 px, line "Drop files or choose", accepts drop anywhere on the window) and "Record" (accent filled circle 32 px, line "Invite guests and record"). Row 3: "Recent" heading 13/16 caps-free meta, then a grid of **Project cards**, 3 per row at 1280, 4 at 1920, 16 px gaps. An "Open other…" text button at the end of the Recent heading row opens the OS picker.
  - Project card (240 x 152): a static overview waveform of the episode (the whole timeline in one 48 px strip, track colors), project name 15/20 semibold (2 lines max), meta line "52:10 · edited 2 h ago", and a stage status chip: "Processing 40%", "Review 6", "Edited", "Delivered 24 Oct". Click opens the project at the stage its chip names. Right-click / long-press: Open, Reveal in folder, Duplicate, Remove from list (not delete).
  - The one primary action: when Recent is empty, Import audio is the primary (filled tile). When projects exist, the first Project card (most recent) gets a 2 px accent focus ring on load and Enter opens it, so "continue where I left off" is one key.
  - Anticipated next action: reopening the last project (Enter, or the top-left card under the cursor's natural landing). After that: the stage chip tells them what's waiting.
  - Direct manipulation: drop audio files anywhere on Home creates a project named after the first file (or "Episode, 25 Oct" for several) in the default folder `~/ShareCut/<name>` and opens Prepare with import already running. No form.
  - Keyboard: Enter opens focused card, arrows move between cards, ⌘N = Import (OS file picker), ⌘R = Record, ⌘O = Open other, ? = Help.
  - Phone: single column, 16 px gutters. Top: wordmark (24 px) and Help. Recent list as 72 px rows (waveform thumbnail 64 x 40 left, name, meta, stage chip right). The two Source tiles move to the bottom thumb zone as a fixed 2-up bar (each 72 px tall, full width halves) above the safe area. Swipe a row left reveals "Remove from list".
  - States: empty (no projects) shows the Source tiles at 220 px tall in the center and a one-line "Your episodes will appear here."; setup needed shows the Setup card (see SCR-SETUP) between the Source tiles and Recent; loading shows card skeletons (static grey blocks, no shimmer) after 300 ms; a missing project folder shows its card dimmed with "Folder moved" and a "Find…" button.
  - Copy: tiles "Import audio" / "Record"; empty line "Your episodes will appear here."
- **Shared elements used:** Source tile (NEW), Project card (NEW), Save state dot, Icon language, Check row (NEW) for setup.
- **Story to build:** `Stages/Home/Home` stories: `Empty`, `WithRecents`, `SetupNeeded`, `SetupDownloading`, `FolderMoved`, `DropHover`, `Phone`, `PhoneEmpty`.

### SCR-HOME-NEW · New project form

- **Today:** `SCR-HOME-NEW--desktop-light.png`, `SCR-HOME-NEW--phone-light.png`.
  - Interaction cost: typing an absolute folder path with no picker (real-recording F07); on a phone the path is on another computer.
  - Hierarchy: Create looks disabled (faded accent) until a path exists, with no hint why.
  - Language: "Workspace directory" is developer wording.
- **Fate:** remove. Projects are created implicitly by Import or Record (defaults: name from first file or date, folder `~/ShareCut/<name>`, de-duplicated with " 2").
- **Spec:** the project name is renamed in place by clicking it in the Stage bar (inline text field, Enter commits, Esc cancels). The folder is changed in Project settings > "Saved in" with a "Move…" button (OS picker). No create form exists anywhere. On a phone, Import uploads the bytes (the existing upload path in `ingestFiles.ts`) into the default folder on the host computer.
- **Shared elements used:** Source tile, inline rename field.
- **Story to build:** none (removed). `Stages/Frame/StageBar` story `RenameProject` covers the rename.

### SCR-HOME-OPEN · Open project form

- **Today:** `SCR-HOME-OPEN--desktop-light.png`, `SCR-HOME-OPEN--phone-light.png`. The user must know a file is called `episode.project.json`; three equal buttons; Cancel wraps on phone.
- **Fate:** replace with "Open other…" (OS folder picker that accepts the project folder or the json) plus Project cards.
- **Spec:** "Open other…" opens the OS picker in folder mode; choosing a folder that contains `episode.project.json` opens it. When no OS picker exists (plain browser), a popover anchored to the button holds one path field (placeholder "Folder of the episode") and an Open button; Enter submits. Errors appear under the field (see SCR-HOME-ERROR).
- **Shared elements used:** popover, inline error.
- **Story to build:** `Stages/Home/OpenOther` stories `Picker`, `PathFallback`, `PathError`.

### SCR-HOME-ERROR · Home error

- **Today:** `SCR-HOME-ERROR--desktop-light.png`, `SCR-HOME-ERROR--phone-light.png`. Error appears above the form, far from the field, in internal phrasing "expected episode.project.json, got 'bad.project.json'".
- **Fate:** restyle into inline field errors.
- **Spec:** error text 13/16 in the danger color directly under the path field, with a fix: "That folder has no ShareCut episode. Choose the folder that holds episode.project.json." Opening a project another window already has open: "This episode is open in another window. Switch to it" (button).
- **Shared elements used:** inline error.
- **Story to build:** covered by `Stages/Home/OpenOther` `PathError`.

### SCR-SETUP · Setup wizard (+ CHECKING, DOWNLOAD, LOADERROR)

- **Today:** `SCR-SETUP--*`, `SCR-SETUP-CHECKING--*`, `SCR-SETUP-DOWNLOAD--*`, `SCR-SETUP-LOADERROR--*`.
  - Purpose: a new user's first screen is a list of model names (wav2vec2, ECAPA, ONNX) before they have any reason to care.
  - Interaction cost: Continue is 2.6 screens down at 320 px (narrow F08); no cancel for a 1.6 GB download.
  - Language: "Audio tools: ready", "wav2vec2 base (ONNX, English)", load error reads "boom".
  - Defaults: the word aligner is off by default, yet the cut-safety bar depends on it (desktop F07).
- **Fate:** merge into SCR-HOME as the Setup card plus a background Job row. The full model list moves to DLG-MODELS.
- **Spec:**
  - Setup card on Home (only when required models are missing): full content width, 120 px tall, sits between the Source tiles and Recent. Left: an icon (cloud with down arrow) 32 px. Text: "Get ShareCut ready" 20/24, line "Transcription and cut-finding run on this computer. One download, about 2 GB." Right: primary button "Get ready" and a text button "Choose…" (opens DLG-MODELS).
  - Defaults bundle: speech model (recommended size), noise reduction, word aligner, speaker model. The aligner is in the default bundle (see open question 2).
  - Downloading: the card turns into a Job row: one progress bar for the bundle, "1.1 of 2.0 GB · about 3 min", a cancel icon (x, 40 px) at the right. The user can import or record while it runs; Prepare queues transcription until the model lands and says so on its job row.
  - Checking: nothing renders for the first 300 ms; after that the card shows a static skeleton. No "Checking installed tools…" box.
  - Load error: the card reads "Couldn't check what's installed." with "Try again". Never shows raw error text; the raw message goes into the Help diagnostics bundle.
  - Phone: the card is full width, 16 px gutters, button full width under the text (48 px tall), in reach above the Source tiles.
  - Skip: there is no Skip button. Doing anything else is skipping; the card stays until models exist or the user dismisses it via its more menu ("Not now", returns next launch).
- **Shared elements used:** Job row (NEW), Model need row (NEW) inside DLG-MODELS, Check row.
- **Story to build:** `Stages/Home/SetupCard` stories `Needed`, `Downloading`, `Failed`, `CheckError`, `Phone`.

### BAN-HOME-SCREEN-HINT · Add to Home Screen hint

- **Today:** `BAN-HOME-SCREEN-HINT--phone-light.png`. A text banner above the transport inside the More hub, permanent until dismissed, competes with the editor chrome.
- **Fate:** move to Home as a one-time card.
- **Spec:** iOS Safari, not standalone, second visit or later: a 96 px card at the top of Home's Recent list with the iOS share glyph drawn inline and "Add to Home Screen for full screen." plus a close icon (44 px). Dismiss stores per device. Never shown inside a project.
- **Shared elements used:** dismissible card (same container as the Setup card).
- **Story to build:** `Stages/Home/Home` story `PhoneInstallHint`.

### DLG-MODELS · Models

- **Today:** `DLG-MODELS--desktop-light.png`, `DLG-MODELS--phone-light.png`. Each row repeats Required/size/status/description in four lines; native select for Whisper size; a long scroll in a modal.
- **Fate:** restyle as a sheet ("Models" in Settings) built from Model need rows.
- **Spec:** right side sheet 420 px (desktop), full-height sheet (phone, large detent). One row per capability, worded by what it does: "Transcription", "Word timing", "Speaker split", "Noise reduction". Row anatomy (64 px): icon, capability name 15/20, size and state in meta ("Installed · 1.6 GB", "Not installed · 360 MB"), a trailing control: Get (cloud icon + word) or a progress ring with cancel, or a more menu (Update, Remove). Transcription has a "Size" segmented control under it: Fast (75 MB) / Balanced (500 MB) / Best (1.6 GB), default Best on desktop. No Apply button.
- **Shared elements used:** Model need row (NEW), Job row, segmented control.
- **Story to build:** `Stages/Settings/ModelsSheet` stories `FreshInstall`, `Mixed`, `Downloading`, `Failed`, `Phone`.

### DLG-MODEL-GATE · Download model? (+ DOWNLOADING) and DLG-WHISPER · Download Whisper model?

- **Today:** `DLG-MODEL-GATE--*`, `DLG-MODEL-GATE-DOWNLOADING--*`, `DLG-WHISPER--*`. A modal interrupts the run; "Use without downloading" does nothing (narrow F07, real-recording F04); the old Pipeline panel told the user to run `podcast bootstrap` in a terminal (narrow F02); the Getting ready row now asks and downloads on Get.
- **Fate:** replace with the Model need row shown in place, inside the job that needs it.
- **Spec:** when a step needs a missing model, its Job row in Prepare (or the export Job row in Deliver) shows the Model need row inline: "Needs the transcription model · 1.6 GB" and a Get button. Pressing Get downloads and the step resumes by itself when it lands. Steps that don't need the model keep running. No modal, no "use without". Choosing a model size in Prepare's advanced sheet never opens a dialog; the size row just shows "Not installed" with Get.
- **Shared elements used:** Model need row, Job row.
- **Story to build:** `Stages/Prepare/ReadyList` stories `NeedsModel`, `ModelDownloading`; `Stages/Deliver/ExportJob` `NeedsModel`.

### DLG-HELP · Help

- **Today:** `DLG-HELP--desktop-light.png`, `DLG-HELP--phone-light.png`. One dialog with a paragraph, a link and a "Create diagnostics bundle" primary; Help means only "report a bug".
- **Fate:** restyle as a Help sheet with three rows.
- **Spec:** popover (desktop, anchored to the Help button, 320 px) or medium sheet (phone). Rows (56 px each, icon + label + chevron): "Shortcuts and gestures" (opens DLG-PALETTE), "Report a problem" (pushes a step inside the same sheet), "Guides" (opens docs site). Report a problem step: a description field (3 lines), a line "Includes logs and settings. No audio, transcripts or project files.", a "Preview what's included" disclosure, and the primary "Send report". After send: "Sent. Reference R-2481" with Copy. Offline: "Saved on this computer. It sends when you're online."
- **Shared elements used:** sheet, Job row (while bundling).
- **Story to build:** `Stages/Settings/HelpSheet` stories `Menu`, `ReportEmpty`, `ReportPreview`, `Sending`, `Sent`, `Queued`, `Failed`, `Phone`.

### DLG-MCP · Connect agent

- **Today:** `DLG-MCP--desktop-light.png`, `DLG-MCP--phone-light.png`. A paragraph comparing it to "Figma desktop MCP", a URL field and a JSON snippet with two copy buttons of different weight.
- **Fate:** restyle as a sheet with one copy action.
- **Spec:** medium sheet. A segmented control picks the client: Claude / Cursor / Other. Below, one read-only block shows exactly what to paste for that client (URL for Claude, JSON for Cursor, URL for Other) with one primary "Copy". Under it a status line driven by presence: "Not connected yet" (hollow circle) turns to "Connected: Claude" (filled check) when an agent joins; the agent then appears as a Person tile in the Stage bar. No project open: "Open an episode first. The agent works on the open episode." with the Recent list link.
- **Shared elements used:** Person tile, segmented control, Check row status glyphs.
- **Story to build:** `Stages/Settings/ConnectAgent` stories `Claude`, `Cursor`, `Connected`, `NoEpisode`, `Phone`.

### SCR-LOADING · Loading cover

- **Today:** `SCR-LOADING--desktop-light.png`, `SCR-LOADING--phone-light.png`. Centered "Loading project…" text on a blank page.
- **Fate:** replace with the destination's skeleton.
- **Spec:** nothing for 300 ms; then the Stage bar renders for real (name known from the URL or Home card) and the stage body shows static grey placeholders in its real layout. After 8 s add one line under the body: "Still loading. Try again" (button). No spinner.
- **Shared elements used:** Stage bar, Status cover (for the 8 s failure).
- **Story to build:** `Stages/Frame/Loading` stories `Prepare`, `Review`, `Slow`.

### SCR-ERROR · Error cover, SCR-COVER · Cover, SCR-RECOVERY · Project not served here

- **Today:** `SCR-ERROR--*` shows raw JSON `{"detail":"not found"}` in the browser for a bad link (the route returns API JSON, not the app); `SCR-COVER--*-story.png` is an unstyled heading and line; `SCR-RECOVERY--*` is a server page with its own style.
- **Fate:** merge all three into NEW Status cover.
- **Spec:** centered column 400 px (phone: 16 px gutters, content in the lower half so the button is in thumb reach). Wordmark symbol 32 px at top. Icon 48 px for the case (broken link, moon for host asleep, folder for not served). Title 20/24, one sentence 15/20, one primary button, at most one text button. Cases: bad or revoked review link: "This link doesn't open anything" / "Ask the person who sent it for a new link." / no button for guests. Host offline: "The host's computer is asleep" / "This page tries again every 30 seconds." / "Try now". Project not served: "This episode isn't open on this computer" / primary "Open <name>" / text "All projects". The server must serve the app (HTML) for `/r/*` and `/rec/*` so these never show JSON.
- **Shared elements used:** Status cover (NEW).
- **Story to build:** `Stages/Frame/StatusCover` stories `BadLink`, `HostAsleep`, `NotServed`, `Phone`.

### DLG-ASK-TEXT · Open project path prompt

- **Today:** `DLG-ASK-TEXT--*`. A modal asking for a json path, "No native file picker here".
- **Fate:** merge into SCR-HOME-OPEN (path popover).
- **Spec:** see SCR-HOME-OPEN. The in-project "Open project" menu item goes to Home.
- **Built (#2295):** the prompt and `askText` are gone. With no OS picker, `project.open` navigates to `/?home=1&openOther=1`, where Home opens the Open other… path field.
- **Shared elements used:** popover.
- **Story to build:** covered by `Stages/Home/OpenOther`.

---

### Prepare stage

### SCR-PREPARE (new) · Prepare stage

- **Today:** Prepare does not exist. Its parts are spread over SCR-SHELL-INGEST, PNL-PIPELINE, CMP-VOCAB, DLG-SPLIT and the Track inspector. Shots: `SCR-SHELL-INGEST--*`, `PNL-PIPELINE--*`, `DLG-SPLIT--*`.
  - Anticipation: after import there is no "Transcribe" action (desktop F08); the user must find Pipeline, pick "Batch (waive align + refine)", and press Run.
  - Hierarchy: setup settings (vocabulary) sit in the editor's bottom dock, next to Transcript and Comments.
  - Language: step ids (`transcribe_tracks`), "waive align + refine", "gate", "deps".
- **Fate:** replace with NEW Prepare stage.
- **Spec:**
  - Layout desktop: three columns inside the stage frame, 24 px gutters. Left (360 px) **Sources**: one Source card per file, grouped by recording session ("Session 1 · 25 Oct", "Session 2 · 2 Nov"), and an "Add audio" Source tile (80 px) plus "Record another session" Source tile at the bottom. Center (flex) **Getting ready**: the Ready list (see "Import and transcription flow"). Right (320 px) **Help the transcriber**: vocabulary chips (CMP-VOCAB) and **Cleanup**: "How tight" segmented Light / Medium / Tight (default Medium) and "Loudness" segmented Podcast −16 / Broadcast −23 / Streaming −14 (default Podcast). At the bottom right of the center column, the Stage hand-off button.
  - Primary action: none while processing (the work is automatic). When processing finishes, the hand-off button becomes the primary: "Review 14 suggestions" (or "Edit" when there are none).
  - Anticipated next: name the speakers while transcription runs (Source cards have the name field focused-ready, Tab moves between them), then go to Review.
  - Direct manipulation: drop files on the Sources column to add; drag Source cards between sessions is not allowed (sessions are recordings); drag to reorder tracks within a session.
  - Keyboard: ⌘I add audio, Tab through speaker names, ⌘Enter takes the hand-off.
  - Phone: one column. The first thing is a one-line summary button (72 px) "Getting ready: 2 of 3 done" that opens the full Ready list in place (it opens by itself when a row needs you or failed); then Sources, Help the transcriber, Cleanup. The summary exists only at phone width; the full card stays in the middle column from 60 rem wide. The DOM order equals the drawn order at every width, with no CSS reordering, so the first Tab stop on a phone is the summary and the next is Sources. Hand-off button fixed above the mini player when ready. Add audio and Record as a 2-up bar at the top of Sources.
  - States: empty (new project): the center shows two large Source tiles (Import audio, Record) and nothing else; processing; needs you (amber dot on the tab, the row that needs input is first and expanded); done; failed step (row red with "Try again" and a "Details" disclosure that shows plain-language cause, raw log in Help bundle).
  - Copy: section titles "Sources", "Getting ready", "Help the transcriber", "Cleanup".
- **Shared elements used:** Stage bar, Stage hand-off button (NEW), Source tile (NEW), Source card (NEW), Job row (NEW), Check row (NEW), segmented control, Person tile color swatches for speakers.
- **Story to build:** `Stages/Prepare/Prepare` stories `Empty`, `Importing`, `Transcribing`, `NeedsSpeakerNames`, `NeedsModel`, `Done`, `StepFailed`, `TwoSessions`, `Phone`, `PhoneDone`.

### SCR-SHELL-INGEST · Empty session import and INT-IMPORT

- **Today:** `SCR-SHELL-INGEST--desktop-light.png`, `SCR-SHELL-INGEST--phone-light.png`. A dashed drop area plus a permanent coach paragraph ("Drop stems here. Use one file per speaker…") plus "Got it"; the phone shows a dead player with "Import audio to play" and a comment composer for an empty project.
- **Fate:** merge into SCR-PREPARE's empty state.
- **Spec:** the empty Prepare center holds the two Source tiles at 240 px tall. Hovering a drag over the window outlines the Sources column with a 2 px accent border and the line "Drop to add 3 files". After drop, each file becomes a Source card at once with its own progress (upload, then probe). One file per speaker is taught by the result, not a paragraph: a single file shows the Split prompt on its card (see DLG-SPLIT). Replacing audio on a track with media: drag a file onto that Source card; it replaces with an Undo toast, no confirm dialog. On phone, Import opens the iOS/Android file picker (multi-select).
- **Shared elements used:** Source tile, Source card, Toast with Undo.
- **Story to build:** `Stages/Prepare/Prepare` `Empty`, `DropHover`, `Importing`.

### Import and transcription flow (INT-IMPORT, new INT-PREPARE-RUN)

- **Today:** desktop F08 (no Transcribe action), real-recording F04 (run does nothing without a model), audit timings: import 3 to 5 s, transcribe + align about 118 s for 8 minutes on tiny.en, batch pipeline 236 s.
- **Fate:** replace manual "Run pipeline" with automatic processing shown in the Ready list.
- **Spec:**
  - Import starts processing at once with the defaults. The Ready list has five rows, each a Job row with a status glyph, a plain title, a one-line detail and, when running, a progress bar: 1 "Add audio" (probe), 2 "Transcribe" ("2 of 3 speakers · about 1 min left"), 3 "Line up tracks" (align), 4 "Clean and level" (noise, compression, balance; non-destructive), 5 "Find suggestions" (fillers, pauses, sounds; proposes only, never applies). Mastering is not here; Deliver owns it.
  - Each row maps to pipeline steps (1: ingest; 2: transcribe; 3: align, require_align_accept auto-accepted below `align.large_move_sec`, merge, render stems, reconcile, precorrect; 4: fill_gate_holes, clean_audio, compress, balance, assemble; 5: analyze_fillers_pauses, apply_sound_actions as proposals). The transcript-refine gate is not a row; see "Refine gate" under Review.
  - Large alignment moves (above `align.large_move_sec`) become a "needs you" Check row: "Guest track moved 4.2 s to line up. Hear it" with Hear and "Looks right" / "Undo move".
  - Adding a second session (Record or Add audio later) processes only new sources (transcript reuse by `audio_sha256` already exists) and appends their suggestions to Review with a "New" tag.
  - Edits made while processing are kept; a row that would overwrite hand-corrected words asks inline on that row (not a modal): "You fixed 12 words. Keep my fixes / Replace" with Keep as the default focused button.
  - Phone: identical rows, 56 px each.
- **Shared elements used:** Job row, Check row, Model need row, A/B audition (for the align move).
- **Story to build:** `Stages/Prepare/ReadyList` stories `Queued`, `Running`, `NeedsAlignCheck`, `NeedsModel`, `KeepMyFixes`, `Failed`, `Done`.

### PNL-PIPELINE · Pipeline panel (now the Getting ready list and Advanced)

- **Today:** `PNL-PIPELINE--desktop-light.png`, `PNL-PIPELINE--phone-light.png`. Mode select "Batch (waive align + refine)", Analyze/Reset/Run, terminal commands with temp paths (narrow F02), results summary clipped at 320 (narrow F01), all inside a 200 px dock.
- **Fate:** merge into SCR-PREPARE: the Ready list is the default view; the full step list moves behind "Advanced" in an Inspector sheet.
- **Spec:** a text button "Advanced" (gear icon) at the end of the "Getting ready" title opens the Inspector sheet listing all steps grouped like the Ready rows, with a switch per optional step, the step's plain name ("Fill gaps from the recorder's noise gate"), and its last result line. Selecting a step shows its settings in the same sheet (DLG-STEP-PARAMS). "Run again from here" is a per-step more-menu item. No Analyze, Reset or mode select: modes become defaults (auto-accept align below the limit, refine gate handled in Review).
- **Shared elements used:** Inspector sheet, Job row, switch.
- **Story to build:** `Stages/Prepare/AdvancedSteps` stories `List`, `StepSelected`, `StepRunning`, `Phone`.

### DLG-STEP-PARAMS · Step parameters

- **Today:** `DLG-STEP-PARAMS--desktop-light.png`, `DLG-STEP-PARAMS--phone-light.png`. Phone-only modal; field help repeats defaults ("Default: true"); language as a typed code "en".
- **Fate:** merge into the Inspector sheet (same on all sizes).
- **Spec:** fields are scrub fields or segmented controls, commit on change, no Apply. Each field shows a reset dot when not default (tap resets). Language is a searchable picker with "Detect automatically" first. Help appears as a one-line hint only while the field is focused. Phone: sheet at half detent, drag to full.
- **Shared elements used:** Inspector sheet, scrub field.
- **Story to build:** `Stages/Prepare/AdvancedSteps` `StepSelected`, `PhoneStep`.

### CMP-VOCAB · Transcription vocabulary

- **Today:** seen in `PNL-PIPELINE--phone-light.png`. Two text fields with "Add term" / "Add guest name" buttons, a 400-character counter, and "Save vocabulary".
- **Fate:** restyle as one chip input in Prepare's right column.
- **Spec:** one field "Names and terms" with chips; Enter or comma adds a chip; Backspace on an empty field removes the last chip; chips show a person icon when they match a speaker name (speaker names from Source cards are added automatically and shown first, not removable here). Saves on every change. The 400-character limit appears only when within 40 characters ("38 left"). If transcription has already run, adding a term shows on the field: "Applies next time words are transcribed. Re-transcribe" (button) which reruns step 2 for all sources.
- **Shared elements used:** chip input.
- **Story to build:** `Stages/Prepare/Vocabulary` stories `Empty`, `WithChips`, `NearLimit`, `AfterTranscribe`, `Phone`.

### DLG-SPLIT · Split speakers

- **Today:** `DLG-SPLIT--desktop-light.png`, `DLG-SPLIT--phone-light.png`. Opened from the Track inspector; names typed before the split are assigned in order of first speech, so they rotate (real-recording F09); "Use selection" buttons demand a range the user can't see under the modal.
- **Fate:** replace with an inline prompt on the Source card plus name-after-hearing.
- **Spec:** a Source card that holds one file with more than one voice in its transcript (or any single-file project) shows a row inside the card: split icon, "One recording of several people?", a stepper (default 2, range 2 to 8, 44 px buttons) and "Split". During the split the card shows a Job row ("Finding voices · 1 of 1517", cancel). Result: the card becomes N Source cards, each with a "Hear" button that plays 4 s of that voice, a name field, and the voice's share of the episode ("5:11"). Names are entered after hearing, so they can't rotate. One Undo restores the single track. Wrong split: a "Merge" item in the card's more menu joins two voices.
- **Shared elements used:** Source card, Job row, A/B audition button style for Hear, Toast with Undo.
- **Story to build:** `Stages/Prepare/SplitSpeakers` stories `Prompt`, `Splitting`, `NameVoices`, `Failed`, `Phone`.

### Missing model state (audit narrow F02, F07; real-recording F04)

- **Today:** see DLG-MODEL-GATE and PNL-PIPELINE shots.
- **Fate:** replace with the Model need row in the Transcribe Job row.
- **Spec:** "Transcribe · Waiting for the transcription model" with Get (1.6 GB) inline; other rows that don't depend on it (Add audio, Clean and level) proceed. The Prepare tab shows the amber dot. When the download finishes, transcription starts by itself and the row says "Starting".
- **Shared elements used:** Model need row, Job row.
- **Story to build:** `Stages/Prepare/ReadyList` `NeedsModel`.

### No-aligner state (audit desktop F07)

- **Today:** status bar says "QC ok" while the step result says "forced alignment unavailable … (podcast bootstrap --component word-aligner)".
- **Fate:** replace with a Check row in Prepare and Review.
- **Spec:** in Prepare's Ready list, row 2 finishes with an amber glyph: "Transcribed. Word timing is approximate" and a Model need row "Download word timing (360 MB)". In Review's Checks group the same Check row appears once ("Cuts may clip word edges until word timing is installed") with Get. After install, a "Re-time words" action runs alignment only.
- **Shared elements used:** Check row, Model need row.
- **Story to build:** `Stages/Prepare/ReadyList` `ApproximateTiming`; `Stages/Review/Queue` `AlignerMissingCheck`.

---

### Review stage

### SCR-REVIEW (new) · Review stage (host)

- **Today:** Review is spread across PNL-REVIEW-QUEUE, PNL-TIGHTEN, PNL-COMMENTS, INS-PENDING and OVL-PENDING. Shots: `PNL-IMPACT--*` (the Impact tab, now PNL-REVIEW-QUEUE), `PNL-TIGHTEN--*`, `PNL-COMMENTS--*`, `INS-PENDING--*`.
  - Purpose: decisions are split across four places with four vocabularies ("pending edit", "tighten hit", "comment", "applied").
  - Interaction cost: approving one cut needs the timeline, an inspector and a 409 recovery (desktop F03).
  - Feedback: Apply suggested runs 65 to 79 s with no progress (real-recording F01).
- **Fate:** replace with NEW Review stage.
- **Spec:**
  - Layout desktop (1280 x 800): Stage bar 48. Left **Queue** 360 px full height. Center **Decision card** column, card max 760 px wide, centered. Bottom of the center column: a 56 px context strip (overview waveform of the whole episode with ticks for every queue item, the current one accented; click a tick to jump). No right column at 1280; at 1920 the card stays 760 and the extra width is margin.
  - Queue header (88 px): progress "6 of 14 decided · saves 7.8 s" (the seconds are the actual timeline duration change, one number used everywhere, fixing real-recording F05), a filter segmented control of icons with counts: All / Suggestions (scissors) / Comments (bubble) / Checks (triangle), and a "Find more" icon button (magnifier) that reruns suggestion finding with the "How tight" setting. Shipped in PR 4a (#2293): host only, uses the saved How tight, asks before it replaces pending hits, shows the Job row "Finding more suggestions" while it runs, and is disabled with a reason while the pipeline slot is busy. A bulk verb shows "Cutting N…" (indeterminate, because the host reports no count) in the group's place until it ends.
  - Queue body: groups in this order: Checks, Comments, then suggestion groups by kind (Fillers, Pauses, Repeats, False starts, Sounds), then "Decided" (collapsed). Group header row 40 px: kind icon, name, count, seconds, and a bulk button with the verb icon ("Cut all 11"; a group with one cuttable item says plain "Cut", named "Cut this one" for assistive tech). Items that stay for one-by-one decisions are counted in a "N to decide one by one" line in the header, shown to editors and not to guests. Item rows 56 px: kind icon, quoted snippet with the struck words drawn as the Suggestion visual, time right-aligned in monospace, saved seconds under it. Unsure-word items are tagged with a dotted underline and are excluded from bulk.
  - Primary action: the Decision card's verb button (Cut / Shorten / Lower / Resolve / Looks right), Enter.
  - Anticipated next action: the next undecided item. After any decision the card advances to the next undecided item in the queue in under 100 ms, and the decided row collapses to a single line with its result glyph. A Toast with Undo shows for 6 s ("Cut 0.8 s · Undo").
  - Keyboard: J / K next / previous, Enter primary verb, X Keep, L Later, A / B hear before / after (each plays 3 s before the change through 3 s after), Space play/pause the context, E open in Edit with this item selected, C comment on this item, ⇧Enter bulk verb for the item's group. All shown in the card's footer in 13 px meta, once per session, then only on hover.
  - Phone: the Decision card fills the screen above the mini player. Top: a 48 px row "3 of 14" (tap opens the Queue as a large sheet) and filter icon. Bottom thumb zone: Keep (left, 56 px, outlined) and the verb (right, 56 px, primary), a full-width A/B segmented control (48 px) above them. Gestures: swipe the card right = primary verb, left = Keep, up = Later; 80 px threshold with the verb icon growing under the card while dragging; release below threshold springs back. Haptic on commit where available.
  - States: empty "Nothing to decide" with the inbox-check icon 48 px and the hand-off "Deliver"; processing (Prepare still finding suggestions) shows decided items and a top Job row "Finding suggestions · 60%"; bulk running shows a Job row in the group header with a count "Cutting 11 · 4 done", the group's buttons disabled, Undo available as soon as it finishes (one step for the whole group); offline guest edits pending (see guest).
- **Shared elements used:** Review queue (NEW), Decision card (NEW), Suggestion, A/B audition, Check row, Job row, Toast with Undo, Stage hand-off button, Transport (context strip + mini player).
- **Story to build:** `Stages/Review/Review` stories `Mixed`, `Suggestion`, `Comment`, `Check`, `Empty`, `BulkRunning`, `Processing`, `Phone`, `PhoneSwipe`, `PhoneQueueSheet`.

### Decision card (the focus surface; replaces INS-PENDING in Review)

- **Today:** `INS-PENDING--desktop-light.png`, `INS-PENDING--phone-light.png`. Approve/Reject at the top, then Source fields with −100/−10/+10/+100 nudge buttons and "Apply timing", "Boundary inaudible", "Review required" as field values. The phone sheet hides the cut it describes.
- **Fate:** replace with Decision card in Review; in Edit, selecting a suggestion shows the floating action bar with the same verbs (Edit worker).
- **Spec:**
  - Anatomy, top to bottom: kind line (icon + "Filler", 13/16) and time "18:36" + speaker swatch and name; title 20/24 in plain words ("Remove “um, you know”", "Shorten a 2.9 s pause to 0.6 s", "Lower a laugh by 12 dB"); transcript excerpt 17/26, two sentences of context, with the change drawn as the Suggestion visual (struck words in the cut color, a hatched gap glyph for pauses); a 96 px waveform of ±6 s with the hatched Suggestion region and two 12 px edge handles (hit area 44 px) to adjust bounds by dragging, snapping to silence by default (hold Alt to disable); under it one plain "why" line from the suggester ("Jon cuts off a word and says it again"); A/B audition control; action row.
  - Action row (desktop, right-aligned): Later (chevron, text button), Keep (shield, outlined), primary verb (filled, verb icon + word). A pencil icon at the far left: "Open in Edit".
  - Adjusting a handle updates the "saves" number live and switches the A/B control to B so the next play is the adjusted result.
  - Comment thread on the same moment (if any) shows below the action row, collapsed to its first line.
  - Unsure word inside the range: the word has a dotted underline and the card shows "Unsure word: is this “uncle”?" with Fix text (inline field) before the primary verb is enabled; this keeps unsure words out of blind approval (ui-philosophy §1).
- **Shared elements used:** Suggestion, A/B audition, Decision card (NEW), Object selection verbs (Cut, Keep, Comment, Hear, Fix text).
- **Stories:** `Stages/Review/DecisionCard` stories `Filler`, `Pause`, `Sound`, `Adjusting`, `UnsureWord`, `UnsureWordEmptySave`, `UnsureWordWithHear`, `CutWithUnsureWord`, `WithComment`, `Check`, `CutAnywayPrompt`, `Comment`, `GuestSuggestion`, `GuestReadOnly`, `GuestEditor`, `Empty`, `Loading`, `LoadError`, `Phone`, `Phone390`, `PhoneGuest`, `PhoneUnsureWordOpenInEdit`, `PhoneEmpty`, `PhoneSwipe`.

### PNL-REVIEW-QUEUE · Impact, now the Review queue (incl. refine-gate state, PNL-REVIEW-QUEUE-REFINE-GATE)

- **Today (before #2293, as the Impact tab; the shots keep their original `PNL-IMPACT--*` and `PNL-IMPACT-REFINE-GATE--*` names):** Totals as a definition list ("Total removed 0.00 s"), Approve all / Reject all, links like "guest's cut at 0:20.0 · agent:suggest"; the refine gate shows "Transcript refinement is required before approval…" and a required Waiver reason textarea (desktop F03, narrow F04, phone F01, F03).
- **Fate:** merged into SCR-REVIEW (shipped in #2293 as the Queue tab) and Deliver's readiness check ("Edits"). The refine gate is a Check row and an in-card Cut anyway prompt.
- **Spec (refine gate):**
  - What it is in user terms: cuts are placed by words, so someone should glance at the transcript before cut suggestions are applied.
  - When the gate is open, Checks holds a row "Check the transcript before cutting" with the count of unsure words ("3 unsure words"). Selecting it opens a Decision card that steps through the unsure words (each with Hear, Fix text, Looks right). Finishing the last word marks the transcript checked (records refine-done for the human). A text button on that card, "Mark as checked", marks it without stepping through. Shipped in PR 3 (#2293): each unsure word is a Review item under "Unsure words" with Hear, Fix text and Looks right; the last one marks the check.
  - Never a dead end: pressing a cut verb while the gate is open does not fail. The card shows one inline line above the action row: "The transcript isn't checked yet. Cut anyway?" with the primary "Cut anyway" and a text button "Check 3 words". "Cut anyway" records a waiver with the reason "Approved after listening in Review" plus the user name and applies the cut. A "Add a note" disclosure lets the user write their own reason. The prompt appears once per session; later cuts go through.
  - Bulk verbs while the gate is open show the same line in the group header.
  - Phone: the inline line sits above the two thumb buttons; no nested scroller.
- **Shared elements used:** Check row, Decision card, Review queue.
- **Story to build:** `Stages/Review/Review` stories `RefineCheck`, `CutAnywayPrompt`, `TranscriptChecked`.

### PNL-TIGHTEN · Tighten

- **Today:** `PNL-TIGHTEN--desktop-light.png`, `PNL-TIGHTEN--phone-light.png`. Search field, class chips, Track select, "Harsh cuts only", Intensity select, "Find hits", a disabled "Apply suggested actions (0)" and "0 of 0 hits". Pauses barely shorten (real-recording F06); apply-all has no progress (F01).
- **Fate:** merge. Finding runs automatically in Prepare (row 5) with "How tight" in Prepare's Cleanup; results become suggestion groups in the Review queue; "Find more" in the queue header reruns.
- **Spec:** the class filter becomes the queue's group headers; track filter becomes a speaker swatch filter in the Queue header's more menu; "Harsh cuts only" becomes a sort option "Most noticeable first". Apply suggested = each group's bulk verb with a Job row and one Undo (see SCR-REVIEW).
- **Shared elements used:** Review queue, Job row.
- **Story to build:** covered by `Stages/Review/Review` `BulkRunning` and `Stages/Review/Queue` `Groups`.
- **Shipped in PR 4 (#2293):** Find more, the Job row, the group bulk running row and `Cut all`; the Tighten tab, panel and `tighten.*` commands and keys are removed. A wire tab `tighten` from an older client lands on Queue. Not built, tracked in #2650: the speaker swatch filter, the "Most noticeable first" sort and the Just applied list.

### PNL-HISTORY · History

- **Today:** `PNL-HISTORY--desktop-light.png`, `PNL-HISTORY--phone-light.png`. Undo/Redo buttons, "1 step", raw entries like "render preview" with a full timestamp.
- **Fate:** replace with NEW History sheet reachable from every stage.
- **Spec:** long-press or right-click on the Undo button in the Stage bar (phone: long-press the undo in the mini player row) opens a popover 360 px: newest at top, one row per user-visible action in plain words with the verb icon ("Cut 11 fillers · 6.2 s", "Renamed guest to Jon"), relative time, author avatar for collaborators and agents. Clicking a row previews the project at that point (Transport plays it, a banner "Viewing 14:02" with "Go back to this" and "Return to now"). System entries (render preview) are hidden. Review's queue has the "Decided" group for decision-level history.
- **Shared elements used:** popover, Person tile avatar, Icon language.
- **Story to build:** `Stages/Frame/HistorySheet` stories `Recent`, `WithCollaborators`, `Previewing`, `Phone`.

### PNL-COMMENTS · Comments panel

- **Today:** `PNL-COMMENTS--desktop-light.png`, `PNL-COMMENTS--phone-light.png`. "Commenting as Host · Change", four filter tabs, a "Toggle comment mode" button, a composer with a separate "at 0:00" chip, cards with Reply fields and Resolve buttons stacked.
- **Fate:** merge into the Review queue (Comments group) and the Decision card for comments; composing moves to the Comment verb everywhere.
- **Spec:** comments are queue items. Their Decision card shows the thread (author avatar, name, relative time, body), the anchor ("18:36 to 18:41", tap plays it), action items as checkboxes, a reply field (one line, grows to 4), and the primary "Resolve" (Enter). R focuses reply. Composing a new comment happens from the Comment verb: C key, the comment button in the mini player, or the object action bar; it anchors at the playhead or selection and opens the composer inline in the queue at that time position. Filters live in the queue filter (Comments) and a "Resolved" toggle in the group header.
- **Shared elements used:** Review queue, Decision card, Comment verb, Person tile avatar.
- **Story to build:** `Stages/Review/CommentCard` stories `Open`, `WithActions`, `Replying`, `Resolved`, `Phone`.

### CMP-COMMENT-CARD and the comment parts (CommentCompose, CommentAnchorChip, CommentTimeChip, CommentAuthorLine, InlineEditInput)

- **Today:** seen in `PNL-COMMENTS--*`, `INS-COMMENT--*`. Author line shows lowercase role words ("host", "reviewer"); time chip and anchor chip are separate controls; Reply and Resolve are outlined boxes of equal weight; the inspector repeats the same comment as a form ("Author host / Status Open / Tracks reference").
- **Fate:** restyle into one Comment row (queue) and one Comment thread (card); INS-COMMENT is removed (the card is the inspector).
- **Spec:**
  - Comment row (queue, 56 px): avatar 24 px, first line of body, time in monospace, reply count glyph. Unread: 8 px accent dot.
  - Comment thread (card): author line = avatar + display name + relative time; body 15/22; anchor shown once as a time range button with a play glyph; edit own comment by clicking the body (InlineEditInput, Enter saves, Esc cancels); action items as checkboxes with the item text; reply composer; Resolve primary. Resolved threads show the comment-check icon and "Reopen" text button.
  - Composer: a single field with the anchor time as a leading chip inside the field ("18:36"), tap the chip to re-anchor to the playhead; Enter posts, ⇧Enter newline; on phone the Post button is an arrow icon 44 px inside the field's right edge.
  - Swipe left on a comment row (touch) = Resolve, with Undo toast.
- **Shared elements used:** Person tile avatar, Comment verb, Toast with Undo.
- **Story to build:** `Stages/Review/CommentCard` (as above) and `Stages/Review/Composer` stories `Empty`, `Anchored`, `Posting`, `Offline`, `GuestFirstPost`, `Phone`.

### CMP-GUEST-NAME · Guest name step (and CMP-GUEST-COMMENT)

- **Today:** `CMP-GUEST-NAME--desktop-light.png`, `CMP-GUEST-NAME--phone-light.png`. A full-width "Your name" field with an error-red border before any error, plus two post buttons ("Post as Guest", "Post comment").
- **Fate:** restyle into the composer.
- **Spec:** on a guest's first post, the composer grows a second line above the field: an avatar placeholder and "Your name" field (placeholder "Name, so the host knows who said it"), prefilled from this browser if known. One Post action; blank name posts as "Guest". The name is then shown as the guest's Person tile in presence and on every comment; change it by tapping their own avatar in the header.
- **Shared elements used:** Composer, Person tile.
- **Story to build:** `Stages/Review/Composer` `GuestFirstPost`.

### OVL-PENDING behavior · Suggestion on the timeline (approve / reject in place)

- **Today:** seen in `INS-PENDING--desktop-light.png`: a floating card "Cut 0.3s · pending" with "Edit timing", Approve, Reject over the lane; on phone the sheet stays open reading "Edit not found" after approving (phone F02).
- **Fate:** keep the behavior, restyle as the Suggestion visual plus the shared object action bar (Edit worker draws the timeline). This spec fixes the verbs and outcomes.
- **Spec:** selecting a Suggestion region shows the action bar with Hear A/B, Keep, the verb (Cut/Shorten/Lower). After the verb: the region becomes an applied cut marker, the selection moves to the next suggestion to the right (playhead does not move), and any sheet showing the decided suggestion closes or shows the next one. Never "Edit not found". Dragging edge handles adjusts bounds (snap to silence by default).
- **Shared elements used:** Suggestion, Object selection model, A/B audition.
- **Story to build:** `Stages/Edit/SuggestionOnTimeline` stories `Selected`, `AfterCut` (shared with the Edit worker).

### DLG-ASK-CONFIRM · Confirm and DLG-ASK-CONFIRM-BULK · Bulk confirm

- **Today:** `DLG-ASK-CONFIRM--*` ("Remove the reference track? Keep track / Remove track"), `DLG-ASK-CONFIRM-BULK--*` ("Approve 2 pending edits? … One Undo takes them back. Keep reviewing / Approve 2"). The bulk dialog itself says the action is undoable, yet blocks with a modal.
- **Fate:** remove for anything undoable (bulk verbs, remove track, touch blade, replace audio); keep a confirm only where undo is impossible.
- **Spec:** undoable actions run at once and show a Toast with Undo (6 s, and the History sheet after). The remaining confirms (Stop sharing a link, which breaks a URL people hold; End record room, Record worker) use an inline confirm inside the row that triggered it: the button turns into "Stop sharing?" with "Keep" focused and "Stop" in danger style, 44 px each. No modal.
- **Shared elements used:** Toast with Undo, inline confirm (CMP-INLINE-CONFIRM).
- **Story to build:** `Stages/Frame/InlineConfirm` stories `StopSharing`, `Phone`.

### Guest review experience (SCR-GUEST-VIEWER, -COMMENTER, -EDITOR, -MOBILE)

- **Today:** `SCR-GUEST-VIEWER--*`, `SCR-GUEST-COMMENTER--*`, `SCR-GUEST-EDITOR--*`, `SCR-GUEST-MOBILE--phone-light.png`. The guest sees the full host editor with two stacked text banners ("Shared comment view · You can comment and suggest edits", "Hearing "Share mix". This link follows the latest version…"), disabled tools they can't use, Shorter/Taller/Reset buttons; the phone shows a dark player card and "Open all".
- **Fate:** replace with Guest Review (reduced Review stage).
- **Spec:**
  - Frame: no Stage bar tabs for Viewer and Commenter (one stage, no switcher). Header 56 px: project name, under it in 13/16 meta the version ("Rough cut · 25 Oct") with a live glyph (two arrows circling = follows latest) or a pin glyph (frozen); right: presence avatars and the guest's own avatar (tap to set name). The Role chip sits next to the name (eye / bubble / pencil + word on desktop, icon only on phone with accessible name).
  - Commenter desktop body: center column 760 px: a **Player card** (240 px): large play button 64 px, timecode, the episode overview waveform with comment pins and Suggestion ticks, ±15 s buttons; under it the composer, ready (focused on load is off; first key press focuses it); under that the transcript, read-only with "Suggest a cut" on word selection (selection action bar shows Comment and Suggest cut). Left 320 px: the Queue reduced to Comments and "Your suggestions".
  - Viewer: same, no composer, no Suggest. A "Comment" control is absent, not disabled.
  - Editor: the Stage bar shows Review and Edit tabs only; Edit verbs apply directly (as today); Review shows everyone's suggestions with Cut/Keep enabled.
  - Phone (all roles): Player card at top (scrubber 44 px tall hit area), transcript below following the playhead, composer docked above the safe area (Commenter). Mini player is not used; the Player card collapses to a 64 px bar when the user scrolls the transcript.
  - Anticipated next action: press play, then comment at the moment. The composer's anchor chip tracks the playhead live while playing, so "pause, type" anchors to where they paused.
  - States: loading (skeleton of this layout), host asleep (Status cover), link revoked (Status cover).
- **Shared elements used:** Role chip (NEW), Player card (NEW, reuses Transport), Composer, Review queue, Person tile, Suggestion, Status cover.
- **Story to build:** `Stages/Review/Guest` stories `Viewer`, `Commenter`, `CommenterFirstComment`, `Editor`, `ViewerPhone`, `CommenterPhone`, `EditorPhone`.

### BAN-GUEST-ROLE · Guest role banner

- **Today:** `BAN-GUEST-ROLE--*`, `BAN-GUEST-ROLE-EDITOR--*`, `BAN-GUEST-ROLE-VIEWER--*`. Two full-width text rows above the transport, about 56 px of permanent prose.
- **Fate:** replace with the Role chip in the guest header.
- **Spec:** see Guest Review. Tapping the Role chip opens a popover with one sentence ("You can comment and suggest cuts. The host decides.") shown automatically once on first visit, anchored to the chip, dismissed by any tap.
- **Shared elements used:** Role chip, popover.
- **Story to build:** `Stages/Review/Guest` `FirstVisitRoleHint`.

### BAN-GUEST-VERSION · Newer version notice

- **Today:** no story, no shot (amber banner per guest-journeys.md).
- **Fate:** replace with an inline version pill in the guest header.
- **Spec:** following link: when the host publishes, the version line becomes an accent pill "New version: Intro fix · Listen" for 10 s, then stays as the version line with a 6 px accent dot until played. Playback position carries over by matching transcript words. Frozen link: nothing changes.
- **Shared elements used:** pill.
- **Story to build:** `Stages/Review/Guest` `NewVersion`.

### SCR-GUEST-OFFLINE · Offline guest and BAN-GUEST-ATTENTION · Needs attention

- **Today:** `SCR-GUEST-OFFLINE--*` (red "Couldn't reach the server" line that stays after reconnect, phone F08), `BAN-GUEST-ATTENTION--*-story.png` ("Needs attention 2 · Details", beige bar that pushes the editor down 45 px, real-recording F01).
- **Fate:** merge into the Save state dot and queue Check rows.
- **Spec:** offline: the Save state dot turns to a hollow cloud with a count ("2 waiting") in the header; posted comments show in the queue with a small clock glyph and a lower contrast until sent; they send by themselves on reconnect and the clock disappears. Conflicts (a guest suggestion that no longer fits a newer host edit) appear as Check rows in the guest's queue: "Your cut at 12:04 overlaps a newer edit" with Hear and "Suggest again here" / "Drop it". The host's Save state dot uses the same states. No banner.
- **Shared elements used:** Save state dot, Check row, Review queue.
- **Story to build:** `Stages/Review/Guest` `Offline`, `OfflineQueued`, `Conflict`, `Reconnected`.

### SCR-GUEST-LINK-INVALID · Dead link

- **Today:** `SCR-GUEST-LINK-INVALID--*`: raw JSON `{"detail":"not found"}`.
- **Fate:** merge into Status cover (`BadLink`).
- **Spec:** see SCR-ERROR. The page never shows JSON.
- **Shared elements used:** Status cover.
- **Story to build:** `Stages/Frame/StatusCover` `BadLink`.

### BAN-FOLLOW · Following banner, and presence (MENU-PEOPLE, OVL-PRESENCE, INT-FOLLOW)

- **Today:** `BAN-FOLLOW--desktop-light.png`: a full-width "Following Guest · Stop following" bar plus a duplicate "Following Guest · Dismiss" toast.
- **Fate:** replace with the followed person's avatar ring plus a compact pill.
- **Spec:** presence avatars (Person tiles at 28 px) in the Stage bar or guest header; each has a 2 px ring in that person's color and a small badge showing their stage (stage icon at 12 px). Click an avatar: popover with "Follow", "Go to where they are" (jumps once), and their current playhead time. Following: their avatar's ring thickens to 3 px, a 32 px pill "Following Rosa ×" appears beside the avatars, and a 2 px frame in their color outlines the content area. Esc or × stops; any edit by the follower stops following. One indicator, no toast.
- **Shared elements used:** Person tile, pill, Icon language (stage icons).
- **Story to build:** `Stages/Frame/Presence` stories `Avatars`, `Popover`, `Following`, `FollowingPhone`.

### BAN-LOADFAIL · Load failure banner

- **Today:** no shot; "Could not load transcript and history. Retry" as a page banner.
- **Fate:** replace with an in-place failure in the region that failed.
- **Spec:** the transcript region (or queue) shows its Status cover variant at region size: icon, "The transcript didn't load", "Try again". Other regions stay usable.
- **Shared elements used:** Status cover (region size).
- **Story to build:** `Stages/Frame/StatusCover` `RegionFailure`.

---

### Deliver stage

### SCR-DELIVER (new) · Deliver stage

- **Today:** Export, Bounce and Share are three modals off the Menu; chapters and social clips are marker-lane blobs with inspectors (`INS-CHAPTER--*`, `INS-SOCIAL--*`).
- **Fate:** replace with NEW Deliver page.
- **Spec:**
  - Layout desktop: single scrolling page in the stage frame, content max 1040 px. Top: **Readiness** (full width). Then two columns (640 / 376 px, 24 px gap): left **Episode file**, **Chapters**, **Clips**; right **Listen link** and the Export Job history ("Last export 2 h ago · Reveal").
  - Primary action: "Export" in the Episode file section (filled, 48 px, with export icon). It is the only filled button on the page.
  - Anticipated next action: export, then reveal or download the files, then send a listen link. After export finishes, the Episode file section shows "Reveal in Finder" (desktop app) or "Download" (browser, phone) as the new primary, and the Listen link section highlights "Copy link" as the follow-up.
  - Keyboard: ⌘E export, ⌘⇧C copy listen link.
  - Phone: one column in the order Readiness, Episode file, Listen link, Chapters, Clips; the Export button is fixed above the mini player until pressed.
  - States: never exported; exporting (Job row); exported and current (Deliver tab check); exported but stale ("Edited since export · Export again"); export failed (Job row red with plain cause and Try again).
- **Shared elements used:** Readiness check list, Check row, Job row, Link row (NEW), Model need row, Stage hand-off button (back to Review when items are open).
- **Story to build:** `Stages/Deliver/Deliver` stories `Ready`, `ItemsOpen`, `Exporting`, `Exported`, `Stale`, `Failed`, `Phone`, `PhoneExported`.

### Readiness check

- **Today:** none. The export (then a dialog) didn't warn about pending edits or stale mix (desktop F11).
- **Fate:** new.
- **Spec:** a list of Check rows, 48 px each, in two columns on desktop (one on phone): "Suggestions decided 14 of 14", "Comments resolved 2 of 3", "Unsure words checked 0 left", "Mix up to date", "Loudness −16.0 LUFS" (after export: measured; before: target with "will be checked"), "Peaks under −1.5 dBTP", "Chapters 5", "Edits saved 23.6 s" (the same number as Review). Each open row has a fix button that opens the right stage with the item selected ("Resolve" opens Review on that comment). The section title is a sentence that summarizes: "Ready to export" or "2 things left. You can still export." Nothing here blocks Export.
- **Shared elements used:** Readiness check list, Check row.
- **Story to build:** `Stages/Deliver/Readiness` stories `AllClear`, `ItemsOpen`, `AfterExport`, `Phone`.

### DLG-EXPORT · Export deliverables

- **Today:** `DLG-EXPORT--desktop-light.png`, `DLG-EXPORT--phone-light.png`. A paragraph explaining file replacement, a disabled WAV checkbox "Always written. Turn it off in the Pipeline tab", loudness explained in prose pointing to another tab; done state gives a relative path, no reveal, no download (desktop F11, narrow F10); captions go stale on re-export (real-recording F02).
- **Fate:** merge into SCR-DELIVER "Episode file".
- **Spec:** a row of format toggles as chips (MP3 on, WAV on, FLAC off), each with its size estimate; "Captions and transcript" always written and regenerated with every export (fixes stale SRT and Markdown); loudness segmented (Podcast −16 / Broadcast −23 / Streaming −14) mirrors Prepare's setting (one setting, two places). "Saves to Field Notes/export" with a "Change" text button. MP3 includes chapters when chapters exist (verify before stating as shipped; ui-philosophy §5). Export runs as a Job row inside the section ("Mastering · Writing MP3 · 60%", cancel); the user can leave the page. Done: file list with name, size, and per-file Reveal / Download icons; one primary "Reveal" or "Download all".
- **Shared elements used:** Job row, chip toggles, segmented control, Model need row.
- **Story to build:** `Stages/Deliver/EpisodeFile` stories `Settings`, `Exporting`, `Exported`, `ExportedPhone`, `NeedsModel`, `Failed`.
- **Shipped (#2451):** the host runs the real export job from this section and the dialog is gone. The format chips come from the Pipeline config (WAV always written as a note, MP3, M4A, FLAC), loudness is the sentence "Mastered to X LUFS, peaks under Y dBTP. Change the target in the Pipeline tab." in place of the segmented choice, and Range, "Saves to", Reveal and Download are hidden because nothing in the project backs them. Progress, Cancel with its reasons, the late-cancel list, Try again, the model prompt and the measured loudness are all in the section; the flow lives in `DawApp`, so leaving Deliver does not stop it.

### DLG-BOUNCE · Bounce (+ READY)

- **Today:** `DLG-BOUNCE--*`, `DLG-BOUNCE-READY--*`. A modal with radio sources, "Selected tracks (0)", a disabled "Limit to session region (no region set)", and "Also write MP3", even when a range is already selected on the timeline.
- **Fate:** replace with the Export verb on a selection (Edit's action bar) and a "Part of the episode" option in Episode file.
- **Spec:** with a range selected anywhere, the action bar's Export icon renders that range of the full mix as WAV immediately (Job row in a toast with Reveal / Download when done). A small chevron next to the icon opens a popover with: source segmented (Full mix / Selected tracks / Soloed) and "Also MP3". In Deliver, Episode file has "Whole episode / Part…" where Part shows In and Out scrub fields.
- **Shared elements used:** Object selection model (Export verb), Job row, popover.
- **Story to build:** `Stages/Edit/ExportRange` stories `Default`, `Options`, `Done` (coordinate with Edit worker); `Stages/Deliver/EpisodeFile` `PartOfEpisode`.
- **Shipped (#2449):** until the Export verb lands in Edit, the dialog is replaced by a Bounce section in Deliver (`Stages/Deliver/Bounce`): the source (Entire mix, Selected tracks, Soloed tracks), Limit to session region, Also write MP3, a range fixed in Edit, progress with Cancel, the files written, and the model prompt. `Mod+Shift+B`, the palette and Range actions → Bounce go to Deliver and focus the Bounce button; the flow lives in `DawApp`, so leaving Deliver does not stop it. Leaving Deliver ends the visit: it clears a fixed range and the bounce choices, while a running bounce continues.

### Share (was DLG-SHARE; incl. created state and record-link section)

- **Today:** `DLG-SHARE--*`, `DLG-SHARE-CREATED--*`. Three radio roles with explanations, two checkboxes with paragraphs, the created link hidden below the footer on phone (narrow F09), raw clipboard error ("Failed to execute 'writeText' on 'Clipboard'…") beside a toast "Review link created".
- **Fate:** replace with Link rows in two homes: review links in Review (header "Invite" button opens a popover), the listen link for the final in Deliver. **Record invites move to the Record stage (designed by the Record worker);** the record room section is removed from this surface, and the Link row element is shared with Record.
- **Spec:**
  - Link row (NEW, 64 px): Role chip as a segmented control (eye / bubble / pencil), the link text in monospace truncated in the middle, a primary "Copy" (link icon), a people count with avatars of who opened it, a pin toggle (frozen on this version, off = follows latest), and a more menu (Allow AI assistants, Stop sharing with inline confirm).
  - Creating: there is no Create button. Opening the Invite popover (Review) or the Listen link section (Deliver) shows a ready Link row with the right default role (Review: Commenter, follows latest; Deliver: Viewer, pinned to the exported version); the link is minted on first Copy. Copy shows "Copied" inside the button for 2 s. If the clipboard is blocked, the link text becomes selected and the button reads "Press ⌘C" (phone: opens the OS share sheet instead, which is also the default on phone).
  - No mix yet: the row reads "Make a mix to share" with "Refresh mix" as its action and mints after it finishes.
  - Online sharing state (tunnel): shown as a glyph on the Link row (globe filled = reachable from anywhere; globe slashed = only on this network) with a popover explaining in one sentence and the fix.
- **Shared elements used:** Link row (NEW), Role chip, Person tile, inline confirm, popover.
- **Story to build:** `Stages/Review/InvitePopover` stories `Default`, `Copied`, `ClipboardBlocked`, `NoMix`, `WithViewers`, `Phone`; `Stages/Deliver/ListenLink` stories `Default`, `Pinned`, `OfflineOnly`.
- **Shipped (#2450):** Deliver has a Share section (`Stages/Deliver/Share`). The header Invite, Project > Share… (`share.manage`) and the Record stage's Invite open Deliver on it, and the old Share dialog is gone. The section holds what the dialog did: the role (Viewer, Commenter, Editor; Commenter by default), Allow AI assistants (MCP), Freeze on the current version, Create review link, the live links (role, version, dates, address, Copy, Copy MCP URL, Stop sharing with its in-place confirm), the online sharing line, and record rooms (create, copy guest and producer links, replace a closed invite, End room, Open Record stage). A link only this network can open says so on its row. It stands in for the Listen link on Deliver, and the Share a listen link button now brings the section into focus.
  - **Where it differs from the spec above.** There is still a Create review link button: the link is made on the click that asks for it and copied in the same click (the copy starts with the click and takes the link when it arrives, so the browser still counts it as a gesture). Copy on a listed link only copies. When the browser refuses a copy, the row reads "Press Ctrl C" with the whole link selected, and no raw clipboard error shows. The role stays a three-way choice on the section, not a chip on each row.
  - **Not done in this part.** Record rooms stay in this section until the Record stage has its own.

### Social clips (INS-SOCIAL)

- **Today:** `INS-SOCIAL--desktop-light.png`, `INS-SOCIAL--phone-light.png`. An orange blob in an unlabeled marker row; inspector shows "Score 0.77", "Approved no", "Review required", number fields with Apply.
- **Fate:** replace with Clip cards in Deliver (and the same Suggestion visual on the marker lane in Edit).
- **Spec:** "Clips" section: horizontal row (desktop, 3 visible, 200 x 168 each) or vertical list (phone) of Clip cards: play button over a waveform of the clip, title (editable inline), duration, strength as one to three filled bars (never a decimal score), drag handles on the waveform to trim (snap to word boundaries), Keep (approve) and a more menu (Remove, Open in Edit). Approved clips export with the episode into `export/clips/` (WAV + sidecar) and appear as files in Episode file. "Find clips" text button reruns proposals. Empty: "No clip ideas yet. Find clips."
- **Shared elements used:** Suggestion (unapproved clip), A/B audition button style, Job row.
- **Story to build:** `Stages/Deliver/Clips` stories `Suggested`, `Trimming`, `Approved`, `Empty`, `Phone`.

### Chapters (INS-CHAPTER)

- **Today:** `INS-CHAPTER--desktop-light.png`, `INS-CHAPTER--phone-light.png`. A diamond on the marker lane; inspector with Title, Time as seconds "0" plus Apply, Delete as the top action.
- **Fate:** restyle as a list in Deliver; the marker lane remains the direct-manipulation surface in Edit.
- **Spec:** "Chapters" list, 44 px rows: time in monospace (scrub field, drag to retime, snaps to sentence starts), title (inline edit), play-from button, delete on hover (Undo toast). "Add at playhead" button at the end. Empty: "Chapters help listeners skip around. Add at playhead".
- **Shared elements used:** scrub field, Toast with Undo.
- **Story to build:** `Stages/Deliver/Chapters` stories `List`, `Editing`, `Empty`, `Phone`.

---

## 3. Shared vocabulary proposals (NEW)

- **NEW: Stage hand-off button.** A secondary-weight accent button (44 px tall desktop, 56 px phone) fixed at the bottom right of a stage's content, or above the mini player on phone. Anatomy: the next stage's icon, a sentence-case label with a reason ("Review 14 suggestions", "Deliver", "Back to Review · 2 new comments"), a trailing arrow. States: hidden while the stage's own work is unfinished and the stage has its own primary; promoted to primary (filled) when the stage is done. Keyboard ⌘Enter. Reused by every stage (Record: "Edit this session").
- **NEW: Source tile.** A large drop-and-tap target that starts content: icon 32 px, title, one line. Two kinds: Import audio (arrow into tray) and Record (accent circle). States: rest, drag-hover (2 px accent border, "Drop to add N files"), disabled with reason. Reused on Home, empty Prepare, Prepare's Sources column, and Record's "new session".
- **NEW: Project card.** Recent-project card: overview waveform strip, name, meta, stage status chip. States: rest, focus ring, processing (progress in chip), folder moved (dimmed + Find). Reused on Home and in the project-switcher popover from the project name.
- **NEW: Source card.** One audio source in Prepare: speaker color swatch, name field, file name and duration in meta, mini waveform, a live level preview on hover, and inline prompts (Split speakers, Replace). States: uploading, probing, ready, needs name, failed. Groups into recording sessions. The Record worker's landed takes become Source cards in a new session group.
- **NEW: Job row.** One background task: status glyph (Check row glyph set), plain title, detail line with numbers ("2 of 3 · about 1 min"), a 4 px progress bar, cancel (x, 40 px), and on failure "Try again" plus a Details disclosure. Never blocks other work. Reused for Prepare steps, model downloads, bulk review verbs, export, clip export, help report, split speakers. Replaces CMP-PIPELINE-CHIP's text and the stalled-no-progress gaps.
- **NEW: Check row.** A status line someone may need to act on: glyph (done, needs you, not yet, failed), label, value, one fix action. Reused in Readiness, Prepare (align move, approximate timing), Review's Checks group (unsure words, transcript check, conflicts, missing aligner), Help's report preview.
- **NEW: Model need row.** The in-place answer to "this needs a model": capability name, size, Get button (cloud icon), progress ring with cancel, and "Manage" link to the Models sheet. Appears inside a Job row or a Check row, never as its own modal. Replaces DLG-MODEL-GATE and DLG-WHISPER.
- **NEW: Review queue.** The list of everything awaiting a decision: header (progress sentence, filter icons with counts, Find more), groups (Checks, Comments, suggestion kinds, Decided) with bulk verbs, 56 px item rows. Keyboard J/K. Reused by host Review, guest Review (filtered), and as the phone queue sheet.
- **NEW: Decision card.** The focus surface for one queue item: kind line, plain title, transcript excerpt with the Suggestion visual, ±6 s waveform with edge handles, why line, A/B audition, action row (Later, Keep, verb). Comment and Check variants swap the body. On phone it is full screen with swipe gestures. The Edit stage's floating action bar uses the same verbs and icons.
- **NEW: Player card.** A larger Transport for listening-first contexts: 64 px play, timecode, overview waveform with pins and ticks, ±15 s. Used by guest Review and, at 64 px collapsed, as the phone mini player. Same controls and icons as the Transport, so not a second transport per window (it replaces it in that window).
- **NEW: Link row.** One shareable link: role segmented control (Role chips), middle-truncated URL, Copy (mints on first copy), opened-by avatars, pin to version, more menu (AI assistants, Stop sharing with inline confirm). Reused for review links (Review), listen link (Deliver), and guest/producer record links (Record stage).
- **NEW: Role chip.** Icon + word for a link role: eye (Viewer), speech bubble (Commenter), pencil (Editor), headphones (Producer, Record). Reused in Link rows, the guest header, presence popovers.
- **NEW: Status cover.** The one full-page (or region-size) "can't show this" layout: symbol, case icon, title, one sentence, one primary, at most one text button. Replaces SCR-ERROR, SCR-COVER, SCR-RECOVERY, SCR-GUEST-LINK-INVALID, BAN-LOADFAIL, and the Record dead ends (Record worker).
- **NEW: History sheet.** Popover from long-press/right-click on Undo in any stage: plain-word steps with verb icons and authors, preview a past point, "Go back to this". Replaces PNL-HISTORY.

Existing elements this spec reuses without change: Stage bar, Transport, Object selection model, Suggestion, Inspector sheet, A/B audition, Readiness check list, Person tile, Icon language, Save state dot (CMP-SAVEDOT, extended with the offline cloud state), Toast with Undo (TOAST-MAIN), inline confirm (CMP-INLINE-CONFIRM), segmented control, scrub field.

---

## 4. Open product questions for Caleb

1. **Does accepting a cut after listening count as checking the transcript?** Today approval is refused until someone runs "refine" or writes a waiver reason. Recommended default: yes. "Cut anyway" records a waiver with an automatic reason ("Approved after listening in Review") and the user's name, so approving is never a dead end, and the Checks group still offers the unsure-word pass.
2. **Should the word aligner be in the default download?** It adds 360 MB (about 2 GB total), and without it word timing is approximate, which is the main risk of clipping a real word. Recommended default: yes, include it in "Get ready".
3. **Should suggestion finding (fillers, pauses, sounds) run automatically after transcription?** It proposes only and never applies. Recommended default: yes, at "How tight: Medium", so Review is populated the first time the user opens it.
4. **Where should review links live, Review or Deliver?** Recommended default: review invites (Commenter, follows latest) in Review's header, and the final listen link (Viewer, pinned to the exported version) in Deliver. Both use the same Link row. The alternative is one Share section in Deliver only, as in the Direction C mock.
5. **Should swipe gestures on the phone Decision card be on by default?** Swiping right applies a cut. Every decision is undoable with a toast. Recommended default: on, with the 80 px threshold and the verb icon shown while dragging.
6. **Should Home open a project at the stage it needs next, or at the stage the user last had open?** Recommended default: the stage it needs next (Prepare while processing, Review if anything is undecided, otherwise Edit). Last-open stage is the fallback when nothing is waiting.
7. **Should Clips stay in Deliver?** Recommended default: yes, because clips are an output. Their markers stay visible in Edit's marker lane.
