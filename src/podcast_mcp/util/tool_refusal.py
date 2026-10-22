"""What a failed tool call tells its caller: a refusal keeps its message and code, a crash nothing.

One rule for both MCP servers, so they cannot drift apart: the owner server
(``mcp/tool_errors.py::install_tool_errors``) and share-linked guest remote MCP
(``services/remote_mcp/protocol.py``). ``tool_refusal`` recognises refusals, anywhere on
the exception's ``__cause__`` chain:

* a ``filelock.Timeout`` (``ProjectBusyError`` / ``RenderBusyError``, or a raw one such as the
  transcript-context lock, #396/#401) -> its fixed, path-free text and ``project_busy``;
* a SQLite busy or locked error -> fixed project-busy text and ``project_busy``;
* a ``CodedError`` (``util/coded_error.py``) -> its message and its own ``code``.

Anything else is a crash and returns ``None``: the adapter logs it on the host and the caller
sees only ``Error executing tool <name>`` (#1178, #1182).

A ``ModelMissing`` also carries its model fields as ``extra`` (the host only).

A share guest is not the host: ``for_guest=True`` uses the refusal's ``guest_message()``,
which selects fixed copy by code and falls back to one generic line for unknown codes. Host
diagnostics never become guest copy (#1327).

The same rule covers what a guest sees while a call fails, not only its result:
``guest_failure_detail`` is the hook guest progress (``install_guest_tool_progress``) uses,
so a failed task's progress message reads ``<label> failed`` for a crash and carries only
the refusal's guest message otherwise.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from filelock import Timeout
from mcp.types import CallToolResult, TextContent

from podcast_mcp.util.coded_error import coded_cause, guest_message_for_code
from podcast_mcp.util.model_missing import ModelMissing
from podcast_mcp.util.project_state import PROJECT_BUSY_CODE, PROJECT_BUSY_MESSAGE, busy_message
from podcast_mcp.util.sqlite_tx import is_sqlite_busy


@dataclass(frozen=True)
class ToolRefusal:
    """A refusal as its caller sees it: the message to show and its ``error_code``."""

    message: str
    code: str
    extra: Mapping[str, Any] | None = None


def lock_timeout_cause(exc: BaseException) -> Timeout | None:
    """Walk ``exc`` and its ``__cause__`` chain for a ``filelock.Timeout``, else ``None``.

    Guards against a cycle (an exception should never be its own cause, but nothing
    prevents it) by tracking exceptions already seen.
    """
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        if isinstance(current, Timeout):
            return current
        seen.add(id(current))
        current = current.__cause__
    return None


def tool_refusal(exc: BaseException, *, for_guest: bool = False) -> ToolRefusal | None:
    """The refusal ``exc`` carries, or ``None`` when ``exc`` is a crash (see the module doc)."""
    busy = lock_timeout_cause(exc)
    if busy is not None:
        message = guest_message_for_code(PROJECT_BUSY_CODE) if for_guest else busy_message(busy)
        return ToolRefusal(message, PROJECT_BUSY_CODE)
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        if is_sqlite_busy(current):
            message = (
                guest_message_for_code(PROJECT_BUSY_CODE) if for_guest else PROJECT_BUSY_MESSAGE
            )
            return ToolRefusal(message, PROJECT_BUSY_CODE)
        seen.add(id(current))
        current = current.__cause__
    refusal = coded_cause(exc)
    if refusal is None:
        return None
    if for_guest:
        return ToolRefusal(refusal.guest_message(), refusal.code)
    extra = {"model": refusal.payload()} if isinstance(refusal, ModelMissing) else None
    return ToolRefusal(str(refusal), refusal.code, extra)


def guest_failure_detail(exc: BaseException) -> str | None:
    """What a guest may read about ``exc`` in a failure message: a refusal's text, else nothing."""
    refusal = tool_refusal(exc, for_guest=True)
    return refusal.message if refusal is not None else None


def refusal_tool_result(refusal: ToolRefusal) -> CallToolResult:
    """A structured ``is_error`` result: the message as text, plus ``error_code``."""
    return CallToolResult(
        content=[TextContent(type="text", text=refusal.message)],
        structured_content={
            "ok": False,
            "error": refusal.message,
            "error_code": refusal.code,
            **(refusal.extra or {}),
        },
        is_error=True,
    )


def crash_tool_result(name: str) -> CallToolResult:
    """The ``is_error`` result for a crash: the mcp SDK's own fixed text, nothing from ``exc``."""
    return CallToolResult(
        content=[TextContent(type="text", text=f"Error executing tool {name}")],
        is_error=True,
    )
