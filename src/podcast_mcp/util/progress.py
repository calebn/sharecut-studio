from __future__ import annotations

import asyncio
import functools
import json
import sys
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager, suppress
from contextvars import ContextVar, Token
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Protocol, TextIO, TypeVar, runtime_checkable

F = TypeVar("F", bound=Callable[..., Any])

PROGRESS_LAZY_CHIP_SEC = 1.0
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


_reporter_var: ContextVar[ProgressReporter | None] = ContextVar(
    "podcast_progress_reporter", default=None
)
_compliance_var: ContextVar[_ComplianceBucket | None] = ContextVar(
    "podcast_progress_compliance", default=None
)
_task_var: ContextVar[ProgressTask | None] = ContextVar("podcast_progress_task", default=None)

# Operation ids that passed through a choke-point wrap (MCP/CLI/guest/pipeline).
_WRAPPED_IDS: set[str] = set()
_WRAPPED_LOCK = threading.Lock()


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


@dataclass
class _ComplianceBucket:
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
_COMPLIANCE_LOG_MAX = 512


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


def _note_compliance(bucket: _ComplianceBucket) -> None:
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
        overflow = len(_COMPLIANCE_LOG) - _COMPLIANCE_LOG_MAX
        if overflow > 0:
            del _COMPLIANCE_LOG[:overflow]


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


def _mcp_progress_token(context: Any) -> Any:
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
    if _mcp_progress_token(context) is None:
        return None
    if isinstance(context, ProgressReporter):
        return context
    if not hasattr(context, "report_progress"):
        return None
    return McpNotificationProgress(context)


class McpNotificationProgress:
    """Best-effort MCP ``notifications/progress`` bridge (async Context)."""

    def __init__(self, context: Any) -> None:
        self._context = context
        self._current = 0.0
        self._total: float | None = None
        self._label = ""
        self._pending_task: Any = None

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
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
        done = self._total if self._total is not None else self._current
        self._schedule(done, self._total, message or "done")

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
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


def current_progress() -> ProgressReporter:
    """Return the adapter-bound reporter, or NullProgress if unbound."""
    return _reporter_var.get() or NullProgress()


def current_progress_task_id() -> str | None:
    """Active ``progress_task`` id from the compliance contextvar, if any."""
    bucket = _compliance_var.get()
    return bucket.task_id if bucket is not None else None


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
    """Domain-facing progress handle (context manager)."""

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
        self._compliance_token: Token[_ComplianceBucket | None] | None = None
        self._task_token: Token[ProgressTask | None] | None = None
        self._bucket = _ComplianceBucket(task_id=task_id, label=label)
        self._closed = False
        self._lock_total = False

    def __enter__(self) -> ProgressTask:
        mark_wrapped(self._mark_id)
        reporter = self._reporter or current_progress()
        if self._reporter is not None:
            self._token = _reporter_var.set(reporter)
        self._compliance_token = _compliance_var.set(self._bucket)
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
            _note_compliance(self._bucket)
            self._reset_tokens()
            # Already emitted cancel; do not emit fail. Let CancelledProgress propagate.
            return False
        if exc is None:
            if not self._closed:
                reporter.end(self.task_id)
                self._bucket.ended = True
        elif isinstance(exc, CancelledProgress):
            if not self._closed:
                reporter.cancel(self.task_id, message=str(exc) or "cancelled")
                self._bucket.cancelled = True
                self._closed = True
            _note_compliance(self._bucket)
            self._reset_tokens()
            return False
        else:
            if not self._closed:
                phase = self.phase
                msg = f"{self.label} failed"
                if phase:
                    msg = f"{self.label} failed while {phase}"
                detail = str(exc).strip()
                if detail:
                    msg = f"{msg}: {detail}"[:200]
                reporter.fail(self.task_id, message=msg, phase=phase)
                self._bucket.failed = True
                self._closed = True
            _note_compliance(self._bucket)
            self._reset_tokens()
            return False
        self._closed = True
        _note_compliance(self._bucket)
        self._reset_tokens()
        return None

    def _reset_tokens(self) -> None:
        if self._task_token is not None:
            _task_var.reset(self._task_token)
            self._task_token = None
        if self._compliance_token is not None:
            _compliance_var.reset(self._compliance_token)
            self._compliance_token = None
        if self._token is not None:
            _reporter_var.reset(self._token)
            self._token = None

    def _reporter_now(self) -> ProgressReporter:
        return self._reporter or current_progress()

    def set_phase(self, phase_id: str, headline: str) -> None:
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
        self.current += amount
        if total is not None and not self._lock_total:
            self.total = total
        self._bucket.had_update = True
        if message:
            self._bucket.had_message = True
        self._reporter_now().update(
            self.task_id,
            self.current,
            total=self.total,
            message=message,
            phase=self.phase,
        )

    def advance_to(
        self,
        current: int,
        *,
        message: str | None = None,
        total: int | None = None,
    ) -> None:
        """Set ``current`` to an absolute count (no-op if already at or past it)."""
        delta = max(0, current - self.current)
        if delta == 0 and message is None and (total is None or total == self.total):
            return
        self.advance(delta, message=message, total=total)

    def message(self, text: str) -> None:
        self._bucket.had_message = True
        self._reporter_now().message(self.task_id, text, phase=self.phase)

    def child(
        self,
        task_id: str,
        label: str,
        *,
        total: int | None = None,
    ) -> ProgressTask:
        return ProgressTask(
            task_id,
            label,
            total=total,
            reporter=self._reporter_now(),
            mark_id=task_id,
        )

    def fail(self, message: str, *, phase: str | None = None) -> None:
        self._bucket.failed = True
        self._closed = True
        self._reporter_now().fail(self.task_id, message=message, phase=phase or self.phase)

    def cancel(self, message: str = "cancelled") -> None:
        self._bucket.cancelled = True
        self._closed = True
        self._reporter_now().cancel(self.task_id, message=message)


class CancelledProgress(Exception):
    """Raised (or caught) when cooperative cancel should end a progress_task."""


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


def wrap_operation(
    operation_id: str,
    label: str | None = None,
    *,
    total: int | None = None,
) -> Callable[[F], F]:
    """Decorator: open a progress_task around a callable (CLI/MCP/guest)."""

    def decorator(fn: F) -> F:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            with progress_task(
                operation_id,
                label or operation_id,
                total=total,
                mark_id=operation_id,
            ):
                return fn(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator


class _TaskState:
    __slots__ = ("current", "label", "last_emit", "phase", "started_at", "total")

    def __init__(self, label: str, total: int | None) -> None:
        self.label = label
        self.total = total
        self.current = 0
        self.phase: str | None = None
        self.started_at = time.monotonic()
        self.last_emit = self.started_at


class ElapsedProgressMixin:
    """Emit elapsed time on stderr when updates stall."""

    def __init__(self, *, heartbeat_sec: float = 5.0) -> None:
        self._heartbeat_sec = heartbeat_sec
        self._tasks: dict[str, _TaskState] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self._thread.start()

    def _register_task(self, task_id: str, label: str, total: int | None) -> None:
        with self._lock:
            self._tasks[task_id] = _TaskState(label, total)

    def _touch_task(
        self,
        task_id: str,
        current: int,
        total: int | None = None,
        phase: str | None = None,
    ) -> _TaskState | None:
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
                stale = [
                    (tid, st)
                    for tid, st in self._tasks.items()
                    if now - st.last_emit >= self._heartbeat_sec
                ]
            for tid, st in stale:
                elapsed = now - st.started_at
                self._emit_heartbeat(tid, st, elapsed)
                with self._lock:
                    if tid in self._tasks:
                        self._tasks[tid].last_emit = now

    def _emit_heartbeat(self, task_id: str, state: _TaskState, elapsed_sec: float) -> None:
        pass  # pragma: no cover - base class; reporters override


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
            if state is not None and phase is not None:
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

    def _emit_heartbeat(self, task_id: str, state: _TaskState, elapsed_sec: float) -> None:
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
    def __init__(self, *, enabled: bool = True) -> None:
        super().__init__()
        self._enabled = enabled
        self._rich = None
        self._progress = None
        self._bars: dict[str, Any] = {}
        if enabled and sys.stderr.isatty():
            try:
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
                    console=None,
                    transient=False,
                )
                self._progress.start()
            except ImportError:
                self._rich = False

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        self._register_task(task_id, label, total)
        if not self._enabled:
            return
        if self._progress is not None:
            bar = self._progress.add_task(label, total=total or 0)
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
        if self._progress is not None and task_id in self._bars:
            kwargs: dict[str, Any] = {"completed": current}
            if total is not None:
                kwargs["total"] = total
            if message:
                kwargs["description"] = message
            self._progress.update(self._bars[task_id], **kwargs)

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
            if state is not None and phase is not None:
                state.phase = phase
                state.last_emit = time.monotonic()
        if self._enabled:
            sys.stderr.write(f"{text}\n")
            sys.stderr.flush()

    def end(self, task_id: str, *, message: str | None = None) -> None:
        with self._lock:
            state = self._tasks.get(task_id)
        if self._progress is not None and task_id in self._bars:
            if state and state.total:
                self._progress.update(self._bars[task_id], completed=state.total)
            self._progress.remove_task(self._bars.pop(task_id))
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
        if self._progress is not None and task_id in self._bars:
            self._progress.remove_task(self._bars.pop(task_id))
        if self._enabled:
            sys.stderr.write(f"{message or 'failed'}\n")
            sys.stderr.flush()
        self._finish_task(task_id)

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        if self._progress is not None and task_id in self._bars:
            self._progress.remove_task(self._bars.pop(task_id))
        if self._enabled:
            sys.stderr.write(f"{message or 'cancelled'}\n")
            sys.stderr.flush()
        self._finish_task(task_id)

    def _emit_heartbeat(self, task_id: str, state: _TaskState, elapsed_sec: float) -> None:
        if not self._enabled:
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


def make_progress_reporter(
    *,
    enabled: bool = True,
    json_mode: bool = False,
) -> ProgressReporter:
    sink = cli_progress_sink(enabled=enabled, json_mode=json_mode)
    return sink if sink is not None else NullProgress()


def default_progress_enabled() -> bool:
    import os

    return os.environ.get("PODCAST_PROGRESS", "1") not in ("0", "false", "no")


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

    original_call_tool = server.call_tool

    async def call_tool(
        name: str,
        arguments: dict[str, Any],
        context: Any = None,
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        reporter = compose_progress(
            mcp_progress_sink(context),
            *adapter_progress_sinks(),
        )
        with bind_progress(reporter), progress_task(name, name, reporter=reporter, mark_id=name):
            return await original_call_tool(name, arguments, context, *args, **kwargs)

    server.add_tool = add_tool  # type: ignore[method-assign]
    server.call_tool = call_tool  # type: ignore[method-assign]
    server._podcast_progress_installed = True


def install_cli_progress(app: Any) -> None:
    """Wrap Typer command callbacks so every CLI command opens progress_task."""

    def _wrap_callback(callback: Callable[..., Any], op_id: str) -> Callable[..., Any]:
        if getattr(callback, "_podcast_progress_wrapped", False):
            return callback

        @functools.wraps(callback)
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            from podcast_mcp.cli.context import get_progress

            reporter = compose_progress(get_progress(), *adapter_progress_sinks())
            with (
                bind_progress(reporter),
                progress_task(op_id, op_id, reporter=reporter, mark_id=op_id),
            ):
                return callback(*args, **kwargs)

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


def install_guest_tool_progress(call_tool_fn: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap guest remote MCP ``call_tool`` so handlers see a bound reporter."""

    @functools.wraps(call_tool_fn)
    def wrapped(name: str, arguments: dict[str, Any] | None = None) -> Any:
        token = _guest_share_token.get()
        extras = [mcp_progress_sink(_guest_mcp_context.get()), *guest_progress_sinks(token)]
        reporter = compose_progress(*extras)
        try:
            with (
                bind_progress(reporter),
                progress_task(name, name, reporter=reporter, mark_id=name),
            ):
                return call_tool_fn(name, arguments)
        finally:
            for sink in extras:
                closer = getattr(sink, "close", None)
                if callable(closer):
                    closer()

    return wrapped
