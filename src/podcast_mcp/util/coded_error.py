"""A domain refusal: an anticipated condition whose message is written for the caller.

A ``CodedError`` says the request cannot be honoured as asked (a stale guard, an unknown id,
an out-of-range index, a missing file or project, a required step not done yet). Its message
is safe to show the host, and its ``code`` is a stable, machine-readable name for the refusal.
Never build the message from another exception's text: log that and chain it with ``from``.
Any other exception is treated as a bug: adapters that must not leak internals (MCP, owner and
guest) keep its text on the server.

Every adapter reports the same message and code: the MCP tool result's
``structured_content.error_code`` (``mcp/tool_errors.py`` and guest remote MCP, both through
``util/tool_refusal.py``, which redacts host paths from the message for a share guest), the CLI's
``Error: <message> (code <code>)`` line (``cli/busy.py``) and, on routes that map one, the
GUI's ``X-Sharecut-Error-Code`` header. ``project_busy`` (a lock timeout) uses the same
adapters but is not a ``CodedError``; see ``util/project_state.py``.

Raise a refusal through the class matching the builtin the call site always raised
(``CodedValueError`` / ``CodedKeyError`` / ``CodedFileNotFoundError``), so callers that catch
the builtin keep working, or give a named guard class both bases and a class-level ``code``::

    class TranscriptTextChangedError(CodedError, ValueError):
        code = "transcript_changed"
"""

from __future__ import annotations


class CodedError(Exception):
    """A refusal whose message reaches the caller; ``code`` names it (for example ``no_mix``).

    Pass ``code`` per raise, or set it once as a class attribute on a named subclass.
    """

    code: str

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code
        if not getattr(self, "code", ""):
            raise TypeError(f"{type(self).__name__} needs a code")

    def __str__(self) -> str:
        # The message as written, also for a KeyError subclass (KeyError quotes its arg).
        return str(self.args[0]) if self.args else ""


class CodedValueError(CodedError, ValueError):
    """A refused value or state where the call site raises ``ValueError``."""


class CodedKeyError(CodedError, KeyError):
    """An unknown id where the call site raises ``KeyError``."""


class CodedFileNotFoundError(CodedError, FileNotFoundError):
    """A missing file or project where the call site raises ``FileNotFoundError``."""


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
