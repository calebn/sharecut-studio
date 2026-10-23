from __future__ import annotations

from contextlib import AbstractContextManager
from contextvars import ContextVar

from podcast_mcp.util.progress import (
    NullProgress,
    ProgressReporter,
    bind_progress,
    default_progress_enabled,
    make_progress_reporter,
)

# Per context, not per process: a Studio runs several handed-off commands at once, each in
# its own thread (#1733), and one command's reporter must not replace another's.
_reporter: ContextVar[ProgressReporter | None] = ContextVar("cli_reporter", default=None)
_prompts_allowed: ContextVar[bool] = ContextVar("cli_prompts_allowed", default=True)
_bind_cm: ContextVar[AbstractContextManager[object] | None] = ContextVar(
    "cli_progress_binding", default=None
)


def _unbind_and_close() -> None:
    binding = _bind_cm.get()
    if binding is not None:
        binding.__exit__(None, None, None)
        _bind_cm.set(None)
    reporter = _reporter.get()
    if reporter is not None and hasattr(reporter, "close"):
        reporter.close()


def configure(
    *, progress: bool | None = None, json_progress: bool = False, no_input: bool = False
) -> None:
    _prompts_allowed.set(not (no_input or json_progress))
    enabled = default_progress_enabled() if progress is None else progress
    _unbind_and_close()
    reporter = make_progress_reporter(enabled=enabled, json_mode=json_progress)
    _reporter.set(reporter)
    # Keep contextvar aligned with the CLI reporter.
    binding = bind_progress(reporter)
    binding.__enter__()
    _bind_cm.set(binding)


def prompts_allowed() -> bool:
    """False under ``--no-input`` and ``--json-progress``, whose stderr is for machines."""
    return _prompts_allowed.get()


def get_progress() -> ProgressReporter:
    reporter = _reporter.get()
    if reporter is None:
        configure()
        reporter = _reporter.get()
    assert reporter is not None
    return reporter


def reset_progress() -> None:
    _unbind_and_close()
    _reporter.set(NullProgress())
    _prompts_allowed.set(True)
