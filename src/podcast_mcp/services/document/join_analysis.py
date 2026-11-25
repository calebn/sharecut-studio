"""Join quality, QA sweep, labelling and ranker training."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from podcast_mcp.edits import cut_safety
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.join_continuity import (
    assess_existing_join,
    assess_project_joins,
)
from podcast_mcp.edits.join_labels import record_label
from podcast_mcp.services.document.join_quality_results import (
    JoinQualityReport,
    JoinQualitySweep,
)
from podcast_mcp.services.document.join_results import JoinLabelResult, JoinTrainResult
from podcast_mcp.services.document.service_base import WorkspaceService
from podcast_mcp.util.coded_error import CodedValueError


class _JoinAnalysis(WorkspaceService):
    def join_quality(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        join_sec: float | None = None,
        cut_start: float | None = None,
        cut_end: float | None = None,
        timebase: str = "timeline",
        audio_caches: dict[str, TrackAudioCache] | None = None,
    ) -> JoinQualityReport:
        tid = self._resolve(track_id, speaker)
        tb: Literal["timeline", "source"] = "timeline" if timebase == "timeline" else "source"
        if cut_start is not None and cut_end is not None:
            proposed = cut_safety.assess_proposed_cut(
                self.ws.project,
                tid,
                float(cut_start),
                float(cut_end),
                timebase=tb,
                audio_caches=audio_caches,
                defaults=self.ws.effective_config(),
            )
            return JoinQualityReport.model_validate(proposed.to_dict())
        if join_sec is None:
            raise CodedValueError(
                "provide join_sec, or cut_start and cut_end", code="join_target_required"
            )
        existing = assess_existing_join(
            self.ws.project,
            tid,
            float(join_sec),
            timebase=tb,
            defaults=self.ws.effective_config(),
        )
        return JoinQualityReport.model_validate(existing.to_dict())

    def join_qa_sweep(self, *, track_id: str | None = None) -> JoinQualitySweep:
        return JoinQualitySweep.model_validate(
            assess_project_joins(
                self.ws.project, track_id=track_id, defaults=self.ws.effective_config()
            )
        )

    def join_label(
        self,
        *,
        track_id: str | None = None,
        speaker: str | None = None,
        join_sec: float,
        verdict: str,
        timebase: str = "source",
        note: str = "",
        play: bool = False,
        cut_start: float | None = None,
        cut_end: float | None = None,
    ) -> JoinLabelResult:
        from .play import PlayService

        tid = self._resolve(track_id, speaker)
        if verdict not in ("pass", "fail"):
            raise CodedValueError("verdict must be pass or fail", code="join_verdict_invalid")
        label_verdict: Literal["pass", "fail"] = "pass" if verdict == "pass" else "fail"
        features = self.join_quality(
            track_id=tid,
            join_sec=join_sec,
            cut_start=cut_start,
            cut_end=cut_end,
            timebase=timebase,
        )
        det_map = {d.name: d.score for d in features.detectors}
        label = record_label(
            self.ws.project,
            track_id=tid,
            join_sec=float(join_sec),
            verdict=label_verdict,
            timebase=timebase,
            cut_start=cut_start,
            cut_end=cut_end,
            note=note,
            features={
                "risk": features.risk,
                "detectors": det_map,
            },
            source="human",
        )
        played = False
        if play:
            from .play import PlayRequest

            PlayService(self.ws).play(
                PlayRequest(
                    source=f"processed:{tid}",
                    start_sec=max(0.0, float(join_sec) - 2.0),
                    end_sec=float(join_sec) + 2.0,
                )
            )
            played = True
        return JoinLabelResult(label=label.to_dict(), played=played, features=features)

    def join_train(
        self,
        *,
        labels_path: Path | None = None,
        out_path: Path | None = None,
    ) -> JoinTrainResult:
        from podcast_mcp.edits.join_labels import load_labels
        from podcast_mcp.edits.join_ranker import save_ranker, train_join_ranker

        labels = load_labels(
            self.ws.project,
            path=labels_path,
        )
        model = train_join_ranker(labels)
        dest = out_path or (self.ws.project.artifacts_dir() / "join_ranker.json")
        save_ranker(model, dest)
        return JoinTrainResult(model=model.to_dict(), path=str(dest), n_labels=len(labels))
