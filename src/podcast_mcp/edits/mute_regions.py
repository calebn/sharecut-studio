"""Clip-local mute-in-place spans (source-media seconds).

Applied MUTE decisions write ``Clip.mute_regions`` instead of rippling. Render
fades the clip out over the start of each region and back in over its end, at the
region's own fade lengths, and lays the region's room-tone ``fill`` under it
(digital silence without one), so timeline length is unchanged.

Only muting and unmuting move a region's edges. A clip cut through a region (split,
trim, roll, ripple delete, partial copy) keeps the region whole, past its own source
edges, so each piece stays silent up to the cut and fades only where the region does.
A trim keeps even a region its clip no longer overlaps: render ignores the part outside
the window, and extending the edge back plays the mute again. A roll gives both clips
over one recording the union of their regions, so a mute the join crosses stays silent.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.ranges import subtract_ranges_from_intervals
from podcast_mcp.models import Clip, ClipMuteRegion, EpisodeProject, RoomToneFill


def _with_span(region: ClipMuteRegion, start: float, end: float) -> ClipMuteRegion:
    return region.model_copy(update={"start_s": start, "end_s": end})


@dataclass(frozen=True)
class MuteSampleEnvelope:
    """A render envelope on its source sample grid."""

    first: int
    last: int
    fade_out: int
    fade_in: int

    def silent_span(self) -> tuple[int, int]:
        """Half-open sample run whose generated gain is exactly zero."""
        if self.fade_out + self.fade_in > self.last - self.first:
            return self.first, self.last
        return self.first + self.fade_out, self.last - self.fade_in + 1


@dataclass(frozen=True)
class MuteEnvelope:
    """One muted region's gain, in seconds from a render window's start.

    The gain falls to zero over the first ``fade_out_sec`` of ``[start, end)``, stays
    there and rises back to one over its last ``fade_in_sec``.
    """

    start: float
    end: float
    fade_out_sec: float
    fade_in_sec: float

    def samples(
        self, sample_rate: int, *, source_start: float = 0.0, origin: int = 0
    ) -> MuteSampleEnvelope:
        return MuteSampleEnvelope(
            math.floor((self.start + source_start) * sample_rate + 0.5) - origin,
            math.floor((self.end + source_start) * sample_rate + 0.5) - origin,
            math.floor(self.fade_out_sec * sample_rate + 0.5),
            math.floor(self.fade_in_sec * sample_rate + 0.5),
        )


def sample_mute_envelopes(
    envelopes: Sequence[MuteEnvelope],
    duration: float,
    sample_rate: int,
    *,
    source_start: float = 0.0,
    origin: int = 0,
) -> tuple[MuteSampleEnvelope, ...]:
    return tuple(
        envelope.samples(sample_rate, source_start=source_start, origin=origin)
        for envelope in envelopes
        if envelope.end > envelope.start + 1e-6 and envelope.end > 0 and envelope.start < duration
    )


def _envelopes(regions: Sequence[ClipMuteRegion], origin: float) -> list[MuteEnvelope]:
    """``regions`` as envelopes from ``origin``, merged where they overlap or abut.

    A merged envelope fades out as its first region does and back in as its last
    does, so every sample has one gain whatever the regions' fills.
    """
    out: list[MuteEnvelope] = []
    for region in sorted(regions, key=lambda r: (r.start_s, r.end_s)):
        env = MuteEnvelope(
            start=region.start_s - origin,
            end=region.end_s - origin,
            fade_out_sec=region.fade_out_ms / 1000.0,
            fade_in_sec=region.fade_in_ms / 1000.0,
        )
        if out and env.start <= out[-1].end + 1e-6:
            prev = out[-1]
            if env.end > prev.end:
                out[-1] = MuteEnvelope(prev.start, env.end, prev.fade_out_sec, env.fade_in_sec)
            continue
        out.append(env)
    return out


def mute_regions_overlapping(
    regions: list[ClipMuteRegion],
    src_start: float,
    src_end: float,
) -> list[ClipMuteRegion]:
    """``regions`` that overlap ``[src_start, src_end)``, whole, for a clip over that range."""
    return merge_mute_regions(
        [r for r in regions if r.end_s > src_start + 1e-9 and r.start_s < src_end - 1e-9]
    )


def merge_mute_regions(regions: list[ClipMuteRegion]) -> list[ClipMuteRegion]:
    """Coalesce overlapping/adjacent source spans that share a fill.

    A merged region fades out as its first part does and back in as its last does.
    """
    if not regions:
        return []
    ordered = sorted(regions, key=lambda r: (r.start_s, r.end_s))
    merged: list[ClipMuteRegion] = [ordered[0]]
    for region in ordered[1:]:
        prev = merged[-1]
        if region.fill == prev.fill and region.start_s <= prev.end_s + 1e-6:
            last = region if region.end_s > prev.end_s else prev
            merged[-1] = prev.model_copy(
                update={"end_s": last.end_s, "fade_in_ms": last.fade_in_ms}
            )
        else:
            merged.append(region)
    return merged


def mute_regions_payload(regions: list[ClipMuteRegion]) -> list[dict[str, Any]]:
    """Sorted region dicts (span, fades, optional fill) for hashes, list_clips, paste."""
    return sorted(
        (
            {
                "start_s": float(r.start_s),
                "end_s": float(r.end_s),
                "fade_out_ms": r.fade_out_ms,
                "fade_in_ms": r.fade_in_ms,
                **({"fill": r.fill.model_dump()} if r.fill is not None else {}),
            }
            for r in regions
        ),
        key=lambda row: (row["start_s"], row["end_s"]),
    )


def _without_span(regions: list[ClipMuteRegion], start: float, end: float) -> list[ClipMuteRegion]:
    """``regions`` minus ``[start, end)``; each remaining piece keeps its fill and fades."""
    return [
        _with_span(region, s, e)
        for region in regions
        for s, e in subtract_ranges_from_intervals([(region.start_s, region.end_s)], [(start, end)])
    ]


def add_source_mute(clip: Clip, region: ClipMuteRegion) -> bool:
    """Mute ``region`` (source-media seconds, with its fill and fades) in ``clip``.

    The new span replaces whatever fill an existing region had under it.
    """
    if not mute_regions_overlapping([region], clip.source_start, clip.source_end):
        return False
    kept = _without_span(clip.mute_regions, region.start_s, region.end_s)
    clip.mute_regions = merge_mute_regions([*kept, region])
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
) -> tuple[MuteEnvelope, ...]:
    """Intersecting mute envelopes relative to ``src_start``; endpoints stay unclipped.

    ``extra`` regions (e.g. ignored-word spans, #633) are merged in without being
    written to ``clip.mute_regions``.
    """
    window = src_end - src_start
    envelopes = _envelopes([*clip.mute_regions, *extra], src_start)
    return tuple(e for e in envelopes if e.end > 0 and e.start < window)


def room_tone_fills_for_source_window(
    clip: Clip, src_start: float, src_end: float
) -> tuple[tuple[MuteEnvelope, RoomToneFill], ...]:
    """``clip``'s filled mutes that intersect the window, relative to ``src_start``.

    Endpoints stay unclipped, as in :func:`mute_spans_for_source_window`, so the fill
    fades in and out across the region's own fades.
    """
    window = src_end - src_start
    return tuple(
        (env, region.fill)
        for region in clip.mute_regions
        if region.fill is not None
        for env in _envelopes([region], src_start)
        if env.end > 0 and env.start < window
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
        """Ignored spans for ``clip``'s transcript that overlap its source range."""
        raw = self._raw_for(clip.track_id, clip.source_id)
        if not raw:
            return []
        return mute_regions_overlapping(raw, clip.source_start, clip.source_end)
