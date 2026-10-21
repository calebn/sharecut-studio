"""Start, wait on and cancel Studio jobs; the catalog owns their shared state."""

from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from podcast_mcp.engines.models.whisper import resolve_whisper_model
from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.jobs.catalog import JobCatalog
from podcast_mcp.services.jobs.events import LIVE_JOB_STATUSES, TERMINAL_JOB_STATUSES
from podcast_mcp.services.jobs.job import (
    BootstrapSlotBusyError,
    Job,
    JobKind,
    JobSlotBusyError,
    cancelled_copy,
    short_fail_message,
)
from podcast_mcp.services.jobs.reporter import (
    JobProgressReporter,
    SsePublishReporter,
)
from podcast_mcp.services.media import (
    BounceRequest,
    BounceService,
    SpeakerService,
    coerce_enrollment,
)
from podcast_mcp.services.pipeline import PipelineService, run_bootstrap
from podcast_mcp.util.progress import bind_progress


class JobManager:
    """Start and wait on jobs while the catalog owns their shared state."""

    def __init__(self) -> None:
        self._catalog = JobCatalog()
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

    def listening_job(self, task_id: str) -> Job | None:
        return self._catalog.listening_job(task_id)

    def listening_progress_reporter(self) -> SsePublishReporter | None:
        """Publish-only SSE sink when the pipeline job itself has listeners."""
        with self._catalog._lock:
            job = self._catalog._job
            if job is None or job.status not in LIVE_JOB_STATUSES:
                return None
            if not job.has_listeners():
                return None
        return SsePublishReporter(self)

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

    def start_bootstrap(
        self,
        *,
        components: list[str] | None = None,
        whisper_model: str | None = None,
        force: bool = False,
    ) -> Job:
        """First-run model download in the second slot: at most one, independent of ``_spawn``."""
        model = resolve_whisper_model(requested=whisper_model)
        with self._catalog._lock:
            current = self._catalog._bootstrap_job
            if current is not None and current.status in LIVE_JOB_STATUSES:
                running = ", ".join(current.components) or "setup"
                raise BootstrapSlotBusyError(
                    f"Another download is already running ({running}); try again when it finishes"
                )
            if current is not None and current.status in TERMINAL_JOB_STATUSES:
                self._catalog._bootstrap_finished[current.id] = current
            job = Job.bootstrap(
                uuid.uuid4().hex[:12],
                list(components) if components else [],
                whisper_model=model,
                force=force,
            )
            self._catalog._bootstrap_job = job

        thread = threading.Thread(
            target=self._run_bootstrap_job,
            args=(job,),
            daemon=True,
            name=f"bootstrap-job-{job.id}",
        )
        thread.start()
        return job

    def get_bootstrap_job(self, job_id: str | None = None) -> Job | None:
        return self._catalog.get_bootstrap_job(job_id)

    def cancel_bootstrap(self, job_id: str | None = None) -> Job | None:
        with self._catalog._lock:
            job = self._catalog._bootstrap_job
            if job is None:
                return None
            if job_id is not None and job.id != job_id:
                return None
            if job.status not in LIVE_JOB_STATUSES:
                return job
            job.cancel_requested = True
            job.message = "Cancel requested…"
            return job

    def _run_bootstrap_job(self, job: Job) -> None:
        job.status = "running"
        job.started_at = time.monotonic()
        job.publish({"type": "status", "job": job.snapshot()})
        reporter = JobProgressReporter(job)
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
                    job.message = cancelled_copy(job.kind)
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
        finally:
            reporter.close()
        job.publish({"type": "done", "job": job.snapshot()})

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
        reporter = JobProgressReporter(job)
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
        reporter: JobProgressReporter,
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


_SHARED_JOBS: JobManager | None = None


def shared_job_manager(*, reset: bool = False) -> JobManager:
    """Process-wide job manager so host GUI and guest MCP share one render lock.

    Pass ``reset=True`` from ``create_app`` so each GUI process/test app starts
    with a clean lock (avoids leftover jobs across TestClient apps).
    """
    global _SHARED_JOBS
    if reset or _SHARED_JOBS is None:
        _SHARED_JOBS = JobManager()
    return _SHARED_JOBS


def studio_job_manager() -> JobManager | None:
    """Studio job manager if ``create_app`` (or a test) already constructed one."""
    return _SHARED_JOBS
