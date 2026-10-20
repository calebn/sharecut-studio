"""Background pipeline jobs for the DAW viewer (progress via per-subscriber SSE fan-out)."""

from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.jobs import (
    KIND_META,
    LIVE_JOB_STATUSES,
    TERMINAL_JOB_STATUSES,
    Job,
    JobKind,
    JobSlotBusyError,
    StepTiming,
    cancelled_copy,
    short_fail_message,
)
from podcast_mcp.services.media import (
    BounceRequest,
    BounceService,
    SpeakerService,
    coerce_enrollment,
)
from podcast_mcp.services.pipeline import PipelineService
from podcast_mcp.util.progress import (
    PROGRESS_LAZY_CHIP_SEC,
    ElapsedProgressMixin,
    ProgressEvent,
    bind_progress,
)

_AGENT_LIVE_LIMIT = 8
_PIPELINE_OWNED_WRAPS = frozenset({"pipeline_run"})
_DOMAIN_PROGRESS_KINDS = frozenset({"start", "update", "message", "heartbeat"})


class _JobProgressReporter(ElapsedProgressMixin):
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


class _SsePublishReporter(ElapsedProgressMixin):
    """Fan-out only: enqueue SSE progress events; never mutate job fields."""

    def __init__(self, manager: PipelineJobManager) -> None:
        super().__init__()
        self._manager = manager

    def _live_job(self, task_id: str) -> Job | None:
        """Return the live job that owns this wrap's ``task_id``, if any."""
        with self._manager._catalog._lock:
            candidates: list[Job] = []
            if self._manager._catalog._job is not None:
                candidates.append(self._manager._catalog._job)
            candidates.extend(self._manager._catalog._agent_live.values())
            for job in candidates:
                if (
                    job.status in LIVE_JOB_STATUSES
                    and job.has_listeners()
                    and job.owns_task(task_id)
                ):
                    return job
            return None

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


class _JobCatalog:
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
        # replaced ``_job`` (waitForJob / followExportJob).
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


class PipelineJobManager:
    """Start and wait on jobs while the catalog owns their shared state."""

    def __init__(self) -> None:
        self._catalog = _JobCatalog()
        self._lock = self._catalog._lock

    @property
    def _job(self) -> Job | None:
        return self._catalog._job

    @_job.setter
    def _job(self, value: Job | None) -> None:
        self._catalog._job = value

    @property
    def _finished(self) -> dict[str, Job]:
        return self._catalog._finished

    @property
    def _finished_order(self) -> list[str]:
        return self._catalog._finished_order

    @property
    def _finished_limit(self) -> int:
        return self._catalog._finished_limit

    @_finished_limit.setter
    def _finished_limit(self, value: int) -> None:
        self._catalog._finished_limit = value

    @property
    def _agent_live(self) -> dict[str, Job]:
        return self._catalog._agent_live

    @property
    def _agent_live_limit(self) -> int:
        return self._catalog._agent_live_limit

    @_agent_live_limit.setter
    def _agent_live_limit(self, value: int) -> None:
        self._catalog._agent_live_limit = value

    def _archive_job(self, job: Job) -> None:
        self._catalog._archive_job(job)

    def set_served_project(self, project_path: Path | str | None) -> None:
        self._catalog.set_served_project(project_path)

    def status(self, project_path: str | None = None) -> dict[str, Any]:
        return self._catalog.status(project_path)

    def recent_snapshots(self, *, limit: int = 10) -> list[dict[str, Any]]:
        return self._catalog.recent_snapshots(limit=limit)

    def get_job(self, job_id: str | None = None) -> Job | None:
        return self._catalog.get_job(job_id)

    def adopt_agent_job(
        self, *, tool_id: str, label: str, claim: str, project_path: str = ""
    ) -> Job:
        return self._catalog.adopt_agent_job(
            tool_id=tool_id, label=label, claim=claim, project_path=project_path
        )

    def complete_agent_job(
        self, job: Job, *, status: str, message: str | None = None, error: str | None = None
    ) -> None:
        self._catalog.complete_agent_job(job, status=status, message=message, error=error)

    def listening_progress_reporter(self) -> _SsePublishReporter | None:
        """Publish-only SSE sink when the pipeline job itself has listeners."""
        with self._catalog._lock:
            job = self._catalog._job
            if job is None or job.status not in LIVE_JOB_STATUSES:
                return None
            if not job.has_listeners():
                return None
        return _SsePublishReporter(self)

    def wait(self, job: Job, *, timeout: float | None = None) -> Job:
        """Block until ``job`` leaves queued/running (host MCP pipeline_run)."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while job.status in LIVE_JOB_STATUSES:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f"Timed out waiting for job {job.id}")
            time.sleep(0.05)
        return job

    def start(
        self,
        project_path: Path,
        *,
        from_step: str | None = None,
        only_step: str | None = None,
        skip_steps: list[str] | None = None,
        unattended: bool = False,
        config: dict[str, Any] | None = None,
    ) -> Job:
        return self._spawn(
            project_path,
            kind="pipeline",
            from_step=from_step,
            only_step=only_step,
            skip_steps=skip_steps,
            unattended=unattended,
            config=config,
        )

    def start_render_preview(self, project_path: Path) -> Job:
        """Rebuild stems/premix via ``PipelineService.render_preview``."""
        return self._spawn(project_path, kind="render_preview", label="Render preview")

    def start_analyze(self, project_path: Path, *, apply: bool) -> Job:
        """Heuristic Analyze via ``analyze_working_set`` (same single-flight slot as pipeline)."""
        return self._spawn(project_path, kind="analyze", label="Analyze", config={"apply": apply})

    def start_split_speakers(
        self,
        project_path: Path,
        *,
        track_id: str,
        speaker_count: int,
        names: list[str] | None = None,
        enrollment: dict[str, list[tuple[float, float]]] | None = None,
    ) -> Job:
        """Split a one-track recording into a lane per speaker via ``SpeakerService``.

        ``enrollment`` holds each named speaker's source-second spans, as the CLI and MCP take them.
        """

        def validate_split() -> None:
            SpeakerService(ProjectWorkspace.open(project_path)).check_split(
                track_id,
                speaker_count=speaker_count,
                names=names,
                enrolled=list(enrollment or {}),
            )

        return self._spawn(
            project_path,
            kind="split_speakers",
            label="Split speakers",
            config={
                "track_id": track_id,
                "speaker_count": speaker_count,
                "names": names,
                "enrollment": enrollment,
            },
            validate=validate_split,
        )

    def start_bounce(
        self,
        project_path: Path,
        *,
        track_ids: list[str] | None = None,
        start_s: float | None = None,
        end_s: float | None = None,
        formats: list[str] | None = None,
        exact_range: ExactRangeTarget | None = None,
    ) -> Job:
        """Bounce stems/range via ``BounceService`` (same single-flight slot as pipeline)."""
        req = BounceRequest(
            track_ids=track_ids,
            start_s=start_s,
            end_s=end_s,
            formats=formats,
            exact_range=exact_range,
        )

        def validate_bounce() -> None:
            BounceService(ProjectWorkspace.open(project_path)).validate(req)

        return self._spawn(
            project_path,
            kind="bounce",
            label="Bounce",
            config={
                "track_ids": track_ids,
                "start_s": start_s,
                "end_s": end_s,
                "formats": formats,
                "exact_range": exact_range.model_dump(mode="json") if exact_range else None,
            },
            validate=validate_bounce,
        )

    def start_export(
        self,
        project_path: Path,
        *,
        formats: list[dict[str, Any]] | None = None,
    ) -> Job:
        """Mastered deliverables via ``PipelineService.export_audio``."""
        return self._spawn(
            project_path,
            kind="export",
            label="Export deliverables",
            config={"formats": formats},
        )

    def cancel(self, job_id: str | None = None) -> Job | None:
        with self._catalog._lock:
            job = self._catalog._job
            if job is None:
                return None
            if job_id is not None and job.id != job_id:
                return None
            if job.status not in LIVE_JOB_STATUSES:
                return job
            job.cancel_requested = True
            job.message = "Cancel requested…"
            return job

    def _spawn(
        self,
        project_path: Path,
        *,
        kind: JobKind,
        from_step: str | None = None,
        only_step: str | None = None,
        skip_steps: list[str] | None = None,
        unattended: bool = False,
        config: dict[str, Any] | None = None,
        label: str | None = None,
        validate: Callable[[], None] | None = None,
    ) -> Job:
        with self._catalog._lock:
            if self._catalog._job is not None and self._catalog._job.status in LIVE_JOB_STATUSES:
                raise JobSlotBusyError("A pipeline-slot job is already running")
        if validate is not None:
            validate()
        with self._catalog._lock:
            if self._catalog._job is not None and self._catalog._job.status in LIVE_JOB_STATUSES:
                raise JobSlotBusyError("A pipeline-slot job is already running")
            current = self._catalog._job
            if current is not None and current.status in TERMINAL_JOB_STATUSES:
                self._catalog._archive_job(current)
            job = Job(
                id=uuid.uuid4().hex[:12],
                project_path=str(project_path.resolve()),
                from_step=from_step,
                only_step=only_step,
                kind=kind,
                label=label,
                skip_steps=list(skip_steps or []),
                unattended=unattended,
                config=config,
            )
            self._catalog._job = job

        thread = threading.Thread(
            target=self._run_job,
            args=(job,),
            daemon=True,
            name=f"pipeline-job-{job.id}",
        )
        thread.start()
        return job

    def _run_job(self, job: Job) -> None:
        with job._lock:
            job.status = "running"
            job.started_at = time.monotonic()
            job.last_progress_at = time.time()
        job.publish({"type": "status", "job": job.snapshot()})
        reporter = _JobProgressReporter(job)
        try:
            try:
                with bind_progress(reporter):
                    done_message, result = self._execute_job(job, reporter)
                with job._lock:
                    if job.cancel_requested:
                        job.status = "cancelled"
                        job.message = cancelled_copy(job.kind)
                        if result is not None:
                            # Work finished (or wrote files) before cancel took effect.
                            job.result = result
                    else:
                        job.status = "ok"
                        job.message = job.message or done_message
                        if result is not None:
                            job.result = result
                    job.finished_at = time.monotonic()
                    if job.steps and job.steps[-1].status == "running":
                        job.steps[-1].finished_at = job.finished_at
                        job.steps[-1].status = "error" if job.status == "cancelled" else "ok"
            except Exception as exc:
                from podcast_mcp.util.progress import CancelledProgress

                with job._lock:
                    cancelled = (
                        job.cancel_requested
                        or isinstance(exc, CancelledProgress)
                        or "cancelled" in str(exc).lower()
                    )
                    job.status = "cancelled" if cancelled else "error"
                    job.finished_at = time.monotonic()
                    short = None if cancelled else short_fail_message(str(exc))
                    job.error = short
                    job.message = cancelled_copy(job.kind) if cancelled else (short or str(exc))
                    if job.steps and job.steps[-1].status == "running":
                        job.steps[-1].status = "error"
                        job.steps[-1].error = short
                        job.steps[-1].finished_at = job.finished_at
        finally:
            reporter.close()
        with self._catalog._lock:
            if self._catalog._job is job and job.status in TERMINAL_JOB_STATUSES:
                self._catalog._archive_job(job)
        job.publish({"type": "done", "job": job.snapshot()})

    def _execute_job(
        self,
        job: Job,
        reporter: _JobProgressReporter,
    ) -> tuple[str, dict[str, Any] | None]:
        ws = ProjectWorkspace.open(Path(job.project_path))
        from podcast_mcp.util.progress import CancelledProgress

        def cancel_check() -> bool:
            return job.cancel_requested

        if job.cancel_requested:
            raise CancelledProgress(cancelled_copy(job.kind))
        if job.kind == "bounce":
            cfg = job.config or {}
            paths = BounceService(ws).bounce(
                BounceRequest(
                    track_ids=cfg.get("track_ids"),
                    start_s=cfg.get("start_s"),
                    end_s=cfg.get("end_s"),
                    formats=cfg.get("formats"),
                    exact_range=ExactRangeTarget.model_validate(cfg["exact_range"])
                    if cfg.get("exact_range")
                    else None,
                ),
                cancel_check=cancel_check,
            )
            return "Bounce complete", {"paths": [str(p) for p in paths]}
        if job.kind == "split_speakers":
            cfg = job.config or {}
            split = SpeakerService(ws).split_speakers(
                cfg["track_id"],
                speaker_count=cfg["speaker_count"],
                names=cfg.get("names"),
                enrollment=coerce_enrollment(cfg.get("enrollment")),
                dry_run=False,
                progress=reporter,
                cancel_check=cancel_check,
            )
            return "Split complete", split
        if job.kind == "analyze":
            from podcast_mcp.services.pipeline import analyze_working_set

            cfg = job.config or {}
            result = analyze_working_set(
                Path(job.project_path),
                ws.project,
                apply=bool(cfg.get("apply")),
                cancel_check=cancel_check,
            )
            return "Analyze complete", result
        svc = PipelineService(ws)
        if job.kind == "export":
            cfg = job.config or {}
            export = svc.export_audio(cfg.get("formats"), cancel_check=cancel_check)
            return "Export complete", export.job_result()
        if job.kind == "render_preview":
            if job.cancel_requested:
                raise CancelledProgress(cancelled_copy(job.kind))
            info = svc.render_preview(rerender=True, progress=reporter, cancel_check=cancel_check)
            if isinstance(info, dict) and not info.get("ok", True):
                raise RuntimeError(
                    str(info.get("error") or "Render preview failed (premix missing)")
                )
            return "Render preview complete", None
        run_result = svc.run(
            from_step=job.from_step,
            only_step=job.only_step,
            skip_steps=job.skip_steps or None,
            progress=reporter,
            unattended=job.unattended,
            config=job.config,
            cancel_check=cancel_check,
        )
        job.result_step = run_result.last_step
        return "Pipeline complete", run_result.job_result()


class AgentJobFanInReporter(ElapsedProgressMixin):
    """Lazily create a Studio ``kind=agent`` job from wrap-level progress.

    Instant tools (start then end with no intra-op events and elapsed < 1s)
    never create a job. The first ``update`` / ``message`` (incl. phase) or
    the 1s timer creates one. Wrap ``end`` / ``fail`` / ``cancel`` finalize.
    """

    LAZY_AFTER_SEC = PROGRESS_LAZY_CHIP_SEC

    def __init__(self, manager: PipelineJobManager) -> None:
        super().__init__()
        self._manager = manager
        self._state_lock = threading.Lock()
        self._claim = uuid.uuid4().hex
        self._wrap_task_id: str | None = None
        self._wrap_label = ""
        self._closed = False
        self._job: Job | None = None
        self._job_reporter: _JobProgressReporter | None = None
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
        extra_reporter: _JobProgressReporter | None = None
        try:
            job = self._manager.adopt_agent_job(
                tool_id=tool_id,
                label=label,
                claim=claim,
            )
            reporter = _JobProgressReporter(job)
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

    def _reporter_if_open(self) -> _JobProgressReporter | None:
        with self._state_lock:
            if self._closed:
                return None
            return self._job_reporter

    def _is_wrap(self, task_id: str) -> bool:
        return self._wrap_task_id is not None and task_id == self._wrap_task_id

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        reporter: _JobProgressReporter | None
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


_SHARED_JOBS: PipelineJobManager | None = None


def guest_render_job(job: Job | None, project_path: Path) -> dict[str, Any] | None:
    """Expose only safe status for a render belonging to this guest project."""
    if (
        job is None
        or job.kind != "render_preview"
        or Path(job.project_path).resolve() != project_path.resolve()
    ):
        return None
    snap = job.snapshot()
    status = snap["status"]
    return {
        "id": job.id,
        "status": status,
        "current": snap["current"],
        "total": snap["total"],
        "message": "Rendering preview" if status in LIVE_JOB_STATUSES else None,
        "error": "Render preview failed" if status == "error" else None,
    }


def shared_job_manager(*, reset: bool = False) -> PipelineJobManager:
    """Process-wide job manager so host GUI and guest MCP share one render lock.

    Pass ``reset=True`` from ``create_app`` so each GUI process/test app starts
    with a clean lock (avoids leftover jobs across TestClient apps).
    """
    global _SHARED_JOBS
    if reset or _SHARED_JOBS is None:
        _SHARED_JOBS = PipelineJobManager()
    return _SHARED_JOBS


def studio_job_manager() -> PipelineJobManager | None:
    """Studio job manager if ``create_app`` (or a test) already constructed one."""
    return _SHARED_JOBS


def gui_sse_progress_sink() -> _SsePublishReporter | None:
    """Live in-process SSE fan-out; no job field writes."""
    return shared_job_manager().listening_progress_reporter()


def gui_agent_job_progress_sink() -> AgentJobFanInReporter | None:
    """Wrap-level MCP/CLI fan-in. None until Studio ``create_app`` registered a manager."""
    if _SHARED_JOBS is None:
        return None
    return AgentJobFanInReporter(_SHARED_JOBS)


def project_meta(project_path: Path) -> dict[str, Any]:
    """mtime/size of episode.project.json plus document.db's server_seq.

    Stats the project file directly and reads ``document_server_seq``, which
    itself is stat + one row on document.db. Neither parses the project, and
    neither creates document.db. ``server_seq`` is omitted when document.db
    cannot be read.
    """
    from podcast_mcp.services.document_sync import document_poll_meta

    return {"path": str(project_path.resolve()), **document_poll_meta(project_path)}


def session_file_meta(project_path: Path) -> dict[str, Any]:
    """Session poll meta for artifacts/session/sync.db (zeros if missing).

    ``mtime_ns`` is the snapshot's ``updated_at_ns`` and ``size`` the serialized
    snapshot's byte length, not file stats (see ``session_meta_at``). Parse-free:
    never opens/parses the project.
    """
    from podcast_mcp.services.session_sync import session_meta

    return session_meta(project_path)
