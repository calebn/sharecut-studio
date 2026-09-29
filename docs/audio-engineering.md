# Audio engineering diagnostics

Objective, evidence-based tools for judging recording/mix quality — the "eyes and ears"
an agent uses before making cleanup or mastering recommendations. All of this runs on
FFmpeg filters and `numpy` — no extra installs required.

## Tools

| Tool | What it shows | Where |
|------|----------------|-------|
| `podcast edit audio-diagnostics --track <id> [--start --end]` | Spectrogram PNG + waveform PNG + `astats` health + hum flag, bundled for one track (or window) | `audio_diagnostics_tool` MCP / CLI |
| `podcast edit analyze-cleanup` | Per-track `health` block (astats + hum) alongside existing gate/bleed/fade findings | `analyze_cleanup_tool` MCP / CLI |
| `artifacts/mastered.hash` | Fingerprint of the premix the master was built from; a mismatch re-masters on export | written by the `master_loudness` pipeline step after `mastered.wav` is swapped in whole; cleared (with `master_qc.json`) when a master starts |
| `artifacts/master_qc.json` | Post-master loudness verification (measured vs. target, pass/fail) | written by the `master_loudness` pipeline step |

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
`play_compose` uses the same ceiling on its own window, so a hot window is trimmed rather
than clipped; a window that peaks under the ceiling plays at unity, the same as the premix
before its whole-mix trim. `audition_eval.inject_hum_span` sums at unity on purpose (see
its docstring).

Premixes mixed under the old rules re-mix once: `MIX_SEMANTICS_REV` is part of
`mix_render_hash`.

The ceiling is part of the hash too, so a pipeline run with a different `mix.premix_peak_ceiling_db` re-mixes. `premix.hash` also records the ceiling on its own line: render status and review publish have no run config (the GUI Pipeline tab's per-project override lives in the GUI process), so they compare the premix against the ceiling it was mixed under and only a volume, mute or mix-rule change reads as stale.

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
at measurement time: re-run `balance_tracks` after adding, removing, bypassing or retuning
effects; nothing yet flags a stale balance.

## Two-pass loudness + mastering QC

`master_loudnorm` now runs FFmpeg's `loudnorm` filter **twice**, as FFmpeg's own docs
recommend:

1. **Pass 1** (`loudnorm_input_stats`) is one `ebur128` pass that reads the input's
   integrated loudness, true peak, loudness range and gate threshold. It replaces a
   loudnorm measure pass, which resamples to 192 kHz and dominated the step's wall time.
   `target_offset` is passed as 0: loudnorm only uses it in dynamic mode.
2. **Pass 2** re-runs `loudnorm` with `linear=true` and the pass-1 measured values fed
   back in (`measured_I`, `measured_TP`, `measured_LRA`, `measured_thresh`, `offset`) and
   `print_format=json`. loudnorm falls back to **dynamic** mode when `TP + gain` would
   exceed the TP target or the LRA exceeds `master.lra` (or the measured LRA is 0); the
   printed `normalization_type` (`linear` / `dynamic`) says which ran.
   Both passes run with `-progress pipe:1` and share one `master_loudnorm`
   child bar in media seconds: pass 1 fills the first half, pass 2 the
   second. Both passes use the one input probe for their length. The
   post-master QC measure reports on a `master_qc_measure`
   child.
   This produces a static (non-pumping) gain instead of single-pass `loudnorm`'s
   dynamic/frame-by-frame correction, and lands much closer to the target LUFS (typically
   within a few tenths of a LU, versus 1-2+ LU drift from single-pass).
3. **Delivery rate restore** — FFmpeg's loudnorm path upsamples to 192 kHz for true-peak
   work. `master_loudnorm` always writes `-ar`/`-ac` matching the premix (or an explicit
   override) so mastered/export WAVs stay at podcast rates (e.g. 44.1/48 kHz), not 192 kHz.

If QC shows integrated LUFS still low while true peak sits on the `TP` ceiling, the
limiter—not the two-pass math—is the constraint. High-crest premixes (very loud peaks
relative to integrated loudness) cannot take the gain needed for `-16` LUFS without
violating TP. `master_loudness` then retries once after `master.crest_tame_af`
(default `dynaudnorm=f=150:g=15`) and records that filter on `master_qc.json`. The crest-tamed intermediate
(`artifacts/premix_premaster.wav`) is deleted after every master, successful or not, so
`crest_tame_af` on `master_qc.json` is the only record that the retry ran; re-run the
filter by hand on `premix.wav` to inspect it. Set
`crest_tame_af: ""` to disable. Loosen `master.true_peak_db` (e.g. `-1.0`) only when
you intentionally accept hotter peaks.

If premix LRA (from pass-1 `measured_LRA` / `loudnorm_input.input_lra`) exceeds `master.lra`
(default `11`), raise `master.lra` toward the measured range or compress first — this
is secondary to crest/TP for most dialogue masters.

After mastering, the `master_loudness` pipeline step re-measures the output
(`measure_loudness_full`, via `ebur128`+`astats`) and writes `artifacts/master_qc.json`:

```json
{
  "target_integrated_lufs": -16.0,
  "target_true_peak_db": -1.5,
  "measured": {"integrated_lufs": -16.1, "true_peak_db": -1.6, "lra": 7.2},
  "within_tolerance": true,
  "issues": [],
  "normalization_type": "linear",
  "loudnorm_input": {"input_i": -20.1, "input_tp": -3.0, "input_lra": 6.0, "input_thresh": -30.5, "target_offset": 0.0}
}
```

`normalization_type: "dynamic"` means loudnorm could not apply one static gain within the
TP/LRA limits, so it limited or compressed dynamically. `loudnorm_input` is the pass-1 stats
(`null` when loudnorm ran single-pass).

Tolerances are configurable (`master.qc_lufs_tolerance_lu`, default `0.5` LU;
`master.qc_true_peak_tolerance_db`, default `0.3` dB) in
[`.agents/defaults/pipeline.yaml`](../.agents/defaults/pipeline.yaml). **Always read this
file after mastering** and surface `within_tolerance: false` to the user before export —
don't just trust that `master_loudnorm` ran without checking what it actually achieved.

`export_deliverables` goes one step further and writes `artifacts/export_qc.json`,
rolling up `master_qc.json`'s issues **plus** transcript reconciliation staleness
(`engines/reconciliation_state.py::reconciliation_status`) into one `ok`/`issues` gate —
see [podcast-master-export](../.agents/skills/podcast-master-export/SKILL.md#final-ship-gate-export_qcjson)
for the exact shape and what to do when `ok` is `false`.

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
On a gate-overreach finding it **always** proposes `effects.gate` with the
threshold lowered by 6 dB, once per Analyze call however many tracks report
overreach (the gate chain is global): from the working set's own `effects.gate` if
present, otherwise from the resolved `gate` preset. This happens even when the
base config's `effects` has no `gate` key, which is now the default because the
repo `effects:` overlay is empty. The proposed config is a per-project working
set, not a repo-tracked defaults YAML, so carrying a `gate` entry there does
not violate the no-redefine rule above.

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
