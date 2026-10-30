"""The one Studio job record: pipeline-slot, agent and bootstrap jobs share it.

A ``Job`` holds the lifecycle fields every kind has (status, timing, progress counters,
result, cancel flag) behind one lock, one ``snapshot()`` and one ``publish()``. The kind picks
the snapshot's shape, so each SSE/poll payload keeps the fields its consumer already reads.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, Literal

from podcast_mcp.engines.models.whisper import DEFAULT_WHISPER_MODEL
from podcast_mcp.services.jobs.events import (
    TERMINAL_JOB_STATUSES,
    job_listener_count,
    publish_job_event,
)
from podcast_mcp.util.coded_error import CodedError

JobKind = Literal[
    "pipeline",
    "render_preview",
    "bounce",
    "export",
    "analyze",
    "split_speakers",
    "agent",
    "bootstrap",
]

_GUI_FAIL_MAX = 200


def _token_looks_like_abs_path(token: str) -> bool:
    s = token.strip(".,:;()[]\"'")
    if not s:
        return False
    if s.startswith("/") and not s.startswith("//"):
        return True
    return len(s) >= 3 and s[1] == ":" and s[2] in ("\\", "/")


def short_fail_message(message: str | None, phase: str | None = None) -> str | None:
    """First non-traceback line for the GUI; never a stack trace or host path."""
    if message is None:
        return None
    line = message.strip().splitlines()[0] if message.strip() else ""
    if line.lower().startswith("traceback"):
        line = ""
    line = " ".join(tok for tok in line.split() if not _token_looks_like_abs_path(tok))
    if not line and phase:
        line = phase
    if not line:
        return None
    return line[:_GUI_FAIL_MAX]


class JobSlotBusyError(CodedError, RuntimeError):
    """Another pipeline-slot job (pipeline run, render preview, export) is still running."""

    code = "job_running"


class BootstrapSlotBusyError(JobSlotBusyError):
    """A first-run download is still running; the download slot holds one at a time.

    ``running`` lists what it is downloading, and ``cancelling`` says it is already stopping.
    """

    code = "bootstrap_job_running"

    def __init__(self, message: str, *, running: list[str], cancelling: bool) -> None:
        super().__init__(message)
        self.running = running
        self.cancelling = cancelling


@dataclass(frozen=True)
class KindMeta:
    cancelled: str
    event_label: str
    unit_tasks: frozenset[str]


# Per-kind chrome + determinate-bar ownership (unit_tasks match progress_task ids).
# Analyze owns both per-track children, so the bar restarts at 0/N for the silence phase.
KIND_META: dict[str, KindMeta] = {
    "pipeline": KindMeta("Pipeline cancelled", "Pipeline", frozenset({"pipeline"})),
    "bounce": KindMeta("Bounce cancelled", "Bounce", frozenset({"bounce"})),
    "export": KindMeta("Export cancelled", "Export", frozenset({"export"})),
    "render_preview": KindMeta("Render preview cancelled", "Render preview", frozenset({"render"})),
    "analyze": KindMeta(
        "Analyze cancelled", "Analyze", frozenset({"analyze_health", "analyze_silence"})
    ),
    "split_speakers": KindMeta(
        "Split speakers cancelled", "Split speakers", frozenset({"speaker-split"})
    ),
    "agent": KindMeta("Activity cancelled", "Activity", frozenset()),
    "bootstrap": KindMeta("Bootstrap cancelled", "Bootstrap", frozenset({"bootstrap"})),
}


def cancelled_copy(kind: str) -> str:
    meta = KIND_META.get(kind)
    return meta.cancelled if meta is not None else "Pipeline cancelled"


@dataclass
class StepTiming:
    name: str
    started_at: float
    finished_at: float | None = None
    status: str = "running"
    error: str | None = None
    summary: str | None = None

    @property
    def elapsed_sec(self) -> float:
        end = self.finished_at if self.finished_at is not None else time.monotonic()
        return max(0.0, end - self.started_at)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "status": self.status,
            "elapsed_sec": round(self.elapsed_sec, 2),
            "error": self.error,
            "summary": self.summary,
        }


@dataclass
class Job:
    """One background job; ``kind`` selects the snapshot shape and the fields that apply."""

    id: str
    project_path: str = ""
    from_step: str | None = None
    only_step: str | None = None
    status: str = "queued"  # queued | running | ok | error | cancelled
    kind: JobKind = "pipeline"
    label: str | None = None
    tool_id: str | None = None
    result: dict[str, Any] | None = None
    started_at: float | None = None
    finished_at: float | None = None
    last_progress_at: float | None = None
    error: str | None = None
    current: int | None = None
    total: int | None = None
    message: str | None = None
    unattended: bool = False
    skip_steps: list[str] = field(default_factory=list)
    config: dict[str, Any] | None = None
    cancel_requested: bool = False
    download: dict[str, Any] | None = None
    failure: dict[str, Any] | None = None
    error_code: str | None = None
    error_model: dict[str, Any] | None = None
    failed_components: list[str] = field(default_factory=list)
    steps: list[StepTiming] = field(default_factory=list)
    result_step: str | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock)

    @classmethod
    def bootstrap(
        cls,
        job_id: str,
        components: list[str],
        *,
        whisper_model: str = DEFAULT_WHISPER_MODEL,
        force: bool = False,
    ) -> Job:
        return cls(
            id=job_id,
            kind="bootstrap",
            config={"components": list(components), "whisper_model": whisper_model, "force": force},
        )

    @property
    def components(self) -> list[str]:
        return list((self.config or {}).get("components", []))

    @property
    def whisper_model(self) -> str:
        return str((self.config or {}).get("whisper_model", DEFAULT_WHISPER_MODEL))

    @property
    def force(self) -> bool:
        return bool((self.config or {}).get("force", False))

    def owns_task(self, task_id: str) -> bool:
        """Whether *task_id* is one of this job's determinate-bar (unit) tasks."""
        if self.kind == "agent":
            return bool(self.tool_id) and task_id == self.tool_id
        meta = KIND_META.get(self.kind)
        units = meta.unit_tasks if meta is not None else frozenset({self.kind})
        return task_id in units

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            elapsed = 0.0
            if self.started_at is not None:
                end = self.finished_at if self.finished_at is not None else time.monotonic()
                elapsed = max(0.0, end - self.started_at)
            if self.kind == "bootstrap":
                return {
                    "id": self.id,
                    "kind": "bootstrap",
                    "components": self.components,
                    "whisper_model": self.whisper_model,
                    "status": self.status,
                    "current": self.current,
                    "total": self.total,
                    "message": self.message,
                    "error": self.error,
                    "download": dict(self.download) if self.download else None,
                    "failure": dict(self.failure) if self.failure else None,
                    "elapsed_sec": round(elapsed, 2),
                    "result": self.result,
                }
            return {
                "id": self.id,
                "project_path": "" if self.kind == "agent" else self.project_path,
                "from_step": self.from_step,
                "only_step": self.only_step,
                "kind": self.kind,
                "label": self.label,
                "tool_id": self.tool_id,
                "status": self.status,
                "current": self.current,
                "total": self.total,
                "message": self.message,
                "error": self.error,
                "error_code": self.error_code,
                "error_model": dict(self.error_model) if self.error_model else None,
                "result": dict(self.result) if self.result else None,
                "last_progress_at": self.last_progress_at,
                "elapsed_sec": round(elapsed, 2),
                "unattended": self.unattended,
                "skip_steps": list(self.skip_steps),
                "steps": [s.to_dict() for s in self.steps],
            }

    def has_listeners(self) -> bool:
        return job_listener_count(self.id) > 0

    def publish(self, event: dict[str, Any]) -> None:
        publish_job_event(self.id, event)


@dataclass(frozen=True)
class GuestJobView:
    """What a share guest reads of one job kind: fixed copy, never host text."""

    running: str
    failed: str
    terminal: frozenset[str] = TERMINAL_JOB_STATUSES
    failure: frozenset[str] = frozenset({"error"})


# Job kinds a guest may see and their projection. A kind absent here is invisible to guests.
GUEST_JOB_VIEW: Mapping[str, GuestJobView] = MappingProxyType(
    {
        "pipeline": GuestJobView("Running pipeline", "Pipeline failed"),
        "render_preview": GuestJobView("Rendering preview", "Render preview failed"),
    }
)


GUEST_PIPELINE_KINDS = frozenset({"pipeline"})
GUEST_RENDER_KINDS = frozenset({"render_preview"})


def _path_in_project(path: str, project_path: Path) -> bool:
    if not path:
        return False
    try:
        return Path(path).resolve() == project_path.resolve()
    except (ValueError, OSError):
        return False


def job_in_project(job: Job, project_path: Path) -> bool:
    """Whether *job* belongs to *project_path*; a job with no path belongs to none."""
    return _path_in_project(job.project_path, project_path)


def guest_visible_job(job: Job | None, project_path: Path, kinds: Collection[str]) -> Job | None:
    """*job* if it is of one of *kinds* (all guest-visible) and the project's, else None."""
    if (
        job is None
        or job.kind not in kinds
        or job.kind not in GUEST_JOB_VIEW
        or not job_in_project(job, project_path)
    ):
        return None
    return job


def guest_job_done(job: Job) -> bool:
    return job.status in GUEST_JOB_VIEW[job.kind].terminal


def _guest_projection(snap: Mapping[str, Any]) -> dict[str, Any]:
    view = GUEST_JOB_VIEW[snap["kind"]]
    status = snap["status"]
    return {
        "id": snap["id"],
        "status": status,
        "current": snap["current"],
        "total": snap["total"],
        "message": view.running if status not in view.terminal else None,
        "error": view.failed if status in view.failure else None,
    }


def guest_job_view(
    job: Job | None, project_path: Path, kinds: Collection[str]
) -> dict[str, Any] | None:
    """Expose only safe status for a job of one of *kinds* belonging to this guest project."""
    visible = guest_visible_job(job, project_path, kinds)
    return None if visible is None else _guest_projection(visible.snapshot())


def guest_status_view(
    status: Mapping[str, Any], project_path: Path, kinds: Collection[str]
) -> dict[str, Any]:
    """Project an unscoped ``JobManager.status`` to this project's jobs of *kinds*.

    The project is matched here by resolved path, so a symlinked share path agrees with
    ``guest_visible_job``; ``job`` is the newest live job, else the newest.
    """
    jobs = [
        _guest_projection(snap)
        for snap in status["jobs"]
        if snap.get("kind") in kinds
        and snap["kind"] in GUEST_JOB_VIEW
        and _path_in_project(str(snap.get("project_path") or ""), project_path)
    ]
    live = [job for job in jobs if job["message"] is not None]
    primary = live[0] if live else (jobs[0] if jobs else None)
    return {"running": bool(live), "job": primary, "jobs": jobs}
