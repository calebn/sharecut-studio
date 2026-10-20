"""Progress reporters: the shared heartbeat base and the in-process implementations."""

from __future__ import annotations

import asyncio
import contextvars
import json
import sys
import threading
import time
from contextlib import suppress
from typing import Any, TextIO

from podcast_mcp.util.progress.protocol import ProgressEvent, ProgressReporter


class TaskState:
    __slots__ = ("current", "label", "last_emit", "phase", "started_at", "total")

    def __init__(self, label: str, total: int | None) -> None:
        self.label = label
        self.total = total
        self.current = 0
        self.phase: str | None = None
        self.started_at = time.monotonic()
        self.last_emit = self.started_at


class ElapsedProgressMixin:
    """Emit elapsed time when updates stall: one heartbeat per sink, innermost task.

    Assumes the open tasks on one reporter form a single nested (LIFO) stack, as
    with nested ``with progress_task(...)`` blocks and one reporter per GUI job.
    Two concurrent sibling tasks on one shared reporter are not supported: only the
    most recently registered one is heartbeated.
    """

    def __init__(self, *, heartbeat_sec: float = 5.0) -> None:
        self._heartbeat_sec = heartbeat_sec
        self._tasks: dict[str, TaskState] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        # Run in a copy of this context so the heartbeat reaches the same output sink as the
        # command that started it (a handed-off command routes output per context).
        self._thread = threading.Thread(
            target=contextvars.copy_context().run, args=(self._heartbeat_loop,), daemon=True
        )
        self._thread.start()

    def _register_task(self, task_id: str, label: str, total: int | None) -> None:
        with self._lock:
            self._tasks.pop(task_id, None)
            self._tasks[task_id] = TaskState(label, total)

    def _touch_task(
        self,
        task_id: str,
        current: int,
        total: int | None = None,
        phase: str | None = None,
    ) -> TaskState | None:
        with self._lock:
            state = self._tasks.get(task_id)
            if state is None:
                return None
            state.current = current
            if total is not None:
                state.total = total
            if phase is not None:
                state.phase = phase
            state.last_emit = time.monotonic()
            return state

    def _finish_task(self, task_id: str) -> None:
        with self._lock:
            self._tasks.pop(task_id, None)

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=1.0)

    def _heartbeat_loop(self) -> None:
        while not self._stop.wait(1.0):
            now = time.monotonic()
            with self._lock:
                target = self._heartbeat_target_locked(now)
            if target is None:
                continue
            tid, st = target
            self._emit_heartbeat(tid, st, now - st.started_at)
            with self._lock:
                # The task may have ended and a new one registered under the same id.
                if self._tasks.get(tid) is st:
                    st.last_emit = now

    def _heartbeat_target_locked(self, now: float) -> tuple[str, TaskState] | None:
        """Innermost (last-registered) open task when no task on this sink emitted for ``heartbeat_sec``.

        Relies on the LIFO stack assumption in the class docstring.
        """
        if not self._tasks:
            return None
        if now - max(st.last_emit for st in self._tasks.values()) < self._heartbeat_sec:
            return None
        tid = next(reversed(self._tasks))
        return tid, self._tasks[tid]

    def _emit_heartbeat(self, task_id: str, state: TaskState, elapsed_sec: float) -> None:
        pass  # pragma: no cover - base class; reporters override


class NullProgress:
    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        pass

    def update(
        self,
        task_id: str,
        current: int,
        *,
        total: int | None = None,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        pass

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        pass

    def end(self, task_id: str, *, message: str | None = None) -> None:
        pass

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        pass

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        pass


class RecordingProgress:
    """Captures events for tests and compliance; optionally fans to another reporter."""

    def __init__(self, inner: ProgressReporter | None = None) -> None:
        self.inner = inner or NullProgress()
        self.events: list[ProgressEvent] = []

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        self.events.append(
            ProgressEvent(
                kind="start",
                task_id=task_id,
                label=label,
                current=0,
                total=total,
                elapsed_sec=0.0,
            )
        )
        self.inner.start(task_id, label, total=total)

    def update(
        self,
        task_id: str,
        current: int,
        *,
        total: int | None = None,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        self.events.append(
            ProgressEvent(
                kind="update",
                task_id=task_id,
                label=task_id,
                current=current,
                total=total,
                elapsed_sec=0.0,
                message=message,
                phase=phase,
            )
        )
        self.inner.update(task_id, current, total=total, message=message, phase=phase)

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        self.events.append(
            ProgressEvent(
                kind="message",
                task_id=task_id,
                label=task_id,
                current=None,
                total=None,
                elapsed_sec=0.0,
                message=text,
                phase=phase,
            )
        )
        self.inner.message(task_id, text, phase=phase)

    def end(self, task_id: str, *, message: str | None = None) -> None:
        self.events.append(
            ProgressEvent(
                kind="end",
                task_id=task_id,
                label=task_id,
                current=None,
                total=None,
                elapsed_sec=0.0,
                message=message,
            )
        )
        self.inner.end(task_id, message=message)

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        self.events.append(
            ProgressEvent(
                kind="fail",
                task_id=task_id,
                label=task_id,
                current=None,
                total=None,
                elapsed_sec=0.0,
                message=message,
                phase=phase,
            )
        )
        self.inner.fail(task_id, message=message, phase=phase)

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        self.events.append(
            ProgressEvent(
                kind="cancel",
                task_id=task_id,
                label=task_id,
                current=None,
                total=None,
                elapsed_sec=0.0,
                message=message,
            )
        )
        self.inner.cancel(task_id, message=message)


class MultiProgress:
    """Fan the same events to several reporters."""

    def __init__(self, *reporters: ProgressReporter) -> None:
        self._reporters = reporters

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        for r in self._reporters:
            r.start(task_id, label, total=total)

    def update(
        self,
        task_id: str,
        current: int,
        *,
        total: int | None = None,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        for r in self._reporters:
            r.update(task_id, current, total=total, message=message, phase=phase)

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        for r in self._reporters:
            r.message(task_id, text, phase=phase)

    def end(self, task_id: str, *, message: str | None = None) -> None:
        for r in self._reporters:
            r.end(task_id, message=message)

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        for r in self._reporters:
            r.fail(task_id, message=message, phase=phase)

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        for r in self._reporters:
            r.cancel(task_id, message=message)


class McpNotificationProgress:
    """Best-effort MCP ``notifications/progress`` bridge (async Context)."""

    def __init__(self, context: Any) -> None:
        self._context = context
        self._current = 0.0
        self._total: float | None = None
        self._label = ""
        self._pending_task: Any = None
        self._failed = False

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        self._failed = False
        self._label = label
        self._current = 0.0
        self._total = float(total) if total is not None else None
        self._schedule(0.0, self._total, label)

    def update(
        self,
        task_id: str,
        current: int,
        *,
        total: int | None = None,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        self._current = float(current)
        if total is not None:
            self._total = float(total)
        self._schedule(self._current, self._total, message or self._label)

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        self._schedule(self._current, self._total, text)

    def end(self, task_id: str, *, message: str | None = None) -> None:
        if self._failed:
            return
        done = self._total if self._total is not None else self._current
        self._schedule(done, self._total, message or "done")

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        self._failed = True
        self._schedule(self._current, self._total, message or "failed")

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        self._schedule(self._current, self._total, message or "cancelled")

    def _schedule(self, progress: float, total: float | None, message: str | None) -> None:
        ctx = self._context
        if ctx is None or not hasattr(ctx, "report_progress"):
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        pending = self._pending_task
        if pending is not None and not pending.done():
            pending.cancel()
        try:
            task = loop.create_task(ctx.report_progress(progress, total, message))
        except RuntimeError:  # pragma: no cover - no running loop / closed loop
            return

        def _consume_result(done: Any) -> None:
            with suppress(asyncio.CancelledError, Exception):
                done.result()

        task.add_done_callback(_consume_result)
        self._pending_task = task


class JsonProgressReporter(ElapsedProgressMixin):
    def __init__(self, stream: TextIO | None = None) -> None:
        super().__init__()
        self._stream = stream or sys.stderr

    def _emit(self, event: ProgressEvent) -> None:
        self._stream.write(json.dumps(event.to_dict()) + "\n")
        self._stream.flush()

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        self._register_task(task_id, label, total)
        self._emit(
            ProgressEvent(
                kind="start",
                task_id=task_id,
                label=label,
                current=0,
                total=total,
                elapsed_sec=0.0,
            )
        )

    def update(
        self,
        task_id: str,
        current: int,
        *,
        total: int | None = None,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        state = self._touch_task(task_id, current, total, phase=phase)
        if state is None:
            return
        elapsed = time.monotonic() - state.started_at
        self._emit(
            ProgressEvent(
                kind="update",
                task_id=task_id,
                label=state.label,
                current=current,
                total=state.total,
                elapsed_sec=elapsed,
                message=message,
                phase=phase or state.phase,
            )
        )

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
            if state is not None:
                if phase is not None:
                    state.phase = phase
                state.last_emit = time.monotonic()
        if state is None:
            return
        elapsed = time.monotonic() - state.started_at
        self._emit(
            ProgressEvent(
                kind="message",
                task_id=task_id,
                label=state.label,
                current=state.current,
                total=state.total,
                elapsed_sec=elapsed,
                message=text,
                phase=phase or state.phase,
            )
        )

    def end(self, task_id: str, *, message: str | None = None) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
        if state is None:
            return
        elapsed = time.monotonic() - state.started_at
        self._emit(
            ProgressEvent(
                kind="end",
                task_id=task_id,
                label=state.label,
                current=state.current,
                total=state.total,
                elapsed_sec=elapsed,
                message=message,
                phase=state.phase,
            )
        )
        self._finish_task(task_id)

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
        if state is None:
            return
        elapsed = time.monotonic() - state.started_at
        self._emit(
            ProgressEvent(
                kind="fail",
                task_id=task_id,
                label=state.label,
                current=state.current,
                total=state.total,
                elapsed_sec=elapsed,
                message=message,
                phase=phase or state.phase,
            )
        )
        self._finish_task(task_id)

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
        if state is None:
            return
        elapsed = time.monotonic() - state.started_at
        self._emit(
            ProgressEvent(
                kind="cancel",
                task_id=task_id,
                label=state.label,
                current=state.current,
                total=state.total,
                elapsed_sec=elapsed,
                message=message,
                phase=state.phase,
            )
        )
        self._finish_task(task_id)

    def _emit_heartbeat(self, task_id: str, state: TaskState, elapsed_sec: float) -> None:
        self._emit(
            ProgressEvent(
                kind="heartbeat",
                task_id=task_id,
                label=state.label,
                current=state.current,
                total=state.total,
                elapsed_sec=elapsed_sec,
                message="still running",
                phase=state.phase,
            )
        )


class CliProgressReporter(ElapsedProgressMixin):
    """Rich bars (TTY) or plain stderr lines; ``_bars`` is guarded by the mixin ``_lock``."""

    def __init__(self, *, enabled: bool = True) -> None:
        super().__init__()
        self._enabled = enabled
        self._rich = None
        self._progress = None
        self._bars: dict[str, Any] = {}
        if enabled and sys.stderr.isatty():
            try:
                from rich.console import Console
                from rich.progress import (
                    BarColumn,
                    Progress,
                    SpinnerColumn,
                    TaskProgressColumn,
                    TextColumn,
                    TimeElapsedColumn,
                )

                self._rich = True
                self._progress = Progress(
                    SpinnerColumn(),
                    TextColumn("[progress.description]{task.description}"),
                    BarColumn(),
                    TaskProgressColumn(),
                    TimeElapsedColumn(),
                    console=Console(stderr=True),
                    transient=False,
                )
                self._progress.start()
            except ImportError:
                self._rich = False

    def _bar(self, task_id: str) -> Any | None:
        with self._lock:
            return self._bars.get(task_id)

    def _pop_bar(self, task_id: str) -> Any | None:
        with self._lock:
            return self._bars.pop(task_id, None)

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        self._register_task(task_id, label, total)
        if not self._enabled:
            return
        if self._progress is not None:
            bar = self._progress.add_task(label, total=total)
            with self._lock:
                self._bars[task_id] = bar
        else:
            sys.stderr.write(f"{label}…\n")
            sys.stderr.flush()

    def update(
        self,
        task_id: str,
        current: int,
        *,
        total: int | None = None,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        state = self._touch_task(task_id, current, total, phase=phase)
        if state is None or not self._enabled:
            return
        bar = self._bar(task_id)
        if self._progress is not None and bar is not None:
            kwargs: dict[str, Any] = {"completed": current}
            if total is not None:
                kwargs["total"] = total
            if message:
                kwargs["description"] = message
            self._progress.update(bar, **kwargs)

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
            if state is not None:
                if phase is not None:
                    state.phase = phase
                state.last_emit = time.monotonic()
        if not self._enabled:
            return
        bar = self._bar(task_id)
        if self._progress is not None and bar is not None:
            self._progress.update(bar, description=text)
            return
        sys.stderr.write(f"{text}\n")
        sys.stderr.flush()

    def end(self, task_id: str, *, message: str | None = None) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
            bar = self._bars.pop(task_id, None)
        if self._progress is not None and bar is not None:
            if state and state.total:
                self._progress.update(bar, completed=state.total)
            self._progress.remove_task(bar)
        elif self._enabled and state:
            elapsed = time.monotonic() - state.started_at
            mins, secs = divmod(int(elapsed), 60)
            line = message or f"Finished {state.label} ({mins}:{secs:02d})"
            sys.stderr.write(f"{line}\n")
            sys.stderr.flush()
        self._finish_task(task_id)

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        bar = self._pop_bar(task_id)
        if self._progress is not None and bar is not None:
            self._progress.remove_task(bar)
        if self._enabled:
            sys.stderr.write(f"{message or 'failed'}\n")
            sys.stderr.flush()
        self._finish_task(task_id)

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        bar = self._pop_bar(task_id)
        if self._progress is not None and bar is not None:
            self._progress.remove_task(bar)
        if self._enabled:
            sys.stderr.write(f"{message or 'cancelled'}\n")
            sys.stderr.flush()
        self._finish_task(task_id)

    def _emit_heartbeat(self, task_id: str, state: TaskState, elapsed_sec: float) -> None:
        if not self._enabled or self._progress is not None:
            return
        mins, secs = divmod(int(elapsed_sec), 60)
        line = f"{state.label}… ({mins}:{secs:02d})"
        if state.total:
            line += f" {state.current}/{state.total}"
        sys.stderr.write(line + "\n")
        sys.stderr.flush()

    def close(self) -> None:
        super().close()
        if self._progress is not None:
            self._progress.stop()
