"""Job lookup and cancel shared by the owner pipeline routes and the guest twins."""

from __future__ import annotations

from podcast_mcp.gui.routes.deps import coded_http_error
from podcast_mcp.services.jobs import Job, JobManager

NO_PIPELINE_JOB = "No pipeline job"


def _found(job: Job | None, detail: str) -> Job:
    if job is None:
        raise coded_http_error(404, detail, code="job_not_found")
    return job


def find_job(jobs: JobManager, job_id: str | None) -> Job:
    return _found(jobs.get_job(job_id), NO_PIPELINE_JOB)


def cancel_job(jobs: JobManager, job_id: str | None, *, detail: str = NO_PIPELINE_JOB) -> Job:
    return _found(jobs.cancel(job_id), detail)
