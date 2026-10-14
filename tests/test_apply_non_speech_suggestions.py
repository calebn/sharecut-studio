"""Bulk apply for non-speech suggested actions (#1434)."""

from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)


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
    pending = [d.id for d in load_project(Path(path)).edit_decisions if not d.applied]
    assert pending == []


def test_cli_apply_suggested_actions(tmp_path, sample_wav) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    result = CliRunner().invoke(app, ["edit", "apply-suggested-actions", "--project", path])
    assert result.exit_code == 0, result.output
    assert "1 cut(s)" in result.output
    assert "1 left" in result.output
