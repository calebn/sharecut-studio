from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.jobs.audio_edits import run_audio_edit
    from podcast_mcp.services.jobs.events import (
        JOB_EVENT_QUEUE_MAX,
        LIVE_JOB_STATUSES,
        TERMINAL_JOB_STATUSES,
        job_events_hub,
        job_listener_count,
        publish_job_event,
    )
    from podcast_mcp.services.jobs.job import (
        GUEST_EXPORT_KINDS,
        GUEST_PIPELINE_KINDS,
        GUEST_RENDER_KINDS,
        BootstrapSlotBusyError,
        Job,
        JobKind,
        JobSlotBusyError,
        StepTiming,
        guest_job_done,
        guest_job_projection,
        guest_job_view,
        guest_status_view,
        guest_visible_job,
        job_in_project,
    )
    from podcast_mcp.services.jobs.manager import (
        JobManager,
        shared_job_manager,
        studio_job_manager,
    )
    from podcast_mcp.services.jobs.reporter import AgentJobFanInReporter, SsePublishReporter

__all__ = [
    "GUEST_EXPORT_KINDS",
    "GUEST_PIPELINE_KINDS",
    "GUEST_RENDER_KINDS",
    "JOB_EVENT_QUEUE_MAX",
    "LIVE_JOB_STATUSES",
    "TERMINAL_JOB_STATUSES",
    "AgentJobFanInReporter",
    "BootstrapSlotBusyError",
    "Job",
    "JobKind",
    "JobManager",
    "JobSlotBusyError",
    "SsePublishReporter",
    "StepTiming",
    "guest_job_done",
    "guest_job_projection",
    "guest_job_view",
    "guest_status_view",
    "guest_visible_job",
    "job_events_hub",
    "job_in_project",
    "job_listener_count",
    "publish_job_event",
    "run_audio_edit",
    "shared_job_manager",
    "studio_job_manager",
]

_MODULE_BY_NAME = {
    "JOB_EVENT_QUEUE_MAX": "events",
    "LIVE_JOB_STATUSES": "events",
    "TERMINAL_JOB_STATUSES": "events",
    "AgentJobFanInReporter": "reporter",
    "BootstrapSlotBusyError": "job",
    "Job": "job",
    "JobKind": "job",
    "JobManager": "manager",
    "JobSlotBusyError": "job",
    "SsePublishReporter": "reporter",
    "StepTiming": "job",
    "GUEST_EXPORT_KINDS": "job",
    "GUEST_PIPELINE_KINDS": "job",
    "GUEST_RENDER_KINDS": "job",
    "guest_job_done": "job",
    "guest_job_projection": "job",
    "guest_job_view": "job",
    "guest_status_view": "job",
    "guest_visible_job": "job",
    "job_events_hub": "events",
    "job_in_project": "job",
    "job_listener_count": "events",
    "publish_job_event": "events",
    "run_audio_edit": "audio_edits",
    "shared_job_manager": "manager",
    "studio_job_manager": "manager",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
