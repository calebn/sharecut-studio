# Multitrack ingest and alignment

Raw recordings often arrive as **several files** in one folder. The episode workspace should end up with **one dialogue track per speaker** (typically two tracks total).

**Remote recordings:** each file has its own **start/stop** and **duration**. Ingest maps them to one **session timeline** — not the same file timestamp on every recorder.

**Two clocks:** transcript word times stay in each track's **source-media seconds**; the edited/deliverable audio runs on **timeline seconds**. `timeline.clips` bridge the two and `engines/session_timeline.py` (`SessionTimeline`) is the only place that maps between them. See [episode-format-v2.md § Timebase invariant](episode-format-v2.md#timebase-invariant).

**Agent workflow:** `.agents/skills/podcast-align-audio/SKILL.md` (pipeline `align_tracks` + gate, or pre-pipeline suggest → verify → listen). Session-clock background: `.agents/skills/podcast-ingest-align/SKILL.md`.

`ingest consolidate` extracts **one WAV per listed source file** under each speaker (extras are kept as whole-file clips with `source_id`, not ignored). It does not mix multiple mics into one stem.

## Pipeline conversation align

After `transcribe_tracks`, the default-on **`align_tracks`** step places dialogue clips on one session clock (bleed phrase Δt, else own-speech/VAD gaps; N speakers). **`require_align_accept`** gates later steps until listen/`podcast align done` (or unattended waive). Uncheck Align in the Pipeline pane when files are not one conversation. See [pipeline.md](pipeline.md) and skill **podcast-align-audio**.

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
5. **`podcast ingest consolidate`** — extract `raw/{speaker}.wav` (+ `_srcN` for extras) and register tracks/clips. Without `--extract-start`/`--extract-duration` the WAV stays whole and the primary clip is **placed** on the session clock (see Placement below). Short recordings are fine with default flags: a correlation window past EOF scores peak 0 and falls back to the session-start offset.
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
| Placement | clip `source_start` / `timeline_start` | Whole-file (untrimmed) consolidate: `offset_to_clip_geometry(content_align - session_start)` so session t=0 is timeline 0 for every speaker; the raw WAV stays whole (non-destructive). Only the primary clip is placed; extra clips follow sequentially. Trimmed extracts are not re-placed. |

Cross-speaker correlation uses `session.reference_speaker` as the reference (not the first-listed file).

**Primary score:** `simultaneous_speech_sec` (VAD overlap). **Secondary:** correlation peak, anchor match, drift between two windows (`drift_warning` in suggest output).

**Do not** use transcript word overlap alone to confirm sync on bleed-heavy tracks.

Waveform PNGs under `artifacts/alignment/` (`showwavespic` via ffmpeg) show whether energy peaks line up vertically.

## v2 project fields written by consolidate

- **`sources`** — one raw file per speaker
- **`timeline.tracks`** / **`timeline.clips`** — one dialogue track per speaker; untrimmed clips carry the session placement (`source_start`, `timeline_start`)
- **`meta.ingest_alignment`** — per-speaker (or `track_id:clip_id` when a speaker has several whole-file clips) `session_start_in_file_sec`, `content_align_sec`, `align_method`

## MCP tools

| Tool | Purpose |
|------|---------|
| `ingest_import_folder_tool` | Draft `ingest.yaml` from a recorder folder |
| `ingest_suggest_alignment_tool` | Pre-consolidate suggest |
| `ingest_verify_alignment_tool` | Post-consolidate verify |
| `play_compare_tool` | Sequential compare audition |
| `play_audio_tool` (`compare=true`) | Compare via play |

## Limitations (v1)

- Single global offset per **whole-file clip** (not piecewise drift inside one file).
- `suggest` sweeps **every** non-reference speaker vs the reference and writes
  `session_start_in_file_sec` for each into `yaml_snippet` /
  `recommended_session_starts`. Candidate list / drift / default waveforms still
  highlight the **first** non-reference guest (backward-compatible shape).
- Weak correlation / missing anchors: rely on VAD + listening.
- Pipeline `align_tracks` prefers consistent bleed n-grams, then own-speech gaps;
  equal-duration pairs start at offset 0 (trust but verify).

## Assigning speakers

The tool does not guess speaker names. List **one file per speaker** in `ingest.yaml`. Omit intro/outro/SFX from `speakers`.
