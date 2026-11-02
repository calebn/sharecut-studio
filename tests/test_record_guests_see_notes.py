"""Host setting `guests_see_notes`: reducer command and guest comment visibility."""

from __future__ import annotations

import pytest

from podcast_mcp.services.record.commands import (
    COMMAND_TYPES,
    HOST_ONLY,
    RecordAuthzError,
    RecordCommand,
    authorize_record_command,
)
from podcast_mcp.services.record.reducer import apply_record_command
from podcast_mcp.services.record.service import filter_record_event_for_guest
from podcast_mcp.services.record.state import RecordSnapshot, empty_record_snapshot
from podcast_mcp.util.coded_error import CodedValueError


def _cmd(payload, *, role="host", pid="p_host") -> RecordCommand:
    return RecordCommand.parse(
        command_type="SetGuestsSeeNotes",
        payload=payload,
        client_id="c",
        role=role,
        participant_id=pid,
        client_seq=1,
    )


def _set(snap: RecordSnapshot, enabled: bool) -> RecordSnapshot:
    return apply_record_command(snap, _cmd({"enabled": enabled}), now_wall_ms=1)


def test_snapshot_default_off_and_field_present() -> None:
    snap = empty_record_snapshot("s")
    assert snap.guests_see_notes is False
    assert snap.model_dump()["guests_see_notes"] is False


@pytest.mark.parametrize("state", ["lobby", "recording", "paused", "stopped"])
def test_set_guests_see_notes_sets_and_clears_in_any_state(state: str) -> None:
    snap = empty_record_snapshot("s").model_copy(update={"state": state})
    on = _set(snap, True)
    assert on.guests_see_notes is True
    assert _set(on, True).guests_see_notes is True
    assert _set(on, False).guests_see_notes is False
    assert snap.guests_see_notes is False


def test_set_guests_see_notes_is_host_only() -> None:
    assert "SetGuestsSeeNotes" in HOST_ONLY
    assert "SetGuestsSeeNotes" in COMMAND_TYPES
    authorize_record_command(role="host", capabilities=[], command_type="SetGuestsSeeNotes")
    for role in ("guest", "producer"):
        with pytest.raises(RecordAuthzError):
            authorize_record_command(
                role=role, capabilities=["join", "comment"], command_type="SetGuestsSeeNotes"
            )


@pytest.mark.parametrize("payload", [{}, {"enabled": "yes"}, {"enabled": 1}, {"enabled": None}])
def test_set_guests_see_notes_rejects_invalid_payload(payload) -> None:
    with pytest.raises(CodedValueError):
        _cmd(payload)


def _row(cid: str, author: str, body: str) -> dict:
    return {"id": cid, "author": author, "body": body}


COMMENTS = [
    _row("own", "p_me", "my note"),
    _row("note", "p_other", "their note"),
    _row("marker", "p_other", "Marker"),
    _row("spaced", "p_other", " Marker "),
]


def _visible(role: str, pid: str, *, flag: bool | None, shape: str = "event") -> list[str]:
    snap: dict = {"comments": [dict(c) for c in COMMENTS]}
    if flag is not None:
        snap["guests_see_notes"] = flag
    event = {"type": "Applied", "snapshot": snap} if shape == "event" else snap
    out = filter_record_event_for_guest(event, participant_id=pid, role=role)
    assert out is not None
    body = out["snapshot"] if shape == "event" else out
    return [c["id"] for c in body["comments"]]


@pytest.mark.parametrize("shape", ["event", "bare"])
def test_guest_filter_setting_off(shape: str) -> None:
    for flag in (False, None):
        assert _visible("guest", "p_me", flag=flag, shape=shape) == ["own", "marker", "spaced"]


@pytest.mark.parametrize("shape", ["event", "bare"])
def test_guest_filter_setting_on(shape: str) -> None:
    assert _visible("guest", "p_me", flag=True, shape=shape) == [
        "own",
        "note",
        "marker",
        "spaced",
    ]


def test_guest_without_comments_sees_only_markers_when_off() -> None:
    assert _visible("guest", "p_new", flag=False) == ["marker", "spaced"]


@pytest.mark.parametrize("role", ["host", "producer"])
def test_host_and_producer_see_everything_with_setting_off(role: str) -> None:
    assert _visible(role, "p_x", flag=False) == ["own", "note", "marker", "spaced"]


def test_setting_applies_only_to_the_snapshot_that_carries_it() -> None:
    event = {
        "type": "Applied",
        "snapshot": {"guests_see_notes": True, "comments": [dict(c) for c in COMMENTS]},
        "history": [{"snapshot": {"comments": [dict(c) for c in COMMENTS]}}],
    }
    out = filter_record_event_for_guest(event, participant_id="p_me", role="guest")
    assert out is not None
    assert [c["id"] for c in out["snapshot"]["comments"]] == ["own", "note", "marker", "spaced"]
    assert [c["id"] for c in out["history"][0]["snapshot"]["comments"]] == [
        "own",
        "marker",
        "spaced",
    ]
