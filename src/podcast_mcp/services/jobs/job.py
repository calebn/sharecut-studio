"""The one Studio job record: pipeline-slot, agent and bootstrap jobs share it.

A ``Job`` holds the lifecycle fields every kind has (status, timing, progress counters,
result, cancel flag) behind one lock, one ``snapshot()`` and one ``publish()``. The kind picks
the snapshot's shape, so each SSE/poll payload keeps the fields its consumer already reads.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from podcast_mcp.services.jobs.events import (
    LIVE_JOB_STATUSES,
    job_listener_count,
    publish_job_event,
)
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.whisper_models import DEFAULT_WHISPER_MODEL

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
    """Another job is still running in the slot: pipeline, render preview or export, or a download."""

    code = "job_running"


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
