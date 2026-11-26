"""Host show-kit HTTP routes: adapters over the kit services."""

from __future__ import annotations

import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any, NoReturn

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from podcast_mcp.gui.routes.bundle_files import export_response, export_stem
from podcast_mcp.gui.routes.deps import (
    coded_exception_error,
    coded_http_error,
    document_conflict_error,
    host_gate,
    resolve_project,
)
from podcast_mcp.gui.routes.project import pin_served_if_allowed
from podcast_mcp.gui.schemas import KitSaveRequest
from podcast_mcp.segments.kit import KitStore
from podcast_mcp.segments.kit_bundle import export_kit
from podcast_mcp.segments.kit_offer import KitOffer
from podcast_mcp.segments.kit_summary import kit_rows, make_entry, save_kit
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
KIT_STATUS = {
    "kit_unknown": 404,
    "kit_import_unknown": 404,
    "kit_busy": 409,
    "kit_import_committing": 409,
    "kit_segment_missing": 409,
    "kit_upload_too_large": 413,
    "kit_bundle_invalid": 422,
    "kit_hash_mismatch": 422,
    "kit_schema_unsupported": 422,
    "kit_invalid": 422,
    "kit_bundle_too_large": 422,
    "kit_staging_full": 429,
    "kit_no_room": 507,
    "kit_write_failed": 500,
}

# Saving adds the refusals only a save can raise; the rest are the library's own.
_SAVE_STATUS = {
    **KIT_STATUS,
    "kit_name_invalid": 422,
    "segment_version_invalid": 422,
}

_EXPORT_STATUS = {
    **KIT_STATUS,
    "segment_hash_mismatch": 409,
    "segment_unreadable": 409,
    "segment_invalid": 409,
}


class KitApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str
    kit_id: str
    kit_version: int = Field(ge=1)
    client_id: str = Field(min_length=1)


def _refuse(exc: CodedValueError) -> NoReturn:
    raise coded_exception_error(400, exc, code="kit_invalid") from exc


def refuse_kit(exc: CodedValueError, statuses: Mapping[str, int] = KIT_STATUS) -> NoReturn:
    raise coded_exception_error(statuses.get(exc.code, 400), exc, code="kit_invalid") from exc


@router.get("/api/kits", dependencies=_HOST_GATE)
def list_kits_route() -> list[dict[str, Any]]:
    return kit_rows(KitStore(), SegmentStore())


@router.post("/api/kits", dependencies=_HOST_GATE)
def save_kit_route(body: KitSaveRequest) -> dict[str, str | int]:
    """Save a kit from the sheet: ``added``, ``new_version`` or ``unchanged`` (all 200).

    Entries go through ``make_entry``, so a bad one is refused with the same code as the CLI
    and MCP. A plain ``def``: the store lock can wait, and FastAPI runs it off the event loop.
    """
    try:
        entries = [
            make_entry(entry.segment_id, entry.version, entry.at, entry.note)
            for entry in body.entries
        ]
        return save_kit(KitStore(), SegmentStore(), body.name, entries).wire()
    except CodedValueError as exc:
        refuse_kit(exc, _SAVE_STATUS)


@router.get("/api/kits/{kit_id}/export", dependencies=_HOST_GATE)
def export_kit_route(kit_id: str) -> FileResponse:
    """The newest version as one ``<name>.sharecutkit`` file, built in a private folder removed afterwards."""
    try:
        return export_response(
            f"{export_stem(kit_id, 'kit')}.sharecutkit",
            lambda out: export_kit(KitStore(), SegmentStore(), kit_id, out),
        )
    except CodedValueError as exc:
        refuse_kit(exc, _EXPORT_STATUS)


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
