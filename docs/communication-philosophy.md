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
    action ("No one has joined" → "Copy invite links"). (Surface 1)
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
| Review link | Async share for follow-along/comment/edit, no live session | "share" alone when record rooms also exist |
| Record room | The live recording room and its lobby/session | "session link", "call" |
| Guest link | Record-room link for the person being recorded | "guest role" |
| Producer link | Record-room link for silent watch/listen (not recorded) | "producer role" — producer is a **link type**, not a review role |
| Viewer / Commenter / Editor | Review-link roles, as in Google Docs. Viewer views and plays; Commenter also comments and suggests edits; Editor also edits directly and approves or rejects suggestions | "producer" in the role dropdown; "suggester" |
| MCP URL | The separate MCP server URL minted with a review link, for an AI assistant | "Agent URL", "agent link", "bot URL" |
| Allow AI assistants (MCP) | The opt-in control that mints an MCP URL. Helper text: "Paste into an MCP client such as Claude or ChatGPT. The assistant gets this link's permissions." | "Allow agent" |
| Take | One continuous recording pass | "clip" for a recording pass |
| Lobby | Pre-recording staging state | "waiting room" |
| Land | Finish a recording and ingest the takes | "save", "finalize" |
| Full-quality recording | Each participant's lossless recording, captured on their own device and uploaded to the project during the session. Its status reads "Saving to project…", then "Saved to project" | "keeper", "local recording", "backup" |
| Room tone | The ambient-noise capture step | — |
| Tighten hit | One candidate tightening decision | — |
| Pending edit | A proposed edit awaiting approve/reject | — |
| Suggest cut | Propose a cut from the transcript | — |
| Blade cut | Split at the playhead on the timeline | "slice" |
| Bounce | Render the current mix | "export mix" |
| Deliverables | Mastered export set | "final export" |
| Stop sharing | Revoke a review link. Links do not expire, so this is how a review link ends | "delete link" |
| End room | Shut down a record room (kills guest + producer links) | "close room" |

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
  adjacent to the control so the opt-in is informed. (Surface 2;
  maintainer decision 2026-09-21: MCP stays opt-in. The adjacent note
  is currently missing from ShareDialog; #1027 restores it.)

## Empty states

Pattern: **what** (one line) + **why it matters** (only if not
obvious) + **the recovery action as a button**. The action is part of
the empty state, not a separate discovery task.

- Do: "No tracks yet. Import Audio adds one dialogue track per
  file." [Import audio]
- Do: "No live record rooms." [Create record links] (replaces the
  "Mint a record room from Share…" dead end — Surface 1)
- Don't: bare "No comments in this filter." with no path back to the
  unfiltered list. (Surface 6 copy inconsistency)
- Keep voice consistent: "No {things} yet" + action. Audit existing
  copy against this when touching a surface. (Surface 6)

## Errors and confirmations

- **Destructive confirmations use the app's `Dialog` with a
  `Button variant="danger"` action — never `window.confirm()`.**
  Native confirms are unstyled, can't carry consequences, and bypass
  the announce pipeline. Eight calls in six files remain; #1027 and
  #1031 replace them and turn on oxlint's `no-alert` rule (see
  Governance). The
  blade-cut confirm sheet in `EditingToolRail` (named target, time,
  Cancel safe-left, action right) is the model. (Surfaces 2, 5, 6.)
- **Confirm copy names the target and the consequence** in human
  terms: "Stop sharing this Viewer link? Anyone using it loses access.
  [Stop sharing] [Keep]". Never a raw token. (Surface 2.)
- **Feedback must be visible, not screen-reader-only.** Every
  `announceStatus` needs a visual twin: a toast stack in `ui/` fed by
  the existing announce channel. `ui/UndoToast` covers comment
  resolution today; the app-wide stack is #1031. A multi-minute export
  whose only "done" signal is invisible is a high-severity bug.
  (Surface 6.)
- **Destructive list actions get toast-with-undo.** Approve, reject,
  skip, blade, trim: after the mutation, a transient confirmation
  with an Undo action. The History tab is the backstop, not the
  interface. (Surfaces 3, 4.) A reviewed-pass approval gets one
  pass-level undo, per UI philosophy § 1.
- **Form errors are wired, not just shown.** `Field` sets
  `aria-describedby` to its error; `InlineError` carries
  `role="alert"`. Fix the primitives once; every caller inherits it.
  (Surface 6; today callers pass the error ID and role, and #1031
  moves that into the primitives.)
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
- [ ] No `window.confirm()`; destructive actions use `Dialog` with a
  `danger` action and consequence-naming copy, spatially separated
  from safe actions.
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
  (`gui/web/.oxlintrc.json`) turns on as an error, with no per-file
  exceptions, once #1027 and #1031 replace the remaining `alert()`,
  `confirm()` and `prompt()` calls; until then review enforces it. axe runs in
  Vitest (`gui/web/src/test/a11y.ts`) and Playwright
  (`make test-web-e2e`) and catches missing names, invalid roles, and
  missing labels. It does not check that `Field` wires its error or
  that every target meets 44px; review checks those until #1031 and
  #1032 land.
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
example confirm no longer mentions expiry. ShareDialog still shows expiry copy
for record links; #1027 removes it.

The port also corrected references that no longer matched the code. The
`ux-pack` rule in `contracts/docs-sync.json` replaced
`scripts/check_ux_pack_sync.py`. The repo has no PR template, so the checklist
item lives in `docs/contributing.md`. `Dialog` has no `danger` variant;
`Button` does. The adjacent MCP note and the automatic `Field` and
`InlineError` wiring are not shipped, and the text now says so.

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
