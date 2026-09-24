from __future__ import annotations

import asyncio
import contextlib
import secrets
import time
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from podcast_mcp.gui.jobs import session_file_meta
from podcast_mcp.gui.middleware_host_binding import websocket_host_binding_denied
from podcast_mcp.gui.routes.deps import peer_host, require_authz, resolve_project
from podcast_mcp.gui.schemas import SessionCommandRequest, ViewerSessionSnapshot
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.record.commands import RecordAuthzError
from podcast_mcp.services.record.reducer import RecordStateError, RoomFullError
from podcast_mcp.services.record.service import (
    LeaseInUseError,
    RecordSessionService,
    filter_record_event_for_guest,
    record_hub_key,
    route_record_ws_message,
)
from podcast_mcp.services.record.state import HOST_PARTICIPANT_ID
from podcast_mcp.services.session_sync.authz import authorize_client
from podcast_mcp.services.session_sync.commands import SyncCommand, retry_command_id
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.services.session_sync.log import ClientSequenceConflictError
from podcast_mcp.services.session_sync.service import SessionSyncService, read_session_state
from podcast_mcp.services.session_sync.viewer import publish_viewer_snapshot
from podcast_mcp.util.proxy_paths import is_relayed_request

router = APIRouter()


def _auth(
    request: Request,
    *,
    client_id: str = "viewer",
    role: str = "viewer",
    token: str | None = None,
    x_podcast_token: str | None = None,
) -> None:
    require_authz(
        client_id=client_id,
        role=role,
        peer_host=peer_host(request),
        token=token or x_podcast_token,
        relayed=is_relayed_request(request.headers),
    )


def apply_ws_client_message(
    svc: SessionSyncService,
    msg: dict[str, Any],
    *,
    client_id: str,
    role: str,
    label: str | None,
    seq: int,
) -> tuple[dict[str, Any] | None, int]:
    """Handle one inbound WS client message. Returns (echo_or_none, next_seq)."""
    mtype = msg.get("type")
    if mtype == "Record":
        return None, seq
    if mtype == "Command":
        client_seq = int(msg["client_seq"])
        payload = msg.get("payload") or {}
        command_type = msg["command_type"]
        command_id = msg.get("command_id") or retry_command_id(
            client_id=client_id,
            client_seq=client_seq,
            role=role,
            type=command_type,
            payload=payload,
        )
        cmd = SyncCommand(
            type=command_type,
            payload=payload,
            client_id=client_id,
            role=role,  # type: ignore[arg-type]
            client_seq=client_seq,
            command_id=command_id,
        )
        try:
            result = svc.submit(cmd)
        except ClientSequenceConflictError as exc:
            return {
                "type": "Error",
                "code": "client_seq_conflict",
                "client_seq": client_seq,
                "command_id": command_id,
                "detail": str(exc),
            }, seq
        return {**result, "type": "Echo"}, seq
    if mtype == "Ack":
        svc.submit(
            SyncCommand(
                type="Ack",
                payload={
                    "acked_server_seq": int(msg.get("acked_server_seq") or 0),
                    "playhead_sec": msg.get("playhead_sec"),
                    "label": label,
                },
                client_id=client_id,
                role=role,  # type: ignore[arg-type]
                client_seq=int(msg.get("client_seq") or seq),
            )
        )
        return None, seq + 1
    if mtype == "Presence":
        svc.submit(
            SyncCommand(
                type="PresenceHeartbeat",
                payload={
                    "label": label or msg.get("label"),
                    "playhead_sec": msg.get("playhead_sec"),
                    "meta": msg.get("meta"),
                },
                client_id=client_id,
                role=role,  # type: ignore[arg-type]
                client_seq=int(msg.get("client_seq") or seq),
            )
        )
        return None, seq + 1
    return None, seq


@router.get("/api/session/meta")
def get_session_meta(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    _auth(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    return session_file_meta(project_path)


@router.get("/api/session/state")
def get_session_state(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    _auth(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    ws = ProjectWorkspace.open(project_path)
    state = read_session_state(ws.project)
    if state is None:
        return JSONResponse(
            status_code=404,
            content={"available": False},
        )
    return state


@router.post("/api/session/command")
def post_session_command(
    body: SessionCommandRequest,
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    _auth(
        request,
        client_id=body.client_id,
        role=body.role,
        token=token or x_podcast_token,
    )
    project_path = resolve_project(path, request)
    ws = ProjectWorkspace.open(project_path)
    svc = SessionSyncService(ws.project)
    cmd = SyncCommand(
        type=body.type,  # type: ignore[arg-type]
        payload=body.payload,
        client_id=body.client_id,
        role=body.role,  # type: ignore[arg-type]
        client_seq=body.client_seq,
        command_id=body.command_id
        or retry_command_id(
            client_id=body.client_id,
            client_seq=body.client_seq,
            role=body.role,
            type=body.type,
            payload=body.payload,
            causation_id=body.causation_id,
        ),
        causation_id=body.causation_id,
    )
    try:
        return svc.submit(cmd)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/session/state")
def post_session_state(
    body: ViewerSessionSnapshot,
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    """Viewer blob -> typed commands (Ack, presence heartbeat, durable deltas)."""
    _auth(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    ws = ProjectWorkspace.open(project_path)
    snapshot = body.model_dump(exclude_none=True)
    return publish_viewer_snapshot(ws.project, snapshot)


@router.websocket("/api/session/ws")
async def session_ws(
    websocket: WebSocket,
    path: str = Query(...),
    client_id: str = Query(...),
    role: str = Query("viewer"),
    label: str | None = Query(None),
    token: str | None = Query(None),
):
    denied = websocket_host_binding_denied(websocket)
    if denied is not None:
        await websocket.close(code=4403, reason=denied[:120])
        return
    project_path = resolve_project(path, websocket)  # type: ignore[arg-type]
    peer = websocket.client.host if websocket.client else None
    decision = authorize_client(
        client_id=client_id,
        role=role,
        peer_host=peer,
        token=token,
        display_name=label,
        relayed=is_relayed_request(websocket.headers),
    )
    if not decision.allowed:
        await websocket.close(code=4403, reason=decision.reason[:120])
        return
    ws_proj = ProjectWorkspace.open(project_path)
    svc = SessionSyncService(ws_proj.project)
    await websocket.accept()
    hub = get_hub()
    # Must match SessionSyncService._project_key (workspace root)
    key = str(ws_proj.project.workspace_path())
    loop = asyncio.get_running_loop()
    queue = hub.subscribe(key, loop)
    write_lock = asyncio.Lock()
    rec_queue = None
    rec_task: asyncio.Task[None] | None = None
    rec_svc: RecordSessionService | None = None
    attached_sid: str | None = None
    fail_until = 0.0
    host_record_conn_id = f"host:{client_id}:{secrets.token_hex(8)}"
    seq = 1
    svc.submit(
        SyncCommand(
            type="PresenceHeartbeat",
            payload={"label": label, "playhead_sec": None},
            client_id=client_id,
            role=role,  # type: ignore[arg-type]
            client_seq=seq,
        )
    )
    seq += 1
    await websocket.send_json({"type": "Snapshot", "snapshot": svc.snapshot()})

    async def _send(payload: dict[str, Any]) -> None:
        async with write_lock:
            await websocket.send_json(payload)

    async def _pump_hub() -> None:
        while True:
            event = await queue.get()
            await _send(event)

    async def _pump_record() -> None:
        assert rec_queue is not None
        while True:
            event = await rec_queue.get()
            filtered = filter_record_event_for_guest(
                event,
                participant_id=HOST_PARTICIPANT_ID,
                role="host",
            )
            if filtered is None:
                continue
            await _send(filtered)

    async def _detach_record() -> None:
        nonlocal rec_svc, rec_queue, rec_task, attached_sid
        if rec_queue is not None:
            hub.unsubscribe(record_hub_key(ws_proj.project), rec_queue)
            rec_queue = None
        if rec_task is not None:
            rec_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await rec_task
            rec_task = None
        rec_svc = None
        attached_sid = None

    async def _attach_record() -> None:
        nonlocal rec_svc, rec_queue, rec_task, attached_sid, fail_until
        session_id = RecordSessionService.active_session_id(ws_proj.project)
        if rec_svc is not None and attached_sid == session_id and session_id:
            return
        if rec_svc is not None:
            await _detach_record()
        if not session_id:
            return
        now = time.monotonic()
        if now < fail_until:
            return
        rec_svc = RecordSessionService(ws_proj.project, session_id=session_id)
        rec_queue = hub.subscribe(record_hub_key(ws_proj.project), loop)
        rec_task = asyncio.create_task(_pump_record())
        try:
            echo, snap = rec_svc.join(
                token="",
                role="host",
                display_name=label or "Host",
                client_id=f"record-join:{client_id}",
                connection_id=host_record_conn_id,
            )
            attached_sid = session_id
            await _send(
                {
                    "plane": "record",
                    "type": "Echo",
                    "participant_id": echo.get("participant_id") or HOST_PARTICIPANT_ID,
                    "snapshot": snap,
                }
            )
            await _send({"plane": "record", "type": "Snapshot", "snapshot": snap})
        except (
            RecordStateError,
            RecordAuthzError,
            RoomFullError,
            LeaseInUseError,
            ValueError,
        ) as exc:
            await _detach_record()
            fail_until = time.monotonic() + 1.0
            with contextlib.suppress(Exception):
                await _send(
                    {
                        "plane": "record",
                        "type": "Error",
                        "code": "record_attach_failed",
                        "detail": str(exc),
                    }
                )

    await _attach_record()
    hub_task = asyncio.create_task(_pump_hub())
    try:
        while True:
            try:
                msg = await websocket.receive_json()
            except WebSocketDisconnect:
                break
            await _attach_record()
            if rec_svc is not None and msg.get("type") == "Record":
                try:
                    rec_echo, seq = route_record_ws_message(
                        rec_svc,
                        msg,
                        client_id=client_id,
                        role="host",
                        participant_id=HOST_PARTICIPANT_ID,
                        seq=seq,
                        connection_id=host_record_conn_id,
                    )
                    await _send(rec_echo)
                except RecordAuthzError as exc:
                    await _send(
                        {
                            "plane": "record",
                            "type": "Error",
                            "code": "forbidden",
                            "detail": str(exc),
                        }
                    )
                except (RecordStateError, RoomFullError, ValueError) as exc:
                    await _send(
                        {
                            "plane": "record",
                            "type": "Error",
                            "code": "invalid_state",
                            "detail": str(exc),
                        }
                    )
                continue
            echo, seq = apply_ws_client_message(
                svc,
                msg,
                client_id=client_id,
                role=role,
                label=label,
                seq=seq,
            )
            if echo is not None:
                await _send(echo)
    finally:
        if rec_svc is not None:
            rec_svc.disconnect(HOST_PARTICIPANT_ID, connection_id=host_record_conn_id)
        hub.unsubscribe(key, queue)
        hub_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await hub_task
        await _detach_record()
        svc.remove_client(client_id)
