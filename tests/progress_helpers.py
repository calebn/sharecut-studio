r"""Shared fake ``rich.progress`` for ``CliProgressReporter`` rich-mode tests.

A real ``rich.progress.Progress`` starts a daemon auto-refresh thread whose
Console writes to whatever ``sys.stderr`` is at refresh time. If a test never
closes its reporter, that thread keeps running and writes clear-line escapes
(``\r\x1b[2K``) into later tests' stderr capture, which makes unrelated
``capsys`` assertions flaky under xdist. Tests must never build a real
``Progress``. Use the ``fake_rich_progress`` fixture (``tests/conftest.py``),
which installs this module for the whole test.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock


class RecordingFakeProgress:
    """Fake rich ``Progress`` that records ctor kwargs and every bar call."""

    _bar_seq = 0

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.ctor_kwargs = kwargs
        self.add_task_calls: list[dict[str, Any]] = []
        self.update_calls: list[tuple[Any, dict[str, Any]]] = []
        self.remove_task_calls: list[Any] = []
        self.stopped = False

    def start(self) -> None:
        return None

    def stop(self) -> None:
        self.stopped = True

    def add_task(self, label: str, total: int | None = 0) -> int:
        type(self)._bar_seq += 1
        bar = type(self)._bar_seq
        self.add_task_calls.append({"label": label, "total": total})
        return bar

    def update(self, bar: Any, **kwargs: Any) -> None:
        self.update_calls.append((bar, kwargs))

    def remove_task(self, bar: Any) -> None:
        self.remove_task_calls.append(bar)


def fake_rich_progress_module() -> MagicMock:
    """Stand-in ``rich.progress`` module whose ``Progress`` is ``RecordingFakeProgress``."""
    return MagicMock(
        BarColumn=MagicMock(),
        Progress=RecordingFakeProgress,
        SpinnerColumn=MagicMock(),
        TaskProgressColumn=MagicMock(),
        TextColumn=MagicMock(),
        TimeElapsedColumn=MagicMock(),
    )
