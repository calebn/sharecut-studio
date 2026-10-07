"""A domain refusal that carries a stable, machine-readable ``code``.

Every adapter reports the same string: the GUI's ``X-Sharecut-Error-Code`` header, the MCP
tool result's ``structured_content.error_code`` (``mcp/busy_errors.py``) and the CLI's
``Error: <message> (code <code>)`` line (``cli/busy.py``), so a caller branches on one value
everywhere instead of parsing the message. ``project_busy`` (a lock timeout) uses the same
adapters but is not a ``CodedError``; see ``util/project_state.py``.
"""

from __future__ import annotations


class CodedError(ValueError):
    """A ``ValueError`` whose ``code`` names the refusal (for example ``no_mix``)."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


def coded_cause(exc: BaseException) -> CodedError | None:
    """Walk ``exc`` and its ``__cause__`` chain for a ``CodedError``, else ``None``."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        if isinstance(current, CodedError):
            return current
        seen.add(id(current))
        current = current.__cause__
    return None


def describe_error(exc: BaseException) -> str:
    """The message, plus ``(code <code>)`` when ``exc`` is a ``CodedError``."""
    if isinstance(exc, CodedError):
        return f"{exc} (code {exc.code})"
    return str(exc)
