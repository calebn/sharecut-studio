from __future__ import annotations

import json
import threading
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from podcast_mcp.gui.assembler import (
    VIEW_PROJECTION_QUERY_DESCRIPTION,
    dump_project_projection,
    parse_view_projection,
)
from podcast_mcp.gui.audio import (
    audio_file_response,
    extract_viewer_waveform_window,
    resolve_viewer_audio,
)
from podcast_mcp.gui.host_file_dialog import pick_episode_project_path
from podcast_mcp.gui.jobs import project_meta
from podcast_mcp.gui.routes.deps import peer_host, require_host, resolve_project
from podcast_mcp.project_io import require_episode_project_file
from podcast_mcp.services import HistoryService, ProjectWorkspace
from podcast_mcp.services.peaks import lookup_track_peaks, peaks_unavailable_body
from podcast_mcp.services.session_sync.authz import is_loopback_host

router = APIRouter()

_PICK_LOCK = threading.Lock()


class CreateProjectBody(BaseModel):
    workspace_dir: str
    name: str = "episode"


class OpenProjectBody(BaseModel):
    path: str


def _peer_may_switch_project(request: Request) -> bool:
    """Loopback peers may create/open and retarget served_project."""
    host = peer_host(request)
    return host is None or is_loopback_host(host)


def _pin_served_if_allowed(request: Request, project_path: Path) -> None:
    if not _peer_may_switch_project(request):
        return
    served = project_path.resolve()
    request.app.state.served_project = served
    request.app.state.jobs.set_served_project(served)


def _unpin_served_if_allowed(request: Request) -> None:
    if not _peer_may_switch_project(request):
        return
    request.app.state.served_project = None
    request.app.state.jobs.set_served_project(None)


def _require_episode_path(path_raw: str) -> Path:
    try:
        return require_episode_project_file(path_raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _open_validated(path_raw: str) -> ProjectWorkspace:
    """Resolve workspace/file path, require episode.project.json, load project."""
    path = _require_episode_path(path_raw)
    try:
        return ProjectWorkspace.open(path)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/project/create")
def create_project(
    body: CreateProjectBody,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    """Create a new episode workspace (host / loopback only)."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    if not _peer_may_switch_project(request):
        raise HTTPException(status_code=403, detail="project create not allowed from this client")
    try:
        ws = ProjectWorkspace.create(body.workspace_dir, name=body.name.strip() or "episode")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _pin_served_if_allowed(request, ws.path)
    return {"project_path": str(ws.path), "name": ws.project.name}


@router.post("/api/project/pick")
def pick_project_path(
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    """Show a host OS file dialog; return a path without pinning served_project."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    if not _peer_may_switch_project(request):
        raise HTTPException(status_code=403, detail="project pick not allowed from this client")
    if not _PICK_LOCK.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A file dialog is already open")
    try:
        result = pick_episode_project_path()
        if result.unavailable:
            return {"unavailable": True, "detail": result.detail}
        if result.cancelled:
            body: dict[str, object] = {"cancelled": True}
            if result.detail:
                body["detail"] = result.detail
            return body
        if not result.path:
            raise HTTPException(
                status_code=400,
                detail=result.detail or "No project path selected",
            )
        # Basename gate only — full schema validation happens on open.
        path = _require_episode_path(result.path)
        return {"project_path": str(path)}
    finally:
        _PICK_LOCK.release()


@router.post("/api/project/open")
def open_project_path(
    body: OpenProjectBody,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    """Validate an existing project and retarget served_project on loopback."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    if not _peer_may_switch_project(request):
        raise HTTPException(
            status_code=403, detail="project open/switch not allowed from this client"
        )
    ws = _open_validated(body.path)
    _pin_served_if_allowed(request, ws.path)
    return {"project_path": str(ws.path), "name": ws.project.name}


@router.post("/api/project/close")
def close_project_path(
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    """Unpin served_project on loopback (host home / New project)."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    if not _peer_may_switch_project(request):
        raise HTTPException(status_code=403, detail="project close not allowed from this client")
    _unpin_served_if_allowed(request)
    return {"ok": True}


@router.get("/api/health")
def health(request: Request) -> dict[str, bool]:
    from podcast_mcp.gui.bind import BOOT_TOKEN_HEADER, boot_token_accepted

    if not boot_token_accepted(request.headers.get(BOOT_TOKEN_HEADER)):
        raise HTTPException(status_code=401, detail="invalid boot token")
    return {"ok": True}


@router.get("/api/project")
def get_project(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    phase: str | None = Query(
        None,
        description=VIEW_PROJECTION_QUERY_DESCRIPTION,
    ),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    _pin_served_if_allowed(request, project_path)
    try:
        projection = parse_view_projection(phase)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    ws = ProjectWorkspace.open(project_path)
    return dump_project_projection(ws, projection=projection)


@router.get("/api/project/meta")
def get_project_meta(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    return project_meta(project_path)


@router.get("/api/peaks/{track_id}")
def get_peaks(
    track_id: str,
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    ws = ProjectWorkspace.open(project_path)
    lookup = lookup_track_peaks(ws.project, track_id)
    if lookup.path is None:
        return JSONResponse(
            status_code=404,
            content=peaks_unavailable_body(track_id, generating=lookup.generating),
        )
    return json.loads(lookup.path.read_text(encoding="utf-8"))


@router.get("/api/waveform-snap")
def get_waveform_snap(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    track_id: str = Query(...),
    start: float = Query(...),
    end: float = Query(...),
    timeline: bool = Query(False),
    focus: float | None = Query(None),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    """Windowed inaudible-cut preview + silence-island ticks for the snap overlay."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    ws = ProjectWorkspace.open(project_path)
    from podcast_mcp.services.edit import EditService

    try:
        return EditService(ws).waveform_snap_window(
            track_id=track_id,
            start=start,
            end=end,
            timeline=timeline,
            focus=focus,
        )
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/audio")
def get_audio(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    kind: str = Query(
        "premix",
        description=(
            "premix | review | review:<id> | stem | processed | raw | track "
            "(via PlayService; for review, track_id may be the version id)"
        ),
    ),
    track_id: str | None = Query(None),
    review_version_id: str | None = Query(
        None,
        description="Frozen review mix id (alias for kind=review + track_id)",
    ),
    rerender: bool = Query(
        False,
        description="Rebuild premix/stem before serving (same as podcast play --rerender)",
    ),
    start_sec: float | None = Query(
        None,
        description="Optional window start for waveform PCM extract (source/stem clock)",
    ),
    end_sec: float | None = Query(
        None,
        description="Optional window end for waveform PCM extract",
    ),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    """Stream a WAV for browser transport via PlayService (supports HTTP Range)."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    ws = ProjectWorkspace.open(project_path)
    transport_kind = kind
    transport_track = track_id
    if review_version_id:
        transport_kind = f"review:{review_version_id}"
        transport_track = None
    if start_sec is not None and end_sec is not None:
        if not transport_track:
            raise HTTPException(
                status_code=400,
                detail="track_id required for windowed audio",
            )
        try:
            audio_path = extract_viewer_waveform_window(
                ws,
                kind=transport_kind,
                track_id=transport_track,
                start_sec=start_sec,
                end_sec=end_sec,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except (KeyError, FileNotFoundError) as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return audio_file_response(audio_path, request=request)
    try:
        audio_path = resolve_viewer_audio(
            ws,
            kind=transport_kind,
            track_id=transport_track,
            rerender=rerender,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return audio_file_response(audio_path, request=request)


@router.get("/api/history/diff")
def history_diff(
    request: Request,
    path: str = Query(...),
    from_index: int | None = Query(None, alias="from_index"),
    to_index: int | None = Query(None, alias="to_index"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    ws = ProjectWorkspace.open(project_path)
    try:
        return HistoryService(ws).diff(
            from_index=from_index,
            to_index=to_index,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
