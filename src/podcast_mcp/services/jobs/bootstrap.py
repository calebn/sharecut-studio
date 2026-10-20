"""First-run bootstrap jobs: at most one download job at a time, process-wide for the GUI."""

from __future__ import annotations

import threading
import time
import uuid

from podcast_mcp.services.jobs.events import LIVE_JOB_STATUSES, TERMINAL_JOB_STATUSES
from podcast_mcp.services.jobs.job import Job
from podcast_mcp.services.jobs.reporter import BootstrapProgressReporter
from podcast_mcp.services.pipeline import run_bootstrap
from podcast_mcp.whisper_models import resolve_whisper_model


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
        reporter = BootstrapProgressReporter(job)
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
