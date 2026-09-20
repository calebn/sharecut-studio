---
name: podcast-balance-levels
description: >-
  Balance dialogue track levels to target LUFS before mixing. Use when hosts and
  guests are at different volumes or after tightening edits — not FX presets
  (podcast-audio-cleanup) or acompressor (podcast-vocal-compression).
---

# Balance levels

## Targets

From `.agents/defaults/pipeline.yaml`:

- Dialogue tracks: **-20 LUFS** integrated (pre-master staging)
- Final master: **-16 LUFS** (see podcast-master-export)

## Workflow

```bash
podcast pipeline run --project episode.project.json --only balance_tracks
```

This sets per-track `gain_db` from FFmpeg ebur128 measurement vs target.

## Agent notes

- Balance dialogue tracks only; music beds use separate gain and ducking.
- If one guest is still quiet after balance, check raw recording before pushing gain > +6 dB.
- Re-balance after large structural edits (many cuts removed).
