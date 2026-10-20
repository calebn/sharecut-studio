"""Job identity and bounded history: the pipeline slot, live agent jobs and finished lookups."""

from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from typing import Any

from podcast_mcp.services.jobs.events import LIVE_JOB_STATUSES
from podcast_mcp.services.jobs.job import Job

_AGENT_LIVE_LIMIT = 8


class JobCatalog:
    """Owns job identity and bounded history.

    Caller-held lock methods are suffixed ``_locked`` or documented at the method.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._job: Job | None = None
        self._finished: dict[str, Job] = {}
        self._finished_order: list[str] = []
        self._finished_limit = 8
        self._agent_live_limit = _AGENT_LIVE_LIMIT
        self._agent_live: dict[str, Job] = {}
        self._agent_claims: dict[str, Job] = {}
        self._agent_latest: Job | None = None
        self._served_project: str | None = None
        # The download slot is independent of the pipeline slot: neither blocks the other.
        self._bootstrap_job: Job | None = None
        self._bootstrap_finished: dict[str, Job] = {}

    def set_served_project(self, project_path: Path | str | None) -> None:
        """Set the project identity used by standalone agent-progress wraps."""
        with self._lock:
            self._served_project = (
                str(Path(project_path).expanduser().resolve()) if project_path is not None else None
            )

    def _running_jobs_locked(self) -> list[Job]:
        running: list[Job] = []
        if self._job is not None and self._job.status in LIVE_JOB_STATUSES:
            running.append(self._job)
        running.extend(job for job in self._agent_live.values() if job.status in LIVE_JOB_STATUSES)
        return running

    def _visible_jobs_locked(self) -> list[Job]:
        seen: dict[str, Job] = {}
        if self._job is not None:
            seen[self._job.id] = self._job
        for job in self._agent_live.values():
            seen[job.id] = job
        if self._agent_latest is not None:
            seen.setdefault(self._agent_latest.id, self._agent_latest)
        # Recent archives so status poll can resolve a job after a successor
        # replaced ``_job`` (waitForPipelineJob / followExportJob).
        for job_id in reversed(self._finished_order):
            archived = self._finished.get(job_id)
            if archived is not None:
                seen.setdefault(archived.id, archived)
        return list(seen.values())

    def _primary_job_locked(self, scope: str | None = None) -> Job | None:
        running = [
            job for job in self._running_jobs_locked() if scope is None or job.project_path == scope
        ]
        if running:
            return max(running, key=lambda job: job.started_at or 0.0)
        candidates = [
            job
            for job in (self._job, self._agent_latest)
            if job is not None and (scope is None or job.project_path == scope)
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda job: job.started_at or 0.0)

    def status(self, project_path: str | None = None) -> dict[str, Any]:
        """Snapshot of pipeline/activity jobs, optionally scoped to a project.

        When ``project_path`` is given, only jobs for that project are
        included, so switching projects does not leak another project's
        finished job into the activity pill. ``None`` keeps the legacy
        unfiltered behavior.
        """
        with self._lock:
            scope = (
                str(Path(project_path).expanduser().resolve()) if project_path is not None else None
            )
            running = [
                job
                for job in self._running_jobs_locked()
                if scope is None or job.project_path == scope
            ]
            jobs = [
                job
                for job in self._visible_jobs_locked()
                if scope is None or job.project_path == scope
            ]
            primary = self._primary_job_locked(scope=scope)
            return {
                "running": bool(running),
                "job": None if primary is None else primary.snapshot(),
                "jobs": [job.snapshot() for job in jobs],
                "running_count": len(running),
            }

    def recent_snapshots(self, *, limit: int = 10) -> list[dict[str, Any]]:
        """Last ≤ ``limit`` job snapshots for a diagnostics bundle."""
        with self._lock:
            ordered: list[Job] = []
            seen: set[str] = set()
            for job_id in reversed(self._finished_order):
                archived = self._finished.get(job_id)
                if archived is None or archived.id in seen:
                    continue
                seen.add(archived.id)
                ordered.append(archived)
            for job in self._running_jobs_locked():
                if job.id not in seen:
                    seen.add(job.id)
                    ordered.append(job)
            if self._job is not None and self._job.id not in seen:
                ordered.append(self._job)
            for job in self._agent_live.values():
                if job.id not in seen:
                    ordered.append(job)
            return [job.snapshot() for job in ordered[:limit]]

    def listening_job(self, task_id: str) -> Job | None:
        """The live pipeline-slot or agent job with SSE listeners that owns ``task_id``."""
        with self._lock:
            candidates: list[Job] = []
            if self._job is not None:
                candidates.append(self._job)
            candidates.extend(self._agent_live.values())
            for job in candidates:
                if (
                    job.status in LIVE_JOB_STATUSES
                    and job.has_listeners()
                    and job.owns_task(task_id)
                ):
                    return job
            return None

    def get_job(self, job_id: str | None = None) -> Job | None:
        with self._lock:
            if job_id is None:
                return self._job
            if self._job is not None and self._job.id == job_id:
                return self._job
            live = self._agent_live.get(job_id)
            if live is not None:
                return live
            if self._agent_latest is not None and self._agent_latest.id == job_id:
                return self._agent_latest
            return self._finished.get(job_id)

    def get_bootstrap_job(self, job_id: str | None = None) -> Job | None:
        with self._lock:
            if job_id is None:
                return self._bootstrap_job
            if self._bootstrap_job is not None and self._bootstrap_job.id == job_id:
                return self._bootstrap_job
            return self._bootstrap_finished.get(job_id)

    def adopt_agent_job(
        self,
        *,
        tool_id: str,
        label: str,
        claim: str,
        project_path: str = "",
    ) -> Job:
        """Create or reuse an agent job. Does not take the pipeline single-flight lock."""
        evicted: list[Job] = []
        with self._lock:
            existing = self._agent_claims.get(claim)
            if existing is not None:
                return existing
            path = str(Path(project_path).expanduser().resolve()) if project_path else ""
            if not path and self._served_project is not None:
                path = self._served_project
            if not path and self._job is not None:
                path = self._job.project_path
            while len(self._agent_live) >= self._agent_live_limit:
                oldest = min(
                    self._agent_live.values(),
                    key=lambda row: row.started_at or 0.0,
                )
                self._forget_agent_locked(oldest)
                self._archive_job(oldest)
                evicted.append(oldest)
            job = Job(
                id=uuid.uuid4().hex[:12],
                project_path=path,
                from_step=None,
                only_step=None,
                kind="agent",
                label=label,
                tool_id=tool_id,
                status="running",
                started_at=time.monotonic(),
                last_progress_at=time.time(),
                message=label,
            )
            self._agent_live[job.id] = job
            self._agent_claims[claim] = job
            self._agent_latest = job
        for old in evicted:
            with old._lock:
                if old.status in LIVE_JOB_STATUSES:
                    old.status = "cancelled"
                    old.message = "Replaced by newer activity"
                    old.finished_at = time.monotonic()
            old.publish({"type": "done", "job": old.snapshot()})
        job.publish({"type": "status", "job": job.snapshot()})
        return job

    def complete_agent_job(
        self,
        job: Job,
        *,
        status: str,
        message: str | None = None,
        error: str | None = None,
    ) -> None:
        """Mark an agent job terminal. Idempotent if already finished."""
        with job._lock:
            if job.status in LIVE_JOB_STATUSES:
                job.status = status
                job.finished_at = time.monotonic()
                if message is not None:
                    job.message = message
                if error is not None:
                    job.error = error
        with self._lock:
            present = job.id in self._agent_live or any(
                claimed is job for claimed in self._agent_claims.values()
            )
            if not present:
                return
            self._forget_agent_locked(job)
            self._archive_job(job)
        job.publish({"type": "done", "job": job.snapshot()})

    def _forget_agent_locked(self, job: Job) -> None:
        self._agent_live.pop(job.id, None)
        drop = [key for key, claimed in self._agent_claims.items() if claimed is job]
        for key in drop:
            self._agent_claims.pop(key, None)

    def _archive_job(self, job: Job) -> None:
        """Keep a finished job findable by id (caller holds ``_lock``)."""
        if job.id in self._finished:
            return
        self._finished[job.id] = job
        self._finished_order.append(job.id)
        while len(self._finished_order) > self._finished_limit:
            old_id = self._finished_order.pop(0)
            self._finished.pop(old_id, None)
