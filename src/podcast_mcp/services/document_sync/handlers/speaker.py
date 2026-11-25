"""Document-plane speaker label handler (#1849)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel

from podcast_mcp.engines.speaker_id import label_window, resolve_speaker_backend
from podcast_mcp.models import EpisodeProject
from podcast_mcp.project.transcript_context import load_transcript_context
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.tracks import unknown_track


class SpeakerLabelResult(BaseModel):
    """What one ``LabelSpeakerWindow`` changed: the words it labelled and the window's score."""

    labeled: int
    role: str
    dry_run: bool = False
    score: dict[str, Any]


def label_speaker_window(ws: ProjectWorkspace, p: dict[str, Any]) -> Mapping[str, Any]:
    """Label one track's words in a window and save it as one undoable step.

    The window is scored inside the mutation, so the project lock is held while it runs,
    as for the home-speaker gate. The commit's combined-transcript hook re-merges combined.
    An unknown track, a track with no transcript or a window that cannot be scored is
    refused, so nothing is journaled for it.
    """
    track_id = str(p["track_id"])
    start_sec = float(p["start_sec"])
    end_sec = float(p["end_sec"])
    ctx = load_transcript_context(ws.project.workspace_path())
    backend = resolve_speaker_backend()

    def mutate(project: EpisodeProject) -> SpeakerLabelResult:
        if not any(t.id == track_id for t in project.tracks):
            raise unknown_track(track_id)
        result = label_window(
            project, track_id, start_sec, end_sec, ctx.speaker_id, backend, dry_run=False
        )
        if "error" in result:
            raise CodedValueError(
                f"speaker label on {track_id!r}: {result['error']}", code="speaker_label_failed"
            )
        return SpeakerLabelResult.model_validate(result)

    labeled = ws.mutate("before speaker label", "after speaker label", mutate)
    return labeled.model_dump(mode="json")
