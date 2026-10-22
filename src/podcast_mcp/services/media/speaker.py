from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, replace
from typing import Any

from podcast_mcp.edits.speaker_split import (
    LOW_CONFIDENCE,
    LaneSpanMove,
    SplitMediaIdentity,
    ensure_splittable,
    move_lane_span,
    split_track_by_speaker,
)
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.speaker_id import (
    SpeakerBackend,
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
from podcast_mcp.engines.speaker_split import RATE, SpeakerAttribution, attribute_speakers
from podcast_mcp.engines.ungated_audio import load_mono_full
from podcast_mcp.engines.waveform_media import schedule_track_waveforms
from podcast_mcp.models import SpeakerSplitCrosstalk
from podcast_mcp.project.transcript_context import context_lock, load_transcript_context
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.progress import (
    ProgressReporter,
    raise_if_cancel_requested,
    resolve_progress,
    resolve_progress_task,
)
from podcast_mcp.util.timebase import TimelineSec
from podcast_mcp.util.tracks import track_audio_path


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
        workspace = self.ws.project.workspace_path()
        with context_lock(workspace):
            ctx = load_transcript_context(workspace)
            ctx.speaker_id = replace(
                ctx.speaker_id,
                expected_speaker_count=count,
                speaker_count_source=source,
            )
            path = ctx.save(workspace)
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
            defaults=self.ws.effective_config(),
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
                defaults=self.ws.effective_config(),
            )

        if dry_run:
            return label_track_home_speaker(
                self.ws.project,
                ctx.speaker_id,
                backend,
                track_ids=track_ids,
                dry_run=True,
                progress=resolve_progress(progress),
                defaults=self.ws.effective_config(),
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
                defaults=self.ws.effective_config(),
            )

        if dry_run:
            return run_speaker_attribution(
                self.ws.project,
                ctx,
                dry_run=True,
                progress=resolve_progress(progress),
                defaults=self.ws.effective_config(),
            )
        return self.ws.mutate(
            "before speaker attribute",
            "after speaker attribute",
            mutate,
        )

    def check_split(
        self,
        track_id: str,
        *,
        speaker_count: int | None = None,
        names: Sequence[str] | None = None,
        enrollment: Mapping[str, Sequence[tuple[float, float]]] | None = None,
    ) -> tuple[list[str], SpeakerBackend]:
        """The speaker names and embedding backend a split of ``track_id`` would use.

        Raises what ``split_speakers`` raises before it reads any audio, so a caller can
        refuse a split that cannot run without waiting for attribution.
        """
        ensure_splittable(self.ws.project, track_id)
        ctx = load_transcript_context(self.ws.project.workspace_path())
        count = speaker_count or (
            ctx.speaker_id.expected_speaker_count
            if ctx.speaker_id.speaker_count_source == "user"
            else None
        )
        if not count:
            raise CodedValueError(
                "a speaker split needs the speaker count: pass it, or set it with set-speaker-count",
                code="speaker_split_count_required",
            )
        for name, spans in (enrollment or {}).items():
            if not spans:
                raise CodedValueError(
                    f"{name} has no voice sample. Pick a stretch where only {name} is talking, "
                    f"or leave {name} out.",
                    code="enrollment_empty",
                )
            for start, end in spans:
                if not (math.isfinite(end) and 0 <= start < end):
                    raise _span_invalid(name, f"{start:g} to {end:g}")
        speakers = _speaker_names(count, names, list(enrollment or {}))
        backend = resolve_speaker_backend()
        if backend.name() == "mock":
            raise CodedValueError(
                "Speaker recognition isn't available on this computer. "
                "See the speaker setup instructions to enable it.",
                code="speaker_backend_unavailable",
            )
        return speakers, backend

    def split_speakers(
        self,
        track_id: str,
        *,
        speaker_count: int | None = None,
        names: Sequence[str] | None = None,
        enrollment: Mapping[str, Sequence[tuple[float, float]]] | None = None,
        crosstalk_mode: SpeakerSplitCrosstalk = "owner",
        room_tone_fill: bool = False,
        dry_run: bool = True,
        progress: ProgressReporter | None = None,
        cancel_check: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        """Attribute ``track_id``'s recording to its speakers, then split it into lanes.

        The speaker count is the caller's or the one the user set
        (``set_expected_speaker_count``); it is never guessed. ``enrollment`` maps a
        speaker's name to source spans of only that speaker, for some or all of them;
        the rest are clustered. ``names`` sets the order (it must hold every enrolled
        name); without it, enrolled speakers come first. Attribution runs before the
        project lock is taken; the split is one undoable mutation.
        """
        project = self.ws.project
        speakers, backend = self.check_split(
            track_id,
            speaker_count=speaker_count,
            names=names,
            enrollment=enrollment,
        )
        count = len(speakers)
        source_track = project.track_by_id(track_id)
        if source_track is None or source_track.media is None:
            raise CodedValueError(
                f"track {track_id} has no media to split",
                code="speaker_split_no_media",
            )
        media_identity = SplitMediaIdentity.capture(source_track.media)
        media_path = track_audio_path(project, track_id)
        samples = load_mono_full(media_path, sample_rate=RATE)
        attribution = attribute_speakers(
            samples,
            speaker_count=count,
            backend=backend,
            enrollment={
                speakers.index(name): list(spans) for name, spans in (enrollment or {}).items()
            },
            progress=resolve_progress(progress),
            cancel_check=cancel_check,
        )
        if dry_run:
            return _attribution_summary(attribution, speakers)
        raise_if_cancel_requested(cancel_check)
        result = self.ws.mutate(
            "before split speakers",
            "after split speakers",
            lambda p: split_track_by_speaker(
                p,
                track_id,
                attribution,
                media_identity=media_identity,
                names=speakers,
                crosstalk_mode=crosstalk_mode,
                room_tone_fill=room_tone_fill,
                defaults=self.ws.effective_config(),
            ),
            operation="split_speakers",
            params={
                "track_id": track_id,
                "speakers": speakers,
                "crosstalk_mode": crosstalk_mode,
                "room_tone_fill": room_tone_fill,
            },
        )
        for lane in result["lanes"][1:]:
            track = self.ws.project.track_by_id(lane["track_id"])
            if track is not None:
                schedule_track_waveforms(
                    self.ws.project, track, defaults=self.ws.effective_config()
                )
        from podcast_mcp.services.document_sync import after_agent_mutation

        after_agent_mutation(self.ws)
        return {
            **result,
            "history_head_id": self.ws.project.history.head_id(),
        }

    def move_lane_span(
        self,
        from_lane: str,
        to_lane: str,
        *,
        source_start: float | None = None,
        source_end: float | None = None,
        timeline_start: float | None = None,
        timeline_end: float | None = None,
    ) -> dict[str, Any]:
        """Move a source span from one speaker-split lane to a sibling lane (one undo step)."""
        project = self.ws.project
        if source_start is None or source_end is None:
            if timeline_start is None or timeline_end is None:
                raise CodedValueError(
                    "pass source_start and source_end or timeline_start and timeline_end",
                    code="speaker_move_lane_span_range_required",
                )
            mapped = SessionTimeline(project).map_timeline_span(
                from_lane,
                TimelineSec(timeline_start),
                TimelineSec(timeline_end),
            )
            if len(mapped) != 1:
                raise CodedValueError(
                    "timeline range must map to one continuous source span on the lane",
                    code="speaker_move_lane_span_timeline",
                )
            source_start, source_end = float(mapped[0][0]), float(mapped[0][1])
        move = LaneSpanMove(from_lane, to_lane, source_start, source_end)
        result = self.ws.mutate(
            f"before move lane span on {from_lane}",
            f"after move lane span to {to_lane}",
            lambda p: move_lane_span(p, move, defaults=self.ws.effective_config()),
            operation="move_lane_span",
            params=asdict(move),
        )
        from podcast_mcp.services.document_sync import after_agent_mutation

        after_agent_mutation(self.ws)
        return {
            **result,
            "history_head_id": self.ws.project.history.head_id(),
        }


def coerce_enrollment(
    raw: Mapping[str, Sequence[Sequence[float]]] | None,
) -> dict[str, list[tuple[float, float]]] | None:
    """An enrollment map from JSON-shaped ``[[start, end], ...]`` spans to what ``split_speakers`` takes."""
    if not raw:
        return None
    for name, spans in raw.items():
        for span in spans:
            if len(span) != 2:
                raise _span_invalid(name, repr(span))
    return {name: [(float(s), float(e)) for s, e in spans] for name, spans in raw.items()}


def _span_invalid(name: str, shown: str) -> CodedValueError:
    return CodedValueError(
        f"{name}'s voice sample {shown} isn't a usable time range. Give a start and end in "
        "seconds, at 0 or later, with the start before the end.",
        code="enrollment_span_invalid",
    )


def _speaker_names(count: int, names: Sequence[str] | None, enrolled: list[str]) -> list[str]:
    if names:
        if len(names) != count:
            raise CodedValueError(
                f"expected {count} speaker names, got {len(names)}",
                code="speaker_names_count_mismatch",
            )
        if len(set(names)) != len(names) or not all(name.strip() for name in names):
            raise CodedValueError(
                "speaker names must be different and not blank", code="speaker_names_invalid"
            )
        missing = [name for name in enrolled if name not in names]
        if missing:
            raise CodedValueError(
                f"enrolled speaker {missing[0]!r} is not one of the names",
                code="speaker_enrolled_name_unknown",
            )
        return list(names)
    if len(enrolled) > count:
        raise CodedValueError(
            f"{len(enrolled)} speakers enrolled but the speaker count is {count}",
            code="speaker_enrolled_count_mismatch",
        )
    return enrolled + [f"Speaker {i + 1}" for i in range(len(enrolled), count)]


def _attribution_summary(attribution: SpeakerAttribution, speakers: list[str]) -> dict[str, Any]:
    seconds = dict.fromkeys(speakers, 0.0)
    crosstalk = 0.0
    for turn in attribution.turns:
        seconds[speakers[turn.speakers[0]]] += turn.end - turn.start
        if turn.crosstalk:
            crosstalk += turn.end - turn.start
    return {
        "dry_run": True,
        "speakers": speakers,
        "method": attribution.method,
        "backend": attribution.backend,
        "turns": len(attribution.turns),
        "seconds_by_speaker": {name: round(sec, 2) for name, sec in seconds.items()},
        "crosstalk_sec": round(crosstalk, 2),
        "low_confidence_sec": round(
            sum(t.end - t.start for t in attribution.turns if t.confidence < LOW_CONFIDENCE), 2
        ),
    }
