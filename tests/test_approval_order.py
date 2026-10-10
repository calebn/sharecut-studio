"""Approving session cuts one at a time shortens the session as approving them together does (#1055).

An approval re-runs the speech-energy scope guard against the project as it stands. After an
earlier approval has rippled the timeline, a rendered stem on disk still has the old timeline,
so reading it at the later cut's timeline seconds finds a peer "speaking" in what is, on the
lanes, silence, and turned the cut into a punch that shortens nothing. The guard reads what the
lanes play instead.
"""

from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.decisions import apply_auto_edits, approve_edits
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
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
        reason="filler:ordering",
        review_required=False,
        applied=False,
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


def _rendered(project: EpisodeProject) -> EpisodeProject:
    """The stems on disk are a fresh render of the project as it stands."""
    from podcast_mcp.engines.play_audit import write_stem_hash

    for track in project.tracks:
        write_stem_hash(project, track.id)
    return project


@pytest.mark.parametrize("forward", [True, False])
def test_a_long_trim_is_approved_alone_whatever_a_stale_stem_holds(
    tmp_path: Path, forward: bool
) -> None:
    # Trim "b" is 4.5 s of air, 9 windows of the 0.5 s the speech guard reads, so it decodes
    # each track once (the cache path) instead of reading windows. The guest's burst is at
    # 19.2 to 19.8 s of its recording, outside "b" (20.0 to 24.5 s) on the lanes. Once "a"
    # is approved the rendered stems are one second out of date, and read at "b"'s new
    # seconds (19.0 to 23.5) the stale guest stem holds the burst: a stem is read only while
    # it is fresh.
    def project_at(name: str) -> EpisodeProject:
        project = _rendered(_project(tmp_path / name, burst=(19.2, 19.8)))
        project.edit_decisions = [_trim("a", 5.0, 6.0), _trim("b", 20.0, 24.5)]
        return project

    together = project_at("together")
    assert approve_edits(together, ["a", "b"]) == 2

    one_by_one = project_at("one")
    for edit_id in ("a", "b") if forward else ("b", "a"):
        assert approve_edits(one_by_one, [edit_id]) == 1

    assert _lane_ends(together) == {"host": 24.5, "guest": 24.5}
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


def _original_trims_project(tmp_path: Path) -> EpisodeProject:
    """Two original-only pause trims keep a guest interjection between them."""
    project = _project(tmp_path, burst=(15.0, 15.5))

    def voice(signal, start, end):
        t = np.arange(round(start * _SR), round(end * _SR)) / _SR
        signal[round(start * _SR) : round(end * _SR)] += sum(
            0.05 / k * np.sin(2 * np.pi * 140 * k * t) for k in range(1, 9)
        )

    host = _room(1)
    voice(host, 0.0, 10.0)
    voice(host, 14.0, 20.0)
    voice(host, 23.0, 30.0)
    _write_wav(tmp_path / "raw" / "host.wav", host)
    guest = _room(2)
    for start, end in ((0.0, 0.3), (15.0, 15.5), (29.0, 29.3)):
        voice(guest, start, end)
    _write_wav(tmp_path / "raw" / "guest.wav", guest)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="before", start=9.7, end=10),
                TranscriptWord(text="after", start=14, end=14.2),
                TranscriptWord(text="before", start=19.7, end=20),
                TranscriptWord(text="after", start=23, end=23.2),
            ],
        ),
        Transcript(
            track_id="guest",
            words=[
                TranscriptWord(text="reference", start=0.0, end=0.3),
                TranscriptWord(text="Uh", start=15.0, end=15.2),
                TranscriptWord(text="-huh.", start=15.2, end=15.5),
                TranscriptWord(text="reference", start=29.0, end=29.3),
            ],
        ),
    ]
    early = _trim("early", 13.0, 13.9)
    late = _trim("late", 21.0, 21.6)
    early.reason = late.reason = "pause:original"
    project.edit_decisions = [early, late]
    return project


def test_original_auto_trims_keep_the_intervening_guest_without_replaying_source(
    tmp_path: Path,
) -> None:
    from podcast_mcp.mcp import server as mcp_server
    from podcast_mcp.models import load_project, save_project

    project = _original_trims_project(tmp_path)
    path = tmp_path / "episode.project.json"
    save_project(project, path)

    result = json.loads(mcp_server.approve_edits_tool(str(path), apply_all_safe=True))

    assert "needs_confirmation" not in result
    assert result["approved_count"] == 2
    saved = load_project(path)
    assert saved.edit_decisions == []
    assert _lane_ends(saved) == pytest.approx({"host": 28.5, "guest": 28.5})
    assert all(clip.source_id is None for clip in saved.clips)
    assert all(row.params["replace_gap_sec"] is None for row in saved.editorial.edit_log)
    assert all(row.params["pad_samples"] == [] for row in saved.editorial.edit_log)
    assert any(
        clip.track_id == "guest" and clip.source_start <= 15.0 and clip.source_end >= 15.5
        for clip in saved.clips
    )


def test_the_pipeline_applies_the_same_auto_trims_apply_all_safe_does(tmp_path: Path) -> None:
    project = _original_trims_project(tmp_path)

    assert apply_auto_edits(project) == 2

    assert project.edit_decisions == []
    assert _lane_ends(project) == pytest.approx({"host": 28.5, "guest": 28.5})
    assert all(row.params["replace_gap_sec"] is None for row in project.editorial.edit_log)
    assert all(row.params["pad_samples"] == [] for row in project.editorial.edit_log)
