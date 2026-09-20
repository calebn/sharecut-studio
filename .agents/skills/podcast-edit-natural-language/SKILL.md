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
7. Audio: `audition_context_tool` (captions + skew/freshness) then `render_preview`, `render_final`; audition with `play_transcript_query_tool` or `play_audio_tool`. For a pending session remove, `play_pending_preview_tool` (Suggested skip / Current / A/B) before approve (see `podcast-play-audition`).
8. Safety: `history_undo` with `rerender=true` if needed.

When the user names a collaborator’s selection (“cut the clip Alice has selected”), call `get_session_presence_tool` and use that client’s `selection` id.

CLI equivalents: `podcast edit-context`, `podcast edit search`, `podcast edit cut-text`, etc.

All cut commands are globally optimized for inaudibility by default (`docs/inaudible-cuts.md`). That optimizer is **local snap + ~0.4s breath absorb**, not a transition planner. Use `--no-inaudible-opt` / `use_inaudible_opt=false` when locking silence-island handoff bounds (or for debugging edge cases).

Filler / hesitation pacing (`tighten.min_gap_after_filler_sec`, `filler_room_tone_replace`, `filler_pad_mode`) also applies to NL removes — see `docs/filler-cut-quality.md`. After approve, decisions with `replace_gap_sec` insert a paced pad at the join (default **silence**; `room_tone` samples stem air). When another mic is speaking in the window, `speech_energy_guard` converts the cut to a **track-local punch** instead of cross-track ripple.

## Workflow

1. Ensure project path and dialogue tracks exist.
2. `transcribe_track` if transcripts are empty.
3. If transcripts are raw ASR, run **podcast-transcript-workflow** through the
   refine gate before searching for cuts (reconcile → precorrect → refine →
   `transcript_refine_done_tool`). Focus/tighten/NL tools raise while refine is pending.
4. Read `build_edit_context` or `get_transcript(combined=true, format=timestamps)`.
5. Map user intent to cuts:
   - *Focus episode / cut tangents / target length* → skill **podcast-focus-episode** (phased spine + review loop).
   - *Remove topic X* → `search_transcript_tool` → confirm span → `cut_time_range_tool` or `cut_text_match_tool` with `review_required=true` unless user said auto-apply.
   - *Delete utterance N* → `cut_utterance_tool`.
   - *Tighten fillers* → skill **podcast-tighten-dialogue** (`propose_edits`, then
     listen-first review / `approve_edits`; optional `edit_mode=mute` to silence
     in place; do not bulk `apply_edits` on a production episode).
6. `edit_impact_report_tool` (markdown=true) — show seconds removed and pending review.
7. `play_pending_preview_tool` (Suggested) so the user hears the skip before deciding; then `approve_edits_tool` with JSON array of ids — applies cuts to the clip timeline (not just flags).
8. `render_preview` — then `play_transcript_query_tool` or `play_audio_tool` on the span so the user can hear it (not only the premix path).
9. `render_final` or `pipeline_run(from_step=assemble_timeline)` when approved.

## NL composition patterns

| User intent | Steps |
|-------------|--------|
| Remove topic X | `search_transcript_tool` → `ripple_delete_tool(start, end)` |
| Remove false-start restart | Include trailing dead air through the pause before the kept line (or rely on `inaudible_cuts.absorb_trailing_silence`); leave ~0.4s breath |
| Narrative handoff / “clean up the transition” / “need a beat” | **Not** word→word + default inaudible opt. `search_transcript` keep-left end + keep-right start (timeline) → `suggest_handoff_cut_tool` → ripple mid-silence→mid-silence with `use_inaudible_opt=false` → audition ~10–15s around the join. Prefer existing room tone; do not `insert_gap` silence unless asked. See **podcast-inaudible-cuts** § Narrative handoffs |
| Move section to after Y | search source + dest → `move_by_text_tool` (exact phrase + timeline clocks; dest outside source; transcript words stay) or `move_segment_tool` (range cut+insert on every dialogue lane — not clip body drag / `move_clips_tool`) |
| Insert pause after sponsor | search → `insert_gap_tool(at_time, duration_sec)` |
| Strip silence on speaker | `strip_silence_tool(speaker=…)` |
| Declick cut joins | `fade_joins_tool` or `recommend_fades_tool` → `apply_fade_recommendations_tool` |
| Overlap blend at joins (music) | `crossfade_joins_tool` |
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
- Never hand-edit `episode.project.json`; use MCP tools only.
- After `history_undo`, use `rerender=true` or `render_preview` to refresh premix.

## Bulk plan from agent

Emit JSON array and call `apply_edit_plan_tool`:

```json
[
  {"track_id": "host", "start": 120.5, "end": 145.0, "reason": "agent:removed tangent"}
]
```
