"""Central source <-> session-timeline mapping.

This is the ONLY module allowed to do clip time math (enforced by
``tests/test_timebase_guards.py``). Everything that touches rendered audio
(stems, premix, mastered, exports) must translate stored source-clock times
through :class:`SessionTimeline` instead of reading ``clip.timeline_start`` /
``clip.source_start`` directly.

Indexes are cached per clip-set fingerprint, so no invalidation hooks are
needed: any clip mutation produces a new fingerprint and a fresh index.
"""

from __future__ import annotations

import itertools
from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol

from podcast_mcp.models import Clip, EpisodeProject
from podcast_mcp.util.timebase import SourceSec, TimelineSec

DEFAULT_MERGE_GAP_SEC = 0.15

_EPS = 1e-9
_MERGE_EPS = 1e-6

_ClipKey = tuple[float, float, float]  # (timeline_start, source_start, source_end)


def origin_track_id_for_clip(project: EpisodeProject, clip: Clip) -> str:
    """Track whose media this clip plays (``source_id`` path, else current lane)."""
    if clip.source_id:
        src = next((s for s in project.sources if s.id == clip.source_id), None)
        if src is not None:
            for track in project.tracks:
                if track.media is not None and track.media.path == src.path:
                    return track.id
    return clip.track_id


@dataclass(frozen=True)
class _Span:
    timeline_start: float
    source_start: float
    source_end: float

    @property
    def duration(self) -> float:
        return self.source_end - self.source_start

    @property
    def timeline_end(self) -> float:
        return self.timeline_start + self.duration


@dataclass(frozen=True)
class _TrackIndex:
    by_timeline: tuple[_Span, ...]  # sorted by timeline_start
    by_source: tuple[_Span, ...]  # sorted by source_start
    timeline_starts: tuple[float, ...]
    source_starts: tuple[float, ...]
    # When spans don't overlap on a given axis, bisect can narrow candidates
    # to a constant-size window; duplicated segments break that guarantee.
    source_monotonic: bool
    timeline_monotonic: bool


def _is_monotonic(spans: tuple[_Span, ...], *, axis: str) -> bool:
    for prev, cur in itertools.pairwise(spans):
        prev_end = prev.source_end if axis == "source" else prev.timeline_end
        cur_start = cur.source_start if axis == "source" else cur.timeline_start
        if cur_start < prev_end - _EPS:
            return False
    return True


@lru_cache(maxsize=128)
def _build_index(clip_keys: tuple[_ClipKey, ...]) -> _TrackIndex:
    spans = [_Span(tl, ss, se) for tl, ss, se in clip_keys if se > ss + _EPS]
    by_timeline = tuple(sorted(spans, key=lambda s: s.timeline_start))
    by_source = tuple(sorted(spans, key=lambda s: s.source_start))
    return _TrackIndex(
        by_timeline=by_timeline,
        by_source=by_source,
        timeline_starts=tuple(s.timeline_start for s in by_timeline),
        source_starts=tuple(s.source_start for s in by_source),
        source_monotonic=_is_monotonic(by_source, axis="source"),
        timeline_monotonic=_is_monotonic(by_timeline, axis="timeline"),
    )


def _candidates_source(idx: _TrackIndex, lo: float, hi: float) -> tuple[_Span, ...]:
    """Spans that could overlap [lo, hi] on the source axis."""
    if not idx.source_monotonic:
        return idx.by_source
    start = max(0, bisect_right(idx.source_starts, lo + _EPS) - 1)
    stop = bisect_right(idx.source_starts, hi + _EPS)
    return idx.by_source[start:stop]


def _candidates_timeline(idx: _TrackIndex, lo: float, hi: float) -> tuple[_Span, ...]:
    """Spans that could overlap [lo, hi] on the timeline axis."""
    if not idx.timeline_monotonic:
        return idx.by_timeline
    start = max(0, bisect_right(idx.timeline_starts, lo + _EPS) - 1)
    stop = bisect_right(idx.timeline_starts, hi + _EPS)
    return idx.by_timeline[start:stop]


def _merge_intervals(
    intervals: list[tuple[float, float]], merge_gap: float
) -> list[tuple[float, float]]:
    intervals.sort()
    merged: list[tuple[float, float]] = []
    for s, e in intervals:
        if merged and s - merged[-1][1] <= merge_gap:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def map_timeline_spans_over_clips(
    clips: Sequence[Clip],
    timeline_spans: Sequence[tuple[float, float]],
    *,
    merge_gap: float = _MERGE_EPS,
) -> list[tuple[SourceSec, SourceSec]]:
    """Map timeline spans to source ranges over an explicit clip snapshot.

    Edit operations need this to translate remove windows against the clips as
    they were *before* the cut; :class:`SessionTimeline` always reflects the
    project's current clips.
    """
    keys = tuple((c.timeline_start, c.source_start, c.source_end) for c in clips)
    if not keys:
        return [(SourceSec(float(s)), SourceSec(float(e))) for s, e in timeline_spans if e > s]
    idx = _build_index(keys)
    out: list[tuple[float, float]] = []
    for tl_start, tl_end in timeline_spans:
        if tl_end <= tl_start:
            continue
        for span in _candidates_timeline(idx, float(tl_start), float(tl_end)):
            ov_start = max(float(tl_start), span.timeline_start)
            ov_end = min(float(tl_end), span.timeline_end)
            if ov_end <= ov_start + _EPS:
                continue
            src_start = span.source_start + (ov_start - span.timeline_start)
            out.append((src_start, src_start + (ov_end - ov_start)))
    return [(SourceSec(s), SourceSec(e)) for s, e in _merge_intervals(out, merge_gap)]


def clip_timeline_overlap_to_source(
    clip: Clip, tl_start: float, tl_end: float
) -> tuple[float, float] | None:
    """Map a timeline sub-range within one clip to source bounds.

    Edit/render code that works on clip lists (without a full project) should
    call this instead of inlining ``source_start + (tl - timeline_start)``.
    """
    if tl_end <= tl_start + _EPS:
        return None
    spans = map_timeline_spans_over_clips([clip], [(tl_start, tl_end)])
    if not spans:
        return None
    return float(spans[0][0]), float(spans[-1][1])


def clip_timeline_point_to_source(clip: Clip, timeline_sec: float) -> float:
    """Map one timeline second inside a clip to source media time."""
    mapped = clip_timeline_overlap_to_source(clip, timeline_sec, timeline_sec + 1e-6)
    if mapped is None:
        raise ValueError(
            f"timeline {timeline_sec}s is outside clip {clip.id!r} "
            f"[{clip.timeline_start}, {clip.timeline_end})"
        )
    return mapped[0]


class SourcePlacement(Protocol):
    """Anything placed on the timeline: a ``Clip`` or an index span."""

    @property
    def source_start(self) -> float: ...

    @property
    def timeline_start(self) -> float: ...


def clip_source_to_timeline_shift(clip: SourcePlacement) -> float:
    """Seconds to add to a source time inside ``clip`` to reach the timeline clock.

    ``timeline = source + shift``; its negation is the file time of timeline 0 for
    the clip's placement (negative when the clip starts after timeline 0).
    """
    return clip.timeline_start - clip.source_start


class SessionTimeline:
    """Bidirectional mapping between source media time and session timeline time.

    A track with no clips maps identically (source == timeline), matching how
    ingest treats un-clipped tracks.
    """

    def __init__(self, project: EpisodeProject) -> None:
        self._project = project

    def _index(self, track_id: str) -> _TrackIndex | None:
        keys = tuple(
            (c.timeline_start, c.source_start, c.source_end)
            for c in self._project.clips
            if origin_track_id_for_clip(self._project, c) == track_id
        )
        if not keys:
            return None
        return _build_index(keys)

    # --- Point mapping ---

    def source_to_timeline(self, track_id: str, sec: SourceSec) -> TimelineSec | None:
        """Timeline position of a source second, or None if the material was cut."""
        idx = self._index(track_id)
        if idx is None:
            return TimelineSec(float(sec))
        best: float | None = None
        for span in _candidates_source(idx, float(sec), float(sec)):
            if span.source_start - _EPS <= sec < span.source_end + _EPS:
                tl = span.timeline_start + (float(sec) - span.source_start)
                if best is None or tl < best:
                    best = tl
        return TimelineSec(best) if best is not None else None

    def timeline_to_source(self, track_id: str, sec: TimelineSec) -> SourceSec | None:
        """Source position of a timeline second, or None if it falls in a gap."""
        idx = self._index(track_id)
        if idx is None:
            return SourceSec(float(sec))
        for span in _candidates_timeline(idx, float(sec), float(sec)):
            if span.timeline_start - _EPS <= sec < span.timeline_end + _EPS:
                return SourceSec(span.source_start + (float(sec) - span.timeline_start))
        return None

    # --- Range mapping ---

    def map_source_span(
        self, track_id: str, start: SourceSec, end: SourceSec
    ) -> list[tuple[TimelineSec, TimelineSec]]:
        """Timeline intervals covering the surviving parts of a source span.

        A span crossing removed material may map to several intervals; parts
        entirely cut away are omitted. Adjacent results are merged.
        """
        if end <= start:
            return []
        idx = self._index(track_id)
        if idx is None:
            return [(TimelineSec(float(start)), TimelineSec(float(end)))]
        out: list[tuple[float, float]] = []
        for span in _candidates_source(idx, float(start), float(end)):
            ov_start = max(float(start), span.source_start)
            ov_end = min(float(end), span.source_end)
            if ov_end <= ov_start + _EPS:
                continue
            tl_start = span.timeline_start + (ov_start - span.source_start)
            out.append((tl_start, tl_start + (ov_end - ov_start)))
        return [(TimelineSec(s), TimelineSec(e)) for s, e in _merge_intervals(out, _MERGE_EPS)]

    def map_timeline_span(
        self, track_id: str, start: TimelineSec, end: TimelineSec
    ) -> list[tuple[SourceSec, SourceSec]]:
        """Source intervals backing a timeline span (gaps omitted, merged)."""
        if end <= start:
            return []
        idx = self._index(track_id)
        if idx is None:
            return [(SourceSec(float(start)), SourceSec(float(end)))]
        out: list[tuple[float, float]] = []
        for span in _candidates_timeline(idx, float(start), float(end)):
            ov_start = max(float(start), span.timeline_start)
            ov_end = min(float(end), span.timeline_end)
            if ov_end <= ov_start + _EPS:
                continue
            src_start = span.source_start + (ov_start - span.timeline_start)
            out.append((src_start, src_start + (ov_end - ov_start)))
        return [(SourceSec(s), SourceSec(e)) for s, e in _merge_intervals(out, _MERGE_EPS)]

    def source_to_timeline_clamped(self, track_id: str, sec: SourceSec) -> TimelineSec:
        """Best-effort point mapping for boundary math.

        Cut-away points clamp to the nearest surviving edge: beyond the last
        clip -> timeline end; inside a removed gap -> the timeline join where
        that gap was closed.
        """
        mapped = self.source_to_timeline(track_id, sec)
        if mapped is not None:
            return mapped
        idx = self._index(track_id)
        if idx is None or not idx.by_source:
            return TimelineSec(float(sec))
        last = idx.by_source[-1]
        if float(sec) >= last.source_end:
            return TimelineSec(last.timeline_end)
        for span in idx.by_source:
            if span.source_start > float(sec):
                return TimelineSec(span.timeline_start)
        return TimelineSec(last.timeline_end)

    # --- Transcript projection ---

    def word_intervals_timeline(
        self,
        track_id: str,
        tl_start: TimelineSec,
        tl_end: TimelineSec,
        *,
        include_suppressed: bool = False,
        merge_gap_sec: float = DEFAULT_MERGE_GAP_SEC,
    ) -> list[tuple[TimelineSec, TimelineSec]]:
        """Timeline spans of transcript words within a timeline window, merged.

        Words are stored in source coordinates; each is projected through the
        clip map before window clamping, so results line up with rendered
        stems even after ripple deletes compress the timeline.
        """
        tr = self._project.transcript_for_track(track_id)
        if not tr or tl_end <= tl_start:
            return []
        raw: list[tuple[float, float]] = []
        for w in tr.words:
            if w.suppressed and not include_suppressed:
                continue
            for s, e in self.map_source_span(track_id, SourceSec(w.start), SourceSec(w.end)):
                cs = max(float(s), float(tl_start))
                ce = min(float(e), float(tl_end))
                if ce > cs + _EPS:
                    raw.append((cs, ce))
        return [(TimelineSec(s), TimelineSec(e)) for s, e in _merge_intervals(raw, merge_gap_sec)]

    def timeline_extent(self, track_id: str) -> tuple[TimelineSec, SourceSec] | None:
        """(timeline end, source end at that point) of the last placed clip."""
        idx = self._index(track_id)
        if idx is None or not idx.by_timeline:
            return None
        last = max(idx.by_timeline, key=lambda s: s.timeline_end)
        return TimelineSec(last.timeline_end), SourceSec(last.source_end)

    # --- Diagnostics ---

    def is_identity(self, track_id: str) -> bool:
        """True when source and timeline clocks coincide for this track."""
        idx = self._index(track_id)
        if idx is None:
            return True
        return all(abs(clip_source_to_timeline_shift(s)) <= _EPS for s in idx.by_timeline)

    def drift_at(self, track_id: str, tl_sec: TimelineSec) -> float:
        """Source-minus-timeline offset at a timeline position (0 if unmapped)."""
        src = self.timeline_to_source(track_id, tl_sec)
        if src is not None:
            return float(src) - float(tl_sec)
        idx = self._index(track_id)
        if idx is None or not idx.by_timeline:
            return 0.0
        preceding = [s for s in idx.by_timeline if s.timeline_start <= float(tl_sec)]
        span = preceding[-1] if preceding else idx.by_timeline[0]
        return -clip_source_to_timeline_shift(span)

    def max_drift(self, track_id: str) -> float:
        """Largest absolute source-vs-timeline offset across the track's clips."""
        idx = self._index(track_id)
        if idx is None:
            return 0.0
        return max(
            (abs(clip_source_to_timeline_shift(s)) for s in idx.by_timeline),
            default=0.0,
        )


_DRIFT_WARN_SEC = 1.0


def timebase_qc_report(project: EpisodeProject) -> dict[str, Any]:
    """Per-track drift and unmapped transcript words for export/doctor QC.

    Source/timeline drift after cuts is expected on edited episodes - reported as
    ``warnings``, not a ship-blocker. Unmapped transcript words (wrong clock or
    cut-away) remain hard ``issues``.
    """
    st = SessionTimeline(project)
    tracks: dict[str, dict[str, float | int]] = {}
    issues: list[str] = []
    warnings: list[str] = []

    track_ids = {c.track_id for c in project.clips}
    for tr in project.transcripts:
        track_ids.add(tr.track_id)

    for track_id in sorted(track_ids):
        drift = st.max_drift(track_id)
        tracks[track_id] = {"max_drift_sec": drift}
        if drift > _DRIFT_WARN_SEC:
            warnings.append(
                f"Track {track_id!r} has {drift:.1f}s source/timeline drift "
                "(compressed timeline - ensure consumers use SessionTimeline)"
            )

    for tr in project.transcripts:
        unmapped = 0
        for w in tr.words:
            if w.suppressed:
                continue
            spans = st.map_source_span(tr.track_id, SourceSec(w.start), SourceSec(w.end))
            if not spans:
                unmapped += 1
        if unmapped:
            tracks.setdefault(tr.track_id, {"max_drift_sec": st.max_drift(tr.track_id)})
            tracks[tr.track_id]["unmapped_words"] = unmapped
            issues.append(
                f"Track {tr.track_id!r}: {unmapped} transcript word(s) fall outside "
                "clip source ranges (may be cut away or stored in wrong clock)"
            )

    return {
        "tracks": tracks,
        "warnings": warnings,
        "issues": issues,
        "ok": not issues,
    }
