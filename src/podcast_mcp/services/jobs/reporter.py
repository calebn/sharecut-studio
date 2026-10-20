"""Progress reporters that feed Studio jobs: field updates, SSE fan-out, agent fan-in."""

from __future__ import annotations

import threading
import time
import uuid
from typing import TYPE_CHECKING, Any

from podcast_mcp.services.jobs.job import KIND_META, Job, StepTiming, short_fail_message
from podcast_mcp.util.progress import PROGRESS_LAZY_CHIP_SEC, ElapsedProgressMixin, ProgressEvent

if TYPE_CHECKING:
    from podcast_mcp.services.jobs.manager import JobManager

_PIPELINE_OWNED_WRAPS = frozenset({"pipeline_run"})
_DOMAIN_PROGRESS_KINDS = frozenset({"start", "update", "message", "heartbeat"})


class JobProgressReporter(ElapsedProgressMixin):
    """ProgressReporter that updates a Job and fans out SSE events."""

    def __init__(self, job: Job) -> None:
        self._job = job
        self._closed = False
        super().__init__(heartbeat_sec=5.0)

    def close(self) -> None:
        self._closed = True
        super().close()

    def _owns_units(self, task_id: str) -> bool:
        return self._job.owns_task(task_id)

    def _event_label(self) -> str:
        if self._job.kind == "agent":
            return self._job.label or "Activity"
        meta = KIND_META.get(self._job.kind)
        return meta.event_label if meta is not None else "Pipeline"

    def _ensure_task(
        self,
        task_id: str,
        current: int,
        total: int | None = None,
        phase: str | None = None,
    ) -> None:
        if self._touch_task(task_id, current, total, phase=phase) is None:
            self._register_task(
                task_id,
                self._event_label(),
                total if total is not None else self._job.total,
            )
            self._touch_task(task_id, current, total, phase=phase)

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        if self._closed:
            return
        self._register_task(task_id, label, total)
        with self._job._lock:
            if self._owns_units(task_id) or (self._job.kind != "agent" and self._job.total is None):
                self._job.total = total
                self._job.current = 0
            if self._job.kind != "agent" or self._owns_units(task_id):
                self._job.message = label
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
        if self._closed:
            return
        now = time.monotonic()
        self._ensure_task(task_id, current, total, phase=phase)
        with self._job._lock:
            if self._owns_units(task_id):
                self._job.current = current
                if total is not None:
                    self._job.total = total
            if message is not None:
                self._job.message = message
            if message and message.startswith("Completed ") and self._job.steps:
                last = self._job.steps[-1]
                if last.status == "running":
                    last.finished_at = now
                    last.status = "ok"
                # "Completed {name}: {summary}" from PipelineRunner
                completed = message.removeprefix("Completed ").strip()
                if ": " in completed:
                    step_name, summary = completed.split(": ", 1)
                    if last.name == step_name and summary:
                        last.summary = summary
            elapsed = self._elapsed(now)
        self._emit(
            ProgressEvent(
                kind="update",
                task_id=task_id,
                label=self._event_label(),
                current=current,
                total=total if total is not None else self._job.total,
                elapsed_sec=elapsed,
                message=message,
                phase=phase,
            )
        )

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        if self._closed:
            return
        now = time.monotonic()
        current = self._job.current if self._job.current is not None else 0
        self._ensure_task(task_id, current, phase=phase)
        with self._job._lock:
            self._job.message = text
            if text.startswith("Running "):
                step_name = text.removeprefix("Running ").strip()
                self._job.steps.append(StepTiming(name=step_name, started_at=now, status="running"))
            elapsed = self._elapsed(now)
        self._emit(
            ProgressEvent(
                kind="message",
                task_id=task_id,
                label=self._event_label(),
                current=self._job.current,
                total=self._job.total,
                elapsed_sec=elapsed,
                message=text,
                phase=phase,
            )
        )

    def end(self, task_id: str, *, message: str | None = None) -> None:
        if self._closed:
            return
        now = time.monotonic()
        with self._job._lock:
            if message is not None:
                self._job.message = message
            if self._job.kind == "agent" and self._owns_units(task_id):
                self._job.status = "ok"
            elapsed = self._elapsed(now)
        self._emit(
            ProgressEvent(
                kind="end",
                task_id=task_id,
                label=self._event_label(),
                current=self._job.current,
                total=self._job.total,
                elapsed_sec=elapsed,
                message=message,
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
        if self._closed:
            return
        now = time.monotonic()
        short = short_fail_message(message, phase)
        owns = self._owns_units(task_id)
        with self._job._lock:
            if short is not None and owns:
                self._job.message = short
                self._job.error = short
            if self._job.kind == "agent" and owns:
                self._job.status = "error"
            if owns and self._job.steps and self._job.steps[-1].status == "running":
                self._job.steps[-1].status = "error"
                self._job.steps[-1].error = short
                self._job.steps[-1].finished_at = now
            elapsed = self._elapsed(now)
        self._emit(
            ProgressEvent(
                kind="fail",
                task_id=task_id,
                label=self._event_label(),
                current=self._job.current,
                total=self._job.total,
                elapsed_sec=elapsed,
                message=short,
                phase=phase,
            )
        )
        self._finish_task(task_id)

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        if self._closed:
            return
        now = time.monotonic()
        with self._job._lock:
            if message is not None:
                self._job.message = message
            if self._job.kind == "agent" and self._owns_units(task_id):
                self._job.status = "cancelled"
            elapsed = self._elapsed(now)
        self._emit(
            ProgressEvent(
                kind="cancel",
                task_id=task_id,
                label=self._event_label(),
                current=self._job.current,
                total=self._job.total,
                elapsed_sec=elapsed,
                message=message,
            )
        )
        self._finish_task(task_id)

    def heartbeat(self, task_id: str, *, message: str | None = None) -> None:
        if self._closed:
            return
        now = time.monotonic()
        current = self._job.current if self._job.current is not None else 0
        if self._touch_task(task_id, current) is None:
            return
        with self._job._lock:
            if message is not None:
                self._job.message = message
            elapsed = self._elapsed(now)
        self._emit(
            ProgressEvent(
                kind="heartbeat",
                task_id=task_id,
                label=self._event_label(),
                current=self._job.current,
                total=self._job.total,
                elapsed_sec=elapsed,
                message=message,
            )
        )

    def _emit_heartbeat(self, task_id: str, state: Any, elapsed_sec: float) -> None:
        _ = (state, elapsed_sec)
        self.heartbeat(task_id)

    def _elapsed(self, now: float) -> float:
        if self._job.started_at is None:
            return 0.0
        return max(0.0, now - self._job.started_at)

    def _emit(self, event: ProgressEvent) -> None:
        if self._closed:
            return
        if event.kind in _DOMAIN_PROGRESS_KINDS:
            with self._job._lock:
                self._job.last_progress_at = time.time()
        payload = event.to_dict()
        payload["type"] = "progress"
        payload["job"] = self._job.snapshot()
        self._job.publish(payload)


class SsePublishReporter(ElapsedProgressMixin):
    """Fan-out only: enqueue SSE progress events; never mutate job fields."""

    def __init__(self, manager: JobManager) -> None:
        super().__init__()
        self._manager = manager

    def _live_job(self, task_id: str) -> Job | None:
        """Return the live job that owns this wrap's ``task_id``, if any."""
        return self._manager.listening_job(task_id)

    def _publish(
        self,
        *,
        kind: str,
        task_id: str,
        label: str,
        current: int | None,
        total: int | None,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        job = self._live_job(task_id)
        if job is None:
            return
        elapsed = 0.0
        if job.started_at is not None:
            elapsed = max(0.0, time.monotonic() - job.started_at)
        payload = ProgressEvent(
            kind=kind,
            task_id=task_id,
            label=label,
            current=current,
            total=total,
            elapsed_sec=elapsed,
            message=message,
            phase=phase,
        ).to_dict()
        payload["type"] = "progress"
        payload["job"] = job.snapshot()
        job.publish(payload)

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        self._publish(
            kind="start",
            task_id=task_id,
            label=label,
            current=0,
            total=total,
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
        self._publish(
            kind="update",
            task_id=task_id,
            label=task_id,
            current=current,
            total=total,
            message=message,
            phase=phase,
        )

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        self._publish(
            kind="message",
            task_id=task_id,
            label=task_id,
            current=None,
            total=None,
            message=text,
            phase=phase,
        )

    def end(self, task_id: str, *, message: str | None = None) -> None:
        self._publish(
            kind="end",
            task_id=task_id,
            label=task_id,
            current=None,
            total=None,
            message=message,
        )

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        self._publish(
            kind="fail",
            task_id=task_id,
            label=task_id,
            current=None,
            total=None,
            message=message,
            phase=phase,
        )

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        self._publish(
            kind="cancel",
            task_id=task_id,
            label=task_id,
            current=None,
            total=None,
            message=message,
        )


class AgentJobFanInReporter(ElapsedProgressMixin):
    """Lazily create a Studio ``kind=agent`` job from wrap-level progress.

    Instant tools (start then end with no intra-op events and elapsed < 1s)
    never create a job. The first ``update`` / ``message`` (incl. phase) or
    the 1s timer creates one. Wrap ``end`` / ``fail`` / ``cancel`` finalize.
    """

    LAZY_AFTER_SEC = PROGRESS_LAZY_CHIP_SEC

    def __init__(self, manager: JobManager) -> None:
        super().__init__()
        self._manager = manager
        self._state_lock = threading.Lock()
        self._claim = uuid.uuid4().hex
        self._wrap_task_id: str | None = None
        self._wrap_label = ""
        self._closed = False
        self._job: Job | None = None
        self._job_reporter: JobProgressReporter | None = None
        self._timer: threading.Timer | None = None
        self._current: int | None = None
        self._total: int | None = None
        self._message: str | None = None
        self._terminal: tuple[str, str | None, str | None] | None = None

    def _stop_timer_locked(self) -> None:
        timer = self._timer
        self._timer = None
        if timer is not None:
            timer.cancel()

    def _arm_timer_locked(self) -> None:
        self._stop_timer_locked()
        timer = threading.Timer(self.LAZY_AFTER_SEC, self._on_lazy_timer)
        timer.daemon = True
        self._timer = timer
        timer.start()

    def _on_lazy_timer(self) -> None:
        task_id = self._wrap_task_id
        if task_id is None:
            return
        self.heartbeat(task_id)

    def _ensure_job(self) -> Job | None:
        with self._state_lock:
            if self._closed or self._wrap_task_id is None:
                return None
            if self._wrap_task_id in _PIPELINE_OWNED_WRAPS:
                return None
            if self._job is not None:
                return self._job
            tool_id = self._wrap_task_id
            label = self._wrap_label
            claim = self._claim
            current = self._current
            total = self._total
            message = self._message
        job: Job | None = None
        owned = False
        extra: Job | None = None
        extra_reporter: JobProgressReporter | None = None
        try:
            job = self._manager.adopt_agent_job(
                tool_id=tool_id,
                label=label,
                claim=claim,
            )
            reporter = JobProgressReporter(job)
            reporter._register_task(tool_id, label, total)
            with job._lock:
                if current is not None:
                    job.current = current
                if total is not None:
                    job.total = total
                if message:
                    job.message = message
            with self._state_lock:
                if self._job is not None:
                    if self._job is not job:
                        extra = job
                        extra_reporter = reporter
                    closed = self._closed
                    terminal = self._terminal
                    result = self._job
                else:
                    self._job = job
                    self._job_reporter = reporter
                    owned = True
                    closed = self._closed
                    terminal = self._terminal
                    result = job
            if extra is not None:
                if extra_reporter is not None:
                    extra_reporter.close()
                self._manager.complete_agent_job(
                    extra,
                    status="cancelled",
                    message=None,
                    error=None,
                )
            if closed:
                status, msg, err = terminal or ("cancelled", None, None)
                try:
                    reporter.close()
                    self._manager.complete_agent_job(
                        result,
                        status=status,
                        message=msg,
                        error=err,
                    )
                finally:
                    reporter.close()
                    with self._state_lock:
                        if self._job_reporter is reporter:
                            self._job_reporter = None
            return result
        except Exception:
            if job is not None and not owned:
                self._manager.complete_agent_job(
                    job,
                    status="cancelled",
                    message=None,
                    error=None,
                )
            raise

    def _reporter_if_open(self) -> JobProgressReporter | None:
        with self._state_lock:
            if self._closed:
                return None
            return self._job_reporter

    def _is_wrap(self, task_id: str) -> bool:
        return self._wrap_task_id is not None and task_id == self._wrap_task_id

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        reporter: JobProgressReporter | None
        with self._state_lock:
            if self._closed:
                return
            if self._wrap_task_id is None:
                self._wrap_task_id = task_id
                self._wrap_label = label
                self._total = total
                if task_id not in _PIPELINE_OWNED_WRAPS:
                    self._arm_timer_locked()
            reporter = self._job_reporter
        if reporter is not None:
            reporter.start(task_id, label, total=total)

    def update(
        self,
        task_id: str,
        current: int,
        *,
        total: int | None = None,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        with self._state_lock:
            self._current = current
            if total is not None:
                self._total = total
            if message is not None:
                self._message = message
        job = self._ensure_job()
        reporter = self._reporter_if_open() if job is not None else None
        if reporter is not None:
            reporter.update(
                task_id,
                current,
                total=total,
                message=message,
                phase=phase,
            )

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        with self._state_lock:
            self._message = text
        job = self._ensure_job()
        reporter = self._reporter_if_open() if job is not None else None
        if reporter is not None:
            reporter.message(task_id, text, phase=phase)

    def heartbeat(self, task_id: str, *, message: str | None = None) -> None:
        """Honest still-alive tick — creates the lazy job if needed."""
        if message is not None:
            with self._state_lock:
                self._message = message
        job = self._ensure_job()
        reporter = self._reporter_if_open() if job is not None else None
        if reporter is None:
            return
        if message is not None:
            reporter.message(task_id, message)
        else:
            reporter.heartbeat(task_id)

    def _finalize_wrap(self, status: str, message: str | None, error: str | None) -> None:
        with self._state_lock:
            self._closed = True
            self._terminal = (status, message, error)
            self._stop_timer_locked()
            job = self._job
            reporter = self._job_reporter
            self._job_reporter = None
        try:
            if reporter is not None:
                reporter.close()
            if job is not None:
                self._manager.complete_agent_job(
                    job,
                    status=status,
                    message=message,
                    error=error,
                )
        finally:
            if reporter is not None:
                reporter.close()

    def end(self, task_id: str, *, message: str | None = None) -> None:
        reporter = self._reporter_if_open()
        if not self._is_wrap(task_id):
            if reporter is not None:
                reporter.end(task_id, message=message)
            return
        if reporter is not None:
            reporter.end(task_id, message=message)
        self._finalize_wrap("ok", message, None)

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        short = short_fail_message(message, phase)
        reporter = self._reporter_if_open()
        if not self._is_wrap(task_id):
            if reporter is not None:
                reporter.fail(task_id, message=short, phase=phase)
            return
        if reporter is not None:
            reporter.fail(task_id, message=short, phase=phase)
        self._finalize_wrap("error", short, short)

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        reporter = self._reporter_if_open()
        if not self._is_wrap(task_id):
            if reporter is not None:
                reporter.cancel(task_id, message=message)
            return
        if reporter is not None:
            reporter.cancel(task_id, message=message)
        self._finalize_wrap("cancelled", message, None)
