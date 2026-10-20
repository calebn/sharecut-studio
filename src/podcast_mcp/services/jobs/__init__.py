from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.jobs.events import (
        JOB_EVENT_QUEUE_MAX,
        LIVE_JOB_STATUSES,
        TERMINAL_JOB_STATUSES,
        job_events_hub,
        job_listener_count,
        publish_job_event,
    )
    from podcast_mcp.services.jobs.job import (
        Job,
        JobKind,
        JobSlotBusyError,
        StepTiming,
        guest_render_job,
    )
    from podcast_mcp.services.jobs.manager import (
        JobManager,
        shared_job_manager,
        studio_job_manager,
    )
    from podcast_mcp.services.jobs.reporter import AgentJobFanInReporter, SsePublishReporter

__all__ = [
    "JOB_EVENT_QUEUE_MAX",
    "LIVE_JOB_STATUSES",
    "TERMINAL_JOB_STATUSES",
    "AgentJobFanInReporter",
    "Job",
    "JobKind",
    "JobManager",
    "JobSlotBusyError",
    "SsePublishReporter",
    "StepTiming",
    "guest_render_job",
    "job_events_hub",
    "job_listener_count",
    "publish_job_event",
    "shared_job_manager",
    "studio_job_manager",
]

_MODULE_BY_NAME = {
    "JOB_EVENT_QUEUE_MAX": "events",
    "LIVE_JOB_STATUSES": "events",
    "TERMINAL_JOB_STATUSES": "events",
    "AgentJobFanInReporter": "reporter",
    "Job": "job",
    "JobKind": "job",
    "JobManager": "manager",
    "JobSlotBusyError": "job",
    "SsePublishReporter": "reporter",
    "StepTiming": "job",
    "guest_render_job": "job",
    "job_events_hub": "events",
    "job_listener_count": "events",
    "publish_job_event": "events",
    "shared_job_manager": "manager",
    "studio_job_manager": "manager",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
