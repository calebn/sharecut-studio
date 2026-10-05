# Sharecut Studio editability

Multi-pass plan that turned the host Sharecut Studio from a **read-only inspector** into a consistent **editor** for agent-mutable timeline/project concerns. Passes 0–8 shipped. Remaining polish lives in [ROADMAP.md § Follow-up](../ROADMAP.md#follow-up).

Agents mutate via MCP/CLI; the GUI writes the same services through typed document commands (`POST /api/document/command`) plus comments, pipeline, bounce, and ingest. The web command flow keeps raw HTTP transport in `gui/web/src/api/documentTransport.ts` and durable queue, replay, conflict, and active-project result policy in `gui/web/src/services/commandQueue.ts`; `gui/web/src/api.ts` remains the named export facade for callers, while `gui/web/src/api/` groups the request adapters by domain. Display-only document ops (`ReorderTrack`, `SetTrackMeta`) and the saved mix (`SetTrackFader`, `SetTrackMute`) apply optimistically in the DAW. Transport failures keep persisted commands queued for replay. A refused reorder or metadata change restores the previous view only while its originating project, optimistic snapshot, and document sequence remain current; mix changes revert only the failed field. See [gui-integration.md](gui-integration.md) and [session-sync.md](session-sync.md).

## Keyboard clip handles

Focused timeline fade and trim handles accept Left/Right arrows through the shared command bus. Fade steps are 1 ms (Shift 10 ms); trim steps are 10 ms (Shift 100 ms), without snapping. Right grows fade-in, Left grows fade-out; Right advances either source boundary. Holding a key previews repeated steps and releasing that arrow saves once, so one Undo restores the gesture. Normal blur also saves; Escape, pointer cancellation, unmount, or changed project/clip geometry discards the preview. An in-flight save blocks another handle gesture. Fades preserve the opposite edge and clamp to the track cap and remaining clip length; trims preserve minimum span and neighbor bounds. A handle that retains native focus after a project reload edits the fresh clip. Removing the focused handle releases keyboard ownership. Arrow keys outside a focused handle retain playhead navigation.

See the [editor interaction inventory](editor-interactions.md) for pointer and
keyboard alternatives, recovery checks and platform limits.

## Clip and marker drafts

Clip body moves keep their existing pointer selection behavior. Escape cancels
an active move from the current focus; owner pointer cancellation/capture loss,
focused-owner blur and unmount also discard it. Chapter and social markers cancel
on Escape, owner cancellation/capture loss, blur or unmount. Later held movement
and release cannot save a canceled draft. These previews do not write episode
state; a changed release uses the existing command and one Undo restores it.
Right mouse buttons and foreign pointer events do not replace a gesture owner.
Switching projects ends clip and marker ownership even when their values match.
An active lane range rejects another pointer pressing a clip body.

## Editor panel space

Desktop and tablet bottom panels resize from the separator's measured height.
Its accessible value reflects that height even when the responsive CSS default
is active and no preference is saved.
Dragging shows a bounded preview. Escape or pointer interruption restores the
prior explicit preference, or the CSS default when no preference existed.
Further held movement cannot restart a canceled gesture. Returning to the origin
leaves a default preference unset. Focus departure and unmount also cancel while
the preview still owns the height; a newer independent resize is preserved.
While a pointer owns the separator, its resize keys stay local and do not alter
the preview. After release, arrows, Home/End, Enter reset and double-click reset
remain available. Phone inspectors use Expand/Collapse. These local view changes create no document
command or History action.

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
| **E. Automation curves** | volume envelopes | `mix.automation_envelopes[]` | Envelope drag on the Volume envelope layer + selected-point inspector |
| **F. Markers / review** | chapters, social clips, comments | `editorial.chapters`, `social`, `review.comments` | Comments + chapter/social CRUD via document commands |
| **G. History** | undo / redo / goto | `history/` snapshots | History Undo/Redo; diff viewer |

Tool registration: `mcp/tools/` (`edits`, `timeline`, `transcript`, `pipeline`, `history`, `comments`, `review`). Domain: `edits/`, `services/document/edit.py`, and related services.

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
- **Footer:** Audition around selection (session transport + Full mix / Edited stems / Original play modes)

**Per-shape body:**

| Shape | Selection | Inspector body | Preview |
|-------|-----------|----------------|---------|
| **A Edit point** | Drag handles on cut overlay; click pending/applied band | Range (source + timeline), reason, confidence; Approve / Reject / Restore; Ask thread | Current / Suggested skip / A/B around the pending band |
| **B Join / fade** | Select a clip or join badge / diamond | Paired fade sliders, incoming transition mode and length | Play across join |
| **C FX** | Track header FX badge → chain list | Per-effect bypass + params; reorder later | FX vs Raw audition; bypass honored in render |
| **D Transcript** | Double-click word or focus + F2 → inline edit | Word text, confidence, suppressed chip | Play word / utterance |
| **E Envelope** | Drag points on the Volume envelope layer | Selected-point time/value | Live gain when cheap; else mark stale |

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
- `UpdatePendingEdit` — on an origin-track pending cut, drag only the true outer start or end edge; the moving edge snaps to waveform ticks and stays inside its source clip while the opposite edge stays fixed. A pointer-up under `HANDLE_DRAG_MIN_PX` (3 px net) only selects the edit. Fine pointers keep the narrow edge targets. Touch shows 44px inline edge targets only when the drawn region is at least 44px wide and the lane can fit both targets; otherwise **Edit timing** focuses the existing Source start field in the inspector. The timeline writes the exact displayed range without optimizer snapping; changing a bound clears its previous optimizer boundary mode and confidence, so manually timed cuts need audition before approval. The inspector source nudge still uses inaudible snap; its fields take `m:ss.mmm` (or plain seconds), and an untouched field sends its exact stored time. The Impact pending list selects all pending edits; bulk Approve/Reject still apply only to review-required edits. The inspector shows the reason once in words (codes in `edits/edit_reasons.py`, labels pinned by `tests/test_edit_reasons.py`), the type as a word (Cut / Mute / Split), and `crossfade_ms` as **Join fade** (approve applies it as fade lengths).
- Timeline Approve/Reject uses the same permission policy and queued-review status as the inspector. A host approval stopped by the transcript-refine gate exposes the existing reasoned waiver recovery in the anchored action surface; guests see the safe explanation without host-only waiver controls.
- `RestoreAppliedEdit` / `revert_applied_edit` — re-insert clip material from `AppliedEditRecord` source clocks for ripple/punch cuts; a ripple reopens the hole on every dialogue track, while a track-scope punch (`params.scope: "track"`) refills its silent hole in place and shifts nothing; mute archives (`params.mute`) subtract intersecting `Clip.mute_regions` without shifting the timeline. Records without source clocks, or whose `params.per_track_source` seam clocks do not span the archived timeline hole (a cut across moved or gapped clips), → History undo
- Inspector Seek / Play around footers (buttons with seek / play icons) (Current / Suggested / A/B on pending)

**Restore limits:** audio/timeline restore only; hard transcript removes are not fully reversed (reconciliation may go stale). Multi-track `ripple_delete` log rows without `source_*` are not restorable this way.

**Done when:** a pending cut can be approved or rejected from the DAW, and an applied cut can be removed with history intact.

### Listen-first pending preview

**Status: shipped.**

Shipped:

- In the GUI, source-timed session-scope REMOVE Suggested is a transport skip: pad-before, then pad-after (Current / Suggested / A/B). Splits, track-scope punch, and pending MUTE stay Current-only there with a skip reason.
- Applied mute-in-place (`Clip.mute_regions` from `tighten.edit_mode: mute`) is in the mix. The DAW paints those holes on clip blocks (`list_clips` / `ClipRow.mute_regions`) and lists them in Clip inspector — preview Current around the hole.
- Review stays on the **current timeline + pending inspector** (no modal). Source-timed Play around is a skip; exact range previews use rendered full-mix audio. Ask, mutation errors, and Current / Suggested / A/B stack in document flow; long threads scroll in the body and long mutation errors scroll in a capped error slot so the footer stays visible.
- One `TimelineComment` thread per pending decision (`edit_decision_id`, unique). First Ask creates the root; later notes are replies. Approve/Reject does **not** auto-resolve the thread.
- Mobile Listen **Pending** chip selects the first review-required pending (else first pending) and switches to Timeline (sheet opens from selection).
- MCP `play_pending_preview_tool` / CLI `podcast play pending-preview` (`current` | `suggested` | `ab`), the rendered pending preview behind `GET /api/pending-preview` and the share route: Current is the premix around the edit. Suggested approves the edit on a snapshot (`approve_edits`, so the same ripple, `replace_gap_sec` paced pad, fades and mute) and renders that window through the per-track segment mix, so it is what approving ships. The window ends where the post-roll lands after the edit, so a cut with a pad longer than itself plays longer than Current. Removes (session or track), mutes and exact ranges all render; a split or an unmapped edit has no Suggested side. Full mix only. Does not mutate the project. Skill: **podcast-play-audition**. Host speakers only.
- Exact range pending GUI previews render the full mix for Current, Suggested, and A/B. Selected islands alone receive Cut/Mute; gaps and other lanes remain audible. The host uses `GET /api/pending-preview`; guests use the token-scoped route with playback permission. Exact proposals show timeline islands and lanes, with source-bound timing controls omitted and guest Approve/Reject disabled with a host-only reason.
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

While a coupled join change is still saving, competing clip fade, trim, roll, and move gestures wait. The existing join save flag guards gesture starts and commits, including commits after an asynchronous boundary read. This prevents an older individual fade from overwriting one side of a coupled crossfade.

Shipped:

- Fades draw as straight SVG gain ramps over the waveform (render's `afade` / `acrossfade` `tri` curve) with the attenuated side dimmed (`timeline/FadeCurves.tsx`; path math in `timeline/fadeCurvePaths.ts`). Each non-cut edge has one fade handle at the clip's top corner, which slides inward with the length. A drag shows the length live in a readout under the handle and clamps to the track's `fade_max_ms`, the clip length and what the other edge's fade leaves. A pointer-up under `HANDLE_DRAG_MIN_PX` (3 px net) only selects. Each handle's accessible name carries its current length (the on-clip readout is visual only). A zero-length fade's handle shows only on hover (fine pointers only), keyboard focus or selection; while hidden it is transparent and click-through but stays in the tab order, and touch users select the clip. The seam line selects the clip and supports a roll drag.
- One **join badge** per drawn join sits at the top of the seam, inside the lane's top gutter above the clips (`--clip-inset-top`, a px token shared with the `.clip-block` top inset, so it holds at any browser text size), so it clears the fade corners, the roll seam line and (on the first track) the marker lane (`timeline/JoinBadge.tsx`, drawn by `TrackLane`): `|` cut, `╲╱` fade, `✕` crossfade, with a warning border when a crossfade cannot blend. A join is drawn when the neighbours abut within `JOIN_GAP_TOLERANCE_SEC` (0.05 s), the right clip's join names the left one, and both are at least `MIN_JOIN_CLIP_PX` (24 px) wide on screen (`edit/joinRender.ts` `isDrawnJoin`). A join under a clip move is hidden; during a join roll the badge and its width rule follow the live roll geometry (`edit/clipEdgePreview.ts` `clipRowDuringRoll`). The badge is a button (named, for example, "Fade join at 0:05.0") with a 24 px wide hit area inside the gutter (`.join-badge::before`, sized by the px token `--join-hit-min`, three `--clip-inset-top` gutters, so it holds at any root font size; the inspector's Join control is the full-size equivalent for WCAG 2.5.8) that opens the **join popover** (`timeline/JoinPopover.tsx` / `JoinPopoverView.tsx`, portaled and fixed under the badge by `joinPopoverPlacement.ts`, re-placed on window resize/scroll and when its own content resizes, via `ui/useResizeObserver`). The popover has Cut / Fade / Crossfade toggles that send `SetClipJoin` with the mode's default length; one **Length** slider, hidden for Cut, that commits on release or a key step through the seam-owned `useJoinEdit` controller and sends `SetClipJoin` with that length, bounded by `edit/fadeLimits.ts` `joinLengthMaxMs` (a 1 ms floor for a crossfade; pinned to `set_clip_join` by `contracts/join-length-limits.json`, which `fadeLimits.test.ts` and `tests/test_join_length_limits_contract.py` both read); the render note; and Seek join / Audition join (`InspectorSeekFooter`, ±0.75 s). Escape, Close or an outside click dismisses it and returns focus to its own badge; one join popover is open at a time (`openJoinId` in the DAW store), so opening another badge, by pointer or keyboard, closes the open one; while a `SetClipJoin` is in flight (`joinMutationInFlight` in the DAW store; a project switch clears it and `openJoinId`, so a request that never settles cannot block the next project's badges) none of these dismiss it and no other badge opens, so a failure still shows its alert; viewers without edit see the mode read-only plus Audition. The vertical seam line rolls the join.
- A blending crossfade draws a centered X over the authored seam. Its exact span is the positive finite projected `join_crossfade_ms` times zoom; blocked joins draw no overlap, even when stored fades are positive. This describes the domain overlap on the authored clock. FFmpeg can clamp it further against rendered segments. Opening the crossfade badge reveals a reserved row below the timeline scroll canvas. A leader connects its parked right-endpoint grip to the X. Dragging the grip changes twice the endpoint displacement in milliseconds, with one atomic `SetClipJoin` on release and one Undo for mode and affected fades. The native Length range supports keyboard editing. Clicks, canceled gestures, stale pairs, roll/move previews and project changes do not submit drafts. Stored asymmetric fades remain authoritative until an intentional coupled edit. A draft warns when the right outgoing fade will shrink. Saved paint returns during submission and queued sync; mutation errors stay in the editor, while the existing document queue and conflict UI own delayed failures.
- Clip labels lead with the track speaker name when present, then show the clip duration in readable units (for example, `Avery · 17m 26s`); narrow labels ellipsize and retain identity, timeline position, and full duration in their accessible name. Internal clip IDs stay in data attributes and the inspector details. The Clip inspector title names the speaker and timeline bounds, shows the ID once, and places destructive actions after editing controls. Clip Inspector fade ranges preview while moving and save the paired lengths once on release, key release, or ordinary blur. They clamp to the track cap, clip length, and the remaining room at the opposite edge. Escape or pointer cancellation restores the saved pair.
- Clip Inspector calls the join into the selected clip **Incoming transition** and explains that it connects the previous clip to this one. A typed transition length applies once; leaving it blank uses the mode default. Track-wide recommendations live under **Track actions → Smooth all joins**.
- Pending-edit timing keeps **Snap to silence** separate from Approve. It starts checked without writing. Turning it off changes no timing. Explicitly checking it again re-snaps the stored source bounds in one `UpdatePendingEdit`; **Apply timing** uses the current checkbox value.
- Pending cuts and mutes show current and suggested source bounds, endpoint shifts, and a signed duration change. The suggestion covers the complete stored range and never replaces typed timing. **Use suggestion** saves the displayed bounds without a second snap pass. Apply any typed timing first. A changed exact range clears the previous optimizer boundary mode and confidence, so audition before approval. Splits have no silence suggestion. Comparisons retain submillisecond precision. Timing saves carry the saved track, type, clock, and bounds, so a changed decision is rejected rather than overwritten. While a timing save is queued, further timing and review actions wait; replay conflicts appear in **Needs attention**.
- Pending hatch regions cover the lane height and retain a minimum 0.75rem hit area. Applied cuts retain the seam notch above the clips.
- Document commands `SetClipFade`, `SetJoinMode` (mode only), `SetClipJoin` (mode plus both fades, one undo step; the inspector's Incoming transition control and the join popover), `ApplyFadeRecommendations` (track-scoped recommend+apply; Track actions **Smooth all joins**)
- MCP `set_clip_join_tool` (also `podcast edit set-clip-join`) and `set_join_mode_tool`; `set_clip_fade` caps dialogue fades at `render.join_fade_max_ms`, bounds each fade to the clip length and limits fade-out to what fade-in leaves (`join_modes.clamp_clip_fades`); the project view exposes the track cap as `TrackView.fade_max_ms` (null = uncapped; same `track_fade_max_ms` resolver), and the GUI mirrors the rule (`edit/fadeLimits.ts` `clampClipFades` / `edgeFadeMaxMs`) so drags and inspector inputs clamp before sending
- Seek join / Play across join audition footer (rendered as buttons); the join popover has the same footer, labelled Seek join / Audition join
- Join control uses `SetClipJoin`: labelled modes (Cut / Fade / Crossfade), an optional length in ms that the next mode change or **Apply transition length** uses once (empty = the mode's server default; **Apply transition length** is disabled while empty; a 0 ms crossfade is rejected in the inspector and the field is cleared), a note on what render will do (from the `list_clips` `join_*` fields, including why a crossfade is blocked), hidden on a track's first clip (a first clip has no join, so a leftover cut mode, e.g. after its left neighbour is deleted, keeps its fade-in editable and rendered). Render ignores the fades at a cut join (the left clip's fade-out and the right clip's fade-in), so the inspector disables the affected edge slider and preserves that saved value when the other edge changes, `ClipBlock` draws no curve or handle for those fades, and proxy playback (`audio/proxyMath.ts`) skips them; trim handles and the roll diamond stay available. Choosing Cut zeroes the join's two fades; switching back to Fade reseeds `inaudible_cuts.micro_fade_ms` (or the typed length) and Crossfade reseeds `tighten.crossfade_ms`, so undo is the way to get the earlier fades back.

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

Speaker labels in the transcript open a name editor for hosts and shares with the `edit` capability. Enter a new name or choose an existing speaker, then select **Save speaker** or press Enter. The change applies to every turn on that track through the same `SetTrackMeta` command as the Track inspector. It preserves source audio, word timing, and track identity. **Cancel** or Escape discards the draft. History Undo restores the previous speaker. The adjacent timecode seeks the turn. Queued saves close the editor and immediately update the track and transcript speaker labels; the shared status announcement reports pending delivery, and hosts also see the pending-edit banner. A rejected save restores the previous view only while the originating project and its optimistic snapshot remain active. Newer peer or external updates remain intact.

**Status: shipped.**

Shipped:

- Transcript toolbar **Annotate** (display density, orthogonal to Correct/Select): off = clean reading view; on = low-confidence underlines, dotted underlines on unsuppressed `suspect_hallucination` words (over digital silence; a suppressed word shows only its strikethrough), Descript-style **edit-boundary** glyphs at every clip join on ProjectView `edit_boundaries` (word-aligned in the turn that precedes/contains the join), and nested **Show cut away**
- Transcript toolbar **Correct** / **Select** toggles (host-only), wrapped in `role="group" aria-label="Transcript mode"`: neither = click seeks; hosts **double-click a word or focus it and press F2 to fix its text inline** (Enter commits via `CorrectTranscriptWord` = one undo step, sending the chip's text as it read when the editor opened as `expected_text` so a correction whose word index shifted under a remote edit is refused with a 409 conflict instead of changing another word (#650), Esc/blur cancels; while a commit is in flight the editor stays read-only, Esc/blur wait for it (and focus stays wherever the user moved it meanwhile), and another word cannot open until it settles (meanwhile the mode hint under the toolbar says the fix is saving, and a visually hidden polite `role="status"` region announces only that saving status; mode toggles are not announced); the pending lock and any failure that settles after the editor closed (mode switch, word removed, Transcript tab left) live in the DAW store, so a panel remount keeps both; that failure shows as an alert under the mode hint with a **Dismiss** link and clears once the word's text changes by any path, another word opens inline, or another project opens (hosts only: never shown on a guest share); guests keep double-click seek); **Correct** selects a word for ASR fix (`TranscriptWordInspector`); **Select** click/shift/drag builds a `transcriptRange` for Mod+C/X/V clipboard. A toolbar mode hint states that Correct's Apply and Suppress are text-only (audio/timing unchanged) while its Ignore mutes audio at render without a cut, and that Select edits audio; the Correct word editor shows the same timing note under Apply.

- **Keyboard word actions:** in Navigate mode, Enter on a focused timed word seeks
through its native button action. F2 opens inline correction for a hydrated
host project. F2 does nothing in Correct or Select mode, on guest shares, or
while a correction is saving. Enter retains the native Correct/Select word
action in those modes; Enter in the inline editor saves and Escape cancels.

- Tooltip / `aria-label` copy for GUI chrome lives on capability rows (`tooltip` / `tooltip_pressed`) in [`contracts/capabilities.manifest.json`](../contracts/capabilities.manifest.json); generated into `gui/web/src/capabilities/copy.ts` via `make schema-export`
- Clip **trim strips** (full-height edges, shown only on hover with a fine pointer, keyboard focus or selection, like a zero-length fade's corner handle; hidden strips stay in the tab order): front = `source_start`, back = `source_end` via `TrimClipEdge` (ripple) with ghost waveform preview; trim/blade magnet to waveform snap ticks (quiet wash + `waveform-snap` API); ticks draw only while trimming or in blade mode (View › Layers › Snap points); a pointer-up under 3 px net, or a trim the snap or clamp leaves on the committed edge, saves nothing
- Join **seam lines** and transcript Annotate **¦** glyphs (both neighbors): **roll** via `RollClipJoin` — left `source_end` and right `source_start` move together; clips stay timeline-flush; pair duration unchanged; a pointer-up under 3 px net only selects
- Transcript boundary drag keeps the inline glyph size fixed and shows **ghost cutaway words** in a bounded body portal. The glyph follows raw pointer movement while the source offset stays within legal bounds; holding Shift slows the offset to 1 ms per CSS pixel, including when Shift changes during a drag. The preview uses the same expand-range math as timeline ghost waveform and identifies which side of the join restores words. It displays a 0.01-second delta (0.001 second in fine mode) and limit feedback. Escape, pointer cancellation, lost capture, blur, scroll, resize and unmount cancel without edits. Dragging past the activation threshold commits once on pointer up; a tap, Enter or Space opens a host-only precision dialog with an exact signed offset, 10 ms / 1 ms nudges, legal source bounds, full/partial word-span feedback and separately rendered **Listen current** / **Listen proposed** track audio. Apply checks its preview revision before saving, while Cancel and unchanged Apply leave project history untouched; an offline Apply reports queued sync without retrying the command. Long drag previews report abbreviated or omitted words. Real cuts retain removed words in a source-scoped transcript archive, so the preview can show restored words after a cut. Complete source-span restoration brings their original metadata back into active text; partial words remain archived. Joins across unrelated recordings do not share word previews. Older cuts without an archive require History recovery
- Fade handles remain distinct from trim/roll
- Document commands `CorrectTranscriptWord`, `CorrectTranscriptPhrase`, `SetTranscriptWordSuppressed`, `SetTranscriptWordAutomatic`, `SetTranscriptWordsIgnored`, `TrimClipEdge`, `RollClipJoin`, `MoveClips` → `EditService`; all five transcript commands carry `expected_text` (#650, #744, #824): corrections send the inline chip text captured when the editor opened, or the Correct inspector's span text captured when the word was selected or End index last changed (when not every word in that range is loaded, or two loaded copies of one word disagree, the inspector sends none and says so under Apply); the inspector's Suppress and Ignore actions, and the Select-mode Ignore/Restore toolbar button, send the word or range's currently rendered text from the same store snapshot that resolved the target, or no guard when that text can't be confirmed, same as Apply; when that happens, the status announcement from Select-mode Ignore/Restore or the hover Restore says "text not verified". The inspector's draft is captured once per word — never re-seeded by a text change, including its own successful Apply. On success it re-captures its baseline from the words the host returned (none, with the hint under Apply, if they do not read as the applied text). It follows an Undo/Redo of its own Applies without a conflict. After a 409 it re-captures from the host's current words, which `correctTranscriptWord` / `correctTranscriptPhrase` load (`detail` phase, re-fetched if a live update lands meanwhile) before rethrowing, like `setEnvelope`. When the re-captured text differs from the refused text, its error says Apply again retries, so no re-read is needed; if the load failed and nothing newer arrived, it keeps the host's re-read wording (#746). A correction that lands, live or replayed from the offline queue after reconnect, removes earlier refused corrections of the same word (track + start index) from Needs attention. The inline chip editor keeps the text it opened with; after a refusal, reopen the word.
- Mapper emits suppressed words with `word_index`, `confidence`, `suppressed`, `ignored`, `suspect_hallucination`, `audibility_locked` chips (a locked word's chip carries a `.locked` inset box-shadow (not `outline`, which the native focus ring needs, #802) and a "Suppression locked" tooltip, #781), including a suppressed word `merge_transcripts` drops from `combined.json` because it falls outside every same-track utterance window (an utterance's first/last word, or a suppressed run between two utterances) — `_edge_suppressed_word_indices` attaches it to the nearest same-track utterance as a view-only chip, so it stays reachable from Correct/Unsuppress (a track whose words are all suppressed gets view-only `suppressed_only` rows instead, one per gap-run, rendered dimmed, #758); `edit_boundaries[]` for **joins only** (both neighbors) plus cutaway word refs — no trailing mark after the last clip on a track. The chip's `title` alone reaches only a mouse hover or a screen reader's accessible description, so `TranscriptWordInspector` also shows the lock as real text: the **Suppressed** row reads `yes (locked)` / `no (locked)` and a one-line note below the field list repeats `TRANSCRIPT_AUDIBILITY_LOCKED_TIP` ("Suppression locked: set directly, not by a heuristic pass. Reconcile and auto-suppress leave it alone."), so sighted keyboard and touch users who select or tab to a locked word can read why it won't change (#813). A locked word's note is followed by a **Return to automatic** button (#824): it clears `audibility_locked` via `setTranscriptWordAutomatic` → `SetTranscriptWordAutomatic` → `EditService.set_word_automatic`, leaving `suppressed` untouched until the next reconcile pass computes and writes its target. Hidden for guests, same as Suppress/Ignore. After the button disappears on success, keyboard focus moves to the word heading. Undo restores the lock and refetches word detail.
- MCP `set_word_suppressed_tool` / `set_word_automatic_tool` for agent parity (optional `expected_text` guard, #744, #824); listen-first audition stays MCP-only (`podcast-transcript-audition`)
- **Ignore / Restore (#633):** non-destructive strikethrough-and-mute for review passes, no cut or pending edit. Ignored words render with a double strikethrough in `--color-transcript-ignored` (a neutral secondary-text ink, not the danger red; Suppress keeps a single dimmed strikethrough), so the two read differently without opening the inspector. `transcript.ignoreWords` command (`daw.transcript.ignore`) → `SetTranscriptWordsIgnored` → `EditService.set_words_ignored`; entry points are a Select-mode toolbar button for the active `transcriptRange`, the primary action (Ignore/Restore) in `TranscriptWordInspector`, beside a secondary text-only Suppress/Unsuppress; each action's title says whether it changes audio, and a hover/focus-visible **Restore** control after each contiguous ignored run (overlaid without reserving line space on fine pointers, hanging just below the run's last word and right-aligned to it, anchored to that word's wrapper inside the scrolling `.transcript-list`, so it follows its run and never adds horizontal overflow; always visible and inline under `pointer: coarse`). A second `transcript.ignoreWords` while one is in flight is dropped (one undo step per double click). Host-only — no keyboard shortcut (#649), not available to guests. MCP `set_words_ignored_tool` gives agents the same parity (optional `expected_text` guard, #744).
- **Low-confidence walkthrough (#634):** under Annotate, the transcript toolbar shows **Previous / i/n low-confidence / Next** (`transcript.prevLowConfidence` / `transcript.nextLowConfidence`, `daw.transcript.*LowConfidence`). The stops are the underlined words (`confidence < 0.7`, the same threshold as `low_confidence_words_tool`), in transcript order, and the walk wraps at both ends. A step seeks to the word, scrolls to it, marks it (`aria-current`, dashed outline) and announces it. In Correct mode it also selects the word into the word editor. The commands turn Annotate on when run from the palette. There is no keyboard shortcut (#649), and the controls work for guests too (seek and scroll only). A word-editor action still in flight when you step keeps its own result: the next word opens with a fresh editor, and a late failure shows in the transcript's failure banner (Dismiss), not under the new word. The banner clears on its own once the word's text changes or, for a failed Suppress / Ignore, once that flag changes (a retry succeeded).
- **Prosody emphasis (#719):** with View › Layers **Prosody** on (host only), the words `analyze_prosody` ranked prominent (top `prosody.top_prominent_words` per segment, matched to transcript `word_index` server-side by exact source timing, else the nearest same-text word starting within 0.25 s) render bold with a `--color-prosody-prominent` top rule; the rule is left off suppressed, ignored and suspect-hallucination words so their strike / dotted underline stays. They get a hover tip "Emphasized (prosody)" and an sr-only "emphasized". Independent of Annotate; stale profiles still mark words, including ones a re-alignment re-timed; the timeline overlay is in [gui-integration.md § Timeline layers](gui-integration.md#timeline-layers-bottom--top).

**Done when:** correcting a word in the Transcript tab persists to `transcripts.per_track` and survives reload.

### Pass 5 — Automation and markers

**Status: shipped.**

Shipped:

- Envelope point drag (`EnvelopeOverlay`) + track volume workspace (`EnvelopeWorkspace`) → `SetEnvelope` → `PipelineService.set_envelope` (full point-list replace). Each point carries an immutable `id`, preserved when its time changes or sorted position changes, so the GUI uses the ID as its React key. Every replacement includes the exact same-track `expected_points` baseline; the server rejects a stale baseline with a visible conflict instead of silently overwriting a peer. GUI edits and host MCP `set_envelope` both go through `DocumentSyncService.submit`, which runs inside `ProjectWorkspace.transaction()` (the cross-process project commit lock), so `SetEnvelope` is serialized across threads and processes (#213).
- On a short phone screen, choose **Expand** in the inspector sheet to reach the envelope controls. Opening the workspace does not expand the sheet automatically.
- Select a track and choose **Add volume envelope** (empty) or **Edit volume envelope** (existing) to open its workspace and show the layer. Opening it creates no points. **Add point** starts a local numeric draft: the first point defaults to 0 seconds and unity level; later points start at the playhead and the existing curve’s level. **Save point** submits one undoable replacement. **Edit point**, **Delete point**, and **Remove volume envelope** use the same transaction; removing the last point returns automation to unity. Cancel or Escape in the form discards its draft, and an unchanged save submits nothing. Times must be finite and nonnegative; GUI levels range from 0 to 1.50×. A new time collision is refused with an option to discard the draft and select the existing point. A stale envelope is refused and can be reloaded. Shares expose **View volume envelope** and point selection; editing remains host-only.
- Editable envelope drags have one pointer owner. Pointerdown focuses its circle without scrolling and freezes lane geometry. Other pointers and non-left mouse buttons cannot alter that preview. Escape, focus departure, owner pointercancel, lost capture, or unmount discards the preview. The preview highlights its point locally without changing inspector selection. Cancellation preserves the pregesture selection and makes later release inert. Escape retains point focus. A no-op release selects the point; a successful changed save selects the same point by its immutable ID. Rejected saves preserve the previous selection. Enter/Space selects only outside an owned preview. Changed owner release submits once through `SetEnvelope`; a no-op submits nothing. Submitted saves retain their draft and geometry hold until settlement. Escape or blur cannot cancel an already submitted save. Read-only point selection and Enter/Space selection remain available.
- Chapter CRUD: `AddChapter` / `UpdateChapter` / `DeleteChapter` (identity `(time, title)`); MarkerLane drag + ChapterInspector; adding one from the GUI (desktop **Menu › Markers → Add chapter at playhead**, phone More's action, both `edit.addChapter`, host only) titles it from the playhead and turns the Markers layer on. It is single-flight via the DAW store's `chapterAddPending` flag (not a module ref), so the item stays disabled across a menu unmount/remount while the add is in flight; a project switch resets the flag and drops the old project's result (guarded by `projectEpoch`). It announces the start ("Adding chapter at 12.0s…"), the added chapter ("Chapter added at 12.0s") or a failed add in the status live region
- Social CRUD: `AddSocialClip` / `UpdateSocialClip` / `DeleteSocialClip` (by candidate `id`); MarkerLane range drag + SocialClipInspector
- `SuggestPendingEdit` → pending `EditDecision` with `review_required=true` (`edit_type`: `remove` default or `mute`)
- Guest: `POST /api/review/{token}/daw/document/command` + `authorize_document_command` allowlists — `edit` = Pass 1–2 apply set + structural apply; `suggest` = `SuggestPendingEdit` / `UpdatePendingEdit` + structural **propose** (`SplitAtTime` / `DeleteClip` / `RippleDeleteClip` via `policy.resolve_structural_mode`)

**Done when:** host can move a chapter marker and edit an envelope point from the timeline without CLI; guest `suggest`/`edit` shares can propose/nudge or approve via the document route.

### Pass 6 — Agent↔DAW parity

**Status: shipped.**

Shipped:

- Document commands diff their named projection (`SHELL`, `DETAIL`, `TRACKS`, `CLIPS`, `FX`, `ENVELOPES`, `MIX`, `COMMENTS`, or `TRANSCRIPT_AUDIO`) into closed deltas. Text correction and suppression use `DETAIL`; word ignore and timing use `TRANSCRIPT_AUDIO` with audio freshness. Undo, Redo, hello, and external changes retain replacement snapshots. One frontend authority checks predecessor sequence and state token, preserves compatible hydrated words, and recovers atomically when the basis is missing. Pending drag and fader drafts affect display only. See [session-sync.md](session-sync.md) for the protocol.
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
- Select mode: unarmed plain clip **body** drag (`MoveClips`) relocates one clip or a multi-selection chosen with Shift/Mod-click in session time and/or onto another track (gaps and overlap allowed; originating media is pinned via `source_id`). This is **not** `MoveSegment` / `move_segment_tool` (range cut + insert on every dialogue lane). Blade mode still seeks/cuts on clip click. Fade/trim/roll handles are unchanged. Host and share `edit` apply immediately (`canApplyPass12`); suggest-guest propose is out of scope.
- Keyboard: **V** = Select when the timeline is focused; **C** = Blade when focused and structural edits are allowed; **K** = Stop (returns the playhead to where playback last started; Space pauses in place; any playhead move while stopped or paused (a seek, a seek link, following someone, or an agent seek) becomes the new start); **Mod+K** = blade at playhead; **Backspace/Delete** = delete clip (or **remove track** when the inspector has a track selected); **Mod+Backspace** = ripple delete; **Home** / **End** (also **Mod+←** / **Mod+→** on laptops) = go to session start/end; **Escape** = exit comment mode, else clear inspector selection (does not clear Mod+A track targeting); **M/S** = mute/solo selected track; **Mod+A** / **Mod+Shift+A** = select/deselect all tracks (timeline focused); **=/−/\\** = zoom in/out/fit session width; **Alt+=/Alt+-** = track height +/− (72/104/144/192/240px; on macOS, Alt rows also match by physical `e.code` (letters, digits, punctuation, US positions) when `e.key` is not a printable ASCII character, so Option's `≠`/`–` and a remapped Alt row still fire; other platforms match `e.key` only, so a non-US layout never fires a row from the wrong key); **Shift+ArrowUp/Down** = waveform amplitude zoom; **Mod+Shift+C** = comment mode; **Mod+B** = Refresh mix (`render.refreshMix`) for host or Docs Editor when stems/premix are stale; **Mod+Shift+B** = Bounce… (`export.bounce`) for a host with a loaded project → `export/bounces/`; **Mod+Shift+E** = Export deliverables… (`export.deliverables`, host with a loaded project) via the same `PipelineService.export_audio` as MCP; **Mod+C** = copy (`edit.copy`, with a loaded project); **Mod+X/V** = cut/paste (`edit.cut` / `edit.paste`, when `canApplyPass12`) for clip or transcript range — paste is **same-track at playhead** (Premiere/Logic default). Shortcut catalog: [`gui/web/src/keymap/`](../gui/web/src/keymap/) (`KEYMAP_COMMANDS` — also Space, focus `1`–`4`, arrow nudge, Mod+Z undo/redo, `?` cheatsheet). Generated docs: [daw-shortcuts.md](daw-shortcuts.md) + UX site [shortcuts](https://ux.sharecut.studio/#/shortcuts) (`make cheatsheet`).
- Keymap fall-through: when several rows share a key (Backspace clip vs track, Escape comment vs deselect), the listener tries each match in catalog order and runs the first whose `when` passes.
- **Mix out of date:** hover/focus the transport **Mix out of date** pill to highlight **cause regions** (`render.invalidations[]` — cut bands on lanes; FX/gain chips on headers) plus Mix/Reconcile cues. Click (host/`edit`) runs `render_preview` via `POST /api/pipeline/render-preview` or guest `POST …/daw/render-preview`.
- **Bounce / export jobs:** host `POST /api/export/bounce` and `POST /api/export/deliverables` return `{ job_id, job }` immediately (400 on validation; 409 if a pipeline-slot job is running). The GUI seeds Activity chrome from the snapshot then polls; artifact paths land on the terminal snapshot `result.paths`. StatusBar uses **Activity** copy; the chip opens Pipeline only for slot jobs (Run disabled + Cancel there). Guest render is unchanged.
- **In-app cheatsheet:** modal via **?** or Transport **Menu → Help → Keyboard shortcuts** (`CommandPalette`); on desktop, layers, zoom (the **View** menu's **Zoom** section — track height, waveform scale, Fit), layout and theme live in the separate **View** menu; the transport **Menu**'s host-only **Markers** section holds **Add chapter at playhead** (`edit.addChapter`). Category tabs; remaps optional (a remap replaces the key only, and the command's Mod/Shift still apply, so menus show e.g. ⌘⇧X; remaps saved for the old `focus.*` commands load as `layout.*`, and `focus.cycle` remaps are dropped). Menu rows show the platform shortcut (⌘⇧B / Ctrl+Shift+B) and expose it via `aria-keyshortcuts`. Prior art: Figma/Docs `?`, Premiere Help → Keyboard Shortcuts (not the VS Code command palette).
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
- **Binary upload** (not in document JSON): host `POST /api/media/upload`; guest `edit` `POST /api/review/{token}/daw/media/upload` (chunked under the relay JSON body cap). Assembler + allowlist in `services/media/media_store.py`.
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

### Transcript find and replace

Hosts can open **Find and replace** in the Transcript toolbar or command palette. Enter a word or phrase and its replacement, choose **Match case** if needed, then select **Preview replacements**. Search matches whole word tokens, ignores surrounding punctuation for matching, and keeps existing edge punctuation unless the replacement explicitly supplies that edge. Case matching is off by default; replacement case is exactly what the host enters. Regular expressions and partial-word replacement are not supported.

The preview lists before/after text with track, source recording, and source-media time. It searches every stored source transcript, including cut-away text. Suppressed and ignored words are skipped and cannot bridge a phrase; the preview reports their count. Unchanged replacements do not create history. Preview rows load into the list in groups of 100; **Show more replacements** reveals the next group, while **Replace all** applies the complete counted set.

Equal word counts preserve each word's source timing and audibility flags. Different word counts use manual phrase correction's timing policy: replacement words share the original phrase's outer source span. The preview warns before applying this redistribution. Source audio, clip positions, and recording identities remain unchanged.

**Replace all** is one undoable history action. The server checks the complete source-keyed candidate set, exact words, timing, and flags under the project transaction before applying anything. A stale preview changes nothing and asks for a new preview. Queued commands keep their preview token and are checked again at replay; the form reports pending delivery. **Undo replacements** appears next to the result and is disabled after a newer view arrives; History remains available to review and undo changes.

Replacement tokens must each contain a letter or number; attach punctuation to the adjacent word. When word counts differ, an explicit audibility lock anywhere in the original phrase is preserved on every replacement word.

### Wordbar source timing

Hosts can select a word in Correct mode and choose **Adjust timing** in its inspector. The inline Wordbar shows the raw recording waveform, nearby words, and source seconds. Start and end handles share the waveform's local viewport; scrolling the main timeline does not move this view. Drag a handle and release to save one history action. Native keyboard range changes and numeric edits stay in the draft until **Apply timing**. Escape while editing, pointer cancellation, lost capture before release, and **Cancel draft** discard that gesture. A zero-length imported word can be repaired to a positive span.

**Play draft** auditions the exact raw recording around the draft boundaries. **Listen while adjusting** opts into short, throttled edge previews. The existing audio controller temporarily owns that source clock, shows local progress, and keeps the timeline playhead in place. Stop, closing the editor, changing project, or taking over with timeline playback cancels preview. Preview does not create renders or document edits. It intentionally hears raw audio, including ignored words. No new public play mode is introduced.

Words in repeated clips, cut-away words, and retained unplaced recordings edit their stored source word once, so all placements reflect the change. The mapper supplies the exact stored transcript key, including a null primary source key; a primary recording alias does not turn that into a different transcript. The current transcript view still chooses its existing track transcript; this control does not add a recording browser or migrate text-correction APIs.

Overlaps with neighboring words produce a warning, without moving the neighbors or preventing a correction. Bounds must be finite, positive, and within the server's known recording duration (at least one sample when its rate is known). Missing duration disables saving until current waveform metadata is available and the editor is reloaded. Before saving, the server rechecks the raw word sequence, flags and recording identity under the project transaction. A stale draft changes nothing and requires a reload. If delivery queues, the editor says so and the same guard applies on replay.

A successful change marks the selected transcript user-edited and clears timing-derived acoustic evidence. Automatic suppression is cleared with that evidence; locked and ignored choices remain. Moving an ignored word changes its mute interval, and a transcript gate can change its rendered interval. Those audio consequences use the transcript/audio projection and normal render freshness bookkeeping. **Undo timing** is available only while that result is current, closes the draft, and restores both boundaries and evidence in one step. After newer work, use History.

## Exact selected ranges

Selected-track range Cut punches holes in place. Mute adds silence only to the selected clip occurrences. Repeated copies of the same recording remain separate targets. A changed clip placement or media revision rejects the whole action and asks for reselection.

Drag empty lane space, Shift-drag a clip body, or arm **Select range** in the
transport Menu (phone: Timeline tool rail). Ordinary unarmed clip drags still
move clips; trim, fade, join and envelope handles keep their own gestures.
Numeric In/Out and lane checkboxes select the same target without dragging.
Selection does not seek or change follow mode.

Timeline and transcript ranges share **Play, Cut, Mute, Comment, Bounce**.
Transcript passages retain pauses between selected words and map unique split
or moved fragments to their destination lanes. Choose an occurrence for repeated
recordings. Ambiguous repeated split fragments require timeline selection.
An agent region stays a labelled preview until explicitly adopted with lanes.

Host Play renders selected lanes; guest **Play full mix** uses a fresh published
premix and asks for host Refresh when it is stale. Disjoint islands preserve
timeline distance as silence. Bounce opens the format dialog with a
fixed target. Comment carries exact islands and lanes into its draft.
Host Cut/Mute apply; edit and suggest guests create one pending action. Disabled
controls explain missing capabilities. Export and exact approval/rejection are
host-only. Manual ranges and exact-only approval do not require transcript
refinement; source and narrative workflows retain their existing gate.

Cut uses canonical microfades at new hole edges and preserves outer fades,
later placement, other copies and other lanes. One History Undo restores the
whole action. Bulk approval validates all exact targets against the starting
snapshot and composes effects per clip. Any stale target rejects the batch.
Fully removed lanes retain their timeline extent as silence.

Reviewed bleed targets reuse the exact occurrence-local MUTE workflow; they preserve gaps and do not affect another placement of the same recording. See [reviewed bleed ranges](transcript-reconcile.md#reviewed-bleed-ranges).
