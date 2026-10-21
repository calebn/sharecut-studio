# ShareCut Studio communication philosophy

This guide sets the voice, terminology, control placement, and ergonomics rules
for ShareCut Studio. It is the companion to the
[UI philosophy](ui-philosophy.md). Where the two overlap, the UI philosophy
wins; § [Reconciled with ui-philosophy](#reconciled-with-ui-philosophy) lists
each resolved conflict.

Like the UI philosophy, this guide states required behavior for new and changed
work. It does not claim that every current surface complies. "(Surface N)" tags
cite the six-surface interaction audit of 2026-09-21 in
[issue #80](https://github.com/calebn/sharecut-studio/issues/80). They record
why a rule exists, not what the current build does. Known gaps are tracked per
surface in #1026 (Recording), #1027 (Share), #1028 (Timeline), #1029
(Transcript and Tighten), #1030 (Navigation), #1031 (Feedback primitives), and
#1032 (cross-shell verification).

## Purpose

One voice, one set of ergonomics rules, applied evenly across every
surface of the app — transport, share, timeline, transcript, menus,
dialogs — and across shells (phone, tablet, desktop). This document
is written for contributors **and** for agents doing implementation
work: if you are adding copy, a control, a menu item, a dialog, or
feedback for an action, the answers are here. It is binding for new
and changed work: the PR checklist enforces it (see Governance below).

Scope: all user-facing copy and control placement in `gui/web`,
CLI help text, and user docs. Out of scope: marketing copy. How an
interaction is wired (one command, one selection table, one menu
primitive, one feedback channel, keyboard and touch twins) is the
[interaction system](interaction-system.md); this document owns what
the controls say and where they sit.

## Voice and tone

We sound like a calm collaborator, not an operator console and not a
cheerleader. Plain words. Verbs over nouns. Short sentences. No
exclamation points in UI copy. We never blame the user, and we never
make them feel the software is fragile.

- Name what happened and what changed, in that order.
  - Do: "Review link created and copied."
  - Don't: "Operation completed successfully."
- Name the consequence, not the mechanism.
  - Do: "End this record room? Both guest and producer links will
    stop working." (ShareDialog end-room copy — good words, wrong
    mechanism; see Errors and confirmations)
  - Don't: "Stop sharing coolname-xyz?" — tokens and IDs are
    addresses for machines, never labels for people. (Surface 2)
- Pair every problem statement with its fix.
  - Do: blockers as a list under the Start button, each with its fix
    action ("No guest has joined yet" → "Copy guest link"). (Surface 1)
  - Don't: a comma-joined wall of blockers far from the button they
    gate. (Surface 1)
- Teach in the empty moment, then get out of the way.
  - Do: "No tracks yet. Import Audio adds one dialogue track per
    file." (MobileShell — the pattern to copy)
  - Don't: "No live room snapshot yet. Mint a record room from
    Share…" — never send the user to another surface when the
    action can live here. (Surface 1)

## Terminology

Canonical terms. Use exactly these; update this table in the same PR
that introduces or renames a concept. The partner-facing
[UX glossary](../ux/pages/domain-glossary.md) explains product concepts
to UX partners; for UI copy, this table wins.

| Term | Meaning | Never say |
|---|---|---|
| Audio tools | The bundled FFmpeg and FFprobe pair needed for media work. Source installs supply a supported matching pair | "Download FFmpeg" in desktop setup |
| Review link | Async share for follow-along/comment/edit, no live session. It works until the host chooses Stop sharing | "share link"; "share" alone when record rooms also exist |
| Record room | The live recording room and its lobby/session | "session link", "call" |
| Guest link | Record-room link for the person being recorded | "guest role" |
| Producer link | Record-room link for silent watch/listen (not recorded) | "producer role" — producer is a **link type**, not a review role |
| Viewer / Commenter / Editor | Review-link roles, as in Google Docs. Viewer views and plays; Commenter also comments and suggests edits; Editor also edits directly and approves or rejects suggestions | "producer" in the role dropdown; "suggester" |
| MCP URL | The separate MCP server URL minted with a review link, for an AI assistant | "Agent URL", "agent link", "bot URL" |
| Allow AI assistants (MCP) | The opt-in control that mints an MCP URL. Helper text: "Paste into an MCP client such as Claude or ChatGPT. The assistant gets this link's permissions." | "Allow agent" |
| Take | One continuous recording pass | "clip" for a recording pass |
| Lobby | Pre-recording staging state | "waiting room" |
| Land | Finish a recording and ingest the takes. Disabled with its reason beside it until there is something to land; "Retry land" after a failed land | "save", "finalize" (a recording is "Saved to project"; Land places it on the timeline) |
| Stop take | End the open take for everyone in the record room. Stop sits alone behind a divider and asks once: "Stop this take? Recording ends for everyone in the room." [Keep recording] [Stop take] | "End take", "Finish recording" |
| Start blocker | One reason Start is disabled, listed under Start with its fix when the host has one: "No guest has joined yet." [Copy guest link], "Waiting for Ava to accept recording." | a comma-joined list of bare names |
| Full-quality recording | Each participant's lossless recording, captured on their own device and saved to the project during the session. Its status reads "Saving to project…", then "Saved to project", shown per participant and per segment wherever the host or a guest can see it. A segment is saved once the host holds the verified file; landing it on the timeline is the separate Land step. The copy kept on the person's device is "this device's copy". "Keeper" stays in code and schema only | "keeper", "local keeper", "local recording", "local backup", "uploading" |
| Save state | The host's project save light, a small dot with no visible text. Its name and tooltip read "Saving to project…", "Saved to project", "Not saved yet · 3 waiting to send", a refusal with "Edit and submit again", an unknown outcome with its recovery, or an unreadable saved queue with "Retry to read them". Shape carries the state with the colour: solid circle saved, ring saving, hollow circle waiting, square failed, dashed diamond unknown. The Needs attention banner is the text beside it and holds Send now, Retry, and Inspect History for hosts when needed. A guest with uncertain Undo or Redo asks the project owner to inspect History. It uses the record room's saving and saved words. Edits waiting to send are kept on this device. Desktop and tablet status bar, phone status row in every mode | "Synced", "Offline mode", "Autosave", "Error" |
| Undo waits for the save | An Undo or Redo pressed while an edit is still saving. A control that would wait says "Undo ready after save" (Redo likewise); a press says "Undo runs after save", then runs on the edit the person just made. A toast's Undo runs only if its change is still the newest step, and otherwise says "Can't undo: the project changed since. Nothing was undone." Never a dead control that only says to wait | "queued", "pending undo", "Wait for the current action to finish." on an Undo |
| Room tone | The track's own quiet ambient sound, laid into the gap a cut leaves. A track with none to lay gets a silent pad, and the cut still applies | "beat", "pad", a raw cause code such as `missing_seam` |
| Automatic reduction | Current-occurrence inspector for automatic audio reduction, rendered freshness and saved choices | A claim that stale rendered audio already reflects the saved choice |
| Restore original audio | Host choice to bypass one selected automatic reduction in this clip occurrence while retaining ordinary mutes and ignored words | A source-wide restore or a promise to remove every mute |
| Refresh regions | Recheck this occurrence and clear the selected region before another Restore | Silent retargeting of the previous selection |
| Undo Restore | Undo the acknowledged Restore only while its exact History head and project opening remain current | Success or Undo for a queued, unconfirmed or no-op reply |
| Move clip | Opens a local time-and-track placement preview in the Clip inspector. Apply move saves it; Cancel discards it | A drag-only instruction |
| Target track | The destination lane for the anchor clip; selected clips shift by lane order | "source track" for the destination |
| Timeline start (seconds) | The anchor clip's exact destination on the episode clock | Source start, which trims recorded audio |
| Shorter / Taller / Reset panel size | Local editor-panel sizing buttons. Steps are 1 rem; Reset clears the browser preference | A project edit or History action |
| Tighten hit | One candidate tightening decision | — |
| Likely laugh | The label on a Tighten hit whose sound rises and falls like a laugh. It is a hint, and its suggested action is Lower (when another speaker talks over it, otherwise it is left) | "Laugh detected", "filler:acoustic:likely_laugh" |
| Possible missed word | The label on a Tighten hit that the project's speech recogniser, hearing that sound alone, writes down as a word the transcript missed. It is a hint, and its suggested action is Leave, so Apply suggested actions keeps the audio and dismisses the hit (#1434) | "Missed word detected", "Rejected", "filler:acoustic:possible_word" |
| Apply suggested actions | The Tighten panel's one primary action: give every listed sound its own suggested action, with the count, `Apply suggested actions (3)`. One undo reverts it. Each row's own Apply and Skip decide one hit | "Apply all", "Accept all", "Apply eligible" |
| Suggested action | What the app proposes for a sound: cut, shorten, lower or leave, picked from one table per kind of sound. The label under each hit says which | "Auto-fix", "Safe", "Eligible" |
| Hold a word, then drag | The touch way to make a word range in Select mode: press and hold a word until it arms, then drag across more words. One finger moving before the hold scrolls and selects nothing. The Select hint names it instead of Mod+X | "long-press select", "drag to select" |
| Add word before / Add word after | The two Range actions buttons that grow the selected word range by one word at the start or the end, so a range needs no gesture. A press steps once; holding repeats. Disabled with its reason when there is no earlier or later word | "Extend left", "Extend right", "Grow" |
| Drop first word / Drop last word | The two Range actions buttons that trim the selected word range by one word at the start or the end. Disabled on a one-word range, with the reason beside it | "Shrink", "Trim start" for a word range |
| Pending edit | A proposed edit awaiting approve/reject | — |
| Suggest cut | Propose a cut from the transcript | — |
| Blade cut | Split at the playhead on the timeline, or at a held time from the touch create menu | "slice" |
| Armed | A timeline target a long press picked up on touch: only it drags, along its own axes, until the finger lifts | "grabbed", "drag mode" |
| Create menu | The touch menu a long press on empty timeline space opens: Add envelope point on the held lane, then Blade cut (with a line naming the tracks it cuts: the selected tracks, else every dialogue track), Add chapter and Add comment, at the held time | "context menu", "add menu" |
| Add comment | The one name, in the create menu and the command catalog (`comment.draftAt`), for starting a comment draft at a held time, as "Add chapter" and "Add envelope point" name their siblings | "Comment here" |
| Comment field | The always-visible field and **Post comment** button for anyone who can comment: docked above the phone mode bar in Listen, at the top of the Comments tab elsewhere. It needs no mode first, and Post enables once it has text | "Comment mode" for the field; "composer" in UI copy |
| Comment time | Where a new comment lands, shown as the "at 0:12" chip beside **Post comment**: the time picked on the ruler or chip, else the selected range, else the playhead. Pressing the chip changes it; a range keeps its range. A time it cannot use stays as it was, with one line beside the chip: "End must be after start" or "Try 0:42 or 0:20–0:30". When the comment's time is not the selected range, the chip says "Selection is 0:04–0:09" so the Inspector's range is not mistaken for it | "anchor" in UI copy; "Click the ruler" instructions |
| Select tool, Blade tool, Toggle comment mode | The three pointer tools by their command names, on a button, in the Menu, in the command palette and in the capabilities page. A compact button may show a short form only when the command declares one (`shortLabel`); every other word on a command's control is its catalog label or a declared variant, and a test walks them | "Select", "Blade", "Comment" for the tool buttons; "Cut at playhead" for Blade cut |
| Needs attention | The banner for edits waiting to send, conflicts and an unreadable queue. One string (`NEEDS_ATTENTION`) is the visible heading, the start of the region name and the start of the details control's name, so what a person reads is what a screen reader announces | "Attention", "View attention details" |
| Status sentences | The status row and the Activity chip read as sentences: "Mix finished", "Transcript failed", "Pipeline is running", "2 pending edits". A failed job adds its message after the sentence only as the host wrote it, with environment names, paths and ids replaced by the next step (`plainError`); a cancelled job adds nothing | "Pipeline: error", "Pending: 2", raw refusal text on a chip |
| Ripple | The edit mode that closes or opens time on every dialogue track, so speakers stay in sync. It is the word on the clip inspector's **Ripple delete** button and the Edit menu's Ripple delete, with the line "Delete leaves a gap. Ripple delete closes it on every dialogue track." under the pair. Its icon mark is a wave, drawn beside the word on a trim drag's readout and the touch peek strip | "ripple trim mode", "shift", "shuffle", "magnetic" |
| Leave a gap | The edit mode that leaves silence (or pastes over) and moves nothing else. The clip inspector's plain **Delete** button does it, and the hint under the Delete pair names it as "leaves a gap". Its icon mark is a broken flatline | "Leave gap", "gap mode", "lift", "non-ripple" |
| Solo on | The button shown while any track is soloed: in the corner above the track headers on desktop and tablet, in the status row and Mix sheet on phone. It reads "Solo on · Clear solo", and one press unsolos every track. Solo is listen-only: only you hear it | "solo mode", "solo active" |
| Implied mute | A track silent only because you soloed another track. Its row, lane and clips go grey like a saved mute; its M and identity stripe are dashed, because it is never saved | "auto-muted", "muted by solo" |
| No mix yet | The status when no mix is rendered (never rendered, or a failed render left none) and Full mix is silent. It replaces "Mix out of date" in the one status pill, chip and Menu item, with "· Refresh" only on a share that can refresh by hand. The host's mix updates on its own, and the pill reads "Updating mix…" while it does. A guest reads it without an action | "No preview", "No premix", a second pill beside "Mix out of date" |
| Split speakers | Turn one recording of several people into one track per speaker. Every track plays the same audio and goes quiet where someone else talks, so together they sound like the original. The host gives the speaker count and can mark a few seconds of each person as a voice sample; the dialog opens from the track inspector or the command palette. Undo puts the single track back | "diarize", "separate speakers", "demix", "unmix" |
| Voice sample | A few seconds of one person talking, kept from the selected range so Split speakers can tell similar voices apart. Listen replays it; Clear drops it | "enrollment", "profile", "voiceprint" |
| Move to {speaker} | Range action on one speaker-split track. It mutes the selected span here and reopens it on the named sibling track. Host only. One undo | "reattribute", "move clip", "swap speakers" |
| Overlapping speech | Two or more people talking at once in a split. It plays once, on the track of the speaker heard most, and the dialog says how long it lasts | "crosstalk" and "bleed" in UI copy (bleed is microphone leakage, a different thing) |
| Listen for | The result of a split names what to listen to before relying on the tracks: overlapping speech and unsure stretches | "warnings" |
| Unsure stretch | Time in a split where the speaker is unclear. The dialog says how long and asks the host to listen there before relying on the tracks | "low confidence" in UI copy (that term is for transcript words) |
| Bounce | Render the current mix | "export mix" |
| Deliverables | Mastered export set | "final export" |
| Stop sharing | Revoke a review link. Links don't expire, so this is how a review link ends (a date set on the CLI or MCP is the one exception) | "delete link" |
| End room | Shut down a record room (kills guest + producer links) | "close room" |
| Online sharing | Making this computer's review and record links reachable from the internet while it runs. Share's status line says what guests can do now, with any fix behind "How to fix" and the online sharing guide | "tunnel", "relay", "host token", "relay URL", a CLI command in UI copy |
| Guests can open your links | Online sharing is connected | "Online", "Connected" as a bare label |
| Reconnecting… | Online sharing lost its connection and is retrying; the line adds "Trying again in N s" (a still clock time under reduced motion). Guests may see a brief interruption | "Tunnel reconnecting", "Guests see Host offline" |
| Not reachable online | Online sharing is set up but guests can't open links: it failed, was refused, or stopped responding | "Offline", "Host offline", "Tunnel failed" |
| Sharing setup needs attention | The guest's line when the host's share registry is not private to the host's account, so the host's sharing refuses to run. The guest sees it as a request failure; the host sees the path and fix on their own computer (CLI, Share, owner tools). Never a path, `chmod` or command in guest copy | "internal error", "registry", "permissions", a raw path or `chmod` line |
| Review files need attention | The guest's line when the host's review files are not private to the host's account, so publishing a review mix refuses to run: "The host's review files need attention; ask the host to check them." The host sees the folder and fix on their own computer (CLI, owner tools). Never a path, `chmod` or command in guest copy | "internal error", "permissions", "staging", a raw path or `chmod` line |
| Isn't available right now | The guest's line when the host's review audio or project is missing: "This review's audio isn't available right now; ask the host to republish." or "This link isn't available right now; ask the host to check it." A refusal that would name a host path and has no line of its own reads "That didn't work; ask the host to check this episode." Fixed copy, never a path, folder name or part of one | "not found", "missing", "internal error", a raw path |
| Online sharing is off | Set up but not running, or stopped on purpose. Neutral, not an error. A host with no online sharing set up sees no line at all | "Offline", "Disconnected" |

Why this matters: Surface 2's audit found users confusing producer
(a record-room link) with the review-role dropdown — the table above
is the fix, enforced in copy review.

## Control placement rules

- **Bottom zone is for doing; top zone is for knowing.** Primary and
  frequent actions live in the bottom easy-reach zone; the top is
  reserved for titles, status, and infrequent controls. (Surfaces 1,
  3, 5 — the phone bottom nav and EditingToolRail are the reference
  implementations, with Undo and Redo in the compact inspector header
  while a selection is open and Zoom beside them; the REC chip stranded in
  the top bar is the violation, and zoom buried in the top overflow menu was
  one until #1028. Desktop uses visible transport Undo, Redo, Zoom out, and Zoom in under the owner decision in #1326.)
- **One primary action per view.** If two buttons compete, one of them
  is not primary — demote it. (Surface 3 bulk approve/reject.) Bulk
  approval follows [UI philosophy § 1](ui-philosophy.md#1-show-and-undo-every-automated-change):
  it applies to a reviewed pass, skips low-confidence items until a
  person reviews them, and is undone by one pass-level control near
  the result.
- **Danger gets distance.** Destructive actions are never adjacent to
  safe ones in a cluster: separate row, right-alignment with a
  divider, or an inline two-step confirm — pick one per surface and
  be consistent. (Surfaces 1, 2, 3, 5.)
- **Gated actions are disabled with the reason in place.** Never a dead
  click, never a surprise error after the round trip. Copy the
  ConsentGate pattern: disabled control + `aria-describedby` reason
  next to it. `Button`, `ToggleButton` and `CommandButton` omit the
  native `disabled` prop: pass `disabledReason="..."` (what is missing
  and what to do), and the control is disabled, titled and described
  with it. Only `undefined` means enabled; an empty or whitespace-only
  reason uses "This action is unavailable right now." `CommandButton`
  preserves an explicit blank reason and guards pointer activation. These
  generic shared controls still use native disabled buttons with title-based
  reasons; broader keyboard and touch discovery remains open under #1686. A
  focusable control such as transport Play or Stop uses `aria-disabled`,
  keeps the same node, guards activation, and points to a visible reason
  beside the controls. Remove the reason to restore activation. Applies to
  Land mid-take, Start with blockers, and Leave while uploads pend. (Surface 1.)
- **Mutually exclusive states get one contextual control.** Pause and
  Resume are one button that flips; never two buttons with one
  permanently disabled. (Surface 1.)
- **Dialogs become bottom sheets on phones**, with the primary action
  pinned to the bottom bar. Centered modals with mid-dialog actions
  and a 24px top-corner Close are a desktop pattern. (Surfaces 1, 2.)
- **Only offer actions that can succeed.** If the backend would reject
  it, the UI doesn't offer it — it explains what to do first.
  (Surface 1: Land gating.)

### Decision: Keep desktop history and zoom controls in the transport

<!-- decision
id: D-desktop-transport-history-zoom
status: accepted
date: 2026-10-13
decided-by: calebn
evidence:
- #1326 owner decision https://github.com/calebn/sharecut-studio/issues/1326#issuecomment-6151053529, add visible Undo, Redo, Zoom out, and Zoom in to the desktop transport
enforced-by:
- gui/web/src/layout/TransportBar.editControls.test.tsx::keeps history and zoom visible when desktop chrome collapses
- gui/web/src/layout/TransportBar.editControls.test.tsx::places history then zoom before tools on a wide desktop for an editor
-->

Desktop keeps **Undo**, **Redo**, **Zoom out**, and **Zoom in** visible in the
transport, including when its labeled chrome collapses. History actions follow
edit permissions and availability. This placement follows the owner's desktop
choice; phone and tablet keep their existing editing rail and compact inspector.

## Progressive disclosure rules

- **Surface the right controls at the right time.** Record-room
  creation lives where the user discovers they need it (RecordPanel
  empty state), not only in Share; link revocation lives in Share
  where links are managed. (Surfaces 1, 2.)
- **Every empty state ships with its recovery action.** No dead-end
  copy, no "go do it elsewhere" without a button that does it.
  (Surfaces 1, 6.)
- **Selecting something must offer actions.** A selection that yields
  no inspector, no toolbar, and no menu entry is a bug, not an edge
  case. (Surface 4: transcript range selection.)
- **Every capability is reachable on every shell that supports it.**
  If it ships on desktop, it has a touch path: Suggest cut, zoom, and
  the overflow menu must all be reachable on phone and tablet. It may
  sit one deliberate action away, as UI philosophy § 4 asks for
  multitrack, effects, and render options. A shell leaves a capability
  out only by a documented product decision in
  [gui-mobile.md](gui-mobile.md), never by omission. (Surfaces 3, 4, 5.)
- **Frequent actions have a direct control.** Menus are shortcuts, not
  the only path, for frequent actions: those belong in the main UI,
  such as the tool rail or the bottom zone. Infrequent actions may live
  only in More or the overflow menu, as long as that path exists on
  every shell. (Surfaces 3, 5 — Apple HIG.)
- **Defaults are opt-in (least privilege).** A control that mints
  externally visible artifacts (e.g. "Allow AI assistants (MCP)" minting an
  MCP URL on every share) starts OFF. The consequence is disclosed
  adjacent to the control so the opt-in is informed: in ShareDialog the
  helper text sits under the checkbox and is its accessible description.
  (Surface 2; maintainer decision 2026-09-21: MCP stays opt-in.)

## Empty states

Pattern: **what** (one line) + **why it matters** (only if not
obvious) + **the recovery action as a button**. The action is part of
the empty state, not a separate discovery task.

- Do: "No tracks yet. Import Audio adds one dialogue track per
  file." [Import audio]
- Do: "No record room yet. Creating one copies a guest link you can
  send." [Create record room] (replaces the "Mint a record room from
  Share…" dead end — Surface 1)
- Don't: bare "No comments in this filter." with no path back to the
  unfiltered list. (Surface 6 copy inconsistency)
- Keep voice consistent: "No {things} yet" + action. Audit existing
  copy against this when touching a surface. (Surface 6)

## Errors and confirmations

- **Destructive confirmations use the app's `Dialog` with a
  `Button variant="danger"` action — never `window.confirm()`.**
  Native confirms are unstyled, can't carry consequences, and bypass
  the announce pipeline. Code asks with `gui/web/src/feedback/ask.ts`:
  `await askConfirm(...)` opens the app's `AskDialog` (the shared
  `Dialog`, a bottom sheet on phones) with the consequence, Keep first
  and focused, and the action last, `danger` when it discards work;
  `await askText(...)` replaces `window.prompt()` with a `Field`. While
  either is open it holds every app shortcut, as the native `confirm()`
  did, so nothing changes behind the question. #1027
  and #1031 replaced every native dialog, and oxlint's `no-alert` rule
  rejects new ones (see Governance). The
  blade-cut confirm sheet in `EditingToolRail` (named target, time,
  Cancel safe-left, action right) is the model. Inside an open
  `Dialog`, confirm in place with `ui/InlineConfirm` instead of
  stacking a second dialog: the row swaps its actions for the
  consequence, Keep first and focused, the danger action last. Escape
  keeps (cancels) the open confirm before it closes the dialog. The
  Share dialog's Stop sharing and End room are the reference.
  (Surfaces 2, 5, 6.)
- **Confirm copy names the target and the consequence** in human
  terms: "Stop sharing this Viewer link? Anyone using it loses access.
  [Keep link] [Stop sharing]". Never a raw token. (Surface 2.)
- **Feedback must be visible, not screen-reader-only.** Every
  `announceStatus` shows the same string in the app toast
  (`feedback/FeedbackToast`, built on `ui/Toast`): one toast at a time,
  centred at the bottom above the status bar on desktop and tablet. On a
  phone it docks above bottom chrome. A visible compact inspector instead
  supplies a host first inside the same body scroller as its fields, below
  the pinned header. Feedback preserves selected half and full heights. A focused
  field or just-pressed control keeps its place when feedback arrives. When
  feedback and a full native label cannot fit together, ordinary body scrolling
  exposes either. The same card pauses expiry while clipped and retains its
  remaining visible time across host changes. Undo, Redo, resize and Close stay
  fully visible. Keeping visible controls and native labels clear is required;
  compact feedback participates in layout rather than covering fields
  ([gui-mobile.md § Feedback toast](gui-mobile.md#feedback-toast)). The shell's single
  live region speaks it, once per announcement, even when the same text
  repeats.
  Only a status that a persistent control already shows (the job chip,
  the presence avatars, the Needs attention summary) passes
  `{ toast: false }`. The Comments panel resolves through the same toast, with
  a `reverse` Undo that reopens the comment. A failure passes
  `{ tone: "error" }` and reads in the error look: it names what failed and the
  next step, never an environment variable, a path or an id. A message about a
  gesture (a target armed) passes `{ gesture: true }` and clears when the
  gesture ends or the mode changes. A multi-minute
  export whose only "done" signal is invisible is a high-severity bug.
  (Surface 6.)
- **A press answers at once, and a long one says it is working.** Make the
  action fast first: a slow command is a defect to fix, not a state to
  decorate. Work that stays long after that shows, in place beside the
  control that started it, what is running ("Approving 86 edits…") and, past
  two seconds, how long it has run. It shows no percent unless the host reports
  a real total ([progress.md](progress.md)). The control stays disabled with
  the busy reason, and the status clears when the command ends, leaving the
  result toast and its Undo. Impact's Approve all and Reject all are the
  reference (#1491). A job that outlives the panel belongs on the Activity chip.
- **Destructive list actions get toast-with-undo.** Approve, reject,
  skip, blade, trim: after the mutation, a transient confirmation
  with an Undo action. The History tab is the backstop, not the
  interface. (Surfaces 3, 4.) A reviewed-pass approval gets one
  pass-level undo, per UI philosophy § 1. Pass `{ undo:
  replyHistoryHead(reply) }` to `announceStatus`: the toast's Undo names
  the history entry the command recorded, shows only while that entry is
  the latest, and goes away once anything else moves history. The server
  refuses an undo whose entry is no longer the latest, and the toast then
  says "Can't undo: the project changed since. Nothing was undone.", so
  it never reverses someone else's edit. An Undo or Redo pressed while this
  tab's own edit is still saving waits for that edit and then runs on it, so
  it never reverses the edit before the slow one and the tap is never lost.
  A control whose Undo or Redo would wait says so in place, "Undo ready after
  save" (the toast's note, the header button's description), and a press says
  "Undo runs after save" on every surface (toast note, status line for Mod+Z,
  header and gesture) instead of looking dead. A toast's Undo stays pressable
  while an edit is saving: the press waits for the save and runs only if the
  toast's change is still the newest step. If a later edit landed first, the
  server refuses and the status says "Can't undo: the project changed since.
  Nothing was undone." The refusal always shows as a toast in place of the
  toast whose Undo was refused, so the Undo button never disappears without a
  reason; only a toast that still offers Undo for a different, newer step keeps
  its place (#1690). For a logical approval recorded across two commands,
  the first toast's Undo is refused and the pass toast's Undo takes back both
  edits (#1677). Tighten apply, skip and Apply
  eligible, transcript word fixes, Suppress, Ignore and Restore, a range Cut or
  Mute, single pending-edit Approve and Reject, Impact's Approve all and Reject all (which ask first with the pending-edit and track counts), track reorder and track removal offer it; blade, trim and the other timeline edits
  still need to adopt it.
- A stale fade gesture says "This clip changed. Nothing was saved. Adjust the
  fade again." Timeline handles and phone nudges use the visible announcement;
  Clip Inspector shows the error inline. Repeat the gesture against current values.
- A server that never answers says what happened to the work. A save
  waiting on it says "The server didn't answer. Nothing was saved." The
  Adjust boundary dialog saves nothing while it loads, so a hung load says
  "The server didn't answer. Try again." and offers **Try again**, which loads
  the controls in place with the same "Preparing boundary controls…" progress.
  A network failure says "The boundary couldn't load. Check your connection and
  try again." and also offers **Try again**. A stale load keeps **Reload boundary**;
  an error a second attempt cannot fix offers neither. Both recovery actions move
  focus to progress, then to the boundary control when it is ready. The banner over a project whose transcript and history never
  loaded says "Could not load transcript and history. The server didn't
  answer." with a **Retry** button.
- **Form errors are wired, not just shown.** `Field` sets
  `aria-describedby` to its error; `InlineError` carries
  `role="alert"`. Fix the primitives once; every caller inherits it.
  (Surface 6; #1031 moved this into the primitives: `Field` owns the
  ids and hands its control `aria-describedby` and `aria-invalid`
  through a render prop.)
- **Announce each error once, at the urgency it deserves.** An error
  caused by what the person just did is assertive (`InlineError`'s
  default, `role="alert"`). An error kept in loaded or background
  state, such as a failed job or a settings load, is polite
  (`origin="state"`, `role="status"`) and speaks only when it arrives;
  showing the saved line again after a tab switch or remount stays
  silent.
- **Heavyweight actions get a dialog, not a menu item.** Starting a
  minutes-long mastered export from one menu tap with no cancel is
  the wrong weight for the interaction — give it the bounce-dialog
  treatment. (Surface 5.)

## Copy patterns for buttons and links

- **Verb-first labels.** "Create link", "Copy guest link", "Stop
  sharing", "End room", "Open room panel", "Import audio". Never
  "Click here", never a bare noun that hides the action.
- **Decision actions first.** In action rows, the actual decisions
  lead: Apply / Skip before Preview / Go to. Most-likely-first in
  menus too. (Surfaces 4, 5.)
- **Menus: grouped, ordered, short, single.** Related items grouped
  with separators; most frequent at top of group; destructive last;
  no duplicated paths to the same action ("Open room panel" twice in
  one dialog — Surface 2); the overflow "Project" section keeps New /
  Open, then the Export pair adjacent, then Share / Record room, with
  Help under View. (Surface 5 — Apple HIG menu grouping.)
- **Announce what happened + what changed:** "Review link created and
  copied", "Record room ended", "Exported 3 files". The toast text
  and the `announceStatus` text are the same string. (Surface 6.)

## Mobile ergonomics checklist

Apply to every PR that touches `gui/web`. Each item traces to an
audited finding.

- [ ] Primary and frequent actions are in the bottom reach zone; the
  top holds titles/status/infrequent controls only.
- [ ] Every interactive target is at least 44 CSS px (2.75rem), or
  has invisible hit-area expansion (`::before`/`::after` slop) on
  coarse pointers (every `.ui-control` variant and action pill carries `--touch-min` on a coarse pointer through one rule in `ui.css`, #1315, #1388). Token floor: `--tap-min` ≥ 2.75rem (today 1.5rem in
  `gui/web/src/styles/theme/brand-tokens.css`; #1032 tracks target-size coverage).
- [ ] Dense canvas targets (envelope points, edges of short clips, pending
  handles) may draw smaller than 44 CSS px only through the dense-target
  pattern: the hit area grows invisibly toward 44 px where there is room; a
  crowded touch resolves to the nearest target, with a way to pick the exact
  target when several sit under the finger (design in #1051); the selected
  target is fully editable from 44 px inspector controls (numeric fields and
  nudges), so no edit needs a precise drag; zoom and a magnifier help while
  dragging; and the keyboard steps through targets. This is WCAG's
  "equivalent control" exception (2.5.5, 2.5.8) plus a dragging alternative
  (2.5.7).
  `gui/web/e2e/touch-floor.spec.ts` sweeps every control on a coarse pointer
  (every phone mode, the tablet and landscape shells and the transport menu) and fails on any under 44 CSS px that is not one
  of its named exceptions: canvas dense targets (the trim handles, fade
  corners, comment pins and the pending edit's hit area and handles, whose
  size follows time on the timeline; a selected pending edit grows its
  handles to 44 px, and the Comments and Edits lists are the equivalent
  controls), inline transcript words and
  timestamps, but not the speaker button (a taller hit area would take the
  next line's taps; the ruler and transport seek at 44 px), the track reorder grip (Move up/down are the
  44 px equivalent), and tablet status chips (the tab strip carries the same
  actions). A new exception needs a line there and here (#1422).
- [ ] No hover-only, mouse-only, or double-click-only path for any
  core flow; drags and gestures use pointer events.
- [ ] Dialogs render as bottom sheets on phone viewports; primary
  action pinned to the bottom bar; Close has a 44px target.
- [ ] Every pointer action has a keyboard path (real `<button>`s, not
  handler-spans; visible focus).
- [ ] The feature is reachable in all three shells (phone / tablet /
  desktop) — check the More hub, the overflow menu, and the tool
  rail, not just the desktop layout.
- [ ] Mutations offer local undo or toast-with-undo; undo is reachable
  near the action, not only in History.
- [ ] Empty states include the recovery action; error states name the
  fix.
- [ ] No `window.confirm()`, `alert()` or `prompt()` (lint rejects
  them); destructive actions ask with `askConfirm` (or `InlineConfirm`
  inside an open dialog) with a `danger` action and consequence-naming
  copy, spatially separated from safe actions.
- [ ] Copy uses the Terminology table verbs-first; no raw tokens/IDs
  in user-facing strings.

## Governance and discoverability

**Canon.** This document lives at `docs/communication-philosophy.md`
and is the single source of truth for voice, terminology, control
placement, and ergonomics. The [UI philosophy](ui-philosophy.md) wins
where the two overlap. This document is linked from all of these so a
new contributor or agent finds it in under a minute:

1. `AGENTS.md` — the Architecture list and the "Docs in sync" table
   (row `user-facing-copy-and-controls` in
   [`contracts/docs-sync.json`](../contracts/docs-sync.json)).
2. `docs/contributing.md` — frontend section; the PR checklist item
   below lives here.
3. `README.md` — one line in the Documentation list.
4. `ux/` onboarding pack — linked from [`ux/README.md`](../ux/README.md)
   and the UX brief. This document is a trigger of the `ux-pack` gate
   rule in `contracts/docs-sync.json`, so a change here fails CI
   unless the pack is updated or the rule is waived.
5. `.agents/rules/gui-styling.md` — for target size and placement.

**Enforcement.**

- PR checklist item (in `docs/contributing.md`): "User-facing copy and
  control placement follow `docs/communication-philosophy.md`
  (terminology table, placement rules, mobile checklist)."
- Existing checks carry specific rules. oxlint's `no-alert` rule
  (`gui/web/.oxlintrc.json`) is an error with no per-file exceptions,
  so any `alert()`, `confirm()` or `prompt()` call fails lint. axe
  runs in Vitest (`gui/web/src/test/a11y.ts`) and Playwright
  (`make test-web-e2e`) and catches missing names, invalid roles, and
  missing labels. `Field` wires its own hint and error, and its tests
  pin that. axe does not check that every target meets 44px; review
  checks that until #1032 lands.
- The `user-facing-copy-and-controls` docs-sync row is advisory. It
  cannot detect a renamed concept, so copy review is what keeps the
  Terminology table current.
- Overrides require explicit maintainer approval — same convention
  as the existing "no `*-disable` / `noqa` without explicit
  approval" rule. `window.confirm()` and sub-44px targets outside
  the dense-target pattern are "never" rules: ship them only with
  maintainer sign-off recorded in the PR. A terminology slip is
  fixed in copy review and needs no sign-off.

**Evolution.**

- Changes come as PRs against `docs/communication-philosophy.md`,
  approved by the maintainer (calebn). Minor copy-pattern additions
  may ride along with the feature PR that motivates them; new rules
  or terminology changes get their own PR.
- Agents pick up updates automatically: the doc is linked from
  `AGENTS.md`, which is live context — no caching, no separate
  sync step. When a rule changes, the PR updates the checklist and
  the ux-pack trigger in the same change.
- If a change here conflicts with the UI philosophy, call out the
  conflict in the PR for a decision and record the outcome in
  § Reconciled with ui-philosophy.
- Keep a short "Changelog" section at the bottom of the doc noting
  date, rule added/changed, and motivating finding, so future
  audits can trace why each rule exists.

## Reconciled with ui-philosophy

### Decision: This guide is canon; the UI philosophy wins on conflict

<!-- decision
id: D-communication-guide-canon
status: accepted
date: 2026-10-06
decided-by: calebn
evidence:
- #80 owner: "Land the communication draft below as written."
- #80 owner: "Where it conflicts with the published `docs/ui-philosophy.md`, the published doc wins."
- #1025: "each conflict is resolved explicitly in the PR. Owner reviews the PR."
- #1038 owner review approved it, keeping "MCP URL", renaming keeper to "Full-quality recording", and allowing a dense-target exception to 44 px
enforced-by:
- docs-sync: ux-pack
- docs-sync: user-facing-copy-and-controls
manual-review: the owner reviews each PR that changes user-facing copy or controls against this guide (contributing.md PR checklist)
-->

The draft in issue #80 landed as written except for these conflicts with the
[UI philosophy](ui-philosophy.md). The owner decided on 2026-10-06 that the UI
philosophy wins each one.

1. **Rule status.** The draft called itself "binding, not aspirational" and
   its checklist "audited findings, not aspirations". The UI philosophy states
   requirements and says they are not evidence of shipped behavior. This guide
   now binds new and changed work and makes no compliance claim about current
   surfaces. The surface issues track the gaps.
2. **Precedence.** The draft named itself the single source of truth. The UI
   philosophy says to raise a conflict in the PR for a decision. This guide is
   the source for voice, terminology, placement, and ergonomics, the UI
   philosophy wins on overlap, and new conflicts go to the PR.
3. **Menu-only actions.** The draft said every menu action must also be in the
   main UI. UI philosophy § 4 lets infrequent actions live in More or the
   overflow menu. Only frequent actions now need a direct control.
4. **Capabilities per shell.** The draft required every desktop capability on
   every shell. UI philosophy § 4 keeps some options one deliberate action away
   and speaks of actions "on a shell that supports it". A capability may now
   sit one action away, and a shell drops one only by a documented decision.
5. **Touch target floor.** The draft said 44pt/48dp. UI philosophy § 7 says at
   least 44 px. The floor is 44 CSS px (2.75rem). Dense canvas targets meet it
   through the dense-target pattern in the mobile checklist, which § 7 now
   names too.
6. **Bulk approval and undo.** The draft asked for toast-with-undo on each
   approve and left bulk approve open. UI philosophy §§ 1 and 3 limit bulk
   approval to a reviewed pass without low-confidence items and give it one
   pass-level undo. Both rules now say so.

One more change comes from the owner's share-link decision of 2026-10-06, not
from the UI philosophy. Links do not expire and are revoked by hand. The
draft's "expiry management lives in Share" now reads "link revocation", and the
example confirm no longer mentions expiry. #1027 removed the Share dialog's
record-link expiry copy; the dialog now says links don't expire.

The port also corrected references that no longer matched the code. The
`ux-pack` rule in `contracts/docs-sync.json` replaced
`scripts/check_ux_pack_sync.py`. The repo has no PR template, so the checklist
item lives in `docs/contributing.md`. `Dialog` has no `danger` variant;
`Button` does. The automatic `Field` and `InlineError` wiring was not
shipped at the port; #1031 shipped it. The adjacent MCP note shipped in #1027.

## Changelog

- 2026-09-21 — Initial draft from the 6-surface interaction audit.
- 2026-10-06 — Landed as canon (#1025). Reconciled with the UI philosophy,
  aligned with non-expiring share links, and scheduled oxlint `no-alert`
  with #1031.
- 2026-10-06 — Owner terminology and target decisions (#1038 review): MCP URL
  and "Allow AI assistants (MCP)" keep the MCP keyword; "full-quality
  recording" replaces "keeper"; Commenter suggests, as in Google Docs (#1050);
  the dense-target pattern for canvas targets (#1051 designs disambiguation);
  terminology slips are a review fix, not a sign-off rule.
- 2026-10-06 — Online sharing terms (#1091 review): the Share dialog's status
  line names what guests can do ("Guests can open your links", "Not reachable
  online", "Online sharing is off") instead of the tunnel, relay or host token,
  keeps any fix behind "How to fix", and shows nothing to a local-only host.
- 2026-10-06 — Added "Solo on" and "Implied mute" (#1102): the global solo
  button above the track headers and the grey, dashed state of a track your
  solo silences.
- 2026-10-06 — Added "No mix yet" (#1113): the one mix status pill says when
  Full mix is silent instead of leaving it in a tooltip, and a guest reads it
  without a Refresh action.
- 2026-10-06 — Added "Ripple", "Leave a gap" and "Cut anyway" (#1137): one
  edit mode for trim, delete, cut and paste, and the dialog a ripple opens
  before it cuts another speaker, naming who, when and what they said.
- 2026-10-06 — Added "Armed" and "Create menu", widened "Blade cut" to a held
  time, and drew the Ripple wave beside the word on a trim drag (#1051 round
  4b, #1135): the touch grammar's long press, its create menu, and the ripple
  mark a trim drag shows.
- 2026-10-07 — Create menu copy (#1181 round 8): "Add comment" is the one name
  for `comment.draftAt` (the menu said "Add comment", the catalog "Comment
  here"), and Blade cut sits apart from the held lane's entry with a line
  naming the tracks it cuts, since it cuts the selected tracks and not the lane
  it was held on.
- 2026-10-08 — Undo while an edit is still saving (#1181 round 9): once the
  wait for the tab's own saves runs out, Undo and Redo run nothing and say so,
  in the same plain form as the stale-head refusal (superseded 2026-10-16,
  #1675: they wait with no cutoff and then run). The roll across a gap that
  the server refuses reads "These clips have a gap between them, so there is
  no join to roll. Move one clip to touch the other, or trim an edge instead."
- 2026-10-07 — Share dialog (#1027): Stop sharing and End room confirm in
  place with `ui/InlineConfirm` (Keep first, danger last), the MCP opt-in
  shows its consequence note, and the example confirm lists Keep first. Six
  native dialogs remain for #1031.
- 2026-10-07 — Added "Stop take" and "Start blocker" and tightened "Land"
  (#1026): the Record room panel's in-place empty state, one take control,
  Stop's one-time question (the shared `ui/InlineConfirm`), and Land and
  Start reasons in place.
- 2026-10-07 — Escape inside an open `InlineConfirm` keeps the choice instead of
  closing the whole dialog (#1151).
- 2026-10-07 — Full-quality recording copy and status (#1148, from the #1038
  decision): "keeper", "local keeper", "local recording" and "local backup"
  leave every user-visible string (host panel, guest pages, errors, download
  names, MCP and CLI descriptions) for "full-quality recording" and "this
  device's copy". The status is "Saving to project…", then "Saved to project",
  per participant and segment. Land keeps its meaning.
- 2026-10-07 — Navigation (#1030): Export deliverables… opens a dialog
  (formats, progress with Cancel export, then the written files) instead of
  starting from one menu tap; the phone Listen hero carries the Menu; the Menu
  keeps Bounce… and Export deliverables… together between New / Open and
  Share / Record room; the command palette is **Commands and shortcuts**,
  searchable from **?** or More → **Search commands**.
- 2026-10-07 — Feedback primitives (#1031): every announcement shows in the
  app toast with a scoped Undo where history recorded the change; the last
  native dialogs became `askConfirm` / `askText` in `AskDialog`; oxlint
  `no-alert` is an error; `Field` wires its hint and error. Review round:
  the toast's Undo names its history entry and the server refuses it once
  another edit is the latest ("Can't undo: the project changed since.
  Nothing was undone."); `InlineError` alerts for action errors and
  speaks saved-state errors politely, once. Second review round: on
  phones the toast docks above the highest bottom chrome shown (sheet,
  Timeline tool rail, mode nav) and below the transport, so it covers
  no controls; a repeated identical announcement is spoken again; a
  refused undo is announced once. Third review round: an open confirm
  holds every app shortcut as the native `confirm()` did (Mod+Z no
  longer undoes behind it), names its consequence as the dialog's
  description, and returns focus to the control that opened it in
  Safari too; the toast steps off the control just pressed.

- 2026-10-16 Undo and Redo pressed while this tab's own edit is still saving wait for it and then run (#1675); the five-second "Your last edit is still saving" refusal is gone. (Superseded for the toast's Undo on 2026-10-17.)
- 2026-10-17 Undo says when it waits for a save (#1680, #1679, #1681): the toast, Mod+Z and the header Undo show "Undo ready after save" while a save, send or offline drain runs and "Undo runs after save" once pressed. A toast's Undo is no longer disabled while saving; the press waits and runs only if its change is still the newest step, otherwise "Can't undo: the project changed since. Nothing was undone." Added "Undo waits for the save".
- 2026-10-16 An Approve all that asks Cut anyway is one Undo (#1677): the Cut anyway toast counts the whole pass ("Approved 10 pending edits") and any Undo takes back both parts, so the dialog's "One Undo takes them back" is true.
- 2026-10-16 The envelope-point select, the effect Bypass toggles and the comment composer's fields and track picks hold the 44 px floor on touch (#1445); the reachability sweep also covers the clip sheet, the Comments panel and a track with an envelope and an effect chain.
- 2026-10-16 The phone Mix sheet shows **Plays at {dB}** over a fader whose track has a volume envelope (#1645), so a phone host can read the level at the playhead without opening the inspector. It stays plain text.
- 2026-10-16 The track header's **Out** readout follows the volume envelope at the playhead (#1642): it is the gain the mix plays (staging, saved volume and envelope), and silence reads `−∞ dB`. It stays plain text, so playback does not announce it.
- 2026-10-16 Tighten shows **Just applied (N)** after Apply suggested actions (#1607): the sounds of the latest batch, each with its action in a select. Changing one keeps the others and stays one undo step; the list goes away once another edit follows, and it is host-only. No progress indicator: the change lands like any other edit.
- 2026-10-15 Panel interiors hold the touch floor and stay clear of sticky chrome (#1445): on touch the Pipeline panel's selects, From / Only shortcuts row and the More hub's back button are 44 px; at large text or in a short window the Pipeline toolbar stops sticking and the Transcript panel scrolls as a whole; the reachability sweep now covers both panels.
- 2026-10-18 The Pipeline toolbar always scrolls now to preserve reachability (#1033); viewport-resize retention does not require one browser-specific scroll anchor.
- 2026-10-15 Split speakers (#1319): each speaker in the dialog has **Use selection** to keep the selected range as a **voice sample**, with **Listen** and **Clear**; the done view suggests undoing and marking samples when two tracks sound like one person. Added "Voice sample".
- 2026-10-12 Split speakers (#1095 phase 2): the track inspector's **Split speakers…** opens a dialog for the speaker count and optional names, shows progress with **Cancel split**, then the new tracks, what to listen for and one **Undo split**. Added "Split speakers", "Overlapping speech" and "Unsure stretch"; the empty-session coach and the phone hint tell people with one recording of everyone where to go.
- 2026-10-14 Move to speaker (#1341). Range actions on one speaker-split track offer **Move to {speaker}** for each sibling. It mutes the span here and reopens it there. One undo.

- 2026-10-09 Compact feedback (#1205). The header stays outside the single
  content scroller. Feedback and native fields share ordinary scroll order.
  Clipped feedback pauses its remaining visible lifetime.
- 2026-10-12 Hung boundary load (#1211). The Adjust boundary dialog says "The
  server didn't answer. Try again." because nothing was being saved.
- 2026-10-14 Boundary network recovery (#1391). Network failures offer **Try
  again**. Retry and reload keep focus inside the dialog through progress and
  recovery.
- 2026-10-13 Hung boundary load (#1314). The dialog now offers **Try again**
  beside that message instead of only Close.
- 2026-10-12 Timeline rail and bulk review (#1028). Zoom out and Zoom in sit in
  the phone and tablet tool rail; Impact's Approve all and Reject all ask first
  with counts and answer with one toast Undo; the tablet lane header's M and S
  reach the 44 px target on touch. Track lock stays out of scope: it was a
  product gap, not an established violation.
- 2026-10-12 Comment field and comment time (#1338). Commenting needs no mode
  or ruler first: Post comment enables on text, the comment lands at the
  "at 0:12" comment time, and the "Click the ruler" hint is gone. The ruler
  tooltip and Comment mode title say "tap or drag the ruler" for touch.
- 2026-10-13 Phone comment field (#1338 round 2). Posting from the phone Listen
  dock closes the keyboard so the guest goes back to listening; tablet and
  desktop keep the field focused for the next comment.
- 2026-10-13 — Hold message (#1212 review): a held cut is named by speaker, kind and time, never by its edit id, and a lane problem reads as a sentence. The Room tone term gained its Never-say column. #1393: the operator reversed the room-tone hold, so a cut with no room tone to lay applies with a silent pad; the room-tone cause and its `filler_pad_mode` advice left the hold message, and the Room tone row says so.
- 2026-10-13 — Added "Review files need attention" (#1322): the guest's fixed line when the host's review folder is not private, next to the sharing-setup line.
- 2026-10-13 Transcript and Tighten (#1029). Select mode works by touch: hold a
  word and drag, or add and drop words at either end in Range actions, and the
  Select hint says so instead of naming Mod+X. Tighten rows lead with the
  decisions, Apply then Skip, before Preview and Go to, and Apply eligible (now Apply suggested actions) is
  the panel's one primary action. Word fixes, Suppress, Ignore and Restore, and
  a range Cut or Mute answer with a toast Undo.
- 2026-10-13 Comment time hints (#1430) and Select range in the tablet sheet (#1429). A comment time the chip refuses says why in one line, and the chip names the selection when the comment time differs from it. Arming Select range over another selection puts In and Out in the sheet, not behind its scrim.
- 2026-10-14 — Shared buttons disable only with a reason (#1444): `Button`,
  `ToggleButton` and `CommandButton` drop the native `disabled` prop for
  `disabledReason`.
- 2026-10-13 — Added "Save state" (#1448): the host's project shows Saving to project…, Saved to project, Not saved yet · N waiting to send, or Save failed with a next step, reusing the record room's saving and saved words.
- 2026-10-13 — Save state is a status light (#1448): a small dot with its text in the name and tooltip, shape plus colour, shown in every phone mode. Send now and Retry live in the Needs attention banner.
- 2026-10-15 — On phone the save light is read-only in every state (#1539): the Needs attention banner is the control, so a Waiting or Failed light adds no row and moves no content.
- 2026-10-14 — The mix rebuilds itself (#1468): the host no longer sees
  "· Refresh" after the mix status, and the pill reads "Updating mix…" while it
  rebuilds. Mod+B stays as "update now". Until the project loads the pill reads
  "Checking mix…" instead of claiming "Mix up to date".
- 2026-10-14 — Save state distinguishes rejected from uncertain command outcomes (#1478): refusal explains that the editor must correct and resubmit, while an unknown result gives the safe recovery for retryable edits or Undo/Redo History inspection.
- 2026-10-15 — A coarse-pointer sweep of the shell pins the 44 px floor (#1422): the More tab's overlay toggles (Pending edits, Markers, Comments and the rest) were 19 px tall and now hold the floor as whole rows, and the remaining sub-44 controls are the named dense-target exceptions.

- 2026-10-19 — Scope split with the new [interaction system](interaction-system.md): this guide keeps what controls say and where they sit; the interaction system owns how an interaction is wired (one command, one selection table, one menu primitive, one feedback channel, keyboard and touch twins) and the checklist a new interaction passes.
- 2026-10-16 — Explicit interactive Approve and manual cut gestures carry acoustic override authority (#1403). Removed the second Cut anyway dialog; programmatic holds still explain the observed speech, and structural refusals remain mandatory.
- 2026-10-20 — Domain refusals in `edits/` and `engines/` are coded (#1810): the ~200 bare `ValueError`s there now raise `CodedValueError` with a code, so the MCP and CLI adapters show the refusal and what to do next instead of a generic failure. `scripts/check_coded_errors.py` covers both packages and has no allowed exceptions.
- 2026-10-20 — Every refused request names its refusal (#1810): the GUI answers an auth denial, a busy project and a guest 4xx with the same status and message as before plus an `X-Sharecut-Error-Code`, so the client can show the host's message and next step instead of a raw response. The busy text for the audio player is now the shared "This project is busy; try again".
- 2026-10-20 — The web app shows the host's refusal message and next step (#1810): one HTTP client keeps the error code and message from every request, including the 11 places that used to show the raw response body. A user sees the sentence the host wrote, not env var names or a truncated body.
- 2026-10-20 — One feedback channel (#1790): the Comments panel and the Needs
  attention banner speak through `announceStatus`, every mutating command's
  toast carries Undo, an error toast has its own look and holds no internals,
  a gesture's message clears with the gesture, "Inspect History" opens History
  on every shell, and an empty state carries its action ("Show all comments",
  "Add a comment", "Clear filters").
- 2026-10-20 — Names and chrome (#1794): every control shows its command's catalog label or one declared short form, and a Vitest walk compares buttons, menu rows, palette rows and the capabilities manifest. Select tool, Blade tool and Toggle comment mode name the pointer tools, and the rail's cut reads Blade cut. The status row and Activity chip read as sentences. The clip inspector drops the monospace ID rows and the fade sliders for number fields with Apply and nudges, and its Delete pair says which leaves a gap and which ripples. The phone help copy names taps and holds, panel tabs are a tablist, and the Ripple and Leave a gap rows name the Delete buttons. The Needs attention banner shows that one string as its heading and the Comments panel's mode button uses the command's name, Toggle comment mode.
