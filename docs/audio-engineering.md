# Audio engineering diagnostics

Objective, evidence-based tools for judging recording/mix quality — the "eyes and ears"
an agent uses before making cleanup or mastering recommendations. All of this runs on
FFmpeg filters and `numpy` — no extra installs required.

## Tools

| Tool | What it shows | Where |
|------|----------------|-------|
| `podcast edit audio-diagnostics --track <id> [--start --end]` | Spectrogram PNG + waveform PNG + `astats` health + hum flag, bundled for one track (or window) | `audio_diagnostics_tool` MCP / CLI |
| `podcast edit analyze-cleanup` | Per-track `health` block (astats + hum) alongside existing gate/bleed/fade findings | `analyze_cleanup_tool` MCP / CLI |
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
  hitting digital max. `peak_count` is how many times the file hit *its own* peak,
  not 0 dBFS.
- `noise_floor_db` / `dynamic_range_db` — how much room is between noise and peaks.

## High-bleed warning

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

## Two-pass loudness + mastering QC

`master_loudnorm` now runs FFmpeg's `loudnorm` filter **twice**, as FFmpeg's own docs
recommend:

1. **Pass 1** (`measure_loudnorm_stats`) runs with `print_format=json` only to measure
   the input's true integrated loudness, true peak, and loudness range — nothing is
   written yet.
2. **Pass 2** re-runs `loudnorm` with `linear=true` and the pass-1 measured values fed
   back in (`measured_I`, `measured_TP`, `measured_LRA`, `measured_thresh`, `offset`).
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
(default `dynaudnorm=f=150:g=15`) and records that filter on `master_qc.json`. Set
`crest_tame_af: ""` to disable. Loosen `master.true_peak_db` (e.g. `-1.0`) only when
you intentionally accept hotter peaks.

If premix LRA (from pass-1 `measured_LRA` / `input_lra`) exceeds `master.lra`
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
  "issues": []
}
```

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
(any YAML under `.agents/`, `config/`, `deploy/`, or `tests/fixtures/`,
scanned recursively) must not redefine a builtin preset name —
`tests/test_effects_presets.py` has a parity test that enforces this and
fails CI if one drifts.

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

`edits/breath_detect.py` defaults to an RMS-percentile heuristic to locate breath
sounds adjacent to a cut. Setting `tighten.breath_handling.vad_backend: silero` in
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

## Agent audition context (v2)

Default `audition_context_tool` (`detail=summary`) runs **windowed** astats/hum on
the span (same numbers as `audio_diagnostics_tool` with a window) and emits
`hum_in_window` / `clipping_in_window` in `hypotheses[]` when the window is at most
60s. Longer windows emit `dsp_unavailable` instead of a full-file FFT. It does not
attach PNGs. Windowed extract uses a fresh timeline stem or `SessionTimeline`
source mapping — never timeline seconds on raw/stale files.

The owner golden-ear harness requests this context without track DSP so its
captions and timing cannot be mistaken for measurements of a proposed cut. It
measures the two rendered A/B WAVs directly instead, with owner-only waveform
PNGs and per-side errors in `key.json`; see [filler-cut-quality.md](filler-cut-quality.md#golden-ear-protocol).

`detail=visual` windowed spectrograms are linear in time (`legend=0`) with JSON
`events[]` (`t` + plot-relative `x`). Overlay ticks use
`FFmpegEngine.annotate_time_marks` (`drawbox`; `drawtext` only when the ffmpeg
build includes it). Read the PNG paths; do not treat spectrograms as ASR.

The payload stays a briefing, not a kitchen sink: no LUFS, join scores, or bleed
maps in the same JSON (call those tools). No extra MOS. No stacked mix PNG (the
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
