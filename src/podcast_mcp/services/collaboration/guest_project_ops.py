"""The Editor's pipeline, export and speaker work, shared by the HTTP twins and the guest MCP tools.

Each function is the body of a ``GUEST_OWNER_ROUTES`` row, taking the share's workspace and the
already-validated fields of its request. A refusal is a ``GuestRefusal``: the HTTP adapter sends
its status, message and code as they are, and a guest MCP tool sends the code with the fixed guest
copy. Nothing here takes a path from a client.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from typing import Any

from podcast_mcp.export.audio import GUEST_EXPORT_FORMATS
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.jobs import (
    GUEST_PIPELINE_KINDS,
    Job,
    JobManager,
    guest_job_projection,
    guest_job_view,
    guest_status_view,
    guest_visible_job,
)
from podcast_mcp.services.media import SpeakerService
from podcast_mcp.services.pipeline import (
    STEP_NAMES,
    WordAlignerMissingError,
    config_store,
    ensure_whisper_cached_for_run,
    ensure_word_aligner_for_run,
    skip_steps_from_enabled,
    transcribe_run_config,
)
from podcast_mcp.util.coded_error import CodedError, CodedValueError, guest_message_for_code
from podcast_mcp.util.model_missing import ModelMissing

log = logging.getLogger(__name__)

JOB_NOT_FOUND = "Job not found"
STEP_NOT_SHARED = "That step is not available on a share link."
RUN_ATTENDED = "The host set this project to attended runs; ask the host to start it."
GUEST_BLOCKED_STEPS = frozenset({"export_deliverables"})
GUEST_MOVE_LANE_SPAN_KEYS = (
    "from_lane",
    "to_lane",
    "source_start",
    "source_end",
    "mute_region",
    "words_moved",
    "history_head_id",
)
SPLIT_REFUSAL_STATUS = {"speaker_backend_unavailable": 409}


class GuestRefusal(CodedError):
    """A refusal with the HTTP status its twin answers with; the message is as the twin sends it."""

    def __init__(self, status: int, message: str, *, code: str) -> None:
        super().__init__(message, code=code)
        self.status = status


def guest_refusal(status: int, code: str) -> GuestRefusal:
    return GuestRefusal(status, guest_message_for_code(code), code=code)


def guest_only_keys(row: Mapping[str, Any], keys: Sequence[str]) -> dict[str, Any]:
    return {key: row[key] for key in keys}


def lookup_guest_job(
    jobs: JobManager, ws: ProjectWorkspace, job_id: str, kinds: frozenset[str]
) -> Job:
    """The share's job of one of *kinds*, else the shared 404."""
    job = guest_visible_job(jobs.get_job(job_id), ws.path, kinds)
    if job is None:
        raise GuestRefusal(404, JOB_NOT_FOUND, code="job_not_found")
    return job


def guest_projected_job(job: Job, ws: ProjectWorkspace, kinds: frozenset[str]) -> dict[str, Any]:
    projected = guest_job_view(job, ws.path, kinds)
    if projected is None:
        raise GuestRefusal(404, JOB_NOT_FOUND, code="job_not_found")
    return {"job": projected}


def guest_cancel_job(
    jobs: JobManager, ws: ProjectWorkspace, job: Job, kinds: frozenset[str]
) -> dict[str, Any]:
    cancelled = jobs.cancel(job.id)
    if cancelled is None:
        raise GuestRefusal(404, JOB_NOT_FOUND, code="job_not_found")
    return guest_projected_job(cancelled, ws, kinds)


def guest_job_status_view(
    jobs: JobManager, ws: ProjectWorkspace, kinds: frozenset[str]
) -> dict[str, Any]:
    return guest_status_view(jobs.status(), ws.path, kinds)


def _check_steps(
    from_step: str | None, only_step: str | None, skip_steps: list[str] | None
) -> None:
    if from_step and from_step not in STEP_NAMES:
        raise GuestRefusal(
            400, f"Unknown from_step: {from_step}", code="pipeline_from_step_unknown"
        )
    if only_step and only_step not in STEP_NAMES:
        raise GuestRefusal(
            400, f"Unknown only_step: {only_step}", code="pipeline_only_step_unknown"
        )
    bad = [s for s in skip_steps or [] if s not in STEP_NAMES]
    if bad:
        raise GuestRefusal(400, f"Unknown skip_steps: {bad}", code="pipeline_skip_steps_unknown")


def guest_start_pipeline_run(
    jobs: JobManager,
    ws: ProjectWorkspace,
    *,
    from_step: str | None,
    only_step: str | None,
    skip_steps: list[str] | None,
    force_transcribe: bool,
    retime_words: bool,
) -> dict[str, Any]:
    _check_steps(from_step, only_step, skip_steps)
    if {from_step, only_step} & GUEST_BLOCKED_STEPS:
        raise GuestRefusal(400, STEP_NOT_SHARED, code="pipeline_step_not_shared")
    working = config_store().get(ws.path, stage=False)
    if not working.unattended:
        raise GuestRefusal(409, RUN_ATTENDED, code="pipeline_attended")
    if skip_steps is None and working.enabled_steps is not None:
        skip_steps = skip_steps_from_enabled(working.enabled_steps)
    skip_steps = [*(skip_steps or []), *sorted(GUEST_BLOCKED_STEPS - set(skip_steps or []))]
    try:
        run_config = transcribe_run_config(
            working.config,
            force=force_transcribe,
            overwrite_edited=False,
            retime_words=retime_words,
        )
    except ValueError as exc:
        code = exc.code if isinstance(exc, CodedError) else "invalid_request"
        raise GuestRefusal(400, str(exc), code=code) from exc
    try:
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
    except WordAlignerMissingError as exc:
        log.info("guest pipeline run refused: word aligner unusable", exc_info=exc)
        raise guest_refusal(409, "model_needed") from exc
    job = jobs.start(
        ws.path,
        from_step=from_step,
        only_step=only_step,
        skip_steps=skip_steps,
        unattended=True,
        config=run_config,
    )
    projected = guest_job_view(job, ws.path, GUEST_PIPELINE_KINDS)
    if projected is None:
        raise GuestRefusal(500, "Pipeline job unavailable", code="pipeline_job_unavailable")
    return {"job": projected}


def guest_start_export(
    jobs: JobManager, ws: ProjectWorkspace, who: str, formats: Sequence[str] | None
) -> dict[str, Any]:
    specs = None if formats is None else [dict(GUEST_EXPORT_FORMATS[f]) for f in formats]
    job = jobs.start_export(ws.path, formats=specs, wait_for_rebuild=False)
    log.info("guest export started by=%s job=%s", who, job.id)
    return {"job": guest_job_projection(job)}


def _past_the_end(
    ws: ProjectWorkspace, track_id: str, enrollment: Mapping[str, Sequence[Any]] | None
) -> bool:
    track = ws.project.track_by_id(track_id)
    duration = track.media.duration_sec if track is not None and track.media else None
    spans = (span for spans in (enrollment or {}).values() for span in spans)
    return duration is not None and any(start >= duration for start, _end in spans)


def guest_start_speaker_split(
    jobs: JobManager,
    ws: ProjectWorkspace,
    who: str,
    *,
    track_id: str,
    speaker_count: int,
    names: list[str] | None,
    enrollment: dict[str, list[tuple[float, float]]] | None,
) -> dict[str, Any]:
    if _past_the_end(ws, track_id, enrollment):
        raise guest_refusal(400, "enrollment_past_end")
    try:
        job = jobs.start_split_speakers(
            ws.path,
            track_id=track_id,
            speaker_count=speaker_count,
            names=names,
            enrollment=enrollment,
        )
    except ModelMissing:
        raise
    except CodedValueError as exc:
        raise guest_refusal(SPLIT_REFUSAL_STATUS.get(exc.code, 400), exc.code) from exc
    log.info("guest speaker split started by=%s job=%s", who, job.id)
    return {"job": guest_job_projection(job)}


def guest_move_lane_span(
    ws: ProjectWorkspace,
    who: str,
    *,
    from_lane: str,
    to_lane: str,
    timeline_start: float,
    timeline_end: float,
) -> dict[str, Any]:
    try:
        moved = SpeakerService(ws).move_lane_span(
            from_lane, to_lane, timeline_start=timeline_start, timeline_end=timeline_end
        )
    except CodedValueError as exc:
        raise guest_refusal(400, exc.code) from exc
    view = guest_only_keys(moved, GUEST_MOVE_LANE_SPAN_KEYS)
    log.info("guest speaker move by=%s", who)
    return view
