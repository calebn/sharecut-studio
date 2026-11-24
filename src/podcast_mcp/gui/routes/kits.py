"""Host show-kit HTTP routes: adapters over the kit services."""

from __future__ import annotations

from typing import Any, NoReturn

from fastapi import APIRouter, Request

from podcast_mcp.gui.routes.deps import coded_exception_error, resolve_project
from podcast_mcp.gui.routes.project import pin_served_if_allowed
from podcast_mcp.segments.kit import KitStore
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.services.document import report_kit_offer
from podcast_mcp.util.coded_error import CodedValueError

router = APIRouter()


def _refuse(exc: CodedValueError) -> NoReturn:
    raise coded_exception_error(400, exc, code="kit_invalid") from exc


@router.get("/api/kits/offer")
def kit_offer_route(path: str, request: Request) -> dict[str, Any]:
    project_path = resolve_project(path, request)
    pin_served_if_allowed(request, project_path)
    try:
        return report_kit_offer(project_path, KitStore(), SegmentStore())
    except CodedValueError as exc:
        _refuse(exc)
