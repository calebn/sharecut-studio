# Multitrack ingest and alignment

Raw recordings often arrive as **several files** in one folder. The episode workspace should end up with **one dialogue track per speaker** (typically two tracks total).

CLI and MCP ingest commands call `IngestService` through the public
`podcast_mcp.services.media` facade. The implementation lives in
`services/media/ingest.py`; recorder-folder scanning remains in `ingest/`.

**Remote recordings:** each file has its own **start/stop** and **duration**. Ingest maps them to one **session timeline** — not the same file timestamp on every recorder.

**Two clocks:** transcript word times stay in each track's **source-media seconds**; the edited/deliverable audio runs on **timeline seconds**. `timeline.clips` bridge the two and `engines/session_timeline.py` (`SessionTimeline`) is the only place that maps between them. See [episode-format-v2.md § Timebase invariant](episode-format-v2.md#timebase-invariant).

**Agent workflow:** `.agents/skills/podcast-align-audio/SKILL.md` (pipeline `align_tracks` + gate, or pre-pipeline suggest → verify → listen). Session-clock background: `.agents/skills/podcast-ingest-align/SKILL.md`.

Alignment windows and consolidated WAVs read the **first audio stream** of a source file, the stream the render plays (#2110); re-run ingest and align on a project made before that with a multi-stream source.

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

After `transcribe_tracks`, the default-on **`align_tracks`** step places dialogue clips on one session clock (bleed phrase Δt, else own-speech/VAD gaps; N speakers). **`require_align_accept`** gates later steps until listen/`podcast align done` (or unattended waive; never for moves above `align.large_move_sec`). Equal-length and manifest-pinned stems are locked (`hold`/`manual`) unless `align.realign`. Uncheck Align in the Pipeline pane when files are not one conversation. The accept sidecar `artifacts/align_accept_status.json` is a `edits/review_gate.ReviewGate` (`ALIGN_GATE` in `edits/align_accept_status.py`), the same gate transcript refine uses; the align module adds only the plan-digest, accepted-drift and unattended-findings policy. See [pipeline.md](pipeline.md) and skill **podcast-align-audio**.

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

One latency is not always enough. Zoom's jitter buffer can re-time a track when its talker resumes after a pause, then ease it back. On the lab tape Audra trails her bleed by 130-150 ms most of the time and by 185-225 ms in the first stretch after several pauses (about 270 ms at the start of 646-660 s). So for a lane the bleed moves or keeps on latency grounds, `align_tracks` also finds where its latency steps, with each step inside one of the lane's own silences. It splits the lane's clip in those silences and slips each piece to its own latency, in the same undoable history entry. A step skips or repeats only silence, never a word: the full-band audio there has 30 ms RMS 45 dB under the lane's voice level and every sample peak 35 dB under it (-60 and -50 dBFS on the lab tape; [audio-engineering.md § Detection levels](audio-engineering.md#detection-levels)). Silence is judged on the full-band audio, because the 8 kHz lag decode hides sibilants. A manifest-pinned, `copy_later`, conflicting or drifting lane gets no steps. Bleed is evidence of timing only; it is never used as audio for another speaker.

The rules are relative to each recording (#1090). Steps come from every pair the lane shares with a track on the reference clock, in either direction, not only from the reference mic. Each talk spurt is scored on its own correlation, so a phrase's level relation to its copy, which follows loudness and the room, cannot pull it into a neighbouring piece. A piece needs its lag pinned by its own evidence (its likelihood-ratio interval inside the deadband, counted in the talker's voiced frames), not a fixed frame count, so a short clear phrase is a piece and a lone click is not. A step is judged against the merged pieces either side of it, so two neighbours inside the deadband become one piece instead of forcing the step into the wrong silence, and where the evidence cannot place a step it goes in the widest silence. The step cost is chosen per lane by cross-validation on held-out frames of every spurt, the smallest cost whose held-out fit is not measurably worse than the best. Each pair's steady lag is measured on the lane's media, so a re-run finds the same steps, keeps the pieces and their `meta.ingest_alignment` records, and writes no history entry. Thresholds, the artifact fields and the lab numbers are in [pipeline.md § Conversation align](pipeline.md#conversation-align-align_tracks--gate).

A per-track timing map that keeps the lane as one clip and follows lag changes
inside continuous speech is planned in #1089. On the lab tape a lag change inside
one talk spurt (1663.8-1671.1 s) and a lag outside the 100 ms search (646-660 s, and
about 20 ms at 740.4 s) need that timing map.

#### Word starts missing from their own track

After placing the clips, `align_tracks` checks every opening of a speaker's own track whose sound reached another mic first (#1059). Two different things look alike there:

- **A clipped start.** A call app's gate opened partway into the word. The track jumps from the gate straight to the word's level, and the sound just after the opening lines up with the copy on the other mic. Bleed is never used as audio for another speaker, so that start is missing from the mix.
- **A late track.** The word is whole on its own track, with its own attack, but plays late: the sound after the opening lines up with the copy shifted back by about the lead. That is alignment left over (a lane offset align could not solve or did not apply, or a local lag its pieces do not follow), not a clipped start.

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
- PR #1170 verification: across about 270 adversarial synthetic recordings no flag was wrong and no late turn was flagged
- PR #1170 verification: a per-lane late-start report sized most lab entries wrongly (its 400 ms envelope match locks onto syllable rhythm), so it was removed
- Revised: round 3 flagged every copy lead past the tolerance and moved each word onto its opening
enforced-by:
- tests/test_clipped_onsets.py::test_a_gate_that_cuts_off_a_word_s_start_flags_it_and_snaps_its_start
- tests/test_clipped_onsets.py::test_a_word_whole_but_late_on_its_own_track_is_not_flagged
- tests/test_clipped_onsets.py::test_word_whose_track_opens_with_its_voice_is_not_flagged
- tests/test_clipped_onsets.py::test_a_lane_left_late_flags_nothing_and_moves_no_word
- docs-sync: decision-alignment
-->

Only a clipped start is flagged and moved. A late track is neither flagged nor reported: its words are whole, so moving their starts would only hide an alignment error, and this pass cannot measure the lateness reliably. Fixing it is alignment's job: `--realign` or applying a proposed shift for a lane offset, the silence-bounded pieces above (#1090) for a lag that steps, and the planned timing map (#1089) for a lag that changes inside speech.

For a clipped start, `edits/clipped_onsets.py` moves the word's start to where the speaker's own track opens and keeps the start it had in `snapped_from`. A start already at or after the opening is left alone. So is a word a person re-timed (`timing_edited`): the person's start wins, `snapped_from` is cleared by the edit, and the word's open comment is withdrawn on the next run. The word gets its own timeline comment, written by `Align tracks`, from where the missing part reached the other mic to the opening, naming the word, how much is missing and which mic has it. See [timeline-comments.md § Comments from Align tracks](timeline-comments.md#comments-from-align-tracks). The step summary adds `N word starts missing from their own track (see comments)`. The pass also runs when align skips, so a project with fewer than two dialogue lanes has its open comments withdrawn and its moved starts put back.

**Idempotent.** Each run first puts every moved start back on `snapped_from`, judges every word at its original time, and moves only the words it flags again. So the transcript depends only on where the lanes sit now: a default run followed by `--realign` leaves the same words and comments as a fresh `--realign`. Everything is judged before anything changes, so a failure leaves words, comments and clips as they were.

The rule reads the timeline after alignment, from 8 kHz level envelopes: a 30 ms frame every 5 ms, and a 5 ms frame every 1 ms for attacks. Every level threshold is relative to the episode's own measurements, and each fixed number has its reason in `edits/clipped_onsets.py`:

- **Copy path.** An ordered pair whose direct track follows its copy at one lag (consistent or drifting in `bleed_latency.measure_pair`), measured again where the lanes now sit. A scattered pair, or one with no bleed, flags nothing, because without a lag the mic's own speaker cannot be told from the copy. The coupling is the median of mic level less direct level over the frames that measurement counts.
- **Opening.** The speaker's track rises 12 dB (twice the 6 dB margin `measure_pair` needs to call one level over another) over its floor, its 5th-percentile level, after at least 100 ms below it (longer than the gaps between syllables), and stays up for two level frames. Over its first 200 ms (one syllable) it out-levels the mic by 6 dB, the margin `measure_pair` needs to count a frame as copy.
- **Copy onset and lead.** Walking back from the copy of the speaker's speech onset, the mic's run stays within 20 dB of the copy's level, the range a word's soft sounds span under its loudest vowel. Both onsets are read 20 dB under their own level, so a copy that only follows the direct sound never leads it. The walk stops at the speaker's previous sound and at 0.5 s. A copy onset more than `align.bleed_lag_tolerance_sec` (40 ms) before the opening is a lead: a shorter one is the timing error align itself calls aligned, and 40 ms is more than one 30 ms level frame.
- **Content shift.** The speaker's first 400 ms after the opening (two syllables, so one shift wins) is correlated with the mic at every shift from 0 to the lead. The best shift is how late the track plays that sound. It counts only at a correlation of 0.4, the match `envelope_lag` needs to call a lag supported. A late track matches at about the lead, which leaves nothing missing, so this is what keeps a late word from being flagged. The shift itself is not reported: it tells "nothing missing" from "something missing", but on real speech it often locks onto the syllable rhythm and misreads how late a track plays.
- **Attack.** The entry is the track's level over its first 10 ms after it opens, less the word's peak. A voice's own attack takes tens of milliseconds to reach the word's level; a gate opening into a word gets there within one 5 ms frame. The lane's attack profile is the entry at every opening whose copy shows it whole (the copy onset, at the path's lag, does not lead past the tolerance). An opening is abrupt when its entry is over the profile's 95th percentile, so even the hardest natural consonant starts on that lane set the bar. A lane with fewer than 20 whole starts has no profile, so nothing on it is abrupt.
- **Clipped.** The content matches, the opening is abrupt, and the lead less the late shift is still over the tolerance. A gate cut on a late track can be clipped too; only the part past the lateness counts as missing. Any other lead flags nothing.
- **Word.** The first transcript word whose original start is in the speaker's silence before the opening and that runs past it. Word starts are read 250 ms either side, because ASR misplaces them that far on gated tracks. An opening without such a word, such as a laugh, is not flagged.

**What it catches.** The flag is built for precision. In an adversarial synthetic sweep (about 270 recordings: late turns with and without crosstalk, plosive-heavy and fricative-heavy speakers, noisy rooms, gates that clip many openings) no flag was wrong and no late turn was flagged. Recall is limited, and each limit below fails silent, never as a false flag:

- **Cut length.** Over arbitrary turns (6 recordings, 36 cuts per length), a gate cut of 30 ms flagged 0, 60 ms 4, 100 ms 23 and 150 ms 10. In practice a cut has to be about 70-80 ms to flag, not the 40 ms tolerance: the copy onset is read 20 dB under the copy's level, so a 60 ms cut measures as a lead of about 45 ms.
- **A cut that takes the whole first syllable.** When the cut removes all of the word's first syllable, or all but its last few ms, the track opens on the next syllable's own attack, which is not abrupt. These are the most severe clips and they are missed; this is why 150 ms cuts flag less often than 100 ms ones.
- **Few whole starts.** A lane with fewer than 20 whole starts never flags, so a gate that clips almost every opening hides all of its clips.
- **Short clips counted as whole.** A clip whose lead stays within the tolerance (cuts up to about 50-60 ms) counts as a whole start, so a few such abrupt entries raise the lane's bar. In the sweep, with every opening clipped by 0-150 ms, the bar rose from about -19 dB to -4 to -7 dB in 3 of 6 recordings; with every cut between 20 and 60 ms it rose to -4 to 0 dB. That can hide a clip whose entry falls under the raised bar. In the sweep it hid none: counting only starts whose copy does not lead at all kept the bar near -19 dB and flagged exactly the same openings, because the long cuts enter near the word's peak. So the rule keeps the simpler tolerance test.
- **Noisy rooms.** The copy onset must clear the mic's floor by 12 dB while 20 dB under the copy's level, so nothing flags once the copy is less than about 30 dB over the mic's floor. In the sweep, with the copy near -38 dBFS, room tone at -70 dBFS or quieter left recall intact, -65 dBFS flagged 1 of 7, and -60 dBFS or louder flagged nothing.

**Comments on re-runs.** A word's comment id comes from the word (its lane, recording and original start), so a re-run that finds an opening a few ms away keeps the same comment. A re-run updates or withdraws its own open comments that no longer apply, for example after `--realign` shifts the lane. A comment someone resolved, answered or ticked stays as it is, and a run never adds a second comment over a word whose comment was answered. Undecodable audio flags nothing and leaves existing comments and moved starts alone.

Lab evidence (Whisper word times; the guest lane is a gated call track, the host mic carries its copy):

- **Lane shifted** (`--realign`, with the pieces above). Nothing is flagged and no word moves. The guest lane has 16 openings with a copy lead. Each opens with a normal attack, 18-64 dB under the word's peak, against the lane's whole-start bar of 15.6 dB under (95th percentile of 55 whole starts), so none is abrupt. The previous rule flagged 7 of these openings, and the owner heard every one of those words whole. A few of these words do play late on the guest's track; that residual is left to alignment (#1089).
- **Default run.** The manifest pin keeps the guest lane about 140 ms late (the shift is only proposed). Nothing is flagged and no word moves.
- **Re-runs.** A default run followed by `--realign` leaves exactly the words and comments of a fresh `--realign`.
- **Mix.** With every tighten candidate applied (aggressive, review ones included) and the preview rendered, the whole premix is bit-identical to `origin/main`'s.
- The remote speaker flags nothing: their pair with the host mic is scattered.

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
# two takes of one mic (a restarted recording): give both files the same label,
#   --speaker take1.wav="Vicky" --speaker take2.wav="Vicky"
# and ingest.yaml gets one speaker with both `sources`, in file order. Only
# explicit --speaker labels merge; labels the scan derives that collide still
# get a numeric suffix ("Host", "Host 2").
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
| Session clock | `session_start_in_file_sec` | `session_start_in_file_sec` in the manifest, else 0; `ingest suggest` sweeps candidates. No speech-onset guess: two speakers' first words are not one event (#1533) |
| Content fine-tune | `content_align_sec` / `session_offset_sec` | VAD turn-taking; optional transcript anchors |
| Trim | — | `file_trim = session_start + extract_start - content_align` |
| Placement | clip `source_start` / `timeline_start` | Whole-file (untrimmed) consolidate: `edits/ingest_placement.place_ingest_sources` (`offset_to_clip_geometry(content_align - session_start)`) so session t=0 is timeline 0 for every speaker; the raw WAV stays whole (non-destructive). Only the primary clip is placed; extra clips follow sequentially. `ingest consolidate` warns when a multi-source speaker's primary clip is placed, since the extras carry no session offset of their own. A lead-in longer than the primary file skips placement and `ingest consolidate` prints a `Warning:` line on stderr. Trimmed extracts (`--extract-start`, with or without `--extract-duration`) are not re-placed. Pipeline `align_tracks` rebases every guest offset (including a held offset of 0) onto the reference clip's placement, so a reference lead-in survives re-alignment. `manual` clips keep their placement; `hold` clips keep any existing placement, including a prior guest nudge. A virgin identity `hold` is rebased onto the reference lead-in once; `unconfirmed_hold` guests are rebased like `weak_hold`. A split, trimmed or rippled track is not re-placed as a whole file (a head-trimmed clip at timeline 0 counts as trimmed unless its shift still matches the recorded `meta.ingest_alignment` lead-in): each clip keeps its timeline window and only its source range slips by the offset delta, so blades and ripples stay lined up; a track where the delta would leave a clip with no audio, or would stack two same-source clips on the timeline, is left unchanged with a `skipped_reason` on its plans (see [pipeline.md § Conversation align](pipeline.md#conversation-align-align_tracks--gate), #520). |

Cross-speaker correlation uses `session.reference_speaker` as the reference (not the first-listed file).
Its bounded WAV windows accept 8-, 16-, 24-, and 32-bit integer PCM, normalize
by the source width, and average channels in float64 before resampling. The
recording keeper format remains 16-bit PCM.

For an `audio` speaker, `cross_speaker_offsets_sec` printed by `ingest
consolidate` is the raw estimator lag: positive means the guest content is
later in its source file. When that audio result is applied to a project,
ingest converts it to the session-clock placement shift (`content_align_sec`),
which has the opposite sign. Manifest and transcript offsets already use the
session-clock sign and are applied unchanged.

**Primary score:** `simultaneous_speech_sec` (VAD overlap). **Secondary:** correlation peak, anchor match, drift between two windows (`drift_warning` in suggest output).

The VAD reads each window in one decode per 30 s block and frames it into 0.25 s chunks in numpy (`vad_speech_intervals`), not one ffmpeg process per chunk (#1546): a 90 s window of a compressed file takes seconds, not tens of seconds, and gives the same intervals, so a longer analysis window is affordable.

**Do not** use transcript word overlap alone to confirm sync on bleed-heavy tracks.

Waveform PNGs under `artifacts/alignment/` (`showwavespic` via ffmpeg) show whether energy peaks line up vertically.

## v2 project fields written by consolidate

- **`sources`** — the raw files per speaker (normally one; several takes of one mic are allowed)
- **`timeline.tracks`** / **`timeline.clips`** — one dialogue track per speaker; untrimmed clips carry the session placement (`source_start`, `timeline_start`)
- **`meta.ingest_alignment`** — per-speaker (or `track_id:clip_id` when a speaker has several whole-file clips or another dialogue track shares the speaker label; ingest and align share `ingest_alignment_meta_key`) `session_start_in_file_sec`, `content_align_sec`, `align_method`; the placement shift is `content_align_sec - session_start_in_file_sec` (`SpeakerIngestAlignment.source_to_timeline_shift_sec`)

## Ingest MCP tools

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

The tool does not guess speaker names. List **one speaker per person** in `ingest.yaml`: normally one file, or several takes of one mic as that speaker's `sources`. Omit intro/outro/SFX from `speakers`.

## Split one recording by speaker

A room mic or a phone recorder puts several people on one file. `podcast speaker split`
(MCP `speaker_split_tool`, `SpeakerService.split_speakers`) turns that lane into one
lane per speaker, so each can be levelled, EQ'd and processed like a multitrack
episode (#1095). ShareCut Studio runs the same service from the track inspector
(**Split speakers…**, below).

```bash
podcast speaker split --project P --track room --speakers 3 --dry-run
podcast speaker split --project P --track room \
  --enroll "Caleb=37.6:47.6" --enroll "Audra=428.5:434.1" --enroll "Lana=270.7:278.3" --apply
podcast speaker split --project P --track room --speakers 2 --crosstalk lane --apply
```

**Input.** The speaker count is required: from the call, or the one the user saved with
`set-speaker-count`. It is never inferred from the track count. `--enroll NAME=START:END`
(source seconds, repeatable) names a few seconds of only that speaker and seeds that
speaker's cluster. Enrolling some speakers and not others works: the rest are clustered
and numbered by when each first talks. `--name` (repeatable) sets every name in order
and must include each enrolled name; without it, enrolled speakers come first and the
rest are `Speaker N`. An enrollment window that the end of the audio cuts to under 50 ms (800 samples at 16 kHz) is dropped, not embedded as a sliver; a shorter-than-a-second window of 50 ms or more is still embedded; a speaker whose spans all lie past the end is refused with `enrollment_past_end`. A span longer than the recording costs about as much as one that ends a window past it. An enrolled name with no spans is refused with `enrollment_empty` before any audio is read. Spans must be finite with 0 <= start < end; a bad span, including one with start equal to end, is refused with `enrollment_span_invalid` before any audio is read. The ECAPA ONNX speaker model is required (downloaded in the Split speakers dialog); the CI mock is refused.

**Data shape.** `engines/speaker_split.py` returns a `SpeakerAttribution`: turns that
cover the recording with no gaps, each with its speakers (most likely first, two or
more is crosstalk) and a confidence. `edits/speaker_split.py` applies it in one
`ProjectWorkspace.mutate()` entry:

- The original lane becomes the first speaker's lane. Each other speaker gets a copy of
  it: same `media.path`, same clip geometry, FX chain and envelopes. No audio is copied
  or decoded into the workspace.
- Each lane gets `mute_regions` wherever another lane owns the audio. Ownership follows
  the turns, so outside crosstalk exactly one lane is open at any moment and the lanes
  sum back to the recording. The 20 ms fades are centred on each hand-over, so one
  lane's linear fade-out and the next lane's fade-in sum to one.
- Flagged crosstalk plays once, on the lane of its most likely speaker (default
  `--crosstalk owner`): nothing plays twice, the lanes sum back exactly, and the turn
  keeps both speakers so the flag can be reviewed. A flag has two sources: a whole
  window where the runner-up sounds present (usually wrong: on the lab, 95% of that
  time is a pause or one person talking, see Failure modes), and a hand-over left
  inside a voiced run (see Hand-overs below; usually right).
  Two opt-ins: `--crosstalk both` plays it on every talking speaker's lane (the
  mix carries it twice, about +6 dB), and `--crosstalk lane` moves it to a shared
  `Crosstalk` lane (the sum stays exact, but a stretch of one speaker's turn then jumps
  to another lane's processing).
- Transcript words of the original lane go to the most likely speaker of the turn that
  holds their midpoint.
- `editorial.speaker_splits[]` keeps the turns, so crosstalk is flagged in the project
  ([episode-format-v2.md](episode-format-v2.md#timeline-and-render)). Doctor and export
  QC skip muted time when they look for stacked copies, so they report exactly the
  audio two lanes play at once: none with `owner` or `lane`, the flagged crosstalk with
  `both`.
- `--room-tone-fill` lays the track's room tone (`engines/room_tone.py`, #1054) under each
  mute. It is off by default: the open lane already carries the bed, so every fill adds
  another copy of it to the mix. A gated recording has no room tone and stays silent.

**In ShareCut Studio.** **Split speakers…** sits beside **Replace audio…** in the track
inspector (host only) and in the command palette (`track.splitSpeakers`). It is disabled
with its reason beside it when the track has no audio or is already a lane of a split
(the project view's `TrackView.speaker_split_id`). The dialog asks for the speaker
count (2 to 8) and optional names; a blank name becomes `Speaker N`, and the engine
numbers unnamed speakers by who talks first. It posts `POST /api/speaker/split
{ path, track_id, speaker_count, names?, enrollment? }`, which starts a `kind=split_speakers`
pipeline-slot job over `SpeakerService.split_speakers` with `dry_run=False`, the
`owner` crosstalk mode and no room-tone fill. The route validates first
(`SpeakerService.check_split`: the count, the names, a real embedding backend, a
splittable track), so a refusal is a 400 or 409 and no job starts. `enrollment` is
`{name: [[start, end]]}` in **source** seconds, the same as `--enroll` and the MCP
`enrollment`, and reaches `split_speakers` unchanged through `coerce_enrollment` (the one
JSON-to-spans conversion the route, job and MCP share); with `names` given, every
enrolled name must be one of them; without it the enrolled names become the first
speakers. In the dialog, each speaker has **Use selection**: select a few seconds of that
person talking on the track (the exact range selection), and the range is kept as that
speaker's voice sample, mapped from timeline to source seconds through the track's clip.
**Listen** replays it and **Clear** drops it. A range that crosses a cut, sits off the
track or is under a second is refused with its reason beside the button. The playhead
alone cannot mark a sample, since a point has no length. The result also says to undo
and run again with a sample per speaker when two tracks sound like one person. The
crosstalk modes and `--room-tone-fill` stay on the CLI and MCP. The job's progress
counts embedded windows, so the bar moves for the whole attribution; Cancel stops it
between windows and, once attribution is done, before the project is touched. The
result is the service's: `lanes[{track_id, name, muted_sec}]`, `crosstalk_sec`,
`crosstalk_regions`, `low_confidence_sec` and `low_confidence_regions` (turns under
`LOW_CONFIDENCE` = 0.5) and `history_head_id` (the `after split speakers` entry).
Studio refreshes the project, announces "Split Room into 3 tracks: Ana, Ben and Cy."
with an Undo bound to that history entry, and keeps the dialog open on the result:
the new tracks with how much of the recording each plays, then what to listen for
(overlapping speech that plays once, and stretches the attribution is unsure of) and
**Undo split**. Redo is the ordinary Redo. The split is one
undo step, `before split speakers` / `after split speakers`.

**Attribution.** Silero frames (20 ms) → 1 s windows every 0.25 s that are at least 30%
voiced → embeddings → spherical k-means seeded from the enrollment spans (or k-means++)
→ each frame scores each speaker by the mean cosine of the windows covering it → a
Viterbi pass picks one speaker per frame, with a switch costing 8 (log-odds at cosine /
0.05) inside voiced frames and 1 in a pause → hand-overs settle into pauses (below).
Crosstalk is a whole window where the runner-up reads at least halfway from its own
absent level to its own present level, or a hand-over left inside a voiced run.

**Hand-overs** (`engines/speaker_hand_overs.py`, from the owner's listening round). A
frame score is the mean of the 1 s windows over it, so a turn shorter than a window has
its evidence smeared over the pauses beside it, and since a hand-over costs less in a
pause, the Viterbi pass alone can park a short turn in the silence next to its own voice
or end it inside its voiced run. On the lab it did both: one reply's turn held none of
its own voice, and the reply played on the neighbour's lane. After the Viterbi pass:

- *Voiced runs* form one fixed union before settlement. Global and provisional-cluster
  measurements select 20 ms frames at or above their floor-to-speech midpoint in dB.
  The floor is the 10th percentile of non-digital sound. Speech is the median of
  detector-positive sound, or all sound when the detector is unavailable. When no
  detector-positive sound exists, the global speech estimate uses the 90th percentile
  of sound. Cluster calibration first bridges eligible dips up to 40 ms and removes
  eligible runs under 60 ms within that cluster. Its median uses only the original
  eligible samples in surviving runs and needs at least three samples. Detector
  blips without a duration-qualified bridged run cannot seed cluster calibration.
  Its midpoint uses the lower of its own floor and the global floor, so speech-only
  labels can borrow measured background and quieter local background
  remains usable.
- With at least 6 dB between speech and a measured floor, actual detector-positive
  non-digital sound also joins the union, including quiet replies mislabeled or parked
  in an adjacent pause. Dips up to 40 ms bridge and runs under 60 ms disappear.
  Detector false positives that survive this duration filter remain protected voice.
  Duration-qualified false positives can also seed the local median and expand voice
  across louder background within their cluster. Digital silence cannot supply a
  floor or detector voice.
- Without a detector, embedding windows and switching use all frames as eligible,
  while run construction receives no detector evidence. At least one cluster must
  show 6 dB contrast within its own sound distribution before settlement can run.
  Every cluster with enough duration-qualified sound for calibration must also
  separate its median from the lower local or global floor by at least 6 dB.
  Otherwise the entire pass abstains, preserving provisional ownership. Contrast
  in another cluster cannot establish whether unresolved constant-level sound is
  quiet speech or background. Different flat speaker levels alone cannot establish
  a pause. With no measurable contrast, including gated constant-level speech,
  labels stay unchanged and this
  pass adds no crosstalk flags. Real all-true detector output remains distinct from
  an unavailable detector.
- *Evidence* for a stretch of voice is the mean of its own embedding (that voice alone:
  not pulled towards a long neighbour, but noisy when short) and its window scores (that
  voice in context). Under 0.3 s, too short to embed, it keeps its window scores.
- *A short turn* (less than a window of voice) keeps its whole run: a hand-over beside
  it may move to any pause within a window, between its neighbouring hand-overs, and
  does when the runs it hands over gain evidence.
- *A hand-over inside a run* moves to the pause just before or after the run when the
  piece it hands over sounds more like the other side. When neither piece does, or no
  pause is within a window, the run holds both voices with no pause between them: the
  cut stays and 0.25 s either side is flagged as crosstalk. A run under 0.3 s is too
  short for two people, and its hand-over always moves.
- Every other hand-over lands on the quietest cut of its own pause, and a turn left with
  no voice joins its neighbours at its quietest cut.

**Too high a count.** With more speakers than voices, k-means splits one voice into
two clusters and the split puts one person on two lanes. Nothing checks for this: the
count is the user's. Undo and split again with a lower count (a check is tracked in
#1340).

### Known limitations

#### Decision: Accept that a short reply can land on the wrong speaker's lane

<!-- decision
id: D-split-short-reply-limit
status: accepted
date: 2026-10-12
decided-by: calebn
evidence:
- #1204: in the shortened enrolled ECAPA fixture `CONTROL-short-reply.wav` (16 kHz mono, 22.8 s, 10.8 s of enrollment before a 12 s excerpt), Lana's reply at source 492.16 to 492.72 s is saved inside an Audra turn and plays on Audra's lane. The result is identical before and after #1200, whose changes preserve quiet turns but leave clustering, scoring and Viterbi alone
- #1204 diagnosis on main 6033d77a: the first error is the embedding, before temporal decoding. The detected reply (input 13.96 to 14.56 s) scores Caleb 0.1611, Audra 0.2075, Lana 0.0945 against the enrolled prototypes; the contextual scores and the Viterbi pass also choose Audra. The original channels and enrollment support Lana as the primary speaker, but do not rule out simultaneous Audra speech
- #1204 rejected: duration-matched enrollment means and fixed cohort calibration (select Caleb); whole declared three-second enrollment spans (select Audra at every boundary variant); symmetric pretrained embedding centering (Audra), where the backend already matches SpeechBrain's default verification; the cached alternate representation (Audra with current, whole-span and actual-duration enrollment; uniform one-frame boundary variants fail to establish recovery); temporal settlement and a switch-cost-only change, which add no missing identity evidence
- #1204 untested: a candidate that passes the actual detected reply and then independent short-utterance validation on the existing source material, plus speaker and boundary controls
- #1095 failure modes: 83% of the attribution errors on the lab tape sit within 0.5 s of a speaker change and 73% inside talk spurts under 1 s, which a 1 s embedding window cannot name
manual-review: owner, on a user report: no test pins this limitation because no fix is known, and the lab fixture is private. The owner reopens #1204 on a user report of a short reply on the wrong lane, or when a method that identifies short utterances exists and passes the actual-run gate, such as a short-utterance embedding or source separation, then the controls listed in the issue and candidate listening approval
-->

When it happens: a very short turn, such as a "yes", an "uh-huh" or a one-word reply under about a second, scores closer to a neighbour's enrollment than to the replier's own. Similar voices make it likelier (in #1204 the pair is Audra and Lana).

What you hear: after a split, the reply plays on the neighbour's lane, not the replier's. The lanes still sum back to the recording, so the mix sounds right. You notice it when you solo a lane, process lanes differently, or cut by speaker: the replier's lane has a hole and the neighbour's lane holds the reply.

What to do:

- Listen to each lane at hand-overs after `--apply`, as the [speaker attribution skill](../.agents/skills/podcast-speaker-attribution/SKILL.md) says, and use `--dry-run` first to read `low_confidence_sec`.
- To try more enrollment, undo the split (`history_undo`), then rerun `podcast speaker split --enroll NAME=START:END` (repeatable per speaker), dry-run first. Give several clean spans, each at least a few seconds of only that speaker. This may not move the reply: #1204's tests with whole declared spans still chose the wrong speaker.
- If a reply stays on the wrong lane, select that span on the wrong lane and use **Move to {speaker}** in range actions (CLI `podcast speaker move-lane-span`, MCP `speaker_move_lane_span_tool`) to mute it there and reopen the sibling lane. One undo step. Range mute alone only silences the wrong lane; it does not reopen the right one.

Reopen #1204 on a user report, or when a method for short utterances passes the actual-run gate named in the block.

### Evidence: gold mixdown enrollment (#1621)

The gold mixdown (`source/gold/full-mixdown.wav` in the private lab checkout) is 184.679 s of the same three speakers after the human content cut. It is not the 28-minute Zoom sum in the table below.

`SpeakerService.check_split` raises `model_needed` when the ONNX model is not downloaded, or `speaker_backend_unavailable` when a download cannot help. The splits below were run with the since-removed Resemblyzer backend (#2255 keeps ECAPA ONNX only), with `podcast speaker split --track room --speakers 3`, and the same engine path as MCP `enrollment` and CLI `--enroll NAME=START:END` (source seconds). Enrollment spans are exclusive 8 s windows taken from the gold solos: Caleb `24.0:32.0`, Audra `149.75:157.75`, Lana `114.88:122.88`. No audio left the Mac.

| | Blind (`method=cluster`) | Enrolled (`method=enroll`) |
| --- | --- | --- |
| Speaker count | 3 (Speaker 1, Speaker 2, Speaker 3) | 3 (Caleb, Audra, Lana) |
| Lane open sec (`seconds_by_speaker`) | 84.22 / 55.94 / 44.52 | 84.08 / 55.94 / 44.66 |
| Lane `muted_sec` after `--apply` | 100.459 / 128.739 / 140.160 | 100.599 / 128.739 / 140.020 |
| `crosstalk_sec` | 2.60 | 3.48 |
| `low_confidence_sec` | 17.64 | 16.62 |
| Turns | 32 | 34 |
| Backend | resemblyzer | resemblyzer |

Each enrollment window plays on one lane for the full 8 s. Blind Speaker 1, 2, and 3 match Caleb, Audra, and Lana. Resemblyzer did not collapse this 184.7 s mixdown. Enrollment named the lanes and moved 0.14 s between Caleb and Lana. Collapse of one voice into two clusters remains a Resemblyzer failure on the longer mixdown (below, 0.5 s and 1.5 s windows).

### Evidence: lab mixdown (#1095)

Truth is the lab tape (rev 3b414c4c): the three aligned Zoom tracks summed into one
48 kHz mono file. A speaker is talking in a 20 ms frame when their own track is within
30 dB of its own speech level and the bleed gate's acoustic evidence (`_own_voice` over
`_foreign_speech`) does not call the frame a peer's copy. That gives 1,013 s with one
speaker (Caleb 684, Audra 153, Lana 175) and 141 s of crosstalk. Enrollment is
simulated with each speaker's earliest clean turns, 10 s per speaker.

Frame accuracy on one-speaker frames (crosstalk column: share of crosstalk frames given
to one of the people talking), per window length, ECAPA:

| Approach | 0.5 s | 1 s | 1.5 s | 3 s | crosstalk (1 s) | CPU s per audio hour (1 s) |
|---|---|---|---|---|---|---|
| A. k-means, k = 3, nearest window | 0.887 | 0.941 | 0.949 | 0.929 | 0.943 | 229 |
| B. enrollment only (10 s each), nearest window | 0.866 | 0.926 | 0.936 | 0.918 | 0.943 | 229 |
| C1. A + pitch and level edges | 0.912 | 0.949 | 0.951 | 0.936 | 0.934 | 230 |
| C2. B + pitch and level edges | 0.898 | 0.939 | 0.940 | 0.925 | 0.919 | 230 |
| D. enrollment-seeded k-means + level edges (shipped) | 0.918 | 0.951 | 0.949 | 0.925 | 0.954 | 230 |

Resemblyzer at 1 s: A 0.943, B 0.947, C 0.942, D 0.954, at 129 s per audio hour. Blind
k-means with Resemblyzer collapsed at 0.5 s and 1.5 s (0.518 and 0.614: one voice split
into two clusters); enrollment seeding fixed it. The shipped engine end to end (voice
detector, embedding, Viterbi) scored 0.951 with ECAPA both seeded and blind, per speaker
Caleb 0.962, Audra 0.971, Lana 0.888, in about 260 s per audio hour on an M2 Pro (one
run; embedding is most of it, 5,552 windows at about 20 ms each).

Pitch did not help at 1 s or longer, so the shipped edge refinement is level only: it
puts 80% of hand-overs in pauses against 61% for per-frame argmax, at the same accuracy.

**Hand-overs in pauses (owner listening round).** The owner heard a reply ("That's
good") on the wrong lane: the split had put that speaker's turn in the 1.1 s of silence
between her two bits of speech and given the reply to the speaker before her. Before and
after the hand-over pass, same run otherwise (seeded ECAPA, `owner`, whole tape):

| | Before | After |
|---|---|---|
| One-speaker frames to the right person | 0.9505 | 0.9526 |
| Caleb / Audra / Lana | 0.962 / 0.971 / 0.889 | 0.962 / 0.977 / 0.894 |
| Hand-overs on a voiced frame, not flagged | 115 of 317 | 0 of 294 |
| Hand-overs inside someone's talk spurt (truth, gaps under 0.1 s bridged), not flagged | 109 | 8 |
| Hand-overs left inside a run and flagged | 0 | 110 |
| Flagged crosstalk | 28 s | 79 s |

Of the 110 flagged hand-overs, 94 have two people talking within 0.3 s in the truth.
Most hand-overs the Viterbi pass put inside a run are real: of the 118 runs holding
one, 100 hold both speakers in the truth. Moving the cut out of every such run, judging
a short piece by its whole run, gave a speaker's words to the other lane (50 frames
fixed, 161 broken), which is why the cut moves only when the piece it hands over sounds
like the other side. Short-turn moves fixed
65 frames and broke 1. A run embedded alone was a worse judge than its windows (0.88
against 0.98 at 0.3-0.5 s), and windows embedding only their voiced frames scored
0.944, so the evidence averages the two rather than replacing the windows. The pass adds
about 8% to the split's time.

Rendered lanes against each person's original Zoom track (scaled like the mixdown),
seeded ECAPA, default `--crosstalk owner`:

| Lane | SNR vs own stem | mixdown vs own stem | own speech level | other voices left where only others talk |
|---|---|---|---|---|
| Caleb | 7.9 dB | 1.4 dB | +0.0 dB | -16.3 dB |
| Audra | 5.4 dB | -4.1 dB | -0.1 dB | -15.0 dB |
| Lana | 3.6 dB | -7.8 dB | -1.0 dB | -20.3 dB |

The lanes sum back to the mixdown within -76.7 dB over the whole tape. Before the hand-over pass, with `--crosstalk both` (one run
each) the SNR was 7.8 / 5.2 / 3.2 dB and the 28 s then flagged played twice, so the
whole-tape residual rose to -22.6 dB; with the pass, `both` would play the 79 s now
flagged twice. SNR stays low
because a lane keeps everything in its own turns: crosstalk, and Audra's room copy on
Caleb's mic, which follows her into her lane.

**Failure modes.**

- *Short talk.* 83% of the errors sit within 0.5 s of a speaker change and 73% inside
  talk spurts under 1 s (backchannels such as "uh-huh"), which a 1 s window cannot name.
  Lana, with the most backchannels, scores lowest. The hand-over pass keeps a short
  reply's run whole where its evidence points to the reply's speaker, but a reply that
  sounds like its neighbour on both its own embedding and its windows stays with the
  neighbour (on the lab, a 0.26 s sound just before the "That's good" reply).
- *Latched speech.* A hand-over inside a voiced run with no pause between the two
  speakers stays where the Viterbi pass put it, flagged. With `owner` the flag does not
  change the audio, so the cut can fall inside a word; review flagged turns.
- *Crosstalk detection does not work with learned embeddings.* On the lab, ECAPA flagged
  28-30 s as crosstalk at 5% precision and 1% recall: two voices at once read as neither
  speaker, not both, and 71% of the lab's overlap lasts under 0.5 s. That is why the
  default gives a flagged stretch to one speaker: with `--crosstalk both`, those flags
  play twice in the mix, and 95% of them are a pause or one person talking. The rule
  works where an embedding adds voices (the synthetic test backend). Overlap needs a
  dedicated detector or source separation (follow-up).
- *Blind clustering can split one voice.* Seen with Resemblyzer, and whenever the count
  is too high. Nothing flags it (#1340). Enroll a few seconds per speaker to avoid it.
- *Truth limits.* The bleed gate keeps some of Audra's copy on Caleb's mic as his own
  ([audio-engineering.md](audio-engineering.md)), so part of the Caleb errors and of the
  Caleb+Audra crosstalk is a truth artefact: 60% of Caleb's errors fall in his quietest
  quarter of frames.
