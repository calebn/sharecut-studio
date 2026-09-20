"""Default project_path for MCP tools via the PODCAST_MCP_PROJECT env var.

Lets a harness pin one episode for the whole MCP session so agents don't
have to thread ``project_path`` through every tool call::

    {
        "mcpServers": {
            "sharecut": {
                "command": "/path/to/.venv/bin/podcast-mcp",
                "env": {"PODCAST_MCP_PROJECT": "/path/to/episode.project.json"},
            }
        }
    }

Installed once on the MCPServer (same choke-point pattern as
``install_mcp_progress``): wraps ``add_tool`` so every registered tool
function keeps its explicit ``project_path`` parameter, but it becomes
optional in the tool schema and falls back to the env var when omitted.
An explicit argument always wins. With neither, the tool raises a clear
error telling the agent what to do.
"""

from __future__ import annotations

import inspect
import os
from collections.abc import Callable
from functools import wraps
from typing import Any

from mcp.server.mcpserver.exceptions import ToolError

ENV_VAR = "PODCAST_MCP_PROJECT"


def resolve_project_path(project_path: str | None) -> str:
    """Return the effective project path: explicit arg, else env default."""
    if project_path:
        return project_path
    default = os.environ.get(ENV_VAR)
    if default:
        return default
    raise ValueError(
        f"No project_path was provided and {ENV_VAR} is not set. "
        f"Pass project_path to the tool, or set {ENV_VAR} in the MCP "
        'server environment (the "env" block of your harness MCP config).'
    )


def _optional_project_annotation(param: inspect.Parameter) -> Any:
    """Widen a project_path annotation to also accept None."""
    ann = param.annotation
    if ann is inspect.Parameter.empty:
        return "str | None"
    if isinstance(ann, str):
        if "None" in ann:
            return ann
        return f"({ann}) | None"
    try:
        return ann | None
    except TypeError:
        return "str | None"


def with_default_project(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap a tool so project_path is optional, defaulting to PODCAST_MCP_PROJECT.

    Functions without a required ``project_path`` parameter are returned
    unchanged. The wrapper preserves ``__name__`` (tool-name stability)
    and ``__doc__`` (tool descriptions).
    """
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return fn
    if "project_path" not in sig.parameters:
        return fn
    if sig.parameters["project_path"].default is not inspect.Parameter.empty:
        return fn

    orig_param = sig.parameters["project_path"]
    new_param = orig_param.replace(
        default=None, annotation=_optional_project_annotation(orig_param)
    )
    params: list[inspect.Parameter] = []
    inserted = False
    for p in sig.parameters.values():
        if p.name == "project_path":
            continue
        # A defaulted parameter may not precede a required one, so park
        # project_path just before any *args / keyword-only / **kwargs group
        # (for the common all-positional case this puts it last).
        if not inserted and p.kind in (
            inspect.Parameter.VAR_POSITIONAL,
            inspect.Parameter.KEYWORD_ONLY,
            inspect.Parameter.VAR_KEYWORD,
        ):
            params.append(new_param)
            inserted = True
        params.append(p)
    if not inserted:
        params.append(new_param)
    new_sig = sig.replace(parameters=params)

    def _call(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
        # Bind against the wrapper's (reordered) signature, so positional
        # callers follow what they see ...
        bound = new_sig.bind_partial(*args, **kwargs)
        if not bound.arguments.get("project_path"):
            try:
                bound.arguments["project_path"] = resolve_project_path(None)
            except ValueError as exc:
                # MCP SDK 2.2.0 turns non-ToolError exceptions into
                # UnexpectedToolError, which hides the message from the
                # agent. Raise ToolError so the helpful text reaches them.
                raise ToolError(str(exc)) from exc
        # ... then rebind by name against the original signature so the
        # underlying function always receives its own parameter order.
        orig_bound = sig.bind_partial(**bound.arguments)
        return fn(*orig_bound.args, **orig_bound.kwargs)

    if inspect.iscoroutinefunction(fn):

        @wraps(fn)
        async def _async_wrapper(*args: Any, **kwargs: Any) -> Any:
            return await _call(args, kwargs)

        wrapper: Callable[..., Any] = _async_wrapper
    else:

        @wraps(fn)
        def _sync_wrapper(*args: Any, **kwargs: Any) -> Any:
            return _call(args, kwargs)

        wrapper = _sync_wrapper

    wrapper.__signature__ = new_sig  # type: ignore[attr-defined]
    return wrapper


def install_project_default(server: Any) -> None:
    """Wrap MCPServer.add_tool so every tool inherits the project default."""
    if getattr(server, "_podcast_project_default_installed", False):
        return

    original_add_tool = server.add_tool

    def add_tool(fn: Callable[..., Any], **kwargs: Any) -> None:
        return original_add_tool(with_default_project(fn), **kwargs)

    server.add_tool = add_tool  # type: ignore[method-assign]
    server._podcast_project_default_installed = True
