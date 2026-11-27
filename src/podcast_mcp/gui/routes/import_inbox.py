"""Host routes for a bundle the iOS app received from the share sheet: fetch the one file, then drop it."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from podcast_mcp import settings
from podcast_mcp.gui.routes.deps import NO_STORE, coded_http_error

router = APIRouter()

INBOX_ENV = "PODCAST_IOS_INBOX_DIR"
_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
_GONE = "That file can't be found. Open it from the share sheet again."


def _gone() -> HTTPException:
    return coded_http_error(404, _GONE, code="import_inbox_unknown", headers=NO_STORE)


def _entry(inbox_id: str) -> Path:
    root = settings.text(INBOX_ENV)
    if not root or not _ID.fullmatch(inbox_id):
        raise _gone()
    entry = Path(root) / inbox_id
    if entry.is_symlink() or not entry.is_dir():
        raise _gone()
    return entry


def _only_file(entry: Path) -> Path:
    members = list(entry.iterdir())
    if len(members) != 1 or members[0].is_symlink() or not members[0].is_file():
        raise _gone()
    return members[0]


@router.get("/api/import/inbox/{inbox_id}")
def inbox_file(inbox_id: str) -> FileResponse:
    """The file the share sheet handed to the app, streamed under its own name."""
    try:
        path = _only_file(_entry(inbox_id))
    except OSError as exc:
        raise _gone() from exc
    return FileResponse(
        path, media_type="application/octet-stream", filename=path.name, headers=NO_STORE
    )


@router.delete("/api/import/inbox/{inbox_id}")
async def drop_inbox_file(inbox_id: str) -> dict[str, str]:
    """Remove the received copy once the page holds it; a second call finds nothing."""
    entry = _entry(inbox_id)
    try:
        await run_in_threadpool(shutil.rmtree, entry)
    except FileNotFoundError as exc:
        raise _gone() from exc
    return {"dropped": inbox_id}
