from __future__ import annotations

from podcast_mcp.models.episode import Transcript, TranscriptWord
from podcast_mcp.services.app import ProjectWorkspace


def transcribed_gate_project(ws: ProjectWorkspace, *, gate: bool) -> None:
    ws.project.tracks[0].transcript_gate = gate
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="hello", start=0.1, end=0.5),
                TranscriptWord(text="there", start=0.6, end=1.0),
            ],
        )
    ]
    ws.save()
