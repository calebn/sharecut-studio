from __future__ import annotations

from dataclasses import replace
from typing import Any

from podcast_mcp.engines.speaker_id import (
    compare_window,
    enroll_segment,
    enroll_track,
    label_track_home_speaker,
    label_window,
    list_profiles,
    resolve_speaker_backend,
    run_speaker_attribution,
    score_window,
    speaker_doctor,
)
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.transcript_context import load_transcript_context
from podcast_mcp.util.progress import ProgressReporter, resolve_progress, resolve_progress_task


class SpeakerService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

    @staticmethod
    def doctor_static() -> dict[str, Any]:
        return speaker_doctor()

    def doctor(self) -> dict[str, Any]:
        return speaker_doctor()

    def profiles(self) -> list[dict[str, Any]]:
        return list_profiles(self.ws.project)

    def set_expected_speaker_count(
        self,
        count: int,
        *,
        source: str = "user",
    ) -> dict[str, Any]:
        ctx = load_transcript_context(self.ws.project.workspace_path())
        ctx.speaker_id = replace(
            ctx.speaker_id,
            expected_speaker_count=count,
            speaker_count_source=source,
        )
        path = ctx.save(self.ws.project.workspace_path())
        return {
            "expected_speaker_count": count,
            "speaker_count_source": source,
            "saved_to": str(path),
        }

    def enroll(
        self,
        *,
        track_id: str | None = None,
        speaker_id: str | None = None,
        start_sec: float | None = None,
        end_sec: float | None = None,
        home_track_id: str | None = None,
        progress: ProgressReporter | None = None,
    ) -> dict[str, Any]:
        ctx = load_transcript_context(self.ws.project.workspace_path())
        backend = resolve_speaker_backend()
        enrolled: list[str] = []

        if speaker_id and track_id and start_sec is not None and end_sec is not None:
            prof = enroll_segment(
                self.ws.project,
                speaker_id,
                track_id,
                start_sec,
                end_sec,
                ctx.speaker_id,
                backend,
                home_track_id=home_track_id,
                progress=progress,
            )
            if prof:
                enrolled.append(prof.speaker_id)
            return {"enrolled": enrolled, "backend": backend.name()}

        tracks = [track_id] if track_id else [t.id for t in self.ws.project.tracks if t.media]
        with resolve_progress_task(
            "speaker-enroll",
            "Speaker enrollment",
            total=len(tracks),
            prefer_parent=True,
            progress=progress,
        ) as task:
            for tid in tracks:
                prof = enroll_track(
                    self.ws.project,
                    tid,
                    ctx.speaker_id,
                    backend,
                    progress=None,
                )
                if prof:
                    enrolled.append(tid)
                task.advance(1, total=len(tracks))
        return {"enrolled": enrolled, "backend": backend.name()}

    def score(
        self,
        track_id: str,
        start_sec: float,
        end_sec: float,
    ) -> dict[str, Any]:
        ctx = load_transcript_context(self.ws.project.workspace_path())
        backend = resolve_speaker_backend()
        ws = score_window(
            self.ws.project,
            track_id,
            start_sec,
            end_sec,
            ctx.speaker_id,
            backend,
        )
        if ws is None:
            return {"error": "could not score window"}
        return ws.to_dict()

    def compare_window(
        self,
        start_sec: float,
        end_sec: float,
        *,
        track_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        ctx = load_transcript_context(self.ws.project.workspace_path())
        backend = resolve_speaker_backend()
        return compare_window(
            self.ws.project,
            start_sec,
            end_sec,
            ctx.speaker_id,
            backend,
            track_ids=track_ids,
        )

    def compare_pair(
        self,
        track_a: str,
        start_a: float,
        end_a: float,
        track_b: str,
        start_b: float,
        end_b: float,
    ) -> dict[str, Any]:
        ctx = load_transcript_context(self.ws.project.workspace_path())
        backend = resolve_speaker_backend()
        wa = score_window(self.ws.project, track_a, start_a, end_a, ctx.speaker_id, backend)
        wb = score_window(self.ws.project, track_b, start_b, end_b, ctx.speaker_id, backend)
        if wa is None or wb is None:
            return {"error": "could not score one or both windows"}
        same = wa.best_track_id == wb.best_track_id
        return {
            "same_speaker_likely": same,
            "window_a": wa.to_dict(),
            "window_b": wb.to_dict(),
        }

    def label(
        self,
        track_id: str,
        start_sec: float,
        end_sec: float,
        *,
        dry_run: bool = True,
    ) -> dict[str, Any]:
        ctx = load_transcript_context(self.ws.project.workspace_path())
        backend = resolve_speaker_backend()
        return label_window(
            self.ws.project,
            track_id,
            start_sec,
            end_sec,
            ctx.speaker_id,
            backend,
            dry_run=dry_run,
        )

    def gate_track(
        self,
        *,
        track_id: str | None = None,
        dry_run: bool = True,
        progress: ProgressReporter | None = None,
    ) -> dict[str, Any]:
        ctx = load_transcript_context(self.ws.project.workspace_path())
        backend = resolve_speaker_backend()
        track_ids = [track_id] if track_id else None

        def mutate(p):
            return label_track_home_speaker(
                p,
                ctx.speaker_id,
                backend,
                track_ids=track_ids,
                dry_run=False,
                progress=resolve_progress(progress),
            )

        if dry_run:
            return label_track_home_speaker(
                self.ws.project,
                ctx.speaker_id,
                backend,
                track_ids=track_ids,
                dry_run=True,
                progress=resolve_progress(progress),
            )
        return self.ws.mutate(
            "before speaker gate",
            "after speaker gate",
            mutate,
        )

    def attribute(
        self,
        *,
        dry_run: bool = True,
        progress: ProgressReporter | None = None,
    ) -> dict[str, Any]:
        ctx = load_transcript_context(self.ws.project.workspace_path())

        def mutate(p):
            return run_speaker_attribution(
                p,
                ctx,
                dry_run=False,
                progress=resolve_progress(progress),
            )

        if dry_run:
            return run_speaker_attribution(
                self.ws.project,
                ctx,
                dry_run=True,
                progress=resolve_progress(progress),
            )
        return self.ws.mutate(
            "before speaker attribute",
            "after speaker attribute",
            mutate,
        )
