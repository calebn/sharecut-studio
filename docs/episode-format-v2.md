# Episode Project Format v2

Canonical file: `episode.project.json` in the episode workspace.

Version `2.0` is the **single source of truth** for editable project state. CLI, MCP, pipeline, and history all load and commit through `ProjectStore`.

## Workspace layout

```
my_episode/
├── episode.project.json    # v2 project (required)
├── raw/                    # Source / consolidated audio (never overwritten by edits)
├── transcripts/            # Optional write-through caches (not authoritative)
├── history/
│   ├── index.json          # Mirror of project.history (optional)
│   └── snapshots/          # Full editable-state snapshots for undo/redo
├── artifacts/              # Rendered intermediates (premix, per-track WAVs)
└── export/                 # Final deliverables (WAV, MP3, SRT, MD)
```

## Top-level sections

| Section | Purpose |
|---------|---------|
| `meta` | `name`, `workspace_dir`, `created_at`, `schema_id`. On disk, `workspace_dir` is always `"."`; `load_project` remaps to the directory containing `episode.project.json`. Media and source paths are workspace-relative (never absolute host paths). |
| `sources` | Raw ingest files, alignment offsets (pre- or post-consolidation). Recorded keepers also carry `clipping_regions[]` (`start_s`/`end_s`, source seconds): sample-peak clipping the browser encoder detected (-1 dBFS), written at landing; `clipping_truncated` (the encoder hit its region cap); `list_clips` reports each clip's share as `clipping_regions` and `clipping_truncated`. Consolidated sources carry none |
| `timeline` | `tracks`, `clips` (placement on session clock), `duration_sec` |
| `editorial` | Non-destructive `edit_decisions` (remove/mute ranges; `split` blade proposals use timeline clock via `timebase`); `edit_log` (committed-cut provenance) |
| `transcripts` | `per_track[]` word-level ASR; `combined` utterances for NL editing |
| `mix` | `processing_chains` (per-track `effects[]` with `effect`, `params`, optional `bypass`), `automation_envelopes` |
| `render` | `last_completed_step`, `pipeline_runs`, `artifacts` paths; `reconciliation_stale` / `last_reconciliation_hash`; `invalidations[]` (diagnostic cause journal since last fresh stem) |
| `social` | Social clip candidates |
| `review` | Timeline comments and action items (session-clock feedback) |
| `history` | Undo/redo cursor and snapshot index |

`history` is always an object: a project with no recorded snapshots saves an empty `ProjectHistory` (`{"cursor": -1, "entries": []}`), and a legacy `"history": null` loads as that empty history. A track's optional `room_tone` and `proxy` are saved as `null` when absent; `schemas/episode.project.schema.json` accepts that, so a file written by `save_project` validates as-is.

Each automation envelope point has an immutable `id` plus its mutable `time` and
`value`. Editors preserve the ID while points move or reorder it; new points get
an ID at model creation. This gives the GUI a stable React identity during drag
operations and prevents an index shift from attaching a DOM node to the wrong
point.

Older project files whose envelope points have no IDs remain readable. On load,
the model assigns deterministic IDs from the envelope track, parameter, and
stored point position; the next normal project save persists those IDs. Point
IDs do not affect audio render or reconciliation fingerprints.

## Transcripts (canonical in project file)

After transcription, **`transcripts.per_track`** must be present in `episode.project.json`. Each entry:

```json
{
  "track_id": "host",
  "language": "en",
  "words": [
    { "text": "hello", "start": 0.5, "end": 0.9, "confidence": 0.95 }
  ]
}
```

Word `start`/`end` (and combined utterance times) are **source-media seconds** on that track's raw file — never the edited timeline. Edits move clips, not word times.

`transcripts.combined` holds time-ordered utterances for search, NL cuts, and SRT export. Exports map these to the timeline clock at write time.

Files under `transcripts/*.json` are **caches only**; `ProjectStore.commit()` may refresh them from the project.

`transcripts.per_track[].vocabulary_revision` records the `transcript_context.yaml` vocabulary revision whose Whisper prompt produced that transcript. Studio asks for re-transcription when any stored transcript has a different revision than the context; a project with no transcripts never asks. Single-track runs stamp only that track, and a failed or empty transcription leaves existing stamps unchanged.

## Timebase invariant

**All stored times (`TranscriptWord`, `EditDecision` remove/mute, `CombinedUtterance`) are source-media seconds; blade `EditDecision` with `type: split` and `timebase: timeline` stores the cut as timeline seconds (`start == end`); `timeline.clips` is the only bridge; anything that touches rendered audio (stems, premix, mastered, export) must map through `SessionTimeline`.**

Two clocks exist:

| Clock | Unit | Where it lives |
|-------|------|----------------|
| **Source** (`SourceSec`) | Seconds into a track's raw media file | `TranscriptWord.start/end`, `EditDecision.start/end`, `CombinedUtterance.start/end` |
| **Timeline** (`TimelineSec`) | Seconds on the edited session/deliverable clock | Rendered stems, `artifacts/premix.wav`, mastered WAV, SRT/VTT captions, social clips, chapters, `review.comments` |

`engines/session_timeline.py` (`SessionTimeline`) is the single hub that maps between them, driven by `timeline.clips`. Consumers never do clip arithmetic inline — see [architecture.md § Timebase](architecture.md#timebase-source-vs-timeline-clock).

## Timeline and render

- **`timeline.tracks`** — ordered list of tracks (array order is Arrange lane order / display order; reorder with `ReorderTrack`). Per-track `gain_db` (staging gain the pipeline's balance step writes), `fader_db` (the user's saved volume, −60 to +12 dB; the mix plays `gain_db + fader_db` and balance never touches it), `muted` (saved mix mute: the mix, play and bounce leave the track out; edits, stems and analysis such as the audio audit still cover it, so a muted track stays in sync and unmutes cleanly), and `transcript_gate` (when true, rendered stems/segments mute outside non-suppressed word intervals after bleed mute). Optional `room_tone` (`MediaAsset`, typically `raw/room-tone/{session}/{participant}.wav` from the record lobby; the older `raw/room-tone/{participant}.wav` path still works for existing projects): filler pads with `filler_pad_mode: room_tone` prefer this bed (abutting tiles with fade-in on the first tile and fade-out on the last when longer than the bed) over stolen stem air. A near-silent bed is ignored. Optional `proxy` (`TrackProxy`): FX source-clock guest proxy fingerprint (`hash`), chunk grid (`chunk_sec`, `overlap_ms`, `chunk_count`), and object storage prefix when uploaded. Proxies exclude timeline edits — guests schedule clips client-side.
- **`timeline.clips`** define what is heard and when: `source_start`/`source_end` in media time, `timeline_start` on the session clock. `Clip.timeline_end` is the one clip-geometry property. Optional `mute_regions[]` (`{start_s, end_s}` source-media seconds) render as silence with ≤5 ms fades (mute-in-place tighten); they do not change clip offsets or session duration.
- **`editorial.edit_decisions`** apply in **source media time** (overlap with each clip).
- **`editorial.edit_log`** archives committed cuts after `approve_edits`, `apply_auto_edits`, or direct timeline ops (`ripple_delete`, etc.). Each `AppliedEditRecord` retains `reason`, source/timeline ranges, `operation`, and echoed tool `params`. Undo restores the log with other editorial state.
- **`render.invalidations[]`** records why stems are dirty since the last fresh render (`reason`: cut/clip/envelope/fx/gain/mute/other; optional `timeline_start`/`timeline_end`). Cleared per track when that stem’s hash is rewritten. Freshness itself stays derived from artifact hashes — invalidations are for UI/agents, not a second source of truth for `needs_rerender`.
- Render path: clips → per-track WAV → mix → `artifacts/premix.wav` → master → `export/`. Stems don't bake the track gain; the mix applies each track's output gain. `artifacts/premix.hash` fingerprints the mix itself: which tracks it played (media, not muted) and each one's output gain, in any order. A volume or mute change reports `render_status.premix.stale_vs_mix` and `needs_rerender` without staling any stem; a premix from before the hash counts as stale once any fader is off 0 dB or any track is muted. `artifacts/mastered.hash` fingerprints the premix `mastered.wav` was mastered from (its mix hash plus file size/mtime). Export re-masters when it doesn't match, and first re-renders and re-mixes a premix that's stale (saved mix changed, a mixed stem newer than it, or a rendered mixed stem behind its edits). Publishing a review version refuses a stale premix, or, while `premix.wav` exists, a master not mastered from the current premix (including one with no `mastered.hash`, until export re-masters it); with only `mastered.wav` and no premix, publish ships that master as-is.

If no clips exist, ingest/pipeline creates one full-span clip per dialogue track.

## History

Each undo point stores a **full snapshot** of editable sections (not a diff): `sources`, `timeline`, `editorial`, `transcripts`, `mix`, `social`, `review`, `render_last_completed_step`, and `meta.ingest_alignment` when present.

## Review comments

`review.comments[]` holds human/agent feedback on the **timeline** clock (what listeners hear on premix/review). Each comment may be an instant (`timeline_end` null or equal to start) or a contiguous span, optionally scoped to one or more `track_ids` (empty = session-wide). Nested `action_items` track checkable work with `completed_by` / `completed_at`; `replies[]` is a flat thread. Optional `edit_decision_id` binds **one** comment thread to a pending `editorial.edit_decisions[]` row (unique among comments; lazy-created on first Ask). Optional `review.versions[]` / `active_version_id` freeze review mixes (`audio_relpath` WAV + optional `mp3_relpath` / `object_store_key` for guest ReviewApp; both relpaths must resolve inside `artifacts/review/` — see timeline-comments.md); comments may stamp `review_version_id`. See [timeline-comments.md](timeline-comments.md).

Undo/redo restores snapshot → `ProjectStore.commit()` updates `episode.project.json`.

## Version policy

Only **`version: "2.0"`** is supported. Older flat layouts are rejected at load time. The format may change freely until the first public release.

## Prior art

Influenced by OpenTimelineIO (tracks/clips), Descript (transcript-first edits), and REAPER-style declarative session + render—without reading DAW project files.
