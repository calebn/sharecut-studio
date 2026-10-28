"""fill_with_room_tone_tool keeps its replies, errors and effects (#1847)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pause_policy_public_helpers import add_bed, configure, defaults, project
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.mcp.tools.history import history_status_tool, history_undo
from podcast_mcp.models import Clip, Track, TrackRole, load_project, save_project

_REPLY_KEYS = {"operation", "pad_samples", "affected_tracks"}


def _gappy_path(tmp_path: Path, name: str = "ws") -> str:
    root = tmp_path / name
    root.mkdir()
    result = project(root)
    result.tracks[0].speaker = "Host"
    add_bed(result, root)
    result.clips = [
        Clip(id="left", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="right", track_id="host", source_start=2, source_end=6, timeline_start=2.0),
    ]
    return str(save_project(result))


def _clips(path: str, track_id: str = "host") -> list[Clip]:
    return [c for c in load_project(Path(path)).clips if c.track_id == track_id]


def _normalised(path: str, track_id: str = "host") -> list[tuple]:
    rows = (
        (
            c.source_id,
            round(c.source_start, 6),
            round(c.source_end, 6),
            round(c.timeline_start, 6),
            c.fade_in_ms,
            c.fade_out_ms,
            c.join_in_mode.value,
        )
        for c in _clips(path, track_id)
    )
    return sorted(rows, key=lambda row: (row[3], row[1]))


def _history_status(path: str) -> dict:
    return json.loads(history_status_tool(path))


@pytest.fixture(autouse=True)
def _config(monkeypatch):
    configure(monkeypatch, defaults())


def test_whole_track_fill_reply_keeps_operation_and_pad_samples_keys(tmp_path):
    path = _gappy_path(tmp_path)
    reply = json.loads(mcp_timeline.fill_with_room_tone_tool(path, track_id="host"))
    assert set(reply) >= _REPLY_KEYS
    assert reply["operation"] == "fill_with_room_tone"
    assert reply["affected_tracks"] == ["host"]
    assert isinstance(reply["pad_samples"], list)


def test_whole_track_fill_by_speaker_matches_by_track_id(tmp_path):
    by_track = _gappy_path(tmp_path, "by-track")
    by_speaker = _gappy_path(tmp_path, "by-speaker")
    track_reply = json.loads(mcp_timeline.fill_with_room_tone_tool(by_track, track_id="host"))
    speaker_reply = json.loads(mcp_timeline.fill_with_room_tone_tool(by_speaker, speaker="Host"))
    assert speaker_reply["operation"] == track_reply["operation"]
    assert speaker_reply["affected_tracks"] == track_reply["affected_tracks"]
    assert speaker_reply["pad_samples"] == track_reply["pad_samples"]
    assert _normalised(by_speaker) == _normalised(by_track)
    assert len(_normalised(by_track)) > 2


def test_whole_track_fill_normalised_clip_list(tmp_path):
    path = _gappy_path(tmp_path)
    before = _normalised(path)
    mcp_timeline.fill_with_room_tone_tool(path, track_id="host")
    after = _normalised(path)
    assert before == [
        (None, 0.0, 1.0, 0.0, 0, 0, "fade"),
        (None, 2.0, 6.0, 2.0, 0, 0, "fade"),
    ]
    assert after[0] == before[0]
    assert after[-1] == before[-1]
    pads = [row for row in after if row[0] == "room-tone-host"]
    assert pads
    assert pads[0][3] == pytest.approx(1.0)
    assert pads[0][4] == 10
    assert pads[-1][5] == 10
    assert {row[6] for row in pads} == {"fade"}
    assert len(after) == len(pads) + 2


def test_whole_track_fill_is_one_history_step_and_undo_restores_the_clips(tmp_path):
    path = _gappy_path(tmp_path)
    before = _normalised(path)
    total = _history_status(path)["total"]
    mcp_timeline.fill_with_room_tone_tool(path, track_id="host")
    status = _history_status(path)
    assert status["total"] == total + 2
    assert status["current_label"] == "after fill room tone"
    assert _normalised(path) != before
    history_undo(path)
    assert _normalised(path) == before


def test_whole_track_fill_of_a_single_clip_track_returns_an_empty_summary(tmp_path):
    root = tmp_path / "single"
    root.mkdir()
    path = str(save_project(project(root)))
    reply = json.loads(mcp_timeline.fill_with_room_tone_tool(path, track_id="host"))
    assert reply["operation"] == "fill_with_room_tone"
    assert reply["pad_samples"] == []


def test_range_fill_keeps_the_same_reply_keys(tmp_path):
    path = _gappy_path(tmp_path)
    reply = json.loads(
        mcp_timeline.fill_with_room_tone_tool(path, track_id="host", start_sec=0.5, end_sec=1.5)
    )
    assert set(reply) >= _REPLY_KEYS
    assert reply["operation"] == "fill_with_room_tone"
    pads = [c for c in _clips(path) if c.id not in {"left", "right"}]
    assert max(c.timeline_end for c in pads) == pytest.approx(1.5)


def test_range_fill_is_one_history_step_and_undo_restores_the_clips(tmp_path):
    path = _gappy_path(tmp_path)
    before = _normalised(path)
    total = _history_status(path)["total"]
    mcp_timeline.fill_with_room_tone_tool(path, track_id="host", start_sec=0.5, end_sec=1.5)
    status = _history_status(path)
    assert status["total"] == total + 2
    assert status["current_label"] == "after fill room tone"
    history_undo(path)
    assert _normalised(path) == before


@pytest.mark.parametrize(
    "kwargs",
    [
        {"track_id": "host", "start_sec": 0.5},
        {"track_id": "host", "end_sec": 1.5},
        {"start_sec": 0.5, "end_sec": 1.5},
        {"speaker": "Host", "start_sec": 0.5, "end_sec": 1.5},
    ],
)
def test_half_a_range_keeps_range_incomplete(tmp_path, kwargs):
    path = _gappy_path(tmp_path)
    before = Path(path).read_bytes()
    with pytest.raises(ValueError) as raised:
        mcp_timeline.fill_with_room_tone_tool(path, **kwargs)
    assert raised.value.code == "range_incomplete"
    assert Path(path).read_bytes() == before


def test_range_fill_over_a_clip_only_range_keeps_nothing_to_fill(tmp_path):
    path = _gappy_path(tmp_path)
    with pytest.raises(ValueError) as raised:
        mcp_timeline.fill_with_room_tone_tool(path, track_id="host", start_sec=0.1, end_sec=0.9)
    assert raised.value.code == "nothing_to_fill"


def test_range_fill_without_a_source_keeps_no_source(tmp_path):
    root = tmp_path / "nosrc"
    root.mkdir()
    result = project(root, guest="digital")
    result.clips = [
        Clip(id="left", track_id="guest", source_start=0, source_end=1, timeline_start=0),
        Clip(id="right", track_id="guest", source_start=2, source_end=6, timeline_start=2.0),
    ]
    path = str(save_project(result))
    with pytest.raises(ValueError) as raised:
        mcp_timeline.fill_with_room_tone_tool(path, track_id="guest", start_sec=1.0, end_sec=2.0)
    assert raised.value.code == "no_source"


@pytest.mark.parametrize("kwargs", [{"track_id": "nope"}, {"speaker": "Nobody"}])
def test_unknown_track_and_speaker_keep_track_not_found(tmp_path, kwargs):
    path = _gappy_path(tmp_path)
    with pytest.raises(ValueError) as raised:
        mcp_timeline.fill_with_room_tone_tool(path, **kwargs)
    assert raised.value.code == "track_not_found"


def test_track_without_media_keeps_track_has_no_media(tmp_path):
    root = tmp_path / "nomedia"
    root.mkdir()
    result = project(root)
    result.tracks.append(Track(id="ghost", label="Ghost", role=TrackRole.DIALOGUE, media=None))
    result.clips += [
        Clip(id="g-0", track_id="ghost", source_start=0, source_end=1, timeline_start=0),
        Clip(id="g-1", track_id="ghost", source_start=2, source_end=3, timeline_start=2.0),
    ]
    path = str(save_project(result))
    with pytest.raises(ValueError) as raised:
        mcp_timeline.fill_with_room_tone_tool(path, track_id="ghost")
    assert raised.value.code == "track_has_no_media"
