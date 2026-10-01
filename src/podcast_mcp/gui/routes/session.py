from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from podcast_mcp.gui.jobs import session_file_meta
from podcast_mcp.gui.routes.deps import peer_host, require_authz, resolve_project
from podcast_mcp.gui.schemas import SessionCommandRequest, ViewerSessionSnapshot
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.remote_mcp import ws_roster_request_allowed
from podcast_mcp.services.session_sync import (
    ROSTER_REQUEST,
    ClientSequenceConflictError,
    SessionSyncService,
    SyncCommand,
    publish_viewer_snapshot,
    read_session_state,
    retry_command_id,
    wire_snapshot,
)
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


def _publish_viewer_blob(
    project: EpisodeProject, body: ViewerSessionSnapshot, *, heartbeat: bool = True
) -> dict[str, Any]:
    """Shared by ``POST /api/session/state`` and the WS ``ViewerState`` frame."""
    return publish_viewer_snapshot(project, body.model_dump(exclude_none=True), heartbeat=heartbeat)


def _viewer_state_error(code: str, exc: Exception) -> dict[str, Any]:
    return {"type": "Error", "code": code, "detail": str(exc)[:500]}


def apply_ws_viewer_state(
    svc: SessionSyncService,
    raw: Any,
    *,
    client_id: str,
    role: str,
    label: str | None,
) -> dict[str, Any]:
    """WS twin of ``POST /api/session/state``: viewer blob -> typed commands.

    Blocking (several sqlite writes): ``host_ws`` runs it in a worker thread.
    Only the host socket dispatches it; ``apply_ws_client_message`` (shared with
    the guest share socket) does not, so a guest frame cannot reach it.
    The socket's own ``client_id`` and ``label`` replace any value in the blob,
    so a socket cannot publish as another client or under another name. No
    ``PresenceHeartbeat``: the socket carries its own ``Presence`` frames.
    A bad blob or a service error answers with an ``Error`` frame and the
    socket stays open.
    """
    try:
        body = ViewerSessionSnapshot.model_validate(raw)
    except ValidationError as exc:
        return _viewer_state_error("invalid_viewer_state", exc)
    body = body.model_copy(update={"client_id": client_id, "label": label})
    try:
        snapshot = _publish_viewer_blob(svc.project, body, heartbeat=False)
    except ValueError as exc:
        return _viewer_state_error("invalid_viewer_state", exc)
    except sqlite3.Error as exc:
        return _viewer_state_error("viewer_state_failed", exc)
    return {
        "type": "Echo",
        "command": {"type": "ViewerState", "client_id": client_id, "role": role},
        "snapshot": snapshot,
    }


def apply_ws_client_message(
    svc: SessionSyncService,
    msg: dict[str, Any],
    *,
    client_id: str,
    role: str,
    label: str | None,
    seq: int,
) -> tuple[dict[str, Any] | None, int]:
    """Handle one inbound WS client message. Returns (echo_or_none, next_seq).

    Shared with the guest share socket. ``ViewerState`` is host-only and handled
    by ``host_ws`` via ``apply_ws_viewer_state``; here it is ignored like any
    unknown type.
    """
    mtype = msg.get("type")
    if mtype == "Record":
        return None, seq
    if mtype == ROSTER_REQUEST:
        # Throttled per client id (one reply/s by default; the guest socket keys by its
        # assigned guest client id the same way): a throttled request gets no reply and
        # the client's 2 s RosterRequest retry asks again.
        if not ws_roster_request_allowed(f"host:{client_id}"):
            return None, seq
        # Sent directly, not via the hub queue: order vs hub frames is not guaranteed;
        # clients drop a full Presence older than their roster version (presenceFrames.ts).
        return svc.roster_event(), seq
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
        echo = {**result, "type": "Echo"}
        snapshot = echo.get("snapshot")
        if isinstance(snapshot, dict):
            echo["snapshot"] = wire_snapshot(snapshot)
        return echo, seq
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
    return _publish_viewer_blob(ws.project, body)
