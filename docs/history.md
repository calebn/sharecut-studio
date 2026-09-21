# Edit history and undo/redo

Podcast MCP uses **non-destructive editing** at two levels:

1. **Source media** — Files in `raw/` are never overwritten. Cuts and effects are applied only at render time via `edit_decisions` and FFmpeg.
2. **Editable state history** — Tracks, transcripts, edit decisions, envelopes, and processing chains are snapshotted so you can move backward and forward through changes.

## Storage layout

```
episode/
├── raw/                          # untouched recordings
├── episode.project.json          # current state + history index
└── history/
    ├── index.json                # cursor + entry list
    └── snapshots/
        ├── abc123.json           # editable-state snapshot
        └── def456.json
```

Each snapshot stores a **full copy** of editable v2 sections (not diffs), so undo/redo and arbitrary cursor jumps are O(1):

- `sources`, `timeline` (tracks + clips), `editorial`, `transcripts` (per_track + combined)
- `mix`, `social`, `review` (timeline comments), `render_last_completed_step`

Undo/redo restores the snapshot and **`ProjectStore.commit()`** writes `episode.project.json`.

Pipeline run logs stay on the project file and are not reverted by undo (only editable layers).

History publication is ordered: a new snapshot is written completely before
`history/index.json` is updated. The index is published with an atomic replace,
so concurrent readers observe either the previous complete index or the new
complete index, never a truncated JSON file.

See [episode-format-v2.md](episode-format-v2.md) for the canonical project layout.

## CLI

```bash
podcast history list --project episode.project.json
podcast history record --project episode.project.json --label "before manual tweak"
podcast history goto --project episode.project.json --index 2
podcast history goto --project episode.project.json --index 2 --rerender  # full stems/premix
podcast history diff --project episode.project.json
podcast undo --project episode.project.json
podcast redo --project episode.project.json
podcast history-status --project episode.project.json   # JSON: cursor, can_undo, can_redo
```

`goto` / `undo` / `redo` **invalidate stem hash sidecars** so `play processed:*` does not trust WAVs built for another history cursor. Without `--rerender`, play falls back to **segment render** (fast A/B). Pass `--rerender` / `rerender=true` when you need full stems or premix.

Bleed mute (`apply_transcript_gate_tool`) sets `track.transcript_gate` in the project snapshot. That flag is what makes history A/B audible: segment render re-applies the gate when the flag is on, and skips it after undo.

Snapshots are recorded automatically before/after:

- `episode add-track`
- `transcribe`, `propose-edits`
- `pipeline run` (before run, after each step, after run)
- Timeline mutations via `EditService.mutate()` (paired `before …` / `after …` entries)
- `render_preview` when automation envelopes change

## Structured history metadata

Each `HistoryEntry` may include:

- `operation` — stable tool name (e.g. `ripple_delete`, `approve_edits`, `render_preview`)
- `params` — echoed invocation args (`timeline_start`, `fade_ms`, `track_id`, …)

`history_list` / `history-status` return flat `entries` plus grouped `groups` that pair before/after mutation snapshots into one user action. Each group includes a human-readable **`title`** (operation + time range / tracks when `params` are present).

`history diff` compares two snapshot indices and returns clip/decision/mix deltas (see `history/diff.py`) plus a **`summary`** string list (see `history/summary.py`) for GUI/CLI/MCP consumers.

## MCP tools

- `history_list` — entries, cursor, and grouped mutations
- `history_status_tool` — cursor and undo/redo flags (JSON)
- `history_goto_tool` — jump to snapshot index (`rerender=true` optional; always invalidates stem hashes)
- `history_diff_tool` — structured delta between indices
- `history_record` — manual snapshot
- `history_undo` / `history_redo` — navigate history (`rerender=true` optional; stem hashes cleared either way)

### GUI (Sharecut Studio)

History tab **Undo** / **Redo** submit document commands `UndoHistory` / `RedoHistory` via `POST /api/document/command` → `HistoryService` (same path as MCP/CLI). Applied snapshots include lean `history.groups` (not cursor flags only), and the client marks history hydrated when those groups arrive, so the step list updates after comments, track rename/reorder, and other targeted patches without leaving the tab. See [session-sync.md](session-sync.md) and [daw-editing.md](daw-editing.md).

See [gui-integration.md](gui-integration.md) for GUI-oriented undo and rerender guidance.

## Branching

If you undo and then make a new edit, snapshots after the current cursor are **discarded** (standard undo-stack behavior). Older snapshots remain on disk for audit but are no longer on the active branch.

## Rendering after undo

Undo changes edit decisions and mix settings, not exported files. Re-run the pipeline from the appropriate step (e.g. `assemble_timeline`) to refresh `artifacts/` and `export/`.

## For contributors and skill authors

When adding MCP tools, CLI commands, or agent skills that change episode state:

- Route undoable work through `ProjectWorkspace.mutate()` (see [contributing.md § History](contributing.md#history-non-destructive-undoable-state)).
- Domain logic stays in `edits/`; services own `mutate` labels; adapters stay thin.
- Skills should document which tool to use for batch undo (e.g. `apply_transcript_cleanup_tool`) and when to call `history_undo`.

Agent entry points: [.agents/INSTRUCTIONS.md](../.agents/INSTRUCTIONS.md), [.agents/rules/engineering-standards.md](../.agents/rules/engineering-standards.md).
