"""Host show-kit HTTP routes: adapters over the kit services."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import NoReturn

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from podcast_mcp.gui.routes.deps import (
    coded_exception_error,
    coded_http_error,
    document_conflict_error,
    host_gate,
    resolve_project,
)
from podcast_mcp.gui.routes.project import pin_served_if_allowed
from podcast_mcp.segments.kit import KitStore
from podcast_mcp.segments.kit_offer import KitOffer
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.services.document import report_kit_offer, submit_kit_apply
from podcast_mcp.services.document_sync import DocumentConflictError
from podcast_mcp.util.coded_error import CodedError, CodedValueError

router = APIRouter()
_HOST_GATE = [Depends(host_gate)]
_APPLY_LOCKS: dict[Path, threading.Lock] = {}
_APPLY_STATUS = {
    "kit_unknown": 404,
    "kit_not_offered": 409,
    "kit_changed": 409,
    "kit_apply_failed": 500,
    "project_write_failed": 500,
}


class KitApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str
    kit_id: str
    kit_version: int = Field(ge=1)
    client_id: str = Field(min_length=1)


def _refuse(exc: CodedValueError) -> NoReturn:
    raise coded_exception_error(400, exc, code="kit_invalid") from exc


@router.get("/api/kits/offer")
def kit_offer_route(path: str, request: Request) -> KitOffer:
    project_path = resolve_project(path, request)
    pin_served_if_allowed(request, project_path)
    try:
        return report_kit_offer(project_path, KitStore(), SegmentStore())
    except CodedValueError as exc:
        _refuse(exc)


@router.post("/api/kits/apply", dependencies=_HOST_GATE)
def kit_apply_route(body: KitApplyRequest, request: Request) -> dict[str, object]:
    project_path = resolve_project(body.path, request)
    lock = _APPLY_LOCKS.setdefault(Path(project_path), threading.Lock())
    try:
        with lock:
            offer = report_kit_offer(project_path, KitStore(), SegmentStore())
            offered = next((kit for kit in offer["kits"] if kit["id"] == body.kit_id), None)
            if offer["reason"] != "offer" or offered is None:
                raise CodedValueError(
                    "This episode is no longer offered that kit. Reload to see what is available.",
                    code="kit_not_offered",
                )
            if offered["version"] != body.kit_version:
                raise CodedValueError(
                    "The show kit changed since it was offered. Reload to see the latest.",
                    code="kit_changed",
                )
            report = submit_kit_apply(project_path, body.kit_id, client_id=body.client_id)
        return dict(report.wire())
    except DocumentConflictError as exc:
        raise document_conflict_error(exc) from exc
    except CodedError as exc:
        raise coded_http_error(_APPLY_STATUS.get(exc.code, 400), str(exc), code=exc.code) from exc
