---
name: podcast-master-export
description: >-
  Master episode loudness and export WAV, MP3, and transcripts. Use for final
  delivery to podcast hosts (Spotify, Apple, etc.). For stem/range bounces
  without mastering use podcast-bounce-export.
---

# Master and export

## Loudness target

- **-16 LUFS** integrated, **-1.5 dBTP** true peak (podcast / Apple-friendly)
- Configured in `.agents/defaults/pipeline.yaml` under `master`
- Mastering runs FFmpeg's `loudnorm` **twice** (measure pass, then a linear-gain pass fed
  the measured values) — accurate to a few tenths of a LU, not the 1-2+ LU drift and
  pumping that single-pass `loudnorm` can produce. Details: [docs/audio-engineering.md](../../../docs/audio-engineering.md).
- Mastered WAV keeps the premix sample rate/channels (loudnorm's internal 192 kHz path is
  not left in deliverables).
- If first-pass QC under-shoots integrated LUFS on a peaky premix, the step retries once
  after `master.crest_tame_af` (default `dynaudnorm=…`) before writing `master_qc.json`.

## Verify after mastering

`master_loudness` writes `artifacts/master_qc.json` — **always read this after
mastering** before telling the user the episode is ready:

```json
{
  "target_integrated_lufs": -16.0,
  "measured": {"integrated_lufs": -16.1, "true_peak_db": -1.6, "lra": 7.2},
  "within_tolerance": true,
  "issues": []
}
```

If `within_tolerance` is `false`, read `issues` and flag it to the user before export —
don't proceed silently. Tolerances: `master.qc_lufs_tolerance_lu` (default `0.5` LU),
`master.qc_true_peak_tolerance_db` (default `0.3` dB).

## Final ship gate: export_qc.json

`export_deliverables` writes `artifacts/export_qc.json` — a rollup of **reconciliation
staleness** plus `master_qc.json`'s issues, so a stale-audibility episode can't silently
ship unnoticed:

```json
{
  "reconciliation": {"stale": false, "fingerprint": "...", "last_reconciliation_hash": "..."},
  "master_qc": {"within_tolerance": true, "issues": []},
  "issues": [],
  "ok": true
}
```

**Always read `export_qc.json` after running `export_deliverables` (or the full
pipeline) and before telling the user the episode is ready.** If `ok` is `false`:

- `reconciliation.stale: true` — re-run `reconcile_transcript_tool` (or `render_preview`
  with reconciliation enabled) and re-export; see
  [podcast-transcript-reconcile](../podcast-transcript-reconcile/SKILL.md).
- A `master_qc` issue — see the loudness QC section above.
- Unmapped transcript words in `timebase.issues` — wrong clock or cut-away words.

Source/timeline **drift** after edits is expected; it appears under `warnings` /
`timebase.warnings` and does **not** flip `ok` by itself.

This check is non-blocking by design (matches `master_qc.json`) — it reports, it
doesn't raise, so an agent decides whether to re-run steps or ship as-is.

## Workflow

Same `PipelineService.export_audio` / `render_final` path as Sharecut Studio **⋯ → Export deliverables** / `Mod+Shift+E` and the Pipeline tab’s `export_deliverables` step.

```bash
podcast pipeline run --project episode.project.json --from master_loudness
```

Outputs in episode `export/`:

- `{name}.wav` (PCM copy of mastered mix when `export.wav: true`)
- Encoded files from `export.formats` (default: `{name}.mp3` at 128 kbps)
- `{name}.md` combined transcript
- `{name}.srt` subtitles from combined utterances

`{name}` is a portable sanitized filename stem, not the project title verbatim:
`My Episode: Part 1/2` exports as `My_Episode_Part_1_2.wav`. Dot-path names,
Windows device names such as `CON`, and overlong titles are made safe; long stems
use a stable hash suffix and stay in `export/`.

For stems/range **without** mastering, use [podcast-bounce-export](../podcast-bounce-export/SKILL.md) (`bounce_audio_tool` / `podcast pipeline bounce`).

## Configurable FFmpeg formats

Edit `.agents/defaults/pipeline.yaml`:

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

Per-format options: `codec`, `format` (container `-f`), `bitrate_kbps`, `sample_rate`, `channels`, `extra_args` (list of extra FFmpeg argv tokens).

Legacy: if `formats` is omitted, only `mp3_bitrate_kbps` is used to emit a single MP3.

Re-encode without full pipeline:

```bash
podcast pipeline export-audio --project episode.project.json
```

MCP: `export_audio_tool(project_path, formats_json?)` — optional JSON array overrides `formats` for that run.

## Agent notes

- Master only the **premix** — do not re-normalize individual tracks after mix.
- If export is too loud/quiet, adjust `master.integrated_lufs` in pipeline.yaml and re-run `--only master_loudness` and `export_deliverables`.
- `play --source export` uses the latest `export/*.wav`, not encoded files.
