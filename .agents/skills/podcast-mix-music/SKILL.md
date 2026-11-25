---
name: podcast-mix-music
description: >-
  Mix intro, outro, and music beds with fade-in/out envelopes under dialogue.
  Use when assembling the final stereo premix before mastering — not dialogue
  FX cleanup (podcast-audio-cleanup) or loudness master/export
  (podcast-master-export).
---

# Mix music

## Defaults

From `.agents/defaults/pipeline.yaml`:

- Music under VO: ~-18 dB relative level on track
- Fade in: 2s, fade out: 3s
- Ducking depth: `mix.music_under_vo_db` (-18 dB), applied by `apply_ducking_tool`, not by the pipeline step

The premix is a unity sum (no 1/N) trimmed to `mix.premix_peak_ceiling_db` (true peak).

## Track roles

- `intro`, `outro`, `music` — automation fade envelopes on volume
- `dialogue` — already processed; included in premix

## Workflow

```bash
podcast track add --project episode.sharecut --id bed --file music/bed.wav --role music
podcast pipeline run --project episode.sharecut --only mix_with_music
```

## Duck music under dialogue

Run `apply_ducking_tool` (`podcast edit duck --project episode.sharecut`). It reads the transcript, so transcribe first. Preview with `dry_run=true`, then pass the reply's `plan_token` as `expected_plan_token` to apply exactly that plan. One call is one undo step for every track.

- Omit `track_ids` to duck every unmuted music track, including a music segment lane inserted from the library (no flag needed); name tracks to duck an intro, outro or sound track. A dialogue track is refused.
- `depth_db` omitted is `mix.music_under_vo_db`. Other knobs: `attack_sec`, `hold_sec`, `release_sec`, `min_gap_sec`, `min_speech_sec`. There is no threshold.
- Fades and your own points are only ever lowered, never raised. Run it again after changing the cut or the settings: earlier generated points are replaced.
- `pipeline run --only mix_with_music` refreshes a segment lane's stale stem, so it applies a dip made since the last render (the summary says `N segment lane stems refreshed`).
- Order does not matter: `mix_with_music` keeps the dip and your points and only re-places its four `mix:fade:` points. After a cut or a changed fade length the fade points move and the dip near them is stale (the step summary says so); run ducking again. A mix run no longer deletes a `pan` envelope.
- Speech with no transcript does not duck. Listen to a render for the level under speech and the first word.

## Custom envelopes

Use MCP `set_envelope` or edit `automation_envelopes` in project JSON:

The MCP tool generates IDs for points that omit them. When replacing an
existing envelope through MCP or editing its project JSON, preserve each
point's `id` while changing its time or value.

MCP `set_envelope` submits a `SetEnvelope` document command (undoable, shown
live in the DAW). Pass `expected_points` with the `[{id, time, value}]`
you last read, copied verbatim; if someone edited the envelope since, the call
fails with a conflict instead of overwriting their edit. Re-read and retry.
It replaces only the volume envelope; a `pan` envelope on the same track is kept.

```json
{"id": "fade-in-start", "time": 0, "value": 0},
{"id": "fade-in-end", "time": 2, "value": 1},
{"id": "fade-out-start", "time": 120, "value": 1},
{"id": "fade-out-end", "time": 123, "value": 0}
```

Values are linear gain (0 = silent, 1 = unity).
