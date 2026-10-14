"""Bulk apply for non-speech suggested actions (#1434)."""

from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.transcript_refine_status import mark_refine_done
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import (
    Clip,
    CutSpeech,
    CutSpeechTrack,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService


def _decision(did: str, reason: str) -> EditDecision:
    return EditDecision(
        id=did,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=1.0,
        end=1.3,
        reason=reason,
        review_required=True,
        applied=False,
    )


def _seed(path: str, sample_wav) -> None:
    media_path = Path(path).parent / "raw" / "host.wav"
    media_path.write_bytes(sample_wav.read_bytes())
    proj = load_project(Path(path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    proj.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0)
    ]
    proj.edit_decisions = [
        _decision("cut", "filler:um"),
        _decision("leave", "filler:acoustic:likely_laugh"),
    ]
    save_project(proj, Path(path))


def test_apply_suggested_actions_cuts_and_leaves(tmp_path, sample_wav) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    out = json.loads(mcp_server.apply_suggested_non_speech_actions_tool(path))
    assert out["applied_cuts"] == 1
    assert out["left"] == 1
    assert out["outcomes"] == 2
    proj = load_project(Path(path))
    pending = [d.id for d in proj.edit_decisions if not d.applied]
    assert pending == []
    assert len(proj.editorial.non_speech_outcomes) == 2


def test_apply_suggested_actions_rolls_back_on_unconfirmed_cut_speech(tmp_path, sample_wav) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    media_path = Path(path).parent / "raw" / "host.wav"
    media_path.write_bytes(sample_wav.read_bytes())
    guest_path = Path(path).parent / "raw" / "guest.wav"
    samples = np.zeros(96_000, dtype=np.float32)
    samples[16_000:32_000] = 0.2 * np.sin(2 * np.pi * 330 * np.arange(16_000) / 16_000)
    with wave.open(str(guest_path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16_000)
        handle.writeframes((samples * 32767).astype("<i2").tobytes())
    proj = load_project(Path(path))
    proj.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            speaker="Guest",
            media=MediaAsset(path="raw/guest.wav", duration_sec=6.0),
        ),
    ]
    proj.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0),
        Clip(id="c2", track_id="guest", source_start=0.0, source_end=6.0, timeline_start=0.0),
    ]
    proj.transcripts = [
        Transcript(
            track_id="guest",
            words=[TranscriptWord(text="hello", start=1.1, end=1.8)],
        )
    ]
    cut = _decision("cut", "filler:um")
    cut.start = 1.0
    cut.end = 2.0
    cut.cut_speech = CutSpeech(
        spans=[RangeInterval(start=1, end=2)],
        tracks=[CutSpeechTrack(track_id="guest", speaker="Guest")],
    )
    proj.edit_decisions = [
        _decision("leave", "filler:acoustic:likely_laugh"),
        cut,
    ]
    mark_refine_done(proj, notes="Known synthetic transcript fixture; no real-project acceptance")
    save_project(proj, Path(path))
    ws = ProjectWorkspace.open(path)
    ws.record_snapshot("initial", force=True)
    saved_before = ws.path.read_bytes()

    outcome = EditService(ws).apply_suggested_non_speech_actions()
    assert outcome["unchanged"] is True
    assert outcome["needs_confirmation"]["reason"] == "cuts_other_speech"
    assert outcome["left"] == 0
    assert outcome["lowered"] == 0
    assert outcome["outcomes"] == 0
    assert ws.path.read_bytes() == saved_before
    reloaded = load_project(ws.path)
    assert len(reloaded.editorial.non_speech_outcomes) == 0
    assert {d.id for d in reloaded.edit_decisions if not d.applied} == {"leave", "cut"}


def test_cli_apply_suggested_actions(tmp_path, sample_wav) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    result = CliRunner().invoke(app, ["edit", "apply-suggested-actions", "--project", path])
    assert result.exit_code == 0, result.output
    assert "1 cut(s)" in result.output
    assert "1 left" in result.output
