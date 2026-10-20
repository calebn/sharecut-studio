"""The refusal for a review artifacts folder or staging folder that is not private to the host.

``services/collaboration/review_versions.py`` raises it at the boundary, where the offending path is known.
Every adapter already reports a ``CodedError``'s message and code (``util/coded_error.py``):
the CLI prints one ``Error:`` line, an MCP tool returns a structured refusal, and the GUI maps
it app-wide in ``gui/routes/deps.py``. A share guest never gets that message: the error holds
fixed guest copy selected by code, read through ``util/tool_refusal.py``.

The refusal is fail-closed: it names what is wrong and how to fix it, and never repairs
anything. A fix is a command only when running it on a folder the host owns cannot widen access.
"""

from __future__ import annotations

import shlex
import stat
from enum import StrEnum
from pathlib import Path

from podcast_mcp.util.coded_error import HostSetupError

REVIEW_NOT_PRIVATE_CODE = "review_artifacts_not_private"
_MOVE = "move the project to a folder you own"


class ReviewPrivacyReason(StrEnum):
    ARTIFACTS_OWNER = "artifacts_owner"
    ARTIFACTS_WRITABLE = "artifacts_writable"
    STAGING_OWNER = "staging_owner"
    STAGING_MODE = "staging_mode"


_PROBLEM = {
    ReviewPrivacyReason.ARTIFACTS_OWNER: "review artifacts folder {path} is owned by another user",
    ReviewPrivacyReason.ARTIFACTS_WRITABLE: (
        "review artifacts folder {path} must not be writable by group or others but is mode {mode}"
    ),
    ReviewPrivacyReason.STAGING_OWNER: "review staging folder {path} is owned by another user",
    ReviewPrivacyReason.STAGING_MODE: (
        "review staging folder {path} must be private (0700) but is mode {mode}"
    ),
}

_FIX = {
    ReviewPrivacyReason.ARTIFACTS_OWNER: "restore your ownership of it, or " + _MOVE,
    ReviewPrivacyReason.ARTIFACTS_WRITABLE: "run: chmod go-w {path}",
    ReviewPrivacyReason.STAGING_OWNER: "remove it and publish again, or " + _MOVE,
    ReviewPrivacyReason.STAGING_MODE: "run: chmod 0700 {path}",
}


class ReviewPrivacyError(HostSetupError):
    """A review artifacts or staging folder is not private to the host user."""

    code = REVIEW_NOT_PRIVATE_CODE

    def __init__(self, path: Path, reason: ReviewPrivacyReason, *, mode: int) -> None:
        fields = {"path": shlex.quote(str(path)), "mode": f"{stat.S_IMODE(mode):04o}"}
        self.path = path
        self.reason = reason
        self.fix = _FIX[reason].format(**fields)
        super().__init__(f"{_PROBLEM[reason].format(**fields)}; {self.fix}")
