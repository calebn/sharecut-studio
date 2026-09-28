# Sharecut Studio editability

Multi-pass plan that turned the host Sharecut Studio from a **read-only inspector** into a consistent **editor** for agent-mutable timeline/project concerns. Passes 0–8 shipped. Remaining polish lives in [ROADMAP.md § Follow-up](../ROADMAP.md#follow-up).

Agents mutate via MCP/CLI; the GUI writes the same services through typed document commands (`POST /api/document/command`) plus comments, pipeline, bounce, and ingest. The web command flow keeps raw HTTP transport in `gui/web/src/api/documentTransport.ts` and durable queue, replay, conflict, and active-project result policy in `gui/web/src/services/commandQueue.ts`; `gui/web/src/api.ts` remains the named export facade for callers, while `gui/web/src/api/` groups the request adapters by domain. Display-only document ops (`ReorderTrack`, `SetTrackMeta`) and the saved mix (`SetTrackFader`, `SetTrackMute`) apply optimistically in the DAW and revert on 4xx/network failure; mix changes revert only the failed field, and a guest mix change whose request never arrived stays queued rather than failing. See [gui-integration.md](gui-integration.md) and [session-sync.md](session-sync.md).

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
| **A. Discrete edit events** | pending `EditDecision`, applied `edit_log`, approve/reject, revert one cut | `editorial.edit_decisions`, `editorial.edit_log` | Pending inspector Approve/Reject/Restore + Impact bulk and Applied edits list; seam/edge ticks (projected through current clips) |
| **B. Boundary / join properties** | fade in/out, `join_in_mode`, **clip edge trim** (`TrimClipEdge`) | `timeline.clips[].fade_*`, `join_in_mode`, `source_*` | Trim handles + ghost waveform; fade curves with top-corner fade handles; join mode |
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
- `UpdatePendingEdit` — timeline edge drag (a pointer-up under `HANDLE_DRAG_MIN_PX`, 3 px net, only selects the edit) + inspector source nudge with inaudible snap; the nudge fields take `m:ss.mmm` (or plain seconds); an untouched field sends its exact stored time; the inspector shows the reason once in words (codes in `edits/edit_reasons.py`, labels pinned by `tests/test_edit_reasons.py`), the type as a word (Cut / Mute / Split), and `crossfade_ms` as **Join fade** (approve applies it as fade lengths)
- `RestoreAppliedEdit` / `revert_applied_edit` — re-insert clip material from `AppliedEditRecord` source clocks for ripple/punch cuts; a ripple reopens the hole on every dialogue track, while a track-scope punch (`params.scope: "track"`) refills its silent hole in place and shifts nothing; mute archives (`params.mute`) subtract intersecting `Clip.mute_regions` without shifting the timeline. Records without source clocks, or whose `params.per_track_source` seam clocks do not span the archived timeline hole (a cut across moved or gapped clips), → History undo
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

- Host-only **Intensity** select (Light / Medium / Aggressive) edits the shared pipeline working set `tighten.intensity` (same value as the Pipeline tab). **Find hits** starts a host pipeline job running only `analyze_fillers_pauses` with `tighten.enabled` forced on for that run only (not persisted), so it re-proposes with the chosen tier and the list refreshes when the job finishes. Intensity and Find hits are disabled while the intensity save is in flight or any pipeline-slot job runs; a save refetches the working set first so only `tighten.intensity` changes, and a failed save rolls back to the last server-confirmed tier. If the config cannot load, the panel shows the error with **Retry**. When the list already has hits, Find hits asks for confirmation first because the re-proposal replaces pending hits (including nudged ones). If the analyze job fails (for example the transcript refine gate), its error shows next to Find hits. Starting Find hits clears a previous intensity save error, so the toolbar shows that run's result. See [filler-cut-quality.md § Intensity presets](filler-cut-quality.md#intensity-presets).
- Search, class (filler/pause/repetition/restart), track, and “harsh cuts only” filters. Columns: time, track, class, ±3-word snippet, risk badge (risky / review), status. Repetition and restart proposals require individual review and are excluded from the default safe batch.
- Per-hit command-bus actions: Preview (Suggested skip when `can_skip`), Skip (`RejectEdits`), Apply (`ApproveEdits`), Go to (seek + select). Shortcuts when the tab is open: `Enter`, `Backspace`, `P`, `Mod+Shift+Enter`.
- **Apply eligible** with **Avoid harsh cuts** (default on) approves the listed hits except `review_required`, `:join_review` / `:risky` reason suffixes, or `join_risk.verdict` review as **one** `ApproveEdits` batch. `Mod+Shift+Enter` uses the same filtered list and checkbox state as the button. Confirm copy: “Apply 23 of 31 — 8 skipped as harsh”.
- `ProjectView.pending_edits[].join_risk` is the propose-time assessment (`:risky` / `:join_review`) — not a live `join_quality` sweep on every snapshot. Live scoring stays MCP `join_quality_tool`.

**Done when:** a host can filter tighten proposals, preview one, and apply the safe batch without leaving Sharecut Studio.

### Pass 2 — Transitions (joins / fades)

**Status: shipped.**

Shipped:

- Fades draw as straight SVG gain ramps over the waveform (render's `afade` / `acrossfade` `tri` curve) with the attenuated side dimmed (`timeline/FadeCurves.tsx`; path math in `timeline/fadeCurvePaths.ts`). Each non-cut edge has one fade handle at the clip's top corner, which slides inward with the length. A drag shows the length live in a readout under the handle and clamps to the track's `fade_max_ms`, the clip length and what the other edge's fade leaves. A pointer-up under `HANDLE_DRAG_MIN_PX` (3 px net) only selects. Each handle's accessible name carries its current length (the on-clip readout is visual only). A zero-length fade's handle shows only on hover (fine pointers only), keyboard focus or selection; while hidden it is transparent and click-through but stays in the tab order, and touch users select the clip. The join diamond selects the clip.
- One **join badge** per drawn join sits at the top of the seam, inside the lane's top gutter above the clips (`--clip-inset-top`, a px token shared with the `.clip-block` top inset, so it holds at any browser text size), so it clears the fade corners, the join diamond and (on the first track) the marker lane (`timeline/JoinBadge.tsx`, drawn by `TrackLane`): `|` cut, `╲╱` fade, `✕` crossfade, with a warning border when a crossfade cannot blend. A join is drawn when the neighbours abut within `JOIN_GAP_TOLERANCE_SEC` (0.05 s), the right clip's join names the left one, and both are at least `MIN_JOIN_CLIP_PX` (24 px) wide on screen (`edit/joinRender.ts` `isDrawnJoin`). A join under a clip move is hidden; during a join roll the badge and its width rule follow the live roll geometry (`edit/clipEdgePreview.ts` `clipRowDuringRoll`). The badge is display-only and click-through for now (an `img` named, for example, "Fade join at 0:05.0"); the join popover (#691) makes it a button. The join diamond still rolls the join.
- Inspector: editable `fade_in_ms` / `fade_out_ms`, `join_in_mode` (fade / crossfade / cut) (entries clamp to the same limit; the hint says when an entry was clamped, also next to a cut-join note, and Apply waits until the clip's track is known)
- Document commands `SetClipFade`, `SetJoinMode` (mode only), `SetClipJoin` (mode plus both fades, one undo step; the inspector's Join control), `ApplyFadeRecommendations` (track-scoped recommend+apply; Track inspector **Smooth all joins on this track**)
- MCP `set_clip_join_tool` (also `podcast edit set-clip-join`) and `set_join_mode_tool`; `set_clip_fade` caps dialogue fades at `render.join_fade_max_ms`, bounds each fade to the clip length and limits fade-out to what fade-in leaves (`join_modes.clamp_clip_fades`); the project view exposes the track cap as `TrackView.fade_max_ms` (null = uncapped; same `track_fade_max_ms` resolver), and the GUI mirrors the rule (`edit/fadeLimits.ts` `clampClipFades` / `edgeFadeMaxMs`) so drags and inspector inputs clamp before sending
- Seek join / Play across join audition footer (rendered as buttons)
- Join control uses `SetClipJoin`: labelled modes (Cut / Fade / Crossfade), an optional length in ms that the next mode change or **Apply length** uses once (empty = the mode's server default; **Apply length** is disabled while empty; a 0 ms crossfade is rejected in the inspector and the field is cleared), a note on what render will do (from the `list_clips` `join_*` fields, including why a crossfade is blocked), hidden on a track's first clip (a first clip has no join, so a leftover cut mode, e.g. after its left neighbour is deleted, keeps its fade-in editable and rendered). Render ignores the fades at a cut join (the left clip's fade-out and the right clip's fade-in), so the inspector disables those fade inputs (Apply fades sends such an edge's stored value unchanged, trimmed only if both fades would not fit the clip), `ClipBlock` draws no curve or handle for those fades, and proxy playback (`audio/proxyMath.ts`) skips them; trim handles and the roll diamond stay available. Choosing Cut zeroes the join's two fades; switching back to Fade reseeds `inaudible_cuts.micro_fade_ms` (or the typed length) and Crossfade reseeds `tighten.crossfade_ms`, so undo is the way to get the earlier fades back.

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

- Transcript toolbar **Annotate** (display density, orthogonal to Correct/Select): off = clean reading view; on = low-confidence underlines, dotted underlines on unsuppressed `suspect_hallucination` words (over digital silence; a suppressed word shows only its strikethrough), Descript-style **edit-boundary** glyphs at every clip join on ProjectView `edit_boundaries` (word-aligned in the turn that precedes/contains the join), and nested **Show cut away**
- Transcript toolbar **Correct** / **Select** toggles (host-only), wrapped in `role="group" aria-label="Transcript mode"`: neither = click seeks; hosts **double-click a word to fix its text inline** (Enter commits via `CorrectTranscriptWord` = one undo step, Esc/blur cancels; while a commit is in flight the editor stays read-only, Esc/blur wait for it (and focus stays wherever the user moved it meanwhile), and another word cannot open until it settles (meanwhile the mode hint under the toolbar says the fix is saving, and a visually hidden polite `role="status"` region announces only that saving status; mode toggles are not announced); the pending lock and any failure that settles after the editor closed (mode switch, word removed, Transcript tab left) live in the DAW store, so a panel remount keeps both; that failure shows as an alert under the mode hint with a **Dismiss** link and clears once the word's text changes by any path, another word opens inline, or another project opens (hosts only: never shown on a guest share); guests keep double-click seek); **Correct** selects a word for ASR fix (`TranscriptWordInspector`); **Select** click/shift/drag builds a `transcriptRange` for Mod+C/X/V clipboard. A toolbar mode hint states that Correct's Apply and Suppress are text-only (audio/timing unchanged) while its Ignore mutes audio at render without a cut, and that Select edits audio; the Correct word editor shows the same timing note under Apply.
- Tooltip / `aria-label` copy for GUI chrome lives on capability rows (`tooltip` / `tooltip_pressed`) in [`contracts/capabilities.manifest.json`](../contracts/capabilities.manifest.json); generated into `gui/web/src/capabilities/copy.ts` via `make schema-export`
- Clip **trim strips** (full-height edges, shown only on hover with a fine pointer, keyboard focus or selection, like a zero-length fade's corner handle; hidden strips stay in the tab order): front = `source_start`, back = `source_end` via `TrimClipEdge` (ripple) with ghost waveform preview; trim/blade magnet to waveform snap ticks (quiet wash + `waveform-snap` API); ticks draw only while trimming or in blade mode (View › Layers › Snap points); a pointer-up under 3 px net, or a trim the snap or clamp leaves on the committed edge, saves nothing
- Join **diamonds** and transcript Annotate **¦** glyphs (both neighbors): **roll** via `RollClipJoin` — left `source_end` and right `source_start` move together; clips stay timeline-flush; pair duration unchanged; a pointer-up under 3 px net only selects
- Transcript boundary drag shows **ghost cutaway words** (same expand-range math as timeline ghost waveform) while restoring into the join
- Fade handles remain distinct from trim/roll
- Document commands `CorrectTranscriptWord`, `CorrectTranscriptPhrase`, `SetTranscriptWordSuppressed`, `SetTranscriptWordsIgnored`, `TrimClipEdge`, `RollClipJoin`, `MoveClips` → `EditService`
- Mapper emits suppressed words with `word_index`, `confidence`, `suppressed`, `ignored`, `suspect_hallucination` chips; `edit_boundaries[]` for **joins only** (both neighbors) plus cutaway word refs — no trailing mark after the last clip on a track
- MCP `set_word_suppressed_tool` for agent parity; listen-first audition stays MCP-only (`podcast-transcript-audition`)
- **Ignore / Restore (#633):** non-destructive strikethrough-and-mute for review passes, no cut or pending edit. Ignored words render with a double strikethrough in `--color-transcript-ignored` (a neutral secondary-text ink, not the danger red; Suppress keeps a single dimmed strikethrough), so the two read differently without opening the inspector. `transcript.ignoreWords` command (`daw.transcript.ignore`) → `SetTranscriptWordsIgnored` → `EditService.set_words_ignored`; entry points are a Select-mode toolbar button for the active `transcriptRange`, the primary action (Ignore/Restore) in `TranscriptWordInspector`, beside a secondary text-only Suppress/Unsuppress; each action's title says whether it changes audio, and a hover/focus-visible **Restore** control after each contiguous ignored run (overlaid without reserving line space on fine pointers, hanging just below the run's last word and right-aligned to it, anchored to that word's wrapper inside the scrolling `.transcript-list`, so it follows its run and never adds horizontal overflow; always visible and inline under `pointer: coarse`). A second `transcript.ignoreWords` while one is in flight is dropped (one undo step per double click). Host-only — no keyboard shortcut (#649), not available to guests. MCP `set_words_ignored_tool` gives agents the same parity.
- **Low-confidence walkthrough (#634):** under Annotate, the transcript toolbar shows **Previous / i/n low-confidence / Next** (`transcript.prevLowConfidence` / `transcript.nextLowConfidence`, `daw.transcript.*LowConfidence`). The stops are the underlined words (`confidence < 0.7`, the same threshold as `low_confidence_words_tool`), in transcript order, and the walk wraps at both ends. A step seeks to the word, scrolls to it, marks it (`aria-current`, dashed outline) and announces it. In Correct mode it also selects the word into the word editor. The commands turn Annotate on when run from the palette. There is no keyboard shortcut (#649), and the controls work for guests too (seek and scroll only). A word-editor action still in flight when you step keeps its own result: the next word opens with a fresh editor, and a late failure shows in the transcript's failure banner (Dismiss), not under the new word. The banner clears on its own once the word's text changes or, for a failed Suppress / Ignore, once that flag changes (a retry succeeded).

**Done when:** correcting a word in the Transcript tab persists to `transcripts.per_track` and survives reload.

### Pass 5 — Automation and markers

**Status: shipped.**

Shipped:

- Envelope point drag (`EnvelopeOverlay`) + selected-point inspector (`EnvelopePointInspector`) → `SetEnvelope` → `PipelineService.set_envelope` (full point-list replace). Each point carries an immutable `id`, preserved when its time changes or sorted position changes, so the GUI uses the ID as its React key. Every replacement includes the exact same-track `expected_points` baseline; the server rejects a stale baseline with a visible conflict instead of silently overwriting a peer. GUI edits and host MCP `set_envelope` both go through `DocumentSyncService.submit`, which runs inside `ProjectWorkspace.transaction()` (the cross-process project commit lock), so `SetEnvelope` is serialized across threads and processes (#213).
- Chapter CRUD: `AddChapter` / `UpdateChapter` / `DeleteChapter` (identity `(time, title)`); MarkerLane drag + ChapterInspector; the overlay legend's **+ Chapter** is `aria-disabled` (still focusable, so a keyboard activation keeps focus) while an add is in flight (the `chapterAddPending` flag lives in the DAW store, so reopening the View menu keeps it; a project switch resets it and drops the old project's result) and announces the start ("Adding chapter at 12.0s…"), the added chapter ("Chapter added at 12.0s") or a failed add in the status live region
- Social CRUD: `AddSocialClip` / `UpdateSocialClip` / `DeleteSocialClip` (by candidate `id`); MarkerLane range drag + SocialClipInspector
- `SuggestPendingEdit` → pending `EditDecision` with `review_required=true` (`edit_type`: `remove` default or `mute`)
- Guest: `POST /api/review/{token}/daw/document/command` + `authorize_document_command` allowlists — `edit` = Pass 1–2 apply set + structural apply; `suggest` = `SuggestPendingEdit` / `UpdatePendingEdit` + structural **propose** (`SplitAtTime` / `DeleteClip` / `RippleDeleteClip` via `policy.resolve_structural_mode`)

**Done when:** host can move a chapter marker and edit an envelope point from the timeline without CLI; guest `suggest`/`edit` shares can propose/nudge or approve via the document route.

### Pass 6 — Agent↔DAW parity

**Status: shipped.**

Shipped:

- Document `Applied` / `Snapshot` use a **named projection** (`SHELL` / `DETAIL` / `TRACKS` / `CLIPS` / `FX` / `ENVELOPES` / `MIX` / `COMMENTS`; `FULL` is hydrate-only via `GET ?phase=full`). Applied defaults to **SHELL**; transcript word/phrase/suppress commands send `DETAIL`; fade/join send `CLIPS`, bypass sends `FX`, envelope points send `ENVELOPES`, volume and mute send `MIX`. Host `useDocumentSync` **merges** via `applyDocumentSnapshot` (skip own-HTTP; apply peers at the current seq and `ExternalMutate` at the newer seq its journal row assigns) and overlays hydrated `words[]` onto SHELL utterances by source clocks when utterance text matches.
- MCP mutations and record landing call `after_agent_mutation` / `notify_document_changed`, which journal a seq-advancing `ExternalMutate` row (default **shell**, #661) so agent cuts update open host DAW tabs without waiting on project poll
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
- Keyboard: **V** = Select, **C** = Blade when the timeline is focused (and structural edits are allowed); **K** = Stop (returns the playhead to where playback last started; Space pauses in place; any playhead move while stopped or paused (a seek, a seek link, following someone, or an agent seek) becomes the new start); **Mod+K** = blade at playhead; **Backspace/Delete** = delete clip (or **remove track** when the inspector has a track selected); **Mod+Backspace** = ripple delete; **Home** / **End** (also **Mod+←** / **Mod+→** on laptops) = go to session start/end; **Escape** = exit comment mode, else clear inspector selection (does not clear Mod+A track targeting); **M/S** = mute/solo selected track; **Mod+A** / **Mod+Shift+A** = select/deselect all tracks (timeline focused); **=/−/\\** = zoom in/out/fit session width; **Alt+=/Alt+-** = track height +/− (72/104/144/192/240px; on macOS, Alt rows also match by physical `e.code` (letters, digits, punctuation, US positions) when `e.key` is not a printable ASCII character, so Option's `≠`/`–` and a remapped Alt row still fire; other platforms match `e.key` only, so a non-US layout never fires a row from the wrong key); **Shift+ArrowUp/Down** = waveform amplitude zoom; **Mod+Shift+C** = comment mode; **Mod+B** = Refresh mix (`render.refreshMix`) for host or Docs Editor when stems/premix are stale; **Mod+Shift+B** = Bounce… (`export.bounce`) for a host with a loaded project → `export/bounces/`; **Mod+Shift+E** = Export deliverables (`export.deliverables`, host with a loaded project) via the same `PipelineService.export_audio` as MCP; **Mod+C** = copy (`edit.copy`, with a loaded project); **Mod+X/V** = cut/paste (`edit.cut` / `edit.paste`, when `canApplyPass12`) for clip or transcript range — paste is **same-track at playhead** (Premiere/Logic default). Shortcut catalog: [`gui/web/src/keymap/`](../gui/web/src/keymap/) (`KEYMAP_COMMANDS` — also Space, focus `1`–`4`, arrow nudge, Mod+Z undo/redo, `?` cheatsheet). Generated docs: [daw-shortcuts.md](daw-shortcuts.md) + UX site [shortcuts](https://ux.sharecut.studio/#/shortcuts) (`make cheatsheet`).
- Keymap fall-through: when several rows share a key (Backspace clip vs track, Escape comment vs deselect), the listener tries each match in catalog order and runs the first whose `when` passes.
- **Stale render:** hover/focus the transport Stale pill to highlight **cause regions** (`render.invalidations[]` — cut bands on lanes; FX/gain chips on headers) plus Mix/Reconcile cues. Click (host/`edit`) runs `render_preview` via `POST /api/pipeline/render-preview` or guest `POST …/daw/render-preview`.
- **Bounce / export jobs:** host `POST /api/export/bounce` and `POST /api/export/deliverables` return `{ job_id, job }` immediately (400 on validation; 409 if a pipeline-slot job is running). The GUI seeds Activity chrome from the snapshot then polls; artifact paths land on the terminal snapshot `result.paths`. StatusBar uses **Activity** copy; the chip opens Pipeline only for slot jobs (Run disabled + Cancel there). Guest render is unchanged.
- **In-app cheatsheet:** modal via **?** or Transport **Menu → Help → Keyboard shortcuts** (`CommandPalette`); on desktop, layers, zoom, layout and theme live in the separate **View** menu. Category tabs; remaps optional (a remap replaces the key only, and the command's Mod/Shift still apply, so menus show e.g. ⌘⇧X; remaps saved for the old `focus.*` commands load as `layout.*`, and `focus.cycle` remaps are dropped). Menu rows show the platform shortcut (⌘⇧B / Ctrl+Shift+B) and expose it via `aria-keyshortcuts`. Prior art: Figma/Docs `?`, Premiere Help → Keyboard Shortcuts (not the VS Code command palette).
- **Command bus:** [`gui/web/src/commands/`](../gui/web/src/commands/) — `execute(id)` is the single handler path for keys, toolbar, WebMCP (Sharecut Studio), and blade cut. `register.ts` remains the public entry point and composes domain registrars in command order; `execute.ts` owns their shared handler map. Track and clip mutations share `trackMutation.ts` so their project changes stay serialized. Keybindings are thin adapters (`keymap/listener.ts` is the only window shortcut listener; see `commands/governance.test.ts`). New shortcuts = keymap row + command handler — never a second `keydown` listener. Cross-surface registration (MCP/CLI/skills): [entry-points.md](entry-points.md) + `contracts/capabilities.manifest.json` (`make capabilities-check`).
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
- **`EpisodeService`:** `add_track` (with media), `add_empty_track`, `set_track_media`, `set_track_meta`, `set_track_volume`, `set_track_mute`, `remove_track`, `reorder_track`; stale render via `record_invalidation` (not on reorder). Host MCP `track_add` / episode mutators call `notify_after_mutation`.
- **Document commands** (`AddTrack`, `SetTrackMedia`, `SetTrackMeta`, `SetTrackFader`, `SetTrackMute`, `RemoveTrack`, `ReorderTrack`) in `EDIT_COMMANDS` — host and share `edit` only (not `suggest` / `view`).
- **Saved mix (#386):** each track's volume is `fader_db` on top of the staging `gain_db` (the mix plays `gain_db + fader_db`; balance never changes the fader), and M is the saved `muted` flag. Solo stays listen-only. Agent plays (`play_compose_tool` and every `--follow-transcript` take: single track, `--compare`, gated mix) play each track at its output gain too. A single or `--compare` take that the gain would push past full scale is pulled back to just under it instead of hard-clipping. The gated mix is then peak-normalised, so it keeps the premix's balance but not its loudness. Host MCP `track_set_volume_tool` / `track_set_mute_tool`, CLI `podcast episode set-track-volume` / `set-track-mute`. A change stales the premix (`artifacts/premix.hash`), not the stems, so Refresh only re-mixes. Export always ships the current mix: it re-mixes a stale premix and re-masters a `mastered.wav` that wasn't mastered from the current premix (#425). A muted track is still part of the timeline: cuts, approvals and restores ripple it, and analysis (the audio audit, the speech-energy guard) ignores the mix mute and volume. `dialogue_track_ids()` returns every dialogue track, and render status reports each one's stem; `mixed_dialogue_track_ids()` is the mix's subset.
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
