# Natural language editing

Podcast MCP supports agent-driven editing in any **MCP-capable client**. Editing is **non-destructive**: decisions live in `episode.project.json`; raw audio in `raw/` is never overwritten.

## Editing MCP tools

| Tool | Purpose |
|------|---------|
| `build_edit_context` | Compact transcript + pending edits for the LLM |
| `get_transcript` | `format=json` or `format=timestamps` |
| `search_transcript_tool` | Find spans by text |
| `cut_time_range_tool` | Remove a time range |
| `cut_text_match_tool` | Remove matching transcript; returns the last five pending decisions as that command saw them, so another writer's edits that land afterwards never replace its own |
| `cut_utterance_tool` | Remove combined utterance by index |
| `cut_words_tool` | Remove word index range on a track |
| `apply_edit_plan_tool` | Bulk edit plan (`edits`: a list of cut objects) |
| `preview_inaudible_cut_tool` | Dry-run boundary optimization metadata |
| `suggest_handoff_cut_tool` | RMS silence-island OUT/IN for narrative handoffs (timeline); quiet means every lane is at or under its own voice floor, so there is no level argument; lock with `use_inaudible_opt=false` |
| `join_quality_tool` / `join_qa_sweep_tool` | Perceptual join continuity (advisory; disclaimer on every report) |
| `join_label_tool` | Explicit A/B pass/fail labels for the join ranker |
| `list_edit_decisions_tool` | List cuts |
| `approve_edits_tool` / `reject_edits_tool` | Review workflow; exact range proposals need the interactive host or an Editor, so these host agent tools refuse them. Studio's Apply suggested actions is `apply_suggested_actions_tool(project_path, ids=None, overrides=None)` (CLI `podcast edit apply-suggested [--ids a,b] [--override ID=ACTION]`): every pending tighten hit, or only those in `ids`, gets the one suggested action its kind of sound carries (`edits/cut_policy.py`: cut, shorten, lower or leave), in one undo step. Each edit in `propose_edits` and `list_edit_decisions_tool` carries a plain-words `label` and its `suggested_action`; `overrides` maps an id to a different action. To change one sound after the batch without undoing the others, call again with `revise=true` (CLI `--revise`) and `overrides={id: action}` and no `ids`: while the batch is still the latest edit (preview renders after it do not count) it steps back to before the batch and applies it again with that change, as one undo step; otherwise it refuses with `no_suggested_batch_to_revise`. Cut and shorten cut; lower turns the sound down 12 dB when another speaker talks over it and otherwise leaves it; leave dismisses the proposal and keeps the audio. Trusted human Apply suggested actions may override acoustic peer holds and records the session ripple in `cut_over_speaker`. Programmatic MCP, CLI, and pipeline calls retain fresh acoustic checks. More than one edit (`all_pending`, or several `ids`) is a bulk approve: a cut that covers a word the transcript is unsure about (`analysis.unsure_word_confidence`, 0.7 as shipped) stays pending and comes back in `held` with reason `unsure_word`; `override_audio_checks` does not release it, approve that one cut by passing its single id (CLI `edit approve --ids ID`) after checking the words with `low_confidence_words_tool`. `approve_edits_tool` returns `ids`, the edits this call approved (`len(ids) == approved_count`), alongside `held` and `confirm_ids`. The removed `confirm_cut_speech` and CLI `--yes` controls cannot grant authority; capabilities and textual consent do not create trusted interactive intent. A programmatic hold keeps the proposal pending; structural failures also hold for human approval. A pending remove or mute proposal whose source audio was cut away (no clip plays its span any more) is retired by the mutation that cut it, so it is never offered; approving one that survived from an older project is refused with `edit_span_not_played` and applies nothing, since its source seconds name no timeline place (#1487) |
| `propose_range_mute_tool` | Submit a serialized exact range as pending MUTE with an explicit retry command ID; see [reviewed bleed ranges](transcript-reconcile.md#reviewed-bleed-ranges) |
| `inspect_clip_bleed_tool` | Host-only, read-only inspection of one clip's automatic attenuation. Returns guarded targets for [occurrence Restore](audio-engineering.md#occurrence-restore-rendering). CLI: `podcast edit inspect-clip-bleed --project ... --clip ... --track ...` |
| `restore_clip_bleed_tool` | Host-only. Pass one unchanged inspected `target` to save that occurrence's Restore choice without rendering. Reuse `command_id` to retry the same submission. Inspect again after `bleed_restore_changed`. CLI: `podcast edit restore-clip-bleed --project ... --target target.json --command-id ...`, where the file contains one region target from inspection |
| `propose_range_cut_tool` | Seal a timeline `start`/`end` on chosen lanes (`track_ids`, default every dialogue lane) and submit it as pending exact CUT with an explicit retry command ID. Approved, it leaves a hole and later clips keep their places; same `EditSelectedRange` as the Studio range Cut. Agents only propose; the interactive host or `podcast edit approve` applies it |
| `edit_impact_report_tool` | Seconds cut and applied-edit count, read from `editorial.edit_log` (approved edits) plus applied decisions still in `edit_decisions`; mutes and structural ops (splits, trims, moves) remove no time. A cross-track ripple counts once in `total_removed_sec` and on every track in `by_track_sec`. Classification: `edits/edit_impact.py` |
| `propose_edits` / `apply_edits` | Filler/pause tightening (`propose_edits` returns `{operation, edits, skip_counts, summary}`, and each edit carries a plain-words `label`, a `suggested_action` (`cut`, `shorten`, `lower` or `leave`), a review `kind` (`filler`, `pause`, `repeat`, `false-start`, `sound` or `other`) and the raw `sound_kind` from one table, `edits/cut_policy.py` (a heard word outranks a laugh flag); discourse skips are `discourse:{token}` and kept acknowledgments (`tighten.backchannels`, such as a split `Uh` + `-huh.`) are `backchannel:{phrase}`; an acoustic hit that looks like a laugh keeps its proposal with reason `filler:acoustic:likely_laugh` and the summary counts it (`1 acoustic (review, 1 likely laugh)`); an acoustic hit the project's Whisper hears as a word keeps its proposal with reason `filler:acoustic:possible_word` and the summary counts it (`1 acoustic (review, 1 possible missed word)`); a Whisper model that is not installed leaves hits unlabelled and counts `word_probe:unavailable` in `skip_counts`; a span whose Whisper decode fails counts `word_probe:failed` and Propose still returns (the summary names both as `N word probe unavailable` / `N word probe failed`); each unavailable peer assessment rejects one candidate as `scope_unavailable` (also for acoustic candidates); every other candidate analysis rejection counts under its reason, such as `breath`, `next_onset`, `kept_word:{word}` or `kept_voice`, and a mute adds `voiced_edge` and `inaudible` ([filler-cut-quality.md § CLI / MCP](filler-cut-quality.md#cli--mcp)); optional `edit_mode=ripple|mute`, optional `intensity=light|medium|aggressive`; without it, shipped `pipeline.yaml` applies, not the GUI working set ([filler-cut-quality.md § Intensity presets](filler-cut-quality.md#intensity-presets))). A pause trim too small to hear against its pause is not proposed (`imperceptible`); one that passes the checks a filler passes applies with `apply_edits`, one that does not waits for review. Default is listen-first review, not bulk apply. |
| `ripple_delete_tool` | Ripple delete by time on every dialogue track. Name the speaker you mean to cut in `track_ids`; speech on any other track in the range returns `needs_confirmation` (its tracks, words and times) and changes nothing. Omitting `track_ids` names no track, so speech on any track requires review. Held cuts need trusted interactive approval in Studio |
| `ripple_delete_text_tool` | Ripple delete by transcript query; the matched speaker is the cut, and another track's speech in the span returns `needs_confirmation`; `override_audio_checks=true` applies it anyway; submits through the document plane (one History step, visible in an open Studio tab) |
| `move_segment_tool` / `move_by_text_tool` | Rearrange a time range on **all dialogue tracks** (shuffle, not clip-body drag); both submit through the document plane and reach an open Studio tab |
| `move_clips_tool` | Reposition specific clips (`timeline_start` / `track_id`); same as GUI body drag |
| `speaker_move_lane_span_tool` | Move a source span from one speaker-split lane to a sibling (mute here, reopen there; one undo). Studio **Move to {speaker}**. See [speaker-attribution.md](speaker-attribution.md) |
| `copy_segment_tool` / `paste_segment_tool` | Studio Copy and Paste. `copy_segment_tool` (read-only) returns the clipboard for `start`/`end`: `{duration, extracts}` from every track with clips in range, or only `track_ids`. `paste_segment_tool` submits that clipboard at `insert_at` as `PasteSegment`, the payload Studio Paste sends: in ripple mode a `duration` gap on every dialogue lane, each extract back on its own track. Paste again to place it twice. `mode` is `ripple` (default) or `gap`, which pastes over the pasted tracks in place and moves nothing. A clipboard that names an unknown track or source, or a source range outside the track's media, is rejected with `paste_unknown_track`, `paste_unknown_source`, `paste_bad_range` or `paste_bad_extract` before anything is written. To cut and paste, copy first, then cut (`propose_range_cut_tool` leaves a hole; `delete_clips_tool` with `mode="ripple"` closes the clips' span on every track). Unlike `move_segment_tool`, the source range is not removed and the timeline grows; undoable |
| `delete_clips_tool` | Delete whole clips by id (`clip_ids`). `mode="gap"` (default) leaves a gap; `mode="ripple"` closes the clips' span on every dialogue track, and speech outside the deleted clips (another track's, or an unselected clip's) returns `needs_confirmation` and leaves the project unchanged; only trusted interactive approval can override that acoustic hold. Same `DeleteClip` as the Studio clip Delete / Ripple delete |
| `roll_clip_join_tool` | Roll the join between two neighbouring clips that abut (touch within the join tolerance, `clips_abut`; across a gap the call is refused with `roll_needs_abutting_clips` and nothing changes) by `delta_sec` source seconds (positive is later); the pair keeps its length so later clips stay put. Reads the boundary token, then submits `RollClipJoin` like the Studio roll seam; a join that changed meanwhile is a conflict |
| `insert_gap_tool` | Open space on the timeline (splits straddling clips, then shifts later media, and moves comments and chapters after the point); one History step through the document plane |
| `strip_silence_tool` | Per-track silence stripping: silence is a run of 10 ms frames (16 kHz) under the track's own audibility floor (its voice floor) plus `over_voice_floor_db` (default 0); a track with no live audio is silence end to end, and one whose voice does not stand out of its room has none to strip |
| `shorten_gaps_tool` | Tighten inter-word pauses on every dialogue track; another speaker talking in a pause returns `needs_confirmation`; `override_audio_checks=true` applies it anyway |
| `fade_joins_tool` | Declick butt-splice fades at clip joins (default dialogue mode). An applying run submits through the document plane (one History step, visible in an open Studio tab); `dry_run=true` only previews and writes nothing |
| `crossfade_joins_tool` | Opt-in overlapping crossfade at joins (music / explicit blend). An applying run submits through the document plane (one History step, visible in an open Studio tab); `dry_run=true` only previews and writes nothing |
| `list_clips_tool` | Clip timeline for GUI/agents (`join_in_mode`, `source_id`, required `source_duration_sec` (`number | null`) and `recording_key` (`string | null`) for the clip's own recording, which `trim_edge_limits` stops at; `recording_key` is a host-install-keyed HMAC identity, equal for clips that play the same resolved recording and resistant to guessed-path confirmation by share guests, `origin_track_id`, effective join render `join_left_clip_id` / `join_render_mode` / `join_crossfade_ms` / `join_crossfade_blocked`, and `join_borrow_sec` while the join blends) |
| `set_clip_join_tool` | One join's mode plus fades (`left_clip_id`, `right_clip_id`, `mode`, `length_ms?`); `set_join_mode_tool` is mode-only |
| `trim_clip_edge_tool` | Move one clip's `in` / `out` edge to a source-media second (expansion clamped to unused source). `mode=ripple` (default) moves every dialogue track by the duration change: a track with a clip edge at the same instant (a session-wide cut) moves that edge too, and every other track loses the trimmed span or gets the same length of silence, so no trim desyncs the speakers. A ripple that shortens over another track's speech returns `needs_confirmation` and leaves the project unchanged; only trusted interactive approval can override that acoustic hold. `mode=gap` moves only the grabbed edge, up to the neighbouring clip, and leaves silence. The tool obtains the current boundary revision for that mode under the project transaction before its guarded save. `speech_crosses_cut`'s `evidence.fix` gives the exact call. Same as the DAW trim handle |
| `list_applied_edits_tool` | Committed-cut provenance from `editorial.edit_log` |
| `render_status_tool` | Stem freshness, premix, reconciliation stale |
| `history_status_tool` / `history_list` / `history_goto_tool` / `history_diff_tool` | Structured history inspector. Status reports cursor, count, current label, head ID and undo/redo flags. List reports cursor, head ID, undo/redo flags, flat entries and grouped actions. |
| `add_chapter_tool` / `remove_chapter_tool` / `list_chapters_tool` | Chapter markers |
| `add_comment_tool` / `list_comments_tool` / `get_comment_tool` / `update_comment_tool` | Timeline review comments (timeline clock) |
| `add_comment_action_tool` / `set_comment_action_done_tool` / `resolve_comment_tool` / `delete_comment_tool` | Comment action items + resolve |
| `add_effect_tool` / `list_effects_tool` | Per-track FFmpeg effects. Supported chain effects: `highpass`, `acompressor`, `loudnorm`, `afftdn`, `arnndn`, `bandreject`, `deesser`, `agate`, `equalizer`. Unsupported effects such as `volume` and `alimiter` are refused; saved unsupported entries remain visible with a warning and are skipped during rendering. |
| `correct_transcript_tool` / `correct_transcript_phrase_tool` / `apply_transcript_cleanup_tool` / `low_confidence_words_tool` | Transcript fixes (history-safe; prefer batch cleanup for undo; cleanup and `verify_transcript_tool` submit through the document plane, so an open Studio tab sees them); pass `expected_text` to refuse a fix whose word indices changed meanwhile (#650) |
| `find_replace_transcript_tool` | Replace a literal word or phrase everywhere (whole words, every track and recording) in one undo step; `dry_run=true` returns `matches` / `count` / `skipped_words` only. Same preview and `ReplaceTranscriptMatches` as Studio Find and replace |
| `set_word_timing_tool` | Set one word's `start` / `end` in source seconds (`source_id` for a recording's own transcript, optional `expected_text` guard); same `SetTranscriptWordTiming` as the Studio Adjust word timing |
| `check_loudness_tool` | Measures the existing export WAV, falling back to premix. `pass` is the LUFS verdict. `stale` and `stale_reason` report known render age without writing audio; an explicit unrelated file has `stale: null` |
| `analyze_cleanup_tool` | Gate risk, low-audibility words, bleed flags, fade recommendations, reconciliation staleness |
| `audibility_map_tool` / `flagged_words_tool` | Cross-track word audibility map and suppression candidates |
| `reconciliation_status_tool` / `reconcile_transcript_tool` | Staleness check; manual reconciliation (automatic after `render_preview` by default). An applying run submits through the document plane (one History step, visible in an open Studio tab); `dry_run=true` only previews and writes nothing |
| `recommend_fades_tool` / `apply_fade_recommendations_tool` | Harsh edit boundaries; applying the list submits through the document plane (one History step, visible in an open Studio tab) |
| `low_audibility_words_tool` / `apply_low_audibility_suppression_tool` | Legacy single-track suppression (explicit apply); `words` items need `track_id` and `word_index` (`source_id` optional; other row keys are ignored and not journaled); `word_index` is coerced to an integer (`"1"`, `1.0` and `true` become 1; 2.7 and -1 are refused) and `track_id` / `source_id` must be strings, else a coded `invalid_payload` (details in [session sync](session-sync.md)) |
| `gate_overreach_tool` | Noise gate clipping detection |
| `render_preview` | Premix after edits |
| `history_undo` | Optional `rerender=true`; optional `expected_head_id` (from `history_status_tool`) refuses with `history_stale` if another edit landed since |
| `play_transcript_query_tool` | Search transcript + play match (topic audition) |
| `play_audio_tool` | Play by time range, `query`, or `processed:<id>` / `premix` |
| `play_compose_tool` | Mix a subset of tracks (`track_ids` + `processed`/`raw`) for a timeline window into `play_cache` (no mute/FX mutation) |
| `play_pending_preview_tool` | Current / Suggested / A/B full mix around a pending remove or mute. Suggested renders the edit as approving applies it (ripple, paced pad, fades); `pad_sec` (0 to 10, default 0.5) is the audio either side, clamped to the timeline; the master loudness stage is not applied, so A and B compare to each other, not to the exported file's level; does not mutate. Host speakers. Share agents: `guest_pending_preview`. |
| `audition_context_tool` | The blind editor's ears for a timeline window: per-track captions + stem freshness (no audio). Payload `schema: audition_context.v2` adds typed `hypotheses[]` (windowed hum/clip at default `summary`; `speech_crosses_cut` for every splice in the window whose clip edge sits in voiced speech, with `removed_ms`, `suggested_source_sec` and `asr_disagrees`; `echo_risk` when one dialogue mic carries another speaker at one consistent lag far more often than the same pair time-shifted, with lag, level and the null rates; `clip_skew` when a single-track ripple moved one track's later clips out of step; clipping needs a peak at or above -20 dBFS), `suggested_listen[]`, explicit clocks, and `limits` (`echo_check_needs_fresh_stems` when stems are stale; `whisper_word_times` when a dialogue track in the window still has Whisper's own word times, i.e. its `tracks[].word_aligner` is `null` because no forced aligner ran; double-check cut points then, #780). Run it on every applied join before export; fix a clipped onset with the `trim_clip_edge_tool` call in `evidence.fix`, confirm an `echo_risk` by listening or from its per-pair evidence before gating with `podcast-mute-bleed`. `detail=visual` adds PNGs. Each track also carries a `prosody` window (pitch, rate, energy, prominent words, phrase boundaries) read from the pipeline's cached profile (`missing`/`stale` with a hint when no fresh profile is cached; `unavailable` with a redacted `error` when the cached profile cannot be read or parsed); top-level `prosody_notes` has up to 8 one-line summaries — see [pipeline.md § Prosody profile](pipeline.md#prosody-profile). |

MCP edit and playback handlers import `EditService`, `TimelineService`,
`TranscriptService`, `AnalysisService`, `PlayService`, and their related public
names from `podcast_mcp.services.document`. `history_diff_tool` serializes the
service's typed empty or populated diff result as an ordinary dictionary. Empty
history has four fields; a selected comparison has eight, including nullable
operation and params. See [History diff results](history.md#history-diff-results).
The implementation
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
- `pipeline_run` without Studio running in the same process passes it to `PipelineService.run`: checked before each step and inside steps that poll it (transcribe, prosody, conversation alignment). With Studio's job manager (`services/jobs`) the run is a Studio job with its own **Cancel**; the request's cancel does not reach it.
- Other host tools see it in two places on the tool's own thread: a wait for the render lock (`render_lock` falls back to `current_cancel_check()`), and a pipeline run nested in the call, such as `render_final` or a preview re-render, which checks it between steps (`render_cancel_scope(None)` and `PipelineRunner.run` without a check keep the enclosing one). Anything else, including work on pool threads (contextvars do not cross `run_parallel`), runs to its end.

After `notifications/cancelled` the SDK sends no response for that request; an in-process `auto`-mode client that cancels its own call can still receive the tool's result or error. An agent should not rely on either: check the files or make the next call.

### Progress reports

`mcp/server.py` installs the host's progress relay through `podcast_mcp.util.progress` (the `install_mcp_progress` sink). A tool reports progress through that package's `progress_task` and `resolve_progress`, not its own timer; see [progress.md](progress.md).

### Tool errors

The mcp SDK passes an exception's text to the client only for its own `ToolError`; anything else reaches the agent as a bare `Error executing tool <name>`. `mcp.tool_errors.install_tool_errors`, installed once on the server in `mcp/server.py`, is the one boundary that decides what the agent sees (#488, #1178). Its rule lives in `util/tool_refusal.py`, which guest remote MCP shares, so a share-linked agent gets the same result shape ([host-online-relay.md § Remote MCP](host-online-relay.md#remote-mcp), #1182):

- **Busy lock.** A tool that waits out a busy `project_commit_lock` or `render_lock` (`ProjectBusyError` / `RenderBusyError`, or a raw `filelock.Timeout`) returns a structured `is_error` `CallToolResult` with `structured_content {ok: false, error, error_code: "project_busy"}`, the same code the GUI's HTTP 503 and guest remote MCP's `isError` result use, so an agent can branch on one string everywhere.
- **Refusal.** A `CodedError` (`util/coded_error.py`) returns the same shape with the refusal's own message (the text the CLI prints) and `error_code`. Examples: a stale `expected_text` guard (`transcript_changed`), `word_index_out_of_range`, `word_source_required` (a word command's bare `word_index` on a track recorded as several takes with no primary transcript: pass the word's `source_id`), `word_source_unknown`, `no_clip_at_time`, `roll_needs_abutting_clips` (a roll across a gap: move a clip to touch the other, or trim an edge), `transcript_not_found`, `track_not_found`, `comment_not_found`, `edit_not_found`, `clip_not_found`, a missing audio file (`file_not_found`) or project (`project_not_found`), no `project_path` and no `PODCAST_MCP_PROJECT` (`project_path_required`), a pending refine or align step (`transcript_refine_required`, `align_accept_required`), an undo or redo conflict (`merge_conflict`), and `publish_review_version_tool`'s `no_mix` (nothing rendered yet; run `render_preview`), `stale_mix` or `stale_master`. Re-read what the message names and retry; do not retry the same call unchanged. A refusal's message never carries another exception's text: `rerender_failed` says the move is saved and to re-render the preview, and the render's own error stays in the server log. A guest gets the same code with the refusal's guest message: its own text when it names no host path, otherwise a fixed path-free line.
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

## Editing CLI

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
podcast edit trim-clip --project ... --clip clip_9c2a08cf --edge in --source-sec 1575.55   # ripple: every track moves; --mode gap for a punch; held cuts name their finding; add --override-audio-checks to apply them
podcast edit roll-join --project ... --left clip_a --right clip_b --delta-sec 0.12
podcast edit delete-clips --project ... --ids clip_a,clip_b --mode ripple      # default --mode gap leaves gaps; held cuts name their finding; add --override-audio-checks to apply them
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

`podcast edit approve` prints the number of edits it applied. A held source REMOVE exits with `cut_scope_changed`, leaves all selected edits pending, and leaves the saved project unchanged. A stale MUTE whose source range no longer overlaps a clip stays pending; if nothing else applies, the command prints `Approved 0 edit(s).` and warns on stderr.

### Audio checks and the owner override

The automatic audio-quality and cut-position checks run on every edit from every surface (CLI, host MCP, share MCP with the Editor capability, Studio). They hold a cut whose edge lands mid-word, whose join would be audible, or that cuts another speaker, and the refusal names the held cut, the finding and the override. They are not a permission: the owner can apply any held edit without Studio.

- CLI: add `--override-audio-checks` to `edit approve`, `edit apply-suggested`, `edit ripple-delete`, `edit trim-clip`, `edit delete-clips` or `edit shorten-gaps`. `edit approve --all` (or `--ids`) applies the proposals that pass, leaves the held ones pending and lists them (a long list is summed up by reason), including a proposal whose audio was already cut away and including any cut that sits right beside a held one (it waits with it, so nothing is applied on a guess); `edit held` lists what the checks would hold and why, changing nothing. `propose_edits` (and `podcast propose-edits`) runs the same check on a scratch copy as it proposes: each proposal row carries `audio_check` (`clean`, or `held` with the reason), and the summary counts the held ones, so a proposal Approve all would refuse is not offered as ready. A row has no `audio_check` when the audio could not be read for the check.
- Host MCP: `override_audio_checks=true` on `approve_edits_tool` (`all_pending=true` approves everything pending; ids or all, it returns `held`), `apply_suggested_actions_tool`, `ripple_delete_tool`, `ripple_delete_text_tool`, `trim_clip_edge_tool`, `delete_clips_tool`, `shorten_gaps_tool` and `update_pending_edit_tool`.
- Host MCP edit tools that map to a catalog command (`set_join_mode_tool`, `set_clip_join_tool`, `move_segment_tool`, `duplicate_segment_tool`, `add_chapter_tool`, the transcript correction and word-state tools, the pending-edit reject, update, revert and suggested-action tools, chapter removal, the effect add, remove and bypass tools, the clip fade and edge trim tools, the staged cut tools, edit approval, the bleed and low-audibility suppression and alignment-mode tools, and the split, delete, move and paste tools) submit it on the document plane, so each is one undo step and journals for open Studio tabs (#1809). `apply_transcript_gate_tool`, `align_retained_bleed_tool` and `mute_off_speaker_tool` run under the render lock instead: only the gate rewrites stems, align moves clip placement and re-renders the preview, and off-speaker sets clip mute regions. They journal one row per apply; see [session sync](session-sync.md).
- Share MCP and the document plane: `override_audio_checks: true` in the payload of `ApproveEdits`, `ApplySuggestedActions`, `UpdatePendingEdit`, `TrimClipEdge`, `DeleteClip`, `CutRange` or `EditSelectedRange`, for any share whose capabilities already allow that command.

The override skips the audio-quality, join and other-speaker checks for that one call and keeps the bounds exactly as given (no snapping). It does not skip project-integrity holds (source geometry, recording identity, pad placement). Each use is recorded as `audio_check_override: {kind: "owner_override", actor, surface}` in the History entry's params and on every applied edit in the edit log, so the log shows who applied a cut over a hold and through which surface. The override never changes who the caller is: a CLI or agent call is not recorded as a Studio human.

Cut boundary optimization (default-on): [inaudible-cuts.md](inaudible-cuts.md). For punchline→pivot / “leave a beat” transitions, see **Narrative handoffs** there — use `suggest_handoff_cut_tool`, not word→word absorb. Its `retain_sec` / `--retain-sec` (default `1.0`, both sides) leaves ~2s of air at a default join; lower it (`0.3`–`0.6`) for a tighter conversational handoff — see [inaudible-cuts.md § Narrative handoffs](inaudible-cuts.md#narrative-handoffs).

NL removes also apply **filler pacing** from `tighten.min_gap_after_filler_sec` / `filler_room_tone_replace` / `filler_pad_mode` (same as auto-tighten): default replace expands the cut across the inter-word hesitation and sets `replace_gap_sec` so approve inserts a paced beat (**room_tone** by default; `silence` opt-in). The pad is sized from the span the remove finally removes, after boundary optimization, by the same `PacedPad` rule as auto-tighten, `clamp(min_gap_after_filler_sec, max(gap, span) × filler_gap_retain_fraction, filler_replace_gap_max_sec)` (`gap` is the flanking words' air when the cut takes the whole gap between them), so a remove whose edges move gets the pad for its final span (#1074). See [filler-cut-quality.md](filler-cut-quality.md) § Filler pacing floor. When another dialogue stem is speaking in the window (`tighten.speech_energy_guard`), a filler or NL cut goes to review as a session ripple that records the speech it would cut; programmatic approval holds, while trusted interactive approval ripples every dialogue track, never a one-track punch. A pause trim does the same, and holds at approval if the conflict is still there with no recorded context. When a peer's audio cannot be read at all, an unsuppressed voiced peer word in the window supplies completed peer-speech evidence (#1145). If assessment itself raises `OSError` or `ValueError`, the manual proposal raises `cut_scope_changed` before publishing a decision. Generated proposals reject before initial planning and after final edge movement, counting one `scope_unavailable`. Saved session approval reassesses its actual span and holds unavailable assessment; a saved track scope (an explicit gap edit) retains its selected operation. A paced pad on a track with no quiet stretch to sample as room tone stays silent on that track; the cut applies. A hold names the cut by speaker, kind and time, not only its id.

## Long raw sessions: content cut before tighten

Omit track and speaker for a session handoff to require quiet across all dialogue lanes, including muted lanes. Explicit selectors analyze one lane. Results list the analyzed `track_ids`. Missing or incomplete evidence cannot qualify a hop as quiet; each proposed boundary must lie in a shared measured quiet island. See [Narrative handoffs](inaudible-cuts.md#narrative-handoffs) for evidence and locking bounds.

On a long raw session, cut content before tightening:

1. Content-cut from the end of the episode toward the start with `ripple_delete_tool`. Off-topic runs and meta talk first (latest first): `suggest_handoff_cut_tool` → `ripple_delete_tool(use_inaudible_opt=false)`. The dead start (`start=0`) goes last, because it shifts everything after it.
2. Then run `propose_edits`. A done or waived refine stays clear through the ripple, because cut words still count as reviewed text ([transcript-workflow.md § What stales a refine decision](transcript-workflow.md#what-stales-a-refine-decision)). It sees only the kept words, so reject any tighten proposal made before the cut.

`analyze_focus_cuts` writes an outline, not a cut list, and is skipped when `focus.enabled` is false. Full order, CLI commands and rationale: [pipeline.md § Long raw sessions](pipeline.md#long-raw-sessions-content-cut-before-tighten).

## Edit reasons

- `filler:` and `pause:` — auto-tighten (`apply_edits` / pipeline `tighten_from_transcript`) when they need no review. A pause remains a session ripple and must remove a positive, perceptible amount of current playback while retaining enough qualified original quiet. Pause trims add no replacement pad. Known peer conflicts keep a session review suggestion with actual CutSpeech context; programmatic approval holds that speech, while trusted interactive approval ripples every dialogue track, never a one-track punch. A fresh session scope conflict on a suggestion that recorded no such context holds instead of converting to a punch. A cut stored as a named `track` gap (Delete in gap mode) stays local; a stored track pause holds. Every ordinary SOURCE REMOVE, including NL and Focus, needs complete unique continuous origin-media geometry at preparation and completed application. Every selected origin placement must also lie on a canonical operation lane; parked MUSIC holds with `operation_scope`, and geometric validity does not waive fresh speech checks. A saved selected hold reports batch restoration only after history and editable/render recovery complete; automatic holds stay pending while independent survivors apply. Suggested uses a preview copy and reports its own hold. Transcript word times remain source seconds; applied clips and archive bounds carry the actual change.
- `nl:` — natural language / manual cuts (approve before render; same ripple / track-local rules)
- `agent:` — bulk plan from agent

Per-track-only tools (`strip_silence_tool`, track-local punch) do **not** ripple other tracks — use those when intentional single-track trimming is desired.


**Fill a range with room tone** (#1136). `fill_with_room_tone_tool` with `track_id`, `start_sec` and `end_sec` fills only the gaps between clips inside that range; clips are untouched. It refuses with `nothing_to_fill`, `no_source` or `range_incomplete`; see [filler-cut-quality.md](filler-cut-quality.md) § Where room tone comes from.

## Restore an applied edit

`revert_applied_edit_tool` supports ordinary source MUTE archives. Cuts and exact ranges return `local_restore_requires_history` before mutation. Use `history_status`, then `history_undo` with the current `expected_head_id` to restore the whole action. History Undo also undoes the other edits in that action. You may need to undo later actions first. Archive clocks remain cut-edge display data and never identify removed recordings.
