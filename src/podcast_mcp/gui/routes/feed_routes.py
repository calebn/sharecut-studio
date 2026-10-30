"""Podcast listing HTTP adapters over ``FeedService``."""

from __future__ import annotations

import logging
import re
from pathlib import PureWindowsPath
from typing import Any

from fastapi import APIRouter, Header, Query, Request

from podcast_mcp.feed.urls import is_local_art
from podcast_mcp.gui.routes.deps import coded_exception_error, require_host, resolve_project
from podcast_mcp.gui.routes.project import pin_served_if_allowed
from podcast_mcp.gui.schemas import FeedEditRequest, FeedWriteRequest
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import FeedService
from podcast_mcp.util.coded_error import CodedValueError

router = APIRouter()
log = logging.getLogger(__name__)


def served(service: FeedService, *, guest: bool = False) -> dict[str, Any]:
    """The wire view and the item as the feed file will carry it, for the XML pane.

    A guest never learns the titles of shows its episode is not linked to, nor where on the
    host's machine a file lives.
    """
    view = service.present("facts")
    assert isinstance(view, dict)
    if guest and view["show"]["kind"] == "choose":
        view["show"]["shows"] = []
    if guest:
        _name_local_files_only(view)
    return {"view": view, "itemXml": service.present("item_xml")}


def _is_host_path(value: object) -> bool:
    return isinstance(value, str) and is_local_art(value) and bool(re.search(r"[/\\]|^~", value))


def _name_local_files_only(view: dict[str, Any]) -> None:
    """Replace a path on the host's machine with its file name in the art rows of a guest's view."""
    image = view.get("channel", {}).get("channel.image")
    if image is not None and _is_host_path(image.get("value")):
        image["value"] = PureWindowsPath(image["value"]).name
    art = view.get("sections", {}).get("art", {}).get("value")
    if art is not None and _is_host_path(art.get("src")):
        art["src"] = PureWindowsPath(art["src"]).name


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
        service.apply(body.edit, body.by)
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
        status = 500 if exc.code == "feed_write_failed" else 400
        raise coded_exception_error(status, exc, code="feed_write_refused") from exc
    return served(FeedService(ProjectWorkspace.open(project_path)))
