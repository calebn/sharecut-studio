from __future__ import annotations

from dataclasses import dataclass
from itertools import pairwise
from math import isfinite
from pathlib import Path
from typing import Any

from podcast_mcp.edits.range_edits import build_range_target, range_geometry
from podcast_mcp.engines.bleed_gate import bleed_gate_geometry
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.session_timeline import clip_timeline_overlap_to_source
from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
from podcast_mcp.engines.ungated_audio import raw_evidence_layout_reason
from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.util.intervals import (
    HalfOpenIntervalIndex,
    intersect_intervals,
    merge_intervals,
    subtract_intervals,
)
from podcast_mcp.util.process import CalledProcessError

MAX_REVIEW_CANDIDATES = 16
MAX_REVIEW_SECONDS = 4.0
MAX_REVIEW_EXCLUSIONS = 128


@dataclass(frozen=True)
class BleedReviewPreview:
    candidates: tuple[dict[str, Any], ...]
    exclusions: tuple[dict[str, Any], ...]
    reasons: tuple[str, ...]
    truncated: bool
    exclusions_truncated: bool = False


def bleed_review_candidates(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    limit: int = MAX_REVIEW_CANDIDATES,
) -> BleedReviewPreview:
    """Return unapproved targets without inferring owner absence from transcript text."""
    geometry = bleed_gate_geometry(project, track_id)
    exclusions: list[dict[str, Any]] = []
    for mapped in geometry.words:
        word = mapped.word
        kind = (
            "locked_word"
            if word.audibility_locked
            else "ignored_word"
            if word.ignored
            else "retained_word"
            if not word.suppressed
            else "uncertain_ownership"
            if word.audibility_status != "bleed" or not word.dominant_track
            else None
        )
        if kind:
            exclusions.extend(
                {"track_id": track_id, "start": float(a), "end": float(b), "reason": kind}
                for a, b in mapped.boundary_spans
            )
    exclusions.extend(
        {"track_id": track_id, "start": a, "end": b, "reason": "untranscribed_source"}
        for a, b in geometry.untranscribed_spans
    )
    if end <= start:
        return BleedReviewPreview((), (), ("empty_review_window",), False)
    exclusions = [
        {**row, "start": max(start, row["start"]), "end": min(end, row["end"])}
        for row in exclusions
        if row["end"] > start and row["start"] < end
    ]
    foreign_spans: dict[str, list[tuple[float, float]]] = {}
    for mapped in geometry.words:
        peer = mapped.word.dominant_track
        if mapped.is_candidate and peer:
            selected = intersect_intervals(
                [(float(a), float(b)) for a, b in mapped.spans], [(start, end)]
            )
            if selected:
                foreign_spans.setdefault(peer, []).extend(selected)
    peers = list(foreign_spans)
    for i, peer in enumerate(peers):
        for other in peers[i + 1 :]:
            exclusions.extend(
                {
                    "track_id": track_id,
                    "start": a,
                    "end": b,
                    "reason": "contradictory_foreign_peers",
                }
                for a, b in intersect_intervals(
                    merge_intervals(foreign_spans[peer]), merge_intervals(foreign_spans[other])
                )
            )

    def preview(
        rows: list[dict[str, Any]], reasons: tuple[str, ...], truncated: bool = False
    ) -> BleedReviewPreview:
        return BleedReviewPreview(
            tuple(rows),
            tuple(exclusions[:MAX_REVIEW_EXCLUSIONS]),
            reasons,
            truncated,
            len(exclusions) > MAX_REVIEW_EXCLUSIONS,
        )

    placements = range_geometry(project, [RangeInterval(start=start, end=end)], [track_id])
    placement_index = HalfOpenIntervalIndex.build(
        (clip.timeline_start, clip.timeline_end) for clip in placements
    )
    for i, first in enumerate(placements):
        for j in placement_index.overlapping_ordinals(first.timeline_start, first.timeline_end):
            if j <= i:
                continue
            second = placements[j]
            a = max(start, first.timeline_start, second.timeline_start)
            b = min(end, first.timeline_end, second.timeline_end)
            if b > a:
                exclusions.append(
                    {
                        "track_id": track_id,
                        "start": a,
                        "end": b,
                        "reason": "overlapping_receiving_placements",
                    }
                )
    layout = raw_evidence_layout_reason(project, track_id)
    if layout:
        return preview([], (layout,))
    track = project.track_by_id(track_id)
    if track is None:
        return preview([], ("missing_receiving_track",))
    protected = merge_intervals([(row["start"], row["end"]) for row in exclusions])
    reasons: set[str] = set()
    protected_index = HalfOpenIntervalIndex.build(protected)
    lane_placements = {track_id: (placements, placement_index)}
    durations: dict[Path, float | None] = {}

    def media_available(tid: str, a: float, b: float) -> bool:
        other = project.track_by_id(tid)
        if other is None or raw_evidence_layout_reason(project, tid):
            return False
        if tid not in lane_placements:
            clips = range_geometry(project, [RangeInterval(start=start, end=end)], [tid])
            lane_placements[tid] = (
                clips,
                HalfOpenIntervalIndex.build((c.timeline_start, c.timeline_end) for c in clips),
            )
        clips, index = lane_placements[tid]
        selected_clips = [clips[i] for i in index.overlapping_ordinals(a, b)]
        coverage = sorted(
            (max(a, c.timeline_start), min(b, c.timeline_end)) for c in selected_clips
        )
        if merge_intervals(coverage) != [(a, b)] or any(
            first[1] > second[0] for first, second in pairwise(coverage)
        ):
            return False
        for clip in selected_clips:
            source = clip_timeline_overlap_to_source(clip, a, b)
            if source is None:
                return False
            try:
                path = resolve_clip_audio_path(project, other, clip).resolve()
                if path not in durations:
                    try:
                        durations[path] = FFmpegEngine().probe(path).duration_sec
                    except (OSError, ValueError, CalledProcessError):
                        durations[path] = None
                duration = durations[path]
                if (
                    duration is None
                    or not isfinite(duration)
                    or not 0 <= source[0] < source[1] <= duration
                ):
                    return False
            except (OSError, ValueError):
                return False
        return True

    grouped: dict[tuple[str, str], list[tuple[float, float]]] = {}
    for mapped in geometry.words:
        if not mapped.is_candidate:
            continue
        peer_id = mapped.word.dominant_track
        if not peer_id or peer_id == track_id or project.track_by_id(peer_id) is None:
            reasons.add("missing_foreign_peer")
            continue
        for a, b in intersect_intervals(
            [(float(a), float(b)) for a, b in mapped.spans], [(start, end)]
        ):
            for i in placement_index.overlapping_ordinals(a, b):
                clip = placements[i]
                if clip.source_id != mapped.source_id:
                    continue
                selected = [(max(a, clip.timeline_start), min(b, clip.timeline_end))]
                if selected[0][1] <= selected[0][0]:
                    continue
                removes = [protected[j] for j in protected_index.overlapping_ordinals(*selected[0])]
                remaining = subtract_intervals(selected, removes)
                if remaining:
                    grouped.setdefault((clip.id, peer_id), []).extend(remaining)
    rows: list[dict[str, Any]] = []
    truncated = False
    by_id = {clip.id: clip for clip in placements}
    windows = sorted(
        (a, b, clip_id, peer)
        for (clip_id, peer), spans in grouped.items()
        for a, b in merge_intervals(spans)
    )
    for a, b, clip_id, peer in windows:
        while a < b:
            last = min(b, a + MAX_REVIEW_SECONDS)
            if not media_available(track_id, a, last):
                reasons.add("unavailable_owner_review_media")
                a = last
                continue
            if not media_available(peer, a, last):
                reasons.add("unavailable_peer_review_media")
                a = last
                continue
            if len(rows) >= limit:
                truncated = True
                break
            clip = by_id[clip_id]
            source = clip_timeline_overlap_to_source(clip, a, last)
            if source is None:
                reasons.add("unavailable_review_mapping")
                break
            target = build_range_target(project, [RangeInterval(start=a, end=last)], [track_id])
            rows.append(
                {
                    "track_id": track_id,
                    "peer_track_id": peer,
                    "timeline_start": a,
                    "timeline_end": last,
                    "source_id": clip.source_id,
                    "clip_id": clip.id,
                    "source_start": float(source[0]),
                    "source_end": float(source[1]),
                    "requires_review": True,
                    "target": target.model_dump(mode="json"),
                    "automatic_refusal_reasons": [],
                    "protection_basis": "transcript_metadata_only",
                }
            )
            a = last
        if truncated:
            break
    if not rows:
        reasons.add("no_eligible_review_intervals")
    return preview(rows, tuple(sorted(reasons)), truncated)
