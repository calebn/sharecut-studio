# Sharecut Studio editability

Multi-pass plan that turned the host Sharecut Studio from a **read-only inspector** into a consistent **editor** for agent-mutable timeline/project concerns. Passes 0–8 shipped. Remaining polish lives in [ROADMAP.md § Follow-up](../ROADMAP.md#follow-up).

Agents mutate via MCP/CLI; the GUI writes the same services through typed document commands (`POST /api/document/command`) plus comments, pipeline, bounce, and ingest. Display-only document ops (`ReorderTrack`, `SetTrackMeta`) apply optimistically in the DAW and revert on 4xx/network failure. See [gui-integration.md](gui-integration.md) and [session-sync.md](session-sync.md).

## Architecture rule

GUI never forks domain logic. Every durable mutation is:

1. A **typed document command** (handler registry + `document.db`), or a thin REST wrapper that calls the same path
2. Existing `*Service` / `edits/*` / `pipeline/*`
3. `ProjectWorkspace.mutate()` → history snapshots

MCP/CLI remain first-class agent paths to the **same** services. No OT/CRDT concurrent cut editing near term — single-writer `mutate` + project poll/reload.

## Mutation shapes (not one panel per MCP tool)

Map tools onto interaction **shapes**. Shared inspector chrome; specialized body.

| Shape | Examples (MCP / domain) | Project storage | DAW today |
|-------|-------------------------|-----------------|-----------|
| **A. Discrete edit events** | pending `EditDecision`, applied `edit_log`, approve/reject, revert one cut | `editorial.edit_decisions`, `editorial.edit_log` | Pending inspector Approve/Reject/Restore + Impact bulk; overlay ticks |
| **B. Boundary / join properties** | fade in/out, `join_in_mode`, **clip edge trim** (`TrimClipEdge`) | `timeline.clips[].fade_*`, `join_in_mode`, `source_*` | Trim handles + ghost waveform; fade handles; join mode |
| **C. Continuous processors** | cleanup / EQ / gate / compressor chains | `mix.processing_chains[]` | Track inspector per-effect bypass; FX vs Raw audition |
| **D. Content text** | word/phrase correct, suppress flags | `transcripts.per_track[].words[]` | Edit toggle → select word → inspector (correct / suppress) |
| **E. Automation curves** | volume envelopes | `mix.automation_envelopes[]` | Envelope drag on Levels + selected-point inspector |
| **F. Markers / review** | chapters, social clips, comments | `editorial.chapters`, `social`, `review.comments` | Comments + chapter/social CRUD via document commands |
| **G. History** | undo / redo / goto | `history/` snapshots | History Undo/Redo; diff viewer |

Tool registration: `mcp/tools/` (`edits`, `timeline`, `transcript`, `pipeline`, `history`, `comments`, `review`). Domain: `edits/`, `services/edit.py`, and related services.

## Modifier UX (consistent interface)

One **modifier** metaphor for shapes A–E:

```text
Select on timeline or list
  → Inspector (typed Modifier panel)
  → Audition / bypass / dry-wet
  → Document command via mutate
```

**Shared inspector chrome (every type):**

- **Header:** type badge + short label + source (agent reason / tool)
- **Primary actions:** Enable/bypass (or Include/exclude for pending cuts), Delete/remove, Reset
- **Secondary:** numeric params with units; scrubbers where time-based
- **Footer:** Audition around selection (session transport + Mix / FX / Raw play modes)

**Per-shape body:**

| Shape | Selection | Inspector body | Preview |
|-------|-----------|----------------|---------|
| **A Edit point** | Drag handles on cut overlay; click pending/applied band | Range (source + timeline), reason, confidence; Approve / Reject / Restore; Ask thread | Current / Suggested skip / A/B around the pending band |
| **B Join / fade** | Click clip edge / join diamond | `fade_in_ms` / `fade_out_ms`, `join_in_mode` toggle | Play across join |
| **C FX** | Track header FX badge → chain list | Per-effect bypass + params; reorder later | FX vs Raw audition; bypass honored in render |
| **D Transcript** | Double-click word → inline edit | Word text, confidence, suppressed chip | Play word / utterance |
| **E Envelope** | Drag points on Levels layer | Selected-point time/value | Live gain when cheap; else mark stale |

Implementation sketch: shared `ModifierInspector` layout + selection in `dawStore`; existing inspectors under `gui/web/src/inspector/views/` grow actions rather than becoming one-off tools UIs.

## Passes and acceptance criteria

### Pass 0 — Foundation

**Status: shipped.** Unblocks all later passes.

Shipped:

- Document command handler registry (`services/document_sync/handlers/`) beyond comments: `ApproveEdits`, `RejectEdits`, `UndoHistory`, `RedoHistory`, `SetClipFade`, `SetJoinMode`, `SetEffectBypass`, `CorrectTranscriptWord`, … Guest ``edit`` shares allow Pass 1–2 apply via `EDIT_COMMANDS` in `services/document_sync/capabilities.py` (includes `SetEffectBypass`); transcript / envelope / marker mutations stay host-only in Sharecut Studio.
- Host GUI → `POST /api/document/command` → existing `*Service` (no parallel REST mappers for new ops); `gui/web/src/api.ts` helpers
- History panel: Undo / Redo buttons
- Shared `ModifierInspector` chrome; pending edit Approve / Reject

**Done when:** a host user can undo/redo from the History tab, and at least one non-comment document command round-trips GUI → mutate → poll refresh.

### Pass 1 — Edit points

**Status: shipped.**

Shipped:

- Pending Approve / Reject (inspector) + Impact **Approve/Reject all review-required**
- `UpdatePendingEdit` — timeline edge drag + inspector source nudge with inaudible snap
- `RestoreAppliedEdit` / `revert_applied_edit` — re-insert clip material from `AppliedEditRecord` source clocks for ripple/punch cuts; mute archives (`params.mute`) subtract intersecting `Clip.mute_regions` without shifting the timeline. Records without source clocks → History undo
- Inspector Seek / Play around footers (Current / Suggested / A/B on pending)

**Restore limits:** audio/timeline restore only; hard transcript removes are not fully reversed (reconciliation may go stale). Multi-track `ripple_delete` log rows without `source_*` are not restorable this way.

**Done when:** a pending cut can be approved or rejected from the DAW, and an applied cut can be removed with history intact.

### Listen-first pending preview

**Status: shipped.**

Shipped:

- Session-scope REMOVE Suggested skip plays pad-before + pad-after (Current / Suggested / A/B). Splits, track-scope punch, and pending MUTE stay Current-only with a skip reason.
- Applied mute-in-place (`Clip.mute_regions` from `tighten.edit_mode: mute`) is in the mix. The DAW paints those holes on clip blocks (`list_clips` / `ClipRow.mute_regions`) and lists them in Clip inspector — preview Current around the hole.
- Review stays on the **current timeline + pending inspector** (no modal). Play around is a skip, not a bounced sidecar. Ask, mutation errors, and Current / Suggested / A/B stack in document flow; long threads scroll in the body and long mutation errors scroll in a capped error slot so the footer stays visible.
- One `TimelineComment` thread per pending decision (`edit_decision_id`, unique). First Ask creates the root; later notes are replies. Approve/Reject does **not** auto-resolve the thread.
- Mobile Listen **Pending** chip selects the first review-required pending (else first pending) and switches to Timeline (sheet opens from selection).
- MCP `play_pending_preview_tool` / CLI `podcast play pending-preview` (`current` | `suggested` | `ab`) — concat pad-before + pad-after; does not mutate the project. Skill: **podcast-play-audition**. Host speakers only.
- Share HTTP / guest MCP: `GET /api/review/{token}/daw/pending-preview` (+ optional `-image`) and `guest_pending_preview` (`play`+`view`). Relative URLs; never `afplay` on the host. See [host-online-relay.md](host-online-relay.md) § Remote MCP.

**Done when:** an approver can hear Suggested vs Current on a pending session remove, then Approve, Reject, or Ask in that inspector thread.

### Tighten review

**Status: shipped.** Host-only **Tighten** tab (phone: More → Tighten) lists pending `filler:`, `pause:`, `repetition:`, and `restart:` decisions.

- Search, class (filler/pause/repetition/restart), track, and “harsh cuts only” filters. Columns: time, track, class, ±3-word snippet, risk badge (risky / review), status. Repetition and restart proposals require individual review and are excluded from the default safe batch.
- Per-hit command-bus actions: Preview (Suggested skip when `can_skip`), Skip (`RejectEdits`), Apply (`ApproveEdits`), Go to (seek + select). Shortcuts when the tab is open: `Enter`, `Backspace`, `P`, `Mod+Shift+Enter`.
- **Apply eligible** with **Avoid harsh cuts** (default on) approves the listed hits except `review_required`, `:join_review` / `:risky` reason suffixes, or `join_risk.verdict` review as **one** `ApproveEdits` batch. `Mod+Shift+Enter` uses the same filtered list and checkbox state as the button. Confirm copy: “Apply 23 of 31 — 8 skipped as harsh”.
- `ProjectView.pending_edits[].join_risk` is the propose-time assessment (`:risky` / `:join_review`) — not a live `join_quality` sweep on every snapshot. Live scoring stays MCP `join_quality_tool`.

**Done when:** a host can filter tighten proposals, preview one, and apply the safe batch without leaving Sharecut Studio.

### Pass 2 — Transitions (joins / fades)

**Status: shipped.**

Shipped:

- Edge handles for fade lengths on clip blocks; join diamond selects clip
- Inspector: editable `fade_in_ms` / `fade_out_ms`, `join_in_mode` (fade / crossfade / cut)
- Document commands `SetClipFade`, `SetJoinMode`, `ApplyFadeRecommendations` (track-scoped recommend+apply)
- MCP `set_join_mode_tool`; dialogue fades capped at `render.join_fade_max_ms` via `set_clip_fade`
- Seek join / Play across join audition footer

**Done when:** changing fade ms or join mode from the inspector updates `timeline.clips` and is audible on next audition.

### Pass 3 — FX bypass / preview

**Status: shipped.**

Shipped:

- `ProcessingEffect.bypass` (default false); `build_track_filter` skips bypassed effects
- Document command `SetEffectBypass` (`track_id`, `effect_index`, `bypass`) + MCP `set_effect_bypass_tool`
- Track inspector per-effect Bypass toggles; chain length unchanged
- FX transport: stale stems request `/api/audio?rerender=true` with cache-bust so A/B is audible

**Done when:** toggling bypass changes processed audition without removing the effect from the chain.

### Pass 4 — Transcript in DAW

**Status: shipped.**

Shipped:

- Transcript toolbar **Annotate** (display density, orthogonal to Correct/Select): off = clean reading view; on = low-confidence underlines, Descript-style **edit-boundary** glyphs at every clip join on ProjectView `edit_boundaries` (word-aligned in the turn that precedes/contains the join), and nested **Show cut away**
- Transcript toolbar **Correct** / **Select** toggles (host-only): neither = seek-on-click / double-click-word seek; **Correct** selects a word for ASR fix (`TranscriptWordInspector`); **Select** click/shift/drag builds a `transcriptRange` for Mod+C/X/V clipboard
- Tooltip / `aria-label` copy for GUI chrome lives on capability rows (`tooltip` / `tooltip_pressed`) in [`contracts/capabilities.manifest.json`](../contracts/capabilities.manifest.json); generated into `gui/web/src/capabilities/copy.ts` via `make schema-export`
- Clip **trim handles** (bottom corners): front = `source_start`, back = `source_end` via `TrimClipEdge` (ripple) with ghost waveform preview; trim/blade magnet to waveform snap ticks (quiet wash + `waveform-snap` API)
- Join **diamonds** and transcript Annotate **¦** glyphs (both neighbors): **roll** via `RollClipJoin` — left `source_end` and right `source_start` move together; clips stay timeline-flush; pair duration unchanged
- Transcript boundary drag shows **ghost cutaway words** (same expand-range math as timeline ghost waveform) while restoring into the join
- Fade handles remain distinct from trim/roll
- Document commands `CorrectTranscriptWord`, `CorrectTranscriptPhrase`, `SetTranscriptWordSuppressed`, `TrimClipEdge`, `RollClipJoin`, `MoveClips` → `EditService`
- Mapper emits suppressed words with `word_index`, `confidence`, `suppressed` chips; `edit_boundaries[]` for **joins only** (both neighbors) plus cutaway word refs — no trailing mark after the last clip on a track
- MCP `set_word_suppressed_tool` for agent parity; listen-first audition stays MCP-only (`podcast-transcript-audition`)

**Done when:** correcting a word in the Transcript tab persists to `transcripts.per_track` and survives reload.

### Pass 5 — Automation and markers

**Status: shipped.**

Shipped:

- Envelope point drag (`EnvelopeOverlay`) + selected-point inspector (`EnvelopePointInspector`) → `SetEnvelope` → `PipelineService.set_envelope` (full point-list replace). Each point carries an immutable `id`, preserved when its time changes or sorted position changes, so the GUI uses the ID as its React key. Every replacement includes the exact same-track `expected_points` baseline; the server rejects a stale baseline with a visible conflict instead of silently overwriting a peer. GUI edits and host MCP `set_envelope` both go through `DocumentSyncService.submit`, so they are serialized by `document_submit_lock` within one host process; a separate stdio MCP process still writes the project file without that lock (#213).
- Chapter CRUD: `AddChapter` / `UpdateChapter` / `DeleteChapter` (identity `(time, title)`); MarkerLane drag + ChapterInspector
- Social CRUD: `AddSocialClip` / `UpdateSocialClip` / `DeleteSocialClip` (by candidate `id`); MarkerLane range drag + SocialClipInspector
- `SuggestPendingEdit` → pending `EditDecision` with `review_required=true` (`edit_type`: `remove` default or `mute`)
- Guest: `POST /api/review/{token}/daw/document/command` + `authorize_document_command` allowlists — `edit` = Pass 1–2 apply set + structural apply; `suggest` = `SuggestPendingEdit` / `UpdatePendingEdit` + structural **propose** (`SplitAtTime` / `DeleteClip` / `RippleDeleteClip` via `policy.resolve_structural_mode`)

**Done when:** host can move a chapter marker and edit an envelope point from the timeline without CLI; guest `suggest`/`edit` shares can propose/nudge or approve via the document route.

### Pass 6 — Agent↔DAW parity

**Status: shipped.**

Shipped:

- Document `Applied` / `Snapshot` use a **named projection** (`SHELL` / `DETAIL` / `TRACKS` / `CLIPS` / `FX` / `ENVELOPES` / `COMMENTS`; `FULL` is hydrate-only via `GET ?phase=full`). Applied defaults to **SHELL**; transcript word/phrase/suppress commands send `DETAIL`; fade/join send `CLIPS`, bypass sends `FX`, envelope points send `ENVELOPES`. Host `useDocumentSync` **merges** via `applyDocumentSnapshot` (skip Echo / own-HTTP; apply peer and `ExternalMutate` at the current seq) and overlays hydrated `words[]` onto SHELL utterances by source clocks when utterance text matches.
- MCP/CLI mutations call `after_agent_mutation` / `notify_document_changed` (`ExternalMutate`, default **shell**) so agent cuts update open host DAW tabs without waiting on project poll
- Agent selection: `SetSelection` + optional selection on seek/region/play; MCP `set_session_selection_tool`; `applyAgentSession` applies selection for agent snapshots
- `TunnelClient` reconnect with exponential backoff + share re-register after disconnect

**Done when:** an MCP cut appears in the DAW without full-page refresh beyond existing poll, and a GUI approve fans out to other connected viewers.

### Pass 7 — Editing tools (blade / delete)

**Status: shipped.**

Shipped:

- **Capability policy** (`services/document_sync/policy.py`): structural commands (`SplitAtTime`, `DeleteClip`, `RippleDeleteClip`) share one type; host/`edit` **applies**, `suggest` **proposes** pending decisions (`shareMode.canApplyStructural` / `canSuggestStructural`)
- Multi-track `split_clips_at` + document `SplitAtTime`; pending `EditDecision` `type: split` (timeline clock, `start == end`); Approve → `split_clips_at`
- GUI `toolMode` select|blade, multi-track `selectedTrackIds`, blade cut guide, ModifierInspector for pending splits
- Select mode: clip **body** drag (`MoveClips`) relocates one clip or a Shift/Mod multi-selection in session time and/or onto another track (gaps and overlap allowed; originating media is pinned via `source_id`). This is **not** `MoveSegment` / `move_segment_tool` (range cut + insert on every dialogue lane). Blade mode still seeks/cuts on clip click. Fade/trim/roll handles are unchanged. Host and share `edit` apply immediately (`canApplyPass12`); suggest-guest propose is out of scope.
- Keyboard: **V** = Select, **C** = Blade when the timeline is focused (and structural edits are allowed); **K** = Stop; **Mod+K** = blade at playhead; **Backspace/Delete** = delete clip (or **remove track** when the inspector has a track selected); **Mod+Backspace** = ripple delete; **Home** / **End** (also **Mod+←** / **Mod+→** on laptops) = go to session start/end; **Escape** = exit comment mode, else clear inspector selection (does not clear Mod+A track targeting); **M/S** = mute/solo selected track; **Mod+A** / **Mod+Shift+A** = select/deselect all tracks (timeline focused); **=/−/\\** = zoom in/out/fit; **Shift+ArrowUp/Down** = waveform amplitude zoom; **Mod+Shift+C** = comment mode; **Mod+B** = Refresh mix (`render.refreshMix`) for host or Docs Editor when stems/premix are stale; **Mod+Shift+B** = Bounce… (`export.bounce`) for a host with a loaded project → `export/bounces/`; **Mod+Shift+E** = Export deliverables (`export.deliverables`, host with a loaded project) via the same `PipelineService.export_audio` as MCP; **Mod+C** = copy (`edit.copy`, with a loaded project); **Mod+X/V** = cut/paste (`edit.cut` / `edit.paste`, when `canApplyPass12`) for clip or transcript range — paste is **same-track at playhead** (Premiere/Logic default). Shortcut catalog: [`gui/web/src/keymap/`](../gui/web/src/keymap/) (`KEYMAP_COMMANDS` — also Space, focus `1`–`4`, arrow nudge, Mod+Z undo/redo, `?` cheatsheet). Generated docs: [daw-shortcuts.md](daw-shortcuts.md) + UX site [shortcuts](https://ux.sharecut.studio/#/shortcuts) (`make cheatsheet`).
- Keymap fall-through: when several rows share a key (Backspace clip vs track, Escape comment vs deselect), the listener tries each match in catalog order and runs the first whose `when` passes.
- **Stale render:** hover/focus the transport Stale pill to highlight **cause regions** (`render.invalidations[]` — cut bands on lanes; FX/gain chips on headers) plus Mix/Reconcile cues. Click (host/`edit`) runs `render_preview` via `POST /api/pipeline/render-preview` or guest `POST …/daw/render-preview`.
- **Bounce / export jobs:** host `POST /api/export/bounce` and `POST /api/export/deliverables` return `{ job_id, job }` immediately (400 on validation; 409 if a pipeline-slot job is running). The GUI seeds Activity chrome from the snapshot then polls; artifact paths land on the terminal snapshot `result.paths`. StatusBar uses **Activity** copy; the chip opens Pipeline only for slot jobs (Run disabled + Cancel there). Guest render is unchanged.
- **In-app cheatsheet:** modal via **?** or Transport **Menu → Help → Keyboard shortcuts** (`CommandPalette`); on desktop, layers, zoom, theme and focus live in the separate **View** menu. Category tabs; remaps optional (a remap replaces the key only, and the command's Mod/Shift still apply, so menus show e.g. ⌘⇧X). Menu rows show the platform shortcut (⌘⇧B / Ctrl+Shift+B) and expose it via `aria-keyshortcuts`. Prior art: Figma/Docs `?`, Premiere Help → Keyboard Shortcuts (not the VS Code command palette).
- **Command bus:** [`gui/web/src/commands/`](../gui/web/src/commands/) — `execute(id)` is the single handler path for keys, toolbar, WebMCP (Sharecut Studio), and blade cut. Keybindings are thin adapters (`keymap/listener.ts` is the only window shortcut listener; see `commands/governance.test.ts`). New shortcuts = keymap row + command handler — never a second `keydown` listener. Cross-surface registration (MCP/CLI/skills): [entry-points.md](entry-points.md) + `contracts/capabilities.manifest.json` (`make capabilities-check`).
- Frontend ids (`tool.blade`, `edit.bladeCut`) are **not** SyncCommand/DocumentCommand types. Blade cut resolves local playhead/tracks then submits `SplitAtTime`. Host MCP `split_clip_tool` also submits `SplitAtTime` via `mcp/tools/agent_document.py` (shared document journal).
- Phone/tablet **editing tool rail** + blade confirm sheet (`EditingToolRail`)
- Clip inspector Delete / Ripple delete under the same policy
- MCP `split_clip_tool` accepts optional `track_ids_json`

**Residual holes:** remaps are localStorage-only (cheatsheet UI) — leave the stub until preferences-backed remaps are available; other host MCP mutators may still use `EditService` + ExternalMutate.

**Done when:** host can blade-cut selected tracks at a click or the playhead, suggest guests create pending splits, and two blades + delete isolates a region.

### Pass 8 — Project, track, and audio ingest

**Status: shipped.**

Shipped:

- **Shared media/clip helper** (`edits/track_media.py`): probe → `MediaAsset` + one full-span `Clip`; reused by `EpisodeService` and ingest consolidate (no second GUI clip stack).
- **`EpisodeService`:** `add_track` (with media), `add_empty_track`, `set_track_media`, `set_track_meta`, `set_track_fader`, `set_track_mute`, `remove_track`, `reorder_track`; stale render via `record_invalidation` (not on reorder). Host MCP `track_add` / episode mutators call `notify_after_mutation`.
- **Document commands** (`AddTrack`, `SetTrackMedia`, `SetTrackMeta`, `SetTrackFader`, `SetTrackMute`, `RemoveTrack`, `ReorderTrack`) in `EDIT_COMMANDS` — host and share `edit` only (not `suggest` / `view`).
- **Saved mix (#386):** each track's volume is `fader_db` on top of the staging `gain_db` (the mix plays `gain_db + fader_db`; balance never changes the fader), and M is the saved `muted` flag. Solo stays listen-only. Host MCP `track_set_fader_tool` / `track_set_mute_tool`, CLI `podcast episode set-track-volume` / `set-track-mute`. A change stales the premix (`artifacts/premix.hash`), not the stems, so Refresh only re-mixes.
- **Binary upload** (not in document JSON): host `POST /api/media/upload`; guest `edit` `POST /api/review/{token}/daw/media/upload` (chunked under the relay JSON body cap). Assembler + allowlist in `services/media_store.py`.
- **Host home:** optional `--project` on loopback; New/Open via `POST /api/project/create|open` then navigate into Sharecut Studio. GUI open/pick require the canonical `episode.project.json` basename (directory resolve is fine); CLI/MCP `open_project` still accept any JSON path. **Browse…** / Mod+O call `POST /api/project/pick` (host OS dialog) then `open`; paste path remains for headless / missing dialog tools. Guests never create/open host projects.
- **Arrange ingest UX:** one `ingestFiles` path for lane drop, empty-session drop, ghost `+ Track`, File menu (Import / New Track / Remove / Move up / Move down), inspector Import/Replace / Remove (via `track.remove`), header drag-handle reorder (`track.reorder`), and `media.import` / `track.add` / `track.remove` / `track.moveUp` / `track.moveDown` / `project.new` / `project.open` commands (Mod+I, Mod+Shift+T, Backspace when track inspector selected, ArrowUp/Down when track selected, Mod+N, Mod+O). Transport **Importing…** pill; no full-page upload card.

**Out of scope (follow-ups):** full `ingest.yaml` consolidate UI, mix-music beds, video tracks, auto-transcribe on import.

**Done when:** host can New/Open a project and import audio onto new or existing lanes; share `edit` can add/replace/remove tracks without writing arbitrary host directories.

## Near-term non-goals

- Full OT/CRDT concurrent cut editing
- Pro Tools–class mixer rebuild
- One unique panel per MCP tool name

Guest/share agents use **capability-filtered remote MCP** and/or guest HTTP — same caps as that share’s human, not the full host editor MCP/CLI/skills surface. See [host-online-relay.md](host-online-relay.md) § Remote MCP.

## Related docs

- [gui-integration.md](gui-integration.md) — viewer layout, APIs, poll reload
- [session-sync.md](session-sync.md) — transport vs document planes
- [host-online-relay.md](host-online-relay.md) — share tokens + remote MCP
- [history.md](history.md) — undo snapshots
- [episode-format-v2.md](episode-format-v2.md) — `edit_decisions`, `edit_log`, clips, mix
- [inaudible-cuts.md](inaudible-cuts.md) / [filler-cut-quality.md](filler-cut-quality.md) — boundary and join quality
- [nl-editing.md](nl-editing.md) — agent NL cut workflows
