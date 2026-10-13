"""A domain refusal: an anticipated condition whose message is written for the caller.

A ``CodedError`` says the request cannot be honoured as asked (a stale guard, an unknown id,
an out-of-range index, a missing file or project, a required step not done yet). Its message
is safe to show the host, and its ``code`` is a stable, machine-readable name for the refusal.
Never build the message from another exception's text: log that and chain it with ``from``.
Any other exception is treated as a bug: adapters that must not leak internals (MCP, owner and
guest) keep its text on the server.

Every adapter reports the same message and code: the MCP tool result's
``structured_content.error_code`` (``mcp/tool_errors.py`` and guest remote MCP, both through
``util/tool_refusal.py``, which reads ``guest_message()`` instead for a share guest), the CLI's
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

from typing import Any

from podcast_mcp.util.redact import mentions_host_path

GENERIC_GUEST_MESSAGE = "That didn't work; ask the host to check this episode."
"""What a share guest reads from a refusal whose host message names a host path."""


class CodedError(Exception):
    """A refusal whose message reaches the caller; ``code`` names it (for example ``no_mix``).

    Pass ``code`` per raise, or set it once as a class attribute on a named subclass. A
    refusal whose host message names a path passes ``guest_message``, the fixed, path-free
    text a share guest reads instead.
    """

    code: str
    _guest_message: str | None = None

    def __init__(
        self, message: str, *, code: str | None = None, guest_message: str | None = None
    ) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code
        if guest_message is not None:
            self._guest_message = guest_message
        if not getattr(self, "code", ""):
            raise TypeError(f"{type(self).__name__} needs a code")

    def __str__(self) -> str:
        # The message as written, also for a KeyError subclass (KeyError quotes its arg).
        return str(self.args[0]) if self.args else ""

    def guest_message(self) -> str:
        """The message for a share guest; never a host path or a piece of one.

        The fixed text the raise site gave, else the host message when it names no path,
        else ``GENERIC_GUEST_MESSAGE``. A path in prose is never partly redacted: where it
        ends is ambiguous, and what is left over spells part of a folder name.
        """
        if self._guest_message is not None:
            return self._guest_message
        text = str(self)
        return GENERIC_GUEST_MESSAGE if mentions_host_path(text) else text

    def __reduce__(self) -> tuple[Any, ...]:
        # Exception pickling re-calls ``cls(*args)``, which loses a per-raise ``code`` (it is
        # keyword-only) and breaks subclasses with their own ``__init__``. Rebuild without
        # ``__init__`` instead, so a refusal survives a process pool.
        return (_restore_coded_error, (type(self), self.args, dict(self.__dict__)))


def _restore_coded_error(
    cls: type[CodedError], args: tuple[Any, ...], state: dict[str, Any]
) -> CodedError:
    exc = cls.__new__(cls, *args)
    exc.args = args
    exc.__dict__.update(state)
    return exc


class CodedValueError(CodedError, ValueError):
    """A refused value or state where the call site raises ``ValueError``."""


class CodedKeyError(CodedError, KeyError):
    """An unknown id where the call site raises ``KeyError``."""


class CodedFileNotFoundError(CodedError, FileNotFoundError):
    """A missing file or project where the call site raises ``FileNotFoundError``."""


class CodedPermissionError(CodedError, PermissionError):
    """A refused permission where the call site raises ``PermissionError``."""


class HostSetupError(CodedPermissionError):
    """The host's own setup refuses to run: a private file or folder is not private.

    Not a caller's missing capability: adapters answer it as a server-side failure (HTTP 500,
    JSON-RPC ``-32603``). The host's message names the path and the fix; subclasses pass a
    fixed, path-free ``guest_message`` for a share guest.
    """


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
