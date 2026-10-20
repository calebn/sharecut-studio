"""Which reporters a call reaches: sink registries, composition and the adapter wraps."""

from __future__ import annotations

import functools
import sys
import threading
from collections.abc import Callable, Mapping
from contextvars import ContextVar
from typing import Any

from podcast_mcp import settings
from podcast_mcp.util.mcp_call_tool import CallNext, wrap_call_tool
from podcast_mcp.util.progress.compliance import mark_wrapped
from podcast_mcp.util.progress.protocol import ProgressReporter
from podcast_mcp.util.progress.reporters import (
    CliProgressReporter,
    JsonProgressReporter,
    McpNotificationProgress,
    MultiProgress,
    NullProgress,
)
from podcast_mcp.util.progress.task import FailDetail, bind_progress, fail_detail_var, progress_task

_adapter_sink_factories: list[Callable[[], ProgressReporter | None]] = []


_adapter_sink_lock = threading.Lock()


_guest_sink_factories: list[Callable[[str], ProgressReporter | None]] = []


_guest_sink_lock = threading.Lock()


_guest_share_token: ContextVar[str | None] = ContextVar("guest_share_token", default=None)


_guest_mcp_context: ContextVar[Any] = ContextVar("guest_mcp_context", default=None)


def register_progress_sink(factory: Callable[[], ProgressReporter | None]) -> None:
    """Register an extra live sink (GUI SSE). Util stays adapter-free."""
    with _adapter_sink_lock:
        if factory not in _adapter_sink_factories:
            _adapter_sink_factories.append(factory)


def clear_progress_sinks() -> None:
    with _adapter_sink_lock:
        _adapter_sink_factories.clear()


def adapter_progress_sinks() -> list[ProgressReporter | None]:
    with _adapter_sink_lock:
        factories = list(_adapter_sink_factories)
    return [factory() for factory in factories]


def register_guest_progress_sink(factory: Callable[[str], ProgressReporter | None]) -> None:
    """Guest-token sink factory (review WS). Not used for host MCP/CLI wraps."""
    with _guest_sink_lock:
        if factory not in _guest_sink_factories:
            _guest_sink_factories.append(factory)


def clear_guest_progress_sinks() -> None:
    with _guest_sink_lock:
        _guest_sink_factories.clear()


def set_guest_progress_context(*, token: str | None, mcp_context: Any = None) -> None:
    _guest_share_token.set(token)
    _guest_mcp_context.set(mcp_context)


def clear_guest_progress_context() -> None:
    _guest_share_token.set(None)
    _guest_mcp_context.set(None)


def guest_progress_sinks(token: str | None) -> list[ProgressReporter | None]:
    if not token:
        return []
    with _guest_sink_lock:
        factories = list(_guest_sink_factories)
    return [factory(token) for factory in factories]


def compose_progress(*extra: ProgressReporter | None) -> ProgressReporter:
    """Attach only live sinks. Zero subscribers → NullProgress (cheap no-op).

    Domain emits once; adapters pass sinks that exist for this call (CLI TTY /
    JSON, MCP progressToken, registered in-process GUI SSE). Origin of the call
    is not a signal — do not dual-publish when nobody is listening.
    """
    sinks: list[ProgressReporter] = []
    for reporter in extra:
        if reporter is None or isinstance(reporter, NullProgress):
            continue
        sinks.append(reporter)
    if not sinks:
        return NullProgress()
    if len(sinks) == 1:
        return sinks[0]
    return MultiProgress(*sinks)


def cli_progress_sink(
    *,
    enabled: bool | None = None,
    json_mode: bool = False,
) -> ProgressReporter | None:
    """CLI stderr sink when a consumer exists (TTY or ``--json-progress``)."""
    if enabled is None:
        enabled = default_progress_enabled()
    if not enabled:
        return None
    if json_mode:
        return JsonProgressReporter()
    if not sys.stderr.isatty():
        return None
    return CliProgressReporter(enabled=True)


def _token_from_mapping(obj: Mapping[str, Any]) -> Any:
    token = obj.get("progressToken") or obj.get("progress_token")
    if token is not None:
        return token
    meta = obj.get("_meta") or obj.get("meta")
    if isinstance(meta, Mapping):
        return meta.get("progressToken") or meta.get("progress_token")
    return None


def mcp_progress_token(context: Any) -> Any:
    if context is None:
        return None
    if isinstance(context, Mapping):
        return _token_from_mapping(context)
    direct = getattr(context, "progress_token", None) or getattr(context, "progressToken", None)
    if direct is not None:
        return direct
    for attr in ("meta", "request_context", "_meta"):
        obj = getattr(context, attr, None)
        if obj is None:
            continue
        if isinstance(obj, Mapping):
            token = obj.get("progressToken") or obj.get("progress_token")
        else:
            token = getattr(obj, "progressToken", None) or getattr(obj, "progress_token", None)
            if token is None and hasattr(obj, "meta"):
                meta = obj.meta
                if isinstance(meta, Mapping):
                    token = meta.get("progressToken") or meta.get("progress_token")
                else:
                    token = getattr(meta, "progressToken", None) if meta is not None else None
        if token is not None:
            return token
    return None


def mcp_progress_sink(context: Any) -> ProgressReporter | None:
    """MCP notifications sink only when the client opted in with a progressToken."""
    if context is None:
        return None
    if mcp_progress_token(context) is None:
        return None
    if isinstance(context, ProgressReporter):
        return context
    if not hasattr(context, "report_progress"):
        return None
    return McpNotificationProgress(context)


def make_progress_reporter(
    *,
    enabled: bool = True,
    json_mode: bool = False,
) -> ProgressReporter:
    sink = cli_progress_sink(enabled=enabled, json_mode=json_mode)
    return sink if sink is not None else NullProgress()


def default_progress_enabled() -> bool:
    return settings.value("PODCAST_PROGRESS", "1") not in ("0", "false", "no")


def install_mcp_progress(server: Any) -> None:
    """Wrap MCPServer.add_tool + call_tool so every tool inherits progress_task."""
    if getattr(server, "_podcast_progress_installed", False):
        return

    original_add_tool = server.add_tool

    def add_tool(
        fn: Callable[..., Any],
        name: str | None = None,
        title: str | None = None,
        description: str | None = None,
        annotations: Any = None,
        icons: Any = None,
        meta: Any = None,
        structured_output: bool | None = None,
    ) -> None:
        tool_name = name if isinstance(name, str) else getattr(fn, "__name__", "tool")
        mark_wrapped(str(tool_name))
        return original_add_tool(
            fn,
            name=name,
            title=title,
            description=description,
            annotations=annotations,
            icons=icons,
            meta=meta,
            structured_output=structured_output,
        )

    async def around_call(
        name: str, arguments: dict[str, Any], context: Any, call_next: CallNext
    ) -> Any:
        reporter = compose_progress(
            mcp_progress_sink(context),
            *adapter_progress_sinks(),
        )
        with bind_progress(reporter), progress_task(name, name, reporter=reporter, mark_id=name):
            return await call_next(arguments)

    server.add_tool = add_tool  # type: ignore[method-assign]
    wrap_call_tool(server, around_call)
    server._podcast_progress_installed = True


def install_guest_tool_progress(
    call_tool_fn: Callable[..., Any], *, fail_detail: FailDetail
) -> Callable[..., Any]:
    """Wrap guest remote MCP ``call_tool`` so handlers see a bound reporter.

    Every sink here faces a share guest (the MCP ``progressToken`` stream and the share
    page's WebSocket), so each ``progress_task`` that fails during the call describes its
    exception with ``fail_detail`` instead of the exception's text. Guest remote MCP
    passes ``util.tool_refusal.guest_failure_detail``: a refusal's guest-safe message, and
    nothing for a crash, which then reads ``<label> failed`` (#1182).
    """

    @functools.wraps(call_tool_fn)
    def wrapped(name: str, arguments: dict[str, Any] | None = None) -> Any:
        token = _guest_share_token.get()
        extras = [mcp_progress_sink(_guest_mcp_context.get()), *guest_progress_sinks(token)]
        reporter = compose_progress(*extras)
        detail_token = fail_detail_var.set(fail_detail)
        try:
            with (
                bind_progress(reporter),
                progress_task(name, name, reporter=reporter, mark_id=name),
            ):
                return call_tool_fn(name, arguments)
        finally:
            fail_detail_var.reset(detail_token)
            for sink in extras:
                closer = getattr(sink, "close", None)
                if callable(closer):
                    closer()

    return wrapped
