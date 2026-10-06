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
- Mastering measures the premix with one `ebur128` pass (I, TP, LRA, gate threshold) and
  picks a plan from it:
  - **`loudnorm`** when the gain to the target keeps the true peak under the ceiling:
    FFmpeg's `loudnorm` in linear mode fed those values, accurate to a few tenths of a LU
    without the 1-2+ LU drift and pumping of single-pass `loudnorm`.
  - **`limit`** when that gain would push peaks over the ceiling (a peaky premix): the
    same static gain into a 4x-oversampled `alimiter` 0.5 dB under the ceiling, then a
    trim onto the target. It re-drives the limiter when it took more loudness than the
    trim can restore.
  Details: [docs/audio-engineering.md § Mastering plan](../../../docs/audio-engineering.md#mastering-plan--mastering-qc).
- Mastered WAV keeps the premix sample rate/channels (neither loudnorm's internal 192 kHz
  path nor the limiter's oversampling is left in deliverables).

## Verify after mastering

`master_loudness` writes `artifacts/master_qc.json` — **always read this after
mastering** before telling the user the episode is ready:

```json
{
  "target_integrated_lufs": -16.0,
  "measured": {"integrated_lufs": -16.0, "true_peak_db": -1.7, "lra": 7.9},
  "within_tolerance": true,
  "issues": [],
  "premix_input": {"input_i": -21.1, "input_tp": -1.0, "input_lra": 7.0, "input_thresh": -32.0, "target_offset": 0.0},
  "plan": "limit",
  "normalization_type": null,
  "limiter": {"gain_db": 5.1, "drive_db": 5.9, "limit_db": -2.0, "renders": 2, "trim_db": 0.3, "peak_reduction_db": 6.9, "loudness_reduction_lu": 1.1}
}
```

`premix_input` is the premix as measured, before any mastering. If `plan` is `"limit"`,
tell the user the premix was too peaky for a static gain and report the limiter's
`peak_reduction_db` (gain reduction on the loudest peak) and `loudness_reduction_lu`
(its average reduction); several dB of loudness reduction is worth a listen. If the plan
is `"loudnorm"` and `normalization_type` is `"dynamic"`, the premix LRA exceeded
`master.lra` and loudnorm compressed it dynamically.

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
  "alignment": {"checked": true, "accepted": true, "tracks": {"guest": 0.0}, "issues": []},
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
- Unmapped transcript words in `timebase.issues` — wrong clock or cut-away words. (Whisper's zero-length words are not unmapped: they appear as `timebase.tracks.<id>.zero_length_words` with a warning and do not flip `ok`; this includes one stamped exactly where a cut begins.)
- Inverted words in `timebase.issues` (`timebase.tracks.<id>.inverted_words`) — a word ends more than 20 ms before it starts: corrupt timing from a bad merge or manual edit, not Whisper output. Fix the word's times.
- A stacked-clip issue in `timebase.issues` (`timebase.stacked_clips`) means two clips read the same source and overlap by more than 50 ms on the timeline. This applies on one lane for every role and across two dialogue lanes. Each row pairs `track_ids[i]` with `clip_ids[i]`; delete or trim one clip, or re-run `align_tracks` (#520).
- An `alignment` issue - a clip sits more than the align threshold off the reference clock, an `unconfirmed_hold` candidate is still pending, or the align artifact is unreadable, and no person accepted the alignment (after a stale accept, only clips that moved more than the threshold since `align done` count). Use `podcast-align-audio`: listen, nudge, `align done`.

Plain source/timeline **drift** after edits is expected; it appears under `warnings` /
`timebase.warnings` and does **not** flip `ok` by itself. Zero-length ASR words that map
onto the timeline are also a `timebase.warnings` entry (`zero_length_words`), not a drift
issue. Relative align drift above `align.large_move_sec` without a person's accept is an
issue (`alignment.issues`).

This check is non-blocking by design (matches `master_qc.json`) — it reports, it
doesn't raise, so an agent decides whether to re-run steps or ship as-is.

From the CLI, `podcast pipeline run` already prints this verdict as an `Export QC: ok|FAILED (N issue[s]), M warning[s] (<path>)` line (plus each issue) right after a run that reached `export_deliverables` — read that line instead of opening `export_qc.json` by hand. MCP `pipeline_run` returns the same verdict lines after `Completed through …`. The command exits 1 when the verdict is not ok (strict by default); pass `--no-strict` to get the report with exit 0 and decide yourself.

## Workflow

Export re-mixes a stale premix and re-masters when `artifacts/mastered.hash` doesn't match, so no manual Refresh is needed before Export. A `master.*` config change still needs `--only master_loudness` (the hash covers the premix, not the config).

Export checks every unmuted track included in the mix. An edit to music, intro, outro, or
sound effects, or a selected media change, rebuilds that track's stem before remixing.
`check_loudness_tool` only measures an existing file. Read its `stale` and `stale_reason`
separately from `pass`: `pass` is the measured loudness verdict, while `stale: true`
means the premix, master, or exported WAV has a known freshness problem. An explicit
unrelated file reports `stale: null`; `stale: false` does not prove that an exported
file's bytes match the master. For tracked project audio, also inspect the `balance` map;
re-run `balance_tracks` when a dialogue entry's `stale` value is true. Run Export to refresh
stale audio.

Same `PipelineService.export_audio` / `render_final` path as Sharecut Studio **⋯ → Export deliverables…** / `Mod+Shift+E` and the Pipeline tab’s `export_deliverables` step.

```bash
podcast pipeline run --project episode.project.json --from master_loudness
```

Outputs in episode `export/`:

- `{name}.wav` (PCM copy of mastered mix when `export.wav: true`)
- Encoded files from `export.formats` (default: `{name}.mp3` at 128 kbps)
- `{name}.md` combined transcript (whole utterances)
- `{name}.srt` captions: word-timed cues split to `export.captions` limits (default ≤7s,
  ≤42 chars/line, ≤2 lines, ≥1s on screen) — see
  [docs/transcript-workflow.md § Captions](../../docs/transcript-workflow.md#captions-srtvtt)

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

## Configurable caption cue limits

```yaml
export:
  captions:
    max_duration_sec: 7.0
    max_chars_per_line: 42
    max_lines: 2
```

`podcast transcript export-srt` / `export-vtt` take the same limits as CLI options
(`--max-duration-sec`, `--max-chars-per-line`, `--max-lines`); unset ones fall back to
`export.captions`. See [docs/transcript-workflow.md § Captions](../../docs/transcript-workflow.md#captions-srtvtt).

## Agent notes

- Master only the **premix** — do not re-normalize individual tracks after mix.
- If export is too loud/quiet, adjust `master.integrated_lufs` in pipeline.yaml and re-run `--only master_loudness` and `export_deliverables`.
- `play --source export` uses the latest `export/*.wav`, not encoded files.
