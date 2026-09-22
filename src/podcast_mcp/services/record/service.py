"""Record session authority: prefixed SyncStore + participant leases + hub fanout."""

from __future__ import annotations

import itertools
import threading
import time
from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.review_shares import list_usable_shares
from podcast_mcp.edits.share_registry import SHARE_KIND_RECORD
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.record.commands import (
    RecordAuthzError,
    RecordCommand,
    authorize_record_command,
)
from podcast_mcp.services.record.live_comments import (
    RecordLiveCommentError,
    drop_cached_record_live_comment_stores,
    live_comment_store_for,
)
from podcast_mcp.services.record.participants import RecordParticipantStore
from podcast_mcp.services.record.reducer import (
    RecordStateError,
    RoomFullError,
    apply_record_command,
    prepare_host_rejoin,
)
from podcast_mcp.services.record.signal import fanout_record_signal
from podcast_mcp.services.record.state import (
    HOST_OFFLINE_PAUSE_MS,
    HOST_PARTICIPANT_ID,
    TAKE_OPEN_REMINT_MSG,
    RecordRole,
    RecordSnapshot,
    empty_record_snapshot,
    recording_ms,
    recording_ms_at,
    start_blockers,
    take_containing_wall,
)
from podcast_mcp.services.record.upload import drop_cached_record_upload_stores
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.services.session_sync.log import cached_sync_store, drop_cached_sync_stores
from podcast_mcp.services.session_sync.service import sync_db_path
from podcast_mcp.services.share import drop_absolute_path_strings

LEASE_IN_USE_GRACE_S = 15.0
_SID_TTL_S = 0.5
_SEQ = itertools.count(1)
_PART_CACHE: dict[str, RecordParticipantStore] = {}
_STORE_LOCK = threading.Lock()
_SID_CACHE: dict[str, tuple[float, str | None]] = {}


class LeaseInUseError(PermissionError):
    """A live tab already holds this participant lease."""


@dataclass
class _Conn:
    connection_id: str
    last_beat: float


_CONNECTIONS: dict[str, _Conn] = {}
_HOST_CONNS: dict[str, dict[str, tuple[float, int]]] = {}
_CONN_LOCK = threading.Lock()


def _now_pair() -> tuple[float, int]:
    return time.monotonic(), time.time_ns() // 1_000_000


def reset_record_runtime_for_tests() -> None:
    with _CONN_LOCK:
        _CONNECTIONS.clear()
        _HOST_CONNS.clear()
    _SID_CACHE.clear()
    stores = drop_cached_sync_stores(table_prefix="record_")
    upload_stores = drop_cached_record_upload_stores()
    comment_stores = drop_cached_record_live_comment_stores()
    with _STORE_LOCK:
        parts = list(_PART_CACHE.values())
        _PART_CACHE.clear()
    for store in stores:
        store.close()
    for upload_store in upload_stores:
        upload_store.close()
    for comment_store in comment_stores:
        comment_store.close()
    for part in parts:
        part.close()


def next_record_client_seq() -> int:
    return next(_SEQ)


def record_hub_key(project: EpisodeProject) -> str:
    return f"record:{project.workspace_path()}"


def _guest_key(hub_key: str, participant_id: str) -> str:
    return f"{hub_key}:{participant_id}"


def _workspace_cache_key(project: EpisodeProject) -> str:
    return str(project.workspace_path())


def invalidate_record_session_cache(project: EpisodeProject) -> None:
    _SID_CACHE.pop(_workspace_cache_key(project), None)


def claim_connection(participant_id: str, connection_id: str, *, hub_key: str) -> None:
    if participant_id == HOST_PARTICIPANT_ID:
        now_mono, now_wall = _now_pair()
        with _CONN_LOCK:
            _HOST_CONNS.setdefault(hub_key, {})[connection_id] = (now_mono, now_wall)
        return
    now = time.monotonic()
    key = _guest_key(hub_key, participant_id)
    with _CONN_LOCK:
        existing = _CONNECTIONS.get(key)
        if (
            existing is not None
            and existing.connection_id != connection_id
            and now - existing.last_beat < LEASE_IN_USE_GRACE_S
        ):
            raise LeaseInUseError("lease_in_use")
        _CONNECTIONS[key] = _Conn(connection_id, now)


def touch_connection(participant_id: str, connection_id: str, *, hub_key: str) -> None:
    now_mono, now_wall = _now_pair()
    with _CONN_LOCK:
        if participant_id == HOST_PARTICIPANT_ID:
            bucket = _HOST_CONNS.get(hub_key)
            if bucket is not None and connection_id in bucket:
                bucket[connection_id] = (now_mono, now_wall)
            return
        existing = _CONNECTIONS.get(_guest_key(hub_key, participant_id))
        if existing is not None and existing.connection_id == connection_id:
            existing.last_beat = now_mono


def connection_holds(hub_key: str, participant_id: str, connection_id: str) -> bool:
    with _CONN_LOCK:
        if participant_id == HOST_PARTICIPANT_ID:
            bucket = _HOST_CONNS.get(hub_key)
            return bucket is not None and connection_id in bucket
        existing = _CONNECTIONS.get(_guest_key(hub_key, participant_id))
        return existing is not None and existing.connection_id == connection_id


def release_connection(participant_id: str, connection_id: str, *, hub_key: str) -> bool:
    """Drop this socket. Return True when the participant has no remaining connections."""
    last, _beat = _release_connection(participant_id, connection_id, hub_key=hub_key)
    return last


def _release_connection(
    participant_id: str, connection_id: str, *, hub_key: str
) -> tuple[bool, int | None]:
    with _CONN_LOCK:
        if participant_id == HOST_PARTICIPANT_ID:
            bucket = _HOST_CONNS.get(hub_key)
            if bucket is None:
                return True, None
            popped = bucket.pop(connection_id, None)
            if not bucket:
                _HOST_CONNS.pop(hub_key, None)
                beat = popped[1] if popped is not None else None
                return True, beat
            return False, None
        key = _guest_key(hub_key, participant_id)
        existing = _CONNECTIONS.get(key)
        if existing is not None and existing.connection_id == connection_id:
            _CONNECTIONS.pop(key, None)
            return True, None
        return existing is None, None


def clear_connections_for_hub(hub_key: str) -> None:
    prefix = f"{hub_key}:"
    with _CONN_LOCK:
        for key in [item for item in _CONNECTIONS if item.startswith(prefix)]:
            _CONNECTIONS.pop(key, None)
        _HOST_CONNS.pop(hub_key, None)


def filter_record_event_for_guest(
    event: dict[str, Any],
    *,
    participant_id: str,
    role: str,
) -> dict[str, Any] | None:
    if event.get("type") == "Signal" and event.get("to") != participant_id:
        return None
    stripped = _strip_lease_keys(event)
    if role != "guest":
        return stripped
    return _filter_live_comments_for_guest(stripped, participant_id)


def _filter_live_comments_for_guest(obj: Any, participant_id: str) -> Any:
    if isinstance(obj, dict):
        out = {
            key: _filter_live_comments_for_guest(value, participant_id)
            for key, value in obj.items()
        }
        comments = out.get("comments")
        if isinstance(comments, list):
            out["comments"] = [
                row
                for row in comments
                if isinstance(row, dict) and str(row.get("author") or "") == participant_id
            ]
        return out
    if isinstance(obj, list):
        return [_filter_live_comments_for_guest(item, participant_id) for item in obj]
    return obj


def _strip_lease_keys(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {
            key: _strip_lease_keys(value)
            for key, value in obj.items()
            if not str(key).lower().startswith("lease")
        }
    if isinstance(obj, list):
        return [_strip_lease_keys(item) for item in obj]
    return obj


def _store_for(project: EpisodeProject):
    return cached_sync_store(sync_db_path(project), table_prefix="record_")


def infer_host_offline_since(
    hub_key: str,
    snap: RecordSnapshot,
    *,
    now_wall_ms: int,
) -> int | None:
    """Guess last-host-leave time when Leave never landed or the sidecar slept."""
    if snap.state not in ("recording", "paused"):
        return None
    if snap.host_offline_since_wall_ms is not None:
        return snap.host_offline_since_wall_ms
    with _CONN_LOCK:
        bucket = dict(_HOST_CONNS.get(hub_key) or {})
    if bucket:
        newest = max(wall for _mono, wall in bucket.values())
        if now_wall_ms - newest >= HOST_OFFLINE_PAUSE_MS:
            return newest
        return None
    if snap.host_last_beat_wall_ms is not None:
        return snap.host_last_beat_wall_ms
    return max(0, now_wall_ms - HOST_OFFLINE_PAUSE_MS)


def _persist_host_offline_since(store: Any, since_wall_ms: int) -> None:
    def mutator(raw: dict[str, Any]) -> dict[str, Any] | None:
        snap = RecordSnapshot.model_validate(raw)
        if snap.state not in ("recording", "paused") or snap.host_offline_since_wall_ms is not None:
            return None
        snap.host_offline_since_wall_ms = max(0, since_wall_ms)
        return snap.model_dump()

    store.mutate_snapshot(mutator)


def _participants_for(project: EpisodeProject) -> RecordParticipantStore:
    key = str(sync_db_path(project).resolve())
    with _STORE_LOCK:
        store = _PART_CACHE.get(key)
        if store is None:
            store = RecordParticipantStore(sync_db_path(project))
            _PART_CACHE[key] = store
        return store


def begin_record_session(project: EpisodeProject, session_id: str) -> None:
    """Start a new room: wipe the previous record command log and snapshot."""
    hub = record_hub_key(project)
    store = _store_for(project)
    active = RecordSessionService.active_session_id(project)

    def guard(raw: dict[str, Any] | None) -> None:
        if not active or not raw:
            return
        snap = RecordSnapshot.model_validate(raw)
        if snap.state in ("recording", "paused"):
            raise RecordStateError(TAKE_OPEN_REMINT_MSG)

    store.reset(empty_record_snapshot(session_id).model_dump(), guard=guard)
    _participants_for(project).clear_all()
    live_comment_store_for(project).clear_all()
    clear_connections_for_hub(hub)
    invalidate_record_session_cache(project)


def assert_no_open_take(project: EpisodeProject) -> None:
    """Refuse remint while the active room is recording or paused."""
    session_id = RecordSessionService.active_session_id(project)
    if not session_id:
        return
    raw = _store_for(project).get_snapshot()
    if not raw:
        return
    snap = RecordSnapshot.model_validate(raw)
    if snap.state in ("recording", "paused"):
        raise RecordStateError(TAKE_OPEN_REMINT_MSG)


class RecordSessionService:
    def __init__(self, project: EpisodeProject, *, session_id: str) -> None:
        self.project = project
        self.session_id = session_id
        self._store = _store_for(project)
        self._participants = _participants_for(project)
        self._comments = live_comment_store_for(project)
        self._hub_key = record_hub_key(project)

    @staticmethod
    def active_session_id(project: EpisodeProject) -> str | None:
        cache_key = _workspace_cache_key(project)
        now = time.monotonic()
        hit = _SID_CACHE.get(cache_key)
        if hit is not None and now - hit[0] < _SID_TTL_S:
            return hit[1]
        last: str | None = None
        for row in list_usable_shares(project):
            if str(row.get("kind") or "") != SHARE_KIND_RECORD:
                continue
            sid = str(row.get("session_id") or "")
            if sid:
                last = sid
        _SID_CACHE[cache_key] = (now, last)
        return last

    def _empty(self) -> dict[str, Any]:
        return empty_record_snapshot(self.session_id).model_dump()

    def _model(self) -> RecordSnapshot:
        raw = self._store.get_snapshot() or self._empty()
        return RecordSnapshot.model_validate(raw)

    def verify_lease(self, participant_id: str, lease: str, *, token: str) -> bool:
        if participant_id == HOST_PARTICIPANT_ID:
            return False
        return self._participants.verify(
            participant_id,
            lease,
            token=token,
            session_id=self.session_id,
        )

    def snapshot(self) -> dict[str, Any]:
        snap = self._model()
        now_ms = time.time_ns() // 1_000_000
        out = snap.model_dump()
        out["recording_ms"] = recording_ms(snap, now_wall_ms=now_ms)
        out["start_blockers"] = start_blockers(snap)
        out["server_time_ns"] = time.time_ns()
        out["comments"] = [
            {
                "id": row["comment_id"],
                "take_index": row["take_index"],
                "recording_ms": row["recording_ms"],
                "pressed_wall_ms": row["pressed_wall_ms"],
                "author": row["author"],
                "body": row["body"],
            }
            for row in self._comments.list_unlanded(self.session_id)
        ]
        return drop_absolute_path_strings(out)

    def join(
        self,
        *,
        token: str,
        role: RecordRole,
        display_name: str,
        participant_id: str | None = None,
        lease: str | None = None,
        client_id: str,
        connection_id: str,
        capabilities: list[str] | None = None,
        client_seq: int | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        if role == "host":
            pid = HOST_PARTICIPANT_ID
            lease_out = ""
        elif participant_id and lease:
            if not self._participants.verify(
                participant_id,
                lease,
                token=token,
                session_id=self.session_id,
            ):
                raise RecordAuthzError("invalid lease")
            pid = participant_id
            lease_out = lease
            self._participants.touch(pid)
        else:
            pid, lease_out = self._participants.mint(
                session_id=self.session_id,
                token=token,
                role=role,
                display_name=display_name,
            )
        inferred_since = None
        now_wall_ms = time.time_ns() // 1_000_000
        if role == "host":
            inferred_since = infer_host_offline_since(
                self._hub_key, self._model(), now_wall_ms=now_wall_ms
            )
        claim_connection(pid, connection_id, hub_key=self._hub_key)
        # Per-connection id so a tab reload (stable guest client_id, seq 1)
        # is not collapsed as the original Join.
        cmd = RecordCommand.parse(
            command_type="Join",
            payload={
                "display_name": display_name,
                "participant_id": pid,
                "lease": lease_out or None,
            },
            client_id=f"record-join:{connection_id}:{client_id}",
            role=role,
            participant_id=pid,
            client_seq=client_seq if client_seq is not None else 1,
        )
        # Lease stays on the Echo only — never persist it on the snapshot.
        cmd.payload.pop("lease", None)
        try:
            snap = self.submit(
                cmd,
                capabilities=capabilities,
                host_offline_since=inferred_since,
            )
        except Exception:
            last, beat = _release_connection(pid, connection_id, hub_key=self._hub_key)
            if last and beat is not None:
                _persist_host_offline_since(self._store, beat)
            raise
        echo: dict[str, Any] = {"participant_id": pid}
        if role != "host":
            echo["lease"] = lease_out
        return echo, snap

    def submit(
        self,
        cmd: RecordCommand,
        *,
        now_wall_ms: int | None = None,
        capabilities: list[str] | None = None,
        connection_id: str | None = None,
        host_offline_since: int | None = None,
    ) -> dict[str, Any]:
        caps = list(capabilities or [])
        if cmd.role == "host" and not caps:
            caps = ["join", "monitor"]
        authorize_record_command(
            role=cmd.role,
            capabilities=caps,
            command_type=cmd.type,
        )
        wall = time.time_ns() // 1_000_000 if now_wall_ms is None else now_wall_ms
        if cmd.type == "Comment":
            self._rewrite_comment(cmd, now_wall_ms=wall)
        stored_payload = dict(cmd.payload)
        stored_payload["participant_id"] = cmd.participant_id
        stored_payload.pop("lease", None)
        hub = self._hub_key

        def apply_fn(snap_dict: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
            if cmd.type == "Leave" and connection_id is not None:
                with _CONN_LOCK:
                    if cmd.participant_id == HOST_PARTICIPANT_ID:
                        if _HOST_CONNS.get(hub):
                            return snap_dict
                    else:
                        existing = _CONNECTIONS.get(_guest_key(hub, cmd.participant_id or ""))
                        if existing is not None:
                            return snap_dict
            current = RecordSnapshot.model_validate(snap_dict or self._empty())
            if cmd.type == "Join" and cmd.role == "host":
                since = host_offline_since
                if since is None:
                    since = infer_host_offline_since(hub, current, now_wall_ms=wall)
                if since is not None:
                    current = prepare_host_rejoin(current, since_wall_ms=since)
            applied = RecordCommand.parse(
                command_type=str(row["type"]),
                payload=row.get("payload") or {},
                client_id=str(row["client_id"]),
                role=row["role"],
                participant_id=(row.get("payload") or {}).get("participant_id"),
                client_seq=int(row["client_seq"]),
                command_id=str(row["command_id"]),
            )
            out = apply_record_command(current, applied, now_wall_ms=wall).model_dump()
            if cmd.type == "Comment":
                self._upsert_comment(cmd)
            return out

        _row, _snap, idempotent = self._store.append_and_apply(
            command_id=cmd.command_id,
            client_id=cmd.client_id,
            client_seq=cmd.client_seq,
            role=cmd.role,
            type=cmd.type,
            payload=stored_payload,
            causation_id=None,
            apply_fn=apply_fn,
            empty_snap_fn=self._empty,
        )
        if cmd.type == "Comment" and idempotent:
            self._upsert_comment(cmd)
        api = self.snapshot()
        if idempotent:
            return api
        event = drop_absolute_path_strings(
            {
                "plane": "record",
                "type": "Applied",
                "command": {"type": cmd.type, "participant_id": cmd.participant_id},
                "snapshot": api,
            }
        )
        get_hub().publish(self._hub_key, event)
        return api

    def _rewrite_comment(self, cmd: RecordCommand, *, now_wall_ms: int) -> None:
        current = self._model()
        raw_pressed = cmd.payload.get("pressed_wall_ms")
        pressed = now_wall_ms if raw_pressed is None else int(raw_pressed)
        pressed = min(max(0, pressed), now_wall_ms)
        take = take_containing_wall(current, pressed)
        if take is None:
            raise RecordStateError("cannot comment unless recording or paused")
        cmd.payload["pressed_wall_ms"] = pressed
        cmd.payload["take_index"] = take.take_index
        cmd.payload["recording_ms"] = recording_ms_at(take, wall_ms=pressed)
        cmd.payload["author"] = cmd.participant_id or ""

    def _upsert_comment(self, cmd: RecordCommand) -> None:
        try:
            self._comments.upsert(
                session_id=self.session_id,
                comment_id=str(cmd.payload.get("id") or cmd.command_id),
                take_index=int(cmd.payload["take_index"]),
                recording_ms=int(cmd.payload["recording_ms"]),
                pressed_wall_ms=int(cmd.payload["pressed_wall_ms"]),
                author=str(cmd.payload.get("author") or cmd.participant_id or ""),
                body=str(cmd.payload.get("body") or ""),
            )
        except RecordLiveCommentError as exc:
            raise RecordStateError(str(exc)) from exc

    def disconnect(self, participant_id: str, *, connection_id: str | None = None) -> None:
        if connection_id is not None:
            last, beat = _release_connection(participant_id, connection_id, hub_key=self._hub_key)
            if not last:
                return
            if participant_id == HOST_PARTICIPANT_ID and beat is not None:
                # A websocket close is an observed host departure.  The stored
                # heartbeat only represents the last sample, which may be stale.
                _persist_host_offline_since(self._store, _now_pair()[1])
        person = next(
            (
                p
                for p in self._model().participants
                if p.participant_id == participant_id and p.connected
            ),
            None,
        )
        if person is None:
            return
        cmd = RecordCommand.parse(
            command_type="Leave",
            payload={},
            client_id=f"disconnect:{participant_id}",
            role=person.role,
            participant_id=participant_id,
            client_seq=next_record_client_seq(),
        )
        try:
            self.submit(
                cmd,
                capabilities=["join", "monitor"],
                connection_id=connection_id,
            )
        except (RecordStateError, RecordAuthzError, RoomFullError):
            return


def route_record_ws_message(
    svc: RecordSessionService,
    msg: dict[str, Any],
    *,
    client_id: str,
    role: RecordRole,
    participant_id: str | None,
    seq: int,
    capabilities: list[str] | None = None,
    connection_id: str | None = None,
) -> tuple[dict[str, Any], int]:
    """Dispatch one inbound ``{type: Record}`` frame (commands persist; Signal does not)."""
    if msg.get("type") != "Record":
        raise ValueError("join_first")
    command_type = str(msg.get("command_type") or "")
    client_seq = int(msg.get("client_seq") or seq)
    if command_type == "Signal":
        if not participant_id:
            raise ValueError("join_first")
        if connection_id is not None:
            if not connection_holds(svc._hub_key, participant_id, connection_id):
                raise RecordStateError("stale_connection")
            touch_connection(participant_id, connection_id, hub_key=svc._hub_key)
        raw_payload = msg.get("payload")
        payload: dict[str, Any] = raw_payload if isinstance(raw_payload, dict) else {}
        roster_ids = {
            str(person.get("participant_id"))
            for person in svc.snapshot().get("participants") or []
            if person.get("participant_id")
        }
        echo = fanout_record_signal(
            svc._hub_key,
            from_id=participant_id,
            payload=payload,
            role=role,
            capabilities=capabilities,
            roster_ids=roster_ids,
        )
        return echo, client_seq + 1
    return apply_record_ws_message(
        svc,
        msg,
        client_id=client_id,
        role=role,
        participant_id=participant_id,
        seq=seq,
        capabilities=capabilities,
        connection_id=connection_id,
    )


def apply_record_ws_message(
    svc: RecordSessionService,
    msg: dict[str, Any],
    *,
    client_id: str,
    role: RecordRole,
    participant_id: str | None,
    seq: int,
    capabilities: list[str] | None = None,
    connection_id: str | None = None,
) -> tuple[dict[str, Any], int]:
    """Handle one inbound ``{type: Record}`` frame. Returns (echo, next_seq)."""
    if msg.get("type") != "Record":
        raise ValueError("join_first")
    command_type = str(msg.get("command_type") or "")
    raw_payload = msg.get("payload")
    payload: dict[str, Any] = raw_payload if isinstance(raw_payload, dict) else {}
    client_seq = int(msg.get("client_seq") or seq)
    cmd = RecordCommand.parse(
        command_type=command_type,
        payload=payload,
        client_id=client_id,
        role=role,
        participant_id=participant_id or payload.get("participant_id"),
        client_seq=client_seq,
        command_id=msg.get("command_id"),
    )
    if participant_id and connection_id:
        if not connection_holds(svc._hub_key, participant_id, connection_id):
            raise RecordStateError("stale_connection")
        if cmd.type == "Heartbeat":
            touch_connection(participant_id, connection_id, hub_key=svc._hub_key)
    snap = svc.submit(cmd, capabilities=capabilities, connection_id=connection_id)
    echo = {
        "plane": "record",
        "type": "Echo",
        "command_type": cmd.type,
        "participant_id": cmd.participant_id,
        "snapshot": snap,
    }
    return echo, client_seq + 1
