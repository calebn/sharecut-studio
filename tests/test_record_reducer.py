"""Table-driven record reducer tests (no I/O)."""

from __future__ import annotations

import pytest

from podcast_mcp.services.record.commands import RecordCommand
from podcast_mcp.services.record.reducer import (
    RecordStateError,
    RoomFullError,
    _recorded_join_full,
    apply_record_command,
    prepare_host_rejoin,
)
from podcast_mcp.services.record.state import (
    empty_record_snapshot,
    recording_ms,
    start_blockers,
)


def _cmd(
    ctype: str,
    *,
    role: str = "guest",
    pid: str = "p_a",
    payload: dict | None = None,
    seq: int = 1,
) -> RecordCommand:
    return RecordCommand.parse(
        command_type=ctype,
        payload=payload or {},
        client_id=f"c-{pid}",
        role=role,  # type: ignore[arg-type]
        participant_id=pid,
        client_seq=seq,
    )


def _join(
    snap,
    *,
    pid: str,
    role: str,
    name: str,
    now: int,
    seq: int = 1,
):
    return apply_record_command(
        snap,
        _cmd("Join", role=role, pid=pid, payload={"display_name": name}, seq=seq),
        now_wall_ms=now,
    )


def test_start_blocked_by_unconsented_guest() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=1, seq=2)
    assert start_blockers(snap) == ["Ava"]
    with pytest.raises(RecordStateError, match="waiting for consent"):
        apply_record_command(snap, _cmd("Start", role="host", pid="p_host"), now_wall_ms=2)


def test_start_allowed_with_producer_and_consented_guest() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=1, seq=2)
    snap = apply_record_command(
        snap,
        _cmd("Consent", pid="p_g", payload={"accepted": True}, seq=3),
        now_wall_ms=2,
    )
    snap = _join(snap, pid="p_p", role="producer", name="Pat", now=3, seq=4)
    assert start_blockers(snap) == []
    out = apply_record_command(snap, _cmd("Start", role="host", pid="p_host"), now_wall_ms=10)
    assert out.state == "recording"
    assert out.take_index == 0
    assert out.takes[0].session_start_wall_ms == 10


def test_rejoined_guest_must_consent_again_before_start() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=1, seq=2)
    snap = apply_record_command(
        snap,
        _cmd("Consent", pid="p_g", payload={"accepted": True}, seq=3),
        now_wall_ms=2,
    )
    assert start_blockers(snap) == []
    snap = apply_record_command(snap, _cmd("Leave", pid="p_g", seq=4), now_wall_ms=3)
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=4, seq=5)
    assert next(p for p in snap.participants if p.participant_id == "p_g").consented is None
    assert start_blockers(snap) == ["Ava"]
    with pytest.raises(RecordStateError, match="waiting for consent"):
        apply_record_command(snap, _cmd("Start", role="host", pid="p_host"), now_wall_ms=5)
    snap = apply_record_command(
        snap,
        _cmd("Consent", pid="p_g", payload={"accepted": True}, seq=6),
        now_wall_ms=6,
    )
    assert start_blockers(snap) == []


def test_join_requires_fresh_consent_even_before_disconnect_is_observed() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=1, seq=2)
    snap = apply_record_command(
        snap,
        _cmd("Consent", pid="p_g", payload={"accepted": True}, seq=3),
        now_wall_ms=2,
    )
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=3, seq=4)
    assert start_blockers(snap) == ["Ava"]


def test_start_blocked_when_nobody_joined() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    assert start_blockers(snap) == ["No one has joined"]
    with pytest.raises(RecordStateError, match="No one has joined"):
        apply_record_command(snap, _cmd("Start", role="host", pid="p_host"), now_wall_ms=1)


def test_room_full_fifth_recorded_and_third_producer() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    for i in range(3):
        snap = _join(
            snap,
            pid=f"p_g{i}",
            role="guest",
            name=f"G{i}",
            now=i + 1,
            seq=i + 2,
        )
    with pytest.raises(RoomFullError):
        apply_record_command(
            snap,
            _cmd("Join", pid="p_g3", payload={"display_name": "G3"}, seq=99),
            now_wall_ms=9,
        )
    snap = _join(snap, pid="p_p0", role="producer", name="P0", now=20, seq=20)
    snap = _join(snap, pid="p_p1", role="producer", name="P1", now=21, seq=21)
    with pytest.raises(RoomFullError):
        apply_record_command(
            snap,
            _cmd(
                "Join",
                role="producer",
                pid="p_p2",
                payload={"display_name": "P2"},
                seq=22,
            ),
            now_wall_ms=22,
        )


def test_guest_join_reserves_host_seat() -> None:
    snap = empty_record_snapshot("sess")
    for i in range(3):
        snap = _join(snap, pid=f"p_g{i}", role="guest", name=f"G{i}", now=i, seq=i + 1)
    with pytest.raises(RoomFullError):
        apply_record_command(
            snap,
            _cmd("Join", pid="p_g3", payload={"display_name": "G3"}, seq=99),
            now_wall_ms=9,
        )
    snap = _join(snap, pid="p_host", role="host", name="Host", now=10, seq=10)
    assert any(p.participant_id == "p_host" and p.connected for p in snap.participants)


def test_pause_not_recording_raises() -> None:
    snap = empty_record_snapshot("sess")
    with pytest.raises(RecordStateError, match="cannot pause"):
        apply_record_command(snap, _cmd("Pause", role="host", pid="p_host"), now_wall_ms=1)


def test_stop_from_paused_closes_pause() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=1, seq=2)
    snap = apply_record_command(
        snap,
        _cmd("Consent", pid="p_g", payload={"accepted": True}, seq=3),
        now_wall_ms=2,
    )
    snap = apply_record_command(snap, _cmd("Start", role="host", pid="p_host"), now_wall_ms=10)
    snap = apply_record_command(snap, _cmd("Pause", role="host", pid="p_host"), now_wall_ms=20)
    assert snap.state == "paused"
    snap = apply_record_command(snap, _cmd("Stop", role="host", pid="p_host"), now_wall_ms=30)
    assert snap.state == "stopped"
    assert snap.takes[0].pauses[0].resume_wall_ms == 30
    assert snap.takes[0].stopped_wall_ms == 30


def test_recording_ms_collapses_two_pauses() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=1, seq=2)
    snap = apply_record_command(
        snap,
        _cmd("Consent", pid="p_g", payload={"accepted": True}, seq=3),
        now_wall_ms=2,
    )
    snap = apply_record_command(snap, _cmd("Start", role="host", pid="p_host"), now_wall_ms=0)
    snap = apply_record_command(snap, _cmd("Pause", role="host", pid="p_host"), now_wall_ms=600_000)
    snap = apply_record_command(
        snap, _cmd("Resume", role="host", pid="p_host"), now_wall_ms=900_000
    )
    assert recording_ms(snap, now_wall_ms=1_000_000) == 700_000
    snap = apply_record_command(
        snap, _cmd("Pause", role="host", pid="p_host"), now_wall_ms=1_000_000
    )
    assert recording_ms(snap, now_wall_ms=1_100_000) == 700_000


def test_leave_keeps_row_for_rejoin() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=1)
    snap = apply_record_command(snap, _cmd("Leave", pid="p_g", seq=2), now_wall_ms=2)
    person = snap.participants[0]
    assert person.connected is False
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=3, seq=3)
    assert snap.participants[0].connected is True
    assert len(snap.participants) == 1


def test_decline_then_late_consent_during_recording() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=1, seq=2)
    snap = apply_record_command(
        snap,
        _cmd("Consent", pid="p_g", payload={"accepted": False}, seq=3),
        now_wall_ms=2,
    )
    assert snap.participants[1].consented is False
    snap2 = _join(snap, pid="p_g2", role="guest", name="Bea", now=3, seq=4)
    snap2 = apply_record_command(
        snap2,
        _cmd("Consent", pid="p_g2", payload={"accepted": True}, seq=5),
        now_wall_ms=4,
    )
    snap2 = apply_record_command(snap2, _cmd("Start", role="host", pid="p_host"), now_wall_ms=10)
    out = apply_record_command(
        snap2,
        _cmd("Consent", pid="p_g", payload={"accepted": True}, seq=6),
        now_wall_ms=11,
    )
    assert out.participants[1].consented is True


def test_remove_participant_marks_removed() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=1)
    snap = apply_record_command(
        snap,
        _cmd(
            "RemoveParticipant",
            role="host",
            pid="p_host",
            payload={"participant_id": "p_g"},
            seq=2,
        ),
        now_wall_ms=2,
    )
    person = snap.participants[0]
    assert person.connected is False
    assert person.removed is True
    assert person.consented is None
    with pytest.raises(RecordStateError, match="removed"):
        _join(snap, pid="p_g", role="guest", name="Ava", now=3, seq=3)


def test_heartbeat_is_noop() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=1)
    out = apply_record_command(snap, _cmd("Heartbeat", pid="p_g", seq=2), now_wall_ms=2)
    assert out.participants[0].display_name == "Ava"


def test_self_commands_and_illegal_transitions() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=1, seq=2)
    with pytest.raises(RecordStateError, match="unknown participant"):
        apply_record_command(
            snap,
            _cmd("SetMuted", pid="p_missing", payload={"muted": True}, seq=3),
            now_wall_ms=2,
        )
    snap = apply_record_command(
        snap, _cmd("SetMuted", pid="p_g", payload={"muted": True}, seq=3), now_wall_ms=2
    )
    assert snap.participants[1].muted is True
    snap = apply_record_command(
        snap, _cmd("HeadphonesAck", pid="p_g", payload={"ok": True}, seq=4), now_wall_ms=3
    )
    assert snap.participants[1].headphones_ack is True
    snap = apply_record_command(
        snap,
        _cmd("UpdateName", pid="p_g", payload={"display_name": "Ava Two"}, seq=5),
        now_wall_ms=4,
    )
    assert snap.participants[1].display_name == "Ava Two"
    with pytest.raises(RecordStateError, match="cannot stop"):
        apply_record_command(snap, _cmd("Stop", role="host", pid="p_host"), now_wall_ms=5)
    with pytest.raises(RecordStateError, match="cannot resume"):
        apply_record_command(snap, _cmd("Resume", role="host", pid="p_host"), now_wall_ms=5)
    snap = apply_record_command(
        snap, _cmd("Consent", pid="p_g", payload={"accepted": True}, seq=6), now_wall_ms=6
    )
    snap = apply_record_command(snap, _cmd("Start", role="host", pid="p_host"), now_wall_ms=10)
    with pytest.raises(RecordStateError, match="cannot start"):
        apply_record_command(snap, _cmd("Start", role="host", pid="p_host"), now_wall_ms=11)
    snap = apply_record_command(snap, _cmd("Stop", role="host", pid="p_host"), now_wall_ms=12)
    assert snap.state == "stopped"
    assert snap.takes[0].stopped_wall_ms == 12
    snap = apply_record_command(snap, _cmd("Start", role="host", pid="p_host"), now_wall_ms=20)
    assert snap.state == "recording"
    assert snap.take_index == 1
    snap = apply_record_command(
        snap,
        _cmd(
            "Comment",
            pid="p_g",
            payload={"id": "live-m1", "pressed_wall_ms": 21, "body": "Marker"},
            seq=8,
        ),
        now_wall_ms=21,
    )
    assert snap.state == "recording"
    snap = apply_record_command(snap, _cmd("Pause", role="host", pid="p_host"), now_wall_ms=22)
    snap = apply_record_command(
        snap,
        _cmd(
            "Comment",
            pid="p_g",
            payload={"id": "live-m2", "pressed_wall_ms": 23, "body": "note"},
            seq=9,
        ),
        now_wall_ms=23,
    )
    assert snap.state == "paused"
    snap = apply_record_command(snap, _cmd("Stop", role="host", pid="p_host"), now_wall_ms=24)
    snap = apply_record_command(
        snap,
        _cmd(
            "Comment",
            pid="p_g",
            payload={"id": "live-m3", "pressed_wall_ms": 25, "body": "late"},
            seq=10,
        ),
        now_wall_ms=25,
    )
    assert snap.state == "stopped"
    bogus = _cmd("Heartbeat", pid="p_g", seq=99)
    bogus.type = "Nope"  # type: ignore[assignment]
    with pytest.raises(ValueError, match="unknown record command type"):
        apply_record_command(snap, bogus, now_wall_ms=21)


def test_join_requires_id_and_reconnect_caps() -> None:
    snap = empty_record_snapshot("sess")
    with pytest.raises(RecordStateError, match="participant_id required"):
        apply_record_command(
            snap,
            RecordCommand.parse(
                command_type="Join",
                payload={"display_name": "Ava"},
                client_id="c",
                role="guest",
                participant_id=None,
                client_seq=1,
            ),
            now_wall_ms=1,
        )
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    for i in range(3):
        snap = _join(snap, pid=f"p_g{i}", role="guest", name=f"G{i}", now=i + 1, seq=i + 2)
    snap = apply_record_command(snap, _cmd("Leave", pid="p_g0", seq=10), now_wall_ms=10)
    snap = _join(snap, pid="p_g3", role="guest", name="G3", now=11, seq=11)
    with pytest.raises(RoomFullError):
        _join(snap, pid="p_g0", role="guest", name="G0", now=12, seq=12)
    snap = apply_record_command(snap, _cmd("Leave", pid="p_g3", seq=13), now_wall_ms=13)
    snap = _join(snap, pid="p_g0", role="guest", name="G0b", now=14, seq=14)
    assert snap.participants[1].display_name == "G0b"
    snap = _join(snap, pid="p_host", role="host", name="Host 2", now=15, seq=15)
    assert snap.participants[0].consented is True
    assert snap.participants[0].display_name == "Host 2"
    with pytest.raises(RecordStateError, match="unknown participant"):
        apply_record_command(
            snap,
            _cmd(
                "RemoveParticipant",
                role="host",
                pid="p_host",
                payload={"participant_id": "nope"},
                seq=16,
            ),
            now_wall_ms=16,
        )
    snap = _join(snap, pid="p_p0", role="producer", name="P0", now=17, seq=17)
    snap = _join(snap, pid="p_p1", role="producer", name="P1", now=18, seq=18)
    snap = apply_record_command(snap, _cmd("Leave", pid="p_p0", seq=19), now_wall_ms=19)
    snap = _join(snap, pid="p_p2", role="producer", name="P2", now=20, seq=20)
    with pytest.raises(RoomFullError):
        _join(snap, pid="p_p0", role="producer", name="P0", now=21, seq=21)


def test_resume_requires_open_pause() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=1, seq=2)
    snap = apply_record_command(
        snap, _cmd("Consent", pid="p_g", payload={"accepted": True}, seq=3), now_wall_ms=2
    )
    snap = apply_record_command(snap, _cmd("Start", role="host", pid="p_host"), now_wall_ms=10)
    snap = apply_record_command(snap, _cmd("Pause", role="host", pid="p_host"), now_wall_ms=20)
    snap.takes[0].pauses[-1].resume_wall_ms = 21
    with pytest.raises(RecordStateError, match="no open pause"):
        apply_record_command(snap, _cmd("Resume", role="host", pid="p_host"), now_wall_ms=22)
    empty = empty_record_snapshot("sess")
    empty.state = "recording"
    with pytest.raises(RecordStateError, match="no active take"):
        apply_record_command(empty, _cmd("Pause", role="host", pid="p_host"), now_wall_ms=1)


def test_recording_ms_handles_inconsistent_take() -> None:
    from podcast_mcp.services.record.state import RecordSnapshot, TakeState
    from podcast_mcp.services.record.state import recording_ms as rms

    snap = RecordSnapshot(session_id="s", state="recording", take_index=-1)
    assert rms(snap, now_wall_ms=10) == 0
    snap = RecordSnapshot(session_id="s", state="recording", take_index=3, takes=[])
    assert rms(snap, now_wall_ms=10) == 0
    snap = RecordSnapshot(
        session_id="s",
        state="recording",
        take_index=3,
        takes=[TakeState(take_index=0, session_start_wall_ms=0, session_start_iso="x")],
    )
    assert rms(snap, now_wall_ms=10) == 10


def test_payload_validation_rejects_blank_names() -> None:
    with pytest.raises(ValueError, match="display_name"):
        RecordCommand.parse(
            command_type="Join",
            payload={"display_name": "   "},
            client_id="c",
            role="guest",
            participant_id="p_g",
            client_seq=1,
        )
    with pytest.raises(ValueError, match="display_name"):
        RecordCommand.parse(
            command_type="UpdateName",
            payload={"display_name": ""},
            client_id="c",
            role="guest",
            participant_id="p_g",
            client_seq=1,
        )
    with pytest.raises(ValueError, match="unknown record command"):
        RecordCommand.parse(
            command_type="Nope",
            payload={},
            client_id="c",
            role="host",
            participant_id="p_host",
            client_seq=1,
        )
    from podcast_mcp.services.record.commands import (
        RecordAuthzError,
        authorize_record_command,
    )

    with pytest.raises(ValueError, match="unknown record command"):
        authorize_record_command(role="host", capabilities=[], command_type="Nope")
    authorize_record_command(role="host", capabilities=[], command_type="Comment")
    with pytest.raises(RecordAuthzError, match="comment capability"):
        authorize_record_command(
            role="guest", capabilities=["join", "monitor"], command_type="Comment"
        )
    authorize_record_command(
        role="guest", capabilities=["join", "monitor", "comment"], command_type="Comment"
    )
    with pytest.raises(ValueError, match="invalid comment id"):
        RecordCommand.parse(
            command_type="Comment",
            payload={"id": "bad id", "body": "Marker", "pressed_wall_ms": 1},
            client_id="c",
            role="guest",
            participant_id="p_g",
            client_seq=1,
        )
    leave = RecordCommand(
        type="Leave",
        payload={},
        client_id="c",
        role="guest",
        participant_id=None,
        client_seq=1,
    )
    with pytest.raises(RecordStateError, match="unknown participant"):
        apply_record_command(empty_record_snapshot("sess"), leave, now_wall_ms=1)
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    snap = apply_record_command(snap, _cmd("Leave", pid="p_host", seq=2), now_wall_ms=2)
    snap.participants[0].consented_wall_ms = None
    snap = _join(snap, pid="p_host", role="host", name="Host", now=3, seq=3)
    assert snap.participants[0].consented is True
    assert snap.participants[0].consented_wall_ms == 3


def _recording_session(now_start: int = 10):
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    snap = _join(snap, pid="p_g", role="guest", name="Ava", now=1, seq=2)
    snap = apply_record_command(
        snap,
        _cmd("Consent", pid="p_g", payload={"accepted": True}, seq=3),
        now_wall_ms=2,
    )
    return apply_record_command(
        snap, _cmd("Start", role="host", pid="p_host"), now_wall_ms=now_start
    )


def test_host_leave_while_recording_persists_offline_since() -> None:
    snap = _recording_session()
    out = apply_record_command(snap, _cmd("Leave", pid="p_host", seq=10), now_wall_ms=20_000)
    assert out.state == "recording"
    assert out.host_offline_since_wall_ms == 20_000
    guest_leave = apply_record_command(snap, _cmd("Leave", pid="p_g", seq=11), now_wall_ms=21_000)
    assert guest_leave.host_offline_since_wall_ms is None


def test_host_join_after_offline_threshold_pauses_once() -> None:
    from podcast_mcp.services.record.state import HOST_OFFLINE_PAUSE_MS

    snap = _recording_session()
    snap = apply_record_command(snap, _cmd("Leave", pid="p_host", seq=10), now_wall_ms=20_000)
    returned = _join(
        snap, pid="p_host", role="host", name="Host", now=20_000 + HOST_OFFLINE_PAUSE_MS, seq=11
    )
    assert returned.state == "paused"
    assert returned.pause_reason == "host_reconnect"
    assert returned.host_offline_since_wall_ms is None
    assert returned.host_offline_gap_ms == HOST_OFFLINE_PAUSE_MS
    assert len(returned.takes[0].pauses) == 1
    assert returned.takes[0].pauses[0].pause_reason == "host_reconnect"
    again = _join(returned, pid="p_host", role="host", name="Host", now=40_000, seq=12)
    assert again.state == "paused"
    assert len(again.takes[0].pauses) == 1


def test_host_join_below_offline_threshold_stays_recording() -> None:
    snap = _recording_session()
    snap = apply_record_command(snap, _cmd("Leave", pid="p_host", seq=10), now_wall_ms=20_000)
    returned = _join(snap, pid="p_host", role="host", name="Host", now=20_500, seq=11)
    assert returned.state == "recording"
    assert returned.pause_reason is None
    assert returned.takes[0].pauses == []
    assert returned.host_offline_since_wall_ms is None


def test_host_return_while_already_paused_does_not_stack() -> None:
    snap = _recording_session()
    snap = apply_record_command(snap, _cmd("Pause", role="host", pid="p_host"), now_wall_ms=15_000)
    snap = apply_record_command(snap, _cmd("Leave", pid="p_host", seq=10), now_wall_ms=20_000)
    assert snap.host_offline_since_wall_ms == 20_000
    returned = _join(snap, pid="p_host", role="host", name="Host", now=40_000, seq=11)
    assert returned.state == "paused"
    assert returned.pause_reason is None
    assert len(returned.takes[0].pauses) == 1
    assert returned.takes[0].pauses[0].pause_reason is None
    assert returned.host_offline_since_wall_ms is None


def test_resume_clears_host_reconnect_pause_reason() -> None:
    from podcast_mcp.services.record.state import HOST_OFFLINE_PAUSE_MS

    snap = _recording_session()
    snap = apply_record_command(snap, _cmd("Leave", pid="p_host", seq=10), now_wall_ms=20_000)
    snap = _join(
        snap, pid="p_host", role="host", name="Host", now=20_000 + HOST_OFFLINE_PAUSE_MS, seq=11
    )
    out = apply_record_command(snap, _cmd("Resume", role="host", pid="p_host"), now_wall_ms=40_000)
    assert out.state == "recording"
    assert out.pause_reason is None
    assert out.host_offline_gap_ms is None
    assert out.takes[0].pauses[0].pause_reason == "host_reconnect"
    assert out.takes[0].pauses[0].resume_wall_ms == 40_000


def test_already_connected_join_does_not_bump_connected_wall_ms() -> None:
    snap = _recording_session()
    host = next(p for p in snap.participants if p.participant_id == "p_host")
    first = host.connected_wall_ms
    again = _join(snap, pid="p_host", role="host", name="Host", now=50_000, seq=20)
    host_again = next(p for p in again.participants if p.participant_id == "p_host")
    assert host_again.connected_wall_ms == first
    assert again.state == "recording"
    assert again.host_last_beat_wall_ms == 50_000


def test_host_heartbeat_updates_last_beat_guest_does_not() -> None:
    snap = _recording_session()
    host_beat = apply_record_command(
        snap, _cmd("Heartbeat", role="host", pid="p_host", seq=20), now_wall_ms=15_000
    )
    assert host_beat.host_last_beat_wall_ms == 15_000
    guest_beat = apply_record_command(
        host_beat, _cmd("Heartbeat", role="guest", pid="p_g", seq=21), now_wall_ms=16_000
    )
    assert guest_beat.host_last_beat_wall_ms == 15_000


def test_recorded_join_full_ignores_unknown_role() -> None:
    snap = empty_record_snapshot("sess")
    snap.caps["recorded"] = 0
    assert _recorded_join_full(snap, "producer") is False


def test_host_return_in_lobby_clears_offline_since_without_pause() -> None:
    snap = empty_record_snapshot("sess")
    snap = _join(snap, pid="p_host", role="host", name="Host", now=0)
    snap.host_offline_since_wall_ms = 1
    again = _join(snap, pid="p_host", role="host", name="Host", now=50_000, seq=2)
    assert again.state == "lobby"
    assert again.host_offline_since_wall_ms is None


def test_prepare_host_rejoin_without_host_row_stamps_recording() -> None:
    snap = empty_record_snapshot("sess")
    snap.state = "recording"
    out = prepare_host_rejoin(snap, since_wall_ms=9_000)
    assert out.host_offline_since_wall_ms == 9_000
    again = prepare_host_rejoin(out, since_wall_ms=1)
    assert again.host_offline_since_wall_ms == 9_000
