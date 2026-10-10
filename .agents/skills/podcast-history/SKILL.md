---
name: podcast-history
description: >-
  Navigate non-destructive edit history with undo, redo, and manual snapshots.
  Use when reverting tighten edits, track changes, or pipeline tweaks without
  touching raw audio files.
---

# Edit history (undo / redo)

## Principles

- **Raw audio** in `raw/` is never modified.
- **Editable state** (tracks, transcripts, `edit_decisions`, `social_clip_candidates`, envelopes, chains) is snapshotted under `history/snapshots/`.
- Undo restores a prior snapshot; redo moves forward on the stack.

## CLI

```bash
podcast history list --project episode.project.json
podcast history goto --project episode.project.json --index N
podcast undo --project episode.project.json --rerender
podcast redo --project episode.project.json
podcast history record --project episode.project.json --label "before risky change"
```

`goto` / undo / redo stale only the stems the move changed (content-addressed hashes, #424); `play processed:*` segment-renders a stale track (fast A/B), and unchanged tracks keep playing their stem. Pass `rerender=true` / `--rerender` only when you need full stems or premix.

## After undo

For a failed mutation, raw history restoration alone does not certify editable and render recovery. A saved unchanged-project assurance requires the registered restore to finish. A failed restore reports an unknown outcome and preserves the original failure; reload the canonical saved project before continuing. Recovery, notification and logger interruptions cannot replace the original error or authorize deleting review media.

Re-render if needed:

```bash
podcast pipeline run --project episode.project.json --from assemble_timeline
```

## MCP

- `history_list`, `history_record`, `history_goto_tool`, `history_undo`, `history_redo` (`rerender=true` optional; stales only the stems the move changed)
- To undo only the change you inspected, pass `expected_head_id` (the `head_id` from `history_status_tool`) to `history_undo` / `history_redo`, or `--expected-head` to `podcast undo` / `redo`. If someone else's edit landed since, the call refuses with `error_code` `history_stale` and nothing moves; re-check `history_status_tool` before retrying. Without it, the tool undoes whatever is latest, which is allowed on purpose for agents and scripts. A history with no entry yet reports `head_id` `root`. The document-plane `UndoHistory` / `RedoHistory` commands (GUI, guests) always require `expected_head_id`.

See [docs/history.md](../../docs/history.md).
