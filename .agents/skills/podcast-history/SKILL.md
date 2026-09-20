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

`goto` / undo / redo clear stem hash sidecars so `play processed:*` segment-renders the restored timeline (fast A/B). Pass `rerender=true` / `--rerender` only when you need full stems or premix.

## After undo

Re-render if needed:

```bash
podcast pipeline run --project episode.project.json --from assemble_timeline
```

## MCP

- `history_list`, `history_record`, `history_goto_tool`, `history_undo`, `history_redo` (`rerender=true` optional; stem hashes always invalidated on navigate)

See [docs/history.md](../../docs/history.md).
