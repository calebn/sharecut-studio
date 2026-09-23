"""Record-session snapshot models and derived clocks."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

RecordState = Literal["lobby", "recording", "paused", "stopped"]
RecordRole = Literal["host", "guest", "producer"]
PauseReason = Literal["host_reconnect"]

RECORDED_ROLES: frozenset[str] = frozenset({"host", "guest"})
DEFAULT_RECORDED_CAP = 4
DEFAULT_PRODUCER_CAP = 2
HOST_PARTICIPANT_ID = "p_host"
HOST_OFFLINE_PAUSE_MS = 10_000
HOST_HEARTBEAT_STALE_MS = 7_500
TAKE_OPEN_REMINT_MSG = "A take is open (REC/PAUSED). Stop it before minting a new room."


class PauseEntry(BaseModel):
    model_config = ConfigDict(extra="ignore")
    seq: int
    pause_wall_ms: int
    resume_wall_ms: int | None = None
    pause_reason: PauseReason | None = None


class TakeState(BaseModel):
    model_config = ConfigDict(extra="ignore")
    take_index: int
    session_start_wall_ms: int
    session_start_iso: str
    stopped_wall_ms: int | None = None
    pauses: list[PauseEntry] = Field(default_factory=list)
    # None means a legacy take stored before per-take consent tracking existed.
    consented_participant_ids: list[str] | None = None


class ParticipantState(BaseModel):
    model_config = ConfigDict(extra="ignore")
    participant_id: str
    role: RecordRole
    display_name: str
    connected: bool = False
    consented: bool | None = None
    consented_wall_ms: int | None = None
    muted: bool = False
    headphones_ack: bool = False
    joined_wall_ms: int
    connected_wall_ms: int | None = None
    removed: bool = False


class RecordSnapshot(BaseModel):
    model_config = ConfigDict(extra="ignore")
    version: int = 1
    session_id: str
    state: RecordState = "lobby"
    take_index: int = -1
    takes: list[TakeState] = Field(default_factory=list)
    participants: list[ParticipantState] = Field(default_factory=list)
    caps: dict[str, int] = Field(
        default_factory=lambda: {
            "recorded": DEFAULT_RECORDED_CAP,
            "producers": DEFAULT_PRODUCER_CAP,
        }
    )
    host_offline_since_wall_ms: int | None = None
    host_last_beat_wall_ms: int | None = None
    pause_reason: PauseReason | None = None
    host_offline_gap_ms: int | None = None


def empty_record_snapshot(session_id: str) -> RecordSnapshot:
    return RecordSnapshot(session_id=session_id)


def _current_take(snap: RecordSnapshot) -> TakeState | None:
    if snap.take_index < 0:
        return None
    for take in snap.takes:
        if take.take_index == snap.take_index:
            return take
    return snap.takes[-1] if snap.takes else None


def find_participant(snap: RecordSnapshot, participant_id: str | None) -> ParticipantState | None:
    """Roster row for ``participant_id`` (None for a falsy or unknown id)."""
    if not participant_id:
        return None
    for person in snap.participants:
        if person.participant_id == participant_id:
            return person
    return None


def take_containing_wall(snap: RecordSnapshot, wall_ms: int) -> TakeState | None:
    """Take whose wall span includes ``wall_ms`` (open take has no end)."""
    for take in snap.takes:
        if wall_ms < take.session_start_wall_ms:
            continue
        end = take.stopped_wall_ms
        if end is None or wall_ms <= end:
            return take
    return None


def recording_ms_at(take: TakeState, *, wall_ms: int) -> int:
    """Recording clock at ``wall_ms`` for this take, collapsing pause spans."""
    end = take.stopped_wall_ms if take.stopped_wall_ms is not None else wall_ms
    clamped = min(max(wall_ms, take.session_start_wall_ms), end)
    elapsed = clamped - take.session_start_wall_ms
    paused = 0
    for entry in take.pauses:
        pause_end = entry.resume_wall_ms if entry.resume_wall_ms is not None else clamped
        paused += max(0, min(pause_end, clamped) - entry.pause_wall_ms)
    return max(0, elapsed - paused)


def take_recording_duration_ms(take: TakeState) -> int:
    """Recording-clock length of a stopped take; 0 if still open."""
    if take.stopped_wall_ms is None:
        return 0
    return recording_ms_at(take, wall_ms=take.stopped_wall_ms)


def recording_ms(snap: RecordSnapshot, *, now_wall_ms: int) -> int:
    """Wall minus summed pause spans; 0 outside an open take."""
    if snap.state not in ("recording", "paused"):
        return 0
    take = _current_take(snap)
    if take is None:
        return 0
    return recording_ms_at(take, wall_ms=now_wall_ms)


def _live(p: ParticipantState) -> bool:
    return p.connected and not p.removed


def recorded_count(snap: RecordSnapshot) -> int:
    return sum(1 for p in snap.participants if p.role in RECORDED_ROLES and _live(p))


def producer_count(snap: RecordSnapshot) -> int:
    return sum(1 for p in snap.participants if p.role == "producer" and _live(p))


def start_blockers(snap: RecordSnapshot) -> list[str]:
    """Display names / reasons that block host Start."""
    guests = [p for p in snap.participants if p.role == "guest" and _live(p)]
    if not guests:
        return ["No one has joined"]
    recorded = [p for p in snap.participants if p.role in RECORDED_ROLES and _live(p)]
    return [p.display_name for p in recorded if p.consented is None]


def take_consented_participant_ids(snap: RecordSnapshot) -> list[str]:
    """Recorded participants who have currently consented (for a new take's roster).

    Liveness is deliberately not required: a consented guest whose socket dropped
    just before Start keeps the take (they still need a valid lease to upload).
    """
    return [
        p.participant_id
        for p in snap.participants
        if p.role in RECORDED_ROLES and not p.removed and p.consented is True
    ]


def guest_upload_consented(
    snap: RecordSnapshot, participant_id: str, *, take_index: int | None
) -> bool:
    """Whether ``participant_id`` may upload a chunk for ``take_index`` (None = room tone).

    Room tone uses the participant's current consent. A keeper chunk is checked
    against the take's consent roster captured at Start and updated by mid-take
    Accept/Decline; a legacy take (``consented_participant_ids is None``) falls
    back to "participant exists and has not declined".

    A participant the host removed is refused for every take and for room tone.
    """
    person = find_participant(snap, participant_id)
    if person is None or person.removed:
        return False
    if take_index is None:
        return person.consented is True
    take = next((t for t in snap.takes if t.take_index == take_index), None)
    if take is None:
        return False
    if take.consented_participant_ids is None:
        return person.consented is not False
    return participant_id in take.consented_participant_ids
