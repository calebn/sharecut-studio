"""TrackView.transcribed: a transcript record exists for the track's current audio (#4712)."""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.gui.assembler import build_track_views
from podcast_mcp.models import MediaAsset, Track, TrackRole, Transcript
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.hashing import sha256_file


def _room(minimal_project: Path) -> tuple[ProjectWorkspace, Path]:
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=1.0),
        )
    )
    return ws, ws.project.workspace_path() / "raw" / "host.wav"


def _transcribed(ws: ProjectWorkspace) -> bool:
    return build_track_views(ws)[0].transcribed


def test_a_record_with_no_words_for_the_current_audio_counts(minimal_project: Path) -> None:
    ws, audio = _room(minimal_project)
    ws.project.transcripts = [
        Transcript(track_id="host", words=[], audio_sha256=sha256_file(audio))
    ]
    assert _transcribed(ws) is True


def test_a_track_with_no_record_is_not_transcribed(minimal_project: Path) -> None:
    ws, _ = _room(minimal_project)
    assert _transcribed(ws) is False


def test_replacing_the_audio_makes_the_record_stale(minimal_project: Path) -> None:
    ws, audio = _room(minimal_project)
    ws.project.transcripts = [
        Transcript(track_id="host", words=[], audio_sha256=sha256_file(audio))
    ]
    assert _transcribed(ws) is True
    audio.write_bytes(audio.read_bytes() + b"\x00\x00" * 4000)
    assert _transcribed(ws) is False
