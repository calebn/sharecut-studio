"""Approving session cuts one at a time shortens the session as approving them together does (#1055).

An approval re-runs the speech-energy scope guard against the project as it stands. After an
earlier approval has rippled the timeline, a rendered stem on disk still has the old timeline,
so reading it at the later cut's timeline seconds finds a peer "speaking" in what is, on the
lanes, silence, and turned the cut into a punch that shortens nothing. The guard reads what the
lanes play instead.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.decisions import ScopeChangedAtApproval, apply_auto_edits, approve_edits
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
)

_SR = 8_000
_SECONDS = 30
_PEER_BURST = (24.0, 24.6)


def _write_wav(path: Path, signal: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (np.clip(signal, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(_SR)
        out.writeframes(data.tobytes())


def _room(seed: int) -> np.ndarray:
    return np.random.default_rng(seed).normal(0.0, 0.0003, _SECONDS * _SR)


def _loud(signal: np.ndarray, lo: float, hi: float) -> None:
    t = np.arange(round(lo * _SR), round(hi * _SR)) / _SR
    signal[round(lo * _SR) : round(hi * _SR)] += 0.1 * np.sin(2 * np.pi * 220.0 * t)


def _project(tmp_path: Path, *, burst: tuple[float, float] = _PEER_BURST) -> EpisodeProject:
    """Host and guest on one clip each. The guest speaks over ``burst`` of the recording;
    both tracks have a rendered stem from before any edit."""
    project = EpisodeProject.create("order", str(tmp_path))
    host, guest = _room(1), _room(2)
    _loud(host, 0.0, 5.0)
    _loud(host, 6.0, 25.0)
    _loud(guest, *burst)
    for track_id, signal in (("host", host), ("guest", guest)):
        _write_wav(tmp_path / "raw" / f"{track_id}.wav", signal)
        _write_wav(tmp_path / "artifacts" / "tracks" / f"{track_id}.wav", signal)
        project.tracks.append(
            Track(
                id=track_id,
                label=track_id,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{track_id}.wav", duration_sec=float(_SECONDS)),
            )
        )
        project.clips.append(
            Clip(
                id=f"{track_id}-all",
                track_id=track_id,
                source_start=0.0,
                source_end=float(_SECONDS),
                timeline_start=0.0,
            )
        )
    return project


def _trim(edit_id: str, start: float, end: float) -> EditDecision:
    return EditDecision(
        id=edit_id,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        reason="pause:1.0s",
        review_required=False,
        scope="session",
        boundary_mode="exact",
    )


def _lane_ends(project: EpisodeProject) -> dict[str, float]:
    return {
        t.id: max(c.timeline_end for c in project.clips if c.track_id == t.id)
        for t in project.tracks
    }


def test_approving_session_cuts_one_at_a_time_removes_what_approving_them_together_does(
    tmp_path: Path,
) -> None:
    # The cuts are 1.0 s of air at 5.0 and 25.0 (the guest is silent in both). Once the
    # first is approved the second plays at timeline 24.0, where the stale stem still holds
    # the guest's burst of 24.0 to 24.6, which the lanes put at 23.0 to 23.6.
    together = _project(tmp_path / "together")
    together.edit_decisions = [_trim("a", 5.0, 6.0), _trim("b", 25.0, 26.0)]
    one_by_one = _project(tmp_path / "one")
    one_by_one.edit_decisions = [_trim("a", 5.0, 6.0), _trim("b", 25.0, 26.0)]

    assert approve_edits(together, ["a", "b"]) == 2
    assert approve_edits(one_by_one, ["a"]) == 1
    assert approve_edits(one_by_one, ["b"]) == 1

    assert _lane_ends(together) == {"host": 28.0, "guest": 28.0}
    assert _lane_ends(one_by_one) == _lane_ends(together)


def test_a_cut_a_peer_now_speaks_through_is_held_not_punched(tmp_path: Path) -> None:
    # The guest really speaks at 25.2 to 25.8 of the recording, inside the second cut. A
    # session cut that would silence only the host is not what was reviewed.
    project = _project(tmp_path, burst=(25.2, 25.8))
    project.edit_decisions = [_trim("b", 25.0, 26.0)]

    with pytest.raises(ScopeChangedAtApproval) as held:
        approve_edits(project, ["b"])

    assert held.value.ids == ("b",)
    assert "guest" in str(held.value)
    assert [e.id for e in project.edit_decisions] == ["b"]
    assert project.edit_decisions[0].scope == "session"
    assert _lane_ends(project) == {"host": 30.0, "guest": 30.0}


def test_applying_auto_edits_leaves_a_cut_a_peer_speaks_through_pending(tmp_path: Path) -> None:
    project = _project(tmp_path, burst=(25.2, 25.8))
    project.edit_decisions = [_trim("a", 5.0, 6.0), _trim("b", 25.0, 26.0)]

    assert apply_auto_edits(project) == 1

    assert [e.id for e in project.edit_decisions] == ["b"]
    assert project.edit_decisions[0].scope == "session"
    assert _lane_ends(project) == {"host": 29.0, "guest": 29.0}


def test_the_approve_tool_refuses_a_held_cut_and_leaves_the_project_as_it_was(
    tmp_path: Path,
) -> None:
    from podcast_mcp.mcp import server as mcp_server
    from podcast_mcp.models import load_project, save_project

    project = _project(tmp_path, burst=(25.2, 25.8))
    project.edit_decisions = [_trim("b", 25.0, 26.0)]
    path = tmp_path / "episode.project.json"
    save_project(project, path)

    with pytest.raises(ScopeChangedAtApproval, match="not applied"):
        mcp_server.approve_edits_tool(str(path), ["b"])

    saved = load_project(path)
    assert [e.id for e in saved.edit_decisions] == ["b"]
    assert _lane_ends(saved) == {"host": 30.0, "guest": 30.0}
