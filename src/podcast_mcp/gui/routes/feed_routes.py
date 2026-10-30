"""Podcast listing HTTP adapters over ``FeedService``."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Header, Query, Request

from podcast_mcp.feed.model import FeedEdit, SetEdit
from podcast_mcp.feed.urls import is_local_art
from podcast_mcp.gui.routes.deps import coded_exception_error, require_host, resolve_project
from podcast_mcp.gui.routes.guest_errors import guest_boundary
from podcast_mcp.gui.routes.project import pin_served_if_allowed
from podcast_mcp.gui.routes.share_common import check_share_token, rate_limit_share
from podcast_mcp.gui.schemas import FeedEditRequest, FeedGuestEditRequest, FeedWriteRequest
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import require_share_edit
from podcast_mcp.services.document import FeedService
from podcast_mcp.util.coded_error import CodedPermissionError, CodedValueError

router = APIRouter()
log = logging.getLogger(__name__)


def served(service: FeedService) -> dict[str, Any]:
    """The wire view and the item as the feed file will carry it, for the XML pane."""
    return {"view": service.present("facts"), "itemXml": service.present("item_xml")}


@router.get("/api/feed")
def get_feed(
    request: Request,
    path: str = Query(..., description="Path to episode.sharecut"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(path, request)
    pin_served_if_allowed(request, project_path)
    return served(FeedService(ProjectWorkspace.open(project_path)))


@router.post("/api/feed/edit")
def edit_feed(
    body: FeedEditRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Pin or unpin one listing value as the host. It undoes like any episode edit."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    pin_served_if_allowed(request, project_path)
    service = FeedService(ProjectWorkspace.open(project_path))
    try:
        service.apply(body.edit, "person")
    except CodedValueError as exc:
        raise coded_exception_error(400, exc, code="feed_edit_invalid") from exc
    return served(FeedService(ProjectWorkspace.open(project_path)))


@router.post("/api/feed/write")
def write_feed_file(
    body: FeedWriteRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Write the episode's feed file as the host. Refused with 400 while a blocker stands."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    pin_served_if_allowed(request, project_path)
    service = FeedService(ProjectWorkspace.open(project_path))
    try:
        service.write()
    except CodedValueError as exc:
        raise coded_exception_error(400, exc, code="feed_write_refused") from exc
    return served(FeedService(ProjectWorkspace.open(project_path)))


@router.post("/api/review/{token}/feed/write")
def write_feed_file_as_guest(token: str) -> dict[str, Any]:
    """An Editor share may write the feed file. Show settings and local files stay host-only."""
    check_share_token(token)
    rate_limit_share(token, "mutate")
    with guest_boundary(log, "review feed write"):
        _row, ws = require_share_edit(token)
        service = FeedService(ws)
        service.write()
        return served(FeedService(ProjectWorkspace.open(ws.path)))


# What an Editor share may change on the show. Choosing the show and where files are hosted
# stay with the host, and so does artwork named by a file path on the host's machine.
GUEST_HOST_ONLY_KEYS = frozenset({"show", "channel.mediaUrl"})


def require_guest_show_edit(edit: FeedEdit) -> None:
    """Raise unless an Editor share may make ``edit``: a plain channel value, never a host setting."""
    key = edit.key
    local_art = (
        key == "channel.image"
        and isinstance(edit, SetEdit)
        and isinstance(edit.value, str)
        and is_local_art(edit.value)
    )
    if not key.startswith("channel.") or key in GUEST_HOST_ONLY_KEYS or local_art:
        raise CodedPermissionError(
            "That setting is changed by the host", code="share_capability_required"
        )


@router.post("/api/review/{token}/feed/edit")
def edit_feed_show_as_guest(token: str, body: FeedGuestEditRequest) -> dict[str, Any]:
    """An Editor share may change the show's plain values. Episode values use the document route."""
    check_share_token(token)
    rate_limit_share(token, "mutate")
    with guest_boundary(log, "review feed edit"):
        _row, ws = require_share_edit(token)
        require_guest_show_edit(body.edit)
        service = FeedService(ws)
        service.apply(body.edit, "person")
        return served(FeedService(ProjectWorkspace.open(ws.path)))
