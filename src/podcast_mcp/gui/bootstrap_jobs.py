"""Background bootstrap jobs for Sharecut Studio first-run (progress via queue → SSE)."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from queue import Queue
from typing import Any

from podcast_mcp.services.bootstrap import run_bootstrap
from podcast_mcp.util.progress import ProgressEvent
from podcast_mcp.whisper_models import DEFAULT_WHISPER_MODEL, resolve_whisper_model


@dataclass
class BootstrapJob:
    id: str
    components: list[str]
    whisper_model: str = DEFAULT_WHISPER_MODEL
    force: bool = False
    status: str = "queued"  # queued | running | ok | error | cancelled
    started_at: float | None = None
    finished_at: float | None = None
    error: str | None = None
    current: int | None = None
    total: int | None = None
    message: str | None = None
    result: dict[str, Any] | None = None
    cancel_requested: bool = False
    events: Queue[dict[str, Any] | None] = field(default_factory=Queue)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            elapsed = 0.0
            if self.started_at is not None:
                end = self.finished_at if self.finished_at is not None else time.monotonic()
                elapsed = max(0.0, end - self.started_at)
            return {
                "id": self.id,
                "kind": "bootstrap",
                "components": list(self.components),
                "whisper_model": self.whisper_model,
                "status": self.status,
                "current": self.current,
                "total": self.total,
                "message": self.message,
                "error": self.error,
                "elapsed_sec": round(elapsed, 2),
                "result": self.result,
            }

    def publish(self, event: dict[str, Any]) -> None:
        self.events.put(event)

    def close_stream(self) -> None:
        self.events.put(None)


class _BootstrapProgressReporter:
    def __init__(self, job: BootstrapJob) -> None:
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
        self._job: BootstrapJob | None = None
        self._finished: dict[str, BootstrapJob] = {}

    def get_job(self, job_id: str | None = None) -> BootstrapJob | None:
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
    ) -> BootstrapJob:
        model = resolve_whisper_model(requested=whisper_model)
        with self._lock:
            if self._job is not None and self._job.status in ("queued", "running"):
                raise RuntimeError("A bootstrap job is already running")
            if self._job is not None and self._job.status in ("ok", "error", "cancelled"):
                self._finished[self._job.id] = self._job
            job = BootstrapJob(
                id=uuid.uuid4().hex[:12],
                components=list(components) if components else [],
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

    def cancel(self, job_id: str | None = None) -> BootstrapJob | None:
        with self._lock:
            job = self._job
            if job is None:
                return None
            if job_id is not None and job.id != job_id:
                return None
            if job.status not in ("queued", "running"):
                return job
            job.cancel_requested = True
            job.message = "Cancel requested…"
            return job

    def _run_job(self, job: BootstrapJob) -> None:
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
        job.close_stream()


_SHARED: BootstrapJobManager | None = None
_SHARED_LOCK = threading.Lock()


def shared_bootstrap_job_manager(*, reset: bool = False) -> BootstrapJobManager:
    global _SHARED
    with _SHARED_LOCK:
        if reset or _SHARED is None:
            _SHARED = BootstrapJobManager()
        return _SHARED
