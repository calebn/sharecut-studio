"""Apply eligible: one harsh rule and one listen-one-by-one rule for Studio and agents."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.tighten_hits import (
    eligible_tighten_ids,
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
    assert eligible_tighten_ids([auto, held, HITS[0]]) == ["auto", "safe"]


def test_eligible_ids_skip_harsh_applied_and_non_tighten() -> None:
    applied = _decision("done", "filler:um")
    applied.applied = True
    assert eligible_tighten_ids([*HITS, applied]) == ["safe"]


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


def test_approve_edits_tool_apply_all_safe_applies_only_eligible(tmp_path, sample_wav) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    out = json.loads(mcp_server.approve_edits_tool(path, apply_all_safe=True))
    assert out == {
        "operation": "approve_edits",
        "approved_count": 1,
        "ids": ["safe"],
        "skipped_harsh": ["risky", "join", "review"],
    }
    assert _pending(path) == ["join", "nl", "review", "risky"]


def test_apply_all_safe_narrows_to_listed_ids(tmp_path, sample_wav) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    out = json.loads(mcp_server.approve_edits_tool(path, ["risky", "nl"], apply_all_safe=True))
    assert out["ids"] == []
    assert out["skipped_harsh"] == ["risky"]
    assert _pending(path) == ["join", "nl", "review", "risky", "safe"]


def test_approve_edits_tool_needs_ids_without_apply_all_safe(tmp_path) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    with pytest.raises(ValueError, match="apply_all_safe"):
        mcp_server.approve_edits_tool(path)


def test_cli_approve_all_safe_is_one_undo_step(tmp_path, sample_wav) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    runner = CliRunner()
    result = runner.invoke(app, ["edit", "approve", "--project", path, "--all-safe"])
    assert result.exit_code == 0, result.output
    assert "Approved 1 edit(s); skipped 3 as harsh." in result.output
    assert _pending(path) == ["join", "nl", "review", "risky"]
    assert runner.invoke(app, ["undo", "--project", path]).exit_code == 0
    assert _pending(path) == ["join", "nl", "review", "risky", "safe"]
