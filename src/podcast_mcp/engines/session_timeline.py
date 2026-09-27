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
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from functools import lru_cache
from typing import Any, Protocol

from podcast_mcp.models import Clip, EpisodeProject
from podcast_mcp.util.intervals import HalfOpenIntervalIndex, merge_intervals
from podcast_mcp.util.timebase import SourceSec, TimelineSec

DEFAULT_MERGE_GAP_SEC = 0.15

_EPS = 1e-9
_MERGE_EPS = 1e-6
_REL_DRIFT_MIN_PIECE_SEC = 1.0  # ignore reference-edit slivers shorter than this

_ClipKey = tuple[float, float, float]  # (timeline_start, source_start, source_end)

ZERO_LENGTH_WORD_PAD_SEC = 0.001
# Whisper stamps words in 20 ms steps; an inversion within one step is a zero-length word,
# a larger one is corrupt timing (a bad merge or manual edit).
_INVERTED_WORD_TOL_SEC = 0.02


def word_source_span(start: float, end: float) -> tuple[SourceSec, SourceSec]:
    """Source span to map an ASR word by, padding a zero-length word (``end <= start``).

    Whisper emits zero-duration words; span mapping cannot place an empty span, so they
    map as ``[start, start + ZERO_LENGTH_WORD_PAD_SEC)``. The one convention for GUI word
    views and export/doctor timebase QC (#621).
    """
    s = float(start)
    e = float(end)
    return SourceSec(s), SourceSec(e if e > s else s + ZERO_LENGTH_WORD_PAD_SEC)


def _clip_source_path(project: EpisodeProject, clip: Clip) -> str | None:
    """Path of the source recording ``clip.source_id`` names, else ``None``."""
    if not clip.source_id:
        return None
    src = project.source_by_id(clip.source_id)
    return src.path if src is not None and src.path else None


def origin_track_id_for_clip(project: EpisodeProject, clip: Clip) -> str:
    """Track whose media this clip plays (``source_id`` path, else current lane)."""
    path = _clip_source_path(project, clip)
    if path is not None:
        for track in project.tracks:
            if track.media is not None and track.media.path == path:
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
    return merge_intervals(intervals, gap=merge_gap)


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


def clip_source_at_timeline(clip: SourcePlacement, timeline_sec: float) -> float:
    """Source clock at ``timeline_sec`` on ``clip``'s placement line, with no bounds check.

    The one copy of ``timeline - shift`` for callers that already own the membership
    rule: :func:`seam_source_clocks_over_clips` accepts a cut that starts exactly at a
    clip's ``timeline_end``, where :func:`clip_timeline_point_to_source` raises.
    """
    return timeline_sec - clip_source_to_timeline_shift(clip)


def seam_source_clocks_over_clips(
    clips: Sequence[Clip],
    timeline_start: float,
    timeline_end: float,
) -> tuple[SourceSec, SourceSec] | None:
    """Source clocks on either side of removing ``[timeline_start, timeline_end)``.

    ``pre`` is the source second at ``timeline_start`` on the clip that runs **into**
    the cut; ``post`` is the source second at ``timeline_end`` on the clip that runs
    **out of** it. Both come from ``clips`` in timeline order (never the source-sorted
    merged spans), so a span that crosses a clip moved out of source order still yields
    the joins the cut makes. A side that falls in a gap reads the source clock where
    the first (last) clip inside the cut, in timeline order, enters (leaves) it.
    Membership and both edge matches share ``_MERGE_EPS``, so a clip that only grazes
    the cut (overlap under 1 µs) is neither inside it nor a fallback anchor.
    Returns ``None`` when no clip material lies in the span.
    """
    ordered = sorted(clips, key=lambda c: c.timeline_start)
    inside = [
        c
        for c in ordered
        if min(timeline_end, c.timeline_end) - max(timeline_start, c.timeline_start) > _MERGE_EPS
    ]
    if not inside:
        return None
    pre = next(
        (
            clip_source_at_timeline(c, timeline_start)
            for c in ordered
            if c.timeline_start + _MERGE_EPS < timeline_start <= c.timeline_end + _MERGE_EPS
        ),
        clip_source_at_timeline(inside[0], max(timeline_start, inside[0].timeline_start)),
    )
    post = next(
        (
            clip_source_at_timeline(c, timeline_end)
            for c in ordered
            if c.timeline_start - _MERGE_EPS <= timeline_end < c.timeline_end - _MERGE_EPS
        ),
        clip_source_at_timeline(inside[-1], min(timeline_end, inside[-1].timeline_end)),
    )
    return SourceSec(pre), SourceSec(post)


SAME_SOURCE_OVERLAP_TOLERANCE_SEC = 0.05
_MIN_SLIP_SEC = 0.01


def slip_clip_to_shift(
    clip: Clip,
    target_shift: float,
    *,
    media_duration: float,
) -> tuple[float, float, float] | None:
    """Move ``clip``'s source range so its source-to-timeline shift becomes ``target_shift``.

    Unlike :func:`offset_to_clip_geometry`, the clip's timeline window is kept: only its
    source range slips by the delta between the current and target shift. A head that
    would land before the file start trims the clip instead (the timeline start moves
    later and the source start clamps to 0); a tail past ``media_duration`` clamps too.
    Returns ``None`` when the slip would leave the clip with no audio.
    """
    delta = target_shift - clip_source_to_timeline_shift(clip)
    src_start = clip.source_start - delta
    src_end = clip.source_end - delta
    tl_start = clip.timeline_start
    if src_start < 0:
        tl_start -= src_start
        src_start = 0.0
    if media_duration > 0:
        src_end = min(src_end, media_duration)
    if src_end - src_start < _MIN_SLIP_SEC:
        return None
    return src_start, src_end, tl_start


def clip_media_key(project: EpisodeProject, clip: Clip) -> str:
    """Media file identity a clip reads: ``sources[source_id].path``, else the lane's media."""
    path = _clip_source_path(project, clip)
    if path is not None:
        return path
    track = next((t for t in project.tracks if t.id == clip.track_id), None)
    if track is not None and track.media and track.media.path:
        return track.media.path
    return f"track:{clip.track_id}"


@dataclass(frozen=True)
class SourceStack:
    """Two clips on one lane that read the same media file and overlap on the timeline."""

    track_id: str
    media: str
    clip_ids: tuple[str, str]
    overlap_sec: float


def same_source_timeline_overlaps(
    project: EpisodeProject,
    *,
    clips: Iterable[Clip] | None = None,
    tolerance_sec: float = SAME_SOURCE_OVERLAP_TOLERANCE_SEC,
) -> list[SourceStack]:
    """Clip pairs on the same lane, reading the same media, whose timeline spans overlap.

    Flags stacked whole-file copies of a split track (see #520): two clips that would
    play the same audio at the same time. Checks ``clips`` (default: every project clip);
    empty (zero-length) clips are ignored.
    """
    groups: dict[tuple[str, str], list[Clip]] = {}
    for clip in project.clips if clips is None else clips:
        if clip.timeline_end <= clip.timeline_start + _EPS:
            continue
        key = (clip.track_id, clip_media_key(project, clip))
        groups.setdefault(key, []).append(clip)

    stacks: list[SourceStack] = []
    for (track_id, media), members in groups.items():
        ordered = sorted(members, key=lambda c: (c.timeline_start, c.id))
        index = HalfOpenIntervalIndex.build((c.timeline_start, c.timeline_end) for c in ordered)
        for i, a in enumerate(ordered):
            for j in index.overlapping_ordinals(a.timeline_start, a.timeline_end):
                if j <= i:
                    continue
                b = ordered[j]
                overlap = min(a.timeline_end, b.timeline_end) - b.timeline_start
                if overlap > tolerance_sec:
                    stacks.append(
                        SourceStack(
                            track_id=track_id,
                            media=media,
                            clip_ids=(a.id, b.id),
                            overlap_sec=round(overlap, 3),
                        )
                    )
    return stacks


class SessionTimeline:
    """Bidirectional mapping between source media time and session timeline time.

    A track with no clips maps identically (source == timeline), matching how
    ingest treats un-clipped tracks.
    """

    def __init__(self, project: EpisodeProject) -> None:
        self._project = project
        self._indexes: dict[str, tuple[tuple[_ClipKey, ...], _TrackIndex | None]] = {}

    def _index(self, track_id: str) -> _TrackIndex | None:
        keys = tuple(
            (c.timeline_start, c.source_start, c.source_end)
            for c in self._project.clips
            if origin_track_id_for_clip(self._project, c) == track_id
        )
        cached = self._indexes.get(track_id)
        if cached is not None and cached[0] == keys:
            return cached[1]
        index = _build_index(keys) if keys else None
        self._indexes[track_id] = (keys, index)
        return index

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
        idx = self._index(track_id)
        return self._map_source_span(idx, start, end)

    def map_source_spans(
        self, track_id: str, spans: Sequence[tuple[SourceSec, SourceSec]]
    ) -> list[list[tuple[TimelineSec, TimelineSec]]]:
        """Map a snapshot batch against one fresh clip index."""
        idx = self._index(track_id)
        return [self._map_source_span(idx, start, end) for start, end in spans]

    @staticmethod
    def _map_source_span(
        idx: _TrackIndex | None, start: SourceSec, end: SourceSec
    ) -> list[tuple[TimelineSec, TimelineSec]]:
        if end <= start:
            return []
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
        words = (w for w in tr.words if include_suppressed or not w.suppressed)
        spans = self.map_source_spans(
            track_id, [(SourceSec(w.start), SourceSec(w.end)) for w in words]
        )
        for mapped in spans:
            for s, e in mapped:
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
        prior = bisect_right(idx.timeline_starts, float(tl_sec)) - 1
        span = idx.by_timeline[max(0, prior)]
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

    def clip_relative_drift(self, clip: Clip, reference_track_id: str) -> float:
        """Signed drift(clip) - drift(reference) with the largest magnitude over the clip.

        The clip's timeline span is split at the reference's span boundaries and each
        piece at least ``_REL_DRIFT_MIN_PIECE_SEC`` long is sampled at its midpoint, so
        an offset region anywhere inside the clip is seen, while a sliver left by per-lane
        cut snapping is not. Ripple cuts shift every track alike and cancel out.
        """
        start, end = float(clip.timeline_start), float(clip.timeline_end)
        own = -clip_source_to_timeline_shift(clip)
        edges = {start, end}
        ref_idx = self._index(reference_track_id)
        if ref_idx is not None:
            for span in _candidates_timeline(ref_idx, start, end):
                for b in (span.timeline_start, span.timeline_end):
                    if start < b < end:
                        edges.add(b)
        ordered = sorted(edges)
        pieces = [
            (a, b) for a, b in itertools.pairwise(ordered) if b - a >= _REL_DRIFT_MIN_PIECE_SEC
        ] or [(start, end)]
        worst = 0.0
        for a, b in pieces:
            rel = own - self.drift_at(reference_track_id, TimelineSec((a + b) / 2.0))
            if abs(rel) > abs(worst):
                worst = rel
        return worst


_DRIFT_WARN_SEC = 1.0


def timebase_qc_report(project: EpisodeProject) -> dict[str, Any]:
    """Per-track drift, unmapped transcript words and stacked clips for export/doctor QC.

    Source/timeline drift after cuts is expected on edited episodes - reported as
    ``warnings``, not a ship-blocker. Zero-length ASR words (``end <= start``, common in
    Whisper output) map by ``word_source_span``; ones that land on the timeline are
    counted as ``zero_length_words`` with a warning (ASR timing flag, #621). Words that
    end more than ``_INVERTED_WORD_TOL_SEC`` before they start are ``inverted_words``, a
    hard issue (corrupt timing). Unmapped transcript words (wrong clock or cut-away) and
    same-source timeline stacks (stacked copies play twice, see #520) remain hard
    ``issues``.
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
        words = [w for w in tr.words if not w.suppressed]
        inverted = sum(1 for w in words if w.end < w.start - _INVERTED_WORD_TOL_SEC)
        timed = [w for w in words if w.end >= w.start - _INVERTED_WORD_TOL_SEC]
        mapped = st.map_source_spans(tr.track_id, [word_source_span(w.start, w.end) for w in timed])
        unmapped = sum(1 for m in mapped if not m)
        zero_length = sum(1 for w, m in zip(timed, mapped, strict=True) if m and w.end <= w.start)
        tinfo = tracks.setdefault(tr.track_id, {"max_drift_sec": st.max_drift(tr.track_id)})
        if zero_length:
            tinfo["zero_length_words"] = zero_length
            warnings.append(
                f"Track {tr.track_id!r}: {zero_length} transcript word(s) have zero ASR "
                "duration (end <= start); mapped as 1 ms spans - an ASR timing flag, not unmapped"
            )
        if inverted:
            tinfo["inverted_words"] = inverted
            issues.append(
                f"Track {tr.track_id!r}: {inverted} transcript word(s) end more than "
                f"{_INVERTED_WORD_TOL_SEC:g}s before they start (corrupt word timing)"
            )
        if unmapped:
            tinfo["unmapped_words"] = unmapped
            issues.append(
                f"Track {tr.track_id!r}: {unmapped} transcript word(s) fall outside "
                "clip source ranges (may be cut away or stored in wrong clock)"
            )

    stacks = same_source_timeline_overlaps(project)
    for stack in stacks:
        tinfo = tracks.setdefault(stack.track_id, {"max_drift_sec": st.max_drift(stack.track_id)})
        tinfo["stacked_clips"] = int(tinfo.get("stacked_clips", 0)) + 1
        a, b = stack.clip_ids
        issues.append(
            f"Track {stack.track_id!r}: clips {a!r} and {b!r} overlap {stack.overlap_sec:.2f}s "
            "on the timeline while reading the same source (stacked copies play twice)"
        )

    return {
        "tracks": tracks,
        "warnings": warnings,
        "issues": issues,
        "ok": not issues,
        "stacked_clips": [asdict(s) for s in stacks],
    }
