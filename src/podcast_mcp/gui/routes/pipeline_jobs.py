"""Job lookup, cancel and run start shared by the owner pipeline routes and the guest twins."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from podcast_mcp.gui.routes.deps import bad_request_error, coded_exception_error, coded_http_error
from podcast_mcp.services.jobs import Job, JobManager
from podcast_mcp.services.pipeline import (
    STEP_NAMES,
    ensure_whisper_cached_for_run,
    ensure_word_aligner_for_run,
    skip_steps_from_enabled,
    transcribe_run_config,
)

NO_PIPELINE_JOB = "No pipeline job"


def _found(job: Job | None, detail: str) -> Job:
    if job is None:
        raise coded_http_error(404, detail, code="job_not_found")
    return job


def find_job(jobs: JobManager, job_id: str | None) -> Job:
    return _found(jobs.get_job(job_id), NO_PIPELINE_JOB)


def cancel_job(jobs: JobManager, job_id: str | None, *, detail: str = NO_PIPELINE_JOB) -> Job:
    return _found(jobs.cancel(job_id), detail)


def check_steps(from_step: str | None, only_step: str | None, skip_steps: list[str] | None) -> None:
    if from_step and from_step not in STEP_NAMES:
        raise coded_http_error(
            400, f"Unknown from_step: {from_step}", code="pipeline_from_step_unknown"
        )
    if only_step and only_step not in STEP_NAMES:
        raise coded_http_error(
            400, f"Unknown only_step: {only_step}", code="pipeline_only_step_unknown"
        )
    if skip_steps:
        bad = [s for s in skip_steps if s not in STEP_NAMES]
        if bad:
            raise coded_http_error(
                400, f"Unknown skip_steps: {bad}", code="pipeline_skip_steps_unknown"
            )


def resolve_skip_steps(
    explicit: list[str] | None, *enabled_options: list[str] | None
) -> list[str] | None:
    if explicit is not None:
        return explicit
    for enabled in enabled_options:
        if enabled is not None:
            return skip_steps_from_enabled(enabled)
    return None


def owner_busy_error(exc: RuntimeError) -> HTTPException:
    return coded_exception_error(409, exc, code="pipeline_busy")


def start_pipeline_job(
    jobs: JobManager,
    project_path: Path,
    *,
    config: dict[str, Any] | None,
    from_step: str | None,
    only_step: str | None,
    skip_steps: list[str] | None,
    unattended: bool,
    force_transcribe: bool,
    overwrite_edited: bool,
    retime_words: bool,
    persist: Callable[[], None] | None = None,
    busy_error: Callable[[RuntimeError], HTTPException] | None = None,
) -> Job:
    """``persist`` runs before the model checks; a guest passes none."""
    try:
        run_config = transcribe_run_config(
            config,
            force=force_transcribe,
            overwrite_edited=overwrite_edited,
            retime_words=retime_words,
        )
    except ValueError as exc:
        raise bad_request_error(exc) from exc

    if persist is not None:
        persist()

    ensure_whisper_cached_for_run(
        config=run_config,
        from_step=from_step,
        only_step=only_step,
        skip_steps=skip_steps,
        memoize=True,  # early 409 only; PipelineService.run re-hashes before its checkpoint
    )
    ensure_word_aligner_for_run(
        run_config, from_step=from_step, only_step=only_step, skip_steps=skip_steps
    )

    try:
        return jobs.start(
            project_path,
            from_step=from_step,
            only_step=only_step,
            skip_steps=skip_steps,
            unattended=unattended,
            config=run_config,
        )
    except RuntimeError as exc:
        if busy_error is None:
            raise
        raise busy_error(exc) from exc
