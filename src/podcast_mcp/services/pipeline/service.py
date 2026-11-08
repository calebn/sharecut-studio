from __future__ import annotations

import copy
import hashlib
import json
import math
from collections.abc import Callable, Mapping
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from podcast_mcp.edits.envelopes import validate_envelope_point_times
from podcast_mcp.engines.stale_audio_streams import stale_stream_files, stale_stream_lines
from podcast_mcp.engines.timeline_render import timeline_duration_sec
from podcast_mcp.export.audio import ExportFormatSpec
from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    EpisodeProject,
    PipelineRun,
    PipelineStepLog,
)
from podcast_mcp.pipeline import PipelineRunner
from podcast_mcp.pipeline import steps as pipeline_steps
from podcast_mcp.pipeline.helpers import ffmpeg
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.pipeline.export_config import (
    ExportSettingsEvidence,
    canonical_export_defaults,
    canonical_settings_evidence,
)
from podcast_mcp.services.pipeline.export_variant import (
    ExportTarget,
    VariantExportResult,
    export_variant_bundle,
    project_commit_guard,
)
from podcast_mcp.services.pipeline.preview import render_preview_result, rerender_preview
from podcast_mcp.services.pipeline.run_intent import PipelineRetryUnavailable, PipelineRunIntent
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.model_missing import ModelMissing
from podcast_mcp.util.owned_stage import owned_stage_supported
from podcast_mcp.util.progress import ProgressReporter
from podcast_mcp.util.project_state import render_cancel_scope, render_lock
from podcast_mcp.util.text import count_noun

EXPORT_CANCELLED = "Export cancelled"


def stale_stream_notices(project: EpisodeProject) -> list[str]:
    """Notice lines for multi-stream media analyzed before analysis read the first stream."""
    return stale_stream_lines(project, stale_stream_files(project))


def format_export_qc_lines(
    export_qc: Mapping[str, Any] | None, qc_path: Path | str | None
) -> list[str]:
    """`Export QC: ok|FAILED (N issue[s]), M warning[s] (<path>)` plus one `  - issue` line each; [] if no export ran."""
    if export_qc is None:
        return []
    verdict = "ok" if export_qc.get("ok") else "FAILED"
    issues = list(export_qc.get("issues") or [])
    warnings = list(export_qc.get("warnings") or [])
    lines = [
        f"Export QC: {verdict} ({count_noun(len(issues), 'issue')}), "
        f"{count_noun(len(warnings), 'warning')} ({qc_path})"
    ]
    lines.extend(f"  - {issue}" for issue in issues)
    return lines


@dataclass(frozen=True)
class PipelineRunResult:
    """Outcome of a `PipelineService.run()` call: the last step and this run's QC verdict."""

    last_step: str
    steps: list[PipelineStepLog]
    export_qc: dict[str, Any] | None = None
    export_qc_path: Path | None = None

    @property
    def ok(self) -> bool:
        """True when this run exported no QC (nothing to fail), or its QC verdict is ok."""
        return self.export_qc is None or bool(self.export_qc.get("ok"))

    def qc_report_lines(self) -> list[str]:
        """This run's export QC verdict lines (empty when the run did not export)."""
        return format_export_qc_lines(self.export_qc, self.export_qc_path)

    def job_result(self) -> dict[str, Any] | None:
        """Compact QC verdict for a Studio job's terminal `result`; None when the run did not export."""
        if self.export_qc is None:
            return None
        return {
            "export_qc": {
                "ok": bool(self.export_qc.get("ok")),
                "issues": list(self.export_qc.get("issues") or []),
                "warnings": list(self.export_qc.get("warnings") or []),
            },
            "export_qc_path": str(self.export_qc_path) if self.export_qc_path else None,
        }


@dataclass(frozen=True)
class AudioExportResult:
    """The files an export wrote, and the master they were encoded from."""

    paths: list[Path]
    # ``master_qc.json``: the configured target and ceiling, the measured master and the
    # verdict. None when the master has no QC report.
    master: dict[str, Any] | None
    edit_head_id: str | None = None
    applied_settings: ExportSettingsEvidence | None = None

    def master_summary(self) -> str:
        """One line naming the configured target and ceiling and what the master measured."""
        if not self.master:
            return "Master QC report missing"
        target = (
            f"{self.master['target_integrated_lufs']} LUFS / "
            f"{self.master['target_true_peak_db']} dBTP"
        )
        measured = self.master.get("measured") or {}
        if measured.get("integrated_lufs") is None:
            return f"Mastered to target {target} (loudness unmeasured)"
        peak = measured.get("true_peak_db")
        # None (unread, or digital silence, which the parser stores as None) and non-finite
        # values are not a level; neither are bools or strings.
        peak_text = (
            f"{peak} dBTP"
            if isinstance(peak, int | float) and not isinstance(peak, bool) and math.isfinite(peak)
            else "no true-peak reading"
        )
        return (
            f"Mastered to target {target}; measured {measured['integrated_lufs']} LUFS / "
            f"{peak_text}"
        )

    def job_result(self) -> dict[str, Any]:
        result: dict[str, Any] = {"paths": [str(p) for p in self.paths], "master": self.master}
        if self.edit_head_id is not None:
            result["edit_head_id"] = self.edit_head_id
        if self.applied_settings is not None:
            result["applied_settings"] = self.applied_settings.to_record()
        return result


class PipelineService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

    def _run_defaults(self) -> dict[str, Any]:
        """The config a run or export uses: the Pipeline tab's staged working set, else shipped defaults."""
        from podcast_mcp.services.pipeline.config import run_defaults_for

        return run_defaults_for(self.ws.path)

    def run(
        self,
        *,
        from_step: str | None = None,
        only_step: str | None = None,
        skip_steps: list[str] | None = None,
        progress: ProgressReporter | None = None,
        unattended: bool = False,
        config: dict | None = None,
        cancel_check=None,
        on_model_wait: Callable[[PipelineRunIntent | PipelineRetryUnavailable], None] | None = None,
    ) -> PipelineRunResult:
        from podcast_mcp.services.pipeline.config import merge_pipeline_config

        defaults = merge_pipeline_config(config) if config is not None else self._run_defaults()
        return self._run_effective(
            defaults=copy.deepcopy(defaults),
            from_step=from_step,
            only_step=only_step,
            skip_steps=skip_steps,
            progress=progress,
            unattended=unattended,
            cancel_check=cancel_check,
            on_model_wait=on_model_wait,
        )

    def retry(
        self,
        intent: PipelineRunIntent,
        *,
        progress: ProgressReporter | None = None,
        cancel_check=None,
        on_model_wait: Callable[[PipelineRunIntent | PipelineRetryUnavailable], None] | None = None,
    ) -> PipelineRunResult:
        return self._run_effective(
            defaults=copy.deepcopy(intent.config),
            from_step=intent.from_step,
            only_step=intent.only_step,
            skip_steps=list(intent.skip_steps) or None,
            progress=progress,
            unattended=intent.unattended,
            cancel_check=cancel_check,
            on_model_wait=on_model_wait,
            intent=intent,
        )

    def _run_effective(
        self,
        *,
        defaults: dict[str, Any],
        from_step: str | None,
        only_step: str | None,
        skip_steps: list[str] | None,
        progress: ProgressReporter | None,
        unattended: bool,
        cancel_check,
        on_model_wait: Callable[[PipelineRunIntent | PipelineRetryUnavailable], None] | None,
        intent: PipelineRunIntent | None = None,
    ) -> PipelineRunResult:
        from podcast_mcp.services.pipeline.config import (
            ensure_whisper_cached_for_run,
            ensure_word_aligner_for_run,
        )

        revision = intent.saved_revision if intent is not None else self.ws.loaded_file_revision
        targets_unchanged = True
        transcribe = defaults.get("transcribe", {})
        destructive = bool(
            transcribe.get("overwrite_edited")
            and (transcribe.get("overwrite") or transcribe.get("retime_words"))
        )

        def transcript_target() -> str:
            data = self.ws.project.transcript_data.model_dump(mode="json")
            return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()

        initial_target = transcript_target() if destructive else None

        def save_progress(history_label: str | None = None) -> None:
            nonlocal revision, targets_unchanged
            before = transcript_target() if destructive else None
            revision = None
            revision = self.ws.save_merged(history_label=history_label)
            if before is not None and before != transcript_target():
                targets_unchanged = False

        try:
            ensure_whisper_cached_for_run(
                config=defaults,
                resolved=True,
                from_step=from_step,
                only_step=only_step,
                skip_steps=skip_steps,
            )
            ensure_word_aligner_for_run(
                defaults,
                from_step=from_step,
                only_step=only_step,
                skip_steps=skip_steps,
                resolved=True,
            )
            with self.ws.transaction() if intent is not None else nullcontext():
                if intent is not None and (
                    self.ws.path.resolve() != intent.project_path
                    or self.ws.loaded_file_revision != intent.saved_revision
                ):
                    raise CodedValueError(
                        "The project changed. Review it before starting the run again.",
                        code="pipeline_retry_stale",
                    )
                self.ws.checkpoint()
                if initial_target is not None and initial_target != transcript_target():
                    targets_unchanged = False
                save_progress("before pipeline run")
            runner = PipelineRunner(defaults=copy.deepcopy(defaults))
            try:
                pipeline_run = runner.run(
                    self.ws.project,
                    from_step=from_step,
                    only_step=only_step,
                    skip_steps=skip_steps,
                    on_step_complete=lambda step: save_progress(f"after {step}"),
                    persist=save_progress,
                    progress=progress,
                    unattended=unattended,
                    cancel_check=cancel_check,
                )
                save_progress("after pipeline run")
            finally:
                from podcast_mcp.services.document_sync import after_agent_mutation

                after_agent_mutation(self.ws)
        except ModelMissing:
            if on_model_wait is not None:
                state: PipelineRunIntent | PipelineRetryUnavailable
                if not targets_unchanged:
                    state = PipelineRetryUnavailable("changed_targets")
                elif revision is None:
                    state = PipelineRetryUnavailable("unknown_revision")
                else:
                    state = PipelineRunIntent(
                        project_path=self.ws.path.resolve(),
                        config=copy.deepcopy(defaults),
                        from_step=from_step,
                        only_step=only_step,
                        skip_steps=tuple(skip_steps or []),
                        unattended=unattended,
                        saved_revision=revision,
                    )
                on_model_wait(state)
            raise
        return self._run_result(pipeline_run)

    def _run_result(self, pipeline_run: PipelineRun) -> PipelineRunResult:
        last_step = self.ws.project.last_completed_step or ""
        exported_ok = any(
            log.step == "export_deliverables" and log.status == "ok" for log in pipeline_run.steps
        )
        export_qc: dict[str, Any] | None = None
        qc_path: Path | None = None
        if exported_ok:
            qc_path = pipeline_steps.export_qc_path(self.ws.project)
            try:
                export_qc = pipeline_steps.read_export_qc(self.ws.project)
            except ValueError as exc:
                export_qc = {
                    "ok": False,
                    "issues": [f"export_qc.json unreadable: {exc}"],
                    "warnings": [],
                }
            if export_qc is None:
                export_qc = {
                    "ok": False,
                    "issues": ["export_qc.json missing after export"],
                    "warnings": [],
                }
        return PipelineRunResult(
            last_step=last_step,
            steps=list(pipeline_run.steps),
            export_qc=export_qc,
            export_qc_path=qc_path,
        )

    def set_envelope(self, track_id: str, points: list[dict]) -> int:
        def mutate(p) -> int:
            if p.track_by_id(track_id) is None:
                raise CodedValueError(
                    f"Volume envelope track {track_id!r} no longer exists",
                    code="envelope_track_missing",
                )
            validate_envelope_point_times(p, track_id, points, timeline_duration_sec(p))
            pts = [
                AutomationPoint(
                    id=str(point["id"]) if "id" in point else str(uuid4()),
                    time=float(point["time"]),
                    value=float(point["value"]),
                )
                for point in points
            ]
            # Replace only the volume envelope; other parameters (e.g. pan) are not ours.
            current = p.volume_envelope_for(track_id)
            if current is None:
                p.automation_envelopes.append(AutomationEnvelope(track_id=track_id, points=pts))
            else:
                index = next(i for i, e in enumerate(p.automation_envelopes) if e is current)
                p.automation_envelopes[index] = AutomationEnvelope(
                    track_id=track_id, parameter=current.parameter, points=pts
                )
            return len(pts)

        return self.ws.mutate(
            "before set envelope",
            f"after set envelope {track_id}",
            mutate,
        )

    def render_preview(
        self,
        *,
        rerender: bool = True,
        progress: ProgressReporter | None = None,
        cancel_check: Callable[[], bool] | None = None,
    ) -> dict:
        if rerender:

            def mutate(p) -> dict:
                return rerender_preview(p, progress=progress, defaults=self.ws.effective_config())

            # mutate() re-reads the saved project under the cross-process lock, so Refresh renders it.
            # The render lock comes before mutate()'s project locks (lock order, #482).
            # The cancel scope also stops the render between its steps (assemble, mix).
            with render_cancel_scope(cancel_check), render_lock(self.ws.project):
                return self.ws.mutate(
                    "before render preview",
                    "after render preview",
                    mutate,
                    operation="render_preview",
                )
        return json.loads(
            render_preview_result(
                self.ws.project, rerender=False, defaults=self.ws.effective_config()
            )
        )

    def render_final(self) -> Path:
        # Lock, then checkpoint: the wait can last minutes and the render must see the
        # project as saved when it ends (#482). The steps' own render_lock re-enters this hold.
        with render_lock(self.ws.project):
            self.ws.checkpoint()
            PipelineRunner(defaults=self._run_defaults()).run(
                self.ws.project, from_step="master_loudness", persist=self.ws.save_merged
            )
            self.ws.save_merged()
        from podcast_mcp.export.names import sanitize_export_stem

        wav = self.ws.project.export_dir() / f"{sanitize_export_stem(self.ws.project.name)}.wav"
        return wav if wav.is_file() else self.ws.project.export_dir()

    def export_audio(
        self,
        formats: list[dict] | None = None,
        *,
        cancel_check: Callable[[], bool] | None = None,
    ) -> AudioExportResult:
        defaults = canonical_export_defaults(self._run_defaults(), formats)
        captured: list[tuple[ExportFormatSpec, ...]] = []
        from podcast_mcp.export.episode import export_episode_deliverables
        from podcast_mcp.util.progress import raise_if_cancel_requested, resolve_progress_task

        with resolve_progress_task(
            "export",
            "Exporting deliverables",
            total=2,
            prefer_parent=True,
        ) as prog:
            with render_lock(self.ws.project, cancel_check=cancel_check):
                # Checkpoint after the wait: a render that held the lock may have committed
                # edits and published hashes for them meanwhile (#482).
                self.ws.checkpoint()
                edit_head_id = self.ws.project.history.edit_head_id()
                raise_if_cancel_requested(cancel_check, EXPORT_CANCELLED)
                prog.set_phase("master", "Preparing mastered WAV…")
                mastered = pipeline_steps.ensure_current_master(self.ws.project, defaults)
                prog.advance(1, message="Mastered WAV ready")
                raise_if_cancel_requested(cancel_check, EXPORT_CANCELLED)
                prog.set_phase("encode", "Writing deliverables…")
                paths = export_episode_deliverables(
                    self.ws.project,
                    ffmpeg(),
                    mastered,
                    defaults,
                    cancel_check=cancel_check,
                    persist_project=self.ws.save_merged,
                    capture_audio_plan=captured.append,
                )
            self.ws.save_merged()
            result = AudioExportResult(
                paths,
                pipeline_steps.read_master_qc(self.ws.project),
                edit_head_id,
                canonical_settings_evidence(defaults, captured[0]) if captured else None,
            )
            prog.advance(1, message=f"Export complete. {result.master_summary()}")
            return result

    def export_variant(
        self,
        target: ExportTarget,
        formats: list[dict[str, Any]] | None = None,
        *,
        cancel_check: Callable[[], bool] | None = None,
    ) -> VariantExportResult:
        """Export a named loudness variant from a positively verified current premix."""
        from podcast_mcp.util.progress import resolve_progress_task

        if not owned_stage_supported():
            raise CodedValueError(
                "This host cannot safely store isolated exports. Use the default export.",
                code="export_variant_storage_invalid",
            )

        with (
            resolve_progress_task(
                "export_variant",
                "Exporting loudness variant",
                total=1,
                prefer_parent=True,
            ) as _progress,
            render_lock(self.ws.project, cancel_check=cancel_check),
        ):
            self.ws.checkpoint()
            defaults = self._run_defaults()
            edit_head_id = self.ws.project.history.edit_head_id()

            def commit_guard(source_digest: str, identity: str):
                return project_commit_guard(
                    self.ws,
                    self._run_defaults,
                    target,
                    formats,
                    source_digest,
                    identity,
                    edit_head_id,
                )

            result = export_variant_bundle(
                self.ws.project,
                defaults,
                target,
                formats,
                pipeline_steps.ffmpeg(),
                edit_head_id=edit_head_id,
                cancel_check=cancel_check,
                commit_guard=commit_guard,
            )
            _progress.advance(1, message="Loudness variant complete")
            return result
