"""Clip-local mute-in-place spans (source-media seconds).

Applied MUTE decisions write ``Clip.mute_regions`` instead of rippling. Render
honours the list with ≤5 ms fades into silence so timeline length is unchanged.
"""

from __future__ import annotations

from collections.abc import Sequence

from podcast_mcp.edits.ranges import clamp_spans, subtract_ranges_from_intervals
from podcast_mcp.models import Clip, ClipMuteRegion, EpisodeProject

MUTE_FADE_SEC = 0.005


def intersect_mute_regions(
    regions: list[ClipMuteRegion],
    src_start: float,
    src_end: float,
) -> list[ClipMuteRegion]:
    """Keep the overlap of ``regions`` with ``[src_start, src_end)``."""
    clamped = clamp_spans(((r.start_s, r.end_s) for r in regions), src_start, src_end)
    return merge_mute_regions([ClipMuteRegion(start_s=s, end_s=e) for s, e in clamped])


def merge_mute_regions(regions: list[ClipMuteRegion]) -> list[ClipMuteRegion]:
    """Coalesce overlapping/adjacent source spans."""
    if not regions:
        return []
    ordered = sorted(regions, key=lambda r: (r.start_s, r.end_s))
    merged: list[ClipMuteRegion] = [ordered[0]]
    for region in ordered[1:]:
        prev = merged[-1]
        if region.start_s <= prev.end_s + 1e-6:
            merged[-1] = ClipMuteRegion(start_s=prev.start_s, end_s=max(prev.end_s, region.end_s))
        else:
            merged.append(region)
    return merged


def mute_regions_payload(regions: list[ClipMuteRegion]) -> list[dict[str, float]]:
    """Sorted ``{start_s, end_s}`` dicts for hashes, list_clips, and paste."""
    return sorted(
        ({"start_s": float(r.start_s), "end_s": float(r.end_s)} for r in regions),
        key=lambda row: (row["start_s"], row["end_s"]),
    )


def add_source_mute(clip: Clip, start: float, end: float) -> bool:
    """Add ``[start, end)`` in source-media seconds to ``clip.mute_regions``."""
    if end <= start:
        return False
    extra = intersect_mute_regions(
        [ClipMuteRegion(start_s=start, end_s=end)],
        clip.source_start,
        clip.source_end,
    )
    if not extra:
        return False
    clip.mute_regions = merge_mute_regions([*clip.mute_regions, *extra])
    return True


def subtract_source_mute(clip: Clip, start: float, end: float) -> bool:
    """Remove overlap of ``[start, end)`` from ``clip.mute_regions``."""
    if end <= start + 1e-9 or not clip.mute_regions:
        return False
    current = [(float(r.start_s), float(r.end_s)) for r in clip.mute_regions]
    remaining = subtract_ranges_from_intervals(current, [(float(start), float(end))])
    if remaining == current:
        return False
    clip.mute_regions = [ClipMuteRegion(start_s=s, end_s=e) for s, e in remaining]
    return True


def mute_spans_for_source_window(
    clip: Clip,
    src_start: float,
    src_end: float,
    extra: Sequence[ClipMuteRegion] = (),
) -> tuple[tuple[float, float], ...]:
    """Mute intervals inside ``[src_start, src_end)``, relative to ``src_start``.

    ``extra`` regions (e.g. ignored-word spans, #633) are merged in without being
    written to ``clip.mute_regions``.
    """
    spans: list[tuple[float, float]] = []
    combined = [*clip.mute_regions, *extra]
    for region in intersect_mute_regions(combined, src_start, src_end):
        spans.append((region.start_s - src_start, region.end_s - src_start))
    return tuple(spans)


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
