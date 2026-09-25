from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

from podcast_mcp.config import load_defaults
from podcast_mcp.models import AutomationEnvelope, AutomationPoint
from podcast_mcp.pipeline import PipelineRunner
from podcast_mcp.pipeline import steps as pipeline_steps
from podcast_mcp.pipeline.helpers import ffmpeg
from podcast_mcp.render import render_preview_result, rerender_preview
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.progress import ProgressReporter


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
    ) -> str:
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
        runner.run(
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
        return self.ws.project.last_completed_step or ""

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
        self, *, rerender: bool = True, progress: ProgressReporter | None = None
    ) -> dict:
        if rerender:

            def mutate(p) -> dict:
                return rerender_preview(p, progress=progress)

            info = self.ws.mutate(
                "before render preview",
                "after render preview",
                mutate,
                operation="render_preview",
                # Refresh renders and commits the saved project, not the copy this job opened.
                reload_first=True,
            )
            return info
        return json.loads(render_preview_result(self.ws.project, rerender=False))

    def render_final(self) -> Path:
        self.ws.checkpoint()
        runner = PipelineRunner()
        runner.run(self.ws.project, from_step="master_loudness")
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
        self.ws.checkpoint()
        defaults = load_defaults()
        export_cfg = dict(defaults.get("export", {}))
        if formats is not None:
            export_cfg["formats"] = formats
        from podcast_mcp.export.audio import export_episode_audio
        from podcast_mcp.util.progress import CancelledProgress, resolve_progress_task

        def raise_if_cancelled() -> None:
            if cancel_check is not None and cancel_check():
                raise CancelledProgress("Export cancelled")

        with resolve_progress_task(
            "export",
            "Exporting deliverables",
            total=2,
            prefer_parent=True,
        ) as prog:
            raise_if_cancelled()
            prog.set_phase("master", "Preparing mastered WAV…")
            mastered = pipeline_steps.ensure_current_master(self.ws.project, defaults)
            prog.advance(1, message="Mastered WAV ready")
            raise_if_cancelled()
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
