"""The progress protocol: the reporter interface, the event it carries, and shared limits."""

from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

PROGRESS_LAZY_CHIP_SEC = 1.0


PROGRESS_UPDATE_MIN_INTERVAL_SEC = 0.25


"""Per-task cap on ``ProgressTask.advance`` updates (latest value wins; see docs/progress.md).

The guest WS sink reuses it as ``GUEST_PROGRESS_COALESCE_SEC``.
"""


_SHORT_FAIL_MAX = 200


def short_fail_headline(message: str | None, phase: str | None = None) -> str | None:
    """Phase + short headline for chips; never a stack trace."""
    if message is None:
        return None
    line = message.strip().splitlines()[0] if message.strip() else ""
    if line.lower().startswith("traceback"):
        line = ""
    if not line and phase:
        line = phase
    if not line:
        return None
    return line[:_SHORT_FAIL_MAX]


@dataclass(frozen=True)
class ProgressEvent:
    kind: str
    task_id: str
    label: str
    current: int | None
    total: int | None
    elapsed_sec: float
    message: str | None = None
    phase: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "task_id": self.task_id,
            "label": self.label,
            "current": self.current,
            "total": self.total,
            "elapsed_sec": round(self.elapsed_sec, 2),
            "message": self.message,
            "phase": self.phase,
        }


@runtime_checkable
class ProgressReporter(Protocol):
    def start(
        self, task_id: str, label: str, total: int | None = None
    ) -> None: ...  # pragma: no cover

    def update(
        self,
        task_id: str,
        current: int,
        *,
        total: int | None = None,
        message: str | None = None,
        phase: str | None = None,
    ) -> None: ...  # pragma: no cover

    def message(
        self, task_id: str, text: str, *, phase: str | None = None
    ) -> None: ...  # pragma: no cover

    def end(self, task_id: str, *, message: str | None = None) -> None: ...  # pragma: no cover

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None: ...  # pragma: no cover

    def cancel(self, task_id: str, *, message: str | None = None) -> None: ...  # pragma: no cover

    def paused(self) -> AbstractContextManager[None]: ...  # pragma: no cover
