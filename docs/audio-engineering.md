# Audio engineering diagnostics

Objective, evidence-based tools for judging recording/mix quality — the "eyes and ears"
an agent uses before making cleanup or mastering recommendations. All of this runs on
FFmpeg filters and `numpy` — no extra installs required.

## Tools

| Tool | What it shows | Where |
|------|----------------|-------|
| `podcast edit audio-diagnostics --track <id> [--start --end]` | Spectrogram PNG + waveform PNG + `astats` health + hum flag, bundled for one track (or window) | `audio_diagnostics_tool` MCP / CLI |
| `podcast edit analyze-cleanup` | Per-track `health` block (astats + hum) alongside existing gate/bleed/fade findings | `analyze_cleanup_tool` MCP / CLI |
| `artifacts/mastered.hash` | Fingerprint of the premix and the audio `master.*` settings (`integrated_lufs`, `true_peak_db`, `lra`) the master was built from, then on a second line the settings it was mastered at; a mismatch re-masters on export (see [Mastering cache](#mastering-cache)) | written by the `master_loudness` pipeline step after `mastered.wav` is swapped in whole; cleared (with `master_qc.json`) when a master starts |
| `artifacts/master_qc.json` | Post-master loudness verification (the configured target and ceiling, measured vs. target, pass/fail), the premix input stats, the mastering plan, and the limiter gain reduction | written by the `master_loudness` pipeline step; the pass/fail verdict is re-derived when only the QC tolerances change |

When `--start` / `--end` (or MCP `start_sec` / `end_sec`) are set, `astats` and
`hum` are measured on **that extracted window**, not the whole stem. Do not treat
full-file diagnostics as evidence about a line in the middle of the episode.

A rendered stem is the timeline as it was rendered, so after an edit moves the timeline it
holds other audio at the same seconds. The audit reads a stem's audio only while
`stem_is_fresh` says it is fresh (`_fresh_stem_path`), including when it decodes each track
once for a long cut's speech guard (`build_track_rms_caches`, with `unprocessed=True` when
a track has an effects chain, same as reconcile); otherwise it reads the
recordings through each track's clips (`engines/lane_window.lane_window`, on the same native sample grid as the raw projection: `engines/sample_grid.py`).

## Reading a spectrogram

`render_spectrogram` (`showspectrumpic`, log-scaled) plots frequency
(vertical axis) against time (horizontal axis), with color intensity showing energy.
Full-file diagnostics keep the Hz legend (`legend=1`). **Windowed** spectrograms
used by `audition_context` `detail=visual` render with `legend=0` so the x-axis is
linear time across the image — JSON `visuals[].events[].x` (0–1) lines up with
pixels. Visual rendering bounds FFmpeg decoder and filter work to one thread per
render, so concurrent tracks and test workers cannot multiply image-render resources.
What to look for:

- **Thin horizontal bands at 50Hz/60Hz (and evenly spaced multiples above them)** — mains
  hum from ungrounded interfaces, laptop chargers, dimmer switches. Cross-check with the
  `hum` field from `detect_mains_hum` before trusting your eyes on a low-res image.
- **Dense energy concentrated around 4-9kHz** — sibilance/harshness; a candidate for the
  `deess` preset (native ffmpeg `deesser` filter, not the old bandreject notch).
- **A raised, broadband haze near the noise floor across the whole clip** — room tone,
  HVAC rumble, hiss; consider `noise_reduction`/`noise_reduction_heavy` (`afftdn`) or,
  for tougher room noise/HVAC hiss, `noise_reduction_rnnoise` (FFmpeg's `arnndn`, a small
  recurrent-network denoiser) — run `podcast bootstrap --component rnnoise` once to fetch
  its model file.
- **A hard flat ceiling at the very top of the plot for long stretches** — clipping;
  cross-check with `astats.peak_count`/`flat_factor` from the same window.

## Objective health stats (`measure_astats`)

Parses FFmpeg's `astats` filter (`Overall` values, falling back to the per-channel
values for fields FFmpeg only prints once, e.g. `Crest factor`):

- `dc_offset` — should be near 0; a persistent nonzero offset points at interface/driver
  issues and eats into available headroom.
- `peak_level_db` / `rms_level_db` — absolute levels; compare across tracks for gain
  staging problems the ear might not catch instantly.
- `crest_factor` — peak-to-RMS ratio. Very low crest factor on a dialogue track usually
  means over-compression/over-limiting already baked into the source.
- `flat_factor` — consecutive samples at the crest. Treat it as clipping only together
  with `peak_level_db` near 0 dBFS; quantized quiet tones can look "flat" without
  hitting digital max. `clipping_indicated` therefore ignores `flat_factor` when the
  peak is under `CLIPPING_MIN_PEAK_DB` (-20 dBFS): a gated Zoom track peaking at
  -68.7 dBFS reported `flat_factor` 6.0 and is not clipped (#775). `peak_count` is how
  many times the file hit *its own* peak, not 0 dBFS.
- `noise_floor_db` / `dynamic_range_db` — how much room is between noise and peaks.
  Analyze reads the health row's `voice_db` (the processed stem's voice level, below)
  too, and warns about an elevated noise floor when `noise_floor_db` sits within
  `NOISE_FLOOR_UNDER_VOICE_DB` (35 dB) of it, so a quieter recording of the same room
  gets the same warning.

## Detection levels

### Decision: Detection levels are offsets from each track's level profile

<!-- decision
id: D-relative-detection-levels
status: accepted
date: 2026-10-13
decided-by: calebn
evidence:
- #1443 beta plan D1, approved by the owner 2026-10-13
- #1374: the bleed gate planned 196 spans at 0 dB and none at -24 dB on the lab tape
- #1401: tighten proposals moved on the lab tape scaled -12 and -24 dB
- #1376: as-recorded pair loudness lost or inverted the echo pair when one mic was much quieter; discovery now uses voice floors plus optional normalized dominance
enforced-by:
- tests/test_level_literals.py::test_the_detectors_hold_no_absolute_level
- tests/test_tighten_gain_invariance.py::test_a_detector_decides_the_same_at_any_recording_level
- tests/test_tighten_gain_invariance.py::test_tighten_proposals_match_when_tracks_are_requantized_to_pcm_s16le
-->

A recording's gain moves every dBFS level in it, so no detector compares a level with a
fixed dBFS value. Each track has one `LevelProfile` (`engines/level_profile.py`): its
room (the 10th percentile of its 10 ms frames), its speech level (the 90th percentile of
the live frames) and its loud level (the 99th). `file_level_profile` measures it once per
audio file revision and sample rate, and every stage that reads the file at that rate
reads that one profile (`TrackRmsCache.profile`, `TrackAudioCache.profile`, the ASR
evidence gate's `TrackEnergy.profile`). A floor is read at the rate of the frames it is
compared with, because band-limiting lowers white room tone more than voice (about
3.5 dB lower at 8 kHz than at 16 kHz): the ASR silence filter, reconcile's 8 kHz caches
and `TrackEnergy` read an 8 kHz profile; tighten's waveform cache and
`recording_profile` read 16 kHz. Every threshold is an offset from it:

- The voice floor, `max(S - 27 dB, R + 6 dB)`, and the audibility floor and voice reach
  read from it. Tighten, reconcile, the ASR silence filter and its aligner evidence gate,
  word spans, joins, prosody segments and strip-silence all read these. Strip silence
  compares the 16 kHz 10 ms frame levels the floor was read from (`frame_levels_db`), not
  ffmpeg `silencedetect`'s sample peaks (`engines/silence.quiet_intervals`). Prosody's
  word-less segmentation reads the profile of its own energy pass, so it adds no decode.
- The voice level, `max(S, L - 6 dB)`: the speech level, or for a speaker who talks under
  a tenth of the time (whose speech level is room tone) 6 dB under the loud level. A
  speaker's loudest frames sit 5.3 to 6.3 dB over their speech level on the lab tape.
  The bleed path (reconcile's echo pairs and copy lag, the bleed gate, bleed-latency
  alignment and clipped onsets) reads every track through `LevelProfile.voice_gain`, so its
  open and floor levels are dB re that track's own voice. A track whose loudest frames show
  no voice over its room (a lane that talks for a second in four minutes) is read as
  recorded. The bleed gate and alignment read the voice level of the lane audio they decode.
  Comparisons between two tracks (which side of a pair is louder, a copy's level against its
  source) add back the difference of the two references (`LevelProfile.path_reference_db`),
  so they compare the tracks as recorded, as before: a track that holds only bleed (a muted
  guest) reads its bleed as its own voice, so only the as-recorded comparison can find it.
  Reported copy level (`level_db`) and word-level loudness add back that same difference.
  Pair discovery does not: it selects frames from per-track voice floors, and a
  voice-normalized dominance mask when enough co-open frames pass it.
  Reconcile's evidence is each track before its effects chain
  (`build_reconciliation_caches(..., unprocessed=True)`): a compressor's threshold is an
  absolute level, so a processed stem moves less than the recording's gain does (#1495).
  A track with no volume envelope, gate, mute, or Bleed Restore gets that evidence by
  evaluating its `Audio` tree in memory (`engines/audio_eval.py`): the tree compiles to pieces
  that read any sample range, sources are decoded once to a temp file at their own rate
  (`engines/decoded_source.py`), and the result streams through one ffmpeg resample to 8 kHz, as
  decoding the render's wav does. A cut between 8 kHz samples therefore lands where the render
  puts it (equal samples to 1e-3, same length, at 48 kHz and 44.1 kHz), and a 50-minute track
  costs about 100 MB beyond its 87 MB result. A track whose sources differ in rate or channel
  count, or any other track, keeps the ffmpeg render (#1943).
  Its levels are compared on a voice scale: each track's levels and floors lose one fixed
  offset, its own voice level (`LevelProfile.path_reference_db`), so every mic's own speaker
  sits at 0 dB. Raw levels cannot be compared across mics (a call recording can carry a
  speaker 12 dB hotter than that speaker's own quiet mic), and a balance gain
  (`Track.gain_db`) is a listening choice. The offset is a constant of the recording, not a
  gain on the audio, and it moves with the file's gain.
  Level cannot say who is speaking where two mics hear one sound at a fixed ratio (a call
  recording and the host's room mic on the same pair), so a mic is a bleed source for a
  track's words only on its leak direction: when the reverse path rests on at least
  `ONE_WAY_RATIO` (50) times its consistent frames (frames count talk time as well as leak strength, so the ratio is set above any plausible split of the talking) (`TrackRmsCacheSet.leak_paths`), the
  quiet side's path is only the echo of the same moments and judges no word.
- Digital silence (`util.dsp.DIGITAL_SILENCE_DB`) reads the same at any gain.

The bleed path's offsets were dBFS levels set on the lab tape, whose tracks' median voice
level is -15.3 dBFS. Each offset is that level's distance under it, to the dB, so the lab
tape reads as before:

| Level | Was (dBFS) | Now (dB under the track's voice) |
| --- | --- | --- |
| Envelope floor (`envelope_lag.LEVEL_FLOOR_DB`) | -90 | 75 |
| Track open (`PEER_OPEN_DB`, was also `bleed_latency.OPEN_DB`) | -60 | 45 |
| Gate owner floor (`bleed_gate._OWNER_FLOOR_UNDER_VOICE_DB`) | -80 | 65 |
| Echo source speaking (`EchoConfig.source_under_voice_db`) | -40 | 25 |
| Echo mic open (`EchoConfig.open_under_voice_db`) | -60 | 45 |
| Gate overreach, word judged / lost | -60 / -80 | 45 / 65 |
| Analyze noise floor warning | -50 | 35 |
| Join onset collision (`join_continuity._ONSET_UNDER_VOICE_DB`), ramp from 5 dB over it | -50 | 35 |

`scripts/check_level_literals.py` (run by `make lint-py` and `tests/test_level_literals.py`)
fails on two kinds of absolute level in `edits/` or `engines/`: a negative dB literal, and a
linear amplitude between `1e-6` and `1` that is compared or bound to a level name (an
`rms_threshold`, a `min_rms`). A name that says what the level is relative
to (`*_over_floor_db`, `*_under_voice_db`, `*_power_ratio`) passes, and that is by design:
the lint reads names, so a relative name over an absolute number is a review matter. The
allowlist holds physical constants only: the clipping ceiling (`CLIPPING_PEAK_LEVEL_DB`,
`CLIPPING_MIN_PEAK_DB`). "Is this silent" guards read `DIGITAL_SILENCE_RMS` (`util/dsp.py`), the level below which a
signal holds no audio at all. Long-delay bleed evidence compares a peer stretch to the window
it is matched to (`LongDelayConfig.min_power_ratio`). The ingest gates (`vad_speech_intervals`, the
acoustic-window `min_rms`) keep fixed thresholds on purpose and are listed in `ALLOWED`. On Daniela's quiet track no
gate relative to the file's level (voice reach, or speech minus 3 to 21 dB) kept her words
without admitting up to 40 s of audio with no word under it, and the offsets that held the Zoom
lab tracks within 1.3% of the fixed gate did not help her; a level gate cannot tell a quiet
mic's voice from another speaker's leakage. The replacement is to drop the other speaker's
copy before gating (the leak paths of #1548), not a better level (sweep: #1533, window 60-150 s on Daniela's tracks and the lab Zoom tracks).
Ingest no longer estimates the session start from speech onsets (#1533): two speakers'
first words are not one event, and a level that follows the audio read a later speaker as a
late recorder (+36 to +48 s on aligned lab tracks).
The ffmpeg filter graph and the delivery loudness targets set render levels, not detection thresholds, and are not scanned.
`tests/test_tighten_gain_invariance.py` is the one contract: tighten, reconcile, the bleed
gate, Analyze, the ASR silence filter, the speaker split and long-delay bleed evidence each decide the same at 0, -12 and -24 dB, and
(for the project-level detectors) with one track alone 24 dB down. Tighten proposal clocks and skip counts must also match when one dialogue track alone is 12 dB quieter (#1529); the speech-energy guard keeps each contrast mic on ``path_reference_db`` when it sits within the residue band plus 12 dB headroom, instead of treating that quieter dialogue recording as bleed residue. Tracks far below that band stay residue (read as recorded).

Known limits:

- Comparisons between two tracks still add back `path_reference_db` for reported copy
  level (`level_db`) and word-level loudness. Pair discovery does not: `echo_risk_pairs`
  selects frames from per-track voice floors, and a voice-normalized dominance mask when
  enough co-open frames pass it. After the null test it drops a co-open fallback reverse
  when the other direction holds; the quieter-source fallback stays when it is the only
  risk; both-ways voice-dom and both-ways fallback stay. Unequal per-track gain no longer
  inverts the true pair (#1376). `audition_context_tool` (`echo_profiles`) does not apply
  that drop.

- A 16-bit recording made quieter loses the frames under one quantization step to digital
  silence, so its room reads differently and pause trims that cut only air can move. That
  is the recording, not the levels: the same audio scaled in floating point decides the
  same.

## High-bleed warning

The full cleanup report shares decoded processed-stem RMS caches across its
audibility, gate, and boundary analyses; each standalone analysis can still
build its own cache.

The audibility and low-audibility scans judge a word against its own track's voice floor (`LevelProfile.voice_floor_db`, the figure tighten reads; [§ Detection levels](#detection-levels)), so a quieter copy of a recording gets the same verdicts; the report's `threshold_db` is that track's floor ([transcript-reconcile.md](transcript-reconcile.md), #1324). Reconcile's **`inaudible`** verdict alone compares speech-band level to a speech-band floor (`SPEECH_BAND`, same high-pass as pause trims) so low-band HVAC and rumble do not raise the broadband room and call whispered speech inaudible (#1377). Bleed dominance and reported `track_rms_db` stay full-band.

`analyze_cleanup` computes `bleed_ratio` (bleed word count / total words) per track. When
it meets or exceeds `analysis.heuristics.bleed_ratio_warn_threshold` (default `0.2`, i.e.
20%), the track gets a `high_bleed_warning` message and the summary line reads `HIGH
BLEED (N% of words)`. This is a strong, evidence-based signal that a session has genuine
multi-mic bleed rather than isolated crosstalk — transcript suppression (`reconcile`)
only fixes text attribution, the wrong-mic audio is still audible in the mix. See
[podcast-mute-bleed](../.agents/skills/podcast-mute-bleed/SKILL.md) to gate it out
acoustically. If flagged bleed words are *louder* on the off-mic track than the direct
mic (compare the as-recorded levels of the two tracks; `audibility_map_tool` rows are on the voice scale, so `own_rms_db` and `track_rms_db` read dB over each track's own voice level, not dBFS),
that also points at a mic gain-staging or placement problem worth flagging for future
recordings — no amount of post-processing removes that at the source.

## Mains hum detector (`detect_mains_hum`)

FFT-based narrowband energy ratio at 50Hz/60Hz plus the first few harmonics, versus
total broadband energy. Returns `hum_detected`, the `dominant_frequency` bucket, and a
plain-language `recommendation` (add a notch, or raise the highpass cutoff) when the
ratio crosses `threshold_ratio` (default `0.05`).

## Premix gain staging and headroom

The premix (`mix_with_music`) sums tracks at **unity** (`amix normalize=0`, the same as
`timeline_render`'s overlaps), not the 1/N of amix's default. With two dialogue tracks
staged to -20 LUFS the sum lands near -17 LUFS, where the old 1/N mix sat near -23. That
1/N sum put the #518 lab premix at about -31 LUFS and made the master add about 16 dB
into the limiter.

`FFmpegEngine.mix_tracks(..., peak_ceiling_db=...)` measures the unity sum's true peak on
the float amix graph (`ebur128=peak=true` into a null output, no temp file), then renders
once with the whole mix trimmed down (never up) so it peaks at or below
`mix.premix_peak_ceiling_db` (default -1.0 dBTP). `bounce` shares the ceiling.
The trim uses the last emitted true-peak summary, which describes the completed graph.
FFmpeg can emit an initial empty summary before it processes the audio.
A mix longer than two minutes is measured in up to eight spans in parallel
(`engines/mix_spans.quiet_spans`). The meter's resampler starts and ends each span without the
audio on the other side, so neighbouring spans share one 100 ms block at least 24 dB under the
ceiling, found within 5 s of an even split. Every sample is measured with its real neighbours in
some span, and the cut edges are too quiet to set the peak, so the loudest span equals the
single-pass peak. With no such block near a split, that split is dropped; a mix with no pauses
is measured in one pass.
`play_compose` uses the same ceiling on its own window, so a hot window is trimmed rather
than clipped; a window that peaks under the ceiling plays at unity, the same as the premix
before its whole-mix trim. `tests/audition_eval.py::inject_hum_span` sums at unity on purpose (see
its docstring).

`MIX_SEMANTICS_REV` is part of `mix_render_hash` and composed-play cache keys.
The completed-summary fix advances it to revision 3, so revision 2 premixes and
composed playback rebuild. Per-track stems remain reusable.

The ceiling is part of the hash too, so a pipeline run with a different `mix.premix_peak_ceiling_db` re-mixes. `premix.hash` also records the ceiling on its own line, then the trim the whole mix got. A window mixed from segments measures only its own peak, so both pending preview sides mix at the trim the whole mix gets (`PlayService.mix_trim_db`): the recorded one while the premix is fresh, otherwise one measured from the current stems with the same `peak_trim_db`. A fader or mute change re-measures the peak; it never re-mixes the premix. Render status and review publish have no run config, so they compare the premix against the ceiling it was mixed under. A volume, mute, or mix-rule change makes that hash stale. A changed stem for any included track also makes the premix stale, including music, intro, outro, and sound effects. A muted track is excluded until it is unmuted.

`check_loudness_tool` measures the existing exported WAV, or `premix.wav` when no exported WAV exists. Its `pass` field judges measured loudness. Its separate `stale` and `stale_reason` fields report known render age without rendering. For a premix, the check uses its hash and included stems. For an exported WAV, it also checks the current master hash and whether the export predates the master. Missing or unverified upstream artifacts report stale. An explicit unrelated audio path has `stale: null` and `stale_reason: "untracked_audio"`. `stale: false` means these checks found no known mismatch; timestamps cannot prove the export's content came from the current master. The check does not refresh audio or alter the loudness verdict.

## Dialogue gain staging (`balance_tracks`)

`balance_tracks` runs after `compress_tracks`. It measures each dialogue track through its
own processing chain (`measure_loudness_blocks`: one ffmpeg pass with `ebur128=framelog=info`,
which prints the 400 ms momentary loudness every 100 ms; those are the BS.1770 gating
blocks). [`util/loudness.py`](../src/podcast_mcp/util/loudness.py) keeps the blocks whose
window centre falls inside the track's own non-suppressed transcript words that its clips
keep on the timeline (words in material focus/tighten cut don't count), then applies the
-70 LUFS absolute and -10 LU relative gates. Bleed and silence therefore don't count. With no
transcript or under 3 s of speech it falls back to ungated BS.1770 and reports `ungated`.
`gain_db = target - measured`; `gain_db` is applied only in the mix, never baked into stems.
A track whose loudness can't be measured (ffmpeg error, no momentary blocks), or whose clips keep none of its words, keeps its
`gain_db` and is listed as `not measured, gain kept` in the summary. Gains are applied only
after every track is measured, so a cancel changes nothing. `gain_db` reflects the FX chain
at measurement time. The track stores a `balance_basis` record with the measured LUFS,
whether speech gating succeeded, and a digest of the media file revision, ordered FX chain,
exact kept speech intervals, and measurement semantics revision. Render status reports the
flag as unknown before the first successful measurement, false when the basis still matches,
and true when it differs. Re-run `balance_tracks` after changing those inputs. The flag does
not compare the requested LUFS target because a target supplied only for one run is not
persisted. `check_loudness_tool` includes the same per-dialogue-track state in its `balance`
map when it measures tracked project audio, so an agent can spot a stale balance while
checking a premix or export.

## Mastering plan + mastering QC

`FFmpegEngine.master_loudness` measures the premix once, picks a plan from that
measurement, and renders the plan:

1. **Pass 1** (`loudnorm_input_stats`) is one `ebur128` pass that reads the premix's
   integrated loudness, true peak, loudness range and gate threshold. It replaces a
   loudnorm measure pass, which resamples to 192 kHz and dominated the step's wall time.
   `target_offset` is passed as 0: loudnorm only uses it in dynamic mode.
2. **Plan** (`engines/mastering.py::plan_master`). Reaching the target takes a static gain
   of `master.integrated_lufs - input_i`. When `input_tp` plus that gain stays at or under
   `master.true_peak_db`, the plan is **loudnorm**. Otherwise it is **limit**: linear
   loudnorm cannot reach the target under the ceiling, and its dynamic fallback
   under-shoots on peaky premixes (the demo premix, −21.1 LUFS / −1.0 dBTP, mastered to
   −17.2 LUFS that way). The plan is decided from the measured stats before any render.
   Unusable stats keep single-pass loudnorm (`LoudnormPlan(two_pass=False)`, no
   `measured_*` values): missing stats, an integrated loudness at the −70 LUFS gating
   floor, or a premix shorter than the 400 ms gate (`LOUDNESS_GATE_SEC`). Those would plan
   a gain of tens of dB.
3. **Loudnorm plan.** `loudnorm` with `linear=true` and the pass-1 values fed back in
   (`measured_I`, `measured_TP`, `measured_LRA`, `measured_thresh`, `offset`) and
   `print_format=json`. This is the same command as before the limiter plan existed, so
   such a premix masters byte for byte as it did. loudnorm still falls back to
   **dynamic** mode when the LRA exceeds `master.lra` (or the measured LRA is 0); the
   printed `normalization_type` (`linear` / `dynamic`) says which ran. This produces a
   static (non-pumping) gain instead of single-pass `loudnorm`'s frame-by-frame
   correction, and lands within a few tenths of a LU of the target.
4. **Limit plan.** The planned gain, then `alimiter` at `true_peak_db - 0.5` dB
   (`LIMITER_MARGIN_DB`), then a gain trim onto the target:
   - `alimiter` limits sample peaks, so it runs on 4x-oversampled audio (`aresample` up,
     limit, back down), where sample peaks track `ebur128`'s true peak. `level=disabled`
     stops it normalizing back up to 0 dBFS; `latency=1` removes its lookahead delay so
     the master stays sample-aligned with the premix. Attack is 5 ms, release 50 ms.
   - Limiting lowers the integrated loudness. `ebur128` measures the limited render. The
     trim can make up the shortfall only within the true-peak headroom left under the
     ceiling (at most the 0.5 dB margin). A larger shortfall is added to the gain into
     the limiter and the limiter runs again, at most three renders
     (`LIMITER_MAX_RENDERS`). Then the trim is applied: the measured shortfall, capped at
     the measured headroom, so the final true peak stays under the ceiling. `ebur128`
     prints the true peak to one decimal, so the headroom is cut by half that
     (`TRUE_PEAK_PRINT_ROUNDING_DB`, 0.05 dB); a 192 kHz re-measure then stays at or under
     the ceiling.
   - If the third render still leaves a shortfall the headroom cannot cover, `converged`
     is `false` and the QC issue says the limiter did not converge (dense clicks every
     ~10 ms are the pathological case: each re-drive only limits harder).
   - The demo premix took two renders: +5.9 dB into the limiter, 6.9 dB of peak gain
     reduction, 1.1 LU of loudness reduction, +0.3 dB trim, and mastered to −16.0 LUFS /
     −1.7 dBTP. The lab recording (−20.0 LUFS / −1.0 dBTP) took one render: +4.0 dB,
     5.0 dB of peak reduction, no loudness reduction, −16.0 LUFS / −2.0 dBTP.
5. **Delivery rate.** FFmpeg's loudnorm upsamples to 192 kHz for true-peak work, and the
   limiter oversamples. Both plans write `-ar`/`-ac` matching the premix (or an explicit
   override), so mastered and export WAVs stay at podcast rates (e.g. 44.1/48 kHz).

Pass 1 and the renders run with `-progress pipe:1` and share one `master_loudnorm` child
bar in media seconds: pass 1 fills the first half and the first render the second; a
re-drive or trim render holds the bar full. Both use the one input probe for their
length. The post-master QC measure reports on a `master_qc_measure` child.

Loosen `master.true_peak_db` (e.g. `-1.0`) only when you intentionally accept hotter
peaks. If the premix LRA (`premix_input.input_lra`) exceeds `master.lra` (default `11`)
and the plan is loudnorm, loudnorm masters dynamically; raise `master.lra` toward the
measured range or compress first.

After mastering, the `master_loudness` pipeline step re-measures the output
(`measure_loudness_full`, via `ebur128`+`astats`) and writes `artifacts/master_qc.json`:

```json
{
  "target_integrated_lufs": -16.0,
  "target_true_peak_db": -1.5,
  "measured": {"integrated_lufs": -16.0, "true_peak_db": -1.7, "lra": 7.9, "integrated_threshold_lufs": -26.9},
  "within_tolerance": true,
  "issues": [],
  "premix_input": {"input_i": -21.1, "input_tp": -1.0, "input_lra": 7.0, "input_thresh": -32.0, "target_offset": 0.0},
  "plan": "limit",
  "normalization_type": null,
  "limiter": {
    "gain_db": 5.1,
    "drive_db": 5.9,
    "limit_db": -2.0,
    "renders": 2,
    "converged": true,
    "trim_db": 0.3,
    "peak_reduction_db": 6.9,
    "loudness_reduction_lu": 1.1
  }
}
```

- `premix_input` is the premix's own pass-1 stats (`null` when ebur128 could not measure
  them and loudnorm ran single-pass).
- `plan` is `loudnorm` or `limit`.
- `normalization_type` is loudnorm's own report for the loudnorm plan: `"dynamic"` means
  loudnorm could not apply one static gain within the LRA limit, so it compressed
  dynamically. It is `null` for the limit plan.
- `limiter` is `null` for the loudnorm plan. For the limit plan: `gain_db` is the planned
  gain, `drive_db` the gain into the limiter after re-drives, `limit_db` the limiter
  ceiling, `renders` the limiter renders run, `converged` whether the trim reached the
  target under the ceiling (`false` adds the issue "Limiter did not converge after 3
  renders (-17.7 LUFS, target -16.0)" in place of the generic loudness miss), `trim_db`
  the gain after it. `peak_reduction_db` is the limiter's gain
  reduction on the loudest true peak (`input_tp + drive_db` minus the limited true peak).
  `loudness_reduction_lu` is its average reduction, as the integrated loudness it took
  (`input_i + drive_db` minus the limited loudness).

Tolerances are configurable (`master.qc_lufs_tolerance_lu`, default `0.5` LU;
`master.qc_true_peak_tolerance_db`, default `0.3` dB) in
[`.agents/defaults/pipeline.yaml`](../.agents/defaults/pipeline.yaml). **Always read this
file after mastering** and surface `within_tolerance: false` to the user before export —
don't just trust that mastering ran without checking what it actually achieved.

`target_integrated_lufs` and `target_true_peak_db` are the levels that were configured
(default −16 LUFS, −1.5 dBTP; the Pipeline tab's *Master LUFS* and *True peak*), so a
reader can tell which level a master was made for. `PipelineService.export_audio` returns
them with the written files (`AudioExportResult.master`, the `master` key of the MCP
`export_audio_tool` JSON, the CLI `export-audio` JSON and the Studio export job's
`result`).

### Decision: Master levels are user-configurable

<!-- decision
id: D-master-levels-configurable
status: accepted
date: 2026-10-06
decided-by: calebn
evidence:
- #1007 owner requirement: "The final master levels must be user-configurable, with the sensible defaults we picked"
- #1008 owner listening on loudness-matched lab and demo clips: limiter master slightly preferred; "The default target stays −16 LUFS"
- #1008: the crest-taming retry it replaced left the demo at −17.2 LUFS; the limiter plan gives −16.0 LUFS / −1.7 dBTP
- #1009 retarget table: −19 LUFS staged re-masters to −19.0, back to −16 re-masters, unchanged settings hit the cache
enforced-by:
- tests/test_master_retarget.py::test_a_changed_loudness_target_re_masters_the_next_export
- tests/test_master_retarget.py::test_each_audio_setting_of_the_master_re_masters_a_cached_master
- tests/test_mastering.py::test_plan_master_limits_only_when_linear_gain_crosses_the_ceiling
- tests/test_pipeline_config.py::test_param_field_default_matches_yaml
- docs-sync: decision-mastering
-->

The host sets the master's integrated loudness and true-peak ceiling on the
Pipeline tab (`master.integrated_lufs`, `master.true_peak_db`). The defaults
are −16 LUFS and −1.5 dBTP. A changed level re-masters on the next export.

### Mastering cache

`mastered.wav` is reused on export while `mastered.hash` still matches
`play_audit.master_fingerprint(project, MasterTarget)`: the premix (`master_source_hash`)
plus the settings that change the audio, `master.integrated_lufs`, `master.true_peak_db`
and `master.lra` (`engines/mastering.py::MasterTarget`). Changing any of them re-masters
on the next export; leaving them alone reuses the file (no re-render). The QC tolerances
only judge the result, so they stay out of the fingerprint: when they change,
`ensure_current_master` re-derives `issues` / `within_tolerance` from the stored
measurement and rewrites `master_qc.json` without mastering again.

An export reads `master.*` from the same config a pipeline run would: the Pipeline tab's
staged working set when one was staged (see [pipeline.md § Configurable
run](pipeline.md#configurable-run-gui--mcp)), else the shipped defaults. The hash records
the settings the master was made at, so callers with no run config (review publish)
judge only the premix.

`export_deliverables` goes one step further and writes `artifacts/export_qc.json`,
rolling up `master_qc.json`'s issues **plus** transcript reconciliation staleness
(`engines/reconciliation_state.py::reconciliation_status`) into one `ok`/`issues` gate —
see [podcast-master-export](../.agents/skills/podcast-master-export/SKILL.md#final-ship-gate-export_qcjson)
for the exact shape and what to do when `ok` is `false`.

## Gate fill (`fill_gate_holes`)

Zoom records each participant through a noise gate, and so do many other conferencing
recorders. Between words the gate drops the track to exact digital zero. Where every
track is gated at once the mix falls to dead air. Where one gate dips mid-phrase, the
voice seems to cut in and out. Editors fill those holes with matched room tone so the
noise floor stays continuous. The `fill_gate_holes` pipeline step does that
(`engines/gate_fill.py`, #1111).

**Holes come from the media, not from our edits.** A hole is a run, on every channel, of
samples below half a 16-bit step (−96 dBFS). It is at least 20 ms long, holds an exact
zero, and has live audio on both sides. No microphone and converter hold exact zero for
20 ms, but a gate does. A lossy codec leaves sub-LSB residue at the gate's edges, and the
run takes it in. Silence before the track's first sound or after its last is a late
joiner or padding, not a gate closing between words, so it is never filled. Our own
mutes, cuts and pads are not in the media, so they are never holes.

**Fill sources**, tried in order:

1. the track's recorded room-tone bed (`track.room_tone`, registered, audible and clean: a bed with speech in it fails the same level and voice rows as an own-audio sample, against its own floor, and the fill moves on to comfort noise, #1216), tiled;
2. comfort noise matched to the track's own noise under its speech;
3. never another track. Bleed is never the main audio (#945). No source reads a peer.

A track whose noise is not a floor stays silent. That means a measured noise less than
30 dB under its own speech level (the room-tone sampler's rule), or nothing to measure:
no pauses of its own and no steady hold before its gate closes.

**Comfort noise** follows telephony comfort-noise generation (CNG). The step measures
the noise the track carries under its own speech, then synthesises Gaussian noise with
that power spectrum. It reads that noise from one of two places, in order:

1. **The gate's hold.** The step reads what the gate holds open before each closure,
   after the voice fell below its threshold. A telephony encoder sends its SID frames from
   the same hangover. Closures within half a second of the voice are read whether or not
   the track has pauses of its own.
2. **The track's own room**, when no hold is measured. Some gates stay open through
   whole pauses and close long after the voice, so no closure has the voice within reach.
   The step then uses the quiet runs the room-tone sampler finds (`engines/room_tone.py`,
   #1054): stretches within 10 dB of the track's floor, trimmed 150 ms from speech and
   digital silence. It needs at least 1 s of them.

**DC is never room.** A decoder can leave the open gate's audio off zero while the closed
gate is exact zero. Zoom's decoded tracks sit 6 to 8 LSB under zero (−72 to −74 dBFS), and
the offset falls toward half an LSB as the gate releases. Counted as noise, that offset
put the third draft's fill 6 to 9 dB over each lab track's room, and synthesised as noise
it became rumble under 100 Hz. So every frame and every block is measured with its own mean
removed, per channel, and the fill carries nothing under 20 Hz.

**Digital residue is never room.** A closed gate rounds a near-zero signal to ±1 LSB
before its exact zero. Zoom's does this for 20 to 37 ms before every closure, and its gate
also dips to that residue while open. A sample within 2 steps of the media's
quantization is residue. The step reads that step as the smallest nonzero sample in the
media. Each closure starts at the last sample above the residue, and a frame or block of
nothing but residue is skipped. A closure with less than one complete 5 ms block
above the residue contributes no measurement. Other measurable closures still
contribute, and an unmeasurable hold falls through to the track's own room or the
existing "no noise measured under its speech" reason. Float and lossy media have
no such step, so nothing in them counts as residue.

The hold is measured per track, never assumed. The step takes the median level of each
5 ms block going back from every closure (up to 0.5 s, and only as far as 8 closures
reach), each block's DC removed. While the gate holds open on the floor that level stays
put. Where the voice's tail begins it rises. The hold is the longest *steady run* in that
profile:

- every block within 3 dB of the quietest block so far;
- rising at most 40 dB/s (least-squares) across it. A reverberant tail decays 60 dB per
  RT60, so in a room under 1.5 s it rises faster;
- at least 15 ms long, because fewer blocks give no slope to judge;
- the voice back at least 10 dB above it further from the closure.

The blocks between the run and the closure are the gate's release: a ramp, or a codec's
quieter last frame (AAC leaves a shelf about 20 dB under the floor). They must all sit
under the run, and the release must be no longer than the run. A gate that closes on a
decaying tail with no hold has no steady run, so its holes stay silent rather than being
filled from the tail.

Both sources are read as Hann periodograms of every channel, averaged across channels.
Each pause or hold uses frames of about 20 ms, or one shorter frame zero-padded when a
hold is shorter. The fill is written to each channel at the level measured. A mono
downmix of Zoom's identical channels reads 3 dB over either, so the step never measures
one. The step keeps the periodograms within 3 dB of the median and averages them per
frequency bin. A word, a breath or a peer's bleed that a pause or a hold still carries
sits over that line, and a steady floor sits within it. The noise is synthesised once as
a seamless loop of at least 20 s (random phases, one inverse FFT), with nothing under
20 Hz. Each hole reads the loop at its own position on the media's clock, so no two holes
start on the same noise and the texture never repeats on a short cycle. The fill's level,
`gate_fill.level_db`, is the loop's level.

**Own audio is never touched.** The step writes one FLAC per track on the media's clock,
`artifacts/gate_fill/{track}_{digest}.flac`. It holds the fill inside each hole and
digital silence everywhere else. Inside each hole the fill fades in over its first
`gate_fill.fade_ms` (10 ms, raised cosine) and out over its last. Render sums the file
under each segment of the track's own media, before the segment's fades and mute
regions, then converts back to the media decoder's sample format. Wherever the fill is
silent, every later filter sees the samples it would see without it. Stems, play
segments and guest proxies are byte-identical outside the holes. Our mutes and
ignored-word regions silence the fill as they silence the media. Cuts drop it, and pads
have no media to fill. The fill applies only while the media keeps the size and mtime it
was measured at. A replaced recording renders without it until the step runs again.

**Undo and visibility.** The step sets `timeline.tracks[].gate_fill` (source, file, holes,
seconds filled, fill level, the measured noise under speech, fade). Undo of
`after fill_gate_holes` restores the previous fill, and the render hash follows it. The
step summary reports each track: holes, seconds filled, source and level, and the
pauses or gate holds the noise was read from, or why it was left silent.
`gate_fill.mode: off` clears every fill.

**Not covered.** A tighten mute whose `filler_pad_mode: room_tone` finds no room tone
still renders digital silence. It is our own edit, and its fill is decided by its own
setting. A bleed-gate mute (`transcript_gate`) has its own fill, [below](#bleed-mute-fill). A hold under 15 ms is
unmeasured, so those holes stay silent, as do AAC holds shorter than about one codec frame.
A 20 ms hold sits at the profile's resolution. Over few closures its three or four blocks
scatter as much as a slow tail rises, so the steady-run rule rejects it on some tracks
and its holes stay silent: 12 to 18 of 21 seeds measure it with 9 closures, and 19 to 20
of 21 with 39. A 30 ms hold is measured on every seed. A peer's bleed that fills most of
every hold raises the median the holds are judged against, so it is read as part of the
room. The credibility rule compares the noise with the room-tone sampler's speech level,
which is read on a mono downmix, so on identical channels the rule's margin is 27 dB
rather than 30. The sampler also picks the quiet runs the fallback reads on its own
levels, which keep the DC offset; the fill reads their spectrum with DC removed. The
render reads the fill through the same `MediaSeek` as its media (#1141), so on AAC
(`.m4a`) media too the fill lands on the samples of the exact decode it was placed on;
`test_fill_never_overlaps_speech_in_a_multi_source_render[m4a]` pins it.

### Bleed mute fill

A bleed-gate mute (`bleed_handling` resolving to `mute`, #945) sets the lane's gain to zero
over each foreign copy. On a lane whose own room is not digital silence that is a gate to the
ear: the room drops out whenever the other speaker talks (#1734). The gate plan therefore
carries a fill, `BleedGatePlan.fill`, and everywhere the plan's gain is applied the muted span
takes `noise x (1 - gain)`. The fill ramps in as the mute ramps out over the same 20 ms, so
the two always sum to the room.

**Sources**, tried in order, all the lane's own (`engines/bleed_fill.py`, `engines/gate_fill.py`):

1. the lane's recorded room-tone bed (`track.room_tone`);
2. comfort noise read from the stretches the plan found to hold neither a foreign copy nor
   the lane's own voice, trimmed 150 ms from each end. A copy that fills the lane's pauses
   is never read as its room, and the plan, not the audio, says where the copies are. It
   needs 1 s of them with live audio;
3. the recorder-gate fill's comfort noise (the gate's hold, else the track's own pauses),
   for a lane that is gated so hard it has no live quiet stretch.

No source reads another track (bleed is never the main audio, #945). The same credibility rule
applies as for gate holes: the noise must sit 30 dB under the lane's speech, else the span
stays digital silence and the dry run says why (`room_tone_fill_reason`). `gate_fill.mode: off`
switches this fill off with the other. An `attenuate` gate has no hole to fill and adds nothing.

**One noise, any clock.** Only the power spectrum is kept. The noise is synthesised at the rate
of the audio it is added to, as a seamless loop of at least 20 s read at `frame % length` on
the clock the gain is applied on. Stems, play segments, source proxies and export read the same
plan the same way, so any chunking of one clock lands on the same samples. A spectrum measured
at 48 kHz keeps its density at 16 kHz, with nothing above the band it was measured in.

**Bleed Restore.** A restored span is the recording's own sound again. The fill leaves as the
restore gain comes in (weight `1 - restore gain`), so a restored span carries no fill under it.

**Undo and the render hash.** The fill is a function of the plan, the lane's media and
`gate_fill.mode`; the stem hash carries a fill revision, the mode and the lane's room-tone bed, so
turning the fill off or changing how it is read renders the stem again. Undo of the bleed mute
restores the previous gate, and with it the fill.

**Not covered.** A lane with no room to read (digital silence where nobody talks) stays
silent, as before. A copy that fills every pause and every hold of a lane leaves nothing but
bleed to read, and the credibility rule then keeps the fill silent rather than letting the
copy's tails stand in for a room. The lab check (#1734) compares the muted spans with the
lane's own pauses by spectrum and level, and with and without the forced aligner.

### Evidence: comfort-noise estimators

These are one-off measurements from the first draft, on the private lab tape (three Zoom
tracks, rev 3b414c4c) and a synthetic set, not asserted by CI. They kept the decoder's DC
offset (see § Evidence: scoring harness). The prototype is under the session scratchpad.
Two kinds of truth were used:

- **Lab, real room.** Caleb's track has a real floor. Its quiet runs of at least 0.3 s
  are the truth. The estimators read his audio with those runs zeroed, as if gated.
- **Synthetic.** Harmonic syllables, 14 dB direct-to-reverb, pink noise plus hum, and a
  Zoom-like gate. There are six cases: noise −60 to −80 dBFS, gate 15 to 32 dB over the
  noise, hold 40 to 150 ms.

| Estimator | Lab, real room: mean band error | Synthetic: mean band error over 6 cases | Lab Audra / Lana estimate |
| --- | --- | --- | --- |
| Quietest 10% of open frames | 1.2 dB | 18.7 dB | −84.7 / −81.7 dBFS |
| Minimum statistics (Martin 2001) | 4.3 dB | 11.6 dB | −74.9 / −72.2 dBFS |
| Hangover, median ÷ ln 2 | 6.1 dB | 12.3 dB | −80.3 / −78.7 dBFS |
| Hangover, quieter half of a fixed 120 ms (first draft) | 3.0 dB | 13.8 dB | −86.3 / −86.6 dBFS |
| Per-bin minimum of minimum statistics and quieter-half hangover | 5.2 dB | 10.6 dB | ≈ hangover |

Every estimator runs high when the gate threshold sits far over the noise or the hold is
short, because reverb and word tails fill its frames. The 30 dB credibility rule is the
backstop there. Minimum statistics reads 10 to 14 dB above the hangover on the gated lab
tracks. In the product, with fixed ~0.26 s blocks, it read −56 to −62 dBFS. The per-bin
minimum then always took the hangover (equal to 0.1 dB on all three tracks), so it was
removed. The quietest-tenth estimate only works where pauses make up a tenth of the open
audio, and it reads 17 to 32 dB high when the gate holds briefly. By ear, clip 4 of the
#1111 listening set plays the first-draft fill against minimum statistics on Audra's stem.

### Evidence: scoring harness

Three drafts changed how the hold was found, but their errors came from what they
measured. The second draft read the closed gate's residue. The third counted the decoder's
DC offset as noise. A one-off harness (`scratchpad/p1111r4/harness.py` in the #1111
session, not asserted by CI) scores every estimator against each track's true floor:

- **One analyzer.** Truth and fill are read the same way: DC removed, Hann frames of about
  85 ms, per channel. Bands are 20 to 100 Hz, 100 to 250 Hz, 250 Hz to 1 kHz, 1 to 4 kHz,
  4 to 8 kHz and 8 to 16 kHz, plus everything from 20 Hz up. Each estimate is scored as the
  loop the step would write.
- **Lab truth.** The track's quiet open audio. These are 20 ms frames at least 100 ms from
  a closed gate and 0.3 s from the track's own words, within 3 dB of the quietest quarter
  of such frames, in runs of at least 100 ms. That gives 78.6 s on Caleb, 23.7 s on Audra
  and 32.5 s on Lana.
- **Synthetic truth.** A pink floor at −66 or −82 dBFS under a gated 16-bit track, at 16
  and 48 kHz, with 14 phrases. The cases cover holds of 20 to 250 ms, a −8 LSB DC offset
  (constant, or falling through the hold), 25 ms of residue, and a −60 dBFS peer's bleed
  in the holds. They also cover a ringing room, a gate that stays open through pauses, and
  gates that close on a decaying tail with no hold.
- **Pass.** Within 2 dB from 20 Hz up, and within 3 dB in every band.

Each cell gives the error from 20 Hz up, then the worst band's error, in dB:

| Estimator | Caleb | Audra | Lana | Synthetic fills in tolerance |
| --- | --- | --- | --- | --- |
| First draft: fixed 120 ms, quieter half, mono downmix, DC kept | +1.6 / +3.6 | −1.7 / −3.7 | −2.8 / −4.6 | 11 of 44 |
| First draft over the measured hold, DC removed | −1.9 / −2.9 | −0.8 / +1.9 | −1.9 / −2.8 | 32 of 42 |
| Third draft: own room, else hold; within 10 dB of the median; DC kept | +7.9 / +8.7 | +9.4 / +12.4 | +6.1 / +9.5 | 34 of 46 |
| Third draft, DC removed | +1.5 / +4.9 | +1.9 / +5.3 | +0.5 / +3.5 | 44 of 46 |
| Own room, else hold; within 3 dB of the median; DC removed | −1.4 / −3.3 | −0.0 / +2.8 | −1.0 / −2.1 | 46 of 46 |
| **Shipped:** hold, else own room; within 3 dB of the median; DC removed | −0.9 / −2.3 | −0.1 / +2.8 | −1.1 / −2.2 | 48 of 48 |

The shipped row runs the step's own code on the files. The other rows re-implement each
estimator in memory, which leaves the 48 kHz bleed case over a −66 dBFS floor silent.

- **DC.** Removing it takes the third draft from 6 to 9 dB high to within 2 dB from 20 Hz
  up. Its bands still sit 3.5 to 5.3 dB high above 100 Hz. Keeping everything within
  10 dB of the median lets breaths, word tails and bleed into the average.
- **The quieter half reads low.** The first draft ranked frames by total power. The band
  under 100 Hz carries about 60% of these rooms' power, and a 20 ms frame resolves it in
  two bins, so the quieter half keeps frames whose low band happened to dip. On the
  synthetic set it reads up to 7.7 dB low under 100 Hz on 20 ms holds, and 3.0 to 6.4 dB
  low in one band behind bleed or a ringing room. Keeping frames within 3 dB of the median
  keeps nearly every frame of a steady floor and still drops a word, a breath or bleed.
- **Hold first.** On Caleb, his own room (the room-tone sampler's runs) reads 3.3 dB low
  under 100 Hz and his hold is within 2.3 dB. On a track with pauses but no hold the
  room is the only source, and there it lands within 1.3 dB in every band.
- **What limits it.** The shipped fill sits 1.4 to 2.3 dB low under 100 Hz on all three
  tracks. A 20 ms frame resolves nothing between DC and 47 Hz, so the fill ramps up from
  20 Hz to its first bin while the rooms keep rising toward 20 Hz. Holding the first bin's
  level down to 20 Hz closes only 0.3 to 0.4 dB of that gap. Audra's 100 to 250 Hz band
  sits 2.8 dB over her open room. Her holds probably carry word tails or bleed there (a
  guess, not measured).

On the synthetic set the shipped fill lands within −0.5 to +0.9 dB from 20 Hz up and
within 2.5 dB in every band, in all 48 cases it fills. The other 12 stay silent: 8 gates
that close on a decaying tail with no hold, as they should, and 4 holds of 20 ms with no
residue. On those 4 the room-tone sampler finds no speech level over the floor for the
credibility rule, under every estimator. The fill's loop holds nothing under 20 Hz by
construction.

`tests/test_gate_fill.py` pins the clean, residue, short-hold (30 ms), bleed (−82 dBFS),
ringing, 250 ms and AAC cases within 2 dB from 20 Hz up and 3 dB per band, with no DC. It
also pins a −8 LSB DC offset under a 150 ms hold, a residue tail and a short hold, a
dual-mono track and a track with pauses of its own. It pins the no-hold ringing case as
silent.

### Evidence: lab tape

The step ran on the whole lab tape in 20 s when its fills were already written, and 26 s
when it wrote them (three 28-minute tracks). The fill FLACs take 12 MB (Caleb) and 80 MB
(Audra, Lana), against 324 MB for each raw WAV.

Zoom's closures, counted on all three tracks (rev 3b414c4c, 16-bit, both channels
identical):

- Every closure leaves 20 to 37 ms (p10 to p90) of residue before its exact zero. 97% of
  those samples are −1 or 0 LSB.
- The open audio sits 8.2 (Caleb), 6.4 (Audra) and 7.3 (Lana) LSB under zero. Over the
  last 200 ms before a closure the median offset falls to about 1 to 5 LSB, and to half an LSB
  in the residue.
- With the offset removed, the median 5 ms block holds steady for 150 ms (Caleb), 215 ms
  (Audra) and 200 ms (Lana) after the residue, before the voice's tail starts.

The second draft read the residue as a 25 ms hold on every track. With the offset kept, the
third draft read holds of 140 ms and 110 ms on Audra and Lana behind 80 and 10 ms of
release.

Each track's fill against its true room, per channel, DC removed, in dBFS:

| Track | Holes (filled) | Read from | | From 20 Hz | 20–100 Hz | 100–250 Hz | 250 Hz–1 kHz | 1–4 kHz | 4–8 kHz | 8–16 kHz |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Caleb | 606 (190 s, 11.2%) | 408 holds of 150 ms | Room | −85.8 | −88.1 | −95.4 | −97.0 | −95.7 | −96.6 | −101.2 |
| | | | Fill | −86.7 | −90.4 | −94.0 | −96.6 | −95.6 | −96.7 | −101.1 |
| Audra | 1142 (1242 s, 73.5%) | 216 holds of 215 ms | Room | −87.1 | −89.1 | −96.9 | −98.7 | −97.8 | −98.3 | −103.0 |
| | | | Fill | −87.2 | −90.5 | −94.1 | −96.6 | −97.2 | −98.4 | −103.2 |
| Lana | 1024 (1238 s, 73.3%) | 234 holds of 200 ms | Room | −86.2 | −88.2 | −94.1 | −96.8 | −98.4 | −100.0 | −102.9 |
| | | | Fill | −87.2 | −90.4 | −93.4 | −96.7 | −98.6 | −100.1 | −102.9 |

Measured the same way, the first draft's fill (which the owner approved by ear) read
−84.2, −88.8 and −89.0 dBFS, and the third draft's −77.9, −77.7 and −80.1 dBFS. The
drafts reported −82.6, −87.7, −87.8 and −75.9, −76.0, −78.1 dBFS, with the DC offset
counted. The shipped fill is 2.5 dB under the first draft on Caleb and 1.6 to 1.8 dB over
it on Audra and Lana.

On the premix, the all-tracks dead air at 1660.29 to 1660.76 now sits at −85.7 dBFS
(−87.8 above 100 Hz), against −86.5 dBFS in the 150 ms before it. At 1499.65 to 1501.63 it
sits at −85.4 dBFS (−87.8 above 100 Hz), against −84.7 dBFS before it. The first draft had
those gaps at −84.1 and −83.8 dBFS. The 150 ms before each pause is mostly the gates
closing. Both A/B windows, rendered through `podcast play` with main's code and this step,
are sample-identical outside every track's holes.

## Transcript gate diagnostics

`analyze_gate_overreach` recognizes `track.transcript_gate` as well as `agate`
effects. For a transcript gate, it compares retained words' onset, body, and tail
windows in the processed stem against selected raw media on the edited timeline.
It reports added onset or tail loss and wholly missing words. Missing stems or
raw evidence produce `risk: unknown`; an enabled gate is not evidence of safety.
These measurements detect excessive attenuation, but do not prove speaker
ownership or complete speech preservation when ASR omitted a word.

Reconciliation on a gated track renders evidence with the transcript gate
disabled. Timeline edits and other effects remain active. If that evidence
cannot be rendered, reconciliation fails without falling back to gated silence.

Follow-transcript playback uses the same acoustic gate policy as stem rendering.
It applies the envelope once on the absolute timeline, so an audition window
starting inside a word does not create a new gate fade. Its returned transcript
intervals identify caption evidence, not all audio that survives the gate.

## Effect presets (source of truth)

`src/podcast_mcp/effects/presets.py::_BUILTIN_PRESETS` is the single source of
truth for effect preset definitions (`noise_reduction`, `noise_reduction_heavy`,
`noise_reduction_rnnoise`, `deess`, `gate`, `eq_presence`, `eq_clarity`,
`eq_warm`, `podcast_standard`). `get_preset` / `list_presets` /
`resolve_presets` read from there.

The `effects:` block in a pipeline defaults YAML is a **by-name overlay** on
top of the builtins, not a second place to define presets: it can add new
preset names, or override a builtin's definition, but only in a custom
`PODCAST_MCP_PIPELINE_DEFAULTS` file. Repo-tracked YAMLs
(any git-tracked YAML under `.agents/`, `config/`, `deploy/`, or `tests/fixtures/`,
listed recursively with `git ls-files`) must not redefine a builtin preset name —
`tests/test_effects_presets.py` has a parity test that enforces this and
fails CI if one drifts. The test explicitly classifies the three pipeline
defaults files (`.agents/defaults/pipeline.yaml` and the two `*_pipeline.yaml`
fixtures). A new tracked YAML with a top-level `effects:` block fails the test
until its path is classified as pipeline defaults or unrelated effects YAML;
an unrelated file is not mistaken for pipeline defaults.

`suggest_pipeline_tuning` (Analyze) resolves presets once per call
(`resolve_presets(defaults)`) and seeds its `noise_reduction` and `gate`
suggestions from them, not from reading `defaults["effects"]` directly, so its
proposed config reflects the same presets `apply_preset_to_chain` would apply.
On an `agate` gate-overreach finding it proposes `effects.gate` with the
threshold lowered by 6 dB, once per Analyze call however many tracks report
overreach (the gate chain is global): from the working set's own `effects.gate` if
present, otherwise from the resolved `gate` preset. This happens even when the
base config's `effects` has no `gate` key, which is now the default because the
repo `effects:` overlay is empty. The proposed config is a per-project working
set, not a repo-tracked defaults YAML, so carrying a `gate` entry there does
not violate the no-redefine rule above.
Transcript-gate findings instead recommend reviewing the acoustic plan and speech
boundaries. They do not introduce or adjust a noise-gate threshold. A report with
both kinds still adjusts the noise gate once for its own findings.

Analyze's `digital_silence` check streams `engines.asr_silence.peak_envelope`, a per-10 ms
peak envelope, and flags a dialogue track whose source audio is mostly digital silence
(`DIGITAL_SILENCE_VAD_FRACTION`, half) as a likely gated stem worth transcribing with VAD on.
A block is digital silence when its peak is within `DIGITAL_SILENCE_LSB` (2) quantization
steps of zero at the file's own bit depth (`digital_silence_peak`): an integer-PCM WAV's
sample width, else 24-bit, so only a gate's zeros (and a step of dither) count outside a WAV.
The threshold belongs to the file, not to a level, so the same recording at +12 to -36 dB
gives the same fraction and the same VAD decision (#1381), and a quiet ungated room never
reads as a gate. A 16-bit file whose room is itself a step or two wide (below about -90 dBFS)
is quantized to near zero, and reads as silent for that reason. The fraction needs no noise
floor, so it does not use `TrackRmsCache`; the silence filter's floor is a separate question
([transcript reconcile](transcript-reconcile.md)).

Lab evidence (2026-10-13, ingested 16-bit tracks, the same recording at five gains): the
old fixed -60 dBFS peak read Caleb (ungated) at 0.22 at +12 dB and 0.64 at -36 dB, and the
gated Audra and Lana at 0.81-0.89. The file-derived threshold reads each track at one value
at every gain: Caleb 0.11, Audra 0.73, Lana 0.73 (24-bit copies; the 16-bit originals read
0.15, 0.78 and 0.77). The stricter definition moves a gated track below the old 0.8 line, so
the VAD fraction is half.

## RNNoise noise reduction (`noise_reduction_rnnoise`)

An alternate to `afftdn` using FFmpeg's `arnndn` filter (a small recurrent-network
denoiser), often a real upgrade for room noise/HVAC hiss/fan noise that `afftdn`'s
spectral-subtraction approach handles less gracefully. Needs a one-time model fetch:

```bash
podcast bootstrap --component rnnoise   # downloads GregorR/rnnoise-models' somnolent-hogwash.rnnn
podcast edit apply-preset --project ... --track host --preset noise_reduction_rnnoise
```

`podcast doctor` reports whether the model is already bootstrapped. Override the
model path with `PODCAST_MCP_RNNOISE_MODEL`, or pass `{"model": "/path/to/x.rnnn"}`
as the effect params to use a different one of `GregorR/rnnoise-models`'s presets
(general/voice/speech × general/recording noise).

## Silero-VAD breath detection (opt-in)

`edits/breath_detect.py` defaults to a level-band heuristic to locate breath sounds
adjacent to a cut: 10 ms frames that sit at least 9.5 dB above the track's room tone
and 7–40 dB below its speech level, both read as the 10th and 90th percentiles of the
live frames in 5 s of kept audio on each side of the cut (`level_profile`,
`breath_level_band`). Nothing about the band is absolute, so a quiet −48 dBFS breath
over a −70 dBFS floor and a −26 dBFS breath under −15 dBFS speech are both in band,
while a noise-gated track with no live audio near the cut yields no band and no
breath. Setting `tighten.breath_handling.vad_backend: silero` in
[`.agents/defaults/pipeline.yaml`](../.agents/defaults/pipeline.yaml) switches to
[`engines/vad_silero.py`](../src/podcast_mcp/engines/vad_silero.py), which looks for
a breath as a *dip* in Silero VAD speech-probability (breaths are voiced-adjacent
noise: low-but-nonzero probability, distinguishable from true silence near 0 and full
speech near 1).

This has **zero extra install cost**: the ONNX model and `onnxruntime` are already
bundled inside `faster-whisper` (a core dependency, used for its own `vad_filter`
option), so there's nothing to download or declare as an optional dependency —
`podcast doctor` reports whether it is available. Falls back to
the heuristic automatically if `onnxruntime`/the model are unavailable, or if
detection is requested at a sample rate other than 16kHz (Silero's fixed contract).

The probability band (`0.05`–`0.5` in `_find_breath_in_window_silero`) is a starting
point, not a tuned constant — like the other thresholds in
[podcast-tighten-dialogue](../.agents/skills/podcast-tighten-dialogue/SKILL.md#tuning),
tune it by ear against real recordings before switching the default away from
`heuristic`.

The same sample-window classifiers reject breath-shaped acoustic gap filler
candidates. Configure `tighten.acoustic_gap_filler.vad_backend` separately; its
default remains `heuristic`. Classification is confined to each proposed run.
The level classifier compares a run with short, audible windows inside both
flanking transcript words; it abstains and leaves the run for review when
either speech reference is missing or below the active audibility floor, and
with no room-tone measurement its band is bounded by that speech level alone.
For an acoustic candidate in the heuristic breath band, 40 ms speech-pitch
probes every 10 ms also keep clearly periodic speech-like runs reviewable;
weakly periodic broadband breath-like runs may be rejected.
Silero does not require that level reference. Model lookup happens once per
classification, and model or inference failures fall back to the level heuristic.

With either backend, a run only counts as a breath when the same pitch sweep
finds no probe at or above a normalized autocorrelation peak of 0.55 over the
run and, for adjacent-cut co-removal, over everything between the run and the
cut edge, and when less than half of the 100 Hz–8 kHz energy of the run, and
separately of that gap, lies above 4 kHz (a sibilant, not a breath). The
heuristic always probes only frames that reach the band floor, and so does
Silero for adjacent-cut co-removal (#828): on the lab tape room tone 40 dB
under the speech level scores 0.6–0.8 on the same sweep, and it is not speech
to protect (#814). A breath is unvoiced noise, and a level band
or a VAD probability dip alone selects the quieter frames of ordinary speech in
a loud window. This applies to adjacent-cut breath co-removal as well as to
acoustic candidates (#798), so a cut is never extended over a voiced run; the
next quieter run in the window is tried instead. For adjacent-cut co-removal
the kept transcript words are also handed to the classifier as keep-out spans:
a frame inside one is never breath and the stretch between a run and the cut
may not touch one, because the search windows lie inside the neighbouring word
whenever a cut edge abuts it (a word the cut removes at least half of is not
kept). A run that continues a kept word on its far side without the level first
falling to the band floor is that word's decay or onset and is rejected too, so
a fricative onset under the 4 kHz split or a voiced tail whose probes stay under
0.55 cannot be co-removed; both backends scan the whole 5 s of flanking audio
for that walk through the shared `_breath_run_predicate` (#828, previously
heuristic-only). And no frame between the run and the cut may
exceed the band ceiling (speech level −7 dB): vocal fry has pulses at speech
level but scores 0.1–0.4 on the 70–350 Hz probe, so level, not pitch, is what
separates it from a breath. This ceiling and the kept-word walk apply only to
adjacent-cut co-removal, where a cut edge gives the gap and the far side their
meaning; the acoustic-gap-filler candidate path above has neither, and Silero
there still skips the level reference. Tune against real recordings by ear
before changing either default.

## Agent audition context (v2)

Default `audition_context_tool` (`detail=summary`) runs **windowed** astats/hum on
the span (same numbers as `audio_diagnostics_tool` with a window) and emits
`hum_in_window` / `clipping_in_window` in `hypotheses[]` when the window is at most
60s. Longer windows emit `dsp_unavailable` instead of a full-file FFT. It does not
attach PNGs. Windowed extract uses a fresh timeline stem or `SessionTimeline`
source mapping — never timeline seconds on raw/stale files.

Three checks make the context an agent's ears at edit boundaries (#775):

- **`speech_crosses_cut`** — for every splice whose join instant lies in the window
  (`clips_ops.splice_joins`, on every dialogue track), `edits/join_speech.py` reads
  the raw source around each clip edge (1.0 s of removed audio, 0.4 s kept) at 16 kHz,
  frames it (20 ms / 10 ms hop), calls a frame speech when it sits within 25 dB of the
  window's loud frames (95th percentile) and above -50 dBFS, bridges 30 ms dips, and
  requires the run through the edge to be periodic (`util.dsp.autocorr_peak` over
  70–350 Hz, like the acoustic-gap detector) so a cut breath is not flagged. A clip
  that starts inside such a run for at least 100 ms is a **clipped onset**; a clip
  that ends inside one is a **clipped tail**; runs shorter than 40 ms on the removed
  side are ignored, and a run that dies within 100 ms inside the clip is a remnant,
  not a phrase. Evidence: `voice_edge_source_sec`, `removed_ms`,
  `suggested_source_sec` (60 ms of air before the voice edge), kept/removed levels,
  the transcript words either side of the cut and `asr_disagrees` (no word covers
  the cut although the voice does). This is why the check works from audio energy
  and not word times: Whisper placed the lab's `Um,` 490 ms after the voice onset,
  the forced aligner 850 ms after it. `evidence.session_join` says whether every
  dialogue track has a clip edge at that instant (a ripple) or only this track (a
  punch), and `evidence.fix` is the one command that restores the audio without
  desyncing the episode: `trim_clip_edge_tool(clip_id, edge, source_sec, mode)`, with
  `mode=ripple` at a session join (every track's edge moves with it) and `mode=gap` on a
  track-local edge (only that edge moves). A ripple trim always moves every dialogue
  track, so no trim leaves one track out of step (see `clip_skew`). The other fix is
  `suggest_handoff_cut_tool` to move the cut to a silence. The suggestion is proven
  before it is offered (#1746): `edits/trim_suggestion.py` runs the same audio checks
  that `trim_clip_edge_tool` runs, on the edge as suggested and then with a little more
  air (up to 160 ms) when the check holds it, and `evidence.fix` carries the first edge
  that passes. `evidence.fix_check` says `passes` (with `nudged_ms` when the edge moved),
  `held` (no edge passes; `held` lists the check's reasons, and the meaning text says to
  listen, then apply with `override_audio_checks=true` or move the cut) or `unchecked`
  (the audio could not be read; the suggestion is the unproven voice edge).
- **`echo_risk`** — `engines/bleed_echo.py` profiles every directed pair of dialogue
  mics over up to 600 s of **fresh** timeline stems centred on the window (the audio
  the listener hears, one clock for every track). Each stem is read at its own voice
  level (`LevelProfile.voice_gain`). In 50 ms frames where speaker A is within 25 dB of
  its voice level and mic B is open (within 45 dB of its own; on the lab tape, whose median
  voice level is −15.3 dBFS, about -40 and -60 dBFS), the
  normalised cross-correlation peak over ±40 ms marks B as carrying a copy of A when
  it reaches 0.25. When enough of those co-open frames also have A at least 6 dB louder
  on the voice-normalized levels, only that quieter-bleed subset scores; otherwise every
  co-open frame scores. Observation and each null shift use that same frame population.
  The copies' lags are clustered in half-millisecond bins and the
  copies within ±1.5 ms of the most common lag are the *consistent* ones. Chance
  peaks between independent voices also cluster near 0 ms (full overlap gives the
  normalised correlation its largest variance at small lags), which is where a
  same-room path sits, so every pair is scored against its own **null**: the same
  two mics with B shifted by ±7.3, ±13.1, ±23.3 and ±31.7 s (independent by
  construction), sampled on up to 400 dominated frames per shift and pooled into one
  consistent-copy rate per dominated frame. A pair is `echo_risk` when it has at
  least 20 copy frames, at least 12 consistent ones, its consistent count is
  improbable under the null (one-sided binomial tail `p_value` ≤ `null_p_max`,
  0.001, exact in log space) and its rate is at least `null_margin` (1.5×) the null,
  so a long span cannot flag a small excess. That is the test `audition_context_tool`
  uses (`echo_profiles`). `echo_risk_pairs` (reconcile) then drops a co-open fallback
  reverse when the other direction holds; the quieter-source fallback stays when it is
  the only risk; both-ways voice-dom and both-ways fallback stay.
  Measured on the lab tape: the same-room
  pair audra→caleb has p ≤ 1.4e-6 on every 600 s span of the unedited run (ratios
  2.4 to 5.9) and p = 1.2e-24 on the 220 s agent timeline; the best remote pair with
  the count floors met is caleb→lana at 100–700 s, ratio 1.83, p = 0.035; 16
  time-shifted audra/caleb controls reach at most ratio 1.92, p ≥ 0.039; six
  synthetic cases (independent harmonic voices, an open noise floor, same-pitch
  voices, delayed copies at -15 and -24 dB) all classify correctly. A stationary periodic voice correlates with itself
  at any shift, but at lags spread over its period multiples, so the null rises with
  it and the one-lag cluster is what a real acoustic path adds. Evidence carries the
  pair, `lag_ms` (positive = B lags A), `level_db` (B relative to A), the frame
  counts, `copy_rate` / `consistent_rate`, `null_copy_rate` / `null_consistent_rate`
  and `null_runs`, the thresholds, the analysed span and the strongest `examples`
  (timeline seconds); `suggested_listen` composes the pair at the first example. A
  stale or missing stem skips the pair and adds `echo_check_needs_fresh_stems` to
  `limits` (`stale_render` already says to render first). Profiles are cached
  in-process by stem `file_revision`. One summed correlation function over all
  co-open frames was measured and rejected: on the lab tape it did not separate the
  same-room pair from the remote one. Act on it by listening to the compose entry
  or reading the per-pair evidence, then gate the bleed mic to its own words
  ([podcast-mute-bleed](../.agents/skills/podcast-mute-bleed/SKILL.md)) or fix mic
  placement for the next session; never gate a track on the code alone. Reconcile
  uses that post-filtered set on its own RMS caches (`TrackRmsCacheSet.echo_pairs`, over
  `echo_risk_pairs`) to tag acoustic `bleed` at all and to pick the source mic on a
  flagged pair ([transcript-reconcile.md](transcript-reconcile.md#bleed-pairs-the-source-wins-by-lag-not-by-loudness-774));
  precorrect's cross-track sync judges only pairs it flags.
  `lag_ms` is the acoustic path inside ±40 ms; where the bleed mic's ASR copy lands
  relative to the source's own words is a separate, transcript-side lag, −150 ms on
  the lab tape because the co-host's stream reaches the recording host over the
  network after her voice reached his mic.
- **`clip_skew`** — `clip_skew.pairs[]` has always carried `source_delta_sec` (the
  two tracks' source clocks at the window mid); that alone is not desync, because
  tracks aligned with different offsets differ by design and a track-local punch
  keeps later clips in place. Each track's shift at mid (timeline minus source) is
  now compared with its own first clip's shift (its alignment); a session ripple
  moves every track alike and a punch moves none, so a pair whose shifts moved apart
  by more than `skew_warn_sec` (50 ms) was rippled on one track only. Such a pair is
  `skewed`, with `skew_sec`, a `clip_skew.warnings[]` line and a `clip_skew`
  hypothesis (`history_undo`, or a `trim_clip_edge_tool` ripple trim of the join).

`util.dsp.autocorr_peak(..., interior=True)` counts only a lag where the correlation is a
true local maximum. Low-frequency room noise has a correlation that only falls, so its
strongest value sits on the shortest lag and reads as a high voice; a periodic signal has
a real peak. The peer speech guard uses it (`voiced_runs.carries_speech_pitch`) to tell a
peer's quiet room from a remark when the owner's bleed fills its reference
([filler-cut-quality.md § Peer speech guard](filler-cut-quality.md#peer-speech-guard));
the default stays unchanged for the voiced runs tighten reads.

`clipping_in_window` ignores `flat_factor` below a -20 dBFS peak
(`CLIPPING_MIN_PEAK_DB`), see [Objective health stats](#objective-health-stats-measure_astats).

The owner golden-ear harness requests this context without track DSP so its
captions and timing cannot be mistaken for measurements of a proposed cut. It
measures the two rendered A/B WAVs directly instead, with owner-only waveform
PNGs and per-side errors in `key.json`; see [filler-cut-quality.md](filler-cut-quality.md#golden-ear-protocol).

`detail=visual` windowed spectrograms are linear in time (`legend=0`) with JSON
`events[]` (`t` + plot-relative `x`). Overlay ticks use
`FFmpegEngine.annotate_time_marks` (`drawbox`; `drawtext` only when the ffmpeg
build includes it). Read the PNG paths; do not treat spectrograms as ASR.

The payload stays a briefing, not a kitchen sink: no LUFS, join scores, or per-word
bleed maps in the same JSON (call those tools; the two boundary checks above are the
exception because they are what a blind editor cannot infer from captions). No extra MOS. No stacked mix PNG (the
engine already has `render_stacked_showwavespic` for alignment audit). No
hypothetical FX graph without mutating the project. Share guests do not get
host `audition_context_tool` / `play_compose_tool` — see
[host-online-relay.md](host-online-relay.md) (`guest_audition_context` is the
review-window twin).

## Not yet implemented (see `ROADMAP.md`)

- Applying the same Silero VAD signal to the pause-floor logic in
  [`edits/tighten/`](../src/podcast_mcp/edits/tighten/) (breath detection is done;
  filler/pause detection still uses the RMS heuristic only).
- Recording MOS / non-intrusive quality scoring in `engines/audio_audit.py`
  (see `ROADMAP.md`; distinct from shipped joinqc NISQA).
- Kitchen-sink audition payload, extra MOS, hypothetical FX A/B without mutate,
  share-host context parity, and stacked mix PNGs in `audition_context` visuals.


## Retained bleed during overlapping speech

### Decision: Each track keeps only its own speaker

<!-- decision
id: D-bleed-own-speaker-only
status: accepted
date: 2026-10-06
decided-by: calebn
evidence:
- #945 owner: "Each track keeps only its own speaker." and "Bleed is never the source for another speaker's audio."
- #945 owner: alignment is the intended fix for the bleed under the speaker's own voice
- #1053 review round 1: judging own speech against the peer's track cut "your" and "thinking"; an expected-copy-level model then touched 0 of 2,393 Caleb words
- lab tape: Caleb's mic carries intentional Audra bleed, and Zoom gates each track to digital silence between words
- #1066 owner: own speech is never touched, including unvoiced own sound such as laughs, breaths and consonants; absence of evidence must never become evidence of copy
- #1066 rejected: per-frame pitch and voice gating, three rounds on the realigned lab. Round 1 cut own laughs and 21.2 s of untranscribed sound main kept; round 2 was safe but left the copy coming in and out (39 short pieces against main's 8); round 3 left copy at full level 77.3 s → 73.0 s, the owner-flagged passage at 1656.4 s −2.8 → −2.9 dB, and still took 4% of a laugh 2–3 dB over the copy that main keeps
- #1066 limit: 74% of the copy main keeps has no pitch, and its sibilants and gate ring stand up to 19 dB over what the peer's own track predicts, so by level they look like own breaths and laughs
- #1094: an own "uh-huh" 10 dB down on one stereo channel was muted, because the gate judged own versus copy on the mixdown of both channels; each channel is now judged, and a frame is turned down only where every channel reads as copy
- #1094 verifier: decoding with `-ac <count>` remixed a quad-tagged file (two channels summed, one silent), so own sound on one channel was cut again; channels are now decoded as recorded. An AAC or Opus dual-mono track decodes its channels slightly apart, which read as true stereo and moved the noise-floor reading 3 dB
- #1159: Opus at 32k, 64k and 128k decode dual-mono with a difference at the edge of a sound that reads within 7.7 dB of that quiet frame's own level, though it is 22 dB or more under the codec block's. The difference is now weighed against the loudest channel within 50 ms; the lab lanes' plans and mono signal hashes are byte-identical to main
- #1052 lab, unaligned run: judging words at the 140 ms copy lag moved 9 of Audra's words off Caleb's track and gave 8 of his back; without a timbre check 12 of his crosstalk words would have gone to her; 0 s of his words turned down; the 1656.4 s passage stays at −1.2 dB because the own-voice check, not a transcript word, keeps that copy
- #1131: the gate read 200 ms ahead before every opening of the peer's track, so own laughs in the peer's gaps lost up to 45.5%; the copy's expected level now reads ahead of each opening only as far as the lane sounds up to it, while where the copy can be keeps the full 200 ms, and synthetic laughs and breaths over the copy keep all but a burst on a loud word (at most 5.6%, against up to 45.5%)
- #1477: when half or more of a peer's gate openings arrive late on their own track, the lane reads the peer's level 90 ms further past each such opening when judging copy, so foreign syllables before the gate opens attenuate instead of reading as own sound; generality caps and `test_late_gate_on_the_direct_track_still_mutes_the_foreign_copy` (BLEED_GATE_REV 18, same change set as #1131)
- #1130 rejected: deciding per copy from the lane's level in the raised frames is circular, since own laughs sit in those frames; a host laughing four to six times brought main's trimming back
- #1131 rejected: re-reading the coupling at the measured lead cut a breath 4 dB over the copy whole and five of six laughs beside a late-opening peer; the late-opening copy it would remove (2.5 s on a synthetic peer) stays
- #1134 rejected: one lead per episode (95th percentile, skipping sound louder before an opening than after it) threw out real copy onsets and ignored late openings rarer than 5%; with 2–7 of 74 words late it left up to twice the copy at full level in twice the pieces
- #1134 rejected: the measured lead also deciding where the copy can be turned the lab lane down later after Caleb's words, holding 0.04 s more of Audra's copy level frames at full level
- #1134 lab: Audra's and Lana's lanes byte-identical to main; on Caleb's lane copy at full level, chatter and words touched (0) match main on the bare and realigned runs, main turns down 0.53 s more, and every sample whose gain changes is −62.7 dBFS or quieter
- #1134 owner: ship. Keeping own laughs and breaths whole next to a guest's gaps is worth slightly more leak when a peer's gate opens late: on synthetic peers whose track opens late on every word, or 250 ms late on several, 0.06–0.76 s more copy stays at full level per episode, in up to 5 more pieces, and copy beside a kept own sound can reach past the 40/80 ms holds; in 600 random placements no own sound was touched more than main
- #1070: a copy path needs the evidence of correlation 0.4 over 30 s (Fisher z), so a strong match is trusted from 20 s. Lab excerpts: the gate acts in 49% of 2-minute windows (main 32%) and 94% of 5-minute windows (main 87%), touching no own word; whole-episode plans are unchanged
- #1070 verifier: the level match alone passed own sound that starts and stops with the peer's (voices gated together word by word, the same cadence, laughing together) in 604 of 4,800 synthetic trials from 20 s, and main's 30 s rule 213 at 30 and 60 s; untranscribed, up to 69 s of own sound per 6 excerpts was turned down. The copy's timbre must now confirm the lag against the peer's speech 1 and 2 s away: 0 of 4,800 pass, true copies pass as before at 30 s and up, and every lab plan is unchanged
- #1070 round 2 verifier: the 20 to 30 s floor computed 0.40 at every length (`max` for `min`); corrected, the lab copy passes 17 and 49 of 100 at 20 and 25 s (32 and 51 under the dead floor) and every lab plan is unchanged. Own sound at its own pitch stays at 0 of 6,762 more trials. Own sound that follows the peer's pitch is not caught: unison singing and speech along at the peer's pitch (±0.3 semitone) pass 96 to 100 of 100 from 20 s, which main passes from 30 s (#1190). A copy of a near-monotone peer passes 25 to 34 of 100 where main passes all from 30 s; that bleed is kept. A peer silent at every near null left the check an absolute likeness of 0.15; it is now compared with the peer's speech 3 to 10 s away, pooled, and unconfirmed with none (abstaining instead would have lost every sparse-peer copy, 99 to 100 of 100). With #1134's peer that opens 180 ms late on every word the level lag read 60 ms late and the timbre there failed, leaving 22.4 s of copy at full level; the timbre is now read at the lag up to 50 ms earlier where it matches best (a gate never opens early), and under 50 frames at the copy's level nothing is confirmed (one co-timed own voice passed on 6; true copies had 90 or more)
enforced-by:
- tests/test_bleed_attenuation.py::test_late_gate_on_the_direct_track_still_mutes_the_foreign_copy
- tests/test_bleed_attenuation.py::test_track_speakers_own_speech_is_untouched
- tests/test_bleed_attenuation.py::test_quiet_untranscribed_owner_overlapping_foreign_audio_stays_audible
- tests/test_bleed_gate_generality.py::test_own_sound_over_a_voiced_copy_is_untouched
- tests/test_bleed_gate_generality.py::test_unpitched_own_sound_clearly_over_the_copy_is_untouched
- tests/test_bleed_gate_generality.py::test_own_voice_is_kept_for_other_speaker_pairs
- tests/test_bleed_gate_generality.py::test_a_laugh_is_touched_no_more_than_level_and_timbre_do_for_other_speaker_pairs
- tests/test_bleed_gate_channels.py::test_own_sound_on_one_channel_is_untouched
- tests/test_bleed_gate_channels.py::test_copy_on_every_channel_is_turned_down
- tests/test_bleed_gate_channels.py::test_own_sound_on_any_channel_of_a_tagged_layout_is_untouched
- tests/test_bleed_gate_channels.py::test_lossy_dual_mono_is_judged_once_like_wav_dual_mono
- tests/test_bleed_gate_channels.py::test_a_short_sound_on_one_channel_is_not_one_signal
- tests/test_bleed_gate_channels.py::test_identical_channels_are_judged_at_ffmpegs_mono_level
- tests/test_bleed_gate_channels.py::test_codec_noise_at_the_edge_of_a_sound_is_one_signal
- tests/test_bleed_gate_channels.py::test_lossy_stereo_with_a_short_sound_on_one_channel_is_two_signals
- tests/test_bleed_gate_channels.py::test_lossy_stereo_with_a_second_voice_on_one_channel_is_two_signals
- tests/test_reconcile_copy_lag.py::test_crosstalk_keeps_both_words_own
- tests/test_reconcile_copy_lag.py::test_a_word_at_the_peers_level_stays_own
- tests/test_bleed_gate_generality.py::test_a_host_who_laughs_again_and_again_keeps_each_laugh
- tests/test_bleed_gate_generality.py::test_a_laugh_over_the_copy_on_a_mic_with_a_noise_floor_is_untouched
- tests/test_bleed_gate_generality.py::test_laughs_beside_a_peer_whose_track_opens_late_are_kept
- tests/test_bleed_gate_generality.py::test_copy_that_leads_the_peers_track_past_the_read_ahead_is_reduced_as_before
- tests/test_bleed_gate_generality.py::test_copy_of_a_few_words_whose_track_opens_late_is_reduced_as_much_as_before
- tests/test_bleed_gate_generality.py::test_copy_beside_a_peer_whose_track_opens_late_on_every_word_leaks_no_more_than_accepted
- tests/test_bleed_gate_generality.py::test_the_lane_is_turned_down_from_200_ms_before_the_peers_track_opens
- tests/test_bleed_gate_generality.py::test_own_breaths_running_into_the_peers_openings_leave_no_more_copy
- tests/test_bleed_attenuation.py::test_own_voice_talking_with_the_peer_is_untouched
- tests/test_bleed_attenuation.py::test_short_excerpt_with_a_strong_copy_is_muted
- tests/test_reconcile_copy_lag.py::test_own_voice_starting_and_stopping_with_the_peer_is_no_copy_path
- tests/test_envelope_lag.py::test_a_short_stretch_with_a_weaker_match_than_its_floor_abstains
- tests/test_copy_timbre.py::test_own_hum_with_a_sparse_peer_at_one_pitch_is_no_copy
- tests/test_copy_timbre.py::test_no_peer_speech_to_compare_against_is_no_copy
- tests/test_copy_timbre.py::test_the_timbre_needs_half_a_second_of_copy_frames
- docs-sync: decision-bleed
supersedes: D-bleed-keep-onset-copies
-->

If a dialogue mic contains both its owner and another speaker, removing that bleed can remove the owner too. Wherever the other speaker's own track is talking and the owner is silent, the transcript gate reduces the copy, with a 40/80 ms hold around the owner's speech ([transcript reconcile](transcript-reconcile.md#acoustic-follow-up-preserve-speech-while-reducing-verified-bleed)). The copy is never used as the other speaker's audio, even where their own track's gate opened late. On a stereo or multichannel mic the owner can be on one channel only, so each channel is judged on its own and a copy is reduced only where every channel reads as copy (#1094). Where both talk at once, the owner's speech stays and the fix is alignment ([recorder latency from bleed](multitrack-ingest.md#recorder-latency-from-bleed)), not muting: the default is to preserve uncertain audio and attempt local alignment of the other speaker's complete direct phrase; the transcript-seeded planner skips copies the gate would already reduce. `apply_transcript_gate_tool` and `podcast edit apply-bleed-mute` include this check. Alignment does not move the uncertain mixed lane, ripple other material, or stretch voiced audio. Before each opening of the other speaker's track, the gate expects their copy only as far ahead as this mic was already sounding, so own laughs and breaths in their pauses stay, at the cost of slightly more of their copy where their call app opens their track late, a trade the owner accepted ([read-ahead per opening](transcript-reconcile.md#read-ahead-per-opening-1131), #1134). On the realigned lab tape 77.3 s of Audra's copy stays at full level on Caleb's mic, 16.4 s of it at her pitch (#1066). Telling that copy from own voice per frame by pitch and voice was tried in three rounds and rejected: it gained little, and the remaining copy looks like own breaths and laughs ([evidence](transcript-reconcile.md#rejected-per-frame-pitch-and-voice-1066)). Better alignment (#1089, #1090) and, later, source separation would help instead. Reconcile now judges word ownership at the copy lag (#1052), with a timbre check so a crosstalk word stays its speaker's ([transcript reconcile](transcript-reconcile.md#words-are-judged-at-the-copy-lag-1052)); on the lab tape that moved Audra's words off Caleb's track but left the 1656.4 s passage as it was.


### Superseded decision: Keep bleed that carries a late-gated onset

<!-- decision
id: D-bleed-keep-onset-copies
status: superseded
date: 2026-10-06
decided-by: calebn
evidence:
- #945: the first default kept bleed carrying a speaker's onset where their direct track was still gated
superseded-by: D-bleed-own-speaker-only
-->

The first #945 default kept a copy that carried a speaker's first syllable
while their own track's gate was still closed. The owner replaced it the same
day with the rule above and accepted the clipped onset. Alignment (#1060) later
moved the lab example, Audra's "And" at 1653.25 s, onto her own track.

### Decision: Bleed handling defaults to auto

<!-- decision
id: D-bleed-auto-mode
status: accepted
date: 2026-10-06
decided-by: calebn
evidence:
- #1053 owner listening, round 1: "All tracks still have bleed audio still slightly ahead of the speaker's main audio making an echo sound."
- #945 owner: "The quieter result was an improvement, but the echo remained."
- #1053 lab, Caleb stem 1611.40 to 1619.40 s: −36.1 to −56.2 dB, own speech at 1506.84 s unchanged
- #1053 review round 3: a floor read from copy tails kept Zoom lanes from muting; a median bed fixed it
- #1053 owner listening, round 4: "Clips 1, 2, 4, 5 and 6 sound great or good."
enforced-by:
- tests/test_bleed_attenuation.py::test_foreign_copy_on_a_gated_lane_is_muted
- tests/test_bleed_attenuation.py::test_lane_with_a_room_floor_is_turned_down_20_db_not_muted
- tests/test_bleed_attenuation.py::test_lane_whose_bed_cannot_survive_attenuation_is_muted
- tests/test_bleed_attenuation.py::test_explicit_bleed_handling_overrides_auto
- docs-sync: decision-bleed
supersedes: D-bleed-attenuate-everywhere
-->

`analysis.heuristics.bleed_handling` picks how the gate reduces a copy. `auto` (default) mutes it on a lane gated to digital silence between words and turns it down by `bleed_attenuation_db` (20 dB) on a lane whose room bed stays above the gate's level floor (75 dB under the lane's voice level) once turned down. `bleed_bed_db` is dB relative to the lane's voice level. A hard gate on a lane with a room bed makes the bed vanish, so a `mute` span carries the lane's own room tone ([Bleed mute fill](#bleed-mute-fill), #1734). `mute` and `attenuate` override `auto` for every lane.

### Superseded decision: Turn bleed down 20 dB on every lane

<!-- decision
id: D-bleed-attenuate-everywhere
status: superseded
date: 2026-10-06
decided-by: calebn
evidence:
- #945: "Attenuate, don't gate" by about 20 dB, because full removal risks gating artifacts
superseded-by: D-bleed-auto-mode
-->

The first default turned every copy down about 20 dB. On the gated Zoom lanes
the owner still heard the copy as an echo ahead of the speaker, so those lanes
now mute.

### Occurrence Restore rendering

The core timeline renderer honors content-bound `Clip.bleed_restore` choices.
Automatic off-speaker envelopes remain in `Clip.off_speaker_mute_regions` with
their original SOURCE bounds and fades. They apply around the complete prepared
clip body, including ordinary Lower, manual mute, ignored words, room tone, and
gate fill. Restore bypasses the automatic factor only inside active saved source
windows. Ordinary masks and ignored words still apply there. A Lower under an
automatic mute stays silent outside explicit Restore support.

The renderer keeps three bus definitions. `U` retains automatic envelopes. `W`
bypasses them inside selected windows. `V` removes those selected prepared bodies
from `W`. The output is `saturate16(B + h*((L-B) + (1-g)*(W-V)))`, where `B` and
`L` are the existing PCM16 gate of `U` and `W`. Gate truncation precedes widened
subtraction. The final ramp `h` applies once. Zero corrections preserve exact
baseline bytes. Several choices use one joint union.

Late-gate-only recovery still uses two FX evaluations. Combined recovery uses
three. Automatic-only recovery with an empty or disabled late gate uses two.
The ramp uses the plan's fade duration at the full saved source bounds, capped
to half the interval. Splits and audition windows do not restart original fades.
Configuration-only graph queries bind the automatic wrapper's primary trim,
leaf, prepared body, and evaluator clocks before its numeric gain is lowered.
Passive observations in the actual passes validate rates, formats, layouts,
counts, and ordered source-coordinate mappings. Both sides of the binary mask
retain the observed producer format and the observed consumer context.

Shared nonlinear FX interactions belong to this joint marginal. Full stems and
segments retain their existing request contexts and staging gain rules. No
arbitrary-window PCM parity is promised. Changed recording bytes deactivate
saved choices and retain the full authored automatic baseline. Reapply preserves
ordinary ownership and saved choices. Equivalent application adds no history.
Media or render-dependency changes refuse publication and preserve the previous
completed artifact. Host Restore commands and source-context proxy variants
remain separate integration work.

#### Source proxy PCM

`engines/source_proxy_audio.py` renders a private source-context variant for one
occurrence. Its independent `B0` uses the legacy source renderer, origin FX,
source gate, and eligible gate fill. An affected secondary recording is selected
before inactive-choice or unity-gate shortcuts. Empty choices retain the legacy
primary-source path. Existing proxy manifests and chunk routing remain unchanged.

`SourceProxyInputs.capture_legacy` seals a track's primary baseline without
inventing a clip. `capture_occurrence` seals the selected occurrence and its
effective preparation. Both expose a content-based input identity and retain
separate project, file, and logical-reference guards. `render_source_proxy_inputs`
consumes that exact capture, including its FX recipe, eligible fill, and source
gate. Default legacy callers retain their existing render command and behavior.

Private `W` and `V` decode the complete source through EOF. Ordinary masks,
ignored words, room tone, gate fill, and automatic envelopes prepare the selected
body. `W` bypasses automatic gain inside the joint saved windows. `V` removes
those windows from the complete prepared body before the same FX chain. Client
clip fades and output gain remain outside this preparation.

The source variant uses `saturate16(B0 + (1-g0)*h*(W-V))`. It has no timeline
`L-B` term. Zero correction preserves exact `B0` bytes. Saved ramp anchors stay
whole when active occurrence membership crops their support.

The `packed-source-proxy-v1` clock maps native source frames through the observed
prepared producer, the observed FX consumer, and the packed `B0` WAV grid.
Each owned conversion uses the existing half-up frame rescaling rule. Internal
FX rate changes add no editorial endpoint conversions. Binary removal uses the
producer grid. Final eligibility uses the complete mapped support. Packet
timestamps and acoustic latency do not move these endpoints. Stateful filters
can emit padded tails or discontinuous packet timestamps, so equal formats and
sample counts alone do not establish physical source ownership.

The renderer validates actual private clocks and PCM extents, checks project and
media dependencies, and replaces only a completed private output. A failure
retains the previous output. This entry point does not create an occurrence
manifest, upload chunks, or change guest playback bindings. Those integrations
and their native and listening acceptance remain separate work.

### Known limitations of the bleed gate

The gate decides that a stretch is another speaker's copy by matching the lane against the peer's track at a fixed lag, then checking the copy's timbre against the peer's speech ([how the copy is found](../.agents/skills/podcast-mute-bleed/SKILL.md#design)). Two kinds of own sound look like a copy to that check. The owner accepted these limitations on 2026-10-12. The gate still leaves own sound alone in the cases the decision above pins with tests. Before you trust a gated stem, run `apply_transcript_gate_tool` with `dry_run=true` and listen to the passages below.

#### Decision: Accept that a music bed shared by two mics can turn down own voice

<!-- decision
id: D-bleed-shared-program-limit
status: accepted
date: 2026-10-12
decided-by: calebn
evidence:
- #1187: the same music, stinger or soundboard audio on two lanes reads as a copy path at a consistent lag, so the lane's own speech under it can count as the peer's copy
- #1187 after #1166's co-timed own-sound fix: the check's pass rate on this case fell from about 45 to 10 per 100 trials at 25 s and from 40 to 9 at 60 s, but several seconds of own voice per few excerpts still end up turned down
- #1187 blocked-owner experiments on main 6033d77a: eight of eight synthetic voiced-sound trials with a shared random-note program falsely confirm a copy at lag zero; both gated lanes render zero RMS in the 10 to 11 s cue while the ungated inputs are nonzero
- #1187 rejected: fixed or global transfer fits, scalar subtraction or projection, and broad cepstral statistics either lose the shared program's source or lose true copies; shared program alone gives strong common-path evidence, and some residual statistics rank quiet independent speech below genuine noisy copies
- #1187 untested: richer adaptive or time-varying transfer, independent source-support combinations, harmonic or speech extractors, separators, speaker-conditioned models, and held-out evaluation on intelligible recorded speech
manual-review: owner, on a user report: no test pins this limitation because no fix is known. The owner reopens #1187 on a user report of own voice turned down under shared music, or when a candidate such as source separation exists and can show, on a lab episode, that it keeps quiet and later own sound after a genuine copy while keeping colored, lagged, noisy, dense, sparse and mixed-program copies
-->

When it happens: two mics both record the same program audio, such as a music bed from a speaker, a stinger, or a soundboard cue, and a person talks over it on one mic.

What you hear: that person's voice is turned down 20 dB, or muted on a call-app lane that is gated between words, for as long as the shared audio plays under them. A few seconds per excerpt is typical.

What to do:

- Dry-run the gate and listen to every passage with shared music or cues, in the stem and in the mix. Compare `attenuation_count` and `gate_reasons` per track with what you hear.
- If own voice is turned down, apply the gate with `start_sec` and `end_sec` windows that leave the passage out, or undo the apply step and keep the gate off for that lane.
- Prefer to record shared music on its own lane, not through the mics.

Reopen #1187 on a user report, or when a new method such as source separation can pass the bar listed in the block.

#### Decision: Accept that own sound following the peer's pitch can read as a copy

<!-- decision
id: D-bleed-pitch-following-limit
status: accepted
date: 2026-10-12
decided-by: calebn
evidence:
- #1190: the timbre check compares the lane with the peer's fine spectrum at the copy lag against the peer's speech 1 to 2 s away. Own sound at its own pitch fails that check, as intended. Own sound whose pitch follows the peer's matches at the lag and nowhere else, exactly as a copy does
- #1190 synthetic trials through the gate's real copy check, 100 per cell, untranscribed own sound co-timed with the peer: singing the peer's melody in unison passes 96 to 100 of 100 from 20 s (main: from 30 s); the same an octave up 68 to 82; own words at the peer's pitch within 0.3 semitone 96 to 100; with a sparse peer 92 to 100; own sound at its own pitch, 17 kinds, 0
- #1190 the same blind spot loses true copies of a near-monotone peer (25 to 34 of 100 pass, main passes all from 30 s), of a peer with 0.5 semitone variance, and of a sung melody; the bleed is kept, which errs toward leaving audio alone
- #1190 comment from the #1166 verification: against a sparse guest, a repeated host phrase with one syllable within about 0.6 semitone of the guest's pitch by chance passes as a copy in 1 to 3 of 100 trials
- #1190 blocked-owner experiments: loose nulls falsely confirm independent followers; strict pitch-conditioned phase keeps the lab pair and repeated-pitch controls but refuses genuine changing-pitch copies when comparable peer events are missing; magnitude transfer has false positives and misses
- PR #1166 round 2: unison singing and speech along at the peer's pitch within 0.3 semitone pass 96 to 100 of 100 from 20 s
manual-review: owner, on a user report: no test pins this limitation because no fix is known. The owner reopens #1190 on a user report of own sound turned down while following the peer's pitch, or of a copy kept at full level against a near-monotone peer, or when a source-identity cue that passes both false-copy and lost-copy trials exists, such as source separation
-->

When it happens: a person sings the peer's melody, chants a line together with the peer, or speaks along at the peer's pitch, such as an echo exercise, and that sound is not in the transcript. It also happens rarely and by chance when a sparse guest's pitch lines up with a syllable of the host.

What you hear: the along-sound is turned down or muted on its own mic. Own sound that follows the other speaker's pitch is turned down in excerpts of 20 s and longer. Since #1166 this starts at 20 s; before, it started at 30 s.

The reverse also happens: a copy of a near-monotone peer, a sung melody, or a repeated phrase matches the peer's other speech as well as the lag, fails the check, and stays at full level. You hear that as the usual bleed echo.

What to do:

- Dry-run the gate and listen to every passage where two people sing, chant or speak in unison.
- Window the apply around those passages with `start_sec` and `end_sec`, or undo the apply step for the lane.
- For a copy that stays, use [aligning retained bleed](#aligning-retained-bleed) or a reviewed mute range.

Reopen #1190 on a user report, or when a method such as source separation can tell own sound from the peer's copy without losing true copies.

### Aligning retained bleed

Preview with `align_retained_bleed_tool(apply=False)` or `podcast edit align-retained-bleed --dry-run`. Supply a timeline window and select the lane carrying the bleed. Proposals require quiet boundary space, independent delay evidence, consistent held-out probes, and agreement from other known retained copies. The evidence reports sampled residuals; it does not certify every sample or exclude competing room reflections. Unsupported or inconsistent regions remain unchanged and appear in `skipped`. An applied gate flag or successful command does not mean those regions are aligned.

An explicit selected bleed lane plus finite `start_sec` and `end_sec` enables bounded acoustic discovery from retained owner phrases on the matching selected direct recording, even if copy words or its transcript are absent. Missing any of these arguments keeps transcript-seeded discovery. Both paths exclude owner seeds explicitly marked `bleed`, dominant on another lane or speaker-matched to another lane, even when a manual choice retains their text. Unattributed and own-lane words remain eligible seeds; eligibility alone does not prove ownership. The completed selected-source interval must also have no explicit foreign attribution, including merged seed gaps and acoustic completion margins. Suppressed or ignored foreign rows conservatively veto because ungated evidence includes their raw samples; text decisions are preserved. Attribution on another recording or outside the completed source interval does not veto. Both paths use the same complete-phrase, quiet-slack, source-coverage, saved-choice and delay acceptance checks.

The bounded path reads local raw context only and does not construct fresh whole-recording gate plans. It does not assume hard attenuation makes a peer irrelevant. Every other unmuted placed lane in the possible copy footprint must be measured quiet in every channel or independently validate the same complete-phrase delay. Known retained-copy peers always validate. An active unrelated, unreadable, partial or conflicting peer causes conservative abstention. This can reduce recall in three-lane episodes; a failed correlation is not proof of copy absence. One global 64-unit budget charges phrase attempts, pair measurements and quiet reads before work. Completed phrases are at most 30 seconds, with bounded lag/null context outside scope used only as evidence. Correction, quiet trim and internal fades remain inside the requested window. Budget exhaustion never emits a partly validated proposal.

`no_retained_bleed_candidate` means an unmuted selected lane has audio placement but no usable transcript seed or eligible bounded owner-phrase candidate. The planner has not measured alignment there; this reason does not establish that the audio is copy-free. Preserve the audio and review the actual mix. In all-track runs, a lane can report no copy seed while also serving as the direct reference in another lane's supported correction or saved hold. These are separate relationships.

Users can save `manual` or `declined` timing decisions with `set_retained_bleed_alignment_mode_tool` or `podcast edit bleed-alignment-choice`. For a preview proposal, pass its decision ID and the same track/window. Choices survive reopening and take priority over automatic correction across retained peers. Set the mode to `auto` to release a saved timing hold for future planning; this does not undo an applied move. A legacy recorder placement lock requires an explicit scoped `override_placement_lock`; this does not override saved manual or declined choices. `align_retained_bleed=False` disables the alignment check for one gate call.

Crossfade layouts currently skip automatic acoustic gating and local alignment because their rendered sample clock can differ from raw clip placements. Gate apply also skips their ungated reconstruction, so a nondefault crossfade recipe cannot change audio outside a selected window. These skips require review, not a clean safety verdict.

Audition context reports `retained_bleed_misalignment` when supported local long-delay evidence exists. It names `podcast-mute-bleed` and the alignment tools. A delay measurement does not prove that owner speech is absent or authorize muting it.

Clip-local mute envelopes use nominal 5 ms transitions rounded to source samples for spans at least 10 ms long. Shorter spans use a hard half-open mute, with zero gain from the start sample up to but excluding the end sample. Gain is evaluated on every channel at sample boundaries. Segment renders preserve the original envelope when their window begins inside a mute. Stateful FX and premix normalization can affect output beyond the edited interval; see [reviewed bleed ranges](transcript-reconcile.md#reviewed-bleed-ranges).

## Off-speaker mute (#1740)

The transcript gate leaves audio it cannot verify as a copy, so on a call recording a few seconds of the other speaker can stay audible on a lane where that lane's own speaker never spoke: a word that pops in and out like an echo. `podcast edit mute-off-speaker` (`mute_off_speaker_tool`) is the plainer rule a person applies by ear. A stretch is muted when all of these hold:

- another dialogue lane has an unsuppressed word there (words merged across pauses under 0.5 s, 80 ms either side) and this lane has no unsuppressed word within 120 ms (a lane's own words are never judged by level, #1594);
- this lane's level envelope follows the other speaker's over that turn (correlation of 0.6 or more, with the lane up to 50 ms early or 300 ms late), so it is a copy; a breath or a laugh of the lane's own speaker does not follow the other voice and the turn is left open (`kept_uncorrelated_sec`, `no_copy_evidence` when no turn qualifies);
- no frame of it is more than 12 dB over the copy level, which is the 40th percentile of this lane minus the speaking peer over the confirmed turns where the peer is within 12 dB of its speech (`leak_ratio_db`). Fewer than one second of that evidence refuses with `no_leak_evidence`. An untranscribed laugh or backchannel under the other voice lasts 50 ms or more over the copy level and stays open with 60 ms around it (`kept_own_energy_sec`).

A short (0.6 s or less), isolated (0.6 s from any other own word) unsuppressed word inside the other speaker's turn is judged from the audio, because reconcile can leave a one-word fragment of the other speaker between words it suppressed: it is released and muted as a copy when the lane's envelope follows the other speaker's (correlation 0.7 or more) and it is no more than 6 dB over the copy level; with only one of the two it is listed as `review` and kept; otherwise it is the speaker's own. `judged_words` lists each with text, source and timeline times, correlation, level over the peer (`level_over_peer_db`, which includes the lane's usual gain difference) and `over_copy_db` (that minus the lane's leak ratio, the number the 6 dB rule reads), so the owner can audition the ones muted or in doubt.

Levels are measured against each recording's own room and speech levels, not a dBFS value (#1443). Only the parts where the lane sounds (6 dB over its room, 100 ms either side) become regions; regions under 150 ms and already-quiet stretches are not written. `audible_muted_sec` and `quiet_muted_sec` split the total, and `own_word_overlap_sec` re-checks, on the same timeline clock, that no region covers an unsuppressed word of the lane (always 0). `still_audible_sec` is the post-check on what plays now: seconds where another speaker talks, the lane has no word and still sounds after the regions (it includes turns left open for want of copy evidence); `still_audible_copy_sec` counts confirmed copies left unmuted that no rule explains (own-energy frames, already in `kept_own_energy_sec`, are not counted) and should be near 0. Copy evidence is read from the track with its earlier mutes removed, so re-running after an apply only closes what still sounds; `kept_gaps` names the rule that left each audible gap under a second open. A gap under 0.5 s inside a turn is held closed unless it holds an own word or own-voice energy, and a loud non-word sound on the other speaker's track (a clap) joins the turn it sits beside.

Each confirmed region is a trusted exact-range MUTE application stored in `Clip.off_speaker_mute_regions`. Ordinary mute and fill ownership remains separate. One History Undo reverses the command. Individual reopening requires a guarded occurrence Restore choice; an archive record alone cannot choose a clip copy. The plan's audio evidence is the audio check, so it applies with trusted boundary intent: the cut-edge audition that guards a ripple cut would hold every edge here, because the lane has no clean edge under a voice that is not its own. Scope and geometry holds still hold a region; they are listed under `held`.

## Bleed render internals

## Layers

Occurrence attenuation choices live in `Clip.bleed_restore`. Automatic SOURCE
mutes live separately in `Clip.off_speaker_mute_regions`. Ordinary mute, Lower,
ignored-word, and fill state remains independently authored. `OffSpeakerAudio`
applies automatic gain around the complete prepared body. Its primary
`SourceAudio` is clock metadata, not a second child. A content-valid Restore
bypasses only that automatic factor inside its saved source windows.

For automatic recovery, the renderer evaluates authored input `U` and bypassed
input `W` through the same continuous track FX. Late-gate recovery also evaluates
`V`, which removes the joint selected windows from complete bypassed bodies.
With `B = legacyGate(U)` and `L = legacyGate(W)`, the PCM16 result is
`saturate16(B + h*((L-B) + (1-g)*(W-V)))`. Legacy gate truncation stays separate
from widened residual arithmetic. Zero corrections copy `B` exactly. Late-only
Restore retains two FX evaluations. Combined recovery uses three, and automatic
recovery with a unity or disabled late gate uses two.

The output ramp `h` uses the plan's fade duration at complete saved source bounds,
capped to half the interval. Splits and crops retain the original automatic fade
anchors. `engines/render_clock.py` observes actual trim, prepared body,
composition, and delay counts, including both sides of conversions. The compiler
first configures the same automatic `aeval` topology with a placeholder gain.
It then maps absolute SOURCE endpoints through the configured primary trim,
leaf, prepared body, and evaluator clocks with the shared `MediaSeek` origin.
Only numeric expressions change before the actual authored pass validates those
associations. Configuration adds no complete FX evaluation.

`MaskAudio` preserves the full observed producer format before and after binary
removal, then restores the observed consumer format. Every rendered branch must
have matching clocks, formats, and extents. Malformed observations or changed
media refuse publication and retain the previous artifact. Private clock files
stay inside the render directory. `RenderDependencies` captures primary media,
room tone, gate fill, peer evidence, and render metadata around every pass.
Automatic-only recovery also captures dependencies when the late gate is disabled.

This is a joint marginal of quantized shared bus renders. Shared nonlinear FX
interactions belong to that marginal. Full renders and segments retain their
existing contexts and staging rules. Empty automatic state leaves the legacy
commands, PCM, and render identities unchanged. Detector cache serialization and
direct clip payloads omit empty automatic fields and always exclude Restore.
Nonempty automatic state participates in detector and render dependencies.
Changed recording bytes deactivate bypass while retaining authored automatic mutes.

`inspect_clip_bleed` reports the late plan, artifact freshness, and
saved choice separately. It maps actual automatic regions into the selected
occurrence and partitions saved coverage from remaining actionable SOURCE
intervals. Unity late plans expose no late-gate target. Authored speaker mutes
remain eligible independently. Ordinary project projections do not perform this
explicit inspection or hash recording bytes.

`services/document/bleed_inspection.py` owns the guarded mutation. Its transaction
adopts external changes, checks the opening history, occurrence, selected recording
bytes, file revisions, relevant track state, and current candidate, then saves one
Undoable choice. The helper does not render audio or reconcile transcripts.

`BleedAttenuationInspector` and `BleedAttenuationOverlay` are controlled React
leaves. They consume supplied targets, eligibility, receipts, and geometry. Their
timeline and inspector host integration uses the current-occurrence session and
shared selection registry described below.

Whole-lane recorder latency is the last stage of pipeline `align_tracks`.
`engines/envelope_lag.py` finds the lag between a voice's direct track and its copy
on another mic from level envelopes, tested against shifted nulls. It abstains
when the best lag sits on the search boundary or is not a strict peak. Reuse it for
any other copy-lag measurement instead of a private estimator.
`engines/bleed_latency.py` measures every ordered lane pair in windows, rejects
scattered or drifting pairs (a window settles when it agrees with the median or a
neighbour, and drift is a trend inside runs between steps, so a long step is not
drift), and solves one latency per lane by weighted least
squares with a residual per pair. Each lane gets one decision from its reason
(`DECISIONS`): `apply` only when pairs a path delay cannot explain (the direct
track trails its copy) connect it to the reference, `propose` when only later
copies do, `flag` on conflict or drift, else `keep`. `edits/conversation_align.py`
loads the lane envelopes near their planned placement (`measure_bleed_latency`
reports lags back where each lane sits, where direction is judged), folds the
decisions into the plans (`bleed_lag`, or `candidate_offset_sec` with a `proposal`), and keeps a lane
whose corrected placement is within `align.bleed_lag_deadband_sec` of where it
sits (`bleed_lag_kept`). `engines/bleed_lag_segments.py` then finds where such a
lane's latency steps from every latency-explained pair it shares with a track on the
reference clock (`BleedPair`, each searched around its `steady_lag` measured on the
lane's media), in the lane's source time, with each step in a silence of its
full-band envelope (RMS and sample peak both under their gates) and the step cost
chosen per lane by cross-validation (`LagSteps.step_cost`). `conversation_align.py`
(`_stepped_lanes`) places lanes on the clock outward from the reference, turns the
segments into per-clip plans with `steps`, and `apply_alignment_plans` splits those
clips (`split_clip_at`) before slipping each piece; a clip already at its recorded
placement keeps its `meta.ingest_alignment` entry, so a re-run changes nothing.
Once the clips are placed, the
`align_tracks` step calls `edits/clipped_onsets.py`, which measures the copy paths
again where the lanes now sit (`measure_pair`) and checks every opening whose sound
reached another mic first. An opening that jumps straight to the word's level, in step
with the copy (`envelope_lag.shift_correlations` at zero shift), is a clipped start: the
word's start moves (old start in `snapped_from`, restored and judged again on every run)
and gets its own `Align tracks` comment. An opening whose sound matches the copy shifted
back by the lead is a late track, which is alignment's to fix: nothing is flagged or
moved. Comments stay in step through
`edits/comments.py`. A word a person re-timed (`TranscriptWord.retime(..., by_person=True)`, via
`apply_word_timing`) carries `timing_edited` and is never judged. It reads only the project and audio, never the solver's internals.

Retained mixed bleed has a separate, conservative local alignment path.
`engines/bleed_delay.py` measures signed copy delays with extended reference
context and shifted null controls; it never claims that the lane owner is absent.
`edits/retained_bleed_alignment.py` plans immutable complete direct-source phrase
moves, validates quiet seams in every source channel, and applies existing split
and move operations on a working copy. Services own workspace history and render
publication. The mixed lane is unchanged. Declared crossfade joins abstain with
`unsupported_crossfade_evidence_clock`, because their rendered clock can differ
from raw clip placement. Supported windows must cover the inferred copy phrase
endpoints as well as independent interior probes. All known retained-copy peers in
the region must corroborate one offset; uncertain or conflicting evidence abstains.
Source-scoped user choices live in `editorial.retained_bleed_alignments`.
Destination overlap is removed only from verified quiet source material using
existing clip geometry, with source ranges and reason in the move edit log.
Any reduction of retained-word source coverage abstains. Saved mix-muted lanes
are excluded from automatic alignment; muted secondary copies cannot veto it.
Planning, trim guards, and bleed gates share `selected_source_transcripts`.
An explicitly selected bleed lane with finite start/end also discovers candidates
from retained owner phrases on selected direct recordings, without inventing copy
transcript words. Both origins exclude retained words explicitly marked bleed,
dominant on another lane or speaker-matched to another lane from owner seeds.
Manual text retention does not override those ownership exclusions; unattributed
and own-lane words remain eligible for the acoustic validator.
Both discovery origins use one complete-phrase validator. It also refuses a
completed direct interval overlapping explicit foreign attribution on that
selected recording, including gaps between seeds and completion margins. Foreign
rows veto even when suppressed or ignored because raw evidence includes their
samples. Attribution on another recording or outside that source interval does
not veto it. A lane with neither a transcript seed nor an eligible bounded owner
phrase reports
`no_retained_bleed_candidate`; this is unmeasured alignment, not acoustic clearance.
Examined candidates retain their specific abstention reasons.
`transcript_for_source` prefers an exact recording transcript; track-level words
apply only to primary media or a physically equivalent explicit source alias.
An unrelated source without a transcript supplies no phrase or gate authorization,
and a destination trim touching it abstains. Its complete selected placement is
protected from lane-wide attenuation, including overlaps with authorized clips;
when candidate planning proceeds, the gate reports
`untranscribed_source_protected`. Earlier abstentions preserve the whole lane
without an attenuation plan. Transcript enrollment, including empty transcripts,
is part of the persistent gate fingerprint. Disjoint authorized bleed
remains eligible for attenuation. Selected transcript words map only
through that recording's placements using
`SessionTimeline.map_selected_source_span(s)`. Implicit primary lanes keep the
identity source-to-timeline clock, independent of copies parked on other lanes.
Phrase indexes retain selected recording identity and are built once per direct
lane. Unbounded runs retain the 64-phrase transcript-seeded workflow. Explicit
lane/start/end requests have one 64-unit budget for phrase attempts, directed pair
measurements and quiet reads. Completed envelopes cannot exceed 30 seconds. The
bounded path does not build fresh whole-recording bleed gate plans or assume hard
attenuation to exclude peers. Every other unmuted placed lane in the possible
copy footprint must be measured quiet in every channel or corroborate the full
phrase delay; known retained-copy peers always participate. Missing, active
unverified or conflicting peers veto the candidate. No proposal survives an
unmeasured required peer when the budget is exhausted.
Local delay reads include bounded lag and shifted-null context with an explicit
timeline origin, rather than decoding complete recordings. Overlapping old/new
correction footprints, including quiet trim and seam fades, abstain as a batch.
Each immutable proposal records every retained-copy reference lane used in its
evidence. A batch also abstains when another correction would move a referenced
copy region. Repeated transcript seeds expanding to identical complete source
geometry produce one correction. Measured unsupported probes intersecting the
copy phrase prevent whole-phrase approval, even if endpoints and other probes agree.
Implicit full-media timelines remain playable but local retiming abstains until
explicit clip placements exist. Missing or unmatched direct phrases are reported.
`set_track_clips` carries manual per-clip ingest metadata onto surviving
same-source subclips, so a split or scoped override preserves other placement locks.
Replacing explicit placements with an empty list sets `timeline_empty`. Adding
placements clears it. Empty-to-empty replacement preserves the flag, including
implicit primary-media playback. Project-aware raw timeline readers silence
flagged lanes without placements while retaining decoded sample shapes and
shared source PCM. Raw source audition remains available.
Saved choices include an optional opaque digest of the normalized recording path;
primary media and equivalent explicit source references share that identity.
No host path is added to editorial metadata. Legacy choices resolve through their
existing source/primary media references.

Transcript bleed gating plans bounded foreign reduction in
`engines/bleed_gate.py` from ungated selected media, mapped by
`engines/ungated_audio.py`. An immutable `BleedGatePlan` carries protected phrases,
verified reduction spans, the lane's resolved reduction (`mute` or `attenuate`, from
`analysis.heuristics.bleed_handling` read through `AnalysisPolicy`; `auto` picks per
lane from its bed, the median level away from its own speech and the copies), the
attenuation in dB, that bed, and abstention reasons. Evidence is each lane's level envelope; the copy lag comes from
the shared `engines/envelope_lag.py` estimator over the peer's own speech and holds
only when the copy's timbre confirms it (`copy_timbre.confirmed_likeness`), every frame
the peer's direct track reaches at that lag is foreign, and own speech is sound over
the copy's expected level by more than the copy's own spread, or nearer it, a fifth
of a second whose fine spectrum is not the peer's (`engines/copy_timbre.py`).
Reconciliation reuses both: `TrackRmsCacheSet.copy_path` measures each bleed pair's
copy lag and likeness once, and `compute_word_audibility_map` reads the source mic
at that lag, taking a word from its speaker only when its fine spectrum is the copy's
([transcript-reconcile.md](transcript-reconcile.md#words-are-judged-at-the-copy-lag-1052)).
Project playback and rendering apply those conservative plans to rendered audio.

`engines/transcript_gated_play.py` uses absolute transition positions so segment
requests add no word-edge fades. `edits/transcript_bleed_mute.py` persists the
track's source selection and publishes a fresh source render through the existing
render lock and history mutation path. ASR coverage is not an exhaustive audio
whitelist. A process-local LRU retains at most 16 immutable gate plans keyed by
serialized relevant metadata, selected media revisions, and policy; it retains
neither live projects nor PCM. Initial evidence still decodes selected sources.
Owner phrases and unresolved activity retain full gain.

`engines/media_probe.py` shares successful `AudioProbe` metadata by resolved path
and file revision in a bounded process-local cache. Rendered-media audit retains
its container-duration policy. Reviewed bleed discovery requires a known, finite,
unestimated first-audio-stream extent and memoizes unavailable extents within each
receiving-lane discovery call. Declared extent is not proof of decodable PCM or
owner absence.

## Occurrence proxy publication

`SourceProxyInputs.capture_legacy` and `capture_occurrence` share source,
processing, fill, gate, dependency capture and validation. An occurrence binds
its selected recording before unity, inactive-choice or other shortcut checks.
The legacy selector requires no manufactured clip or replacement track media.

Source proxies preserve an independently rendered legacy baseline `B0`.
Continuous whole-source passes produce `W` with the selected automatic reduction
bypassed and `V` with the joint selected windows removed before the same FX.
The proxy correction is `saturate16(B0 + (1-g0)*h*(W-V))`. It never substitutes
a second approximation for `B0`. The observed native, producer, consumer and
packed-output clocks map saved source bounds, including conversion round trips.
Existing clip fades and output gains apply once in the client after decoding.

`services/media/proxy_variants.py` owns complete manifest publication under the
render lock. `RenderSection.proxy_manifests` retains the current and one previous
complete generation. Ordered chunk digests bind new public hashes to actual
encoded bytes. Publication uses the shared `util/atomic_directory.py` no-replace
rename, synchronizes files and the namespace before one derived metadata save,
and revalidates captured inputs before accepting the generation. It adds no
History step. Existing accepted URLs are never overwritten or purged on refusal.
A complete unaccepted directory alone grants no read authority.

Host `ensure_and_upload_all_proxies` publishes the complete generation after its
independent track ensure and upload attempts, so its basis includes the final
upload metadata History head. Successful preparation lets unchanged guest reads
reuse the accepted generation without saving or rendering. Preparation failures
log a host warning and preserve best-effort sharing. Later edits can require a new
generation. Standalone `ensure_track_proxy` still grants no aggregate authority.

The manifest's project basis binds history head, render hashes and complete clip
geometry to occurrence artifact references. The client admits one complete
playback snapshot. Changed or unavailable variant generations pause timeline
audio until a matching snapshot arrives. An offline legacy-only exception
requires exact replay of validated, locally queued MoveClips geometry; an empty
variant map alone does not permit a mismatched project.
