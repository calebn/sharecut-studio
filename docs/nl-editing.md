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
| `apply_edit_plan_tool` | Bulk edit plan (`edits`: a list of cut objects) |
| `preview_inaudible_cut_tool` | Dry-run boundary optimization metadata |
| `suggest_handoff_cut_tool` | RMS silence-island OUT/IN for narrative handoffs (timeline); lock with `use_inaudible_opt=false` |
| `join_quality_tool` / `join_qa_sweep_tool` | Perceptual join continuity (advisory; disclaimer on every report) |
| `join_label_tool` | Explicit A/B pass/fail labels for the join ranker |
| `list_edit_decisions_tool` | List cuts |
| `approve_edits_tool` / `reject_edits_tool` | Review workflow; exact range proposals need the interactive host or an Editor, so these host agent tools refuse them. `approve_edits_tool(apply_all_safe=true)` (CLI `podcast edit approve --all-safe`) is Studio Apply eligible with Avoid harsh cuts: every pending tighten hit, or only those in `ids`, except harsh ones (`edits/tighten_hits.is_harsh_tighten_hit`), in one undo step; `skipped_harsh` lists the rest. An approval whose ripple would cut another speaker's speech (checked against the transcript at approval time) returns `needs_confirmation` and applies nothing; ask the person, then pass `confirm_cut_speech=true` (CLI `--yes`) |
| `propose_range_mute_tool` | Submit a serialized exact range as pending MUTE with an explicit retry command ID; see [reviewed bleed ranges](transcript-reconcile.md#reviewed-bleed-ranges) |
| `propose_range_cut_tool` | Seal a timeline `start`/`end` on chosen lanes (`track_ids`, default every dialogue lane) and submit it as pending exact CUT with an explicit retry command ID. Approved, it leaves a hole and later clips keep their places; same `EditSelectedRange` as the Studio range Cut. Agents only propose; the interactive host or `podcast edit approve` applies it |
| `edit_impact_report_tool` | Seconds cut and applied-edit count, read from `editorial.edit_log` (approved edits) plus applied decisions still in `edit_decisions`; mutes and structural ops (splits, trims, moves) remove no time. A cross-track ripple counts once in `total_removed_sec` and on every track in `by_track_sec`. Classification: `edits/edit_impact.py` |
| `propose_edits` / `apply_edits` | Filler/pause tightening (`propose_edits` returns `{operation, edits, skip_counts, summary}`; discourse skips are `discourse:{token}` and kept acknowledgments (`tighten.backchannels`, such as a split `Uh` + `-huh.`) are `backchannel:{phrase}`; every candidate analysis rejects counts under its reason, such as `breath`, `next_onset`, `kept_word:{word}` or `kept_voice`, and a mute adds `voiced_edge` and `inaudible` ([filler-cut-quality.md § CLI / MCP](filler-cut-quality.md#cli--mcp)); optional `edit_mode=ripple|mute`, optional `intensity=light|medium|aggressive`; without it, shipped `pipeline.yaml` applies, not the GUI working set ([filler-cut-quality.md § Intensity presets](filler-cut-quality.md#intensity-presets))). Default is listen-first review, not bulk apply. |
| `ripple_delete_tool` | Ripple delete by time on every dialogue track. Name the speaker you mean to cut in `track_ids`; speech on any other track in the range returns `needs_confirmation` (its tracks, words and times) and changes nothing until you pass `confirm_cut_speech=true`. Omitting `track_ids` names no track, so speech on any track asks first; confirm a whole-session time cut the person signed off on with `confirm_cut_speech=true` |
| `ripple_delete_text_tool` | Ripple delete by transcript query; the matched speaker is the cut, and another track's speech in the span asks first (`confirm_cut_speech`) |
| `move_segment_tool` / `move_by_text_tool` | Rearrange a time range on **all dialogue tracks** (shuffle, not clip-body drag) |
| `move_clips_tool` | Reposition specific clips (`timeline_start` / `track_id`); same as GUI body drag |
| `copy_segment_tool` / `paste_segment_tool` | Studio Copy and Paste. `copy_segment_tool` (read-only) returns the clipboard for `start`/`end`: `{duration, extracts}` from every track with clips in range, or only `track_ids`. `paste_segment_tool` submits that clipboard at `insert_at` as `PasteSegment`, the payload Studio Paste sends: in ripple mode a `duration` gap on every dialogue lane, each extract back on its own track. Paste again to place it twice. `mode` is `ripple` (default) or `gap`, which pastes over the pasted tracks in place and moves nothing. A clipboard that names an unknown track or source, or a source range outside the track's media, is rejected with `paste_unknown_track`, `paste_unknown_source`, `paste_bad_range` or `paste_bad_extract` before anything is written. To cut and paste, copy first, then cut (`propose_range_cut_tool` leaves a hole; `delete_clips_tool` with `mode="ripple"` closes the clips' span on every track). Unlike `move_segment_tool`, the source range is not removed and the timeline grows; undoable |
| `delete_clips_tool` | Delete whole clips by id (`clip_ids`). `mode="gap"` (default) leaves a gap; `mode="ripple"` closes the clips' span on every dialogue track, and speech outside the deleted clips (another track's, or an unselected clip's) returns `needs_confirmation` until `confirm_cut_speech=true`. Same `DeleteClip` as the Studio clip Delete / Ripple delete |
| `roll_clip_join_tool` | Roll the join between two neighbouring clips by `delta_sec` source seconds (positive is later); the pair keeps its length so later clips stay put. Reads the boundary token, then submits `RollClipJoin` like the Studio roll seam; a join that changed meanwhile is a conflict |
| `insert_gap_tool` | Open space on the timeline (splits straddling clips, then shifts later media) |
| `strip_silence_tool` | Per-track silence stripping |
| `shorten_gaps_tool` | Tighten inter-word pauses on every dialogue track; another speaker talking in a pause asks first (`confirm_cut_speech`) |
| `fade_joins_tool` | Declick butt-splice fades at clip joins (default dialogue mode) |
| `crossfade_joins_tool` | Opt-in overlapping crossfade at joins (music / explicit blend) |
| `list_clips_tool` | Clip timeline for GUI/agents (`join_in_mode`, `source_id`, `origin_track_id`, effective join render `join_left_clip_id` / `join_render_mode` / `join_crossfade_ms` / `join_crossfade_blocked`) |
| `set_clip_join_tool` | One join's mode plus fades (`left_clip_id`, `right_clip_id`, `mode`, `length_ms?`); `set_join_mode_tool` is mode-only |
| `trim_clip_edge_tool` | Move one clip's `in` / `out` edge to a source-media second (expansion clamped to unused source). `mode=ripple` (default) moves every dialogue track by the duration change: a track with a clip edge at the same instant (a session-wide cut) moves that edge too, and every other track loses the trimmed span or gets the same length of silence, so no trim desyncs the speakers. A ripple that shortens over another track's speech returns `needs_confirmation` until `confirm_cut_speech=true`. `mode=gap` moves only the grabbed edge, up to the neighbouring clip, and leaves silence. The tool obtains the current boundary revision for that mode under the project transaction before its guarded save. `speech_crosses_cut`'s `evidence.fix` gives the exact call. Same as the DAW trim handle |
| `list_applied_edits_tool` | Committed-cut provenance from `editorial.edit_log` |
| `render_status_tool` | Stem freshness, premix, reconciliation stale |
| `history_status_tool` / `history_goto_tool` / `history_diff_tool` | Structured history inspector |
| `add_chapter_tool` / `remove_chapter_tool` / `list_chapters_tool` | Chapter markers |
| `add_comment_tool` / `list_comments_tool` / `get_comment_tool` / `update_comment_tool` | Timeline review comments (timeline clock) |
| `add_comment_action_tool` / `set_comment_action_done_tool` / `resolve_comment_tool` / `delete_comment_tool` | Comment action items + resolve |
| `add_effect_tool` / `list_effects_tool` | Per-track FFmpeg presets |
| `correct_transcript_tool` / `correct_transcript_phrase_tool` / `apply_transcript_cleanup_tool` / `low_confidence_words_tool` | Transcript fixes (history-safe; prefer batch cleanup for undo); pass `expected_text` to refuse a fix whose word indices changed meanwhile (#650) |
| `find_replace_transcript_tool` | Replace a literal word or phrase everywhere (whole words, every track and recording) in one undo step; `dry_run=true` returns `matches` / `count` / `skipped_words` only. Same preview and `ReplaceTranscriptMatches` as Studio Find and replace |
| `set_word_timing_tool` | Set one word's `start` / `end` in source seconds (`source_id` for a recording's own transcript, optional `expected_text` guard); same `SetTranscriptWordTiming` as the Studio Adjust word timing |
| `check_loudness_tool` | Measures the existing export WAV, falling back to premix. `pass` is the LUFS verdict. `stale` and `stale_reason` report known render age without writing audio; an explicit unrelated file has `stale: null` |
| `analyze_cleanup_tool` | Gate risk, low-audibility words, bleed flags, fade recommendations, reconciliation staleness |
| `audibility_map_tool` / `flagged_words_tool` | Cross-track word audibility map and suppression candidates |
| `reconciliation_status_tool` / `reconcile_transcript_tool` | Staleness check; manual reconciliation (automatic after `render_preview` by default) |
| `recommend_fades_tool` / `apply_fade_recommendations_tool` | Harsh edit boundaries |
| `low_audibility_words_tool` / `apply_low_audibility_suppression_tool` | Legacy single-track suppression (explicit apply) |
| `gate_overreach_tool` | Noise gate clipping detection |
| `render_preview` | Premix after edits |
| `history_undo` | Optional `rerender=true`; optional `expected_head_id` (from `history_status_tool`) refuses with `history_stale` if another edit landed since |
| `play_transcript_query_tool` | Search transcript + play match (topic audition) |
| `play_audio_tool` | Play by time range, `query`, or `processed:<id>` / `premix` |
| `play_compose_tool` | Mix a subset of tracks (`track_ids` + `processed`/`raw`) for a timeline window into `play_cache` (no mute/FX mutation) |
| `play_pending_preview_tool` | Current / Suggested / A/B full mix around a pending remove or mute. Suggested renders the edit as approving applies it (ripple, paced pad, fades); does not mutate. Host speakers. Share agents: `guest_pending_preview`. |
| `audition_context_tool` | The blind editor's ears for a timeline window: per-track captions + stem freshness (no audio). Payload `schema: audition_context.v2` adds typed `hypotheses[]` (windowed hum/clip at default `summary`; `speech_crosses_cut` for every splice in the window whose clip edge sits in voiced speech, with `removed_ms`, `suggested_source_sec` and `asr_disagrees`; `echo_risk` when one dialogue mic carries another speaker at one consistent lag far more often than the same pair time-shifted, with lag, level and the null rates; `clip_skew` when a single-track ripple moved one track's later clips out of step; clipping needs a peak at or above -20 dBFS), `suggested_listen[]`, explicit clocks, and `limits` (`echo_check_needs_fresh_stems` when stems are stale; `whisper_word_times` when a dialogue track in the window still has Whisper's own word times, i.e. its `tracks[].word_aligner` is `null` because no forced aligner ran; double-check cut points then, #780). Run it on every applied join before export; fix a clipped onset with the `trim_clip_edge_tool` call in `evidence.fix`, confirm an `echo_risk` by listening or from its per-pair evidence before gating with `podcast-mute-bleed`. `detail=visual` adds PNGs. Each track also carries a `prosody` window (pitch, rate, energy, prominent words, phrase boundaries) read from the pipeline's cached profile (`missing`/`stale` with a hint when no fresh profile is cached; `unavailable` with a redacted `error` when the cached profile cannot be read or parsed); top-level `prosody_notes` has up to 8 one-line summaries — see [pipeline.md § Prosody profile](pipeline.md#prosody-profile). |

MCP edit and playback handlers import `EditService`, `PlayService`, and their
related public names from `podcast_mcp.services.document`. The implementation
lives in `services/document/`; tool behavior and names are unchanged.

Share and session-control MCP handlers use the `services.collaboration` facade.
Record, identity, document-sync, session-sync, and remote-MCP helpers are imported
through their owning context facades. Tool names and permissions are unchanged.

### Structured arguments

List and object arguments are JSON values, not JSON text: `ids=["e1", "e2"]`, `track_ids=["host"]`, `config={"balance": {"dialogue_lufs": -18}}`, `selection={"kind": "clip", "id": "c1"}`. The tool schema gives each shape, and the server validates it before the tool runs. A client that sends the same structure as a JSON string still works. Free-text arguments are taken as written: `body="null"` stores the word "null" and `expected_text="[1]"` compares against "[1]"; send JSON `null` or omit the argument to leave it unset. Contract: [contributing.md § Structured MCP arguments](contributing.md#structured-mcp-arguments).

### Cancelling a long tool

`mcp.request_cancel.install_request_cancel`, installed once on the server in `mcp/server.py`, binds each host tool call's cancellation (`notifications/cancelled`, or the client dropping the request) to `util.project_state.current_cancel_check()`. What that stops (#1164):

- `export_audio_tool` passes it to `PipelineService.export_audio(cancel_check=...)`: checked before mastering and before encoding, and the running encode is stopped; an earlier `export/` is left untouched and the tool raises `CancelledProgress("Export cancelled")`. See [pipeline.md](pipeline.md#export-formats).
- `bounce_audio_tool` passes it to `BounceService.bounce`: checked before and after the stem render, after the mix and per trimmed range, and the running encode is stopped.
- `render_preview` passes it to `PipelineService.render_preview`: stops a wait for the render lock and the render between its steps (assemble timeline, mix); a step that has started runs to its end.
- `pipeline_run` without Studio running in the same process passes it to `PipelineService.run`: checked before each step and inside steps that poll it (transcribe, prosody, conversation alignment). With Studio's job manager the run is a Studio job with its own **Cancel**; the request's cancel does not reach it.
- Other host tools see it in two places on the tool's own thread: a wait for the render lock (`render_lock` falls back to `current_cancel_check()`), and a pipeline run nested in the call, such as `render_final` or a preview re-render, which checks it between steps (`render_cancel_scope(None)` and `PipelineRunner.run` without a check keep the enclosing one). Anything else, including work on pool threads (contextvars do not cross `run_parallel`), runs to its end.

After `notifications/cancelled` the SDK sends no response for that request; an in-process `auto`-mode client that cancels its own call can still receive the tool's result or error. An agent should not rely on either: check the files or make the next call.

### Tool errors

The mcp SDK passes an exception's text to the client only for its own `ToolError`; anything else reaches the agent as a bare `Error executing tool <name>`. `mcp.tool_errors.install_tool_errors`, installed once on the server in `mcp/server.py`, is the one boundary that decides what the agent sees (#488, #1178). Its rule lives in `util/tool_refusal.py`, which guest remote MCP shares, so a share-linked agent gets the same result shape ([host-online-relay.md § Remote MCP](host-online-relay.md#remote-mcp), #1182):

- **Busy lock.** A tool that waits out a busy `project_commit_lock` or `render_lock` (`ProjectBusyError` / `RenderBusyError`, or a raw `filelock.Timeout`) returns a structured `is_error` `CallToolResult` with `structured_content {ok: false, error, error_code: "project_busy"}`, the same code the GUI's HTTP 503 and guest remote MCP's `isError` result use, so an agent can branch on one string everywhere.
- **Refusal.** A `CodedError` (`util/coded_error.py`) returns the same shape with the refusal's own message (the text the CLI prints) and `error_code`. Examples: a stale `expected_text` guard (`transcript_changed`), `word_index_out_of_range`, `no_clip_at_time`, `transcript_not_found`, `track_not_found`, `comment_not_found`, `edit_not_found`, `clip_not_found`, a missing audio file (`file_not_found`) or project (`project_not_found`), no `project_path` and no `PODCAST_MCP_PROJECT` (`project_path_required`), a pending refine or align step (`transcript_refine_required`, `align_accept_required`), an undo or redo conflict (`merge_conflict`), and `publish_review_version_tool`'s `no_mix` (nothing rendered yet; run `render_preview`), `stale_mix` or `stale_master`. Re-read what the message names and retry; do not retry the same call unchanged. A refusal's message never carries another exception's text: `rerender_failed` says the move is saved and to re-render the preview, and the render's own error stays in the server log. A guest gets the same refusal with each host path in its message replaced by `[path]`.
- **Crash.** Any other exception is treated as a bug: the agent sees only `Error executing tool <name>`, and the server logs the traceback. Guest remote MCP returns the same text as an `isError` result. A plain `ValueError` is a crash here too, so a refusal an agent can act on is raised as a `CodedError` ([contributing.md § MCP tool errors](contributing.md#mcp-tool-errors)).

Argument validation errors (a wrong type, a missing required argument) are the SDK's own `ToolError` and keep their text. Guest remote MCP checks a call's arguments against the tool's signature before it runs and answers a bad one with JSON-RPC `-32602` and the validation text (`data.error_code: "invalid_arguments"`).

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
podcast edit suggest-handoff-cut --project ... --keep-left-end 2154.0 --keep-right-start 2167.0
podcast edit ripple-delete --project ... --start 0 --end 1289.5          # content cut: dead start
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
podcast edit trim-clip --project ... --clip clip_9c2a08cf --edge in --source-sec 1575.55   # ripple: every track moves; --mode gap for a punch; --yes cuts another track's speech
podcast edit roll-join --project ... --left clip_a --right clip_b --delta-sec 0.12
podcast edit delete-clips --project ... --ids clip_a,clip_b --mode ripple      # default --mode gap leaves gaps; --yes cuts speech outside the clips
podcast edit propose-range-cut --project ... --start 41.2 --end 43.0 --tracks host,guest
podcast edit copy-segment --project ... --start 41.2 --end 43.0 > clip.json     # --tracks host for one lane
podcast edit paste-segment --project ... --at 120 --clipboard clip.json         # - reads stdin; --mode gap pastes over in place
podcast transcript find-replace --project ... --search "Jon" --replace "John" --dry-run
podcast transcript set-word-timing --project ... --track host --word-index 812 --start 1201.40 --end 1201.62
podcast edit analyze-cleanup --project ...
podcast edit recommend-fades --project ...
podcast edit fade-joins --project ...
podcast edit crossfade-joins --project ...
podcast edit low-audibility --project ...
```

`podcast edit approve` prints the number of edits it applied. If no requested edits can be applied, it prints `Approved 0 edit(s).` and warns on stderr. A mute or remove whose source range no longer overlaps a clip stays pending for review.

Cut boundary optimization (default-on): [inaudible-cuts.md](inaudible-cuts.md). For punchline→pivot / “leave a beat” transitions, see **Narrative handoffs** there — use `suggest_handoff_cut_tool`, not word→word absorb. Its `retain_sec` / `--retain-sec` (default `1.0`, both sides) leaves ~2s of air at a default join; lower it (`0.3`–`0.6`) for a tighter conversational handoff — see [inaudible-cuts.md § Narrative handoffs](inaudible-cuts.md#narrative-handoffs).

NL removes also apply **filler pacing** from `tighten.min_gap_after_filler_sec` / `filler_room_tone_replace` / `filler_pad_mode` (same as auto-tighten): default replace expands the cut across the inter-word hesitation and sets `replace_gap_sec` so approve inserts a paced beat (**room_tone** by default; `silence` opt-in). The pad is sized from the span the remove finally removes, after boundary optimization, by the same `PacedPad` rule as auto-tighten, `clamp(min_gap_after_filler_sec, max(gap, span) × filler_gap_retain_fraction, filler_replace_gap_max_sec)` (`gap` is the flanking words' air when the cut takes the whole gap between them), so a remove whose edges move gets the pad for its final span (#1074). See [filler-cut-quality.md](filler-cut-quality.md) § Filler pacing floor. When another dialogue stem is speaking in the window (`tighten.speech_energy_guard`), the decision uses **`scope=track`** (punch silence on the cut track only) instead of cross-track ripple. When a peer's audio cannot be read at all, an unsuppressed peer word in the window does the same (#1145).

## Long raw sessions: content cut before tighten

Omit track and speaker for a session handoff to require quiet across all dialogue lanes, including muted lanes. Explicit selectors analyze one lane. Results list the analyzed `track_ids`. Missing or incomplete evidence cannot qualify a hop as quiet; each proposed boundary must lie in a shared measured quiet island. See [Narrative handoffs](inaudible-cuts.md#narrative-handoffs) for evidence and locking bounds.

On a long raw session, cut content before tightening:

1. Content-cut from the end of the episode toward the start with `ripple_delete_tool`. Off-topic runs and meta talk first (latest first): `suggest_handoff_cut_tool` → `ripple_delete_tool(use_inaudible_opt=false)`. The dead start (`start=0`) goes last, because it shifts everything after it.
2. Then run `propose_edits`. A done or waived refine stays clear through the ripple, because cut words still count as reviewed text ([transcript-workflow.md § What stales a refine decision](transcript-workflow.md#what-stales-a-refine-decision)). It sees only the kept words, so reject any tighten proposal made before the cut.

`analyze_focus_cuts` writes an outline, not a cut list, and is skipped when `focus.enabled` is false. Full order, CLI commands and rationale: [pipeline.md § Long raw sessions](pipeline.md#long-raw-sessions-content-cut-before-tighten).

## Edit reasons

- `filler:` / `pause:` — auto-tighten (`apply_edits` / pipeline `tighten_from_transcript`). Applies via **cross-track ripple delete** when peers are quiet: the same session timeline window is removed on all dialogue tracks and clips shift together. If `speech_energy_guard` finds peer speech, apply uses a **track-local punch** instead. **Transcript word times do not change** — they stay in source-media seconds; only the clips (the source↔timeline bridge) move, and words whose source span is fully cut are dropped. Decisions are removed from `edit_decisions` after apply (the timeline carries the edit).
- `nl:` — natural language / manual cuts (approve before render; same ripple / track-local rules)
- `agent:` — bulk plan from agent

Per-track-only tools (`strip_silence_tool`, track-local punch) do **not** ripple other tracks — use those when intentional single-track trimming is desired.
