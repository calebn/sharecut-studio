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

Render status and `check_loudness_tool` on tracked project audio report whether the saved
balance measurement is stale. The `check_loudness_tool` result includes a per-dialogue-track
`balance` map; re-run this step for tracks where `balance[track_id].stale` is true. The
status compares the primary media file revision, ordered FX chain, exact speech intervals
kept by the track's own-media clips, and measurement semantics revision. It ignores gain
and mix controls, transcript wording, timeline-only clip placement, and render state. A
missing status means the track has not been measured. The report does not compare the
requested LUFS target; per-run target overrides are not saved.

```bash
podcast pipeline run --project episode.project.json --only balance_tracks
```

This sets per-track staging `gain_db` so the track hits the target loudness
**post-FX** (measured through the track's processing chain) and **speech-gated** to the
track's own non-suppressed transcript words that its clips keep (bleed and cut material excluded). It runs after
`compress_tracks`; re-run it after changing FX. The summary lists the achieved LUFS per
track; `ungated` means no transcript (or too little speech), so the whole file was measured. A track listed as `not measured, gain kept` kept its previous gain_db; check its media and FX chain, and whether its clips keep any of its words (a track whose words were all cut is not measured).
It never touches `fader_db`, the user's saved volume on top of it: the mix plays
`gain_db + fader_db`. For a deliberate level change on one track, use
`track_set_volume_tool` (or `podcast episode set-track-volume`) so re-running
balance keeps it.

## Agent notes

- Balance dialogue tracks only; music beds use separate gain and ducking.
- If one guest is still quiet after balance, check raw recording before pushing gain > +6 dB.
- Re-balance after large structural edits (many cuts removed).
