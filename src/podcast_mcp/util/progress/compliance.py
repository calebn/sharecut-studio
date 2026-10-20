"""Runtime record of which operations opened a progress task and how rich it was."""

from __future__ import annotations

import threading
from contextvars import ContextVar
from dataclasses import dataclass

compliance_var: ContextVar[ComplianceBucket | None] = ContextVar(
    "podcast_progress_compliance", default=None
)


# Operation ids that passed through a choke-point wrap (MCP/CLI/guest/pipeline).
_WRAPPED_IDS: set[str] = set()


_WRAPPED_LOCK = threading.Lock()


@dataclass
class ComplianceBucket:
    """Per-task richness tracking for progress-check."""

    task_id: str
    label: str
    had_phase: bool = False
    had_message: bool = False
    had_update: bool = False
    ended: bool = False
    failed: bool = False
    cancelled: bool = False


@dataclass
class ComplianceRecord:
    task_id: str
    label: str
    rich: bool
    had_phase: bool
    had_message: bool
    had_update: bool
    ended: bool
    failed: bool
    cancelled: bool


_COMPLIANCE_LOG: list[ComplianceRecord] = []


_COMPLIANCE_LOCK = threading.Lock()


COMPLIANCE_LOG_MAX = 512


def mark_wrapped(operation_id: str) -> None:
    """Record that ``operation_id`` went through a choke-point wrap."""
    with _WRAPPED_LOCK:
        _WRAPPED_IDS.add(operation_id)


def wrapped_ids() -> frozenset[str]:
    with _WRAPPED_LOCK:
        return frozenset(_WRAPPED_IDS)


def clear_wrapped_ids() -> None:
    with _WRAPPED_LOCK:
        _WRAPPED_IDS.clear()


def drain_compliance_log() -> list[ComplianceRecord]:
    with _COMPLIANCE_LOCK:
        out = list(_COMPLIANCE_LOG)
        _COMPLIANCE_LOG.clear()
        return out


def clear_compliance_log() -> None:
    with _COMPLIANCE_LOCK:
        _COMPLIANCE_LOG.clear()


def note_compliance(bucket: ComplianceBucket) -> None:
    rich = bucket.had_phase or bucket.had_message or bucket.had_update
    with _COMPLIANCE_LOCK:
        _COMPLIANCE_LOG.append(
            ComplianceRecord(
                task_id=bucket.task_id,
                label=bucket.label,
                rich=rich,
                had_phase=bucket.had_phase,
                had_message=bucket.had_message,
                had_update=bucket.had_update,
                ended=bucket.ended,
                failed=bucket.failed,
                cancelled=bucket.cancelled,
            )
        )
        overflow = len(_COMPLIANCE_LOG) - COMPLIANCE_LOG_MAX
        if overflow > 0:
            del _COMPLIANCE_LOG[:overflow]
