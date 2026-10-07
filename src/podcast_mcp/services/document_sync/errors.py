"""Document sync errors."""

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


class DocumentSequenceConflictError(DocumentConflictError):
    """``(client_id, client_seq)`` or ``command_id`` already names a different edit (#377)."""
