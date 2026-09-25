# Episode project format

**Canonical spec:** [episode-format-v2.md](episode-format-v2.md) (version `2.0` only — no backward compatibility yet).

Primary file: `episode.project.json` in the episode workspace directory.

## Layout

```
my_episode/
├── episode.project.json
├── raw/                 # Source recordings (never overwritten)
├── transcripts/         # Per-track and combined JSON
├── history/             # Undo/redo snapshots (editable state only)
├── artifacts/           # Renders, waveform pyramids (peaks/*.wfpk), pipeline logs
└── export/              # Final audio (WAV + configured formats), SRT, MD
```

## Key entities

- **tracks** — Logical lanes (`host`, `guest_1`, `music_bed`, `intro`, …)
- **edit_decisions** — Non-destructive cuts (remove ranges with crossfade ms)
- **automation_envelopes** — Volume keyframes per track
- **processing_chains** — FFmpeg effect params per track
- **pipeline_runs** — Step execution history
- **history** — Undo/redo cursor and snapshot index (see [history.md](history.md))

Schema: [schemas/episode.project.schema.json](../schemas/episode.project.schema.json)
