"""Progress for long-running work: one event vocabulary, one task API, many sinks.

``protocol`` holds the reporter interface and event, ``task`` the ``ProgressTask`` that
domain code opens, ``sinks`` the registries and adapter wraps that decide which reporters a
call reaches, ``reporters`` the in-process implementations over ``ElapsedProgressMixin``, and
``compliance`` the runtime record behind ``make progress-check``. See docs/progress.md.
"""

from __future__ import annotations

from podcast_mcp.util.progress.compliance import (
    ComplianceRecord,
    clear_compliance_log,
    clear_wrapped_ids,
    drain_compliance_log,
    mark_wrapped,
    wrapped_ids,
)
from podcast_mcp.util.progress.protocol import (
    PROGRESS_LAZY_CHIP_SEC,
    PROGRESS_UPDATE_MIN_INTERVAL_SEC,
    ProgressEvent,
    ProgressReporter,
    short_fail_headline,
)
from podcast_mcp.util.progress.reporters import (
    CliProgressReporter,
    ElapsedProgressMixin,
    JsonProgressReporter,
    McpNotificationProgress,
    MultiProgress,
    NotificationProgress,
    NullProgress,
    RecordingProgress,
)
from podcast_mcp.util.progress.sinks import (
    adapter_progress_sinks,
    clear_guest_progress_context,
    clear_guest_progress_sinks,
    clear_progress_sinks,
    cli_progress_sink,
    compose_progress,
    default_progress_enabled,
    guest_progress_sinks,
    install_guest_tool_progress,
    install_mcp_progress,
    make_progress_reporter,
    mcp_progress_sink,
    mcp_progress_token,
    register_guest_progress_sink,
    register_progress_sink,
    set_guest_progress_context,
)
from podcast_mcp.util.progress.task import (
    CancelledProgress,
    FailDetail,
    ProgressTask,
    bind_progress,
    current_progress,
    current_progress_task,
    progress_task,
    raise_if_cancel_requested,
    resolve_progress,
    resolve_progress_task,
)

__all__ = [
    "PROGRESS_LAZY_CHIP_SEC",
    "PROGRESS_UPDATE_MIN_INTERVAL_SEC",
    "CancelledProgress",
    "CliProgressReporter",
    "ComplianceRecord",
    "ElapsedProgressMixin",
    "FailDetail",
    "JsonProgressReporter",
    "McpNotificationProgress",
    "MultiProgress",
    "NotificationProgress",
    "NullProgress",
    "ProgressEvent",
    "ProgressReporter",
    "ProgressTask",
    "RecordingProgress",
    "adapter_progress_sinks",
    "bind_progress",
    "clear_compliance_log",
    "clear_guest_progress_context",
    "clear_guest_progress_sinks",
    "clear_progress_sinks",
    "clear_wrapped_ids",
    "cli_progress_sink",
    "compose_progress",
    "current_progress",
    "current_progress_task",
    "default_progress_enabled",
    "drain_compliance_log",
    "guest_progress_sinks",
    "install_guest_tool_progress",
    "install_mcp_progress",
    "make_progress_reporter",
    "mark_wrapped",
    "mcp_progress_sink",
    "mcp_progress_token",
    "progress_task",
    "raise_if_cancel_requested",
    "register_guest_progress_sink",
    "register_progress_sink",
    "resolve_progress",
    "resolve_progress_task",
    "set_guest_progress_context",
    "short_fail_headline",
    "wrapped_ids",
]
