"""Sparse durable transport wire snapshots and full response boundaries (#722)."""

from __future__ import annotations

import pytest

from podcast_mcp.gui.routes.session import apply_ws_client_message, apply_ws_viewer_state
from podcast_mcp.models import load_project
from podcast_mcp.services.session_sync.commands import TRANSPORT_FIELDS
from podcast_mcp.services.session_sync.service import SessionSyncService
from podcast_mcp.services.session_sync.snapshot import apply_command, empty_snapshot, wire_snapshot
from sync_helpers import _foreign_session_write


def _transport(snapshot):
    return {key: value for key, value in snapshot.items() if key in TRANSPORT_FIELDS}


def test_wire_snapshot_limits_fields_to_command_sequence():
    snap = empty_snapshot()
    for seq, ctype, payload in (
        (1, "SetPlaying", {"is_playing": True}),
        (2, "SetPlayhead", {"playhead_sec": 3.5}),
        (3, "FutureCommand", {"unexpected": "ignored"}),
    ):
        apply_command(
            snap,
            {
                "server_seq": seq,
                "type": ctype,
                "payload": payload,
                "command_id": str(seq),
                "client_id": "agent",
                "role": "agent",
            },
        )
    snap["unexpected"] = "ignored"
    snap["fields"]["unexpected"] = {"server_seq": 3}
    assert _transport(wire_snapshot(snap)) == {}
    assert "unexpected" not in wire_snapshot(snap)
    assert _transport(wire_snapshot(snap, server_seq=2)) == {"playhead_sec": 3.5}
    assert _transport(wire_snapshot(snap, after=0)) == {
        "playhead_sec": 3.5,
        "is_playing": True,
    }


@pytest.mark.parametrize("metadata", [None, [], {}, {"server_seq": True}, {"server_seq": "1"}])
def test_wire_snapshot_skips_invalid_attribution(metadata):
    snap = {**empty_snapshot(), "server_seq": 1, "fields": {"playhead_sec": metadata}}
    assert _transport(wire_snapshot(snap)) == {}
    snap["fields"] = metadata
    assert _transport(wire_snapshot(snap)) == {}


@pytest.mark.parametrize(
    ("command_type", "payload", "expected"),
    [
        ("ClearRegion", {"stop": True}, {"region": None, "is_playing": False}),
        (
            "SetMuteSolo",
            {"viewer_mute": {}, "solo_tracks": {}},
            {"viewer_mute": {}, "solo_tracks": {}},
        ),
        ("SetSelection", {"selection": None}, {"selection": None}),
    ],
)
def test_wire_delta_preserves_explicit_clears_and_attributed_unchanged_values(
    minimal_project, command_type, payload, expected
):
    from podcast_mcp.services.session_sync.service import wire_session_event

    svc = SessionSyncService(load_project(minimal_project))
    result = svc.submit_control(command_type, payload)
    event = wire_session_event(result["command"], result["snapshot"], roster_version=0)
    assert _transport(event["snapshot"]) == expected
    assert event["prev_seq"] == 0


def test_command_echo_and_full_response_boundaries(minimal_project):
    svc = SessionSyncService(load_project(minimal_project))
    svc.submit_control("SetPlaying", {"is_playing": True})
    echo, _ = apply_ws_client_message(
        svc,
        {
            "type": "Command",
            "client_seq": 1,
            "command_type": "SetPlayhead",
            "payload": {"playhead_sec": 4.0},
        },
        client_id="viewer",
        role="viewer",
        label=None,
        seq=1,
    )
    assert echo is not None
    assert echo["type"] == "Echo"
    assert echo["prev_seq"] == 1
    assert echo["server_seq"] == 2
    assert _transport(echo["snapshot"]) == {"playhead_sec": 4.0}
    assert not {"clients", "fields"} & echo["snapshot"].keys()
    assert svc.snapshot().keys() >= TRANSPORT_FIELDS


def test_viewer_echo_is_full_and_repeated_publish_stays_at_head(minimal_project):
    svc = SessionSyncService(load_project(minimal_project))
    svc.submit_control("SetPlayhead", {"playhead_sec": 4.0})
    args = {"client_id": "viewer", "role": "viewer", "label": None}
    echo = apply_ws_viewer_state(svc, {"audition_mode": "raw"}, **args)
    assert echo["type"] == "Echo"
    assert "prev_seq" not in echo
    assert echo["snapshot"]["server_seq"] == 2
    assert echo["snapshot"].keys() >= TRANSPORT_FIELDS
    assert echo["snapshot"]["audition_mode"] == "raw"
    assert echo["snapshot"]["playhead_sec"] == 4.0
    assert {"clients", "fields"} <= echo["snapshot"].keys()
    repeat = apply_ws_viewer_state(svc, {"audition_mode": "raw"}, **args)
    assert repeat["snapshot"]["server_seq"] == echo["snapshot"]["server_seq"]
    assert _transport(repeat["snapshot"]) == _transport(echo["snapshot"])


def test_idempotent_command_echo_returns_current_full_transport_state(minimal_project):
    svc = SessionSyncService(load_project(minimal_project))
    command = {
        "type": "Command",
        "client_seq": 1,
        "command_type": "SetPlayhead",
        "payload": {"playhead_sec": 4.0},
    }
    args = {"client_id": "viewer", "role": "viewer", "label": None, "seq": 1}
    first, _ = apply_ws_client_message(svc, command, **args)
    assert first is not None and first["server_seq"] == 1
    svc.submit_control("SetPlayhead", {"playhead_sec": 8.0})
    svc.submit_control("SetMode", {"audition_mode": "raw"})
    retry, _ = apply_ws_client_message(svc, command, **args)
    assert retry is not None and retry["type"] == "Echo"
    assert retry["idempotent"] is True
    assert retry["command"]["command_id"] == first["command"]["command_id"]
    assert retry["command"]["server_seq"] == 1
    assert retry["server_seq"] == retry["snapshot"]["server_seq"] == 3
    assert "prev_seq" not in retry
    assert retry["snapshot"].keys() >= TRANSPORT_FIELDS
    assert retry["snapshot"]["playhead_sec"] == 8.0
    assert retry["snapshot"]["audition_mode"] == "raw"
    assert not {"clients", "fields"} & retry["snapshot"].keys()


def test_cross_process_delta_collapses_latest_values_since_watcher_cursor(minimal_project):
    project = load_project(minimal_project)
    svc = SessionSyncService(project)
    baseline = svc.submit_control("SetMode", {"audition_mode": "raw"})["server_seq"]
    _foreign_session_write(project, 2.0)
    _foreign_session_write(project, 0.0, command_type="SetPlaying", payload={"is_playing": True})
    head = _foreign_session_write(project, 8.0)
    event = svc.publish_cross_process_head(after=baseline)
    assert event is not None
    assert event["server_seq"] == head["server_seq"]
    assert event["prev_seq"] == head["server_seq"] - 1
    assert event["prev_seq"] != baseline  # clients with the baseline must resync
    assert _transport(event["snapshot"]) == {"playhead_sec": 8.0, "is_playing": True}
    assert not {"clients", "fields"} & event["snapshot"].keys()


def test_cross_process_without_cursor_includes_only_head_fields(minimal_project):
    project = load_project(minimal_project)
    svc = SessionSyncService(project)
    _foreign_session_write(project, 0.0, command_type="SetPlaying", payload={"is_playing": True})
    head = _foreign_session_write(project, 8.0)
    event = svc.publish_cross_process_head()
    assert event is not None
    assert event["prev_seq"] == head["server_seq"] - 1
    assert _transport(event["snapshot"]) == {"playhead_sec": 8.0}
