# Sharecut Studio communication philosophy

This guide sets the voice, terminology, control placement, and ergonomics rules
for Sharecut Studio. It is the companion to the
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
CLI help text, and user docs. Out of scope: marketing copy.

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
| Room tone | The ambient-noise capture step | — |
| Tighten hit | One candidate tightening decision | — |
| Pending edit | A proposed edit awaiting approve/reject | — |
| Suggest cut | Propose a cut from the transcript | — |
| Blade cut | Split at the playhead on the timeline, or at a held time from the touch create menu | "slice" |
| Armed | A timeline target a long press picked up on touch: only it drags, along its own axes, until the finger lifts | "grabbed", "drag mode" |
| Create menu | The touch menu a long press on empty timeline space opens: Add envelope point on the held lane, then Blade cut (with a line naming the tracks it cuts: the selected tracks, else every dialogue track), Add chapter and Add comment, at the held time | "context menu", "add menu" |
| Add comment | The one name, in the create menu and the command catalog (`comment.draftAt`), for starting a comment draft at a held time, as "Add chapter" and "Add envelope point" name their siblings | "Comment here" |
| Ripple | The edit mode that closes or opens time on every dialogue track, so speakers stay in sync. Its icon mark is a wave, drawn beside the word on a trim drag's readout and the touch peek strip | "ripple trim mode", "shift", "shuffle", "magnetic" |
| Leave a gap | The edit mode that leaves silence (or pastes over) and moves nothing else. Its icon mark is a broken flatline | "Leave gap", "gap mode", "lift", "non-ripple" |
| Cut anyway | The confirm action when a ripple would also cut another speaker's speech. The dialog, titled "Cut Avery's speech too?", lists each speaker, the time and the words, then offers Leave a gap (safe, left) or Cut anyway (danger, right); approving a suggestion has no gap form, so it offers Cancel instead. Agents and the CLI get the same facts in one line: "This also cuts Avery's speech at 0:12.4 ("so the plan is"). Cut anyway, or leave a gap to keep it." | "Proceed", "Force", "Ignore warning" |
| Solo on | The button shown while any track is soloed: in the corner above the track headers on desktop and tablet, in the status row and Mix sheet on phone. It reads "Solo on · Clear solo", and one press unsolos every track. Solo is listen-only: only you hear it | "solo mode", "solo active" |
| Implied mute | A track silent only because you soloed another track. Its row, lane and clips go grey like a saved mute; its M and identity stripe are dashed, because it is never saved | "auto-muted", "muted by solo" |
| No mix yet | The status when no mix is rendered (never rendered, or a failed render left none) and Full mix is silent. It replaces "Mix out of date" in the one status pill, chip and Menu item, with "· Refresh" only where the person can refresh. A guest reads it without an action | "No preview", "No premix", a second pill beside "Mix out of date" |
| Bounce | Render the current mix | "export mix" |
| Deliverables | Mastered export set | "final export" |
| Stop sharing | Revoke a review link. Links don't expire, so this is how a review link ends (a date set on the CLI or MCP is the one exception) | "delete link" |
| End room | Shut down a record room (kills guest + producer links) | "close room" |
| Online sharing | Making this computer's review and record links reachable from the internet while it runs. Share's status line says what guests can do now, with any fix behind "How to fix" and the online sharing guide | "tunnel", "relay", "host token", "relay URL", a CLI command in UI copy |
| Guests can open your links | Online sharing is connected | "Online", "Connected" as a bare label |
| Reconnecting… | Online sharing lost its connection and is retrying; the line adds "Trying again in N s" (a still clock time under reduced motion). Guests may see a brief interruption | "Tunnel reconnecting", "Guests see Host offline" |
| Not reachable online | Online sharing is set up but guests can't open links: it failed, was refused, or stopped responding | "Offline", "Host offline", "Tunnel failed" |
| Online sharing is off | Set up but not running, or stopped on purpose. Neutral, not an error. A host with no online sharing set up sees no line at all | "Offline", "Disconnected" |

Why this matters: Surface 2's audit found users confusing producer
(a record-room link) with the review-role dropdown — the table above
is the fix, enforced in copy review.

## Control placement rules

- **Bottom zone is for doing; top zone is for knowing.** Primary and
  frequent actions live in the bottom easy-reach zone; the top is
  reserved for titles, status, and infrequent controls. (Surfaces 1,
  3, 5 — the phone bottom nav and EditingToolRail are the reference
  implementations; the REC chip stranded in the top bar and zoom
  buried in the top overflow menu are the violations.)
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
  next to it. Applies to Land mid-take, Start with blockers, and
  Leave while uploads pend. (Surface 1.)
- **Mutually exclusive states get one contextual control.** Pause and
  Resume are one button that flips; never two buttons with one
  permanently disabled. (Surface 1.)
- **Dialogs become bottom sheets on phones**, with the primary action
  pinned to the bottom bar. Centered modals with mid-dialog actions
  and a 24px top-corner Close are a desktop pattern. (Surfaces 1, 2.)
- **Only offer actions that can succeed.** If the backend would reject
  it, the UI doesn't offer it — it explains what to do first.
  (Surface 1: Land gating.)

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
  phone it docks just above the highest bottom chrome that is shown (an
  open sheet, the Timeline tool rail, or the mode nav) and below the
  transport, so it covers no controls or sheet fields ([gui-mobile.md §
  Feedback toast](gui-mobile.md#feedback-toast)). The shell's single
  live region speaks it, once per announcement, even when the same text
  repeats.
  Only a status that a persistent control already shows (the job chip,
  the presence avatars) passes `{ toast: false }`. The Comments panel
  keeps its own `ui/Toast` for comment resolution. A multi-minute
  export whose only "done" signal is invisible is a high-severity bug.
  (Surface 6.)
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
  tab's own edit is still saving, five seconds past the press, runs nothing
  and says "Your last edit is still saving. Nothing was undone." ("…Nothing
  was redone."), so it never reverses the edit before the slow one. Tighten apply, skip and Apply
  eligible, track reorder and track removal offer it; blade, trim and the other timeline edits
  still need to adopt it.
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
  coarse pointers. Token floor: `--tap-min` ≥ 2.75rem (today 1.5rem in
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
  in the same plain form as the stale-head refusal. The roll across a gap that
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
