"""Hand stdio MCP tool calls to the Studio serving the project (#1753).

An agent on the stdio ``podcast-mcp`` server is a second writer while Studio is open: its tool
calls take the same project and render locks as Studio and fail with "Project is busy" while
Studio builds the mix. The CLI avoids this by handing each command to Studio (#1733); this does
the same for MCP. While a Studio serves the project, a tool call runs in that Studio through its
own ``/mcp`` endpoint (single writer, the screen updates live) and the result comes back as
Studio produced it. With no Studio serving the project, the call runs here. A Studio that was
found serving the project but cannot take the call (it fails before the call is sent) stops it
with an error and nothing runs, so the call never writes behind a live Studio.

Only the stdio entry point installs this. Studio runs the same tool registry, and its own copy
must never forward to itself.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import CallToolResult, TextContent

from podcast_mcp import settings
from podcast_mcp.mcp.project_default import ENV_VAR as PROJECT_ENV_VAR
from podcast_mcp.services.app import (
    DIRECT_ENV_VAR,
    StudioHost,
    StudioUnresponsive,
    locate_studio,
)
from podcast_mcp.util.mcp_call_tool import CallNext, wrap_call_tool
from podcast_mcp.util.progress import mcp_progress_sink

log = logging.getLogger(__name__)

HOST_MCP_PATH = "/mcp"

#: Tool arguments that name a file or folder on the caller's machine. Studio's working
#: directory is not the caller's, so a relative one is made absolute before it is sent.
PATH_ARGUMENTS = frozenset(
    {"file_path", "audio_path", "wav_a", "wav_b", "manifest_path", "diag_dir", "audio_dir"}
)


def _tool_accepts_project_path(server: Any, name: str) -> bool:
    tool = server._tool_manager.get_tool(name)
    if tool is None:
        return False
    return "project_path" in ((tool.parameters or {}).get("properties") or {})


def _requested_project(arguments: dict[str, Any]) -> str | None:
    value = arguments.get("project_path") or settings.raw(PROJECT_ENV_VAR)
    return str(value) if value else None


def _lost_result(host: StudioHost, name: str, why: str) -> CallToolResult:
    text = (
        f"Studio (pid {host.pid}) was running {name} for the project, but {why}. "
        "The call had already been sent and may have changed the project. Check the project "
        "in Studio (or run `podcast history-status`) before you call it again."
    )
    return CallToolResult(content=[TextContent(type="text", text=text)], is_error=True)


def _not_taken_result(host: StudioHost, name: str) -> CallToolResult:
    text = (
        f"Studio (pid {host.pid}) is serving the project but did not take {name}. "
        f"Nothing was run. Run it again, or set {DIRECT_ENV_VAR}=1 to write directly "
        "(this may overwrite what Studio is holding)."
    )
    return CallToolResult(content=[TextContent(type="text", text=text)], is_error=True)


def _progress_relay(context: Any) -> Any:
    """Forward Studio's progress to the stdio client, only if that client asked for progress.

    The client opts in with a ``progressToken``; without one nothing is sent, as when the tool
    runs in this process. A relay that fails never fails the call.
    """
    try:
        opted_in = mcp_progress_sink(context) is not None
    except Exception:  # an odd request context must not decide whether the call is sent
        log.debug("could not tell whether the client asked for progress", exc_info=True)
        return None
    if not opted_in:
        return None

    async def relay(progress: float, total: float | None, message: str | None) -> None:
        try:
            await context.report_progress(progress, total, message)
        except Exception:
            log.debug("could not relay Studio progress to the client", exc_info=True)

    return relay


async def _run_in_studio(
    host: StudioHost, name: str, arguments: dict[str, Any], context: Any = None
) -> Any:
    """Run one tool call in Studio and return its result, or an error result; never ``None``.

    A failure before the call is sent returns an error saying nothing was run, so the caller
    does not run the call here behind a live Studio.
    """
    relay = _progress_relay(context)
    sent = False
    try:
        url = f"http://{host.host}:{host.port}{HOST_MCP_PATH}"
        async with (
            streamable_http_client(url) as (read, write, *_),
            ClientSession(read, write) as session,
        ):
            await session.initialize()
            sent = True
            if relay is None:
                return await session.call_tool(name, arguments)
            return await session.call_tool(name, arguments, progress_callback=relay)
    except Exception as exc:
        if not sent:
            log.debug("Studio at %s:%s did not take the call", host.host, host.port, exc_info=True)
            return _not_taken_result(host, name)
        log.warning("Studio stopped answering %s", name, exc_info=True)
        return _lost_result(host, name, f"it stopped answering ({type(exc).__name__})")


def install_studio_handoff(server: Any) -> None:
    """Wrap ``server.call_tool`` so a project tool call runs in the Studio serving the project."""
    if getattr(server, "_podcast_studio_handoff_installed", False):
        return

    async def around(
        name: str, arguments: dict[str, Any], context: Any, call_next: CallNext
    ) -> Any:
        arguments = dict(arguments or {})
        requested = (
            _requested_project(arguments) if _tool_accepts_project_path(server, name) else None
        )
        if requested is None:
            return await call_next(arguments)
        try:
            host = await asyncio.to_thread(_locate, requested)
        except StudioUnresponsive as silent:
            return CallToolResult(
                content=[TextContent(type="text", text=str(silent))], is_error=True
            )
        if host is None:
            return await call_next(arguments)
        # Studio binds the project it serves; the path is not sent.
        forwarded = {
            key: _absolute(key, value) for key, value in arguments.items() if key != "project_path"
        }
        return await _run_in_studio(host, name, forwarded, context)

    wrap_call_tool(server, around)
    server._podcast_studio_handoff_installed = True


def _locate(project: str) -> StudioHost | None:
    try:
        return locate_studio(Path(project))
    except StudioUnresponsive:
        raise
    except Exception:
        log.debug("could not look for a Studio serving %s", project, exc_info=True)
        return None


def _absolute(key: str, value: Any) -> Any:
    if key in PATH_ARGUMENTS and isinstance(value, str) and value:
        return str(Path(value).expanduser().absolute())
    return value
