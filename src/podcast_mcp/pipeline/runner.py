from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.pipeline_unattended import is_unattended
from podcast_mcp.edits.transcript_refine_status import (
    load_status,
    precorrect_fingerprint,
    refine_mode_from_defaults,
    refresh_unattended_waiver,
    status_is_clear_payload,
    transcript_text_fingerprint,
)
from podcast_mcp.engines.reconciliation_state import mark_reconciliation_stale
from podcast_mcp.history import HistoryManager
from podcast_mcp.models import (
    EpisodeProject,
    PipelineRun,
    PipelineStepLog,
)
from podcast_mcp.pipeline import steps as pipeline_steps
from podcast_mcp.util.progress import (
    CancelledProgress,
    ProgressReporter,
    bind_progress,
    progress_task,
    resolve_progress,
)

StepFn = Callable[[EpisodeProject, dict], str | None]

AUDIO_AFFECTING_STEPS = frozenset(
    {
        "align_tracks",
        "clean_audio",
        "balance_tracks",
        "compress_tracks",
        "focus_from_transcript",
        "tighten_from_transcript",
        "render_dialogue_stems",
        "assemble_timeline",
        "mix_with_music",
    }
)

_STEP_MAP: dict[str, StepFn] = {
    "ingest_tracks": pipeline_steps.ingest_tracks,
    "transcribe_tracks": pipeline_steps.transcribe_tracks,
    "align_tracks": pipeline_steps.align_tracks,
    "require_align_accept": pipeline_steps.require_align_accept,
    "merge_transcript": pipeline_steps.merge_transcript,
    "render_dialogue_stems": pipeline_steps.render_dialogue_stems,
    "reconcile_transcript": pipeline_steps.reconcile_transcript,
    "precorrect_transcript": pipeline_steps.precorrect_transcript,
    "require_transcript_refine": pipeline_steps.require_transcript_refine,
    "analyze_focus_cuts": pipeline_steps.analyze_focus_cuts,
    "focus_from_transcript": pipeline_steps.focus_from_transcript,
    "analyze_fillers_pauses": pipeline_steps.analyze_fillers_pauses,
    "tighten_from_transcript": pipeline_steps.tighten_from_transcript,
    "clean_audio": pipeline_steps.clean_audio,
    "balance_tracks": pipeline_steps.balance_tracks,
    "compress_tracks": pipeline_steps.compress_tracks,
    "assemble_timeline": pipeline_steps.assemble_timeline,
    "mix_with_music": pipeline_steps.mix_with_music,
    "master_loudness": pipeline_steps.master_loudness,
    "export_deliverables": pipeline_steps.export_deliverables,
}

ORDERED_STEP_NAMES: list[str] = [
    "ingest_tracks",
    "transcribe_tracks",
    "align_tracks",
    "require_align_accept",
    "merge_transcript",
    "render_dialogue_stems",
    "reconcile_transcript",
    "precorrect_transcript",
    "require_transcript_refine",
    "analyze_focus_cuts",
    "focus_from_transcript",
    "analyze_fillers_pauses",
    "tighten_from_transcript",
    "clean_audio",
    "balance_tracks",
    "compress_tracks",
    "assemble_timeline",
    "reconcile_transcript",
    "mix_with_music",
    "master_loudness",
    "export_deliverables",
]

PIPELINE_STEPS: list[tuple[str, StepFn]] = [(name, _STEP_MAP[name]) for name in ORDERED_STEP_NAMES]

STEP_NAMES = ORDERED_STEP_NAMES

TRANSCRIBE_STEP = "transcribe_tracks"


def _current_run(project: EpisodeProject, run: PipelineRun) -> PipelineRun:
    """The run as the project holds it now: a merged save can swap the object."""
    return next((r for r in project.pipeline_runs if r.id == run.id), run)


def select_pipeline_steps(
    from_step: str | None,
    only_step: str | None,
    skip_steps: set[str] | None = None,
) -> list[tuple[str, StepFn]]:
    """Resolve which pipeline steps will run for the given selection args."""
    skip = skip_steps or set()
    if only_step:
        if only_step not in _STEP_MAP:
            raise ValueError(f"unknown step: {only_step}")
        if only_step in skip:
            return []
        return [(only_step, _STEP_MAP[only_step])]

    steps_list = list(PIPELINE_STEPS)
    if from_step:
        if from_step not in _STEP_MAP:
            raise ValueError(f"unknown step: {from_step}")
        idx = STEP_NAMES.index(from_step)
        steps_list = steps_list[idx:]
    if skip:
        steps_list = [(n, fn) for n, fn in steps_list if n not in skip]
    return steps_list


class PipelineRunner:
    def __init__(
        self,
        defaults: dict | None = None,
        history: HistoryManager | None = None,
    ) -> None:
        self.defaults = defaults if defaults is not None else load_defaults()
        self.history = history

    def run(
        self,
        project: EpisodeProject,
        *,
        from_step: str | None = None,
        only_step: str | None = None,
        skip_steps: list[str] | None = None,
        on_step_complete: Callable[[], None] | None = None,
        progress: ProgressReporter | None = None,
        unattended: bool = False,
        cancel_check: Callable[[], bool] | None = None,
    ) -> PipelineRun:
        run = PipelineRun(
            id=uuid.uuid4().hex[:12],
            started_at=datetime.now(UTC).isoformat(),
        )
        project.pipeline_runs.append(run)

        reporter = resolve_progress(progress)
        skip = set(skip_steps or [])
        unknown = skip - set(_STEP_MAP)
        if unknown:
            raise ValueError(f"unknown skip_steps: {sorted(unknown)}")
        selected = self._select_steps(from_step, only_step, skip)
        if not selected:
            raise ValueError("no pipeline steps selected to run")
        step_defaults = dict(self.defaults)
        if unattended:
            step_defaults["_pipeline_unattended"] = True
        if cancel_check is not None:
            step_defaults["_pipeline_cancel_check"] = cancel_check
        gate_status: dict[str, Any] | None = None
        gate_text_fingerprint: str | None = None

        with (
            bind_progress(reporter),
            progress_task(
                "pipeline",
                "Pipeline",
                total=len(selected),
                reporter=reporter,
                mark_id="pipeline",
            ) as pipe,
        ):
            for step_idx, (name, fn) in enumerate(selected, start=1):
                run = _current_run(project, run)
                if cancel_check is not None and cancel_check():
                    pipe.cancel("Pipeline cancelled")
                    raise CancelledProgress("Pipeline cancelled")
                log = PipelineStepLog(
                    step=name,
                    started_at=datetime.now(UTC).isoformat(),
                )
                run.steps.append(log)
                title = name
                try:
                    from podcast_mcp.pipeline.meta import step_meta

                    title = step_meta(name).title
                except KeyError:
                    pass
                with pipe.child(name, title) as step_prog:
                    # GUI job parser keys off "Running {step_id}" on the
                    # parent pipeline task (see gui/jobs._JobProgressReporter).
                    # Do not prefix child phase with "Running " — that would
                    # double-append step rows in the GUI parser.
                    reporter.message("pipeline", f"Running {name}")
                    step_prog.set_phase("running", title)
                    try:
                        summary = fn(project, step_defaults)
                        log.status = "ok"
                        if summary:
                            log.message = summary
                        log.finished_at = datetime.now(UTC).isoformat()
                        if name == "require_transcript_refine" and (
                            refine_mode_from_defaults(step_defaults) != "off"
                        ):
                            candidate = load_status(project)
                            if (
                                candidate is not None
                                and candidate.get("status") == "waived"
                                and candidate.get("source") == "unattended"
                                and status_is_clear_payload(
                                    candidate,
                                    fingerprint=precorrect_fingerprint(project),
                                )
                            ):
                                gate_status = candidate
                                gate_text_fingerprint = transcript_text_fingerprint(project)
                        if name in AUDIO_AFFECTING_STEPS:
                            mark_reconciliation_stale(project)
                        project.last_completed_step = name
                        if self.history is not None:
                            self.history.record(project, f"after {name}")
                        if on_step_complete is not None:
                            on_step_complete()
                        done_msg = f"Completed {name}"
                        if summary:
                            done_msg = f"{done_msg}: {summary}"
                        reporter.update(
                            "pipeline",
                            step_idx,
                            total=len(selected),
                            message=done_msg,
                        )
                        pipe.current = step_idx
                    except Exception as exc:
                        log.status = "error"
                        log.message = str(exc)
                        log.finished_at = datetime.now(UTC).isoformat()
                        raise

        if (
            gate_status is not None
            and gate_text_fingerprint is not None
            and is_unattended(
                flag=unattended,
                defaults=step_defaults,
            )
        ):
            refresh_unattended_waiver(
                project,
                gate_status=gate_status,
                gate_text_fingerprint=gate_text_fingerprint,
            )
        return _current_run(project, run)

    def _select_steps(
        self,
        from_step: str | None,
        only_step: str | None,
        skip_steps: set[str] | None = None,
    ) -> list[tuple[str, StepFn]]:
        return select_pipeline_steps(from_step, only_step, skip_steps)
