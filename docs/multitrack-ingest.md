# Multitrack ingest and alignment

Raw recordings often arrive as **several files** in one folder. The episode workspace should end up with **one dialogue track per speaker** (typically two tracks total).

CLI and MCP ingest commands call `IngestService` through the public
`podcast_mcp.services.media` facade. The implementation lives in
`services/media/ingest.py`; recorder-folder scanning remains in `ingest/`.

**Remote recordings:** each file has its own **start/stop** and **duration**. Ingest maps them to one **session timeline** — not the same file timestamp on every recorder.

**Two clocks:** transcript word times stay in each track's **source-media seconds**; the edited/deliverable audio runs on **timeline seconds**. `timeline.clips` bridge the two and `engines/session_timeline.py` (`SessionTimeline`) is the only place that maps between them. See [episode-format-v2.md § Timebase invariant](episode-format-v2.md#timebase-invariant).

**Agent workflow:** `.agents/skills/podcast-align-audio/SKILL.md` (pipeline `align_tracks` + gate, or pre-pipeline suggest → verify → listen). Session-clock background: `.agents/skills/podcast-ingest-align/SKILL.md`.

`ingest consolidate` extracts **one WAV per listed source file** under each speaker (extras are kept as whole-file clips with `source_id`, not ignored). It does not mix multiple mics into one stem.

## Pipeline conversation align

Local retained-bleed alignment addresses a different problem from conversation
placement: a remote speaker can be present on another mic with a network delay
even after the recorders share a conversation clock. The transcript gate mutes or turns down such
a copy wherever the remote speaker's own track is talking (#945).
Where the gate must retain mixed audio, the planner may isolate and move one complete
direct-source phrase inside the requested region. It preserves the mixed lane,
requires quiet source slack on both ends, and rejects drift, conflicting peer
delays, or weak evidence. Mix-muted direct or retained lanes are skipped. Quiet destination overlap is
trimmed inside the affected region, without removing retained-word coverage.
Existing manual recorder placement and saved local
manual/declined decisions are honored. Bypassing a recorder lock requires an
explicit scoped request and records override provenance; saved local choices
still take precedence. This does not move the whole lane or stretch voiced audio. Declared crossfade joins abstain with `unsupported_crossfade_evidence_clock`, because their rendered clock can differ from raw clip placement.
Per-clip recorder locks remain attached to surviving same-source material after
ordinary splits, quiet trimming, and scoped corrections. Phrase selection and
retained-word checks use the selected recording's transcript. Conflicting batch
footprints abstain; missing or unmatched direct phrases remain explicitly unresolved.
Local evidence decodes only its lag and shifted-null context. Projects using the
renderer's implicit full-media fallback can still apply bleed mute; local retiming
reports `unsupported_implicit_timeline_alignment` until explicit clips exist.
Reciprocal corrections and corrections that move any stationary retained-copy
reference in the same region abstain together. Unsupported measured interior
probes also abstain; three agreeing survivors cannot authorize unresolved portions
of a whole phrase. Equivalent primary/explicit references to the same recording
retain saved local choices through source pinning and reopening.

After `transcribe_tracks`, the default-on **`align_tracks`** step places dialogue clips on one session clock (bleed phrase Δt, else own-speech/VAD gaps; N speakers). **`require_align_accept`** gates later steps until listen/`podcast align done` (or unattended waive; never for moves above `align.large_move_sec`). Equal-length and manifest-pinned stems are locked (`hold`/`manual`) unless `align.realign`. Uncheck Align in the Pipeline pane when files are not one conversation. See [pipeline.md](pipeline.md) and skill **podcast-align-audio**.

### Recorder latency from bleed

#### Decision: Shift a lane only when its direct track trails its own bleed

<!-- decision
id: D-align-from-bleed-lag
status: accepted
date: 2026-10-06
decided-by: calebn
evidence:
- #1037 owner: "Align tracks whose measured lag against their own bleed is consistent; it should remove the echo at its source."
- #1037 owner: "Solve for one offset per track ... flag a track whose pairs conflict instead of guessing."
- #1060 review: a loudspeaker loop shifted an on-time track in 40 of 40 trials, which gave the direction rule
- #1060 lab: Audra to Caleb +142.5 ms, MAD 7.5 ms; zero-lag correlation 0.387 to 0.586
- #1060 owner listening: "sounds much better for all clips"
enforced-by:
- tests/test_bleed_latency.py::test_loudspeaker_loop_on_one_pair_is_proposed_never_applied
- tests/test_bleed_latency.py::test_conflicting_pairs_flag_the_track_instead_of_shifting_it
- tests/test_bleed_latency.py::test_align_tracks_shifts_a_held_late_track_and_undo_restores
- tests/test_bleed_lag_segments.py::test_a_long_step_is_split_not_read_as_drift_or_scatter
- docs-sync: decision-alignment
-->

Equal-length files share one container clock, not one latency. Each recorder track reaches that clock after its own capture and network delay. On the lab Zoom tape, Audra's track trails her bleed on Caleb's mic by 143 ms, so the mix carried an early copy of her voice under the direct one. The last `align_tracks` stage measures each lane's lag behind its own bleed on the other mics, for every ordered pair, from level envelopes in 30 s windows. It then solves one latency per lane across all pairs (weighted least squares, reference at 0). A `hold` or scored lane moves by its latency (method `bleed_lag`) only when its direct track trails its own copy, which only latency explains, and its pairs agree within `align.bleed_lag_tolerance_sec` (40 ms). A copy that arrives after the direct sound can be a loudspeaker loop or monitoring, so the bleed never moves a lane solved only from later copies, on one pair or several, even with `--realign`; it gets the shift as a proposal. Direction is judged where the lane sits before the run, not at a scorer's planned move. A lane whose pairs conflict, or whose lag drifts across the episode, is flagged in the step summary and left in place. Drift is a trend inside the stretches between steps; a lag that steps and holds for a long stretch is split into pieces instead (#1090). A manifest-pinned lane keeps its placement and gets the shift as a proposed `candidate_offset_sec`. A lane already within `align.bleed_lag_deadband_sec` (20 ms) of its corrected placement does not move, so re-runs are no-ops.

#### Decision: Split a lane at its silences now; a timing map later

<!-- decision
id: D-align-piecewise-at-silences
status: accepted
date: 2026-10-06
decided-by: calebn
evidence:
- #1060 owner listening: clip 7 "doesn't sound perfectly aligned"
- #1071 lab: at 646 to 658 s the lag is about 285 ms (r=0.986) against 0.59 at the constant 142.5 ms
- #1088 owner: "ship the 37 silence-bounded pieces now. The timing map comes later (#1089)."
- #1088 owner listening: the pieces "all sound pretty good… much better" than the constant shift
- #1090 owner: "Pick the threshold by cross-validation per recording, not as a constant."
- #1090 owner: "A rerun with no change should write no history entry." and "Add an explicit peak bound."
- #1090 owner: steps use only the reference mic; "use every pair when available"
- #1090 lab: 31 steps (36 before), 15 s windows over the deadband 3 of 82 (7), none more than 10 ms worse, loudest skipped or repeated sample -58.4 dBFS (-50.3)
enforced-by:
- tests/test_bleed_lag_segments.py::test_align_tracks_splits_the_lane_in_the_silence_and_undo_restores
- tests/test_bleed_lag_segments.py::test_drifting_lane_is_flagged_and_not_split
- tests/test_bleed_lag_segments.py::test_manifest_pin_proposes_one_shift_and_keeps_the_clip_whole
- tests/test_bleed_lag_segments.py::test_a_step_is_judged_against_its_merged_neighbours
- tests/test_bleed_lag_segments.py::test_a_short_clear_stretch_keeps_its_own_lag
- tests/test_bleed_lag_segments.py::test_a_lone_phrase_after_a_pause_keeps_the_lag_its_own_speech_shows
- tests/test_bleed_lag_segments.py::test_a_noisy_lone_phrase_between_long_pauses_keeps_its_own_lag
- tests/test_bleed_lag_segments.py::test_a_blip_is_noise_and_an_easing_is_a_step
- tests/test_bleed_lag_segments.py::test_steps_use_a_mic_other_than_the_reference
- tests/test_bleed_lag_segments.py::test_steps_show_through_the_other_voice_on_the_lane_mic
- tests/test_bleed_lag_segments.py::test_rerun_keeps_the_pieces_where_they_are
- tests/test_bleed_lag_segments.py::test_rerun_finds_the_same_pieces_wherever_the_first_piece_sits
- tests/test_bleed_lag_segments.py::test_a_step_never_skips_a_peak_the_rms_gate_misses
- tests/test_bleed_lag_segments.py::test_the_step_cost_is_chosen_per_recording
- docs-sync: decision-alignment
-->

One latency is not always enough. Zoom's jitter buffer can re-time a track when its talker resumes after a pause, then ease it back. On the lab tape Audra trails her bleed by 130-150 ms most of the time and by 185-225 ms in the first stretch after several pauses (about 270 ms at the start of 646-660 s). So for a lane the bleed moves or keeps on latency grounds, `align_tracks` also finds where its latency steps, with each step inside one of the lane's own silences. It splits the lane's clip in those silences and slips each piece to its own latency, in the same undoable history entry. A step skips or repeats only silence, never a word: the full-band audio there has 30 ms RMS under -60 dB and every sample under -50 dBFS. Silence is judged on the full-band audio, because the 8 kHz lag decode hides sibilants. A manifest-pinned, `copy_later`, conflicting or drifting lane gets no steps. Bleed is evidence of timing only; it is never used as audio for another speaker.

The rules are relative to each recording (#1090). Steps come from every pair the lane shares with a track on the reference clock, in either direction, not only from the reference mic. Each talk spurt is scored on its own correlation, so a phrase's level relation to its copy, which follows loudness and the room, cannot pull it into a neighbouring piece. A piece needs its lag pinned by its own evidence (its likelihood-ratio interval inside the deadband, counted in the talker's voiced frames), not a fixed frame count, so a short clear phrase is a piece and a lone click is not. A step is judged against the merged pieces either side of it, so two neighbours inside the deadband become one piece instead of forcing the step into the wrong silence, and where the evidence cannot place a step it goes in the widest silence. The step cost is chosen per lane by cross-validation on held-out frames of every spurt, the smallest cost whose held-out fit is not measurably worse than the best. Each pair's steady lag is measured on the lane's media, so a re-run finds the same steps, keeps the pieces and their `meta.ingest_alignment` records, and writes no history entry. Thresholds, the artifact fields and the lab numbers are in [pipeline.md § Conversation align](pipeline.md#conversation-align-align_tracks--gate).

A per-track timing map that keeps the lane as one clip and follows lag changes
inside continuous speech is planned in #1089. On the lab tape a lag change inside
one talk spurt (1663.8-1671.1 s) and a lag outside the 100 ms search (646-660 s, and
about 20 ms at 740.4 s) need that timing map.

#### Word starts missing from their own track

After placing the clips, `align_tracks` checks every opening of a speaker's own track whose sound reached another mic first (#1059). Two different things look alike there:

- **A clipped start.** A call app's gate opened partway into the word. The track jumps from the gate straight to the word's level, and the sound just after the opening lines up with the copy on the other mic. Bleed is never used as audio for another speaker, so that start is missing from the mix.
- **A late track.** The word is whole on its own track, with its own attack, but plays late: the sound after the opening lines up with the copy shifted back by about the lead. Alignment left that behind (a lane offset align could not solve or did not apply, or a local lag its pieces do not follow). It is not a clipped start.

#### Decision: Flag a missing start only where the track opens mid-word

<!-- decision
id: D-missing-start-mid-word
status: accepted
date: 2026-10-07
decided-by: calebn
evidence:
- #1059 owner: "Snap the word's start to where the speaker's own track actually opens, consistent with #979."
- PR #1170 owner listening: all 7 lab flags were false positives; "the flagged word is clearly present on the speaker's own track"
- PR #1170 lab: at every flagged opening the own track rose from its noise floor in a normal attack (about -93, -49, -24 dBFS over 30 ms)
- PR #1170 lab: 4 of 8 openings matched the other mic shifted back by about the lead (r 0.79 to 0.90, about -0.1 at zero shift)
- PR #1170 owner: "Flag only when the own track opens mid-word" and "Route late-track cases to alignment instead."
- Revised: round 3 flagged every copy lead past the tolerance and moved each word onto its opening
enforced-by:
- tests/test_clipped_onsets.py::test_a_gate_that_cuts_off_a_word_s_start_flags_it_and_snaps_its_start
- tests/test_clipped_onsets.py::test_a_word_whole_but_late_on_its_own_track_is_an_alignment_residual
- tests/test_clipped_onsets.py::test_word_whose_track_opens_with_its_voice_is_not_flagged
- tests/test_clipped_onsets.py::test_a_lane_left_late_gets_one_alignment_comment_and_no_word_moves
- docs-sync: decision-alignment
-->

Only a clipped start is flagged and moved. A late track is reported, never moved: its words are whole, so moving their starts would only hide an alignment error. `edits/clipped_onsets.py` handles each:

- **Clipped start.** It moves the word's start to where the speaker's own track opens and keeps the start it had in `snapped_from`. A start already at or after the opening is left alone. So is a word a person re-timed (`timing_edited`): the person's start wins, `snapped_from` is cleared by the edit, and the word's open comment is withdrawn on the next run. The word gets its own timeline comment, written by `Align tracks`, from where the missing part reached the other mic to the opening, naming the word, how much is missing and which mic has it.
- **Late track.** No word moves. The lane gets one comment that lists each late word start with its time and how late it plays, and says aligning the track there fixes them. The step summary reports them per lane as an alignment residual. Align fixes these, not this pass: `--realign` or applying a proposed shift for a lane offset, the silence-bounded pieces above (#1090) for a lag that steps, and the planned timing map (#1089) for a lag that changes inside speech.

See [timeline-comments.md § Comments from Align tracks](timeline-comments.md#comments-from-align-tracks). The step summary adds `N word starts missing from their own track (see comments)` for clipped starts and `<lane>: N word starts late on its own track (<ms>; alignment residual, see comments)` for late ones. The pass also runs when align skips, so a project with fewer than two dialogue lanes has its open comments withdrawn and its moved starts put back.

**Idempotent.** Each run first puts every moved start back on `snapped_from`, judges every word at its original time, and moves only the words it flags again. So the transcript depends only on where the lanes sit now: a default run followed by `--realign` leaves the same words and comments as a fresh `--realign`. Everything is judged before anything changes, so a failure leaves words, comments and clips as they were.

The rule reads the timeline after alignment, from 8 kHz level envelopes: a 30 ms frame every 5 ms, and a 5 ms frame every 1 ms for attacks. Every level threshold is relative to the episode's own measurements, and each fixed number has its reason in `edits/clipped_onsets.py`:

- **Copy path.** An ordered pair whose direct track follows its copy at one lag (consistent or drifting in `bleed_latency.measure_pair`), measured again where the lanes now sit. A scattered pair, or one with no bleed, reports nothing, because without a lag the mic's own speaker cannot be told from the copy. The coupling is the median of mic level less direct level over the frames that measurement counts.
- **Opening.** The speaker's track rises 12 dB (twice the 6 dB margin `measure_pair` needs to call one level over another) over its floor, its 5th-percentile level, after at least 100 ms below it (longer than the gaps between syllables), and stays up for two level frames. Over its first 200 ms (one syllable) it out-levels the mic by 6 dB, the margin `measure_pair` needs to count a frame as copy.
- **Copy onset and lead.** Walking back from the copy of the speaker's speech onset, the mic's run stays within 20 dB of the copy's level, the range a word's soft sounds span under its loudest vowel. Both onsets are read 20 dB under their own level, so a copy that only follows the direct sound never leads it. The walk stops at the speaker's previous sound and at 0.5 s. A copy onset more than `align.bleed_lag_tolerance_sec` (40 ms) before the opening is a lead: a shorter one is the timing error align itself calls aligned, and 40 ms is more than one 30 ms level frame.
- **Content shift.** The speaker's first 400 ms after the opening (two syllables, so one shift wins) is correlated with the mic at every shift from 0 to the lead. The best shift is how late the track plays that sound. It counts only at a correlation of 0.4, the match `envelope_lag` needs to call a lag supported.
- **Attack.** The entry is the track's level over its first 10 ms after it opens, less the word's peak. A voice's own attack takes tens of milliseconds to reach the word's level; a gate opening into a word gets there within one 5 ms frame. The lane's attack profile is the entry at every opening whose copy shows it whole (the copy onset, at the path's lag, does not lead). An opening is abrupt when its entry is over the profile's 95th percentile, so even the hardest natural consonant starts on that lane set the bar. A lane with fewer than 20 whole starts has no profile, so nothing on it is abrupt.
- **Classify.** Clipped: the content matches, the opening is abrupt, and the lead less the late shift is still over the tolerance. Late: the content matches with a shift over the tolerance. A lead can be both (a gate cut on a late lane). Neither: the mic's earlier sound is not this word's start, for example the mic's own speaker.
- **Word.** The first transcript word whose original start is in the speaker's silence before the opening and that runs past it. Word starts are read 250 ms either side, because ASR misplaces them that far on gated tracks. An opening without such a word, such as a laugh, is not reported.

**Known limit.** A track late by more than its word's first syllable and the gap after it shows no lead: the walk back on the mic stops in that gap, so the copy onset it finds is the next syllable's. Such a word is neither flagged nor reported here. In a synthetic sweep over 18 turns from 6 recordings, every turn 100 or 150 ms late was reported (late shift within 20 ms) and no turn 300 ms late was; every gate that cut 100 or 150 ms off a turn was flagged, and the untouched recordings reported nothing. A late lane's offset as a whole is still measured by align itself.

**Comments on re-runs.** A word's comment id comes from the word (its lane, recording and original start), and a lane's from the lane, so a re-run that finds an opening a few ms away keeps the same comment. A re-run updates or withdraws its own open comments that no longer apply, for example after `--realign` shifts the lane. A comment someone resolved, answered or ticked stays as it is, and a run never adds a second comment over a word whose comment was answered. Undecodable audio reports nothing and leaves existing comments and moved starts alone.

Lab evidence (Whisper word times; the guest lane is a gated call track, the host mic carries its copy):

- **Lane shifted** (`--realign`, with the pieces above). Nothing is flagged and no word moves. One lane comment lists 6 late starts: 106.5 "Are" (80 ms), 149.8 "Yeah" (280 ms), 428.2 "Okay" (420 ms), 483.8 "Yeah" (170 ms), 983.4 "really" (140 ms) and 1072.5 "I" (280 ms). Each matches the host mic shifted back by about its lead (r 0.60-0.95) and opens with a normal attack: its entry is 22-42 dB under the word's peak, against the lane's whole-start bar of 15.9 dB under. The other copy leads, at 578.6, 909.2, 1137.4 and 1611.0, match at 0-30 ms with normal attacks, so the host mic's earlier sound is not their start. The previous rule flagged 7 openings here, and the owner heard every one of those words whole.
- **Default run.** The manifest pin keeps the guest lane about 140 ms late (the shift is only proposed), so one lane comment lists 39 late starts (50-430 ms). No word moves.
- **Re-runs.** A default run followed by `--realign` leaves exactly the words and comments of a fresh `--realign`.
- **Mix.** With every tighten candidate applied (aggressive, review ones included) and the preview rendered, the whole premix is bit-identical to `origin/main`'s.
- The remote speaker reports nothing: their pair with the host mic is scattered.

#### Human acceptance

Human acceptance covers the current alignment plan as well as clip placement. A new plan, including a held acoustic candidate, needs a fresh review even when clip geometry is unchanged. If every acoustic confirmation window fails to decode, the large move remains an unconfirmed candidate held at identity for review.

## Record-session landing drift

After a live record session, `RecordLandingService` compares each recorded
keeper's sample count to that segment's recording-clock span (join to the
next overlapping file-acked segment or take end). `drift_ms` is that duration
error (`null` when unverified). `|drift_ms| > 50 ms` or a missing
`session_start` sets land JSON `align_fallback` as a **hint** to run pipeline
`align_tracks` after transcribe — land does not invoke it (no transcripts).
`engines.align.gcc_phat_result` remains the shared-source TDOA helper (tests
and later bleed confirm); `gcc_phat_offset` is the "0 on indistinct" wrapper
for those tests only. Independent dry keepers are not two sensors of one
source. Single-participant takes skip the check.
See [recording-session.md § Clock and landing](recording-session.md#clock-and-landing-on-the-timeline).

## Import a recorder export folder

Generic **audio-only** importer for a folder of per-speaker files (Zoom / Riverside / Zencastr / SquadCast *exports you already have locally*). It writes `ingest.yaml` and does **not** copy audio, create tracks, or mint `record` URLs. Vendor-specific folder layouts and video stay v1.

```bash
podcast ingest import "/path/to/export" --out ingest.yaml
# optional: --speaker audioJohnSmith….m4a="John Smith" --dry-run --json
```

MCP: `ingest_import_folder_tool`. Then continue with suggest → consolidate → verify (or pipeline `align_tracks`) as below.

**Label rules** (filename only; conservative): strip extension, vendor/noise tokens (`audio`, `track`, `recording`, `raw`, `wav`, dates `YYYY-MM-DD`, long digit runs, GUID-like ids, `zoom` / `riverside` / `zencastr` / `squadcast`), split on `_` `-` `.` and camelCase, title-case the remainder. Role words such as `host` / `guest` are **kept** (`host-caleb.wav` → `Host Caleb`). Empty remainder → `speaker_{n}`.

Examples: `audioJohnSmith11234567890.m4a` → `John Smith`; `Jane_Doe-track-2026-01-02.wav` → `Jane Doe`.

**Vendor hint** (`zoom` | `riverside` | `zencastr` | `squadcast` | `unknown`) is informational from filename/folder tokens only — no layout assumptions. Only **top-level** files in the folder are scanned (no subfolders). Mix-named files (`mix`, `combined` as filename tokens; e.g. `session_mix.wav`, not substring `remix`) are skipped unless they are the only audio. Warnings cover duplicate labels, a much shorter file, mono vs stereo mix, sample-rate mismatch, and more than 8 files. Default bounds: 32 files and 12 hours of probed duration. Child symlinks that resolve outside the folder are refused.

Home → “Import recorder folder” GUI is a follow-up.

## Workflow

1. Put raw files in a folder (e.g. `Audio Files/`), or run **`podcast ingest import DIR`** to draft `ingest.yaml` from filenames.
2. Review speaker labels (and `session.reference_speaker`); override with `--speaker file=Name` if needed.
3. **`podcast ingest suggest`** — VAD sweep for `session_start_in_file_sec` (+ optional waveform PNGs).
4. Merge suggested offsets into `ingest.yaml`.
5. **`podcast ingest consolidate`** — extract `raw/{speaker}.wav` (+ `_srcN` for extras) and register tracks/clips. Without `--extract-start` the WAV stays whole and the primary clip is **placed** on the session clock (see Placement below). `--extract-start` alone trims from that session time to the end of the file; with `--extract-duration` it trims a window. An `--extract-start` that maps past the end of a speaker's primary file fails with an error naming the speaker and the file duration. Trimmed extracts are not re-placed. Short recordings are fine with default flags: a correlation window past EOF scores peak 0 and falls back to the session-start offset.
6. **`podcast ingest verify`** — VAD overlap audit on consolidated tracks, read through each track's clips (timeline clock).
7. **`podcast play --compare`** — hear each dialogue track then premix on the same window.
8. Or run the **pipeline** (transcribe → align_tracks → …) and clear the align gate.

## ingest.yaml example

```yaml
session:
  reference_speaker: Host

speakers:
  - name: Host
    sources:
      - "host.wav"
    session_start_in_file_sec: 0
  - name: Guest
    sources:
      - "guest.wav"
    # session_start_in_file_sec from suggest, or manual

align_anchors:
  - reference_speaker: Host
    reference_contains: how are you
    source_speaker: Guest
    source_contains: doing well
    align_to: after_reference
    gap_sec: 0.5
```

`align_to` is `after_reference` (default) or `start`. Anchors need `--transcript` JSON at consolidate time.

## Commands

```bash
# Draft ingest.yaml from a recorder export folder (audio-only)
podcast ingest import "/path/to/Audio Files" --out ingest.yaml

# Pre-consolidate offset suggestion (VAD + optional waveforms)
podcast ingest suggest \
  --audio-dir "/path/to/Audio Files" \
  --manifest ingest.yaml \
  --analysis-start 0 \
  --analysis-duration 90 \
  --sweep-min 0 --sweep-max 240 --sweep-step 5 \
  --waveform-top 3

# Legacy cross-correlation report
podcast ingest report \
  --audio-dir "/path/to/Audio Files" \
  --manifest ingest.yaml

# Post-consolidate VAD verify
podcast ingest verify \
  --project ./my_episode/episode.project.json \
  --window 0:90 \
  --fail-on-warn

# Build one WAV per speaker
podcast episode init --dir ./my_episode --name "Episode"
podcast ingest consolidate \
  --audio-dir "/path/to/Audio Files" \
  --manifest ingest.yaml \
  --project ./my_episode/episode.project.json \
  --extract-start 0 \
  --extract-duration 300

# Listen: each dialogue track, then premix
podcast play --project ./my_episode/episode.project.json \
  --compare --start 0 --end 90
```

### Suggest flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--analysis-start` | `0` | Session window start for sweep |
| `--analysis-duration` | `90` | Window length (sec) |
| `--sweep-min` / `--sweep-max` / `--sweep-step` | `0` / `240` / `5` | Guest `session_start_in_file_sec` candidates |
| `--waveform-top` | `3` | PNG stacks for top N candidates |
| `--diag-dir` | workspace `artifacts/alignment` | Output directory for PNGs |

Suggest sweeps **each** non-reference guest independently. Cost is O(guests × sweep). Narrow `--sweep-max` / `--sweep-step` for interactive packs.

### Verify flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--window` | `0:90` | Timeline range `START:END` |
| `--fail-on-warn` | off | Exit 1 on `warn` or `fail` |
| `--waveforms` | on | Write `alignment_stack.png` |

## How alignment works (v1)

**One global offset per non-reference speaker.**

| Layer | Field | Method |
|-------|-------|--------|
| Session clock | `session_start_in_file_sec` | VAD sweep (`ingest suggest`) or RMS onset at consolidate |
| Content fine-tune | `content_align_sec` / `session_offset_sec` | VAD turn-taking; optional transcript anchors |
| Trim | — | `file_trim = session_start + extract_start - content_align` |
| Placement | clip `source_start` / `timeline_start` | Whole-file (untrimmed) consolidate: `edits/ingest_placement.place_ingest_sources` (`offset_to_clip_geometry(content_align - session_start)`) so session t=0 is timeline 0 for every speaker; the raw WAV stays whole (non-destructive). Only the primary clip is placed; extra clips follow sequentially. `ingest consolidate` warns when a multi-source speaker's primary clip is placed, since the extras carry no session offset of their own. A lead-in longer than the primary file skips placement and `ingest consolidate` prints a `Warning:` line on stderr. Trimmed extracts (`--extract-start`, with or without `--extract-duration`) are not re-placed. Pipeline `align_tracks` rebases every guest offset (including a held offset of 0) onto the reference clip's placement, so a reference lead-in survives re-alignment. `manual` clips keep their placement; `hold` clips keep any existing placement, including a prior guest nudge. A virgin identity `hold` is rebased onto the reference lead-in once; `unconfirmed_hold` guests are rebased like `weak_hold`. A split, trimmed or rippled track is not re-placed as a whole file (a head-trimmed clip at timeline 0 counts as trimmed unless its shift still matches the recorded `meta.ingest_alignment` lead-in): each clip keeps its timeline window and only its source range slips by the offset delta, so blades and ripples stay lined up; a track where the delta would leave a clip with no audio, or would stack two same-source clips on the timeline, is left unchanged with a `skipped_reason` on its plans (see [pipeline.md § Conversation align](pipeline.md#conversation-align-align_tracks--gate), #520). |

Cross-speaker correlation uses `session.reference_speaker` as the reference (not the first-listed file).
Its bounded WAV windows accept 8-, 16-, 24-, and 32-bit integer PCM, normalize
by the source width, and average channels in float64 before resampling. The
recording keeper format remains 16-bit PCM.

**Primary score:** `simultaneous_speech_sec` (VAD overlap). **Secondary:** correlation peak, anchor match, drift between two windows (`drift_warning` in suggest output).

**Do not** use transcript word overlap alone to confirm sync on bleed-heavy tracks.

Waveform PNGs under `artifacts/alignment/` (`showwavespic` via ffmpeg) show whether energy peaks line up vertically.

## v2 project fields written by consolidate

- **`sources`** — one raw file per speaker
- **`timeline.tracks`** / **`timeline.clips`** — one dialogue track per speaker; untrimmed clips carry the session placement (`source_start`, `timeline_start`)
- **`meta.ingest_alignment`** — per-speaker (or `track_id:clip_id` when a speaker has several whole-file clips or another dialogue track shares the speaker label; ingest and align share `ingest_alignment_meta_key`) `session_start_in_file_sec`, `content_align_sec`, `align_method`; the placement shift is `content_align_sec - session_start_in_file_sec` (`SpeakerIngestAlignment.source_to_timeline_shift_sec`)

## MCP tools

| Tool | Purpose |
|------|---------|
| `ingest_import_folder_tool` | Draft `ingest.yaml` from a recorder folder |
| `ingest_suggest_alignment_tool` | Pre-consolidate suggest |
| `ingest_verify_alignment_tool` | Post-consolidate verify |
| `play_compare_tool` | Sequential compare audition |
| `play_audio_tool` (`compare=true`) | Compare via play |

## Limitations (v1)

- Single global offset per **file** (split pieces share it; not piecewise drift inside one file).
- `suggest` sweeps **every** non-reference speaker vs the reference and writes
  `session_start_in_file_sec` for each into `yaml_snippet` /
  `recommended_session_starts`. Candidate list / drift / default waveforms still
  highlight the **first** non-reference guest (backward-compatible shape).
- Weak correlation / missing anchors: rely on VAD + listening.
- Pipeline `align_tracks` prefers consistent bleed n-grams, then own-speech gaps;
  equal-duration stems and manifest-pinned offsets are locked at their placement
  (`hold` / `manual`); `align.realign` (or `pipeline run --realign`) re-scores them.

## Assigning speakers

The tool does not guess speaker names. List **one file per speaker** in `ingest.yaml`. Omit intro/outro/SFX from `speakers`.
