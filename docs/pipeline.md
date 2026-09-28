# Pipeline

Default step order (see [transcript-workflow.md](transcript-workflow.md) for transcript layers):

1. `ingest_tracks` — Probe audio, validate paths
2. `transcribe_tracks` — faster-whisper per dialogue track (and per extra source file). **Reuses** any stored transcript whose `audio_sha256` matches the media (legacy/seeded transcripts with words but no hash are adopted and stamped, unless the ASR caches show that track was only transcribed from other audio, which counts as changed audio; the media is re-hashed only when its size or mtime changed); ASR runs only for missing transcripts, changed audio, or `transcribe.overwrite: true` (CLI `--force`, MCP/GUI `force_transcribe`, Studio Re-transcribe). Replacing a hand-edited transcript (`user_edited`) whether forced or because its audio changed, is refused in unattended runs (`TranscriptOverwriteRefused`) unless Studio Re-transcribe confirmed it (`overwrite_edited`) and overwritten with a warning plus "N edited overwritten" in attended runs. ASR skips silence with faster-whisper's built-in Silero VAD (`transcribe.vad`, same bundled model as `tighten.vad`) and hallucination-safe decode options (`transcribe.decode`: temperature `[0, 0.2, 0.4]`, `hallucination_silence_threshold` 2 s; `condition_on_previous_text` stays on and, when turned off, the vocabulary prompt is sent as `hotwords`). After ASR, words whose own-track peak is below `transcribe.silence_filter.peak_dbfs` (-60) are flagged `suspect_hallucination` (informational, never deleted; reused transcripts are re-flagged when audio, filter settings or word spans change; unchanged runs reuse stored flags without decoding audio; the summary counts flags on every transcribed or reused track and adds "silence filter skipped on N track(s)" when a track cannot be decoded; that track keeps only aligner-evidence flags and is retried next run). **Upgrading:** the VAD / decode options are part of the ASR cache key, so existing ASR cache entries miss once and Whisper re-runs the next time a track needs ASR. Stored project transcripts are still reused by `audio_sha256` and keep their old words (no VAD) until Re-transcribe (`force_transcribe`, CLI `--force`). The next pipeline run still flags them. `transcribe.decode.temperature` is yaml / `config_json` only (no Pipeline pane field). `transcribe.forced_alignment.enabled` (off by default; English only; model via `podcast bootstrap --component word-aligner`) re-times Whisper's words with a local CTC aligner right after ASR (it streams the 16 kHz decode once through `FFmpegEngine.stream_mono_f32` + `SequentialWindowReader`, holding about one ≤21 s window plus one decode chunk resident, whatever the track length (a single word span longer than 20 s, e.g. a Whisper word stretched across a silence, gets its own window as long as the span); spans come out identical to a whole-file decode, so caches stay valid, #730): results are cached beside the ASR cache, along with each placed word's `alignment_score` (mean CTC posterior); a score below `transcribe.forced_alignment.min_word_score` (default 0.01, 0 = off) also sets `suspect_hallucination` (#195); words it cannot place keep Whisper's times clamped between their re-timed neighbours, so words stay in time order (a word the clamp collapses to zero length is flagged `deferred`), and all words keep Whisper's times when the model is missing; outcomes go to the summary ("N words re-timed", "N reused track(s) not re-timed (Re-time words to re-time)" for reused transcripts with words, in a language the aligner supports, whose `word_aligner` or `alignment_score_method` is not the current one, "forced alignment kept Whisper timestamps on N track(s)") and `artifacts/transcript_timing.json` → `forced_alignment`. Stored transcripts are re-timed by the run-only `retime_words` flag (Studio **Re-time words**, CLI `--retime-words`, MCP `pipeline_run(retime_words=true)`): it moves reused transcripts whose ASR cache is present (same model, language, vocabulary prompt and decode) into the run and re-aligns Whisper's cached words — Whisper itself does not run; combining it with `--force` / `force_transcribe` is rejected. Hand-edited transcripts are re-timed only with the same confirmation Re-transcribe uses (`overwrite_edited`); otherwise the summary reports "N edited track(s) not re-timed (confirm replacing their edits to re-time)". Reused transcripts with no ASR cache for the current inputs are reported as "N track(s) with no ASR cache not re-timed (Re-transcribe to re-time)". A successful re-time reports "N reused track(s) re-timed from the ASR cache", and a track whose alignment fails reports "N track(s) not re-timed (forced alignment failed)". `transcript_timing.json` → `forced_alignment.retime` lists `retimed` / `failed` / `skipped_edited` / `skipped_no_asr_cache`. A `retime_words` run that has any track to re-time or transcribe fails before touching any transcript when the word aligner cannot load (not downloaded: `podcast bootstrap --component word-aligner`); one with nothing to run does not load or hash the aligner. `podcast transcribe` re-times only by re-running ASR (Re-transcribe / `--force`); the anomalous-duration flag runs on the final (aligned) spans. Cancel stops the step before the next track and before each forced-alignment pass (`CancelledProgress`). Each ASR run reports `transcribe_audio` progress in audio seconds
3. `align_tracks` — Conversation-clock placement (bleed phrases / own-speech gaps); default on; uncheck for unrelated clips
4. `require_align_accept` — Gate until align done/waived (`align.accept.mode`; auto-waive with `--unattended`, but never moves above `align.large_move_sec`)
5. `merge_transcript` — Combined time-ordered script
6. `render_dialogue_stems` — Pass-1 per-track stems for audibility (queues no waveform pyramids; `assemble_timeline` does)
7. `reconcile_transcript` — Pass 1: audibility/bleed suppress
8. `precorrect_transcript` — Glossary and cross-track sync
9. `require_transcript_refine` — Hard agent gate (`refine-done` / waive; auto-waive with `--unattended` / `PODCAST_BATCH=1` when mode is `waive_unattended`; after an active gate, a successful unattended run refreshes its waiver only for later suppression changes)
10. `analyze_prosody` — Cache a per-track prosody profile (pitch, rate, energy, voice quality, prominent words, phrase boundaries) for `audition_context` to read. On by default (`prosody.enabled`); a no-op with a clear summary when the optional `praat-parselmouth` backend is not installed. See [§ Prosody profile](#prosody-profile).
11. `analyze_focus_cuts` — writes `artifacts/focus_outline.md`: an **outline for the agent, not a cut list** (its `focus:*` hints are optional). Off unless `focus.enabled`; when off it writes nothing and only reports `skipped (focus.enabled=false)`. On long raw sessions, see [§ Long raw sessions](#long-raw-sessions-content-cut-before-tighten).
12. `focus_from_transcript` — No-op unless `focus.auto_apply`
13. `analyze_fillers_pauses` — Mark filler words and long pauses (**no-op** unless `tighten.enabled`). Manual `propose_edits` uses `tighten.edit_mode` (`ripple` default, or `mute`); `tighten.intensity` (`light`/`medium`/`aggressive`, [filler-cut-quality.md § Intensity presets](filler-cut-quality.md#intensity-presets)) overlays preset values at propose time.
14. `tighten_from_transcript` — Apply filler/pause edit decisions (**no-op** unless `tighten.enabled`)
15. `clean_audio` — HPF per dialogue track
16. `compress_tracks` — acompressor on dialogue (attack/release/makeup from `compression.*`; default makeup 0; balance measures after it; the step owns each dialogue chain's single acompressor: any existing one, whether from an earlier run, the `podcast_standard` preset or `add_effect`, is overwritten in place with `compression.*` (position and bypass kept), extra acompressors are removed, and both are logged and counted in the step summary; to keep a hand-tuned compressor, skip the step: MCP `pipeline_run(skip_steps_json='["compress_tracks"]')`, CLI `--skip compress_tracks`, or uncheck **Compress tracks** in the Pipeline pane)
17. `balance_tracks` — gain staging from **post-FX, speech-gated** loudness (the track's chain, own non-suppressed transcript words; ungated without a transcript); the summary reports the achieved level per track
18. `assemble_timeline` — Final stems after edits + FX
19. `reconcile_transcript` — Pass 2: post-FX audibility refresh
20. `mix_with_music` — Intro/outro/bed + ducking envelopes
21. `master_loudness` — two-pass loudnorm to podcast target (pass 1 is `ebur128`; `master_qc.json` records `normalization_type`); rebuilds a missing or stale premix first; writes `artifacts/master_qc.json` verification report and `artifacts/mastered.hash`. Progress: `master_loudnorm` / `master_qc_measure` children in media seconds (ffmpeg `-progress`).
22. `export_deliverables` — re-masters when `mastered.hash` doesn't match the current premix. A master with no hash (mastered before #425) is re-mastered once, and an imported or legacy episode with only `mastered.wav` and no `premix.wav` is re-assembled, re-mixed and re-mastered instead of exported as-is; audio (WAV + configured FFmpeg formats), SRT, MD; writes `artifacts/export_qc.json` (reconciliation staleness + mastering QC + unaccepted relative align drift rollup — check `ok` before shipping; a clean run is `ok` — `mix_with_music` does not stale reconciliation (#621))

Transcript quality runs **before** focus/tighten so search and narrative edits use reconciled, precorrected, refined text.

## Long raw sessions: content cut before tighten

The default pipeline makes no content cuts: focus and tighten are off, so a raw 28-minute session exports at 28 minutes. On a long raw session (pre-show chatter, off-topic runs, meta talk), do the **content cut before you tighten**. Tighten proposals in material you later remove waste review time for both the agent and the human. On the lab tape, 62 of 80 `propose-edits` hits fell in pre-show chatter that the human edit drops.

1. **Content cut first** (timeline seconds, all dialogue tracks). Read the whole transcript (`podcast edit transcript` / `get_transcript(combined=true, format=timestamps)`) and decide the kept ranges. A content cut usually removes far more than the 15% guard, so get explicit sign-off on the kept ranges first. Then:
   - Cut from the end of the episode toward the start, so timeline times you already looked up stay valid. Otherwise search again after each ripple.
   - **Off-topic run or meta talk** (latest run first): run `podcast edit suggest-handoff-cut --track <id> --keep-left-end <L> --keep-right-start <R>` (`suggest_handoff_cut_tool`). Then run `podcast edit ripple-delete --start <cut_start> --end <cut_end> --no-inaudible-opt` (`ripple_delete_tool(..., use_inaudible_opt=false)`). See [inaudible-cuts.md § Narrative handoffs](inaudible-cuts.md).
   - **Dead start, last:** it is always the leftmost cut (`--start 0`) and shifts everything after it left, so cut it after every off-topic run. Find the first kept line's `timeline_start` with `podcast edit search --query "<first kept line>"` (`search_transcript_tool`). Then run `podcast edit ripple-delete --start 0 --end <timeline_start − ~0.5>` (`ripple_delete_tool`).
   - Use ripple deletes, not per-track `cut_time_range_tool` / `apply_edit_plan_tool` decisions. With peer speech in the window, those become a track-local punch (`speech_energy_guard`) and leave a hole.
2. **Re-clear the refine gate after every ripple.** An applied cut drops the removed words, which changes the precorrect fingerprint. A done or waived refine then goes stale (`podcast transcript refine-status` shows `"stale": true`), and the next ripple, approve or `propose-edits` raises `TranscriptRefineRequiredError`. Re-waive with `podcast transcript refine-waive --reason "content cut: structural edit"` (`transcript_refine_waive_tool`), or run `refine-done` if you refined again.
3. **Then tighten the kept range:** `podcast propose-edits` (`propose_edits`). The ripple dropped the removed words, so proposals come only from kept material, and there is no range argument. Content cuts still pending (`review_required`, not approved) keep their words, so approve them first. The ripple does not remove tighten proposals made before the content cut: reject them (`podcast edit reject --ids …` / `reject_edits_tool`) and propose again.
4. **`analyze_focus_cuts` is an outline, not a cut list.** It writes `artifacts/focus_outline.md` for the agent to read (**podcast-focus-episode**). Its heuristic `focus:*` hints are optional and often empty; it proposed 0 cuts on the lab tape. With the default `focus.enabled: false` it writes nothing and reports only `skipped (focus.enabled=false)`.

Skills: **podcast-pipeline-run**, **podcast-edit-natural-language** (content-cut tools), **podcast-tighten-dialogue**, **podcast-focus-episode**. Tool reference: [nl-editing.md § Long raw sessions](nl-editing.md#long-raw-sessions-content-cut-before-tighten).

## Prosody profile

`analyze_prosody` (step 10, `group=editorial`, `kind=tooling`, `depends_on=(precorrect_transcript,)`, `noop_unless=prosody.enabled`) gives the agent a prosodic description of delivery — pitch, rate, energy, voice quality, prominent words, and phrase boundaries — that the transcript alone cannot: it runs once per dialogue track's primary media, caches the result, and never mutates the timeline. `audition_context` (`play_context` / `audition_context_tool` / `guest_audition_context`) reads the cache; it never recomputes (#196). The DAW's **Prosody** layer reads the same cache through `GET /api/project/prosody` (`PlayService.prosody_overlay` → `edits.prosody_profile.prosody_overlay`, #719), mapped to the timeline via `SessionTimeline`. `tracks[].prosody.status` is `fresh` (`segments[]` capped at 6 plus `truncated`), `missing` or `stale` (with a host-only `hint`), or `unavailable` (the cache file could not be read or parsed; `error` is the redacted exception, and guests get the generic `prosody unavailable`). The profile fingerprints the reconciled, precorrected word set, so run it standalone (`podcast pipeline run --only analyze_prosody`) only after reconcile/precorrect have run: `--only` does not run dependencies. Any later change to the word set (a ripple delete, a new suppression) makes the profile `stale` until the next run recomputes it. It depends on `precorrect_transcript` rather than the `require_transcript_refine` gate: in a full run the gate still stops the pipeline before this step, and unchecking the gate in the Pipeline tab leaves `analyze_prosody` enabled on purpose. Profiling a not-yet-refined transcript is harmless because the step never mutates the timeline and a later refine edit changes the words fingerprint so the profile reads stale until recomputed. Guests (`guest_audition_context`, share HTTP `…/daw/audition-context`) get the same `tracks[].prosody` and `prosody_notes` as an allowlisted copy (status, segments, truncated; known segment fields only), so the host-only `hint` and exception text never reach guests. `audition_eval` passes `include_prosody=False` because prosody feeds no hypothesis gate.

**Backend:** `praat-parselmouth` only (`engines/prosody.py`), behind the optional `prosody` extra (`pyproject.toml`) — no torch, no openSMILE (it would duplicate these features and ship a second native binary). Without the extra, the step is a no-op and reports `skipped (praat-parselmouth not installed; install the 'prosody' extra)`; `audition_context`'s `tracks[].prosody` then reports `status: "missing"` with a hint, same as before the step ever ran.

**Segmentation:** word gaps at or under `prosody.segment_gap_sec` (1.0s default) merge into one segment; a run longer than `prosody.max_segment_sec` (30s) is split. With no transcript yet, segments come from energy runs (`util.dsp.bool_runs` over a floor-dB mask) instead, so the step still produces a coarse profile.

**Bounded memory (#727):** the step streams each track once through `FFmpegEngine.stream_mono_f32` — 16 kHz mono float32, identical samples to `engines.audio_audit.load_mono_full` — instead of decoding the whole track into memory. It analyses each segment in its own Praat `Sound` built over that segment padded by 0.5s on each side, served by `util.pcm_stream.SequentialWindowReader`: resident audio is about one window plus one decode chunk, whatever the track length, instead of holding the whole float32 decode plus its float64 copy plus Praat's own copy for a multi-hour track. With no transcript, a first streamed pass finds segments from a frame-RMS energy envelope, so the file decodes twice. Segment ends past the media end are clamped once the reader reaches EOF; a segment that clamps to `end <= start` is dropped. Because Praat's pitch and harmonicity silence/voicing thresholds are relative to the peak of the *analysed* `Sound`, a quiet segment is now judged on its own peak rather than the loudest moment elsewhere in the track (gain-invariant F0/HNR) — a behaviour change from whole-file analysis, hence `ALGORITHM_VERSION` 4. `analyze_prosody` (the in-memory array entry point, used by tests and other in-process callers) keeps the same per-segment-window behaviour, backed by a single-chunk reader; `analyze_prosody_file` is the bounded-memory entry point the pipeline step calls.

**Per segment:**

- **F0** — mean/median Hz and sd/range in semitones (`Sound.to_pitch_ac`, `prosody.pitch_floor_hz`/`pitch_ceiling_hz`, defaults 75/500 Hz), plus voiced fraction.
- **Rate** — a De Jong & Wempe-style syllable-nucleus count: intensity peaks (`Sound.to_intensity`) at least 2 dB above the preceding trough, within 25 dB of the segment's own intensity ceiling, and coincident with a voiced pitch frame. `speech_rate` divides by segment duration; `articulation_rate` divides by duration minus interior pauses.
- **Pauses** — interior sub-floor intensity runs of at least `prosody.pause_min_sec` (0.25s); a run touching either edge of the segment is not a pause (a real segment boundary already covers it).
- **Energy** — mean/sd/slope (dB, linear regression over the segment), plus start/mid/end-third means, `drop_db` (start third − end third), and a `trend` (`falling` when `drop_db > 1.5`, `rising` when `< -1.5`, else `flat`).
- **Voice quality** — jitter/shimmer/HNR (`Sound.to_harmonicity_cc`, `To PointProcess (periodic, cc)`), flagged against Praat's standard voice-report thresholds (jitter local > 1.04%, shimmer local > 3.81%, HNR < 7 dB) as `jitter_high` / `shimmer_high` / `hnr_low`. An unmeasured value (Praat undefined/NaN) reports `0.0` with its flag `false`; a measured 0 dB HNR is `hnr_low`.
- **Prominent words** — up to `prosody.top_prominent_words` (5) per segment, ranked by a z-score fusion of F0 peak, energy peak, and duration-per-syllable (a crude vowel-group syllable count; no dependency).
- **Boundaries** — `strength = 0.5·pause + 0.3·lengthening + 0.2·pitch_reset` per word gap (each term clamped to `[0, 1]`); boundaries at or above `prosody.boundary_min_strength` (0.3) are kept (a weaker word gap is dropped even when it has a short pause), and the segment end is always included (`kind: "segment_end"`) as a natural chapter/cut-point signal.

No `NaN` is ever returned: every stat falls back to `0.0` (or an empty list) when a segment has no voiced frames, no words, or too few samples to measure.

**Cache:** `transcripts/prosody/{track_id}_{audio16}_{inputs16}.json`, mirroring the ASR transcript cache (`engines/transcribe.py`, `cache_id_part`) — `audio16` is the shared `edits.transcript_reuse.audio_identity` 16-hex prefix, `inputs16` hashes the algorithm version, `prosody.*` params, the installed parselmouth version, and a word-timing fingerprint (`edits/prosody_profile.py`). The reader (`load_track_profile`, used by every `audition_context` call) never hashes audio: it lists this track's cache files (normally one; the step prunes superseded profiles), picks the newest, and compares its stored `audio_size`/`audio_mtime_ns` against `stat()` plus the words fingerprint (`track_words_fingerprint`, #729, memoizes it in memory on the transcript's words revision, so it's recomputed (an O(words) sort + sha256, tens of ms at ~18k words) only after a words change in this process; the revision is process-wide, so an edit on any other track also forces one recompute; never persisted); it also reports `stale` when the stored `algorithm_version` differs from `ALGORITHM_VERSION` or (when parselmouth is installed) the stored engine `version` differs; and, only when this process has staged a pipeline working set by writing it (a Studio Pipeline-tab edit or run, `pipeline_set_config_tool`, Analyze `apply`, or `pipeline_run_tool` with the default `use_working_set=true`, which stages its `config_json`), when the stored `params` differ from the staged `prosody.*` params (resolved once per `audition_context` call); a mismatch reports `status: "stale"` with a hint to re-run the step. Only reading the config (`GET /api/pipeline/config`, `pipeline_get_config_tool`) stages nothing. With nothing staged (a CLI or stdio MCP process that never wrote the working set, a restarted Studio server, or `pipeline_run_tool(..., use_working_set=false)`), the reader trusts the stored params, because the working set is process-local. The writer (the pipeline step) is the only thing that hashes audio or reruns Praat, and it reuses a profile only when audio, words, params, algorithm version and parselmouth version all match, and refreshes those stat fields on a reuse (e.g. a touch with no content change). After each write the step deletes that track's superseded profiles, so one file per track remains. Files are matched by exact `{track_id}_{audio16}_{inputs16}.json` name, so `host` never reads or prunes `host_b`'s cache. Compute, write and prune run under a per-track `transcripts/prosody/{track_id}.lock` (filelock), so two concurrent runs never both run Praat for one track. A second run waits up to `PROSODY_LOCK_TIMEOUT_SEC` (600s) for that lock; at ~0.31s of compute per audio minute (see Measured performance below) it only times out behind a track tens of hours long, so revisit the timeout if per-segment cost or the timeout changes. A file with another `schema` is ignored. Cancellation is checked before each track, before each decode chunk of the no-transcript energy pass (`PCM_STREAM_CHUNK_FRAMES`, about 65s of 16 kHz audio), after that pass, and before each segment; one segment's Praat passes (at most `max_segment_sec` + 1s of audio) are not interruptible, and an ffmpeg read that stalls inside one window waits for the `PCM_STREAM_TIMEOUT_SEC` (600s) decode watchdog, as every `stream_pcm_f32` consumer does. If the media's size or mtime changes between the audio hash and the end of analysis (for example rewritten between the two no-transcript decodes), the step raises instead of caching a profile under the stale audio identity. See [persistence.md](persistence.md).

**Measured performance:** on a 6.4s real-speech fixture (`tests/fixtures/word_boundary/5338-24640-0003.wav`), `analyze_prosody_file` computes one track's profile in ~0.13s. On synthetic clips (the fixture tiled with 1s gaps, gold words shifted per copy), wall time and peak RSS (macOS `ru_maxrss`, bytes; KiB on Linux) for the streamed per-segment path (new, #727) versus the old whole-file-decode-then-whole-file-Praat-pass path:

| Clip     | New: wall | New: peak RSS | Old: wall | Old: peak RSS |
| -------- | --------- | -------------- | --------- | -------------- |
| 5 min    | ~1.6s     | ~162 MiB       | ~0.8s     | ~330 MiB        |
| 60 min   | ~18.4s    | ~169 MiB       | ~9.2s     | ~1878 MiB       |

These are one-off local measurements (macOS, September 2026, at commit db039dcd0), not asserted by CI. The bounded-memory claim itself is guarded by `tests/test_pcm_stream.py::test_resident_samples_stay_bounded` and `tests/test_prosody_engine.py::test_analyze_prosody_file_matches_array_path_with_bounded_windows`, which checks that each window and the reader's `buffered_samples` stay within one padded segment plus one decode chunk. Peak RSS for the new path stays flat as track length grows (dominated by the Python/numpy/parselmouth baseline, not the audio); the old path's peak RSS grows roughly linearly with track length (about 5.7x from 5 to 60 minutes, close to the 12x duration increase once the fixed decode/Sound-object overhead is accounted for). Wall time roughly doubles under the new path (~0.31s of compute per audio minute vs. ~0.15s for the old path at both sizes): cost is now per-segment contour extraction (`to_pitch_ac`/`to_intensity`/`to_harmonicity_cc`/`To PointProcess` on each segment's own padded `Sound`), which scales with speech duration plus 1s of padding per segment, rather than one whole-file contour pass computed once per track regardless of segment count.

**Praat reference spot check** (`tests/test_prosody_engine.py::test_prosody_matches_praat_reference_on_fixture`, parametrized over the array (`analyze_prosody`) and streamed-file (`analyze_prosody_file`) entry points, run when the `prosody` extra is installed): on the same fixture, the engine's segment F0 mean is within 5% of Praat's own `Get mean … Hertz`, the segment intensity mean is within 1.5 dB of Praat's `Get mean … dB`, and the computed speech rate falls in `[2, 8]` syllables/sec. `test_analyze_prosody_is_invariant_to_loudness_elsewhere` additionally checks that F0/HNR are gain-invariant across a loud/quiet two-copy track (see Bounded memory above).

Not implemented (see [ROADMAP.md](../ROADMAP.md)): the Wavelet Prosody Toolkit's continuous-wavelet-transform prominence/boundary version (git-only, needs PyQt, cannot be a PyPI dependency), AuToBI ToBI labels, an openSMILE/eGeMAPS cross-check, a desktop sidecar `prosody` extra, a stored F0 contour (the #719 overlay draws the energy thirds, boundaries and prominent words only), and `tighten`/`chapters` consuming boundaries directly.

## Conversation align (`align_tracks` + gate)

After ASR (while bleed phrases still exist in the transcript), **`align_tracks`**
places dialogue clips on one session clock:

0. **Locks first** - when every dialogue stem has the same duration (within ~50 ms; the Analyze `pre_aligned` case) each stem is held as method `hold` (a lone same-length clip in a mixed set only gets the soft `same_length_prior`); a manifest-pinned offset (the clip's own `track_id:clip_id` entry in `meta.ingest_alignment`, or the speaker-label entry when that label is unique among dialogue tracks, with `align_method: "manual"`) is kept as method `manual`, and the plan records the offset that placement represents against the reference clip it overlaps most. Locked clips keep their geometry exactly (splits, ripples, ingest placement); a `hold` clip that is not co-timed with the reference clip it overlaps most is rebased onto that clip's lead-in first. Only `align.realign: true` (GUI Pipeline pane, MCP `config_json='{"align": {"realign": true}}'`, or `podcast pipeline run --realign`) re-scores them.
1. **Bleed n-grams** - same phrase on two+ tracks gives a weighted-median Δt. Bleed counts only when at least `align.min_bleed_matches` (5) n-grams cluster **and** carry at least `align.bleed_min_share` (0.3) of the weighted matches; n-grams made only of filler/stopwords ("i don't know") count 0.2x, and repeated phrases are down-weighted by their multiplicity. Sub-second Δt (`align.bleed_identity_sec`) is confirmed with waveform xcorr before apply; identity only when acoustic lag is ~0. `align.bleed_identity_sec` is capped at `align.large_move_sec`.
2. Else **own-speech / VAD gaps** - occupancy excludes bleed copies and stretched ASR words; N-way union; hierarchical coarse-to-fine sweep over a bound from the longest dialogue file (`align.max_offset_sec: 0` = auto). Applied when confident about a multi-second move (not search-wall). Local **silence-midpoint** refine (±2s, capped to ~0.3s drift) polishes the peak.
3. Else **late-join occupancy** - after leading file silence, park the first real speech island in a host silence long enough to hold it (silence-mid minus utterance center, or silence start if mid would overhang). Apply only when turn-taking **clearly beats identity**. Method `gaps_late`; then the same local silence-mid refine. Sparse one-off bleed bigrams are for human/agent diagnosis, not the default clock.
4. **Weak hold** - when gaps and late-join are not confident, `weak_hold` at 0.

**Upgrading from earlier releases:** `align.min_bleed_matches` rose from 2 to 5, and bleed now also needs `align.bleed_min_share`. Re-running align on an existing project can fall through to gaps/late-join or a hold where it used to take a bleed clock. To restore the old bleed trust for a project, set `align.min_bleed_matches: 2` and `align.bleed_min_share: 0`.

**Large moves:** any candidate above `align.large_move_sec` (1.0 s) must be confirmed by waveform xcorr (at least 3 windows, peak at least `align.large_move_min_peak`, residual within `align.acoustic_agree_sec`). Unconfirmed candidates are held at 0 as `unconfirmed_hold`; the candidate stays in the artifact (`candidate_offset_sec`, `acoustic_confirmed`) and the step summary so a person can listen and nudge. The artifact records the `large_move_sec` the scorer ran with; `align status` / `align brief`, the unattended gate and export QC all use that value (falling back to config), so a per-run override is honoured everywhere.

A whole-file clip (the only clip on its lane reading that media, starting at the file head, or
at timeline 0 at the lead-in placement `meta.ingest_alignment` records) is re-placed from the
offset, same as before; a head trimmed and rippled to timeline 0 takes the slip path below. A
split, trimmed or rippled track instead keeps every clip's timeline window and slips its source
range by the delta between its current and target shift (the plan offset plus the shift of the
reference clip it overlaps most) — a head that would land before the file start trims the clip
(timeline start moves later, source start clamps to 0), and a tail past the file end
clamps too. When the delta would leave a piece with no audio, or applying it would newly
stack two same-source clips on the timeline (`same_source_timeline_overlaps`, #520), the
whole track is left unchanged: its plans get `skipped_reason` (naming each newly stacked clip
pair, up to six; surfaced in the step summary as `skipped <track> (...)` and in the artifact),
while `offset_sec` is kept so the
unattended gate still sees the move. `meta.ingest_alignment` is written from each placed
clip's source-to-timeline shift via `SpeakerIngestAlignment.from_source_to_timeline_shift`
(readers use its `source_to_timeline_shift_sec` property); (`session_start_in_file_sec = max(0, -shift)`,
`content_align_sec = max(0, shift)`), which reproduces the old whole-file values exactly.
Writes `meta.ingest_alignment`, clip geometry, and `artifacts/alignment/conversation_align.json`.
Never blades/splits one WAV into multiple clips. Several raw files per speaker stay
several whole clips (`source_id`).

**`require_align_accept`** blocks later steps until `podcast align done` / waive. Unattended /
`PODCAST_BATCH=1` with `align.accept.mode: waive_unattended` keeps the scorer result and
auto-waives (it does **not** skip the scorer). The waiver records the current alignment plan digest without granting a human drift exemption. It never auto-waives a move above `align.large_move_sec`, including an `unconfirmed_hold` candidate above it: the gate stops and names the tracks so a person listens first. It also stops when an unlocked clip's current placement sits more than that off the reference, which is the same check export QC runs, so an unattended run the gate waived passes the `alignment` QC unless the clips are edited later. If an accepted artifact is missing or unreadable, the gate and export QC fail until alignment is rerun and reviewed. Uncheck **Align tracks** in the Pipeline
pane when files are unrelated segments — the gate cascade-disables with it.
`merge_transcript` still depends only on `transcribe_tracks` so skipping align does not
disable ASR.

**v1 limits (documented, not solved here):** one offset per file (split pieces share it); no
clock-drift piecewise sync; mixdown/stereo “everyone on one track”; Whisper silence hallucinations
beyond VAD, safer decoding and the `suspect_hallucination` flag (#521), plus the opt-in forced
aligner's no-acoustic-evidence flag (`transcribe.forced_alignment.min_word_score`, #195).

`export_qc.json` includes an `alignment` block. Each dialogue clip's relative drift from the reference is measured on every stretch between reference edits (slivers under 1 s ignored), so ripple cuts cancel out. Drift above the threshold is an issue when no person accepted the alignment: missing, pending or waived by `unattended`. A person's `align done` / waive records each clip's relative drift (`accepted_drift` in the status file). Once later edits make that accept stale, only a clip that moved more than the threshold from its accepted drift is an issue, and the message says the accept is stale. A locked (`hold`/`manual`) clip is exempt only while it still sits where align locked it. The artifact records each clip's source range and relative drift (`rel_drift_sec`), so split pieces keep the exemption (matched by source overlap on the same track), and a clip pinned under a later reference clip is measured against that clip. An `unconfirmed_hold` candidate above the threshold that no person accepted, and an unreadable align artifact, are issues too. All of these are warnings when `align.accept.mode: off`.

`export_qc.json`'s `timebase` block also carries `stacked_clips`: any pair of clips on the same lane that read the same media file and overlap on the timeline (`same_source_timeline_overlaps`, #520) is a hard `timebase.issues` entry — the pair would play the same audio twice. `podcast doctor` reports the same stacks as warnings.

`timebase` counts words outside every clip's source range as `unmapped_words`, a hard issue. Whisper's zero-length words (`end <= start`, or inverted by at most one 20 ms ASR step) are padded to a 1 ms span (`word_source_span`, the same convention as the GUI word views). A zero-length word stamped exactly at a kept clip's source end (a cut that starts at the word) maps onto that clip's last 1 ms (`SessionTimeline.map_word_spans`), not unmapped. Those that land on the timeline are `zero_length_words` with a `timebase.warnings` entry (an ASR timing flag that does not flip `ok`, #621). Words that end more than 20 ms before they start are `inverted_words`, a hard issue (corrupt timing from a bad merge or manual edit). Plain `max_drift_sec` after ripple cuts is a warning. Misalignment between tracks is the `alignment` block's hard issue (#519), and same-source stacks are hard issues (#520).

CLI/MCP: `podcast align status|brief|done|waive` / `align_*_tool`. Skill: **podcast-align-audio**.

Each step returns a short human-readable **summary** (counts of tracks, cuts, suppressions, QC issues, etc.). The runner stores it on `PipelineStepLog.message` and surfaces it in CLI `--json-progress` (`Completed {step}: {summary}`) and the DAW Pipeline tab. `PipelineService.run()` returns a `PipelineRunResult` (`last_step`, `steps`, `export_qc`, `export_qc_path`, `ok`); CLI `pipeline run` prints one line per step plus, when this run exported, an `Export QC: ok|FAILED (…)` verdict line — see § CLI result and --strict below. MCP `pipeline_run` returns `Completed through {last_step}` followed by the same verdict lines (nothing extra when the run did not export), and a Studio pipeline job's terminal snapshot carries it as `result.export_qc` (`ok`, `issues`, `warnings`) plus `result.export_qc_path`. Intra-step phases use the shared progress framework ([progress.md](progress.md)) — engines called from steps pick up the bound reporter via `resolve_progress()`.

## Configurable run (GUI / MCP)

Sharecut Studio Pipeline pane and MCP tools share a **working set** of enabled steps + yaml-derived params:

- `GET`/`PUT` config and `POST` analyze — see [gui-integration.md](gui-integration.md) § Pipeline tab
- Config payload includes `whisper_models` with per-model `cached`; GUI `transcribe.model` is a catalog picker that confirms before downloading via bootstrap (whisper-only). Pipeline `components.whisper.ok` requires the selected weights on disk. Pipeline **Run** (GUI/MCP/CLI) fails fast if `transcribe_tracks` would run and weights are missing — it never Hugging Face–pulls; use bootstrap or the picker Dialog to download.
- MCP: `pipeline_get_config_tool`, `pipeline_set_config_tool`, `pipeline_analyze_tool`, then `pipeline_run` (skill **podcast-pipeline-tune**)
- CLI: `podcast pipeline run --unattended`, optional `--skip a,b,c`, `--realign` (re-score equal-length / manifest-pinned stems in `align_tracks`), `--force` (re-runs ASR over existing transcripts for that run only; `transcribe.overwrite` in the advanced group is the persisted equivalent; `force_transcribe` on `pipeline_run` / `POST /api/pipeline/run` is run-only and never saved to the working set), repeatable `--set path=value` (run-only override, never saved; unknown keys (dotted, or as leaf keys of a mapping value such as `focus={...}`) and unknown `effects.<preset>` names (dotted or as keys of `effects={...}`) are rejected; `effects={}` is accepted and is a no-op (it merges onto the `effects:` overlay and does not clear it) — same lifetime as `--realign`/`--force`; e.g. `--set focus.enabled=true` turns on focus without a custom `PODCAST_MCP_PIPELINE_DEFAULTS` file), and `--strict/--no-strict` (default strict: exit 1 when this run exported and QC is not ok; `--no-strict` reports the verdict and exits 0; see § CLI result and --strict). `podcast pipeline list [--json]` shows each step's enabled / no-op / disabled state under the effective config. `podcast pipeline config [--set path=value ...] [--json]` previews the effective config (defaults + `--set`), the `PARAM_FIELDS` values (marked `*` where overridden), and step states — nothing is persisted. `podcast pipeline analyze --project P [--set path=value ...] [--json]` runs Analyze against that config and prints each reason with its evidence, any `suggested_skip_steps`, the per-track `report_summary.tracks` numbers, and a ready-to-paste `podcast pipeline run ... --set ...` line built from the analyze `--set` overrides plus the patches (project path shell-quoted).
- Validation: only CLI `--set` rejects unknown dotted keys and unknown `effects` preset names; MCP `config_json` (`pipeline_set_config_tool`, `pipeline_run`) and GUI `PUT /api/pipeline/config` keep only the top-level key filter (`ALLOWED_CONFIG_TOP_KEYS`), since a working set's `effects:` overlay may define custom preset chains.
- Enabling a step expands `depends_on`; missing FFmpeg/whisper/rnnoise show as component badges (bootstrap CTAs)
- **Analyze** proposes static knobs from diagnostics (hum, noise floor, gate, bleed, clipping, pre-aligned equal-duration dialogue, digital-silence dialogue stems); any gate-overreach finding always proposes a milder `effects.gate` (-6 dB threshold, applied once per Analyze call regardless of how many tracks are flagged), seeded from the resolved `gate` preset when the working set has none (see [audio-engineering.md](audio-engineering.md#effect-presets-source-of-truth)); loudness measure→target still happens inside balance/master at run time. Every reason carries an `evidence` dict (the measured numbers plus the threshold compared against), and `report_summary.tracks` lists one row per dialogue track's health numbers even when no reason fires. A dialogue track that could not be measured for digital silence reports `digital_silence_fraction: null` with `digital_silence_skipped` (`missing_audio` or `decode_failed`) rather than looking clean. `pre_aligned` only *hints* — `suggested_skip_steps: ["align_tracks"]` — since `apply` patches config only, never `enabled_steps`; an agent or person applies the hint (`enabled_steps_json`, or CLI `--skip`). `apply` (GUI and MCP, via `services.pipeline_config.analyze_working_set`) deep-merges only `patches` onto the working set as staged when the scan finishes, so a config edit made during the scan is kept. CLI `pipeline analyze` and MCP `pipeline_analyze_tool` both report progress through `services.pipeline_config.suggest_pipeline_tuning`, which runs the `health` phase (a named `analyze_health` child wrapping `analyze_cleanup`, itself advancing once per dialogue track) then the `digital_silence` phase (a named `analyze_silence` child advancing once per dialogue track as it scans for digital silence); the GUI's `POST /api/pipeline/analyze` runs the same service as a cancellable `kind=analyze` pipeline-slot job, so Sharecut Studio shows those phases and per-track counts over SSE, and Cancel stops the scan between tracks without applying anything (a cancel that lands after `apply` merged the patches keeps `result`, `applied: true`, on the cancelled snapshot).

### Analyze checks

| code | measured | threshold | patch |
| --- | --- | --- | --- |
| `hum` | mains hum detector | fixed heuristic | seeds `effects.noise_reduction` |
| `noise_floor` | astats noise floor (dBFS) | `NOISE_FLOOR_WARN_DB` = -50 | none (advisory) |
| `gate_overreach` | gate risk/issues from cleanup | risk in `{high, medium}` or issues present | `effects.gate` threshold -6 dB (once per call) |
| `bleed` | bleed ratio | `AnalysisPolicy.bleed_ratio_warn_threshold` | none (advisory) |
| `clipping` | peak level / flat factor | `CLIPPING_PEAK_LEVEL_DB` = -0.3 | `compression.makeup_db = 0.0` |
| `pre_aligned` | equal-duration dialogue stems | `DURATION_EPS_SEC` | none; `suggested_skip_steps: ["align_tracks"]` |
| `digital_silence` | share of source-audio blocks below `transcribe.silence_filter.peak_dbfs` (`engines.asr_silence.peak_envelope`) | `DIGITAL_SILENCE_VAD_FRACTION` = 0.8 | `transcribe.vad.enabled = true` (only when VAD was off) |

## Resume from a step

```bash
podcast pipeline run --project episode.project.json --from precorrect_transcript
podcast pipeline run --project episode.project.json --unattended
podcast pipeline run --project episode.project.json --from tighten_from_transcript
podcast pipeline run --project episode.project.json --from assemble_timeline
podcast pipeline run --project episode.project.json --only master_loudness
```

`--from reconcile_transcript` resumes at pass 1. Pass 2 reconcile is included when resuming from `assemble_timeline`.

Defaults: `.agents/defaults/pipeline.yaml` (tighten, mix, export, and other step parameters; `effects:` is only a by-name overlay on the FX presets built into `effects/presets.py`, see [audio-engineering.md](audio-engineering.md#effect-presets-source-of-truth)). Cut boundaries: [inaudible-cuts.md](inaudible-cuts.md). **Tuning filler/pause cuts:** [filler-cut-quality.md](filler-cut-quality.md). **Audio diagnostics and mastering QC:** [audio-engineering.md](audio-engineering.md). `config.load_defaults()` reads that file (or the one `PODCAST_MCP_PIPELINE_DEFAULTS` names) on each call but re-parses the YAML only when its contents change; each caller gets its own copy.

### CLI result and --strict

`pipeline run` prints, to stdout (TTY or not), one line per step (`{status} {step}`, plus `: {message}` when the step returned a summary), then — only when this run completed `export_deliverables` with status `ok` — an `Export QC: ok|FAILED (N issue[s]), M warning[s] (<path>)` line with each issue listed below it. The last line stays `Pipeline complete. Last step: {last_step}`.

The default has been `--strict` since #628; it was opt-in before because of the false QC failures fixed in #621. It exits 1 when this run exported and the QC verdict is not ok; it prints `Export QC is not ok; exiting 1 (pass --no-strict to exit 0).` to stderr. `--no-strict` prints the same report and exits 0. A run that never reached `export_deliverables` always passes, so partial runs such as `--only ingest_tracks` in scripts need no flag. A QC file left over from an earlier run is never read.

## Edits during a run

Each step's save merges onto the saved project (`ProjectWorkspace.checkpoint()` / `save_merged()`), so a volume, mute, comment or cut saved while the run is going survives and later steps see it. A volume or mute saved during the stems step does not stop it. A merged save replaces whole project sections (tracks, pipeline runs, render state) in place, so steps and the runner re-fetch objects from the project after each save rather than keep earlier references; the runner re-resolves its run each step. If another request and the run changed the same value, that step fails with a "re-run it" message and saves nothing. If a step's save fails before the project file is replaced (any error, not only a conflict), the step is not marked done in memory either, so a later save cannot record it as completed. An undo or redo during a run, even before the first step, also stops it: the message says an undo or redo changed the project (conflict key `history.lineage`), nothing is saved, and the history index stays as the saved project has it. Writers in other processes commit under the same `project_commit_lock`, so this holds across processes too (#213).

Each step runs on a private copy of the project. Its changes become visible to concurrent playback and render snapshots in one `project_state_lock` swap after the step, merged with any in-memory edit made meanwhile (#357), so a snapshot sees the project from before the step or after it, never half. Guards inside a step still watch the live project: the stem render compares its snapshot against the project the copy was taken from (`util.project_state.live_project`), so an uncommitted in-memory edit during FFmpeg still fails the step with `project changed during stem rendering`. A value both the step and another edit changed fails the step with the same "re-run it" message and publishes nothing to the project; stems, premix or master the step already wrote stay on disk, and since each `.hash` names the snapshot it was built from, freshness checks judge them against the live project and the re-run reconciles them. A failed or cancelled step still publishes what it changed; if that conflicts with an edit made meanwhile, the partial changes are dropped with a warning, and the step reports its own error either way. A step must not hand its private copy to work that outlives it (background waveform builds capture paths, not the project).

## Tighten params

Pipeline auto-tighten stays **off** (`tighten.enabled: false`) until the golden-ear bar in [filler-cut-quality.md](filler-cut-quality.md). Manual `propose-edits` / `apply-edits` still read these keys. A config with no `tighten.enabled` key counts as `false` everywhere: the step bodies, the Pipeline checklist defaults and `pipeline list` all read the step's `StepMeta.noop_unless` gate (`pipeline.meta.step_noop_reason`).

| Key | Default | Role |
|-----|---------|------|
| `tighten.enabled` | `false` | Run `analyze_fillers_pauses` / `tighten_from_transcript` |
| `tighten.intensity` | `medium` | `light` / `medium` / `aggressive` preset overlay applied at propose time |
| `tighten.repetition_candidates` | `true` | Propose review-only `repetition:` / `restart:` hits (`light` turns this off) |
| `tighten.filler_words` | um, uh, erm, ah, like, you know, sort of, kind of | Lexicon (ASR-normalized) |
| `tighten.discourse_markers` | like, you know, sort of, kind of | Demoted tokens (adjacent-token phrase match): candidates only with an adjacent true disfluency/repeat, pause ≥ `discourse_pause_sec`, or ASR confidence &lt; `discourse_confidence_max`. Missing key = defaults; `[]` disables demotion. |
| `tighten.discourse_pause_sec` | `0.35` | Flanking pause that qualifies a discourse marker |
| `tighten.discourse_confidence_max` | `0.6` | ASR confidence below this qualifies a discourse marker |
| `tighten.min_filler_cluster` | `2` | Min lexicon hits in a gap cluster before cutting |
| `tighten.max_pause_sec` | `1.2` | Inter-word gap before pause trim |
| `tighten.acoustic_gap_filler.enabled` | `true` | Review-only `filler:acoustic` proposals for voiced audio inside ASR gaps (never auto-applied) |
| `tighten.acoustic_gap_filler.min_gap_sec` | `0.35` | Shortest gap scanned (floor `0.35`) |
| `tighten.acoustic_gap_filler.max_run_sec` | `1.5` | Longest voiced run proposed (ceiling `1.5`) |
| `tighten.acoustic_gap_filler.max_frames` | `600` | 10 ms frames per gap (ceiling `600`, ~6 s); longer gaps are skipped |
| `tighten.acoustic_gap_filler.vad_backend` | `heuristic` | Breath rejection for each candidate run; `silero` is opt-in and falls back to the heuristic when unavailable |

Propose summaries include `N discourse kept` (`discourse:{token}` skip counts) and, when relevant, `N acoustic (review)` / `N acoustic skipped` (`acoustic:*` skip counts). Full table and symptom → knob guide: [filler-cut-quality.md](filler-cut-quality.md).

## Export formats

Audio deliverables are configured under `export` in `pipeline.yaml`:

```yaml
export:
  wav: true
  formats:
    - ext: mp3
      codec: libmp3lame
      bitrate_kbps: 128
    - ext: flac
      codec: flac
```

Each `formats` entry is passed to FFmpeg (`-codec:a`, `-b:a`, optional `-f`, `sample_rate`, `channels`, `extra_args`). Omit the `formats` key to keep legacy behavior (single MP3 using `mp3_bitrate_kbps`).

One-off encode without re-running the full pipeline:

```bash
podcast pipeline export-audio --project episode.project.json
podcast pipeline export-audio --project episode.project.json \
  --formats '[{"ext":"opus","codec":"libopus","bitrate_kbps":96}]'
```

MCP: `export_audio_tool` with optional `formats_json` (same array shape).

## Performance

Each completed step still commits its canonical state and `last_completed_step`
synchronously for crash resume. Unchanged history-index and transcript-cache mirrors
skip duplicate writes; bulk word corrections rebuild the combined transcript once
per batch. History trims oldest undo entries toward a 400-snapshot limit while
preserving the redo tail.

Step **order** is always strictly sequential (each step's input is the previous
step's output) — but three steps parallelize the independent work they loop over
internally, via a shared thread-pool helper (`util/parallel.py`):

| Step | What runs concurrently |
|------|-------------------------|
| `analyze_fillers_pauses` | Candidate gathering runs one task per dialogue track (including the per-gap acoustic scan for `filler:acoustic`, vectorized NumPy over the shared audio cache). Every filler, pause, repetition, restart, or acoustic candidate across **all** tracks is then analyzed (waveform boundary snap, risk assessment, fade sizing) in one shared pool; overlaps are resolved and decisions applied serially in the original order |
| `assemble_timeline` / `render_dialogue_stems` | Each track's stem is rendered concurrently (`_render_track_stems`) |
| `export_deliverables` | Each configured output format is encoded concurrently |

Analyze's digital-silence fraction (`engines/asr_silence.digital_silence_fraction`) is
cached in-process per (resolved path, `file_revision` — device, inode, size, mtime — a
SHA-256 of the file's first and last 64 KiB, and `peak_dbfs`), so re-running Analyze
from the GUI or MCP server does not re-decode unchanged dialogue stems; each CLI
`podcast pipeline analyze` is a fresh process and decodes once. An atomic replace or an
in-place rewrite re-measures when it changes the inode, size, mtime or either 64 KiB end
(so unstable or reused `st_ino` values no longer hide a replacement with new audio at
either end); only a same-size edit confined to the middle of the file that also keeps
inode and mtime keeps the cached value until the GUI/MCP process restarts.

The stem duration check (`probe_wav_duration_sec`, used by `stem_is_fresh`,
`render_status_report` and the bleed-mute rewrite) is cached in-process per resolved
path and `file_revision` the same way (up to 1024 file revisions per process, shared by
every open project). Every document snapshot that carries
`render_status` (MIX, CLIPS, FX, ENVELOPES, TRANSCRIPT_AUDIO, SHELL) re-reads hashes
and stats but spawns no ffprobe for an unchanged stem. A publish swaps the file
(`render_atomic`), so it always re-probes. Failures are not cached. Writers must replace
a probed file or change its size or mtime; an in-place rewrite that keeps both is
unsupported and keeps the old duration until the process restarts.

The stem step first reads each renderable track's fingerprint (`stem_fingerprint`:
`track_render_hash` plus the expected stem length) under `project_state_lock`, with no
project copy, and keeps every stem that matches it (`stem_matches`). Only when a stem is
stale does it take one deep snapshot; workers render that snapshot and write each hash
from it. After the render, the live project and (if the project file moved) the saved one
are compared against the hash each stem was rendered or found fresh at — a changed hash,
or a changed renderable track set, keeps the new invalidations and fails before
publishing `track_outputs.json`; retry the render for the new state. On-demand processed
playback (`play processed:<id>`, `/api/audio`) decides the stem and segment-cache tiers
from the same fingerprint; it deep-copies only for a segment render, and keys that cache
by the snapshot's own hash (#358). A warm decision hashes only that track's own inputs and
stats its files; it makes no deep copy of every track's transcript and the history, so its
cost no longer grows with the project's history.

Tighten proposal snapshots speaker profiles and speaker-ID settings once before
parallel candidate analysis. The read-only snapshot gives every candidate the
same bleed decision inputs and avoids repeated profile file reads.

Writers of stems, premix and master (stem render, mix, master, export, Refresh, bleed-mute apply, on-demand `ensure_stem`) hold the per-workspace render lock `artifacts/render.lock` (cross-process, re-entrant; #482). A second export or Refresh waits instead of mixing over the same premix. An export and `render_final` take the render lock first and only then checkpoint the saved project, so they render it as saved when the wait ends. A waiter polls in 0.5 s slices: a cancelled pipeline run, export or Refresh (the GUI render-preview job) stops waiting (`CancelledProgress`), and after 60 min it raises `RenderBusyError` (a `filelock.Timeout` with a fixed message; the GUI routes that map the project-lock timeout to HTTP 503 `project_busy` map it too; CLI commands and MCP tools do not map either yet, #488). MCP `apply_transcript_gate_tool` waits at most 30 s (`REQUEST_RENDER_LOCK_TIMEOUT_SEC`), because an MCP call cannot be cancelled. Playback never queues behind a render: processed playback with `rerender` waits at most 2 s, then plays a segment render of the current edits instead of rebuilding the stem (also when the project lock is busy; this does not set `render_busy`); a premix rerender (`play --source premix --rerender`, GUI `/api/audio?rerender=1`) and a transport stem build wait at most 2 s, then serve the premix or stem already on disk, which may be stale, and report `render_busy` (`TransportPath.render_busy`, `PlayResult.render_busy`, `render_busy` in `podcast play` / MCP play JSON, and the `X-Sharecut-Render-Busy: 1` header on `/api/audio`); a stem fallback also reports `stem_is_fresh`. A busy project lock (`filelock.Timeout` after 30 s, from `ensure_stem`'s invalidation clear or the premix save) takes the same fallback without `render_busy`, because it comes after the render: the file on disk is the fresh one. With nothing on disk they re-raise the timeout, which `/api/audio` maps to HTTP 503 `project_busy`. Lock order: render lock, then the project locks (`project_state_lock`, `project_commit_lock`); never take the render lock while holding those (a first acquire under the commit lock raises `RuntimeError`). Pipeline steps and `rerender_preview`, whose first argument is the project, use the `@with_render_lock` decorator; services, which hold `self.ws.project`, use `with render_lock(project):`. `apply_transcript_bleed_mute(dry_run=False)` requires its caller to hold the lock. Stem worker threads never take it (the file lock is thread-local). Readers never take it.

Stems, premix and master are published through `util.atomic_render.render_atomic`: render to a sibling temp, drop the `.hash`, `os.replace` the WAV, then write the new hash from the same project snapshot (#356), so a `.hash` only ever names the bytes beside it (a stem through `engines.play_audit.publish_stem`; the master's hash is already dropped when mastering starts). A writer holding the render lock first deletes temps (`<name>.<pid>.<hex>.partial.wav`) a crashed writer left beside its target. Bleed-mute apply publishes its gated stem through `publish_stem` too; a gated render longer than the timeline is rejected before the swap, so the old stem and its hash stay (`duration_mismatch_after_gate`). `mix_with_music` re-renders music, intro and outro stems with their fade envelope through `publish_stem`, so their `.hash` names the faded render and a later envelope edit stales them. Processed playback reads the stem's file identity before the freshness check and again after its extract; if a publish swapped the stem in between, it discards the extract and falls back to segment render.

Configure via `performance.max_workers` in `pipeline.yaml`:

```yaml
performance:
  max_workers: 0   # 0 = auto (cpu_count-based, capped at 8); 1 = serial; N = explicit cap
```

Set `max_workers: 1` to force fully serial, single-threaded execution — useful when
debugging a specific cut/render issue and you want deterministic, reproducible
single-threaded behavior. `master_loudness`'s two-pass loudnorm is not parallelized
(pass 2 depends on the ebur128 pass-1 measurement of the same file).

### Single-pass timeline render

Each track stem is assembled in **one** `ffmpeg` invocation
(`engines/ffmpeg.py::render_timeline`, driven by `render_track_from_timeline`)
rather than rendering one part file per clip and concatenating. A single
`-filter_complex` graph trims every source range, applies per-clip fades, and
joins them, handling every inter-segment relationship in the same graph:

| Relationship | Filter used |
|--------------|-------------|
| Abutting (gapless) clips | `concat` |
| Timeline gap between clips | `apad` (silence) + `concat` |
| Soft clip join (both sides faded) | `acrossfade` (curve from `render.crossfade_curve`) |
| Genuine timeline overlap | `adelay` + `amix` (summed over the overlap) |
| First clip starting after t=0 | leading `adelay` |

It then runs the track FX chain **once** over the fully assembled audio. Besides
collapsing N+1 subprocess spawns into one, this keeps stateful filters
(`acompressor`, `agate`, `deesser`, `afftdn`, `loudnorm`) continuous across clip
joins instead of resetting their state at every boundary, which removes the
pumping/discontinuity artifacts that per-clip rendering could introduce at cut
points.

### Per-track audio cache (the bigger win)

Independent of thread-pool parallelism, `analyze_fillers_pauses` decodes each
track's raw source audio once for each required sample rate up front
(`edits/audio_cache.py::TrackAudioCache`, built in `propose_tighten_edits`):
8 kHz for join/RMS measurement and 16 kHz for waveform-boundary and breath
analysis. Each later cached window read is an in-memory NumPy slice. The
`engines/audio_audit.py::TrackRmsCache` applies the same pattern to processed
stems; `analyze_gate_overreach` also caches raw-audio reads.
The full cleanup report passes one processed-stem cache set through its
subanalyses, and the project join sweep shares source decode and calibration
per track while checking each join with a bounded high-rate window.

Measured on a real 65-minute, 2-track episode (`analyze_fillers_pauses`, 181 final
decisions, byte-identical output across all variants):

| Variant | Time | vs. original |
|---------|------|---------------|
| Original (serial, no cache) | 110.4s | 1x |
| + thread-pool parallelism only | 18.0s | 6.1x |
| + per-track audio cache (serial) | 11.2s | 9.9x |
| + audio cache + parallelism | 10.9s | **10.1x** |

Both optimizations are complementary and safe to run together. The historical
benchmark's uncached path spent most of its time spawning `ffmpeg` for each
candidate window. Current PCM WAV window reads use the in-process decoder;
other containers retain the `ffmpeg` fallback. The cache still eliminates
repeated decoding and leaves the remaining per-candidate work small enough that
thread-pool overhead and the cache's one-time decode cost roughly cancel out
further concurrency gains for this step. Parallelism still matters more for
`assemble_timeline` (real per-track rendering work, not just tiny reads) and for
episodes with more dialogue tracks.
