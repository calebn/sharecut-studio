"""Background bootstrap jobs for Sharecut Studio first-run (progress via per-subscriber SSE fan-out)."""

from __future__ import annotations

import threading
import time
import uuid

from podcast_mcp.services.jobs import LIVE_JOB_STATUSES, TERMINAL_JOB_STATUSES, Job
from podcast_mcp.services.pipeline import run_bootstrap
from podcast_mcp.util.progress import ElapsedProgressMixin, ProgressEvent
from podcast_mcp.whisper_models import resolve_whisper_model


class _BootstrapProgressReporter(ElapsedProgressMixin):
    def __init__(self, job: Job) -> None:
        super().__init__()
        self._job = job

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        with self._job._lock:
            self._job.total = total
            self._job.current = 0
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
        with self._job._lock:
            self._job.current = current
            if total is not None:
                self._job.total = total
            if message is not None:
                self._job.message = message
        self._emit(
            ProgressEvent(
                kind="update",
                task_id=task_id,
                label=self._job.message or "",
                current=current,
                total=total if total is not None else self._job.total,
                message=message,
                phase=phase,
                elapsed_sec=0.0,
            )
        )

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        with self._job._lock:
            self._job.message = text
        self._emit(
            ProgressEvent(
                kind="message",
                task_id=task_id,
                label=text,
                current=self._job.current,
                total=self._job.total,
                message=text,
                phase=phase,
                elapsed_sec=0.0,
            )
        )

    def end(self, task_id: str, *, message: str | None = None) -> None:
        if message:
            with self._job._lock:
                self._job.message = message
        self._emit(
            ProgressEvent(
                kind="end",
                task_id=task_id,
                label=message or self._job.message or "",
                current=self._job.current,
                total=self._job.total,
                message=message,
                elapsed_sec=0.0,
            )
        )

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        with self._job._lock:
            if message is not None:
                self._job.message = message
                self._job.error = message
        self._emit(
            ProgressEvent(
                kind="fail",
                task_id=task_id,
                label=message or self._job.message or "",
                current=self._job.current,
                total=self._job.total,
                message=message,
                phase=phase,
                elapsed_sec=0.0,
            )
        )

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        with self._job._lock:
            if message is not None:
                self._job.message = message
        self._emit(
            ProgressEvent(
                kind="cancel",
                task_id=task_id,
                label=message or self._job.message or "",
                current=self._job.current,
                total=self._job.total,
                message=message,
                elapsed_sec=0.0,
            )
        )

    def _emit(self, event: ProgressEvent) -> None:
        payload = event.to_dict()
        payload["type"] = "progress"
        payload["job"] = self._job.snapshot()
        self._job.publish(payload)


class BootstrapJobManager:
    """At most one bootstrap job at a time (process-wide for the GUI)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._job: Job | None = None
        self._finished: dict[str, Job] = {}

    def get_job(self, job_id: str | None = None) -> Job | None:
        with self._lock:
            if job_id is None:
                return self._job
            if self._job is not None and self._job.id == job_id:
                return self._job
            return self._finished.get(job_id)

    def start(
        self,
        *,
        components: list[str] | None = None,
        whisper_model: str | None = None,
        force: bool = False,
    ) -> Job:
        model = resolve_whisper_model(requested=whisper_model)
        with self._lock:
            if self._job is not None and self._job.status in LIVE_JOB_STATUSES:
                running = ", ".join(self._job.components) or "setup"
                raise RuntimeError(
                    f"Another download is already running ({running}); try again when it finishes"
                )
            if self._job is not None and self._job.status in TERMINAL_JOB_STATUSES:
                self._finished[self._job.id] = self._job
            job = Job.bootstrap(
                uuid.uuid4().hex[:12],
                list(components) if components else [],
                whisper_model=model,
                force=force,
            )
            self._job = job

        thread = threading.Thread(
            target=self._run_job,
            args=(job,),
            daemon=True,
            name=f"bootstrap-job-{job.id}",
        )
        thread.start()
        return job

    def cancel(self, job_id: str | None = None) -> Job | None:
        with self._lock:
            job = self._job
            if job is None:
                return None
            if job_id is not None and job.id != job_id:
                return None
            if job.status not in LIVE_JOB_STATUSES:
                return job
            job.cancel_requested = True
            job.message = "Cancel requested…"
            return job

    def _run_job(self, job: Job) -> None:
        job.status = "running"
        job.started_at = time.monotonic()
        job.publish({"type": "status", "job": job.snapshot()})
        reporter = _BootstrapProgressReporter(job)
        try:
            if job.cancel_requested:
                raise RuntimeError("cancelled")
            result = run_bootstrap(
                job.components or None,
                whisper_model=job.whisper_model,
                force=job.force,
                progress=reporter,
            )
            with job._lock:
                if job.cancel_requested:
                    job.status = "cancelled"
                    job.message = "Bootstrap cancelled"
                elif not result.get("ok", False):
                    job.status = "error"
                    failed = [
                        f"{name}: {info.get('error')}"
                        for name, info in (result.get("results") or {}).items()
                        if isinstance(info, dict) and not info.get("ok", True)
                    ]
                    job.error = "; ".join(failed) or "Bootstrap failed"
                    job.message = job.error
                else:
                    job.status = "ok"
                    job.message = "Bootstrap complete"
                job.result = result
                job.finished_at = time.monotonic()
        except Exception as exc:
            with job._lock:
                job.status = "cancelled" if job.cancel_requested else "error"
                job.error = str(exc)
                job.message = str(exc)
                job.finished_at = time.monotonic()
        job.publish({"type": "done", "job": job.snapshot()})


_SHARED: BootstrapJobManager | None = None
_SHARED_LOCK = threading.Lock()


def shared_bootstrap_job_manager(*, reset: bool = False) -> BootstrapJobManager:
    global _SHARED
    with _SHARED_LOCK:
        if reset or _SHARED is None:
            _SHARED = BootstrapJobManager()
        return _SHARED
