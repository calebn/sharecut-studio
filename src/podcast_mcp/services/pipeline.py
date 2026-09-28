from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from podcast_mcp.config import load_defaults
from podcast_mcp.models import AutomationEnvelope, AutomationPoint, PipelineRun, PipelineStepLog
from podcast_mcp.pipeline import PipelineRunner
from podcast_mcp.pipeline import steps as pipeline_steps
from podcast_mcp.pipeline.helpers import ffmpeg
from podcast_mcp.render import render_preview_result, rerender_preview
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.progress import ProgressReporter
from podcast_mcp.util.project_state import render_lock
from podcast_mcp.util.text import count_noun

EXPORT_CANCELLED = "Export cancelled"


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


class PipelineService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

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
    ) -> PipelineRunResult:
        from podcast_mcp.services.pipeline_config import (
            ensure_whisper_cached_for_run,
            merge_pipeline_config,
        )

        ensure_whisper_cached_for_run(
            config=config,
            from_step=from_step,
            only_step=only_step,
            skip_steps=skip_steps,
        )
        self.ws.checkpoint()
        # Commit the "before" entry now so the index never holds an entry the file lacks.
        self.ws.save_merged(history_label="before pipeline run")
        defaults = merge_pipeline_config(config) if config is not None else None
        runner = PipelineRunner(defaults=defaults)
        pipeline_run = runner.run(
            self.ws.project,
            from_step=from_step,
            only_step=only_step,
            skip_steps=skip_steps,
            on_step_complete=lambda step: self.ws.save_merged(history_label=f"after {step}"),
            progress=progress,
            unattended=unattended,
            cancel_check=cancel_check,
        )
        self.ws.save_merged(history_label="after pipeline run")
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
            pts = [
                AutomationPoint(
                    **({"id": str(point["id"])} if "id" in point else {}),
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
                return rerender_preview(p, progress=progress)

            # mutate() re-reads the saved project under the cross-process lock, so Refresh renders it.
            # The render lock comes before mutate()'s project locks (lock order, #482).
            with render_lock(self.ws.project, cancel_check=cancel_check):
                return self.ws.mutate(
                    "before render preview",
                    "after render preview",
                    mutate,
                    operation="render_preview",
                )
        return json.loads(render_preview_result(self.ws.project, rerender=False))

    def render_final(self) -> Path:
        # Lock, then checkpoint: the wait can last minutes and the render must see the
        # project as saved when it ends (#482). The steps' own render_lock re-enters this hold.
        with render_lock(self.ws.project):
            self.ws.checkpoint()
            PipelineRunner().run(self.ws.project, from_step="master_loudness")
            self.ws.save_merged()
        from podcast_mcp.export.names import sanitize_export_stem

        wav = self.ws.project.export_dir() / f"{sanitize_export_stem(self.ws.project.name)}.wav"
        return wav if wav.is_file() else self.ws.project.export_dir()

    def export_audio(
        self,
        formats: list[dict] | None = None,
        *,
        cancel_check: Callable[[], bool] | None = None,
    ) -> list[Path]:
        defaults = load_defaults()
        export_cfg = dict(defaults.get("export", {}))
        if formats is not None:
            export_cfg["formats"] = formats
        from podcast_mcp.export.audio import export_episode_audio
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
                raise_if_cancel_requested(cancel_check, EXPORT_CANCELLED)
                prog.set_phase("master", "Preparing mastered WAV…")
                mastered = pipeline_steps.ensure_current_master(self.ws.project, defaults)
                prog.advance(1, message="Mastered WAV ready")
                raise_if_cancel_requested(cancel_check, EXPORT_CANCELLED)
                prog.set_phase("encode", "Writing deliverables…")
                paths = export_episode_audio(
                    self.ws.project,
                    ffmpeg(),
                    mastered,
                    export_cfg,
                    max_workers=defaults.get("performance", {}).get("max_workers"),
                )
            self.ws.save_merged()
            prog.advance(1, message="Export complete")
            return paths
