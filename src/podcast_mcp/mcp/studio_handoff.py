"""Hand stdio MCP tool calls to the Studio serving the project (#1753).

An agent on the stdio ``podcast-mcp`` server is a second writer while Studio is open: its tool
calls take the same project and render locks as Studio and fail with "Project is busy" while
Studio builds the mix. The CLI avoids this by handing each command to Studio (#1733); this does
the same for MCP. While a Studio serves the project, a tool call runs in that Studio through its
own ``/mcp`` endpoint (single writer, the screen updates live) and the result comes back as
Studio produced it. With no Studio serving the project, or one that cannot be reached before the
call is sent, the call runs here as before.

Only the stdio entry point installs this. Studio runs the same tool registry, and its own copy
must never forward to itself.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import CallToolResult, TextContent

from podcast_mcp import settings
from podcast_mcp.mcp.project_default import ENV_VAR as PROJECT_ENV_VAR
from podcast_mcp.services.app import StudioHost, StudioUnresponsive, locate_studio
from podcast_mcp.services.app.studio_host import DIRECT_ENV_VAR
from podcast_mcp.util.mcp_call_tool import CallNext, wrap_call_tool
from podcast_mcp.util.progress import mcp_progress_sink

log = logging.getLogger(__name__)

HOST_MCP_PATH = "/mcp"

#: The ping has its own timeout; this bounds a Studio that answers the ping and then hangs.
INITIALIZE_TIMEOUT_SEC = 10.0

#: Statuses that mean the host does not serve ``/mcp`` (an older build, a non-loopback bind).
_NO_MCP_ROUTE = (404, 405)

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
    return _error_result(text)


def _declined_result(host: StudioHost) -> CallToolResult:
    return _error_result(
        f"Studio (pid {host.pid}) is serving this project but did not take the call, so nothing "
        f"was run. Try again in a moment, or set {DIRECT_ENV_VAR}=1 to write directly "
        "(this may overwrite what Studio is holding)."
    )


def _error_result(text: str) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=text)], is_error=True)


def _leaves(exc: BaseException) -> list[BaseException]:
    if isinstance(exc, BaseExceptionGroup):
        return [leaf for inner in exc.exceptions for leaf in _leaves(inner)]
    return [exc]


def _studio_is_not_there(exc: BaseException, status: int | None) -> bool:
    """A timeout means Studio is there but silent, so it is not treated as absent."""
    if status in _NO_MCP_ROUTE:
        return True
    leaves = _leaves(exc)
    if any(isinstance(leaf, TimeoutError | httpx2.TimeoutException) for leaf in leaves):
        return False
    return any(isinstance(leaf, OSError | httpx2.NetworkError) for leaf in leaves)


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
    """Run one tool call in Studio; ``None`` means no Studio is there, so run it here."""
    relay = _progress_relay(context)
    sent = False
    status: int | None = None

    async def note_status(response: httpx2.Response) -> None:
        nonlocal status
        if status is None:
            status = response.status_code

    try:
        url = f"http://{host.host}:{host.port}{HOST_MCP_PATH}"
        http_client = httpx2.AsyncClient(timeout=httpx2.Timeout(30.0, read=300.0))
        http_client.event_hooks["response"].append(note_status)
        async with (
            http_client,
            streamable_http_client(url, http_client=http_client) as (read, write, *_),
            ClientSession(read, write) as session,
        ):
            async with asyncio.timeout(INITIALIZE_TIMEOUT_SEC):
                await session.initialize()
            sent = True
            if relay is None:
                return await session.call_tool(name, arguments)
            return await session.call_tool(name, arguments, progress_callback=relay)
    except Exception as exc:
        if not sent:
            if _studio_is_not_there(exc, status):
                log.debug("no Studio at %s:%s", host.host, host.port, exc_info=True)
                return None
            log.warning(
                "Studio at %s:%s did not take the call", host.host, host.port, exc_info=True
            )
            return _declined_result(host)
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
        result = await _run_in_studio(host, name, forwarded, context)
        if result is None:
            return await call_next(arguments)
        return result

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
