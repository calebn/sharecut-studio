"""Harsh and listen-one-by-one flags on tighten hits, and the Apply suggested actions entry points."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.tighten_hits import (
    is_harsh_tighten_hit,
    is_listen_one_by_one_hit,
)
from podcast_mcp.gui.mapper import map_pending_edits_to_timeline
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
from podcast_mcp.util.coded_error import CodedValueError


def _decision(did: str, reason: str, *, review: bool = False, start: float = 1.0) -> EditDecision:
    return EditDecision(
        id=did,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=start + 0.3,
        reason=reason,
        review_required=review,
        applied=False,
    )


HITS = [
    _decision("safe", "filler:um", start=1.0),
    _decision("risky", "filler:uh:risky", start=2.0),
    _decision("join", "pause:0.8s:join_review", review=True, start=3.0),
    _decision("review", "repetition:word:the", review=True, start=4.0),
    _decision("nl", "nl:topic", start=5.0),
]


def test_harsh_is_review_or_join_risk_on_tighten_hits_only() -> None:
    assert {d.id: is_harsh_tighten_hit(d) for d in HITS} == {
        "safe": False,
        "risky": True,
        "join": True,
        "review": True,
        "nl": False,
    }
    assert is_harsh_tighten_hit(_decision("nl-review", "nl:topic", review=True)) is False


def test_a_pause_trim_that_stays_for_review_is_listened_to_one_by_one_and_never_eligible() -> None:
    # One that passed the checks that keep a filler from review is applied like a filler.
    auto = _decision("auto", "pause:1.10s:solo", review=False)
    held = _decision("held", "pause:1.10s:solo:voiced_edge", review=True)

    assert not is_harsh_tighten_hit(auto)
    assert not is_listen_one_by_one_hit(auto)
    assert is_harsh_tighten_hit(held)
    assert is_listen_one_by_one_hit(held)
    assert [d.id for d in HITS if is_listen_one_by_one_hit(d)] == ["join"]


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
    proj.edit_decisions = [d.model_copy() for d in HITS]
    save_project(proj, Path(path))


def _pending(path: str) -> list[str]:
    return sorted(d.id for d in load_project(Path(path)).edit_decisions if not d.applied)


def test_studio_view_carries_the_same_harsh_and_listen_one_by_one_flags(
    tmp_path, sample_wav
) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    proj = load_project(Path(path))
    rows = map_pending_edits_to_timeline(proj, proj.edit_decisions)
    assert {r["id"]: r["harsh"] for r in rows} == {
        "safe": False,
        "risky": True,
        "join": True,
        "review": True,
        "nl": False,
    }
    assert {r["id"]: r["listen_one_by_one"] for r in rows} == {
        "safe": False,
        "risky": False,
        "join": True,
        "review": False,
        "nl": False,
    }


def test_studio_view_sends_the_review_kind_and_raw_sound_kind(tmp_path, sample_wav) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    proj = load_project(Path(path))
    proj.edit_decisions.append(
        _decision("laugh", "filler:acoustic:likely_laugh", start=6.0),
    )
    rows = map_pending_edits_to_timeline(proj, proj.edit_decisions)
    assert {r["id"]: (r["kind"], r["sound_kind"]) for r in rows} == {
        "safe": ("filler", "filler"),
        "risky": ("filler", "filler"),
        "join": ("pause", "pause"),
        "review": ("repeat", "repetition"),
        "nl": ("other", None),
        "laugh": ("sound", "laugh"),
    }


def test_apply_suggested_actions_tool_applies_every_listed_sound(tmp_path, sample_wav) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    out = json.loads(mcp_server.apply_suggested_actions_tool(path, ["safe", "nl"]))
    assert out["applied"] == {"cut": 1}
    assert out["held"] == []
    assert _pending(path) == ["join", "nl", "review", "risky"]


def test_approve_edits_tool_needs_ids(tmp_path) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    with pytest.raises(CodedValueError, match="pass ids or all_pending=true"):
        mcp_server.approve_edits_tool(path)


def test_cli_apply_suggested_is_one_undo_step(tmp_path, ten_second_silence_wav) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, ten_second_silence_wav)
    runner = CliRunner()
    result = runner.invoke(
        app, ["edit", "apply-suggested", "--project", path, "--ids", "safe,risky"]
    )
    assert result.exit_code == 0, result.output
    assert result.output.startswith("Applied 2 cut")
    assert _pending(path) == ["join", "nl", "review"]
    assert runner.invoke(app, ["undo", "--project", path]).exit_code == 0
    assert _pending(path) == ["join", "nl", "review", "risky", "safe"]
