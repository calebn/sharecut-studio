"""Pure record-session reducer. All state-machine tests target this module."""

from __future__ import annotations

from datetime import UTC, datetime

from podcast_mcp.services.record.commands import RecordCommand
from podcast_mcp.services.record.state import (
    HOST_OFFLINE_PAUSE_MS,
    HOST_PARTICIPANT_ID,
    ParticipantState,
    PauseEntry,
    PauseReason,
    RecordSnapshot,
    TakeState,
    producer_count,
    recorded_count,
    start_blockers,
)


class RecordStateError(ValueError):
    """Illegal record-session transition."""


class RoomFullError(RecordStateError):
    """Recorded or producer cap would be exceeded."""


def _iso(now_wall_ms: int) -> str:
    return datetime.fromtimestamp(now_wall_ms / 1000, tz=UTC).isoformat()


def _find(snap: RecordSnapshot, participant_id: str | None) -> ParticipantState | None:
    if not participant_id:
        return None
    for person in snap.participants:
        if person.participant_id == participant_id:
            return person
    return None


def _require_self(snap: RecordSnapshot, cmd: RecordCommand) -> ParticipantState:
    person = _find(snap, cmd.participant_id)
    if person is None or person.removed:
        raise RecordStateError("unknown participant")
    return person


def _current_take(snap: RecordSnapshot) -> TakeState:
    for take in snap.takes:
        if take.take_index == snap.take_index:
            return take
    raise RecordStateError("no active take")


def _host_live(snap: RecordSnapshot) -> bool:
    person = _find(snap, HOST_PARTICIPANT_ID)
    return person is not None and person.connected and not person.removed


def _recorded_join_full(snap: RecordSnapshot, role: str) -> bool:
    cap = int(snap.caps.get("recorded") or 0)
    live = recorded_count(snap)
    if role == "host":
        return live >= cap
    if role == "guest":
        reserved = 0 if _host_live(snap) else 1
        return live + reserved >= cap
    return False


def _join(snap: RecordSnapshot, cmd: RecordCommand, *, now_wall_ms: int) -> RecordSnapshot:
    pid = cmd.participant_id
    if not pid:
        raise RecordStateError("participant_id required")
    existing = _find(snap, pid)
    if existing is not None and existing.removed:
        raise RecordStateError("participant removed")
    display_name = str(cmd.payload.get("display_name") or "")
    if existing is None:
        if cmd.role in ("host", "guest") and _recorded_join_full(snap, cmd.role):
            raise RoomFullError("room_full")
        if cmd.role == "producer" and producer_count(snap) >= int(snap.caps.get("producers") or 0):
            raise RoomFullError("room_full")
        consented = True if cmd.role == "host" else None
        person = ParticipantState(
            participant_id=pid,
            role=cmd.role,
            display_name=display_name,
            connected=True,
            consented=consented,
            consented_wall_ms=now_wall_ms if cmd.role == "host" else None,
            joined_wall_ms=now_wall_ms,
            connected_wall_ms=now_wall_ms,
        )
        snap.participants.append(person)
        if cmd.role == "host":
            snap.host_last_beat_wall_ms = now_wall_ms
            return _apply_host_return(snap, now_wall_ms=now_wall_ms)
        return snap
    if not existing.connected:
        if existing.role in ("host", "guest") and _recorded_join_full(snap, existing.role):
            raise RoomFullError("room_full")
        if existing.role == "producer" and producer_count(snap) >= int(
            snap.caps.get("producers") or 0
        ):
            raise RoomFullError("room_full")
    was_connected = existing.connected
    existing.connected = True
    if not was_connected:
        existing.connected_wall_ms = now_wall_ms
    existing.role = cmd.role
    if display_name:
        existing.display_name = display_name
    if cmd.role == "host":
        existing.participant_id = existing.participant_id or HOST_PARTICIPANT_ID
        existing.consented = True
        if existing.consented_wall_ms is None:
            existing.consented_wall_ms = now_wall_ms
        snap.host_last_beat_wall_ms = now_wall_ms
        return _apply_host_return(snap, now_wall_ms=now_wall_ms)
    return snap


def _clear_live_pause_reason(snap: RecordSnapshot) -> None:
    snap.pause_reason = None
    snap.host_offline_gap_ms = None


def _enter_pause(
    snap: RecordSnapshot,
    now_wall_ms: int,
    *,
    reason: PauseReason | None = None,
) -> RecordSnapshot:
    take = _current_take(snap)
    take.pauses.append(
        PauseEntry(seq=len(take.pauses), pause_wall_ms=now_wall_ms, pause_reason=reason)
    )
    snap.state = "paused"
    if reason is not None:
        snap.pause_reason = reason
    return snap


def prepare_host_rejoin(snap: RecordSnapshot, *, since_wall_ms: int) -> RecordSnapshot:
    """Apply last-host Leave semantics without appending a Leave command."""
    person = _find(snap, HOST_PARTICIPANT_ID)
    if person is not None:
        person.connected = False
    if snap.state in ("recording", "paused") and snap.host_offline_since_wall_ms is None:
        snap.host_offline_since_wall_ms = max(0, since_wall_ms)
    return snap


def _apply_host_return(snap: RecordSnapshot, *, now_wall_ms: int) -> RecordSnapshot:
    since = snap.host_offline_since_wall_ms
    snap.host_offline_since_wall_ms = None
    if since is None:
        return snap
    if snap.state == "paused":
        return snap
    if snap.state != "recording":
        return snap
    gap = max(0, now_wall_ms - since)
    if gap < HOST_OFFLINE_PAUSE_MS:
        return snap
    _enter_pause(snap, now_wall_ms, reason="host_reconnect")
    snap.host_offline_gap_ms = gap
    return snap


def apply_record_command(
    snap: RecordSnapshot,
    cmd: RecordCommand,
    *,
    now_wall_ms: int,
) -> RecordSnapshot:
    out = snap.model_copy(deep=True)
    ctype = cmd.type
    if ctype == "Join":
        return _join(out, cmd, now_wall_ms=now_wall_ms)
    if ctype == "Leave":
        person = _require_self(out, cmd)
        person.connected = False
        if (
            person.participant_id == HOST_PARTICIPANT_ID
            and out.state in ("recording", "paused")
            and out.host_offline_since_wall_ms is None
        ):
            out.host_offline_since_wall_ms = max(0, now_wall_ms)
        return out
    if ctype == "Consent":
        person = _require_self(out, cmd)
        accepted = bool(cmd.payload.get("accepted"))
        person.consented = accepted
        person.consented_wall_ms = now_wall_ms
        return out
    if ctype == "SetMuted":
        person = _require_self(out, cmd)
        person.muted = bool(cmd.payload.get("muted"))
        return out
    if ctype == "HeadphonesAck":
        person = _require_self(out, cmd)
        person.headphones_ack = bool(cmd.payload.get("ok"))
        return out
    if ctype == "UpdateName":
        person = _require_self(out, cmd)
        person.display_name = str(cmd.payload.get("display_name") or person.display_name)
        return out
    if ctype == "Heartbeat":
        if cmd.participant_id == HOST_PARTICIPANT_ID:
            out.host_last_beat_wall_ms = now_wall_ms
        return out
    if ctype == "Comment":
        return out
    if ctype == "Start":
        if out.state not in ("lobby", "stopped"):
            raise RecordStateError(f"cannot start from {out.state}")
        blockers = start_blockers(out)
        if blockers:
            raise RecordStateError("waiting for consent: " + ", ".join(blockers))
        take_index = out.take_index + 1
        out.take_index = take_index
        out.takes.append(
            TakeState(
                take_index=take_index,
                session_start_wall_ms=now_wall_ms,
                session_start_iso=_iso(now_wall_ms),
            )
        )
        out.state = "recording"
        out.host_offline_since_wall_ms = None
        out.host_last_beat_wall_ms = now_wall_ms
        _clear_live_pause_reason(out)
        return out
    if ctype == "Pause":
        if out.state != "recording":
            raise RecordStateError("cannot pause unless recording")
        return _enter_pause(out, now_wall_ms)
    if ctype == "Resume":
        if out.state != "paused":
            raise RecordStateError("cannot resume unless paused")
        take = _current_take(out)
        if not take.pauses or take.pauses[-1].resume_wall_ms is not None:
            raise RecordStateError("no open pause")
        take.pauses[-1].resume_wall_ms = now_wall_ms
        out.state = "recording"
        _clear_live_pause_reason(out)
        return out
    if ctype == "Stop":
        if out.state not in ("recording", "paused"):
            raise RecordStateError("cannot stop unless recording or paused")
        take = _current_take(out)
        if out.state == "paused" and take.pauses and take.pauses[-1].resume_wall_ms is None:
            take.pauses[-1].resume_wall_ms = now_wall_ms
        take.stopped_wall_ms = now_wall_ms
        out.state = "stopped"
        out.host_offline_since_wall_ms = None
        _clear_live_pause_reason(out)
        return out
    if ctype == "RemoveParticipant":
        target_id = str(cmd.payload.get("participant_id") or "")
        target = _find(out, target_id)
        if target is None:
            raise RecordStateError("unknown participant")
        target.connected = False
        target.consented = None
        target.removed = True
        return out
    raise ValueError(f"unknown record command type: {ctype}")
