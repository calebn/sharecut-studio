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
- Ducking depth: -10 dB (future: envelope from speech boundaries)

## Track roles

- `intro`, `outro`, `music` — automation fade envelopes on volume
- `dialogue` — already processed; included in premix

## Workflow

```bash
podcast track add --project episode.project.json --id bed --file music/bed.wav --role music
podcast pipeline run --project episode.project.json --only mix_with_music
```

## Custom envelopes

Use MCP `set_envelope` or edit `automation_envelopes` in project JSON:

The MCP tool generates IDs for points that omit them. When replacing an
existing envelope through MCP or editing its project JSON, preserve each
point's `id` while changing its time or value.

MCP `set_envelope` submits a `SetEnvelope` document command (undoable, shown
live in the DAW). Pass `expected_points_json` with the `[{id, time, value}]`
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
