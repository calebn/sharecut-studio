"""Document-plane speaker label handler (#1849)."""

from __future__ import annotations

from typing import Any

from podcast_mcp.engines.speaker_id import label_window, resolve_speaker_backend
from podcast_mcp.project.transcript_context import load_transcript_context
from podcast_mcp.services.app import ProjectWorkspace


def label_speaker_window(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    """Label one track's words in a window and save it as one undoable step.

    The window is scored inside the mutation, so the project lock is held while it runs,
    as for the home-speaker gate. The commit's combined-transcript hook re-merges combined.
    """
    track_id = str(p["track_id"])
    start_sec = float(p["start_sec"])
    end_sec = float(p["end_sec"])
    ctx = load_transcript_context(ws.project.workspace_path())
    backend = resolve_speaker_backend()
    return ws.mutate(
        "before speaker label",
        "after speaker label",
        lambda project: label_window(
            project, track_id, start_sec, end_sec, ctx.speaker_id, backend, dry_run=False
        ),
    )
