---
name: podcast-bounce-export
description: >-
  Bounce selected or all stems (optional timeline range) to WAV/MP3 under
  export/bounces/ without mastering. Use to send a guest their track, mix a
  subset, or export a section. For full loudness-mastered deliverables use
  podcast-master-export.
---

# Bounce export (stems / range)

Lightweight mixdown — **not** the ship-to-host path. Same tooling as Sharecut Studio
**⋯ → Bounce…** / `Mod+Shift+B`.

## When to use

- Mix one or more tracks to a single file
- Bounce a timeline region without running `master_loudness`
- “Send guest their stem” / review packs

Do **not** use this for Spotify/Apple delivery — use [podcast-master-export](../podcast-master-export/SKILL.md).

## MCP / CLI (same service)

```text
bounce_audio_tool(
  project_path,
  track_ids_json=None | '["host","guest"]',
  start_s=None,   # timeline seconds
  end_s=None,
  formats_json='["wav"]' | '["wav","mp3"]',
)
```

CLI twin:

```bash
podcast pipeline bounce --project PATH [--tracks host,guest] [--start SEC] [--end SEC] [--formats wav,mp3]
```

Outputs land in `{workspace}/export/bounces/`.

## Notes

- Omit `track_ids` / `--tracks` → all **non-muted** mixable tracks with media
- Renders stems into a **private bounce temp dir** (does not overwrite shared
  `artifacts/tracks/` — safe concurrent with GUI refresh-mix)
- Unscoped bounce clamps to clip timeline extent (`timeline_duration_sec`) when
  the mix is longer than the edit
- Times are **timeline** clock ([tool_timebase](../../../src/podcast_mcp/util/tool_timebase.py))
- Does **not** write `master_qc.json` / `export_qc.json`
- Encode/copy shares [`write_audio_formats`](../../../src/podcast_mcp/export/audio.py) with master deliverables; bounce still mixes stems/range itself (no loudness)
