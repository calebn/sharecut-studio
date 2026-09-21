---
name: podcast-social-clips
description: >-
  Find and export short social-media clip candidates from podcast transcripts.
  Audio export today; video crop/captions are TODO. Use for TikTok, Reels,
  Shorts, LinkedIn clips via MCP or CLI.
---

# Social clips

## Harness

**MCP:** `propose_social_clips_tool`, `list_social_clips_tool`, `social_clip_report_tool`, `approve_social_clips_tool`, `reject_social_clips_tool`, `export_social_clips_tool`.

**CLI:** `podcast clips propose`, `podcast clips report`, `podcast clips approve`, `podcast clips export`.

## Workflow

1. Episode should have `transcribe` + `merge_transcript` (or full pipeline through mix).
2. Prefer listenable audio: `artifacts/premix.wav` or `export/{name}.wav`. `{name}`
   is a portable sanitized export stem; e.g. `My Episode: Part 1/2` is
   `My_Episode_Part_1_2.wav` (never a nested export path).
3. `propose_social_clips_tool` with optional `platform` (`tiktok`, `reels`, `linkedin`, `youtube_shorts`) — adjusts max duration via `.agents/defaults/pipeline.yaml`.
4. `social_clip_report_tool` — present top candidates with score, timestamps, title/caption suggestions.
5. User picks clips → `approve_social_clips_tool` with JSON id array.
6. `export_social_clips_tool` → `export/clips/*.wav` + sidecar JSON per clip.

## Agent refinement

- Promote/demote candidates in conversation; use `reject_social_clips_tool` for bad picks.
- Narrow boundaries with `cut_time_range_tool` on the source track if a clip starts/ends late (re-propose optional).
- Use `search_transcript_tool` when user asks for clips about a topic (*"clips about pricing"*).

## Video (TODO)

Not implemented yet. Exported JSON includes `start`/`end` for a future video pipeline (9:16 crop, burned-in captions, multicam). Do not promise MP4 export in v1.

## Clocks

Candidates are **scored** on source-clock combined utterances but store **timeline** `start`/`end` (mapped through `SessionTimeline`), because export cuts the premix/mastered audio which runs on the timeline clock. So candidate times line up with the listenable WAV, not the raw source. If you narrow a boundary with `cut_time_range_tool`, pass **source** seconds (re-propose to refresh mapped candidate times). See [docs/social-clips.md](../../docs/social-clips.md).

## Non-destructive

Clip export reads premix/export WAV only; source `raw/` is untouched. Snapshots recorded on propose/approve.
