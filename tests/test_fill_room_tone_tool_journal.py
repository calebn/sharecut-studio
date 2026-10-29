"""fill_with_room_tone_tool journals one FillRoomTone command per call (#1847)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.models import load_project
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.document_sync.host_submit import submit_host_document_command
from podcast_mcp.services.document_sync.payloads import validate_payload
from test_guest_document_gate import gap_project


def _rows(path) -> list[dict]:
    return DocumentSyncService.open(str(path)).store.commands_after(0)


@pytest.mark.parametrize(
    ("kwargs", "payload"),
    [
        ({"track_id": "host"}, {"track_id": "host", "speaker": None}),
        ({"speaker": "Host"}, {"track_id": None, "speaker": "Host"}),
    ],
)
def test_whole_track_fill_journals_one_fill_room_tone_command_with_unset_keys_null(
    minimal_project, monkeypatch, kwargs, payload
):
    gap_project(minimal_project, monkeypatch)
    mcp_timeline.fill_with_room_tone_tool(str(minimal_project), **kwargs)
    rows = _rows(minimal_project)
    assert [row["type"] for row in rows] == ["FillRoomTone"]
    stored = {key: value for key, value in rows[0]["payload"].items() if key != "result"}
    assert stored == {**payload, "start_sec": None, "end_sec": None}


def test_range_fill_journals_one_fill_room_tone_command_with_its_range(
    minimal_project, monkeypatch
):
    gap_project(minimal_project, monkeypatch)
    path = str(minimal_project)
    mcp_timeline.fill_with_room_tone_tool(path, track_id="host", start_sec=0.5, end_sec=1.5)
    rows = _rows(path)
    assert [row["type"] for row in rows] == ["FillRoomTone"]
    payload = rows[0]["payload"]
    assert (payload["track_id"], payload["start_sec"], payload["end_sec"]) == ("host", 0.5, 1.5)
    assert payload["speaker"] is None


def test_whole_track_fill_journals_the_tool_reply_as_the_result(minimal_project, monkeypatch):
    gap_project(minimal_project, monkeypatch)
    path = str(minimal_project)
    reply = json.loads(mcp_timeline.fill_with_room_tone_tool(path, track_id="host"))
    assert _rows(path)[0]["payload"]["result"]["pad_samples"] == reply["pad_samples"]


def test_a_failed_whole_track_fill_journals_nothing(minimal_project, monkeypatch):
    gap_project(minimal_project, monkeypatch)
    path = str(minimal_project)
    with pytest.raises(ValueError) as raised:
        mcp_timeline.fill_with_room_tone_tool(path, track_id="nope")
    assert raised.value.code == "track_not_found"
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
def test_malformed_ranges_are_refused_before_journalling(minimal_project, monkeypatch, payload):
    gap_project(minimal_project, monkeypatch)
    path = str(minimal_project)
    with pytest.raises(ValueError):
        validate_payload("FillRoomTone", payload)
    with pytest.raises(ValueError):
        submit_host_document_command(path, "FillRoomTone", payload)
    assert _rows(path) == []


def test_a_range_less_row_replays_idempotently(minimal_project, monkeypatch):
    gap_project(minimal_project, monkeypatch)
    path = str(minimal_project)
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


def test_a_fill_with_no_target_keeps_missing_argument(minimal_project, monkeypatch):
    gap_project(minimal_project, monkeypatch)
    path = str(minimal_project)
    with pytest.raises(ValueError):
        validate_payload("FillRoomTone", {})
    with pytest.raises(ValueError) as raised:
        mcp_timeline.fill_with_room_tone_tool(path)
    assert raised.value.code == "missing_argument"
    assert _rows(path) == []


def test_an_inverted_range_is_a_coded_invalid_payload(minimal_project, monkeypatch):
    gap_project(minimal_project, monkeypatch)
    path = str(minimal_project)
    with pytest.raises(ValueError) as raised:
        mcp_timeline.fill_with_room_tone_tool(path, track_id="host", start_sec=5.0, end_sec=2.0)
    assert raised.value.code == "invalid_payload"
    assert _rows(path) == []


def _command(payload: dict, seq: int, command_id: str | None = None) -> DocumentCommand:
    return DocumentCommand(
        type="FillRoomTone",
        payload=payload,
        client_id="browser",
        client_seq=seq,
        role="agent",
        **({"command_id": command_id} if command_id else {}),
    )


def test_a_hand_built_command_journals_the_same_row_shape_as_the_tool(minimal_project, monkeypatch):
    gap_project(minimal_project, monkeypatch)
    path = str(minimal_project)
    svc = DocumentSyncService.open(path)
    svc.submit(_command({"track_id": "host", "start_sec": 0.5, "end_sec": 1.5}, 1))
    mcp_timeline.fill_with_room_tone_tool(path, track_id="host", start_sec=1.5, end_sec=2.0)
    built, tool = (set(row["payload"]) - {"result"} for row in _rows(path))
    assert built == tool == {"track_id", "speaker", "start_sec", "end_sec"}


def test_a_hand_built_malformed_command_is_refused_before_journalling(minimal_project, monkeypatch):
    gap_project(minimal_project, monkeypatch)
    path = str(minimal_project)
    with pytest.raises(ValueError):
        DocumentSyncService.open(path).submit(
            _command({"track_id": "host", "start_sec": 1.5, "end_sec": 0.5}, 1)
        )
    assert _rows(path) == []


def test_a_retry_with_a_new_command_id_stays_idempotent_after_normalising(
    minimal_project, monkeypatch
):
    gap_project(minimal_project, monkeypatch)
    path = str(minimal_project)
    payload = {"track_id": "host", "start_sec": 0.5, "end_sec": 1.5}
    DocumentSyncService.open(path).submit(_command(payload, 1))
    again = DocumentSyncService.open(path).submit(_command(payload, 1, command_id="retry"))
    assert again["idempotent"] is True
    assert len(_rows(path)) == 1


def test_a_whole_track_fill_on_fewer_than_two_clips_is_an_unchanged_no_op(
    minimal_project, monkeypatch
):
    from podcast_mcp.mcp.tools.history import history_status_tool
    from podcast_mcp.models import save_project

    gap_project(minimal_project, monkeypatch)
    path = str(minimal_project)
    project = load_project(Path(path))
    project.clips = project.clips[:1]
    save_project(project, minimal_project)
    before = Path(path).read_bytes()
    reply = json.loads(mcp_timeline.fill_with_room_tone_tool(path, track_id="host"))
    assert reply["operation"] == "fill_with_room_tone"
    assert reply["pad_samples"] == []
    assert reply["unchanged"] is True
    assert Path(path).read_bytes() == before
    assert [row["type"] for row in _rows(path)] == ["FillRoomTone"]
    assert json.loads(history_status_tool(path))["total"] == 0
