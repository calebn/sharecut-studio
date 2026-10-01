from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
import time
from typing import Any, Literal, cast

from anyio import CancelScope
from fastapi import APIRouter, Query, WebSocket
from starlette.concurrency import run_in_threadpool

from podcast_mcp.gui.middleware_host_binding import websocket_host_binding_denied
from podcast_mcp.gui.routes.deps import resolve_project
from podcast_mcp.gui.routes.guest_ws_common import GuestWsGuard, WsTaskSet
from podcast_mcp.gui.routes.session import apply_ws_client_message, apply_ws_viewer_state
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import cross_process_lease
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.service import document_hub_key, host_document_event
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
from podcast_mcp.services.session_sync.authz import AuthzDecision, authorize_client
from podcast_mcp.services.session_sync.commands import SyncCommand, TransportRole
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.services.session_sync.presence_delta import is_own_presence_echo
from podcast_mcp.services.session_sync.service import SessionSyncService
from podcast_mcp.util.proxy_paths import is_relayed_request

router = APIRouter()
log = logging.getLogger(__name__)
HOST_WS_AUTHZ_RECHECK_S = 30.0
Plane = Literal["session", "document", "record"]


def _wire_event(event: dict[str, Any], plane: Plane) -> dict[str, Any]:
    frame = {**event, "plane": plane}
    command = event.get("command")
    author = event.get("author_client_id")
    if not author and isinstance(command, dict):
        author = command.get("client_id")
    if isinstance(author, str) and author:
        frame["client_id"] = author
    return frame


@router.websocket("/api/host/ws")
async def host_ws(
    websocket: WebSocket,
    path: str = Query(...),
    client_id: str = Query(...),
    document_client_id: str = Query(...),
    role: str = Query("viewer"),
    label: str | None = Query(None),
    token: str | None = Query(None),
):
    denied = websocket_host_binding_denied(websocket)
    if denied is not None:
        await websocket.close(code=4403, reason=denied[:120])
        return
    project_path = resolve_project(path, websocket)
    peer = websocket.client.host if websocket.client else None
    relayed = is_relayed_request(websocket.headers)

    def authorize() -> AuthzDecision:
        for identity in (client_id, document_client_id):
            decision = authorize_client(
                client_id=identity,
                role=role,
                peer_host=peer,
                token=token,
                display_name=label,
                relayed=relayed,
            )
            if not decision.allowed:
                return decision
        return decision

    decision = authorize()
    if not decision.allowed:
        await websocket.close(code=4403, reason=decision.reason[:120])
        return

    def open_services() -> tuple[ProjectWorkspace, SessionSyncService, DocumentSyncService]:
        document = DocumentSyncService.open(project_path)
        workspace = document.ws
        return workspace, SessionSyncService(workspace.project), document

    workspace, session, document = await run_in_threadpool(open_services)
    await websocket.accept()
    guard = GuestWsGuard(
        websocket,
        lambda: authorize().allowed,
        interval=HOST_WS_AUTHZ_RECHECK_S,
        revoked_reason="authorization revoked",
    )
    hub = get_hub()
    loop = asyncio.get_running_loop()
    session_key = str(workspace.project.workspace_path())
    document_key = document_hub_key(workspace.project)
    subscriptions = contextlib.ExitStack()
    session_queue = hub.subscribe(session_key, loop)
    subscriptions.callback(hub.unsubscribe, session_key, session_queue)
    document_queue = hub.subscribe(document_key, loop)
    subscriptions.callback(hub.unsubscribe, document_key, document_queue)
    tasks = WsTaskSet(f"host ws client_id={client_id}")
    record_tasks = WsTaskSet(f"host record ws client_id={client_id}")
    record_queue: asyncio.Queue[dict[str, Any]] | None = None
    record: RecordSessionService | None = None
    attached_sid: str | None = None
    fail_until = 0.0
    connection_id = f"host:{client_id}:{secrets.token_hex(8)}"
    seq = 1
    presence_generation: int | None = None

    async def send(event: dict[str, Any], plane: Plane) -> None:
        await guard.send_json(_wire_event(event, plane))

    async def pump(queue: asyncio.Queue[dict[str, Any]], plane: Plane) -> None:
        try:
            while True:
                event = await queue.get()
                if plane == "session" and is_own_presence_echo(event, client_id):
                    continue
                if plane == "document":
                    event = host_document_event(event)
                if plane == "record":
                    filtered = filter_record_event_for_guest(
                        event, participant_id=HOST_PARTICIPANT_ID, role="host"
                    )
                    if filtered is None:
                        continue
                    event = filtered
                await send(event, plane)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("%s pump failed client_id=%s", plane, client_id)
            with contextlib.suppress(Exception):
                await guard.close(1011, f"{plane} pump failed")
            raise

    async def detach_record() -> None:
        nonlocal record, record_queue, attached_sid
        with CancelScope(shield=True):
            old = record
            try:
                if record_queue is not None:
                    hub.unsubscribe(record_hub_key(workspace.project), record_queue)
                    record_queue = None
                await record_tasks.stop()
            finally:
                try:
                    if old is not None:
                        await run_in_threadpool(
                            old.disconnect, HOST_PARTICIPANT_ID, connection_id=connection_id
                        )
                finally:
                    record = None
                    attached_sid = None

    async def attach_record() -> None:
        nonlocal record, record_queue, attached_sid, fail_until
        session_id = await run_in_threadpool(
            RecordSessionService.active_session_id, workspace.project
        )
        if record is not None and attached_sid == session_id and session_id:
            return
        if record is not None:
            await detach_record()
        if not session_id or time.monotonic() < fail_until:
            return
        record = await run_in_threadpool(
            RecordSessionService, workspace.project, session_id=session_id
        )
        record_queue = hub.subscribe(record_hub_key(workspace.project), loop)
        try:
            echo, snapshot = await run_in_threadpool(
                record.join,
                token="",
                role="host",
                display_name=label or "Host",
                client_id=f"record-join:{client_id}",
                connection_id=connection_id,
            )
            attached_sid = session_id
            await send(
                {
                    "type": "Echo",
                    "client_id": client_id,
                    "participant_id": echo.get("participant_id") or HOST_PARTICIPANT_ID,
                    "snapshot": snapshot,
                },
                "record",
            )
            await send({"type": "Snapshot", "snapshot": snapshot}, "record")
            record_tasks.spawn(pump(record_queue, "record"))
        except (
            RecordStateError,
            RecordAuthzError,
            RoomFullError,
            LeaseInUseError,
            ValueError,
        ) as exc:
            await detach_record()
            fail_until = time.monotonic() + 1.0
            await send(
                {"type": "Error", "code": "record_attach_failed", "detail": str(exc)}, "record"
            )

    def join_session() -> dict[str, Any]:
        nonlocal presence_generation
        presence_generation = session.claim_client(client_id)
        session.submit(
            SyncCommand(
                type="PresenceHeartbeat",
                payload={"label": label, "playhead_sec": None},
                client_id=client_id,
                role=cast(TransportRole, role),
                client_seq=seq,
            )
        )
        return session.snapshot()

    try:
        async with cross_process_lease(workspace):
            try:
                tasks.spawn(guard.recheck_loop())
                initial_session = await run_in_threadpool(join_session)
                seq += 1
                await send({"type": "Snapshot", "snapshot": initial_session}, "session")
                initial_document = await run_in_threadpool(
                    document.document_snapshot, projection="shell"
                )
                await send({"type": "Snapshot", "snapshot": initial_document}, "document")
                tasks.spawn(pump(session_queue, "session"))
                tasks.spawn(pump(document_queue, "document"))
                await attach_record()
                while not guard.closed:
                    raw = await websocket.receive()
                    if raw["type"] == "websocket.disconnect":
                        break
                    if not await guard.share_ok_on_frame():
                        await guard.close(4403, "authorization revoked")
                        break
                    try:
                        message = json.loads(raw.get("text") or raw.get("bytes") or b"")
                        if not isinstance(message, dict):
                            raise ValueError("expected an object")
                    except (ValueError, UnicodeError):
                        if guard.note_malformed():
                            await guard.close(4400, "too many malformed frames")
                            break
                        continue
                    if message.get("plane") == "document":
                        continue
                    await attach_record()
                    if message.get("type") == "Record":
                        if record is None:
                            continue
                        try:
                            echo, seq = await run_in_threadpool(
                                route_record_ws_message,
                                record,
                                message,
                                client_id=client_id,
                                role="host",
                                participant_id=HOST_PARTICIPANT_ID,
                                seq=seq,
                                connection_id=connection_id,
                            )
                            await send({**echo, "client_id": client_id}, "record")
                        except RecordAuthzError as exc:
                            await send(
                                {"type": "Error", "code": "forbidden", "detail": str(exc)}, "record"
                            )
                        except (RecordStateError, RoomFullError, ValueError) as exc:
                            await send(
                                {"type": "Error", "code": "invalid_state", "detail": str(exc)},
                                "record",
                            )
                        continue
                    if message.get("type") == "ViewerState":
                        echo = await run_in_threadpool(
                            apply_ws_viewer_state,
                            session,
                            message.get("snapshot"),
                            client_id=client_id,
                            role=role,
                            label=label,
                        )
                        await send(echo, "session")
                        continue
                    try:
                        session_echo, seq = await run_in_threadpool(
                            apply_ws_client_message,
                            session,
                            message,
                            client_id=client_id,
                            role=role,
                            label=label,
                            seq=seq,
                        )
                    except (KeyError, TypeError, ValueError) as exc:
                        await send(
                            {"type": "Error", "code": "invalid_message", "detail": str(exc)[:500]},
                            "session",
                        )
                        continue
                    if session_echo is not None:
                        await send(session_echo, "session")
            finally:
                with CancelScope(shield=True):
                    subscriptions.close()
                    try:
                        try:
                            if guard.closed:
                                await guard.wait_closed()
                        finally:
                            await tasks.stop()
                    finally:
                        try:
                            await detach_record()
                        finally:
                            if presence_generation is not None:
                                await run_in_threadpool(
                                    session.remove_client, client_id, generation=presence_generation
                                )
    finally:
        subscriptions.close()
