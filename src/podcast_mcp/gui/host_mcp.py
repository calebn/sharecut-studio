"""Host Streamable HTTP MCP on the local GUI (official SDK, not guest JSON-RPC).

Public URL is ``POST/GET http://127.0.0.1:8765/mcp``. Guest share MCP stays on
``/mcp/{token}`` and ``/mcp/{token}/mcp`` — those routes are registered first.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any

from fastapi import FastAPI
from mcp.types import CallToolResult, TextContent
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from podcast_mcp.mcp.server import mcp

HOST_MCP_PATH = "/mcp"

NO_OPEN_PROJECT = "No episode is open in Sharecut Studio. Open a project in the DAW, then retry."

_request_app: ContextVar[FastAPI | None] = ContextVar("host_mcp_app", default=None)
_call_tool_wrapped = False


def _tool_accepts_project_path(name: str) -> bool:
    tool = mcp._tool_manager.get_tool(name)
    if tool is None:
        return False
    parameters = tool.parameters or {}
    properties = parameters.get("properties") or {}
    return "project_path" in properties


def _no_open_project_result() -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=NO_OPEN_PROJECT)],
        is_error=True,
    )


def install_host_project_injection() -> None:
    """Bind the GUI's open episode into host MCP tools (idempotent)."""
    global _call_tool_wrapped
    if _call_tool_wrapped:
        return

    original_call_tool = mcp.call_tool

    async def call_tool(
        name: str,
        arguments: dict[str, Any],
        context: Any = None,
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        arguments = dict(arguments or {})
        app = _request_app.get()
        if app is not None:
            served = getattr(app.state, "served_project", None)
            if served is None:
                return _no_open_project_result()
            if _tool_accepts_project_path(name):
                arguments["project_path"] = str(served)
        return await original_call_tool(name, arguments, context, *args, **kwargs)

    mcp.call_tool = call_tool  # type: ignore[method-assign]
    _call_tool_wrapped = True


def streamable_host_http_app(*, host: str = "127.0.0.1") -> ASGIApp:
    """Build the stateless SDK Streamable HTTP app (creates ``session_manager``)."""
    return mcp.streamable_http_app(
        streamable_http_path=HOST_MCP_PATH,
        host=host,
        stateless_http=True,
    )


class _BindRequestApp:
    """ASGI wrapper so Starlette ``Route`` does not treat the binder as ``func(request)``."""

    def __init__(self, app: FastAPI, inner: ASGIApp) -> None:
        self._app = app
        self._inner = inner

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        token = _request_app.set(self._app)
        try:
            await self._inner(scope, receive, send)
        finally:
            _request_app.reset(token)


def mount_host_mcp(
    app: FastAPI,
    *,
    host: str = "127.0.0.1",
    enabled: bool = True,
) -> None:
    """Register exact ``/mcp`` last so guest ``/mcp/{token}`` routes stay first.

    Use a method-complete ``Route`` rather than ``Mount("/")`` so OPTIONS on
    other GUI paths does not fall through to the SDK app. Off-loopback binds
    skip this mount so LAN peers cannot forge ``Host: 127.0.0.1``.
    """
    install_host_project_injection()
    if not enabled:
        app.state.host_mcp_session_manager = None
        return
    http_app = streamable_host_http_app(host=host)
    app.state.host_mcp_session_manager = mcp.session_manager
    app.router.routes.append(
        Route(
            HOST_MCP_PATH,
            endpoint=_BindRequestApp(app, http_app),
            methods=["GET", "POST", "DELETE", "OPTIONS", "HEAD"],
        )
    )


@asynccontextmanager
async def host_mcp_lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Run the SDK session manager captured on this app (not the process global)."""
    manager = getattr(app.state, "host_mcp_session_manager", None)
    if manager is None:
        yield
        return
    async with manager.run():
        yield
