"""What a failed tool call tells its caller: a refusal keeps its message and code, a crash nothing.

One rule for both MCP servers, so they cannot drift apart: the owner server
(``mcp/tool_errors.py::install_tool_errors``) and share-linked guest remote MCP
(``services/remote_mcp/protocol.py``). ``tool_refusal`` recognises two refusals, anywhere on
the exception's ``__cause__`` chain:

* a ``filelock.Timeout`` (``ProjectBusyError`` / ``RenderBusyError``, or a raw one such as the
  transcript-context lock, #396/#401) -> its fixed, path-free text and ``project_busy``;
* a ``CodedError`` (``util/coded_error.py``) -> its message and its own ``code``.

Anything else is a crash and returns ``None``: the adapter logs it on the host and the caller
sees only ``Error executing tool <name>`` (#1178, #1182).

A share guest is not the host: ``for_guest=True`` replaces each host filesystem path in a
refusal's message with ``[path]`` (``util.redact.redact_host_paths``), so a refusal written
for the host's own agent, such as ``raw media not found: <path>``, can reach a guest too.
"""

from __future__ import annotations

from dataclasses import dataclass

from filelock import Timeout
from mcp.types import CallToolResult, TextContent

from podcast_mcp.util.coded_error import coded_cause
from podcast_mcp.util.project_state import PROJECT_BUSY_CODE, busy_message
from podcast_mcp.util.redact import redact_host_paths


@dataclass(frozen=True)
class ToolRefusal:
    """A refusal as its caller sees it: the message to show and its ``error_code``."""

    message: str
    code: str


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
        return ToolRefusal(busy_message(busy), PROJECT_BUSY_CODE)
    refusal = coded_cause(exc)
    if refusal is None:
        return None
    message = str(refusal)
    if for_guest:
        message = redact_host_paths(message)
    return ToolRefusal(message, refusal.code)


def refusal_tool_result(refusal: ToolRefusal) -> CallToolResult:
    """A structured ``is_error`` result: the message as text, plus ``error_code``."""
    return CallToolResult(
        content=[TextContent(type="text", text=refusal.message)],
        structured_content={"ok": False, "error": refusal.message, "error_code": refusal.code},
        is_error=True,
    )


def crash_tool_result(name: str) -> CallToolResult:
    """The ``is_error`` result for a crash: the mcp SDK's own fixed text, nothing from ``exc``."""
    return CallToolResult(
        content=[TextContent(type="text", text=f"Error executing tool {name}")],
        is_error=True,
    )
