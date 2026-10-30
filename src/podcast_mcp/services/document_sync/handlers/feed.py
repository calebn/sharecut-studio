"""Document-plane podcast listing handlers: pins are undoable like any episode edit."""

from __future__ import annotations

from typing import Any

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import FeedService


def set_feed_field(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return FeedService(ws).set_field(str(p["key"]), p["value"], p.get("by", "person"))


def clear_feed_field(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return FeedService(ws).clear_field(str(p["key"]))


HANDLERS = {"SetFeedField": set_feed_field, "ClearFeedField": clear_feed_field}
