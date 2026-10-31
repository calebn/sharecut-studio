"""Short-lived signed tickets for downloading one exported file without the host session token."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from pathlib import Path

from fastapi import HTTPException

from podcast_mcp.gui.routes.deps import coded_http_error
from podcast_mcp.util.coded_error import guest_message_for_code

TICKET_TTL_SEC = 30 * 60

_KEY = secrets.token_bytes(32)


def _now() -> float:
    return time.time()


def _sign(project: Path, file_id: str, version: str, expires: int) -> str:
    message = "\0".join((str(project), file_id, version, str(expires))).encode()
    return hmac.new(_KEY, message, hashlib.sha256).hexdigest()


def mint(project: Path, file_id: str, version: str) -> str:
    """``expires.version.signature`` for *file_id* at *version* in *project*."""
    expires = int(_now()) + TICKET_TTL_SEC
    return f"{expires}.{version}.{_sign(project, file_id, version, expires)}"


def _refused(status: int, code: str) -> HTTPException:
    return coded_http_error(status, guest_message_for_code(code), code=code)


def check(ticket: str, project: Path, file_id: str, current_version: str) -> None:
    """Raise unless *ticket* was minted for *file_id* of *project* and still fits the file.

    A forged or misdirected ticket is a 403. A genuine one is a 410 once it has expired or the
    file was rewritten after the listing that issued it.
    """
    expires_text, _, rest = ticket.partition(".")
    version, _, signature = rest.rpartition(".")
    if not (expires_text.isdecimal() and version and signature):
        raise _refused(403, "export_ticket_invalid")
    expires = int(expires_text)
    expected = _sign(project, file_id, version, expires)
    if not hmac.compare_digest(signature, expected):
        raise _refused(403, "export_ticket_invalid")
    if _now() > expires:
        raise _refused(410, "export_ticket_expired")
    if version != current_version:
        raise _refused(410, "export_file_changed")
