---
name: podcast-vocal-compression
description: >-
  Apply gentle speech compression to dialogue tracks via FFmpeg acompressor.
  Use when vocals need more even level before the final mix — not broad cleanup
  presets (podcast-audio-cleanup) or inter-track LUFS balance (podcast-balance-levels).
---

# Vocal compression

## Defaults

From `.agents/defaults/pipeline.yaml`:

- Threshold: -18 dB
- Ratio: 3:1
- Attack / release: 15 ms / 150 ms
- Makeup: **0 dB** by default — `balance_tracks` already stages dialogue to
  `dialogue_lufs` (-20). Non-zero makeup after gain staging often clips peaks.
  Raise makeup only on unbalanced stems, or when you intentionally skip balance.

## Workflow

```bash
podcast pipeline run --project episode.project.json --only compress_tracks
```

Then re-render:

```bash
podcast pipeline run --project episode.project.json --from assemble_timeline
```

## Guidelines

- Podcast speech: aim for **3–6 dB** gain reduction on peaks, not pumping.
- Do not compress music/SFX tracks with this skill — dialogue roles only.
- Compression runs at assemble via `processing_chains` on the project file.
