# Natural language editing

Podcast MCP supports agent-driven editing in any **MCP-capable client**. Editing is **non-destructive**: decisions live in `episode.project.json`; raw audio in `raw/` is never overwritten.

## MCP tools

| Tool | Purpose |
|------|---------|
| `build_edit_context` | Compact transcript + pending edits for the LLM |
| `get_transcript` | `format=json` or `format=timestamps` |
| `search_transcript_tool` | Find spans by text |
| `cut_time_range_tool` | Remove a time range |
| `cut_text_match_tool` | Remove matching transcript |
| `cut_utterance_tool` | Remove combined utterance by index |
| `cut_words_tool` | Remove word index range on a track |
| `apply_edit_plan_tool` | Bulk JSON edit plan |
| `preview_inaudible_cut_tool` | Dry-run boundary optimization metadata |
| `suggest_handoff_cut_tool` | RMS silence-island OUT/IN for narrative handoffs (timeline); lock with `use_inaudible_opt=false` |
| `join_quality_tool` / `join_qa_sweep_tool` | Perceptual join continuity (advisory; disclaimer on every report) |
| `join_label_tool` | Explicit A/B pass/fail labels for the join ranker |
| `list_edit_decisions_tool` | List cuts |
| `approve_edits_tool` / `reject_edits_tool` | Review workflow |
| `edit_impact_report_tool` | Seconds removed summary |
| `propose_edits` / `apply_edits` | Filler/pause tightening (`propose_edits` returns `{operation, edits, skip_counts, summary}`; discourse skips are `discourse:{token}`; optional `edit_mode=ripple|mute`). Default is listen-first review, not bulk apply. |
| `ripple_delete_tool` | Cross-track ripple delete by time |
| `ripple_delete_text_tool` | Ripple delete by transcript query |
| `move_segment_tool` / `move_by_text_tool` | Rearrange a time range on **all dialogue tracks** (shuffle, not clip-body drag) |
| `move_clips_tool` | Reposition specific clips (`timeline_start` / `track_id`); same as GUI body drag |
| `insert_gap_tool` | Open space on the timeline (splits straddling clips, then shifts later media) |
| `strip_silence_tool` | Per-track silence stripping |
| `shorten_gaps_tool` | Tighten inter-word pauses |
| `fade_joins_tool` | Declick butt-splice fades at clip joins (default dialogue mode) |
| `crossfade_joins_tool` | Opt-in overlapping crossfade at joins (music / explicit blend) |
| `list_clips_tool` | Clip timeline for GUI/agents (`join_in_mode`, `source_id`, `origin_track_id`) |
| `list_applied_edits_tool` | Committed-cut provenance from `editorial.edit_log` |
| `render_status_tool` | Stem freshness, premix, reconciliation stale |
| `history_status_tool` / `history_goto_tool` / `history_diff_tool` | Structured history inspector |
| `add_chapter_tool` / `remove_chapter_tool` / `list_chapters_tool` | Chapter markers |
| `add_comment_tool` / `list_comments_tool` / `get_comment_tool` / `update_comment_tool` | Timeline review comments (timeline clock) |
| `add_comment_action_tool` / `set_comment_action_done_tool` / `resolve_comment_tool` / `delete_comment_tool` | Comment action items + resolve |
| `add_effect_tool` / `list_effects_tool` | Per-track FFmpeg presets |
| `correct_transcript_tool` / `correct_transcript_phrase_tool` / `apply_transcript_cleanup_tool` / `low_confidence_words_tool` | Transcript fixes (history-safe; prefer batch cleanup for undo) |
| `check_loudness_tool` | LUFS check on export |
| `analyze_cleanup_tool` | Gate risk, low-audibility words, bleed flags, fade recommendations, reconciliation staleness |
| `audibility_map_tool` / `flagged_words_tool` | Cross-track word audibility map and suppression candidates |
| `reconciliation_status_tool` / `reconcile_transcript_tool` | Staleness check; manual reconciliation (automatic after `render_preview` by default) |
| `recommend_fades_tool` / `apply_fade_recommendations_tool` | Harsh edit boundaries |
| `low_audibility_words_tool` / `apply_low_audibility_suppression_tool` | Legacy single-track suppression (explicit apply) |
| `gate_overreach_tool` | Noise gate clipping detection |
| `render_preview` | Premix after edits |
| `history_undo` | Optional `rerender=true` |
| `play_transcript_query_tool` | Search transcript + play match (topic audition) |
| `play_audio_tool` | Play by time range, `query`, or `processed:<id>` / `premix` |
| `play_compose_tool` | Mix a subset of tracks (`track_ids` + `processed`/`raw`) for a timeline window into `play_cache` (no mute/FX mutation) |
| `play_pending_preview_tool` | Current / Suggested skip / A/B around a pending session remove (does not mutate). Host speakers. Share agents: `guest_pending_preview`. |
| `audition_context_tool` | Per-track captions + stem freshness for a timeline window (no audio). Payload `schema: audition_context.v2` adds typed `hypotheses[]` (including windowed hum/clip at default `summary`), `suggested_listen[]`, explicit clocks, and `limits`. `detail=visual` adds PNGs. |

## Skills

- Editing: `.agents/skills/podcast-edit-natural-language/SKILL.md`
- Narrative focus (tangents, target length, spine): `.agents/skills/podcast-focus-episode/SKILL.md`
- Cut boundaries: `.agents/skills/podcast-inaudible-cuts/SKILL.md`
- Tighten: `.agents/skills/podcast-tighten-dialogue/SKILL.md`
- Audio cleanup: `.agents/skills/podcast-audio-cleanup/SKILL.md`
- Transcript workflow (hub): [transcript-workflow.md](transcript-workflow.md), `.agents/skills/podcast-transcript-workflow/SKILL.md`
- Transcript refine (agent text fixes): `.agents/skills/podcast-transcript-refine/SKILL.md`
- Transcript reconciliation (bleed/audibility): `.agents/skills/podcast-transcript-reconcile/SKILL.md`
- Transcript precorrect (rules): `.agents/skills/podcast-transcript-precorrect/SKILL.md`
- Transcript correction (quick): `.agents/skills/podcast-transcript-correct/SKILL.md`
- Chapters: `.agents/skills/podcast-chapter-markers/SKILL.md`
- Timeline comments / review TODOs: `.agents/skills/podcast-timeline-comments/SKILL.md` — [timeline-comments.md](timeline-comments.md)
- Playback: `.agents/skills/podcast-play-audition/SKILL.md` — *"play where they talk about X"*

Agents compose NL requests: **search transcript → read timestamps → call primitive tool** (see engineering standards).

### Which clock does a tool use?

Stored transcript/edit times are **source-media seconds**; rendered audio (stems, premix, export) is **timeline seconds**. `search_transcript_tool` returns `TranscriptMatch` with **both**: `start`/`end` (source, feeds cut decisions) and `timeline_start`/`timeline_end` (mapped for play/ripple; `null` if the match was cut away). Cut tools (`cut_time_range_tool`, `cut_text_match_tool`, …) take **source** seconds; play/chapter/comment/gate tools take **timeline** seconds. Every time-bearing tool's clock is declared in `util/tool_timebase.py` and enforced by `tests/test_time_conformance.py`.

## CLI

```bash
podcast edit-context --project episode.project.json
podcast edit search --project ... --query "coffee"
podcast edit cut-text --project ... --query "coffee"
podcast edit preview-cut --project ... --track host --start 32.4 --end 34.8
podcast edit suggest-handoff-cut --project ... --track host --keep-left-end 2154.0 --keep-right-start 2167.0
podcast edit approve --project ... --ids cut_abc123
podcast edit impact --project ...
podcast render-preview --project ...
podcast play --project ... --query "coffee"
podcast play pending-preview --project ... --edit-id cut1 --mode suggested --dry-run
podcast comment list --project ... --open-only
podcast comment add --project ... --author agent --start 12.5 --body "Trim intro"
podcast play --project ... --source processed:host --start 0 --end 15
podcast play compose --project ... --track-ids host,guest --tier processed --start 12 --end 18 --dry-run
podcast play context --project ... --start 12 --end 18
podcast edit analyze-cleanup --project ...
podcast edit recommend-fades --project ...
podcast edit fade-joins --project ...
podcast edit crossfade-joins --project ...
podcast edit low-audibility --project ...
```

`podcast edit approve` prints the number of edits it applied. If no requested edits can be applied, it prints `Approved 0 edit(s).` and warns on stderr. A mute or remove whose source range no longer overlaps a clip stays pending for review.

Cut boundary optimization (default-on): [inaudible-cuts.md](inaudible-cuts.md). For punchline→pivot / “leave a beat” transitions, see **Narrative handoffs** there — use `suggest_handoff_cut_tool`, not word→word absorb.

NL removes also apply **filler pacing** from `tighten.min_gap_after_filler_sec` / `filler_room_tone_replace` / `filler_pad_mode` (same as auto-tighten): default replace expands the cut across the inter-word hesitation and sets `replace_gap_sec` so approve inserts a paced beat (**silence** by default; `room_tone` opt-in). See [filler-cut-quality.md](filler-cut-quality.md). When another dialogue stem is speaking in the window (`tighten.speech_energy_guard`), the decision uses **`scope=track`** (punch silence on the cut track only) instead of cross-track ripple.

## Edit reasons

- `filler:` / `pause:` — auto-tighten (`apply_edits` / pipeline `tighten_from_transcript`). Applies via **cross-track ripple delete** when peers are quiet: the same session timeline window is removed on all dialogue tracks and clips shift together. If `speech_energy_guard` finds peer speech, apply uses a **track-local punch** instead. **Transcript word times do not change** — they stay in source-media seconds; only the clips (the source↔timeline bridge) move, and words whose source span is fully cut are dropped. Decisions are removed from `edit_decisions` after apply (the timeline carries the edit).
- `nl:` — natural language / manual cuts (approve before render; same ripple / track-local rules)
- `agent:` — bulk plan from agent

Per-track-only tools (`strip_silence_tool`, track-local punch) do **not** ripple other tracks — use those when intentional single-track trimming is desired.
