---
name: podcast-bounce-export
description: >-
  Bounce selected or all stems (optional timeline range) to WAV/MP3 under
  export/bounces/ without mastering. Use to send a guest their track, mix a
  subset, or export a section. For full loudness-mastered deliverables use
  podcast-master-export.
---

# Bounce export (stems / range)

Lightweight mixdown — **not** the ship-to-host path. Same tooling as **Export** in
Sharecut Studio's Edit action bar, which runs in place (palette: Export full mix;
Mod+E exports a selected range in place, otherwise it opens Deliver). The files are
listed on Deliver as "Exports of a selection" (label "Unmastered export"). The MCP
`bounce_audio_tool` and `podcast pipeline bounce` are unchanged.

## When to use

- Mix one or more tracks to a single file
- Bounce a timeline region without running `master_loudness`
- “Send guest their stem” / review packs

Do **not** use this for Spotify/Apple delivery — use [podcast-master-export](../podcast-master-export/SKILL.md).

## MCP / CLI (same service)

```text
bounce_audio_tool(
  project_path,
  track_ids=None | ["host", "guest"],
  start_s=None,   # timeline seconds
  end_s=None,
  formats=["wav"] | ["wav", "mp3"],
)
```

CLI twin:

```bash
podcast pipeline bounce --project PATH [--tracks host,guest] [--start SEC] [--end SEC] [--formats wav,mp3]
```

Outputs land in `{workspace}/export/bounces/`.

## Notes

- Export runs in place from the Edit action bar, with progress and Cancel, and
  the toast offers Download. Leaving the stage does not stop the job.

- Studio selected-range Export uses a fixed exact target. It exports selected
  occurrences/lanes and preserves silent gaps between islands; a changed target
  rejects before output. Share guests cannot export it.

- Omit `track_ids` / `--tracks` → all **non-muted** mixable tracks with media
- Renders stems into a **private bounce temp dir** (does not overwrite shared
  `artifacts/tracks/` — safe concurrent with GUI refresh-mix)
- Unscoped bounce clamps to clip timeline extent (`timeline_duration_sec`) when
  the mix is longer than the edit
- Times are **timeline** clock ([tool_timebase](../../../src/podcast_mcp/util/tool_timebase.py))
- Does **not** write `master_qc.json` / `export_qc.json`
- Encode/copy shares [`write_audio_formats`](../../../src/podcast_mcp/export/audio.py) with master deliverables; bounce still mixes stems/range itself (no loudness)

The bounce sum is a unity sum trimmed under the same `mix.premix_peak_ceiling_db` true-peak ceiling as the premix.
