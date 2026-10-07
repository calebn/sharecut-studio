"""Document sync errors."""

from podcast_mcp.util.coded_error import CodedError


class DocumentConflictError(CodedError, ValueError):
    """Raised when a command target no longer exists (offline rebase conflict)."""

    code = "document_conflict"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.conflict = True


class DocumentSequenceConflictError(DocumentConflictError):
    """``(client_id, client_seq)`` or ``command_id`` already names a different edit (#377)."""
