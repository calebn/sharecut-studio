"""Document-plane HTTP/WS - comment live updates (separate from transport session)."""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from podcast_mcp.edits.transcript_refine_status import TranscriptRefineRequiredError
from podcast_mcp.gui.middleware_host_binding import websocket_host_binding_denied
from podcast_mcp.gui.routes.deps import peer_host, require_authz, resolve_project
from podcast_mcp.gui.schemas import DocumentCommandRequest
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.document_sync.payloads import (
    document_command_from_body,
    parse_document_command,
)
from podcast_mcp.services.document_sync.service import document_hub_key
from podcast_mcp.services.session_sync.authz import authorize_client
from podcast_mcp.services.session_sync.hub import get_hub

router = APIRouter()


def _submit_ws_command(
    svc: DocumentSyncService,
    msg: dict[str, Any],
    *,
    client_id: str,
    role: str,
    seq: int,
) -> dict[str, Any]:
    cmd = parse_document_command(
        {
            "type": msg["command_type"],
            "payload": msg.get("payload") or {},
            "client_id": client_id,
            "role": role,
            "client_seq": int(msg.get("client_seq") or seq - 1),
            "command_id": msg.get("command_id") or uuid4().hex,
            "structural_mode": msg.get("structural_mode"),
        }
    )
    return svc.submit(cmd, structural_mode=msg.get("structural_mode"))


@router.get("/api/document/comments")
def get_document_comments(
    request: Request,
    path: str = Query(...),
    client_id: str = Query("viewer"),
    role: str = Query("viewer"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_authz(
        client_id=client_id,
        role=role,
        peer_host=peer_host(request),
        token=token or x_podcast_token,
    )
    project_path = resolve_project(path, request)
    svc = DocumentSyncService.open(project_path)
    return svc.comments_snapshot()


@router.post("/api/document/command")
def post_document_command(
    body: DocumentCommandRequest,
    request: Request,
    path: str = Query(...),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_authz(
        client_id=body.client_id,
        role=body.role,
        peer_host=peer_host(request),
        token=token or x_podcast_token or body.token,
    )
    project_path = resolve_project(path, request)
    svc = DocumentSyncService.open(project_path)
    cmd = document_command_from_body(body)
    try:
        return svc.submit(cmd, structural_mode=body.structural_mode)
    except DocumentConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail={"detail": str(exc), "conflict": True},
        ) from exc
    except TranscriptRefineRequiredError as exc:
        raise HTTPException(
            status_code=409,
            detail=str(exc),
            headers={"X-Sharecut-Error-Code": "transcript_refine_required"},
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.websocket("/api/document/ws")
async def document_ws(
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
    )
    if not decision.allowed:
        await websocket.close(code=4403, reason=decision.reason[:120])
        return

    def open_document() -> tuple[ProjectWorkspace, DocumentSyncService, dict[str, Any]]:
        ws_proj = ProjectWorkspace.open(project_path)
        svc = DocumentSyncService(ws_proj)
        return ws_proj, svc, svc.document_snapshot(projection="shell")

    ws_proj, svc, initial_snapshot = await run_in_threadpool(open_document)
    await websocket.accept()
    hub = get_hub()
    key = document_hub_key(ws_proj.project)
    loop = asyncio.get_running_loop()
    queue = hub.subscribe(key, loop)
    await websocket.send_json(
        {
            "type": "Snapshot",
            "plane": "document",
            "snapshot": initial_snapshot,
        }
    )

    async def _pump_hub() -> None:
        while True:
            event = await queue.get()
            await websocket.send_json(event)

    hub_task = asyncio.create_task(_pump_hub())
    seq = 1
    try:
        while True:
            try:
                raw_msg = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            msg = await run_in_threadpool(json.loads, raw_msg)
            if msg.get("type") != "Command":
                continue
            again = authorize_client(
                client_id=client_id,
                role=role,
                peer_host=peer,
                token=token,
                display_name=label,
            )
            if not again.allowed:
                await websocket.send_json({"type": "Error", "detail": again.reason or "forbidden"})
                await websocket.close(code=4403, reason=(again.reason or "forbidden")[:120])
                break
            seq += 1
            try:
                result = await run_in_threadpool(
                    _submit_ws_command, svc, msg, client_id=client_id, role=role, seq=seq
                )
                await websocket.send_json({**result, "type": "Echo"})
            except ValidationError as exc:
                await websocket.send_json({"type": "Error", "detail": str(exc)})
            except (KeyError, ValueError, PermissionError) as exc:
                await websocket.send_json({"type": "Error", "detail": str(exc)})
    finally:
        hub.unsubscribe(key, queue)
        hub_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await hub_task
