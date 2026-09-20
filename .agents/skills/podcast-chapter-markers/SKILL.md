---
name: podcast-chapter-markers
description: >-
  Add chapter markers to an episode and export with metadata. Use when the user
  wants chapters for Apple Podcasts or show notes.
---

# Chapter markers

## Tools

- `add_chapter_tool(project_path, at_time, title)` — `at_time` is **timeline seconds** (position on the mastered export), not source-media time
- `remove_chapter_tool(project_path, title)` — remove by title (all markers with that title)
- `list_chapters_tool`
- Sharecut Studio / guest document command `DeleteChapter` matches `(time, title)` when two chapters share a title
- `pipeline_run` / export — chapters written to `export/<name>.chapters.json`; MP3 gets title metadata

## NL workflow

1. `search_transcript_tool("interview starts")` → use match **`timeline_start`** (the mapped deliverable clock), not `start` (source clock). If `timeline_start` is `null`, that span was cut — pick another anchor.
2. `add_chapter_tool(project_path, at_time=timeline_start, title="Interview")`
3. `render_final` or full pipeline to refresh export

Using `start` (source seconds) here would place chapters at the wrong point on the edited audio whenever cuts precede the anchor.
