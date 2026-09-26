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
complete index, never a truncated JSON file. Code reads the index through `project_store.read_history_index` (absent: `None`; unreadable or invalid: `ValueError`), and each caller chooses its fallback.
A long job's entries (`before pipeline run`, `after <step>`, `after pipeline run`, the merge entry) are recorded inside `ProjectWorkspace.save_merged(history_label=...)`, in the same locked merge and commit. On a conflict, or a commit that fails before the project file is replaced, the in-memory history and `history/index.json` are restored, and every snapshot file written during that call is removed (`project_store.rollback_history`; a snapshot is deleted only once the index no longer lists it). Cleanup failures are logged and the original error still propagates. If the file was replaced and only the transcript cache write failed, memory adopts the saved state. If the project file cannot be stat'ed after the failure, only the in-memory history is restored; the index and snapshots stay on disk, because an orphaned snapshot is harmless and a deleted referenced one is not. A corrupt `history/index.json` does not stop the job: a failed save restores it from the saved project's history. An undo, redo or goto by another request during a job, including before a pipeline's first step, conflicts at `history.lineage` rather than interleaving entries; the message says an undo or redo changed the project and asks for a re-run. Two undo/redo moves to different entries with no new entries on either side conflict at `history.cursor` with the same message. These checks assume every writer of `episode.project.json` and `history/` holds `project_commit_lock`, as every in-tree writer does; writers in other processes are #213.
`run_mutation` compensates its own failure the same way (`history/rollback.py`: `take_history_checkpoint`, then `rolled_back_on_failure` around the record/commit steps). If `record(before)`, `mutate`, the audio bookkeeping, `record(after)` or the commit raises (any `BaseException`, including a commit-lock timeout or `KeyboardInterrupt`), it takes `project_commit_lock` once and, in that one hold, checks whether the commit landed (`project_store.commit_landed`) and rolls back: it puts `history/index.json` back to its pre-call payload, deletes the snapshots this call wrote (`project_store.rollback_own_history`) and restores the in-memory `project.history`, so the redo branch comes back and no dangling `before` entry is left. The history is kept when the commit landed (the project file revision changed and only a later write failed). When the project file cannot be stat'ed, only memory is restored. When another writer recorded on top of this call's entries, or the rollback itself fails, the index on disk is kept and `project.history` adopts it (the pre-call history if the index is unreadable), so the next commit does not overwrite it; a warning is logged. The index counts as this call's when it equals the pre-call payload or one this call wrote; that is sound because every entry id is a fresh uuid, so no other writer can produce an identical payload. Cleanup failures are logged and the original error propagates. `ProjectWorkspace.record_snapshot` and `history.manager.record_if_changed` record and commit through `history.manager.record_and_commit`, which rolls back the same way. Restoring the rest of the in-memory editable state after a record/commit failure is #489.
Review mix publication relies on that rollback and deletes its generated media only when the version is not in the canonical project and the history index is back to its pre-publication payload. A version already present in the canonical project keeps its history and media.

History record/undo/redo/goto and `ProjectStore.commit` run under `project_commit_lock` (an in-process lock plus a per-workspace file lock at `artifacts/episode.project.json.lock`, kept outside `history/`). `ReviewService.publish` stages media (copy + MP3) outside the file lock, then holds it from the history-index read through commit and failure cleanup, so no other process can commit the failed version between the canonical check and media deletion. Staging still holds the in-process `project_state_lock`, so other threads in the same process that need this workspace (mutations, render snapshots, GUI requests) wait for the copy and MP3 encode; this keeps stage + attach atomic against in-process writers. The source premix is resolved and checked when staging, not re-validated under the file lock, so another process can re-render `premix.wav` before the version is attached; the version's `sha256` still matches its own copied `mix.wav`, and the lock does not guarantee premix freshness. If the lock cannot be taken or the history index cannot be read, the staged media is removed before the error propagates. Loads stay unlocked, so the lock orders writes but does not prevent lost updates: `run_mutation` releases it between `record(before)` and `record(after)`, and a workspace whose in-memory history predates another process's commit overwrites that commit's index and project JSON. Lost-update prevention is tracked in #213 and #426.

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

With `rerender=true` the move and its stale marks are committed first, in one step under `project_commit_lock`, so no other writer's commit lands between them. The render then runs between `checkpoint()` and `save_merged()`, so an edit another request saved meanwhile is merged in as an `after merging concurrent edits` entry, and the returned cursor points at that entry (not at the move's target). The move stays saved whatever happens next: a same-value clash raises `ProjectMergeConflict` and a failed render raises `HistoryRerenderError`, and both messages say to re-render the preview, not to repeat the move. The document plane (`UndoHistory` / `RedoHistory`) returns both as a 409 conflict with that message. A failed render also drops its partial in-memory state from the workspace (`ProjectWorkspace.discard_changes()`), so a caller that keeps the workspace sees the saved move, not a half-rendered project. If another undo or redo moved the cursor during the render (`history.lineage` / `history.cursor`), the message says to check `history_status` before re-rendering instead, since the saved cursor is no longer this move's.

Bleed mute (`apply_transcript_gate_tool`) sets `track.transcript_gate` in the project snapshot. That flag is what makes history A/B audible: segment render re-applies the gate when the flag is on, and skips it after undo.

Snapshots are recorded automatically before/after:

- `episode add-track`
- `transcribe`, `propose-edits`
- `pipeline run` (before run, after each step, after run, recorded inside `save_merged(history_label=...)`; plus `after merging concurrent edits` when a save merged in another request's change)
- Timeline mutations via `EditService.mutate()` (paired `before …` / `after …` entries)
- `render_preview` when automation envelopes change

## Structured history metadata

Each `HistoryEntry` may include:

- `operation` — stable tool name (e.g. `ripple_delete`, `approve_edits`, `render_preview`)
- `params` — echoed invocation args (`timeline_start`, `fade_ms`, `track_id`, …)

`history_list` / `history-status` return flat `entries` plus grouped `groups` that pair before/after mutation snapshots into one user action. Each group includes a human-readable **`title`** (operation + time range / tracks when `params` are present). The History tab virtualizes long group lists (≥200 steps) so a many-entry history keeps the DOM bounded.

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
