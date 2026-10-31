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
_MAX_EXPIRES_DIGITS = 12

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


def verified_version(ticket: str, path: str, file_id: str) -> str:
    """The file version *ticket* was minted for, once its signature and expiry hold.

    *path* is the project path as the request names it. A forged, malformed or misdirected
    ticket is a 403; a genuine one that has expired is a 410. Nothing about the project is
    read before this passes.
    """
    expires_text, _, rest = ticket.partition(".")
    version, _, signature = rest.rpartition(".")
    if not (
        expires_text.isascii()
        and expires_text.isdigit()
        and len(expires_text) <= _MAX_EXPIRES_DIGITS
        and version
        and signature.isascii()
    ):
        raise _refused(403, "export_ticket_invalid")
    try:
        project = Path(path).expanduser().resolve()
    except (OSError, ValueError) as exc:
        raise _refused(403, "export_ticket_invalid") from exc
    expires = int(expires_text)
    if not hmac.compare_digest(signature, _sign(project, file_id, version, expires)):
        raise _refused(403, "export_ticket_invalid")
    if _now() > expires:
        raise _refused(410, "export_ticket_expired")
    return version


def require_unchanged(ticket_version: str, current_version: str) -> None:
    """Raise a 410 when the file was rewritten after the listing that issued the ticket."""
    if ticket_version != current_version:
        raise _refused(410, "export_file_changed")
