"""CLI progress wraps: bind the CLI reporter and live adapter sinks around each command."""

from __future__ import annotations

import functools
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from podcast_mcp.cli.context import get_progress
from podcast_mcp.cli.model_offer import offer_download
from podcast_mcp.util.model_missing import ModelMissing
from podcast_mcp.util.progress import (
    ProgressTask,
    adapter_progress_sinks,
    bind_progress,
    compose_progress,
    progress_task,
)


def cli_operation_label(op_id: str) -> str:
    """Readable CLI wrap label: ``pipeline.run`` -> ``podcast pipeline run``."""
    return "podcast " + op_id.replace(".", " ")


@contextmanager
def cli_progress_task(op_id: str) -> Iterator[ProgressTask]:

    reporter = compose_progress(get_progress(), *adapter_progress_sinks())
    with (
        bind_progress(reporter),
        progress_task(op_id, cli_operation_label(op_id), reporter=reporter, mark_id=op_id) as task,
    ):
        yield task


def install_cli_progress(app: Any) -> None:
    """Wrap Typer command callbacks so every CLI command opens progress_task."""

    def _wrap_callback(callback: Callable[..., Any], op_id: str) -> Callable[..., Any]:
        if getattr(callback, "_podcast_progress_wrapped", False):
            return callback

        @functools.wraps(callback)
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            with cli_progress_task(op_id):
                offered: set[tuple[str, str]] = set()
                while True:
                    try:
                        return callback(*args, **kwargs)
                    except ModelMissing as missing:
                        asked = (missing.id, missing.model)
                        if asked in offered or not offer_download(missing):
                            raise
                        offered.add(asked)

        wrapped._podcast_progress_wrapped = True  # type: ignore[attr-defined]
        return wrapped

    def _walk(typer_app: Any, prefix: str = "") -> None:
        for cmd in getattr(typer_app, "registered_commands", []) or []:
            cb = getattr(cmd, "callback", None)
            if cb is None:
                continue
            name = getattr(cmd, "name", None) or getattr(cb, "__name__", "command")
            op_id = f"{prefix}{name}" if prefix else str(name)
            cmd.callback = _wrap_callback(cb, op_id)
        for group in getattr(typer_app, "registered_groups", []) or []:
            name = getattr(group, "name", None) or ""
            inner = getattr(group, "typer_instance", None)
            if inner is None:
                continue
            next_prefix = f"{prefix}{name}." if name else prefix
            _walk(inner, next_prefix)

    _walk(app)
