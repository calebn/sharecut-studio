"""fill_with_room_tone_tool journals one FillRoomTone command per call (#1847)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pause_policy_public_helpers import add_bed, configure, defaults, project
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import Clip, load_project, save_project
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.document_sync.host_submit import submit_host_document_command
from podcast_mcp.services.document_sync.payloads import validate_payload


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


def _rows(path: str) -> list[dict]:
    return DocumentSyncService.open(path).store.commands_after(0)


@pytest.fixture(autouse=True)
def _config(monkeypatch):
    configure(monkeypatch, defaults())


def test_whole_track_fill_journals_one_fill_room_tone_command(tmp_path):
    path = _gappy_path(tmp_path)
    mcp_timeline.fill_with_room_tone_tool(path, track_id="host")
    assert [row["type"] for row in _rows(path)] == ["FillRoomTone"]


def test_whole_track_fill_by_speaker_journals_one_fill_room_tone_command(tmp_path):
    path = _gappy_path(tmp_path)
    mcp_timeline.fill_with_room_tone_tool(path, speaker="Host")
    assert [row["type"] for row in _rows(path)] == ["FillRoomTone"]


def test_range_fill_journals_one_fill_room_tone_command_with_its_range(tmp_path):
    path = _gappy_path(tmp_path)
    mcp_timeline.fill_with_room_tone_tool(path, track_id="host", start_sec=0.5, end_sec=1.5)
    rows = _rows(path)
    assert [row["type"] for row in rows] == ["FillRoomTone"]
    payload = rows[0]["payload"]
    assert (payload["track_id"], payload["start_sec"], payload["end_sec"]) == ("host", 0.5, 1.5)
    assert "speaker" not in payload


@pytest.mark.parametrize(
    ("kwargs", "keys"),
    [({"track_id": "host"}, {"track_id"}), ({"speaker": "Host"}, {"speaker"})],
)
def test_whole_track_payload_drops_the_unset_keys(tmp_path, kwargs, keys):
    path = _gappy_path(tmp_path)
    mcp_timeline.fill_with_room_tone_tool(path, **kwargs)
    payload = _rows(path)[0]["payload"]
    assert set(payload) - {"result"} == keys


def test_whole_track_fill_journals_the_tool_reply_as_the_result(tmp_path):
    path = _gappy_path(tmp_path)
    reply = json.loads(mcp_timeline.fill_with_room_tone_tool(path, track_id="host"))
    assert _rows(path)[0]["payload"]["result"]["pad_samples"] == reply["pad_samples"]


def test_a_failed_whole_track_fill_journals_nothing(tmp_path):
    path = _gappy_path(tmp_path)
    with pytest.raises(ValueError) as raised:
        mcp_timeline.fill_with_room_tone_tool(path, track_id="nope")
    assert raised.value.code == "track_not_found"
    assert _rows(path) == []


def test_payload_without_track_or_speaker_is_refused(tmp_path):
    with pytest.raises(ValueError):
        validate_payload("FillRoomTone", {})
    path = _gappy_path(tmp_path)
    with pytest.raises(ValueError):
        mcp_timeline.fill_with_room_tone_tool(path)
    assert _rows(path) == []


@pytest.mark.parametrize(
    "payload",
    [
        {"track_id": "host", "start_sec": 0.5},
        {"track_id": "host", "end_sec": 1.5},
        {"track_id": "host", "start_sec": 1.5, "end_sec": 0.5},
        {"track_id": "host", "start_sec": 1.0, "end_sec": 1.0},
    ],
    ids=["start-only", "end-only", "reversed", "empty"],
)
def test_malformed_ranges_are_refused_before_journalling(tmp_path, payload):
    path = _gappy_path(tmp_path)
    with pytest.raises(ValueError):
        validate_payload("FillRoomTone", payload)
    with pytest.raises(ValueError):
        submit_host_document_command(path, "FillRoomTone", payload)
    assert _rows(path) == []


def test_a_range_less_row_replays_idempotently(tmp_path):
    path = _gappy_path(tmp_path)
    command = DocumentCommand(
        type="FillRoomTone",
        payload={"speaker": "Host"},
        client_id="replay",
        client_seq=1,
        role="agent",
    )
    first = DocumentSyncService.open(path).submit(command)
    assert not first.get("idempotent")
    clips = load_project(Path(path)).clips
    again = DocumentSyncService.open(path).submit(command)
    assert again["idempotent"] is True
    assert load_project(Path(path)).clips == clips
    rows = _rows(path)
    assert [row["type"] for row in rows] == ["FillRoomTone"]
    stored = {k: v for k, v in rows[0]["payload"].items() if k != "result"}
    assert validate_payload("FillRoomTone", stored)["speaker"] == "Host"
