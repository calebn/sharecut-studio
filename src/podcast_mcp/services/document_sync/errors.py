"""Document sync errors."""

from __future__ import annotations

from typing import TypeGuard

from podcast_mcp.util.coded_error import CodedError


class DocumentConflictError(CodedError, ValueError):
    """Raised when a command target no longer exists (offline rebase conflict).

    ``code`` is ``document_conflict`` unless a stale-target ``CodedError`` passes its own
    (for example ``history_stale``), which the HTTP adapter sends as
    ``X-Sharecut-Error-Code``.
    """

    code = "document_conflict"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message, code=code)
        self.conflict = True

    @classmethod
    def wrapping(cls, cause: CodedError, *, code: str | None = None) -> DocumentConflictError:
        """Wrap a refusal about a moved target, retaining its host diagnostic and effective code."""
        return cls(str(cause), code=code)


class DocumentSequenceConflictError(DocumentConflictError):
    """``(client_id, client_seq)`` or ``command_id`` already names a different edit (#377)."""


# A command whose target has gone (a clip, track, comment or edit deleted since the client
# read it) is an offline-rebase conflict, not a bad request. Decided by the refusal's code,
# never by its wording.
_MISSING_TARGET_CODES = frozenset({"track_has_no_media"})


def names_missing_target(exc: BaseException) -> TypeGuard[CodedError]:
    """True for a ``CodedError`` whose code says its target no longer exists."""
    if not isinstance(exc, CodedError):
        return False
    return exc.code.endswith("_not_found") or exc.code in _MISSING_TARGET_CODES
