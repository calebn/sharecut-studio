"""A project write that failed for a reason the user can fix, in plain words."""

from __future__ import annotations

import errno
import sqlite3

from filelock import Timeout

from podcast_mcp.util.coded_error import CodedError

PROJECT_WRITE_FAILED_CODE = "project_write_failed"

_DISK_FULL_ERRNOS = {errno.ENOSPC, errno.EDQUOT}
_NOT_WRITABLE_ERRNOS = {errno.EACCES, errno.EPERM, errno.EROFS}

_DISK_FULL_TEXT = (
    "The disk is full, so the project could not be written. Free some space, then try again."
)
_NOT_WRITABLE_TEXT = (
    "Studio could not write to the project folder. "
    "Check that it is not read-only and that Studio may use it, then try again."
)
_DISK_ERROR_TEXT = (
    "The disk reported an error, so the project could not be written. "
    "Check the drive, then try again."
)


class ProjectWriteFailedError(CodedError):
    """The project could not be written; ``status`` is the HTTP status that fits the cause."""

    code = PROJECT_WRITE_FAILED_CODE

    def __init__(self, message: str, *, status: int) -> None:
        super().__init__(message)
        self.status = status


def project_write_failed(exc: BaseException) -> ProjectWriteFailedError | None:
    """The plain-words error for a disk-full, read-only, permission or I/O failure, else ``None``.

    A coded refusal and a lock timeout are never a write failure. The text names the cause and
    the fix and never the file path.
    """
    if isinstance(exc, (CodedError, Timeout)):
        return None
    if isinstance(exc, sqlite3.OperationalError):
        code = getattr(exc, "sqlite_errorcode", None)
        base = (code & 0xFF) if code is not None else None
        full = base == sqlite3.SQLITE_FULL
        not_writable = base == sqlite3.SQLITE_READONLY
        disk_error = base == sqlite3.SQLITE_IOERR
    elif isinstance(exc, OSError):
        full = exc.errno in _DISK_FULL_ERRNOS
        not_writable = exc.errno in _NOT_WRITABLE_ERRNOS
        disk_error = exc.errno == errno.EIO
    else:
        return None
    if full:
        return ProjectWriteFailedError(_DISK_FULL_TEXT, status=507)
    if not_writable:
        return ProjectWriteFailedError(_NOT_WRITABLE_TEXT, status=500)
    if disk_error:
        return ProjectWriteFailedError(_DISK_ERROR_TEXT, status=500)
    return None
