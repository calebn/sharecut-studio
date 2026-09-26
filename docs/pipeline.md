# Pipeline

Default step order (see [transcript-workflow.md](transcript-workflow.md) for transcript layers):

1. `ingest_tracks` — Probe audio, validate paths
2. `transcribe_tracks` — faster-whisper per dialogue track (and per extra source file)
3. `align_tracks` — Conversation-clock placement (bleed phrases / own-speech gaps); default on; uncheck for unrelated clips
4. `require_align_accept` — Gate until align done/waived (`align.accept.mode`; auto-waive with `--unattended`)
5. `merge_transcript` — Combined time-ordered script
6. `render_dialogue_stems` — Pass-1 per-track stems for audibility
7. `reconcile_transcript` — Pass 1: audibility/bleed suppress
8. `precorrect_transcript` — Glossary and cross-track sync
9. `require_transcript_refine` — Hard agent gate (`refine-done` / waive; auto-waive with `--unattended` / `PODCAST_BATCH=1` when mode is `waive_unattended`; after an active gate, a successful unattended run refreshes its waiver only for later suppression changes)
10. `analyze_focus_cuts` — `artifacts/focus_outline.md`; off unless `focus.enabled`
11. `focus_from_transcript` — No-op unless `focus.auto_apply`
12. `analyze_fillers_pauses` — Mark filler words and long pauses (**no-op** unless `tighten.enabled`). Manual `propose_edits` uses `tighten.edit_mode` (`ripple` default, or `mute`).
13. `tighten_from_transcript` — Apply filler/pause edit decisions (**no-op** unless `tighten.enabled`)
14. `clean_audio` — HPF per dialogue track
15. `balance_tracks` — LUFS gain staging
16. `compress_tracks` — acompressor on dialogue (attack/release/makeup from `compression.*`; default makeup 0 after balance)
17. `assemble_timeline` — Final stems after edits + FX
18. `reconcile_transcript` — Pass 2: post-FX audibility refresh
19. `mix_with_music` — Intro/outro/bed + ducking envelopes
20. `master_loudness` — two-pass loudnorm to podcast target; rebuilds a missing or stale premix first; writes `artifacts/master_qc.json` verification report and `artifacts/mastered.hash`
21. `export_deliverables` — re-masters when `mastered.hash` doesn't match the current premix. A master with no hash (mastered before #425) is re-mastered once, and an imported or legacy episode with only `mastered.wav` and no `premix.wav` is re-assembled, re-mixed and re-mastered instead of exported as-is; audio (WAV + configured FFmpeg formats), SRT, MD; writes `artifacts/export_qc.json` (reconciliation staleness + mastering QC rollup — check `ok` before shipping)

Transcript quality runs **before** focus/tighten so search and narrative edits use reconciled, precorrected, refined text.

## Conversation align (`align_tracks` + gate)

After ASR (while bleed phrases still exist in the transcript), **`align_tracks`**
places each whole-file dialogue clip on one session clock:

1. **Bleed n-grams** — same phrase on two+ tracks ⇒ median Δt (strong clock when matches agree). Sub-second Δt (`align.bleed_identity_sec`) is confirmed with waveform xcorr before apply; identity only when acoustic lag is ~0.
2. Else **own-speech / VAD gaps** — occupancy excludes bleed copies and stretched ASR words; N-way union; hierarchical coarse→fine sweep over a bound from the longest dialogue file (`align.max_offset_sec: 0` = auto). Applied when confident about a multi-second move (not search-wall; near-exact equal lengths require a clear win over identity). Local **silence-midpoint** refine (±2s, capped to ~0.3s drift) polishes the peak.
3. Else **late-join occupancy** — after leading file silence, park the first real speech island in a host silence long enough to hold it (silence-mid − utterance center, or silence start if mid would overhang). Apply only when turn-taking **clearly beats identity**. Method `gaps_late`; then the same local silence-mid refine. Sparse one-off bleed bigrams are for human/agent diagnosis, not the default clock.
4. **Equal duration / weak hold** — near-exact file lengths (~50ms) soft-hold identity when gaps and late-join are not confident; otherwise `weak_hold` at 0.

Writes `meta.ingest_alignment`, clip geometry, and `artifacts/alignment/conversation_align.json`.
Does **not** blade/split one WAV into multiple clips. Several raw files per speaker stay
several whole clips (`source_id`).

**`require_align_accept`** blocks later steps until `podcast align done` / waive. Unattended /
`PODCAST_BATCH=1` with `align.accept.mode: waive_unattended` keeps the scorer result and
auto-waives (it does **not** skip the scorer). Uncheck **Align tracks** in the Pipeline
pane when files are unrelated segments — the gate cascade-disables with it.
`merge_transcript` still depends only on `transcribe_tracks` so skipping align does not
disable ASR.

**v1 limits (documented, not solved here):** one offset per whole file (no clock-drift
piecewise sync); mixdown/stereo “everyone on one track”; Whisper silence hallucinations
beyond treating sparse own-speech as weak occupancy.

CLI/MCP: `podcast align status|brief|done|waive` / `align_*_tool`. Skill: **podcast-align-audio**.

Each step returns a short human-readable **summary** (counts of tracks, cuts, suppressions, QC issues, etc.). The runner stores it on `PipelineStepLog.message` and surfaces it in CLI `--json-progress` (`Completed {step}: {summary}`) and the DAW Pipeline tab. Intra-step phases use the shared progress framework ([progress.md](progress.md)) — engines called from steps pick up the bound reporter via `resolve_progress()`.

## Configurable run (GUI / MCP)

Sharecut Studio Pipeline pane and MCP tools share a **working set** of enabled steps + yaml-derived params:

- `GET`/`PUT` config and `POST` analyze — see [gui-integration.md](gui-integration.md) § Pipeline tab
- Config payload includes `whisper_models` with per-model `cached`; GUI `transcribe.model` is a catalog picker that confirms before downloading via bootstrap (whisper-only). Pipeline `components.whisper.ok` requires the selected weights on disk. Pipeline **Run** (GUI/MCP/CLI) fails fast if `transcribe_tracks` would run and weights are missing — it never Hugging Face–pulls; use bootstrap or the picker Dialog to download.
- MCP: `pipeline_get_config_tool`, `pipeline_set_config_tool`, `pipeline_analyze_tool`, then `pipeline_run` (skill **podcast-pipeline-tune**)
- CLI: `podcast pipeline run --unattended` and optional `--skip a,b,c`
- Enabling a step expands `depends_on`; missing FFmpeg/whisper/rnnoise show as component badges (bootstrap CTAs)
- **Analyze** proposes static knobs from diagnostics (hum, noise floor, gate, bleed, clipping); any gate-overreach finding always proposes a milder `effects.gate` (-6 dB threshold, applied once per Analyze call regardless of how many tracks are flagged), seeded from the resolved `gate` preset when the working set has none (see [audio-engineering.md](audio-engineering.md#effect-presets-source-of-truth)); loudness measure→target still happens inside balance/master at run time

## Resume from a step

```bash
podcast pipeline run --project episode.project.json --from precorrect_transcript
podcast pipeline run --project episode.project.json --unattended
podcast pipeline run --project episode.project.json --from tighten_from_transcript
podcast pipeline run --project episode.project.json --from assemble_timeline
podcast pipeline run --project episode.project.json --only master_loudness
```

`--from reconcile_transcript` resumes at pass 1. Pass 2 reconcile is included when resuming from `assemble_timeline`.

Defaults: `.agents/defaults/pipeline.yaml` (tighten, mix, export, and other step parameters; `effects:` is only a by-name overlay on the FX presets built into `effects/presets.py`, see [audio-engineering.md](audio-engineering.md#effect-presets-source-of-truth)). Cut boundaries: [inaudible-cuts.md](inaudible-cuts.md). **Tuning filler/pause cuts:** [filler-cut-quality.md](filler-cut-quality.md). **Audio diagnostics and mastering QC:** [audio-engineering.md](audio-engineering.md).

## Edits during a run

Each step's save merges onto the saved project (`ProjectWorkspace.checkpoint()` / `save_merged()`), so a volume, mute, comment or cut saved while the run is going survives and later steps see it. A volume or mute saved during the stems step does not stop it. A merged save replaces whole project sections (tracks, pipeline runs, render state) in place, so steps and the runner re-fetch objects from the project after each save rather than keep earlier references; the runner re-resolves its run each step. If another request and the run changed the same value, that step fails with a "re-run it" message and saves nothing. If a step's save fails before the project file is replaced (any error, not only a conflict), the step is not marked done in memory either, so a later save cannot record it as completed. An undo or redo during a run, even before the first step, also stops it: the message says an undo or redo changed the project (conflict key `history.lineage`), nothing is saved, and the history index stays as the saved project has it. This covers one process only (#213).

## Tighten params

Pipeline auto-tighten stays **off** (`tighten.enabled: false`) until the golden-ear bar in [filler-cut-quality.md](filler-cut-quality.md). Manual `propose-edits` / `apply-edits` still read these keys.

| Key | Default | Role |
|-----|---------|------|
| `tighten.enabled` | `false` | Run `analyze_fillers_pauses` / `tighten_from_transcript` |
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

Step **order** is always strictly sequential (each step's input is the previous
step's output) — but three steps parallelize the independent work they loop over
internally, via a shared thread-pool helper (`util/parallel.py`):

| Step | What runs concurrently |
|------|-------------------------|
| `analyze_fillers_pauses` | Candidate gathering runs one task per dialogue track (including the per-gap acoustic scan for `filler:acoustic`, vectorized NumPy over the shared audio cache). Every filler, pause, repetition, restart, or acoustic candidate across **all** tracks is then analyzed (waveform boundary snap, risk assessment, fade sizing) in one shared pool; overlaps are resolved and decisions applied serially in the original order |
| `assemble_timeline` / `render_dialogue_stems` | Each track's stem is rendered concurrently (`_render_track_stems`) |
| `export_deliverables` | Each configured output format is encoded concurrently |

Stem workers read one deep project snapshot captured before dispatch. Each
worker renders and writes its cache hash from that snapshot. If an edit changes
the live render hash, renderable track set, or committed project-file
revision while FFmpeg runs, the step retains new invalidations and fails before
publishing `track_outputs.json`; retry the render for the new state. On-demand processed playback uses the same snapshot rule for
full stems and segment cache keys.

Configure via `performance.max_workers` in `pipeline.yaml`:

```yaml
performance:
  max_workers: 0   # 0 = auto (cpu_count-based, capped at 8); 1 = serial; N = explicit cap
```

Set `max_workers: 1` to force fully serial, single-threaded execution — useful when
debugging a specific cut/render issue and you want deterministic, reproducible
single-threaded behavior. `master_loudness`'s two-pass loudnorm is not parallelized
(pass 2 depends on pass 1's measurement of the same file).

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
