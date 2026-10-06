"""Clip-local mute-in-place spans (source-media seconds).

Applied MUTE decisions write ``Clip.mute_regions`` instead of rippling. Render
fades the clip out of and back into each span over ``MUTE_FADE_SEC`` and lays the
region's room-tone ``fill`` under it (digital silence without one), so timeline
length is unchanged.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from podcast_mcp.edits.ranges import clamp_spans, subtract_ranges_from_intervals
from podcast_mcp.models import Clip, ClipMuteRegion, EpisodeProject, RoomToneFill

MUTE_FADE_SEC = 0.005


def _with_span(region: ClipMuteRegion, start: float, end: float) -> ClipMuteRegion:
    return ClipMuteRegion(start_s=start, end_s=end, fill=region.fill)


def intersect_mute_regions(
    regions: list[ClipMuteRegion],
    src_start: float,
    src_end: float,
) -> list[ClipMuteRegion]:
    """Keep the overlap of ``regions`` with ``[src_start, src_end)``, each with its fill."""
    clamped = [
        _with_span(region, s, e)
        for region in regions
        for s, e in clamp_spans([(region.start_s, region.end_s)], src_start, src_end)
    ]
    return merge_mute_regions(clamped)


def merge_mute_regions(regions: list[ClipMuteRegion]) -> list[ClipMuteRegion]:
    """Coalesce overlapping/adjacent source spans that share a fill."""
    if not regions:
        return []
    ordered = sorted(regions, key=lambda r: (r.start_s, r.end_s))
    merged: list[ClipMuteRegion] = [ordered[0]]
    for region in ordered[1:]:
        prev = merged[-1]
        if region.fill == prev.fill and region.start_s <= prev.end_s + 1e-6:
            merged[-1] = _with_span(prev, prev.start_s, max(prev.end_s, region.end_s))
        else:
            merged.append(region)
    return merged


def mute_regions_payload(regions: list[ClipMuteRegion]) -> list[dict[str, Any]]:
    """Sorted ``{start_s, end_s[, fill]}`` dicts for hashes, list_clips, and paste."""
    return sorted(
        (
            {
                "start_s": float(r.start_s),
                "end_s": float(r.end_s),
                **({"fill": r.fill.model_dump()} if r.fill is not None else {}),
            }
            for r in regions
        ),
        key=lambda row: (row["start_s"], row["end_s"]),
    )


def _without_span(regions: list[ClipMuteRegion], start: float, end: float) -> list[ClipMuteRegion]:
    """``regions`` minus ``[start, end)``; each remaining piece keeps its fill."""
    return [
        _with_span(region, s, e)
        for region in regions
        for s, e in subtract_ranges_from_intervals([(region.start_s, region.end_s)], [(start, end)])
    ]


def add_source_mute(
    clip: Clip, start: float, end: float, *, fill: RoomToneFill | None = None
) -> bool:
    """Mute ``[start, end)`` (source-media seconds) in ``clip`` over ``fill``.

    The new span replaces whatever fill an existing region had under it.
    """
    if end <= start:
        return False
    extra = intersect_mute_regions(
        [ClipMuteRegion(start_s=start, end_s=end, fill=fill)],
        clip.source_start,
        clip.source_end,
    )
    if not extra:
        return False
    (added,) = extra
    kept = _without_span(clip.mute_regions, added.start_s, added.end_s)
    clip.mute_regions = merge_mute_regions([*kept, added])
    return True


def muted_source_spans(project: EpisodeProject) -> dict[str, list[ClipMuteRegion]]:
    """Merged ``clip.mute_regions`` spans per track, fill or not: what render mutes."""
    by_track: dict[str, list[ClipMuteRegion]] = {}
    for clip in project.clips:
        by_track.setdefault(clip.track_id, []).extend(
            ClipMuteRegion(start_s=r.start_s, end_s=r.end_s) for r in clip.mute_regions
        )
    return {
        track_id: merge_mute_regions(regions) for track_id, regions in by_track.items() if regions
    }


def source_span_is_muted(regions: Sequence[ClipMuteRegion], start: float, end: float) -> bool:
    """True when merged ``regions`` fully cover ``[start, end)`` (within 1 ms)."""
    return any(r.start_s <= start + 1e-3 and r.end_s >= end - 1e-3 for r in regions)


def subtract_source_mute(clip: Clip, start: float, end: float) -> bool:
    """Remove overlap of ``[start, end)`` from ``clip.mute_regions``."""
    if end <= start + 1e-9 or not clip.mute_regions:
        return False
    remaining = _without_span(clip.mute_regions, start, end)
    if remaining == clip.mute_regions:
        return False
    clip.mute_regions = remaining
    return True


def mute_spans_for_source_window(
    clip: Clip,
    src_start: float,
    src_end: float,
    extra: Sequence[ClipMuteRegion] = (),
) -> tuple[tuple[float, float], ...]:
    """Intersecting mute envelopes relative to ``src_start``; endpoints stay unclipped.

    ``extra`` regions (e.g. ignored-word spans, #633) are merged in without being
    written to ``clip.mute_regions``.
    """
    spans: list[tuple[float, float]] = []
    combined = [*clip.mute_regions, *extra]
    for region in merge_mute_regions(combined):
        if region.end_s > src_start and region.start_s < src_end:
            spans.append((region.start_s - src_start, region.end_s - src_start))
    return tuple(spans)


def room_tone_fills_for_source_window(
    clip: Clip, src_start: float, src_end: float
) -> tuple[tuple[float, float, RoomToneFill], ...]:
    """``clip``'s filled mutes that intersect the window, relative to ``src_start``.

    Endpoints stay unclipped, as in :func:`mute_spans_for_source_window`, so render
    fades the fill only at a region's own edges.
    """
    return tuple(
        (region.start_s - src_start, region.end_s - src_start, region.fill)
        for region in clip.mute_regions
        if region.fill is not None and region.end_s > src_start and region.start_s < src_end
    )


class IgnoredWordRegions:
    """Ignored-word spans (#633) per clip, computed at render time.

    Read-only: nothing is written to ``clip.mute_regions``. The unclamped span list
    is built once per ``(track_id, source_id)`` transcript, so looping over C clips
    of one source costs O(W + C·k) rather than O(C·W).
    """

    def __init__(self, project: EpisodeProject) -> None:
        self._project = project
        self._raw: dict[tuple[str, str | None], list[ClipMuteRegion]] = {}

    def _raw_for(self, track_id: str, source_id: str | None) -> list[ClipMuteRegion]:
        key = (track_id, source_id)
        cached = self._raw.get(key)
        if cached is None:
            transcript = self._project.transcript_for_source(track_id, source_id)
            cached = (
                [
                    ClipMuteRegion(start_s=w.start, end_s=w.end)
                    for w in transcript.words
                    if w.ignored and w.end > w.start
                ]
                if transcript is not None
                else []
            )
            self._raw[key] = cached
        return cached

    def for_clip(self, clip: Clip) -> list[ClipMuteRegion]:
        """Ignored spans for ``clip``'s transcript, clamped to its source range."""
        raw = self._raw_for(clip.track_id, clip.source_id)
        if not raw:
            return []
        return intersect_mute_regions(raw, clip.source_start, clip.source_end)
