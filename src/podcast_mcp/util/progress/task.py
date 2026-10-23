"""``ProgressTask`` and the context variables that bind a reporter to the running call."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token
from types import TracebackType

from podcast_mcp.util.model_missing import failure_text
from podcast_mcp.util.progress.compliance import (
    ComplianceBucket,
    compliance_var,
    mark_wrapped,
    note_compliance,
)
from podcast_mcp.util.progress.protocol import PROGRESS_UPDATE_MIN_INTERVAL_SEC, ProgressReporter
from podcast_mcp.util.progress.reporters import NullProgress

_update_clock: Callable[[], float] = time.monotonic  # tests pin this


_reporter_var: ContextVar[ProgressReporter | None] = ContextVar(
    "podcast_progress_reporter", default=None
)


_task_var: ContextVar[ProgressTask | None] = ContextVar("podcast_progress_task", default=None)


FailDetail = Callable[[BaseException], str | None]


"""What a failed ``progress_task`` may say about its exception: text to append, or ``None``."""


fail_detail_var: ContextVar[FailDetail | None] = ContextVar("progress_fail_detail", default=None)


def _exception_text(exc: BaseException) -> str | None:
    """The host's rule: a failed task's message carries the exception's own text."""
    return failure_text(exc).strip() or None


def current_progress() -> ProgressReporter:
    """Return the adapter-bound reporter, or NullProgress if unbound."""
    return _reporter_var.get() or NullProgress()


def current_progress_task() -> ProgressTask | None:
    """Innermost open ``ProgressTask``, if any."""
    return _task_var.get()


def resolve_progress(progress: ProgressReporter | None = None) -> ProgressReporter:
    """Prefer an explicit reporter, else the contextvar, else NullProgress."""
    if progress is not None:
        return progress
    return current_progress()


@contextmanager
def resolve_progress_task(
    task_id: str,
    label: str,
    *,
    total: int | None = None,
    prefer_parent: bool = False,
    progress: ProgressReporter | None = None,
) -> Iterator[ProgressTask]:
    """Open a nested progress handle, or reuse the parent when preferred.

    Always binds ``resolve_progress(progress)`` so callers can pass an explicit
    reporter without a surrounding ``bind_progress``.

    - With a parent and ``prefer_parent``: yield the parent (phases / messages /
      deltas on the wrap or leaf task — no orphan ``start``). Nested unit scales
      belong in children (``prefer_parent=False``).
    - With a parent otherwise: ``parent.child(task_id, …)``.
    - With no parent: ``progress_task(task_id, …)`` so standalone calls still emit.
    """
    with bind_progress(resolve_progress(progress)):
        parent = current_progress_task()
        if prefer_parent and parent is not None:
            if total is not None and parent.total is None:
                parent.total = total
                parent._reporter_now().update(
                    parent.task_id,
                    parent.current,
                    total=total,
                    phase=parent.phase,
                )
            prev_lock = parent._lock_total
            parent._lock_total = True
            try:
                yield parent
            finally:
                parent._lock_total = prev_lock
            return
        if parent is not None:
            with parent.child(task_id, label, total=total) as child:
                yield child
            return
        with progress_task(task_id, label, total=total) as task:
            yield task


@contextmanager
def bind_progress(reporter: ProgressReporter) -> Iterator[ProgressReporter]:
    token = _reporter_var.set(reporter)
    try:
        yield reporter
    finally:
        _reporter_var.reset(token)


class ProgressTask:
    """One progress row; use as a context manager.

    ``advance`` / ``advance_to`` coalesce to one update per
    ``PROGRESS_UPDATE_MIN_INTERVAL_SEC``. A throttled value is only sent by a flush
    (``set_phase`` / ``message`` / ``child`` / ``end`` via ``__exit__`` / ``fail`` /
    ``cancel``), so a task used outside ``with`` must still be closed or its last
    value is never reported. ``advance*`` is safe from several threads: counts and
    sends are serialized under a per-task lock.
    """

    def __init__(
        self,
        task_id: str,
        label: str,
        *,
        total: int | None = None,
        reporter: ProgressReporter | None = None,
        mark_id: str | None = None,
    ) -> None:
        self.task_id = task_id
        self.label = label
        self.total = total
        self.current = 0
        self.phase: str | None = None
        self._reporter = reporter
        self._mark_id = mark_id or task_id
        self._token: Token[ProgressReporter | None] | None = None
        self._compliance_token: Token[ComplianceBucket | None] | None = None
        self._task_token: Token[ProgressTask | None] | None = None
        self._bucket = ComplianceBucket(task_id=task_id, label=label)
        self._closed = False
        self._lock_total = False
        self._last_update_at: float | None = None
        self._pending_update = False
        self._pending_message: str | None = None
        # Reentrant: advance_to() holds the lock while calling advance(), which takes it again.
        self._update_lock = threading.RLock()
        # Captured here as well as read on exit, so a task built inside a guest call (a
        # ``child`` handed to a worker thread) keeps the guest rule wherever it ends.
        self._fail_detail = fail_detail_var.get()

    def __enter__(self) -> ProgressTask:
        mark_wrapped(self._mark_id)
        reporter = self._reporter or current_progress()
        if self._reporter is not None:
            self._token = _reporter_var.set(reporter)
        self._compliance_token = compliance_var.set(self._bucket)
        self._task_token = _task_var.set(self)
        reporter.start(self.task_id, self.label, total=self.total)
        return self

    def __exit__(
        self,
        _exc_type: type[BaseException] | None,
        exc: BaseException | None,
        _tb: TracebackType | None,
    ) -> bool | None:
        reporter = self._reporter or current_progress()
        if self._closed and self._bucket.cancelled:
            note_compliance(self._bucket)
            self._reset_tokens()
            # Already emitted cancel; do not emit fail. Let CancelledProgress propagate.
            return False
        if exc is None:
            if not self._closed:
                self._flush_update()
                reporter.end(self.task_id)
                self._bucket.ended = True
        elif isinstance(exc, CancelledProgress):
            if not self._closed:
                self._flush_update()
                reporter.cancel(self.task_id, message=str(exc) or "cancelled")
                self._bucket.cancelled = True
                self._closed = True
            note_compliance(self._bucket)
            self._reset_tokens()
            return False
        else:
            if not self._closed:
                self._flush_update()
                phase = self.phase
                msg = f"{self.label} failed"
                if phase:
                    msg = f"{self.label} failed while {phase}"
                detail = (self._fail_detail or fail_detail_var.get() or _exception_text)(exc)
                if detail:
                    msg = f"{msg}: {detail}"[:200]
                reporter.fail(self.task_id, message=msg, phase=phase)
                self._bucket.failed = True
                self._closed = True
            note_compliance(self._bucket)
            self._reset_tokens()
            return False
        self._closed = True
        note_compliance(self._bucket)
        self._reset_tokens()
        return None

    def _reset_tokens(self) -> None:
        if self._task_token is not None:
            _task_var.reset(self._task_token)
            self._task_token = None
        if self._compliance_token is not None:
            compliance_var.reset(self._compliance_token)
            self._compliance_token = None
        if self._token is not None:
            _reporter_var.reset(self._token)
            self._token = None

    def _reporter_now(self) -> ProgressReporter:
        return self._reporter or current_progress()

    def set_phase(self, phase_id: str, headline: str) -> None:
        self._flush_update()
        self.phase = phase_id
        self._bucket.had_phase = True
        self._bucket.had_message = True
        self._reporter_now().message(self.task_id, headline, phase=phase_id)

    def advance(
        self,
        amount: int = 1,
        *,
        message: str | None = None,
        total: int | None = None,
    ) -> None:
        self._bucket.had_update = True
        if message:
            self._bucket.had_message = True
        now = _update_clock()
        with self._update_lock:
            self.current += amount
            prev_total = self.total
            if total is not None and not self._lock_total:
                self.total = total
            if not self._update_due(now, total_changed=self.total != prev_total):
                self._pending_update = True
                # Latest non-None message wins, so a later None never clears a pending one
                # (most sinks keep the headline on None; MCP sinks fall back to the task label).
                if message is not None:
                    self._pending_message = message
                return
            self._mark_update_sent(now)
            # Sent under the lock so concurrent advances reach the reporter in order.
            self._send_update(message)

    def _update_due(self, now: float, *, total_changed: bool) -> bool:
        if self._last_update_at is None or total_changed:
            return True
        if self.total is not None and self.current >= self.total:
            return True
        return now - self._last_update_at >= PROGRESS_UPDATE_MIN_INTERVAL_SEC

    def _mark_update_sent(self, now: float) -> None:  # caller holds _update_lock
        self._last_update_at = now
        self._pending_update = False
        self._pending_message = None

    def _send_update(self, message: str | None) -> None:  # caller holds _update_lock
        self._reporter_now().update(
            self.task_id, self.current, total=self.total, message=message, phase=self.phase
        )

    def _flush_update(self) -> None:
        """Emit a coalesced update before phase / message / child / terminal events."""
        with self._update_lock:
            if not self._pending_update:
                return
            message = self._pending_message
            self._mark_update_sent(_update_clock())
            self._send_update(message)

    def advance_to(
        self,
        current: int,
        *,
        message: str | None = None,
        total: int | None = None,
    ) -> None:
        """Set ``current`` to an absolute count (no-op if already at or past it)."""
        with self._update_lock:
            delta = max(0, current - self.current)
            if delta == 0 and message is None and (total is None or total == self.total):
                return
            self.advance(delta, message=message, total=total)

    def message(self, text: str) -> None:
        self._flush_update()
        self._bucket.had_message = True
        self._reporter_now().message(self.task_id, text, phase=self.phase)

    def child(
        self,
        task_id: str,
        label: str,
        *,
        total: int | None = None,
    ) -> ProgressTask:
        self._flush_update()
        return ProgressTask(
            task_id,
            label,
            total=total,
            reporter=self._reporter_now(),
            mark_id=task_id,
        )

    def fail(self, message: str, *, phase: str | None = None) -> None:
        self._flush_update()
        self._bucket.failed = True
        self._closed = True
        self._reporter_now().fail(self.task_id, message=message, phase=phase or self.phase)

    def cancel(self, message: str = "cancelled") -> None:
        self._flush_update()
        self._bucket.cancelled = True
        self._closed = True
        self._reporter_now().cancel(self.task_id, message=message)


class CancelledProgress(Exception):
    """Raised (or caught) when cooperative cancel should end a progress_task."""


def raise_if_cancel_requested(
    cancel_check: Callable[[], bool] | None, message: str = "cancelled"
) -> None:
    """Raise ``CancelledProgress(message)`` once ``cancel_check()`` is true (cooperative cancel)."""
    if cancel_check is not None and cancel_check():
        raise CancelledProgress(message)


def progress_task(
    task_id: str,
    label: str,
    *,
    total: int | None = None,
    reporter: ProgressReporter | None = None,
    mark_id: str | None = None,
) -> ProgressTask:
    return ProgressTask(
        task_id,
        label,
        total=total,
        reporter=reporter,
        mark_id=mark_id,
    )
