"""Podcast listing HTTP adapters over ``FeedService``."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Query, Request

from podcast_mcp.gui.routes.deps import coded_exception_error, require_host, resolve_project
from podcast_mcp.gui.routes.project import pin_served_if_allowed
from podcast_mcp.gui.schemas import FeedEditRequest
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import FeedService
from podcast_mcp.util.coded_error import CodedValueError

router = APIRouter()


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
