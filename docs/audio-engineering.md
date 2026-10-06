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

## High-bleed warning

The full cleanup report shares decoded processed-stem RMS caches across its
audibility, gate, and boundary analyses; each standalone analysis can still
build its own cache.

`analyze_cleanup` computes `bleed_ratio` (bleed word count / total words) per track. When
it meets or exceeds `analysis.heuristics.bleed_ratio_warn_threshold` (default `0.2`, i.e.
20%), the track gets a `high_bleed_warning` message and the summary line reads `HIGH
BLEED (N% of words)`. This is a strong, evidence-based signal that a session has genuine
multi-mic bleed rather than isolated crosstalk — transcript suppression (`reconcile`)
only fixes text attribution, the wrong-mic audio is still audible in the mix. See
[podcast-mute-bleed](../.agents/skills/podcast-mute-bleed/SKILL.md) to gate it out
acoustically. If flagged bleed words are *louder* on the off-mic track than the direct
mic (compare `own_rms_db` against the dominant track's RMS from `audibility_map_tool`),
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
before its whole-mix trim. `audition_eval.inject_hum_span` sums at unity on purpose (see
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

Analyze's `digital_silence` check reuses `engines.asr_silence.peak_envelope` — the
same per-10 ms peak envelope the ASR silence filter streams — and flags a dialogue
track whose source audio is mostly below `transcribe.silence_filter.peak_dbfs`
(-60 dBFS by default) as a likely gated stem worth transcribing with VAD on.

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
`podcast bootstrap --component silero-vad` just verifies it's there. Falls back to
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
  desyncing the episode: `trim_clip_edge_tool(clip_id, edge, source_sec,
  all_tracks=session_join)`. A session-wide cut trimmed on one track alone leaves that
  track's later clips out of step with the others (see `clip_skew`). The other fix is
  `suggest_handoff_cut_tool` to move the cut to a silence.
- **`echo_risk`** — `engines/bleed_echo.py` profiles every directed pair of dialogue
  mics over up to 600 s of **fresh** timeline stems centred on the window (the audio
  the listener hears, one clock for every track). In 50 ms frames where speaker A is
  above -40 dBFS, mic B is open (above -60 dBFS) and at least 6 dB quieter, the
  normalised cross-correlation peak over ±40 ms marks B as carrying a copy of A when
  it reaches 0.25; the copies' lags are clustered in half-millisecond bins and the
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
  so a long span cannot flag a small excess. Measured on the lab tape: the same-room
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
  runs the same statistic on its own RMS caches (`TrackRmsCacheSet.echo_pairs`, over
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
  hypothesis (`history_undo`, or `trim_clip_edge_tool` with `all_tracks=true`).

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
  [`edits/fillers.py`](../src/podcast_mcp/edits/fillers.py) (breath detection is done;
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
enforced-by:
- tests/test_bleed_attenuation.py::test_late_gate_on_the_direct_track_still_mutes_the_foreign_copy
- tests/test_bleed_attenuation.py::test_track_speakers_own_speech_is_untouched
- tests/test_bleed_attenuation.py::test_quiet_untranscribed_owner_overlapping_foreign_audio_stays_audible
- docs-sync: decision-bleed
supersedes: D-bleed-keep-onset-copies
-->

If a dialogue mic contains both its owner and another speaker, removing that bleed can remove the owner too. Wherever the other speaker's own track is talking and the owner is silent, the transcript gate reduces the copy, with a 40/80 ms hold around the owner's speech ([transcript reconcile](transcript-reconcile.md#acoustic-follow-up-preserve-speech-while-reducing-verified-bleed)). The copy is never used as the other speaker's audio, even where their own track's gate opened late. Where both talk at once, the owner's speech stays and the fix is alignment ([recorder latency from bleed](multitrack-ingest.md#recorder-latency-from-bleed)), not muting: the default is to preserve uncertain audio and attempt local alignment of the other speaker's complete direct phrase; the transcript-seeded planner skips copies the gate would already reduce. `apply_transcript_gate_tool` and `podcast edit apply-bleed-mute` include this check. Alignment does not move the uncertain mixed lane, ripple other material, or stretch voiced audio. About 19 s of Audra-pitched audio still survives as Caleb's own on the lab tape (#1066).

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

`analysis.heuristics.bleed_handling` picks how the gate reduces a copy. `auto` (default) mutes it on a lane gated to digital silence between words and turns it down by `bleed_attenuation_db` (20 dB) on a lane whose room bed stays above the 16-bit floor once turned down. A hard gate on a lane with a room bed makes the bed vanish. `mute` and `attenuate` override `auto` for every lane.

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

### Aligning retained bleed

Preview with `align_retained_bleed_tool(apply=False)` or `podcast edit align-retained-bleed --dry-run`. Supply a timeline window and select the lane carrying the bleed. Proposals require quiet boundary space, independent delay evidence, consistent held-out probes, and agreement from other known retained copies. The evidence reports sampled residuals; it does not certify every sample or exclude competing room reflections. Unsupported or inconsistent regions remain unchanged and appear in `skipped`. An applied gate flag or successful command does not mean those regions are aligned.

An explicit selected bleed lane plus finite `start_sec` and `end_sec` enables bounded acoustic discovery from retained owner phrases on the matching selected direct recording, even if copy words or its transcript are absent. Missing any of these arguments keeps transcript-seeded discovery. Both paths exclude owner seeds explicitly marked `bleed`, dominant on another lane or speaker-matched to another lane, even when a manual choice retains their text. Unattributed and own-lane words remain eligible seeds; eligibility alone does not prove ownership. The completed selected-source interval must also have no explicit foreign attribution, including merged seed gaps and acoustic completion margins. Suppressed or ignored foreign rows conservatively veto because ungated evidence includes their raw samples; text decisions are preserved. Attribution on another recording or outside the completed source interval does not veto. Both paths use the same complete-phrase, quiet-slack, source-coverage, saved-choice and delay acceptance checks.

The bounded path reads local raw context only and does not construct fresh whole-recording gate plans. It does not assume hard attenuation makes a peer irrelevant. Every other unmuted placed lane in the possible copy footprint must be measured quiet in every channel or independently validate the same complete-phrase delay. Known retained-copy peers always validate. An active unrelated, unreadable, partial or conflicting peer causes conservative abstention. This can reduce recall in three-lane episodes; a failed correlation is not proof of copy absence. One global 64-unit budget charges phrase attempts, pair measurements and quiet reads before work. Completed phrases are at most 30 seconds, with bounded lag/null context outside scope used only as evidence. Correction, quiet trim and internal fades remain inside the requested window. Budget exhaustion never emits a partly validated proposal.

`no_retained_bleed_candidate` means an unmuted selected lane has audio placement but no usable transcript seed or eligible bounded owner-phrase candidate. The planner has not measured alignment there; this reason does not establish that the audio is copy-free. Preserve the audio and review the actual mix. In all-track runs, a lane can report no copy seed while also serving as the direct reference in another lane's supported correction or saved hold. These are separate relationships.

Users can save `manual` or `declined` timing decisions with `set_retained_bleed_alignment_mode_tool` or `podcast edit bleed-alignment-choice`. For a preview proposal, pass its decision ID and the same track/window. Choices survive reopening and take priority over automatic correction across retained peers. Set the mode to `auto` to release a saved timing hold for future planning; this does not undo an applied move. A legacy recorder placement lock requires an explicit scoped `override_placement_lock`; this does not override saved manual or declined choices. `align_retained_bleed=False` disables the alignment check for one gate call.

Crossfade layouts currently skip automatic acoustic gating and local alignment because their rendered sample clock can differ from raw clip placements. Gate apply also skips their ungated reconstruction, so a nondefault crossfade recipe cannot change audio outside a selected window. These skips require review, not a clean safety verdict.

Audition context reports `retained_bleed_misalignment` when supported local long-delay evidence exists. It names `podcast-mute-bleed` and the alignment tools. A delay measurement does not prove that owner speech is absent or authorize muting it.

Clip-local mute envelopes use nominal 5 ms transitions rounded to source samples for spans at least 10 ms long. Shorter spans use a hard half-open mute, with zero gain from the start sample up to but excluding the end sample. Gain is evaluated on every channel at sample boundaries. Segment renders preserve the original envelope when their window begins inside a mute. Stateful FX and premix normalization can affect output beyond the edited interval; see [reviewed bleed ranges](transcript-reconcile.md#reviewed-bleed-ranges).
