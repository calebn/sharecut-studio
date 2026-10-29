from __future__ import annotations

import shutil
import threading
from dataclasses import asdict
from pathlib import Path

from fastapi import APIRouter, Header, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from podcast_mcp.gui.assembler import (
    VIEW_PROJECTION_QUERY_DESCRIPTION,
    dump_project_projection,
    parse_view_projection,
)
from podcast_mcp.gui.audio import (
    audio_file_response,
    resolve_viewer_transport,
)
from podcast_mcp.gui.host_file_dialog import pick_episode_project_path
from podcast_mcp.gui.poll_meta import project_meta
from podcast_mcp.gui.routes.deps import (
    bad_request_error,
    coded_exception_error,
    coded_http_error,
    peer_host,
    require_host,
    resolve_project,
)
from podcast_mcp.gui.routes.handoff import set_served_project
from podcast_mcp.project.io import (
    ensure_utf8_path,
    require_episode_project_file,
    resolve_project_path,
)
from podcast_mcp.project.merge import ProjectMergeConflict
from podcast_mcp.services.app import (
    ProjectWorkspace,
    default_workspace_dir,
    forget_recent,
    recent_project_cards,
    record_recent,
)
from podcast_mcp.services.document import HistoryService, PlayService
from podcast_mcp.services.session_sync import is_loopback_host

router = APIRouter()

_PICK_LOCK = threading.Lock()


class CreateProjectBody(BaseModel):
    # Blank: the server picks <workspace root>/<name>, numbered when taken (Home's tiles).
    workspace_dir: str = ""
    name: str = "episode"


class OpenProjectBody(BaseModel):
    path: str


def _peer_may_switch_project(request: Request) -> bool:
    """Loopback peers may create/open and retarget served_project."""
    host = peer_host(request)
    return host is None or is_loopback_host(host)


def pin_served_if_allowed(request: Request, project_path: Path) -> None:
    if not _peer_may_switch_project(request):
        return
    served = project_path.resolve()
    if request.app.state.served_project != served:
        set_served_project(request.app, served)
        record_recent(served)


def _unpin_served_if_allowed(request: Request) -> None:
    if not _peer_may_switch_project(request):
        return
    set_served_project(request.app, None)


def _require_episode_path(path_raw: str) -> Path:
    try:
        resolved = require_episode_project_file(path_raw)
        ensure_utf8_path(resolved)
        return resolved
    except ValueError as exc:
        raise coded_exception_error(400, exc, code="project_path_invalid") from exc
    except FileNotFoundError as exc:
        raise coded_exception_error(404, exc, code="project_file_missing") from exc


def _open_validated(path_raw: str) -> ProjectWorkspace:
    """Resolve workspace/file path, require episode.project.json, load project."""
    path = _require_episode_path(path_raw)
    try:
        return ProjectWorkspace.open(path)
    except Exception as exc:
        raise coded_exception_error(400, exc, code="project_open_failed") from exc


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
        raise coded_http_error(
            403, "project create not allowed from this client", code="project_create_not_allowed"
        )
    name = body.name.strip() or "episode"
    reserved: Path | None = None
    requested = body.workspace_dir.strip()
    if requested:
        try:
            ensure_utf8_path(Path(requested).expanduser().resolve())
        except ValueError as exc:
            raise coded_exception_error(400, exc, code="project_path_invalid") from exc
    try:
        if requested:
            workspace_dir = requested
        else:
            reserved = default_workspace_dir(name)
            workspace_dir = str(reserved)
            if resolve_project_path(reserved).exists():
                reserved = None
                raise FileExistsError(f"{workspace_dir} already holds an episode")
        ws = ProjectWorkspace.create(workspace_dir, name=name)
    except Exception as exc:
        if reserved is not None:
            shutil.rmtree(reserved, ignore_errors=True)
        raise coded_exception_error(400, exc, code="project_create_failed") from exc
    pin_served_if_allowed(request, ws.path)
    record_recent(ws.path)
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
        raise coded_http_error(
            403, "project pick not allowed from this client", code="project_pick_not_allowed"
        )
    if not _PICK_LOCK.acquire(blocking=False):
        raise coded_http_error(409, "A file dialog is already open", code="file_dialog_open")
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
            raise coded_http_error(
                400,
                result.detail or "No project path selected",
                code="project_path_required",
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
        raise coded_http_error(
            403,
            "project open/switch not allowed from this client",
            code="project_open_not_allowed",
        )
    ws = _open_validated(body.path)
    pin_served_if_allowed(request, ws.path)
    record_recent(ws.path)
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
        raise coded_http_error(
            403, "project close not allowed from this client", code="project_close_not_allowed"
        )
    _unpin_served_if_allowed(request)
    return {"ok": True}


def _require_recent_access(request: Request) -> None:
    if not _peer_may_switch_project(request):
        raise coded_http_error(
            403,
            "recent projects not available from this client",
            code="project_recent_not_allowed",
        )


@router.get("/api/projects/recent")
def list_recent_projects(
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> JSONResponse:
    """The last opened episodes on this machine as Home cards (host / loopback only)."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    _require_recent_access(request)
    cards = recent_project_cards(getattr(request.app.state, "jobs", None))
    return JSONResponse({"projects": cards}, headers={"Cache-Control": "no-store"})


@router.delete("/api/projects/recent")
def forget_recent_project(
    request: Request,
    path: str = Query(..., description="Path of the entry to drop from the list"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, bool]:
    """Remove one entry from the recent list; the project itself is never touched."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    _require_recent_access(request)
    return {"removed": forget_recent(path)}


@router.get("/api/health")
def health(request: Request) -> dict[str, bool]:
    from podcast_mcp.gui.bind import BOOT_TOKEN_HEADER, boot_token_accepted

    if not boot_token_accepted(request.headers.get(BOOT_TOKEN_HEADER)):
        raise coded_http_error(401, "invalid boot token", code="invalid_boot_token")
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
    pin_served_if_allowed(request, project_path)
    try:
        projection = parse_view_projection(phase)
    except ValueError as exc:
        raise bad_request_error(exc) from exc
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


@router.get("/api/pending-edits/{edit_id}/cut-suggestion")
def get_pending_cut_suggestion(
    request: Request,
    edit_id: str,
    path: str = Query(..., description="Path to episode.project.json"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> JSONResponse:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    from podcast_mcp.services.document import EditService

    try:
        suggestion = EditService(ProjectWorkspace.open(project_path)).preview_pending_cut(edit_id)
    except KeyError as exc:
        raise coded_http_error(
            404, "pending edit not found", code="pending_edit_not_found"
        ) from exc
    except ValueError as exc:
        raise bad_request_error(exc) from exc
    return JSONResponse(asdict(suggestion), headers={"Cache-Control": "no-store"})


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
    from podcast_mcp.services.document import AnalysisService

    try:
        return AnalysisService(ws).waveform_snap_window(
            track_id=track_id,
            start=start,
            end=end,
            timeline=timeline,
            focus=focus,
        )
    except (KeyError, ValueError) as exc:
        raise coded_exception_error(400, exc, code="waveform_snap_invalid") from exc


@router.get("/api/project/prosody")
def get_project_prosody(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
):
    """Cached prosody profile per dialogue track, timeline-mapped, for the DAW overlay (#719)."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    return PlayService(ProjectWorkspace.open(project_path)).prosody_overlay()


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
    source_id: str | None = Query(None),
    review_version_id: str | None = Query(
        None,
        description="Frozen review mix id (alias for kind=review + track_id)",
    ),
    rerender: bool = Query(
        False,
        description="Rebuild premix/stem before serving (same as podcast play --rerender)",
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
    try:
        transport = resolve_viewer_transport(
            ws,
            kind=transport_kind,
            track_id=transport_track,
            source_id=source_id,
            rerender=rerender,
        )
    except ValueError as exc:
        raise bad_request_error(exc) from exc
    except KeyError as exc:
        raise coded_exception_error(404, exc, code="audio_source_unknown") from exc
    except FileNotFoundError as exc:
        raise coded_exception_error(404, exc, code="audio_file_missing") from exc
    except ProjectMergeConflict as exc:
        # The premix re-render's save collided with a concurrent edit; nothing was saved.
        raise coded_exception_error(409, exc, code="project_merge_conflict") from exc
    response = audio_file_response(transport.path, request=request)
    if transport.render_busy:
        # Refresh lost the render-lock race; this is the file already on disk.
        response.headers["X-Sharecut-Render-Busy"] = "1"
    return response


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
        result = HistoryService(ws).diff(from_index=from_index, to_index=to_index)
        return result.model_dump()
    except ValueError as exc:
        raise bad_request_error(exc) from exc
