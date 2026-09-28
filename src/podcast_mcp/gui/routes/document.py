"""Document-plane HTTP/WS - comment live updates (separate from transport session)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import sqlite3
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request, WebSocket
from filelock import Timeout
from starlette.concurrency import run_in_threadpool

from podcast_mcp.edits.transcript_refine_status import TranscriptRefineRequiredError
from podcast_mcp.gui.middleware_host_binding import websocket_host_binding_denied
from podcast_mcp.gui.routes.deps import (
    peer_host,
    project_busy_error,
    require_authz,
    resolve_project,
)
from podcast_mcp.gui.routes.guest_ws_common import GuestWsGuard, WsTaskSet
from podcast_mcp.gui.schemas import DocumentCommandRequest
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.cross_process_sync import CrossProcessLease, watch_cross_process_writes
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.document_sync.payloads import document_command_from_body
from podcast_mcp.services.document_sync.service import document_hub_key
from podcast_mcp.services.session_sync.authz import AuthzDecision, authorize_client
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.util.proxy_paths import is_relayed_request
from podcast_mcp.util.sqlite_tx import is_sqlite_busy

router = APIRouter()
_PROJECT_BUSY = "Project is busy in another process; try again"
log = logging.getLogger(__name__)
# The socket has no inbound frames to hook, so authorize_client re-runs on a timer.
# Owner session-authz interval, deliberately independent of guest_ws_common's
# GUEST_SHARE_RECHECK_S (guest share validity) even though both are 30 s today.
DOCUMENT_WS_AUTHZ_RECHECK_S = 30.0


def _is_project_busy(exc: BaseException) -> bool:
    """The project file lock timed out, or the document.db write lock stayed busy."""
    return isinstance(exc, Timeout) or is_sqlite_busy(exc)


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
        relayed=is_relayed_request(request.headers),
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
        relayed=is_relayed_request(request.headers),
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
    except (Timeout, sqlite3.OperationalError) as exc:
        if not _is_project_busy(exc):
            raise
        raise project_busy_error(_PROJECT_BUSY) from exc
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
    """Server→client document fan-out: hello shell ``Snapshot``, then hub ``Applied``.

    Applied from this process's writers, and from other processes' journal writes via
    the cross-process watcher (#695).

    Commands use ``POST /api/document/command``; inbound frames are ignored (#565).
    ``authorize_client`` runs on connect and every ``DOCUMENT_WS_AUTHZ_RECHECK_S``;
    a revoked grant closes ``4403`` and a failed hub pump closes ``1011`` (client
    reconnects and resyncs).
    """
    denied = websocket_host_binding_denied(websocket)
    if denied is not None:
        await websocket.close(code=4403, reason=denied[:120])
        return
    project_path = resolve_project(path, websocket)  # type: ignore[arg-type]
    peer = websocket.client.host if websocket.client else None
    relayed = is_relayed_request(websocket.headers)

    def _authorize() -> AuthzDecision:
        return authorize_client(
            client_id=client_id,
            role=role,
            peer_host=peer,
            token=token,
            display_name=label,
            relayed=relayed,
        )

    decision = _authorize()
    if not decision.allowed:
        await websocket.close(code=4403, reason=decision.reason[:120])
        return

    def open_document() -> tuple[ProjectWorkspace, DocumentSyncService]:
        ws_proj = ProjectWorkspace.open(project_path)
        svc = DocumentSyncService(ws_proj)
        return ws_proj, svc

    ws_proj, svc = await run_in_threadpool(open_document)
    await websocket.accept()
    guard = GuestWsGuard(
        websocket,
        lambda: _authorize().allowed,
        interval=DOCUMENT_WS_AUTHZ_RECHECK_S,
        revoked_reason="authorization revoked",
    )
    hub = get_hub()
    key = document_hub_key(ws_proj.project)
    loop = asyncio.get_running_loop()
    queue = hub.subscribe(key, loop)
    tasks = WsTaskSet(f"document ws client_id={client_id}")
    bridge_lease: CrossProcessLease | None = None
    try:
        # After subscribe, before the hello snapshot (#695): a foreign write in between
        # is in the snapshot or published by the watcher.
        bridge_lease = await run_in_threadpool(watch_cross_process_writes, ws_proj)
        initial_snapshot = await run_in_threadpool(svc.document_snapshot, projection="shell")
        await guard.send_json(
            {
                "type": "Snapshot",
                "plane": "document",
                "snapshot": initial_snapshot,
            }
        )

        async def _pump_hub() -> None:
            try:
                while True:
                    event = await queue.get()
                    await guard.send_json(event)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("document pump failed client_id=%s", client_id)
                with contextlib.suppress(Exception):
                    await guard.close(1011, "document pump failed")
                raise

        tasks.spawn(_pump_hub())
        tasks.spawn(guard.recheck_loop())
        # Server→client only (#565): every send (hello Snapshot, _pump_hub, the authz
        # recheck's 4403 close) goes through guard's write lock. Inbound frames are drained
        # only to notice the disconnect; commands go through POST /api/document/command.
        # Raw receive(), not receive_text(): a binary frame must not raise KeyError.
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
    finally:
        hub.unsubscribe(key, queue)
        if bridge_lease is not None:
            bridge_lease.release()
        await tasks.stop()
