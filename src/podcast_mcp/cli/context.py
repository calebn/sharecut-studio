from __future__ import annotations

from podcast_mcp.util.progress import (
    NullProgress,
    ProgressReporter,
    bind_progress,
    default_progress_enabled,
    make_progress_reporter,
)

_reporter: ProgressReporter | None = None
_bind_cm = None


def configure(*, progress: bool | None = None, json_progress: bool = False) -> None:
    global _reporter, _bind_cm
    enabled = default_progress_enabled() if progress is None else progress
    if _bind_cm is not None:
        _bind_cm.__exit__(None, None, None)
        _bind_cm = None
    if _reporter is not None and hasattr(_reporter, "close"):
        _reporter.close()
    _reporter = make_progress_reporter(enabled=enabled, json_mode=json_progress)
    # Keep contextvar aligned with the process-wide CLI reporter.
    _bind_cm = bind_progress(_reporter)
    _bind_cm.__enter__()


def get_progress() -> ProgressReporter:
    if _reporter is None:
        configure()
    assert _reporter is not None
    return _reporter


def reset_progress() -> None:
    global _reporter, _bind_cm
    if _bind_cm is not None:
        _bind_cm.__exit__(None, None, None)
        _bind_cm = None
    if _reporter is not None and hasattr(_reporter, "close"):
        _reporter.close()
    _reporter = NullProgress()
