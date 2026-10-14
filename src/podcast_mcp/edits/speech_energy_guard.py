"""Cross-track speech-energy guard for cut proposals and apply.

Transcript-guided cuts miss unlabeled words. Before session-wide ripple, check
whether another dialogue stem is audibly speaking in the mapped window and
either skip, force review, or convert to a track-local punch (silence hole,
no peer ripple). Both guards share their evidence: :func:`measure_peer_speech`
is a peer's own sound, and :func:`speech_words_in` its unsuppressed words whose
own voice reaches into the cut (:func:`word_voice_sounds_in`). The ripple speech
guard (``edits/cut_speech.py``) reads words first; this guard reads sound and
falls back to words only where a peer's sound cannot be read.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Collection, Iterable, Sequence
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any, Literal, NamedTuple, TypeAlias

import numpy as np

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.audio_cache import track_level_profile
from podcast_mcp.edits.clips_ops import clips_for_track, remove_timeline_range_from_clips
from podcast_mcp.edits.join_speech import JoinSpeechConfig
from podcast_mcp.edits.session_air import (
    SampleRun,
    lane_clip_placements,
    lane_placements,
    read_samples,
)
from podcast_mcp.edits.voiced_runs import FRAME_SEC, HOP_SEC, PROBE_SEC, carries_speech_pitch
from podcast_mcp.engines.audio_audit import (
    _RMS_SAMPLE_RATE,
    TrackRmsCache,
    TrackRmsCacheSet,
    measure_timeline_rms_db,
    timeline_frame_levels_db,
    timeline_window_samples,
)
from podcast_mcp.engines.level_profile import (
    LEVEL_FRAME_SEC,
    VOICE_FLOOR_OVER_ROOM_DB,
    room_floor_db,
    speech_level_db,
)
from podcast_mcp.engines.sample_grid import Piece, lay_out
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    clip_source_to_timeline_shift,
    clip_timeline_overlap_to_source,
    word_source_span,
)
from podcast_mcp.models import CutSpeechWord, EpisodeProject
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.dsp import DIGITAL_SILENCE_DB, bool_runs
from podcast_mcp.util.intervals import intersect_intervals, merge_intervals, subtract_intervals
from podcast_mcp.util.timebase import SourceSec
from podcast_mcp.util.tracks import dialogue_track_ids

log = logging.getLogger(__name__)

ConflictAction = Literal["skip", "review"]
CONFLICT_ACTIONS: tuple[ConflictAction, ...] = ("review", "skip")


@dataclass(frozen=True)
class SpeechEnergyGuardResult:
    """Outcome of checking other tracks over a proposed source cut."""

    blocking_track_ids: tuple[str, ...]
    action: ConflictAction | None
    """None when the cut is safe for session ripple."""

    cut_rms_db: float | None = None
    other_rms_db: dict[str, float] = field(default_factory=dict)

    @property
    def blocked(self) -> bool:
        return bool(self.blocking_track_ids)


def _guard_cfg(defaults: dict[str, Any] | None) -> dict[str, Any]:
    cfg = defaults if defaults is not None else load_defaults()
    return dict((cfg.get("tighten") or {}).get("speech_energy_guard") or {})


def speech_energy_guard_enabled(defaults: dict[str, Any] | None = None) -> bool:
    return bool(_guard_cfg(defaults).get("enabled", True))


def validate_speech_energy_on_conflict(defaults: dict[str, Any] | None = None) -> ConflictAction:
    """The validated ``tighten.speech_energy_guard.on_conflict``: ``review`` or ``skip``.

    An unknown value raises ``ValueError`` naming the valid ones. ``merge_pipeline_config``
    calls this when a config loads, so a bad value never reaches a run; it must not be called
    from the cut-scope path, whose ``ValueError`` handler would report it as unavailable.
    """
    raw = _guard_cfg(defaults).get("on_conflict", "review")
    mode = str(raw).strip().lower()
    for valid in CONFLICT_ACTIONS:
        if mode == valid:
            return valid
    raise ValueError(
        "unknown tighten.speech_energy_guard.on_conflict: "
        f"{raw!r}; valid values: {', '.join(CONFLICT_ACTIONS)}"
    )


def speech_energy_on_conflict(defaults: dict[str, Any] | None = None) -> ConflictAction:
    return _guard_cfg(defaults).get("on_conflict", "review")


@dataclass(frozen=True)
class PeerSpeechLevels:
    """Own-sound evidence over timeline spans: which peer tracks are speaking there."""

    owner_rms_db: float | None
    peer_rms_db: dict[str, float]
    speaking: tuple[str, ...]
    unread: dict[str, list[tuple[float, float]]] = field(default_factory=dict)
    """Per peer, the spans where its own sound could not be read, so it shows nothing."""


@dataclass(frozen=True)
class _RemovedCells:
    """The peer's samples a removal deletes, as cells of its reader's sample grid."""

    rate: int
    offset: float
    origin: int
    sole: list[tuple[int, int]]
    """Removed cells only removed audio plays in."""
    shared: list[tuple[int, int]]
    """Removed cells a retained recording plays in as well."""
    runs: list[SampleRun]
    """The removed audio itself, one run per recording piece."""

    def seconds(self, cell: int) -> float:
        return self.offset + (cell - self.origin) / self.rate

    def spans(self, cells: list[tuple[int, int]]) -> list[tuple[float, float]]:
        return [(self.seconds(a), self.seconds(b)) for a, b in cells]

    def removed_audio(
        self, project: EpisodeProject, peer_track_id: str, caches: TrackRmsCacheSet | None
    ) -> TrackRmsCacheSet:
        """``caches`` with the peer's lane replaced by only the audio the removal deletes.

        The lane keeps the peer's own level profile: the removed audio is read against
        the whole recording's levels, not its own.
        """
        first = min(a for a, _ in self.shared)
        last = max(b for _, b in self.shared)
        peer = caches.get(peer_track_id) if caches else None
        only = TrackRmsCache(
            samples=read_samples(self.runs, first, last - first, self.rate),
            sample_rate=self.rate,
            timeline_offset_sec=self.seconds(first),
            recording_profile=(
                peer.profile
                if peer is not None
                else track_level_profile(project, peer_track_id, sample_rate=_RMS_SAMPLE_RATE)
            ),
        )
        return TrackRmsCacheSet(caches={**(caches.caches if caches else {}), peer_track_id: only})


def _as_cells(spans: list[tuple[float, float]]) -> list[tuple[int, int]]:
    return [(int(a), int(b)) for a, b in spans]


def _removal_cells(
    project: EpisodeProject,
    peer_track_id: str,
    start: float,
    end: float,
    caches: TrackRmsCacheSet | None,
    *,
    removal_span: tuple[float, float] | None,
) -> _RemovedCells:
    """The peer's samples a removal of ``removal_span`` deletes inside ``[start, end)``.

    The lane is laid out on the reader's sample grid (``engines.sample_grid``) and the
    removal is applied to each clip as the forward consumer applies it, so a sample is
    removed exactly when no remaining piece covers it. A cell can hold several recordings
    (an overlay); it is shared when one of them is retained.
    """
    track = project.track_by_id(peer_track_id)
    cache = caches.get(peer_track_id) if caches else None
    rate = cache.sample_rate if cache else _RMS_SAMPLE_RATE
    offset = cache.timeline_offset_sec if cache else 0.0
    origin = round(offset * rate)
    removal_start, removal_end = removal_span if removal_span is not None else (start, end)
    pairs = lane_clip_placements(project, track) if track else []
    limit = track.media.duration_sec if track and track.media else None
    clips = [
        clip
        if math.isfinite(placement.tl_end)
        else clip.model_copy(
            update={
                "source_end": clip.source_start
                + max(0.0, (end if limit is None else limit) - clip.timeline_start)
            }
        )
        for clip, placement in pairs
    ]
    cells = lay_out(
        [Piece(c.source_start, c.source_end, c.timeline_start, c.timeline_end) for c in clips], rate
    )
    gone_cells: list[tuple[float, float]] = []
    kept_cells: list[tuple[float, float]] = []
    runs: list[SampleRun] = []
    for clip, (_, placement), cell in zip(clips, pairs, cells, strict=True):
        kept = [
            (round(piece.source_start * rate), round(piece.source_end * rate))
            for piece in remove_timeline_range_from_clips([clip], removal_start, removal_end)
        ]
        gone = subtract_intervals([(cell.first, cell.first + cell.count)], kept)
        shift = cell.dest - cell.first
        gone_cells.extend((a + shift, b + shift) for a, b in gone)
        kept_cells.extend((a + shift, b + shift) for a, b in kept)
        runs.extend(SampleRun(placement.media, int(a + shift), int(a), int(b - a)) for a, b in gone)
    window = (
        -math.inf if start == removal_start else round((start - offset) * rate) + origin,
        math.inf if end == removal_end else round((end - offset) * rate) + origin,
    )
    inside = intersect_intervals(merge_intervals(gone_cells), [window])
    shared = intersect_intervals(inside, kept_cells)
    sole = subtract_intervals(inside, shared)
    return _RemovedCells(rate, offset, origin, _as_cells(sole), _as_cells(shared), runs)


# The lower quartile of the peer's own windows is its room: a quiet room dips now and then, and
# a sound that fills a minority of its own frames does not move the reference up with it.
_OWN_ROOM_PERCENTILE = 25.0


class _PeerFrames(NamedTuple):
    levels: np.ndarray
    own: np.ndarray
    pitchless: Callable[[], np.ndarray]
    """Which independent frames lie in a run that carries no speech pitch (read on demand)."""


def _pitchless_independent_runs(
    project: EpisodeProject,
    peer_track_id: str,
    start: float,
    end: float,
    own: np.ndarray,
    caches: TrackRmsCacheSet | None,
) -> np.ndarray:
    pitchless = np.zeros(own.size, dtype=bool)
    read = timeline_window_samples(project, peer_track_id, start, end, caches=caches)
    if read is None:
        return pitchless
    samples, rate = read
    frame = max(1, round(rate * LEVEL_FRAME_SEC))
    for first, last in bool_runs(own):
        if (
            carries_speech_pitch(samples[first * frame : last * frame], rate, interior=True)
            is False
        ):
            pitchless[first:last] = True
    return pitchless


def _owned_peer_frames(
    project: EpisodeProject,
    peer_track_id: str,
    start: float,
    end: float,
    *,
    owner_track_ids: Collection[str],
    dominance_db: float,
    caches: TrackRmsCacheSet | None,
    half_open: bool = False,
) -> _PeerFrames | None:
    if half_open:
        start, end = (float(np.nextafter(point, np.inf)) for point in (start, end))
    else:
        end = float(np.nextafter(end, np.inf))
    levels = timeline_frame_levels_db(
        project,
        peer_track_id,
        start,
        end,
        frame_sec=LEVEL_FRAME_SEC,
        hop_sec=LEVEL_FRAME_SEC,
        caches=caches,
    )
    if levels is None:
        return None
    peer = project.track_by_id(peer_track_id)
    gain = peer.gain_db if peer else 0.0
    own = levels > DIGITAL_SILENCE_DB + gain
    for tid in owner_track_ids:
        owner = timeline_frame_levels_db(
            project,
            tid,
            start,
            end,
            frame_sec=LEVEL_FRAME_SEC,
            hop_sec=LEVEL_FRAME_SEC,
            caches=caches,
        )
        if owner is None:
            continue
        track = project.track_by_id(tid)
        owner_gain = track.gain_db if track else 0.0
        size = min(levels.size, owner.size)
        own[:size] &= ~(
            (owner[:size] > DIGITAL_SILENCE_DB + owner_gain)
            & ((owner[:size] - owner_gain) - (levels[:size] - gain) >= dominance_db)
        )
    return _PeerFrames(
        levels,
        own,
        lambda: _pitchless_independent_runs(project, peer_track_id, start, end, own, caches),
    )


class _PeerSpan(NamedTuple):
    levels: np.ndarray
    own: np.ndarray
    reference: np.ndarray
    pitchless: Callable[[], np.ndarray]


def _chained(
    head: Callable[[], np.ndarray], tail: Callable[[], np.ndarray]
) -> Callable[[], np.ndarray]:
    return lambda: np.concatenate((head(), tail()))


def _run_windows(levels: np.ndarray, own: np.ndarray) -> list[tuple[tuple[int, int], np.ndarray]]:
    """Each run of the peer's own frames and the level of each pitch-probe window inside it.

    A window spans :data:`~podcast_mcp.edits.voiced_runs.PROBE_SEC`, long enough that a
    low-frequency hum does not flicker its level from frame to frame. Runs shorter than a
    window are left out.
    """
    size = round(PROBE_SEC / LEVEL_FRAME_SEC)
    runs = []
    for first, last in bool_runs(own):
        if last - first >= size:
            power = np.convolve(10 ** (levels[first:last] / 10), np.ones(size) / size, "valid")
            runs.append(((first, last), 10 * np.log10(power)))
    return runs


def _independent_frames_are_room(block: _PeerSpan, references: Sequence[_PeerSpan]) -> bool:
    """Whether every frame of ``block`` that is the peer's own is quiet room, not speech.

    Called only where the room cannot be read from the peer's reference frames, because
    the owner's bleed fills them. The peer's own frames then show its room: a run of them
    that carries no speech pitch, and no window of which rises more than
    :data:`~podcast_mcp.edits.audio_cache.VOICE_FLOOR_OVER_ROOM_DB` over the lower quartile
    of the peer's own windows, is room. A run too short to judge, or that carries pitch or
    rises above that quiet, may be a remark and is not.
    """
    runs = _run_windows(block.levels, block.own)
    if not runs:
        return False
    room = room_floor_db(
        np.concatenate(
            [windows for part in references for _, windows in _run_windows(part.levels, part.own)]
        ),
        percentile=_OWN_ROOM_PERCENTILE,
    )
    pitchless = block.pitchless()
    room_like = np.zeros(block.own.size, dtype=bool)
    for (first, last), windows in runs:
        if bool(pitchless[first:last].all()) and windows.max() <= room + VOICE_FLOOR_OVER_ROOM_DB:
            room_like[first:last] = True
    return not bool((block.own & ~room_like).any())


def _peer_speaks_near_span(
    project: EpisodeProject,
    peer_track_id: str,
    span: tuple[float, float],
    *,
    owner_track_ids: Collection[str],
    dominance_db: float,
    caches: TrackRmsCacheSet | None,
    admissible_span: tuple[float, float] | None = None,
    removal_span: tuple[float, float] | None = None,
) -> bool | None:
    config = JoinSpeechConfig()
    start, end = (
        admissible_span
        if admissible_span is not None
        else (max(0.0, span[0] - config.pad_sec), span[1] + config.pad_sec)
    )
    if admissible_span is None and start > 0.0:
        start = float(np.nextafter(start, np.inf))
    track = project.track_by_id(peer_track_id)
    gain = track.gain_db if track else 0.0
    extent = max(
        (clip.timeline_end for clip in clips_for_track(project, peer_track_id)),
        default=track.media.duration_sec if track and track.media else None,
    )
    if extent is not None:
        end = min(end, extent)

    coverage = merge_intervals(
        ((part.tl_start, part.tl_end) for part in lane_placements(project, track)) if track else (),
        gap=0.0,
    )

    def covered(
        lo: float, size: int, *, sealed: bool, source: TrackRmsCacheSet | None
    ) -> np.ndarray:
        cache = source.get(peer_track_id) if source else None
        if cache:
            read_start = float(np.nextafter(lo, np.inf)) if sealed else lo
            lo = (
                cache.timeline_offset_sec
                + math.floor((read_start - cache.timeline_offset_sec) * cache.sample_rate)
                / cache.sample_rate
            )
        starts = lo + np.arange(size) * LEVEL_FRAME_SEC
        mask = np.zeros(size, dtype=bool)
        for left, right in coverage:
            mask |= (starts >= left) & (starts + LEVEL_FRAME_SEC <= right)
        return mask

    def frames(
        lo: float, hi: float, *, sealed: bool = False, source: TrackRmsCacheSet | None = caches
    ) -> _PeerSpan | None:
        if hi - lo < LEVEL_FRAME_SEC - 1e-9:
            return None
        evidence = _owned_peer_frames(
            project,
            peer_track_id,
            lo,
            hi,
            owner_track_ids=owner_track_ids,
            dominance_db=dominance_db,
            caches=source,
            half_open=sealed,
        )
        if evidence is None:
            return None
        levels, own, pitchless = evidence
        reference = covered(lo, levels.size, sealed=sealed, source=source)
        if lo + levels.size * LEVEL_FRAME_SEC < hi - 1e-9:
            tail = _owned_peer_frames(
                project,
                peer_track_id,
                hi - LEVEL_FRAME_SEC,
                hi,
                owner_track_ids=owner_track_ids,
                dominance_db=dominance_db,
                caches=source,
                half_open=sealed,
            )
            if tail is None:
                return None
            levels = np.concatenate((levels, tail.levels))
            own = np.concatenate((own, tail.own))
            reference = np.concatenate(
                (
                    reference,
                    covered(hi - LEVEL_FRAME_SEC, tail.levels.size, sealed=sealed, source=source),
                )
            )
            pitchless = _chained(pitchless, tail.pitchless)
        return _PeerSpan(levels, own, reference, pitchless)

    before = frames(max(0.0, start - 5.0), start)
    after = frames(end, min(end + 5.0, extent) if extent is not None else end + 5.0)
    unavailable = False
    decision_spans: list[tuple[float, float]] = [(start, end)]
    source = caches
    if admissible_span is not None:
        removed = _removal_cells(
            project, peer_track_id, start, end, caches, removal_span=removal_span
        )
        decision_spans = removed.spans(removed.sole)
        if removed.shared:
            try:
                source = removed.removed_audio(project, peer_track_id, caches)
                decision_spans = merge_intervals([*decision_spans, *removed.spans(removed.shared)])
            except (OSError, ValueError):
                unavailable = True
    blocks: list[tuple[float, float]] = []
    for left, right in decision_spans:
        block_start = left
        while block_start < right - 1e-9:
            block_end = min(block_start + 2.0, right)
            read_start = (
                max(left, min(block_start, block_end - LEVEL_FRAME_SEC))
                if admissible_span is not None
                else min(block_start, block_end - LEVEL_FRAME_SEC)
            )
            blocks.append((read_start, block_end))
            block_start = block_end
    for block_start, block_end in blocks:
        evidence = frames(
            block_start,
            block_end,
            sealed=admissible_span is not None,
            source=source,
        )
        if evidence is None:
            unavailable = True
        else:
            levels, own = evidence.levels, evidence.own
            if not bool(own.any()):
                continue
            nearby = (
                (before, after)
                if end - start <= 2.0
                else (before,)
                if block_start - start < end - block_end
                else (after,)
            )
            references = [evidence, *(part for part in nearby if part is not None)]
            upper = max(
                (
                    speech + gain
                    for local, mask, _, _ in references
                    if (speech := speech_level_db(local[mask] - gain, min_live_sec=0.0)) is not None
                ),
                default=None,
            )
            room_parts = [local[mask] for local, _, mask, _ in references if bool(mask.any())]
            if upper is not None and room_parts:
                room = room_floor_db(np.concatenate(room_parts))
                floor = max(upper - config.speech_dynamic_db, room + 6.0)
                if upper < room + 6.0:
                    if room > upper and any(
                        bool(((local > DIGITAL_SILENCE_DB + gain) & ~mask).any())
                        for local, mask, _, _ in references
                    ):
                        if not _independent_frames_are_room(evidence, references):
                            return True
                        continue
                    unavailable = True
                elif bool((own & (levels >= floor)).any()):
                    return True
            else:
                unavailable = True
    return None if unavailable else False


def _gain_db(project: EpisodeProject, track_id: str) -> float:
    track = project.track_by_id(track_id)
    return track.gain_db if track else 0.0


def _voice_reach_db(
    project: EpisodeProject, track_id: str, caches: TrackRmsCacheSet | None
) -> float:
    """The level the mean of a stretch must reach to hold ``track_id``'s voice, in recorded dB."""
    cache = caches.get(track_id) if caches else None
    reach = (
        cache.profile
        if cache is not None
        else track_level_profile(project, track_id, sample_rate=_RMS_SAMPLE_RATE)
    ).voice_reach_db
    track = project.track_by_id(track_id)
    return reach + (track.gain_db if track else 0.0)


def _peer_voice_in_mean(
    project: EpisodeProject, peer_track_id: str, rms: float, caches: TrackRmsCacheSet | None
) -> bool | None:
    """Whether a peer's whole-span mean level ``rms`` (recorded dB) holds its voice.

    Where no frame-by-frame calibration can be made, the span's mean is held to the level
    the peer's voice reaches (:attr:`~podcast_mcp.engines.level_profile.LevelProfile.voice_reach_db`):
    a peer with no live audio never speaks. A peer whose loudest frames show no contrast with
    its room has no voice level of its own to read, so it is held to the voice level of the
    session's other tracks (the median of theirs), at any recording level. ``None`` when the
    session has no track to read it against.
    """
    reach = _voice_reach_db(project, peer_track_id, caches)
    if reach == -math.inf:
        session = [
            r
            for tid in dialogue_track_ids(project)
            if math.isfinite(r := _voice_reach_db(project, tid, caches))
        ]
        if not session:
            return None
        reach = float(np.median(session))
    return rms >= reach


def measure_peer_speech(
    project: EpisodeProject,
    timeline_spans: Sequence[tuple[float, float]],
    *,
    owner_track_ids: Collection[str],
    peer_track_ids: Iterable[str],
    defaults: dict[str, Any] | None = None,
    caches: TrackRmsCacheSet | None = None,
    _admissible_spans: Sequence[tuple[float, float]] | None = None,
    _removal_spans: Sequence[tuple[float, float]] | None = None,
) -> PeerSpeechLevels | None:
    if _admissible_spans is not None and (
        not _admissible_spans
        or tuple(_admissible_spans) != tuple(timeline_spans)
        or any(not math.isfinite(s) or not math.isfinite(e) or e <= s for s, e in _admissible_spans)
    ):
        raise CodedValueError(
            "Peer detection support must match the exact positive query spans.",
            code="invalid_range",
        )
    if _removal_spans is not None and (
        _admissible_spans is None
        or not _removal_spans
        or any(not math.isfinite(s) or not math.isfinite(e) or e <= s for s, e in _removal_spans)
        or any(left[1] > right[0] for left, right in pairwise(_removal_spans))
        or any(sum(a <= s and e <= b for a, b in _removal_spans) != 1 for s, e in timeline_spans)
    ):
        raise CodedValueError(
            "Peer removal geometry must contain each sealed query in one ordered component.",
            code="invalid_range",
        )
    cfg = _guard_cfg(defaults)
    dominance = float(cfg.get("dominance_db", 3.0))
    min_overlap = float(cfg.get("min_overlap_sec", 0.03))
    checked = [(s, e) for s, e in timeline_spans if e - s >= min_overlap]
    if not checked:
        return None

    span_owner_rms = [
        max(
            (
                r
                for r in (
                    measure_timeline_rms_db(
                        project, tid, s, e, caches=caches, floor_db=DIGITAL_SILENCE_DB
                    )
                    for tid in owner_track_ids
                )
                if r is not None
            ),
            default=None,
        )
        for s, e in checked
    ]
    owner_rms = max((r for r in span_owner_rms if r is not None), default=None)
    # Which mic is louder is read on the recordings, without the balance gains (#1549).
    span_owner_raw = [
        max(
            (
                r - _gain_db(project, tid)
                for tid in owner_track_ids
                if (
                    r := measure_timeline_rms_db(
                        project, tid, s, e, caches=caches, floor_db=DIGITAL_SILENCE_DB
                    )
                )
                is not None
            ),
            default=None,
        )
        for s, e in checked
    ]

    peer_rms: dict[str, float] = {}
    speaking: list[str] = []
    unread: dict[str, list[tuple[float, float]]] = {}
    for tid in peer_track_ids:
        if tid in owner_track_ids:
            continue
        speaks = False
        peer_gain = _gain_db(project, tid)
        for (tl_start, tl_end), span_owner in zip(checked, span_owner_raw, strict=True):
            rms = measure_timeline_rms_db(
                project, tid, tl_start, tl_end, caches=caches, floor_db=DIGITAL_SILENCE_DB
            )
            if rms is None:
                unread.setdefault(tid, []).append((tl_start, tl_end))
                continue
            if tid not in peer_rms or rms > peer_rms[tid]:
                peer_rms[tid] = rms
            calibrated = _peer_speaks_near_span(
                project,
                tid,
                (tl_start, tl_end),
                owner_track_ids=owner_track_ids,
                dominance_db=dominance,
                caches=caches,
                admissible_span=(tl_start, tl_end) if _admissible_spans is not None else None,
                removal_span=next(
                    (
                        component
                        for component in _removal_spans
                        if component[0] <= tl_start and tl_end <= component[1]
                    ),
                    None,
                )
                if _removal_spans is not None
                else None,
            )
            if calibrated is None:
                voiced = _peer_voice_in_mean(project, tid, rms, caches)
                raw = rms - peer_gain
                calibrated = (
                    span_owner is None or raw - span_owner >= dominance
                    if voiced is None
                    else voiced and (span_owner is None or span_owner - raw < dominance)
                )
            speaks |= calibrated
        if speaks:
            speaking.append(tid)
    return PeerSpeechLevels(
        owner_rms_db=owner_rms,
        peer_rms_db=peer_rms,
        speaking=tuple(speaking),
        unread=unread,
    )


def word_voice_sounds_in(
    project: EpisodeProject,
    track_id: str,
    word_span: tuple[float, float],
    span: tuple[float, float],
) -> bool:
    """Whether a word's own voice on ``track_id`` sounds inside timeline ``span``.

    ASR stretches a word's span over the silence beside its voice, so the span alone
    does not show that ``span`` holds any of it. The word's loudest frame on its own
    track is its voice level, and a frame of ``span`` is that voice when it sits within
    the speech range of that level (``JoinSpeechConfig.speech_dynamic_db``). Another
    speaker's bleed on this mic is not discounted: it is no louder than the word's own
    quiet start or end, so telling them apart would hide real speech, and a false
    positive only asks. Frames are the tighten grid (``voiced_runs.FRAME_SEC`` every
    ``HOP_SEC``). Audio that cannot be read counts as voice, so a missing file never
    hides speech.
    """

    def levels(start: float, end: float) -> np.ndarray | None:
        return timeline_frame_levels_db(
            project, track_id, start, end, frame_sec=FRAME_SEC, hop_sec=HOP_SEC
        )

    word = levels(*word_span)
    inside = levels(*span)
    if word is None or inside is None:
        return True
    return bool((inside >= float(word.max()) - JoinSpeechConfig().speech_dynamic_db).any())


def _voiced_in_parts(
    project: EpisodeProject,
    track_id: str,
    word: CutSpeechWord,
    parts: Sequence[tuple[float, float]],
) -> bool:
    span = (word.timeline_start, word.timeline_end)
    return any(
        word_voice_sounds_in(project, track_id, span, (a, b))
        for start, end in parts
        if (a := max(start, span[0])) < (b := min(end, span[1]))
    )


def speech_words_in(
    project: EpisodeProject,
    track_id: str,
    parts: Sequence[tuple[float, float]],
    min_overlap: float,
    *,
    voiced: bool,
) -> list[CutSpeechWord]:
    """``track_id``'s unsuppressed, unignored words overlapping timeline ``parts``.

    A word counts once it overlaps a part by ``min_overlap`` (or by all of itself
    when shorter). ``voiced`` keeps only words whose own voice sounds where they
    meet a part (:func:`word_voice_sounds_in`).
    """
    words: list[CutSpeechWord] = []
    for clip in clips_for_track(project, track_id):
        sources = [
            source
            for start, end in parts
            if (source := clip_timeline_overlap_to_source(clip, start, end)) is not None
        ]
        if not sources:
            continue
        transcript = project.transcript_for_source(clip.track_id, clip.source_id)
        if transcript is None:
            continue
        shift = clip_source_to_timeline_shift(clip)
        for word in transcript.words:
            if word.suppressed or word.ignored or word.suspect_hallucination:
                continue
            w_start, w_end = word_source_span(word.start, word.end)
            overlap = max(min(w_end, hi) - max(w_start, lo) for lo, hi in sources)
            if overlap <= 0 or overlap < min(min_overlap, w_end - w_start) - 1e-9:
                continue
            words.append(
                CutSpeechWord(
                    text=word.text,
                    timeline_start=w_start + shift,
                    timeline_end=w_end + shift,
                )
            )
    if voiced:
        words = [w for w in words if _voiced_in_parts(project, track_id, w, parts)]
    return sorted(words, key=lambda w: w.timeline_start)


def guard_min_overlap_sec(defaults: dict[str, Any] | None = None) -> float:
    """Shortest overlap with a removed span that counts as cutting speech."""
    return float(_guard_cfg(defaults).get("min_overlap_sec", 0.03))


def assess_cross_track_speech(
    project: EpisodeProject,
    cut_track_id: str,
    src_start: float,
    src_end: float,
    *,
    defaults: dict[str, Any] | None = None,
    caches: TrackRmsCacheSet | None = None,
    _admissible_spans: Sequence[tuple[float, float]] | None = None,
) -> SpeechEnergyGuardResult:
    """Return tracks that are speaking over the cut's mapped timeline window.

    A peer's own sound decides. Where it cannot be read (no stem or source audio),
    the peer's unsuppressed words whose own voice is in the window decide instead.
    """
    if src_end <= src_start or not speech_energy_guard_enabled(defaults):
        return SpeechEnergyGuardResult(blocking_track_ids=(), action=None)

    spans = SessionTimeline(project).map_source_span(
        cut_track_id, SourceSec(src_start), SourceSec(src_end)
    )
    # A track-local hole inside the gap splits it into several mapped spans;
    # peer speech in any span at or above min_overlap can block, not just the
    # largest one (#793).
    levels = measure_peer_speech(
        project,
        spans,
        owner_track_ids=(cut_track_id,),
        peer_track_ids=dialogue_track_ids(project),
        defaults=defaults,
        caches=caches,
        _admissible_spans=_admissible_spans,
    )
    if levels is None:
        return SpeechEnergyGuardResult(blocking_track_ids=(), action=None)
    min_overlap = guard_min_overlap_sec(defaults)
    blocking = levels.speaking + tuple(
        tid
        for tid, unread in levels.unread.items()
        if tid not in levels.speaking
        and speech_words_in(project, tid, unread, min_overlap, voiced=True)
    )
    if not blocking:
        return SpeechEnergyGuardResult(
            blocking_track_ids=(),
            action=None,
            cut_rms_db=levels.owner_rms_db,
            other_rms_db=levels.peer_rms_db,
        )
    return SpeechEnergyGuardResult(
        blocking_track_ids=blocking,
        action=speech_energy_on_conflict(defaults),
        cut_rms_db=levels.owner_rms_db,
        other_rms_db=levels.peer_rms_db,
    )


class PeerSpeechBlocked(ValueError):
    """``on_conflict: skip`` and peers are speaking over the cut."""

    def __init__(self, peers: tuple[str, ...]) -> None:
        super().__init__(
            f"cut blocked: other track(s) speaking in window ({', '.join(peers)}); "
            "leave in or review it"
        )
        self.peers = peers


@dataclass(frozen=True)
class ResolvedCutScope:
    cause: Literal["session_clear", "intentional_track", "peer_speech", "speaker_bleed"]
    guard: SpeechEnergyGuardResult | None = None

    @property
    def scope(self) -> Literal["session", "track"]:
        scopes: dict[str, Literal["session", "track"]] = {
            "session_clear": "session",
            "intentional_track": "track",
            "peer_speech": "track",
            "speaker_bleed": "track",
        }
        return scopes[self.cause]


@dataclass(frozen=True)
class CutScopeUnavailable:
    """Peer assessment failed without selecting an executable cut scope."""


CutScopeResolution: TypeAlias = ResolvedCutScope | CutScopeUnavailable


def resolve_cut_scope(
    project: EpisodeProject,
    cut_track_id: str,
    src_start: float,
    src_end: float,
    *,
    requested_scope: str = "session",
    defaults: dict[str, Any] | None = None,
    caches: TrackRmsCacheSet | None = None,
    _admissible_spans: Sequence[tuple[float, float]] | None = None,
) -> CutScopeResolution:
    """Resolve current cut scope or report unavailable peer assessment."""
    if requested_scope == "track":
        return ResolvedCutScope("intentional_track")

    try:
        from podcast_mcp.engines.speaker_id import (
            assess_speaker_cut_role,
            load_all_profiles,
        )
        from podcast_mcp.transcript_context import load_transcript_context

        if load_all_profiles(project):
            ctx = load_transcript_context(project.workspace_path())
            speaker = assess_speaker_cut_role(
                project,
                cut_track_id,
                src_start,
                src_end,
                ctx.speaker_id,
            )
            if speaker and speaker.get("role") == "bleed":
                return ResolvedCutScope("speaker_bleed")
    except Exception as exc:
        log.debug("speaker cut scope guard skipped: %s", exc, exc_info=True)

    try:
        guard = assess_cross_track_speech(
            project,
            cut_track_id,
            src_start,
            src_end,
            defaults=defaults,
            caches=caches,
            _admissible_spans=_admissible_spans,
        )
    except (OSError, ValueError):
        return CutScopeUnavailable()
    if not guard.blocked:
        return ResolvedCutScope("session_clear", guard)
    # skip and review: never session-ripple over live peer speech.
    return ResolvedCutScope("peer_speech", guard)
