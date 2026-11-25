from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from podcast_mcp.engines.ducking import (
    DuckingParams,
    DuckingPlan,
    EnvPoint,
    dialogue_activity,
    dialogue_sources,
    plan_envelope,
    plan_token,
)
from podcast_mcp.engines.timeline_render import timeline_duration_sec
from podcast_mcp.models import EpisodeProject, TrackRole
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.document_sync.payloads import ENVELOPE_POINTS_MAX
from podcast_mcp.util.coded_error import CodedValueError

_AUTO_ROLES = frozenset({TrackRole.MUSIC})


class _DuckFlag(Protocol):
    duck_under_dialogue: bool


class SegmentLibrary(Protocol):
    def get(self, segment_id: str, version: int | None = None) -> _DuckFlag: ...


@dataclass
class DuckingTrackPlan:
    track_id: str
    plan: DuckingPlan
    current: list[EnvPoint]

    @property
    def changed(self) -> bool:
        return self.plan.points != self.current

    def summary(self, *, with_points: bool) -> Mapping[str, Any]:
        out: dict[str, Any] = {
            "track_id": self.track_id,
            "changed": self.changed,
            "regions": len(self.plan.regions),
            "points": len(self.plan.points),
            "generated": self.plan.generated,
            "lowered_user_points": self.plan.lowered,
            "replaced_generated": self.plan.replaced_generated,
            "kept_user_points": self.plan.kept_user_points,
            "coarsened": self.plan.coarsened,
            "min_gap_sec": self.plan.min_gap_sec,
        }
        if with_points:
            out["speech_regions"] = [[s, e] for s, e in self.plan.regions]
            out["envelope"] = [p._asdict() for p in self.plan.points]
        return out


@dataclass
class DuckingPlans:
    depth_db: float
    dialogue_track_ids: list[str]
    tracks: list[DuckingTrackPlan]
    warnings: list[str] = field(default_factory=list)

    @property
    def token(self) -> str:
        return plan_token({t.track_id: t.plan.points for t in self.tracks})

    @property
    def changed(self) -> bool:
        return any(t.changed for t in self.tracks)

    def envelopes(self) -> Mapping[str, list[dict[str, Any]]]:
        return {t.track_id: [p._asdict() for p in t.plan.points] for t in self.tracks}

    def result(self, *, with_points: bool) -> Mapping[str, Any]:
        return {
            "plan_token": self.token,
            "depth_db": self.depth_db,
            "dialogue_track_ids": self.dialogue_track_ids,
            "tracks": [t.summary(with_points=with_points) for t in self.tracks],
            "warnings": self.warnings,
        }


def _explicit_targets(project: EpisodeProject, track_ids: Sequence[str]) -> list[str]:
    out: list[str] = []
    for track_id in dict.fromkeys(track_ids):
        track = project.track_by_id(track_id)
        if track is None:
            raise CodedValueError(
                f"Track {track_id!r} does not exist, so it cannot be ducked.",
                code="ducking_unknown_track",
            )
        if track.role == TrackRole.DIALOGUE:
            raise CodedValueError(
                f"Track {track_id!r} is a dialogue track. Ducking lowers music and sound "
                "tracks under speech, never the speech itself.",
                code="ducking_dialogue_target",
            )
        out.append(track_id)
    return out


def _segment_tracks(
    project: EpisodeProject, store: SegmentLibrary | None, warnings: list[str]
) -> list[str]:
    wanted: dict[str, bool] = {}
    library: SegmentLibrary | None = store
    found: list[str] = []
    for track in project.tracks:
        if track.role == TrackRole.DIALOGUE or track.muted:
            continue
        for clip in project.clips:
            ref = clip.segment_ref
            if clip.track_id != track.id or ref is None:
                continue
            key = f"{ref.segment_id}@{ref.version}"
            if key not in wanted:
                library = library or SegmentStore()
                try:
                    wanted[key] = library.get(ref.segment_id, ref.version).duck_under_dialogue
                except (CodedValueError, OSError) as exc:
                    wanted[key] = False
                    warnings.append(
                        f"Segment {ref.segment_id} version {ref.version} on track "
                        f"{track.id!r} could not be read from the library ({exc}), so its "
                        "duck-under-dialogue setting was not applied."
                    )
            if wanted[key]:
                found.append(track.id)
                break
    return found


def select_targets(
    project: EpisodeProject,
    track_ids: Sequence[str] | None,
    warnings: list[str],
    store: SegmentLibrary | None = None,
) -> list[str]:
    if track_ids is not None:
        return _explicit_targets(project, track_ids)
    music = [
        t.id
        for t in project.tracks
        if t.role in _AUTO_ROLES and t.media is not None and not t.muted
    ]
    chosen = list(dict.fromkeys([*music, *_segment_tracks(project, store, warnings)]))
    if not chosen:
        raise CodedValueError(
            "No music or duck-under-dialogue segment track to duck. Name the tracks with track_ids.",
            code="ducking_no_targets",
        )
    return chosen


def plan_ducking(
    project: EpisodeProject,
    payload: Mapping[str, Any],
    defaults: Mapping[str, Any],
    store: SegmentLibrary | None = None,
) -> DuckingPlans:
    warnings: list[str] = []
    targets = select_targets(project, payload.get("track_ids"), warnings, store)
    sources = dialogue_sources(project, payload.get("dialogue_track_ids"))
    if not any(
        transcript.words
        for track_id in sources
        for _, transcript in project.selected_source_transcripts(track_id)
    ):
        raise CodedValueError(
            "No dialogue transcript to read speech from, so there is nothing to duck under. "
            "Transcribe the dialogue tracks first.",
            code="ducking_no_dialogue_activity",
        )
    depth = payload.get("depth_db")
    params = DuckingParams(
        depth_db=float(defaults["mix"]["music_under_vo_db"] if depth is None else depth),
        attack_sec=float(payload["attack_sec"]),
        hold_sec=float(payload["hold_sec"]),
        release_sec=float(payload["release_sec"]),
        min_gap_sec=float(payload["min_gap_sec"]),
        min_speech_sec=float(payload["min_speech_sec"]),
    )
    spans = dialogue_activity(project, sources)
    duration = timeline_duration_sec(project)
    tracks: list[DuckingTrackPlan] = []
    for track_id in targets:
        envelope = project.volume_envelope_for(track_id)
        current = (
            [EnvPoint(p.id, p.time, p.value) for p in envelope.points]
            if envelope is not None
            else []
        )
        plan = plan_envelope(spans, current, params, duration, ENVELOPE_POINTS_MAX)
        tracks.append(DuckingTrackPlan(track_id, plan, current))
    return DuckingPlans(params.depth_db, sources, tracks, warnings)


def check_plan_token(plans: DuckingPlans, expected: str | None) -> None:
    if expected is not None and expected != plans.token:
        raise DocumentConflictError(
            "The project changed since this ducking was planned, so nothing was applied. "
            "Run a dry run again and apply the new plan."
        )
