---
name: podcast-edit-natural-language
description: >-
  Edit podcast episodes by what was said: search transcript, cut by text or time,
  approve edits, preview audio. Use when removing a line or topic, trimming
  dialogue, cleaning up a transition, leaving a beat, or punchline-to-pivot
  handoffs (suggest_handoff_cut_tool — not word-edge cuts + default absorb).
  Not filler/pause density (podcast-tighten-dialogue) or theme/spine cuts
  (podcast-focus-episode).
---

# Edit podcast by natural language

## Harness

Use **podcast-mcp** tools (stdio MCP). Raw files in `raw/` are never modified; only `episode.project.json` and rendered artifacts change.

1. `build_edit_context` — start here for transcript + pending edits.
2. `get_transcript` with `format=timestamps` — readable lines for the model.
3. Mutations: `search_transcript_tool`, `cut_text_match_tool`, `cut_time_range_tool`, `cut_utterance_tool`, `cut_words_tool`, `apply_edit_plan_tool`.
   - For inspection before committing, use `preview_inaudible_cut_tool`.
   - For narrative handoffs (“leave a beat”, “clean transition”), use `suggest_handoff_cut_tool` — **not** word-edge cuts with default absorb.
   - For splice QA, use `join_quality_tool` / `join_qa_sweep_tool` (advisory; not a human-ear guarantee).
4. Timeline (search → time → tool): `ripple_delete_tool`, `move_segment_tool` (range shuffle on **all dialogue tracks**), `move_clips_tool` (reposition specific clips in time or onto another track — same as GUI body drag), `insert_gap_tool`, `split_clip_tool`, `duplicate_segment_tool`, `strip_silence_tool`, `shorten_gaps_tool`, `fade_joins_tool`, `crossfade_joins_tool`, `list_clips_tool`.
5. Cleanup analysis: `analyze_cleanup_tool`, `recommend_fades_tool`, `gate_overreach_tool`, `low_audibility_words_tool` (see **podcast-audio-cleanup**).
6. Review: `list_edit_decisions_tool`, `edit_impact_report_tool`, `approve_edits_tool`, `reject_edits_tool`, `update_pending_edit_tool` (nudge + snap), `revert_applied_edit_tool` (restore one applied cut with source clocks).
7. Audio: `render_preview`, then **`audition_context_tool` on every applied join** (a ±3 s window around each `timeline_start` of a spliced clip, or `join_qa_sweep_tool` for all of them) before `render_final`. It is your ears: fix every `speech_crosses_cut` (`trim_clip_edge_tool` at its `suggested_source_sec`, or re-cut to a handoff silence) and hand every `echo_risk` to **podcast-mute-bleed** before export. Then audition with `play_transcript_query_tool` or `play_audio_tool`. For a pending session remove, `play_pending_preview_tool` (Suggested skip / Current / A/B) before approve (see `podcast-play-audition`).
8. Safety: `history_undo` with `rerender=true` if needed.

When the user names a collaborator’s selection (“cut the clip Alice has selected”), call `get_session_presence_tool` and use that client’s `selection` id.

CLI equivalents: `podcast edit-context`, `podcast edit search`, `podcast edit cut-text`, etc.

All cut commands are globally optimized for inaudibility by default (`docs/inaudible-cuts.md`). That optimizer is **local snap + ~0.4s breath absorb**, not a transition planner. Use `--no-inaudible-opt` / `use_inaudible_opt=false` when locking silence-island handoff bounds (or for debugging edge cases).

Filler / hesitation pacing (`tighten.min_gap_after_filler_sec`, `filler_room_tone_replace`, `filler_pad_mode`) also applies to NL removes — see `docs/filler-cut-quality.md`. After approve, decisions with `replace_gap_sec` insert a paced pad at the join (default **silence**; `room_tone` samples stem air). When another mic is speaking in the window, `speech_energy_guard` converts the cut to a **track-local punch** instead of cross-track ripple.

## Workflow

1. Ensure project path and dialogue tracks exist.
2. `transcribe_track` if transcripts are empty (it runs ASR even over existing transcripts, reusing the ASR disk cache when the audio and prompt are unchanged, and replaces edited transcripts with a warning; prefer the pipeline's reuse otherwise).
3. If transcripts are raw ASR, run **podcast-transcript-workflow** through the
   refine gate before searching for cuts (reconcile → precorrect → refine →
   `transcript_refine_done_tool`). Focus/tighten/NL tools raise while refine is pending.
4. Read `build_edit_context` or `get_transcript(combined=true, format=timestamps)`.
5. Map user intent to cuts:
   - *Long raw session / "cut it down to the show"* → **content cut before tighten** (below), then tighten.
   - *Focus episode / cut tangents / target length* → skill **podcast-focus-episode** (phased spine + review loop).
   - *Remove topic X* → `search_transcript_tool` → confirm span → `cut_time_range_tool` or `cut_text_match_tool` with `review_required=true` unless user said auto-apply.
   - *Delete utterance N* → `cut_utterance_tool`.
   - *Tighten fillers* → skill **podcast-tighten-dialogue** (`propose_edits`, then
     listen-first review / `approve_edits`; optional `intensity=light|medium|aggressive` (the GUI working-set tier is not read here; pass it explicitly), optional `edit_mode=mute` to silence
     in place; do not bulk `apply_edits` on a production episode). Tighten may
     also propose `filler:acoustic` hits (voiced audio the ASR missed inside a
     word gap); they are always review-only — play each before approving.
6. `edit_impact_report_tool` (markdown=true) — show seconds removed and pending review.
7. `play_pending_preview_tool` (Suggested) so the user hears the skip before deciding; then `approve_edits_tool` with JSON array of ids — applies cuts to the clip timeline (not just flags).
8. `render_preview` — then `audition_context_tool` on each applied join (step 7 of the harness list; no `speech_crosses_cut` / `echo_risk` left unaddressed), then `play_transcript_query_tool` or `play_audio_tool` on the span so the user can hear it (not only the premix path).
9. `render_final` or `pipeline_run(from_step=assemble_timeline)` when approved and every join has passed the context check.

## Content cut before tighten (long raw sessions)

On a raw session, remove the dead start, off-topic runs and meta talk **before** any `propose_edits`. Otherwise tighten proposes dozens of hits in material that is about to go.

1. Read the whole transcript (`get_transcript(combined=true, format=timestamps)`) and agree the kept ranges with the user. This usually exceeds the 15% rule, so get explicit approval.
2. Cut on every dialogue track, from the end of the episode toward the start (earlier timeline times stay valid; otherwise re-search after each ripple):
   - Off-topic run or meta talk (latest first): `suggest_handoff_cut_tool(keep_left_end, keep_right_start)` → `ripple_delete_tool(cut_start, cut_end, use_inaudible_opt=false)` (CLI `podcast edit suggest-handoff-cut` then `podcast edit ripple-delete … --no-inaudible-opt`).
   - Dead start, last (it is the leftmost cut and shifts everything after it): `search_transcript_tool` → first kept line's `timeline_start` → `ripple_delete_tool(start=0, end=timeline_start-0.5)` (CLI `podcast edit ripple-delete --start 0 --end …`).
   - Not `cut_time_range_tool` / `apply_edit_plan_tool`: with peer speech in the window they become a track-local punch.
3. After **each** ripple: `transcript_refine_waive_tool(reason="content cut: structural edit")` (CLI `podcast transcript refine-waive --reason …`). Dropped words make the waive stale, and the next edit raises `TranscriptRefineRequiredError`.
4. Then `propose_edits` (**podcast-tighten-dialogue**). The removed words are gone, so proposals fall only in the kept range; there is no range argument. Reject tighten proposals made before the cut (`reject_edits_tool`).

`analyze_focus_cuts` (pipeline) writes an outline, not a cut list, and is skipped when `focus.enabled` is false. See [docs/pipeline.md § Long raw sessions](../../../docs/pipeline.md#long-raw-sessions-content-cut-before-tighten).

## NL composition patterns

| User intent | Steps |
|-------------|--------|
| Remove topic X | `search_transcript_tool` → `ripple_delete_tool(start, end)` |
| Cut a raw session down to the show | Content cut before tighten (section above): `suggest_handoff_cut_tool` → `ripple_delete_tool(use_inaudible_opt=false)` per off-topic run (latest first), then `ripple_delete_tool` for the dead start last, `transcript_refine_waive_tool` after each, then `propose_edits` |
| Remove false-start restart | Include trailing dead air through the pause before the kept line (or rely on `inaudible_cuts.absorb_trailing_silence`); leave ~0.4s breath |
| Narrative handoff / “clean up the transition” / “need a beat” | **Not** word→word + default inaudible opt. `search_transcript` keep-left end + keep-right start (timeline) → `suggest_handoff_cut_tool` → ripple mid-silence→mid-silence with `use_inaudible_opt=false` → audition ~10–15s around the join. Prefer existing room tone; do not `insert_gap` silence unless asked. See **podcast-inaudible-cuts** § Narrative handoffs |
| Move section to after Y | search source + dest → `move_by_text_tool` (exact phrase + timeline clocks; dest outside source; transcript words stay) or `move_segment_tool` (range cut+insert on every dialogue lane — not clip body drag / `move_clips_tool`) |
| Insert pause after sponsor | search → `insert_gap_tool(at_time, duration_sec)` |
| Strip silence on speaker | `strip_silence_tool(speaker=…)` |
| Declick cut joins | `fade_joins_tool` or `recommend_fades_tool` → `apply_fade_recommendations_tool` |
| Overlap blend at joins (music) | `crossfade_joins_tool` |
| One join's mode + fades (fade / crossfade / cut) | `set_clip_join_tool` (not `set_join_mode_tool`, which leaves the fades unset) |
| Check if gate ruined words | `gate_overreach_tool(speaker=…)` after `add_effect_tool(preset="gate")` |
| Add chapter | search → `add_chapter_tool(at_time, title)` |
| Remove chapter | `remove_chapter_tool(title)` |
| Leave / work review comments | skill **podcast-timeline-comments** — `add_comment_tool` / `list_comments_tool` / `resolve_comment_tool` (timeline clock) |

## Clocks (source vs timeline)

- `search_transcript_tool` returns each match with **both** clocks: `start`/`end` (source-media seconds, feed cut tools) and `timeline_start`/`timeline_end` (edited clock, feed play/chapter/comment/ripple). A `null` `timeline_start` means the span is already cut.
- Cut tools (`cut_time_range_tool`, `cut_text_match_tool`, `cut_words_tool`) take **source** seconds. Play, chapters, comments, and ripple-by-time take **timeline** seconds.
- Ripple delete / tighten **do not rewrite word times** — clips move, words stay in source seconds, fully-cut words are dropped. Do not assume timestamps "shifted" after an edit; re-search to get fresh mapped `timeline_*` values.

## Rules

- Do not remove >15% of duration without explicit user approval.
- NL cuts use `review_required=true` by default; use `approve_edits_tool` before final export.
- Every applied join gets an `audition_context_tool` check (or one `join_qa_sweep_tool`) before export; a `speech_crosses_cut` or `echo_risk` you did not act on is a defect you shipped blind.
- Never hand-edit `episode.project.json`; use MCP tools only.
- After `history_undo`, use `rerender=true` or `render_preview` to refresh premix.

## Bulk plan from agent

Emit JSON array and call `apply_edit_plan_tool`:

```json
[
  {"track_id": "host", "start": 120.5, "end": 145.0, "reason": "agent:removed tangent"}
]
```
