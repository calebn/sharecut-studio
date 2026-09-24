"""Public record-share routes — token-scoped, no review mix or host paths."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect

from podcast_mcp.edits.share_capabilities import CAP_JOIN, CAP_MONITOR, has_capability
from podcast_mcp.edits.share_registry import SHARE_KIND_RECORD
from podcast_mcp.gui.routes.guest_ws_common import GuestWsGuard, guest_ws_reject
from podcast_mcp.gui.routes.record_upload_http import (
    UploadKindParam,
    ingest_record_upload_request,
)
from podcast_mcp.gui.routes.share_common import (
    check_share_token,
    rate_limit_share,
    share_features_manifest,
)
from podcast_mcp.services.record.commands import RecordAuthzError
from podcast_mcp.services.record.reducer import RecordStateError, RoomFullError
from podcast_mcp.services.record.service import (
    LeaseInUseError,
    RecordSessionService,
    filter_record_event_for_guest,
    record_hub_key,
    route_record_ws_message,
)
from podcast_mcp.services.record.state import RecordRole
from podcast_mcp.services.record.upload import (
    UPLOAD_KIND_ROOM_TONE,
    RecordUploadError,
    RecordUploadService,
    parse_participant_id,
    parse_upload_kind,
)
from podcast_mcp.services.record_share import record_bootstrap
from podcast_mcp.services.remote_mcp.limits import get_host_limiters, host_rate_limit_enabled
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.services.share import lookup_share, open_share_workspace
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.ws_limits import GUEST_FRAME_MAX_BYTES

router = APIRouter()
log = logging.getLogger(__name__)


@router.get("/api/rec/{token}/bootstrap")
def get_record_bootstrap(token: str) -> dict[str, Any]:
    row = check_share_token(token, kind=SHARE_KIND_RECORD)
    rate_limit_share(token, "read")
    return record_bootstrap(row)


@router.get("/api/rec/{token}/features")
def get_record_features(token: str, request: Request) -> dict[str, Any]:
    check_share_token(token, kind=SHARE_KIND_RECORD)
    rate_limit_share(token, "read")
    return share_features_manifest(request)


def _record_still_valid(token: str) -> bool:
    try:
        row = lookup_share(token, kind=SHARE_KIND_RECORD)
    except (KeyError, FileNotFoundError):
        return False
    return has_capability(row.get("capabilities"), CAP_MONITOR)


@router.websocket("/api/rec/{token}/ws")
async def record_ws(
    websocket: WebSocket,
    token: str,
    client_id: str | None = Query(None),
    name: str | None = Query(None),
) -> None:
    try:
        row = lookup_share(token, kind=SHARE_KIND_RECORD)
    except KeyError:
        await guest_ws_reject(websocket, 4403, "invalid or revoked share token")
        return
    if not has_capability(row.get("capabilities"), CAP_MONITOR):
        await guest_ws_reject(websocket, 4403, "monitor capability required")
        return
    role_raw = str(row.get("role") or "guest")
    if role_raw not in ("guest", "producer"):
        await guest_ws_reject(websocket, 4403, "invalid record role")
        return
    role: RecordRole = role_raw  # type: ignore[assignment]
    session_id = str(row.get("session_id") or "")
    if not session_id:
        await guest_ws_reject(websocket, 4403, "record room missing")
        return
    try:
        _row, ws_proj = open_share_workspace(token, kind=SHARE_KIND_RECORD)
    except (KeyError, FileNotFoundError):
        await guest_ws_reject(websocket, 4403, "share not found")
        return

    gate_held = False
    if host_rate_limit_enabled():
        lim = get_host_limiters()
        gate = lim.guest_ws_concurrent.try_enter(token)
        if not gate.allowed:
            await guest_ws_reject(websocket, 4429, "guest ws concurrency limit")
            return
        gate_held = True

    caps = list(row.get("capabilities") or [])
    guest_client_id = client_id or f"rec-{token[:8]}"
    svc = RecordSessionService(ws_proj.project, session_id=session_id)
    hub = get_hub()
    hub_key = record_hub_key(ws_proj.project)
    connection_id = secrets.token_hex(8)
    participant_id: str | None = None
    joined = False
    q = None
    pump_task: asyncio.Task[None] | None = None
    recheck_task: asyncio.Task[None] | None = None
    guard: GuestWsGuard | None = None

    def _connection_valid() -> bool:
        return _record_still_valid(token) and (
            participant_id is None or svc.participant_active(participant_id)
        )

    try:
        await websocket.accept()
        guard = GuestWsGuard(websocket, _connection_valid)
        loop = asyncio.get_running_loop()
        q = hub.subscribe(hub_key, loop)

        async def _pump() -> None:
            assert q is not None and guard is not None
            try:
                while True:
                    event = await q.get()
                    if not _connection_valid():
                        await guard.close(4403, "participant removed or share revoked")
                        return
                    filtered = filter_record_event_for_guest(
                        event,
                        participant_id=participant_id or "",
                        role=role,
                    )
                    if filtered is None:
                        continue
                    await guard.send_json(filtered)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("record pump failed token=%s", token[:8])
                with contextlib.suppress(Exception):
                    await guard.close(1011, "record pump failed")
                raise

        pump_task = asyncio.create_task(_pump())
        recheck_task = asyncio.create_task(guard.recheck_loop())

        while True:
            try:
                text = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            if not guard.share_ok_on_frame() or not _connection_valid():
                await guard.close(4403, "participant removed or share revoked")
                break
            if len(text) > GUEST_FRAME_MAX_BYTES:
                if guard.note_malformed():
                    await guard.close(4400, "too many malformed frames")
                    break
                continue
            try:
                msg = json.loads(text)
            except ValueError:
                if guard.note_malformed():
                    await guard.close(4400, "too many malformed frames")
                    break
                continue
            if not isinstance(msg, dict) or msg.get("type") != "Record":
                await guard.send_json({"plane": "record", "type": "Error", "code": "join_first"})
                continue
            command_type = str(msg.get("command_type") or "")
            raw_payload = msg.get("payload")
            payload: dict[str, Any] = raw_payload if isinstance(raw_payload, dict) else {}
            if host_rate_limit_enabled() and command_type not in (
                "Heartbeat",
                "HeadphonesAck",
            ):
                lim = get_host_limiters()
                conn_key = f"{token}:{connection_id}"
                if command_type == "Signal":
                    if not lim.guest_ws_record_signal.allow(conn_key).allowed:
                        await guard.send_json(
                            {"plane": "record", "type": "Error", "code": "rate_limited"}
                        )
                        continue
                    if not lim.guest_ws_record_signal_token.allow(token).allowed:
                        await guard.send_json(
                            {"plane": "record", "type": "Error", "code": "rate_limited"}
                        )
                        continue
                else:
                    if not lim.guest_ws_record.allow(conn_key).allowed:
                        await guard.send_json(
                            {"plane": "record", "type": "Error", "code": "rate_limited"}
                        )
                        continue
                    if not lim.guest_ws_record_token.allow(token).allowed:
                        await guard.send_json(
                            {"plane": "record", "type": "Error", "code": "rate_limited"}
                        )
                        continue
            try:
                if not joined:
                    if command_type != "Join":
                        await guard.send_json(
                            {"plane": "record", "type": "Error", "code": "join_first"}
                        )
                        continue
                    echo, snap = svc.join(
                        token=token,
                        role=role,
                        display_name=str(
                            payload.get("display_name") or name or f"Guest {token[:6]}"
                        ),
                        participant_id=payload.get("participant_id"),
                        lease=payload.get("lease"),
                        client_id=guest_client_id,
                        connection_id=connection_id,
                        capabilities=caps,
                        client_seq=int(msg.get("client_seq") or 1),
                    )
                    participant_id = str(echo["participant_id"])
                    joined = True
                    filtered_join = filter_record_event_for_guest(
                        {"plane": "record", "type": "Snapshot", "snapshot": snap},
                        participant_id=participant_id,
                        role=role,
                    )
                    snap_out = (filtered_join or {}).get("snapshot", snap)
                    await guard.send_json(
                        {
                            "plane": "record",
                            "type": "Echo",
                            **echo,
                        }
                    )
                    await guard.send_json(
                        {
                            "plane": "record",
                            "type": "Snapshot",
                            "snapshot": snap_out,
                        }
                    )
                    continue
                echo, _seq = route_record_ws_message(
                    svc,
                    msg,
                    client_id=guest_client_id,
                    role=role,
                    participant_id=participant_id,
                    seq=int(msg.get("client_seq") or 1),
                    capabilities=caps,
                    connection_id=connection_id,
                )
                filtered_echo = filter_record_event_for_guest(
                    echo,
                    participant_id=participant_id or "",
                    role=role,
                )
                await guard.send_json(filtered_echo or echo)
            except LeaseInUseError:
                await guard.send_json({"plane": "record", "type": "Error", "code": "lease_in_use"})
            except RecordAuthzError:
                await guard.send_json({"plane": "record", "type": "Error", "code": "forbidden"})
            except RoomFullError:
                await guard.send_json({"plane": "record", "type": "Error", "code": "room_full"})
            except (RecordStateError, ValueError) as exc:
                await guard.send_json(
                    {
                        "plane": "record",
                        "type": "Error",
                        "code": "invalid_state",
                        "detail": str(exc),
                    }
                )
    finally:
        try:
            if q is not None:
                hub.unsubscribe(hub_key, q)
            for task in (pump_task, recheck_task):
                if task is not None:
                    task.cancel()
            for task in (pump_task, recheck_task):
                if task is None:
                    continue
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception:
                    log.exception("record ws pump exit token=%s", token[:8])
            if participant_id is not None:
                svc.disconnect(participant_id, connection_id=connection_id)
        finally:
            if gate_held:
                get_host_limiters().guest_ws_concurrent.exit(token)


def _guest_upload_ctx(
    token: str,
) -> tuple[RecordUploadService, RecordSessionService, str, ProjectWorkspace]:
    row = check_share_token(token, kind=SHARE_KIND_RECORD)
    if not has_capability(row.get("capabilities"), CAP_JOIN):
        raise HTTPException(status_code=403, detail="join capability required")
    _, ws = open_share_workspace(token, kind=SHARE_KIND_RECORD)
    session_id = str(row.get("session_id") or "")
    if not session_id:
        raise HTTPException(status_code=404, detail="no active record room")
    return (
        RecordUploadService(ws.project),
        RecordSessionService(ws.project, session_id=session_id),
        session_id,
        ws,
    )


def _require_guest_lease(
    svc: RecordSessionService, token: str, participant_id: str, lease: str
) -> str:
    try:
        pid = parse_participant_id(participant_id)
    except RecordUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not lease or not svc.verify_lease(pid, lease, token=token):
        raise HTTPException(status_code=403, detail="invalid lease")
    return pid


def _require_guest_upload_consent(
    svc: RecordSessionService, pid: str, kind: str | None, take_index: int
) -> None:
    try:
        parsed = parse_upload_kind(kind)
    except RecordUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    scoped_take = None if parsed == UPLOAD_KIND_ROOM_TONE else take_index
    if not svc.upload_consented(pid, take_index=scoped_take):
        raise HTTPException(status_code=403, detail="consent required")


@router.get("/api/rec/{token}/upload")
def get_record_upload_status(
    token: str,
    x_record_participant: str = Header(..., alias="X-Record-Participant"),
    x_record_lease: str = Header(..., alias="X-Record-Lease"),
) -> dict[str, Any]:
    uploader, session, session_id, _ws = _guest_upload_ctx(token)
    rate_limit_share(token, "read")
    pid = _require_guest_lease(session, token, x_record_participant, x_record_lease)
    return uploader.status(session_id=session_id, participant_id=pid)


@router.post("/api/rec/{token}/upload")
async def post_record_upload(
    request: Request,
    token: str,
    take_index: int = Query(...),
    segment_index: int = Query(...),
    part_seq: int = Query(...),
    sha256: str = Query(""),
    file_sha256: str | None = Query(None),
    final: bool = Query(False),
    expected_parts: int | None = Query(None, ge=1),
    join_offset_ms: int | None = Query(None),
    kind: UploadKindParam = None,
    x_record_participant: str = Header(..., alias="X-Record-Participant"),
    x_record_lease: str = Header(..., alias="X-Record-Lease"),
):
    uploader, session, session_id, ws = _guest_upload_ctx(token)
    rate_limit_share(token, "mutate")
    pid = _require_guest_lease(session, token, x_record_participant, x_record_lease)
    _require_guest_upload_consent(session, pid, kind, take_index)

    def before_ingest() -> None:
        _require_guest_lease(session, token, x_record_participant, x_record_lease)
        _require_guest_upload_consent(session, pid, kind, take_index)

    return await ingest_record_upload_request(
        request,
        uploader,
        session_id=session_id,
        participant_id=pid,
        take_index=take_index,
        segment_index=segment_index,
        part_seq=part_seq,
        sha256=sha256,
        file_sha256=file_sha256,
        final=final,
        expected_parts=expected_parts,
        join_offset_ms=join_offset_ms,
        workspace=ws,
        clip_scope=pid,
        kind=kind,
        before_ingest=before_ingest,
    )


@router.delete("/api/rec/{token}/upload")
def delete_record_upload(
    token: str,
    kind: UploadKindParam = None,
    x_record_participant: str = Header(..., alias="X-Record-Participant"),
    x_record_lease: str = Header(..., alias="X-Record-Lease"),
) -> dict[str, Any]:
    uploader, session, session_id, _ws = _guest_upload_ctx(token)
    rate_limit_share(token, "mutate")
    pid = _require_guest_lease(session, token, x_record_participant, x_record_lease)
    try:
        parsed = parse_upload_kind(kind)
    except RecordUploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if parsed != UPLOAD_KIND_ROOM_TONE:
        raise HTTPException(status_code=400, detail="only room_tone can be revoked")
    uploader.revoke_room_tone(session_id, pid)
    return {"revoked": True, "kind": UPLOAD_KIND_ROOM_TONE}
