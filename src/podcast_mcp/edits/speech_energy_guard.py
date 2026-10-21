"""Peer sound and word measurements for cut policy.

``cut_safety`` owns cut scope and ripple disposition. These measurements share
current playback evidence without deciding whether a caller may apply a cut.
"""

from __future__ import annotations

import logging
import math
import subprocess
from collections.abc import Callable, Collection, Iterable, Sequence
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any, Literal, NamedTuple

import numpy as np

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.audio_cache import track_level_profile
from podcast_mcp.edits.clips_ops import clips_for_track, remove_timeline_range_from_clips
from podcast_mcp.edits.join_speech import JoinSpeechConfig
from podcast_mcp.edits.session_air import (
    SampleRun,
    lane_clip_placements,
    lane_placements,
    read_samples,
)
from podcast_mcp.edits.voiced_runs import (
    FRAME_SEC,
    HOP_SEC,
    PROBE_SEC,
    carries_quiet_speech_pitch,
    carries_speech_pitch,
)
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
    LevelProfile,
    room_floor_db,
    speech_level_db,
)
from podcast_mcp.engines.sample_grid import Piece, lay_out
from podcast_mcp.engines.session_timeline import (
    clip_source_to_timeline_shift,
    clip_timeline_overlap_to_source,
    word_source_span,
)
from podcast_mcp.models import CutSpeechWord, EpisodeProject
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.dsp import DIGITAL_SILENCE_DB, bool_runs, frame_rms_db
from podcast_mcp.util.intervals import intersect_intervals, merge_intervals, subtract_intervals
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


def _guard_cfg(defaults: EffectiveConfig) -> dict[str, Any]:
    return dict((defaults.get("tighten") or {}).get("speech_energy_guard") or {})


def speech_energy_guard_enabled(defaults: EffectiveConfig) -> bool:
    return bool(_guard_cfg(defaults).get("enabled", True))


def validate_speech_energy_on_conflict(defaults: EffectiveConfig) -> ConflictAction:
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
    raise CodedValueError(
        "unknown tighten.speech_energy_guard.on_conflict: "
        f"{raw!r}; valid values: {', '.join(CONFLICT_ACTIONS)}",
        code="pipeline_config_value_invalid",
    )


def speech_energy_on_conflict(defaults: EffectiveConfig) -> ConflictAction:
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
    defaults: EffectiveConfig,
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
            for piece in remove_timeline_range_from_clips(
                [clip], removal_start, removal_end, defaults=defaults
            )
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
    *,
    defaults: EffectiveConfig,
) -> np.ndarray:
    pitchless = np.zeros(own.size, dtype=bool)
    read = timeline_window_samples(
        project, peer_track_id, start, end, caches=caches, defaults=defaults
    )
    if read is None:
        return pitchless
    samples, rate = read
    frame = max(1, round(rate * LEVEL_FRAME_SEC))
    for first, last in bool_runs(own):
        segment = samples[first * frame : last * frame]
        if carries_speech_pitch(segment, rate, interior=True) is not False:
            continue
        if carries_quiet_speech_pitch(segment, rate, interior=True) is True:
            continue
        pitchless[first:last] = True
    return pitchless


# A ringing room falls at least this fast, frame to frame (0.3 dB over a 10 ms frame, a decay
# time near 2 s); a remark or a steady sound that follows the owner's word falls slower.
_TAIL_DECAY_PER_FRAME = 10 ** (-0.03)


def _without_bleed_tails(levels: np.ndarray, own: np.ndarray, dominated: np.ndarray) -> np.ndarray:
    """``own`` less the decaying tail of the owner's bleed that runs on past where it dominated.

    A room rings on after the owner's word: the peer's frames fall away from the bleed level
    toward the level the run settles at, and none of those frames is the peer's. A remark
    begins with a rise, so a run that starts right after a dominated frame is tail only while
    its level keeps falling at the pace of a ringing room (over a pitch-probe window, so one
    frame's flicker does not end it),
    stays under that bleed, and sits more than :data:`VOICE_FLOOR_OVER_ROOM_DB` over the run's
    own lower quartile. A steady sound that follows the owner's word does not fall, so it is not
    tail.
    """
    size = round(PROBE_SEC / LEVEL_FRAME_SEC)
    smooth = np.convolve(10 ** (levels / 10), np.ones(size) / size)[: levels.size]
    kept = own.copy()
    for first, last in bool_runs(own):
        if first == 0 or not dominated[first - 1]:
            continue
        settled = float(np.percentile(levels[first:last], _OWN_ROOM_PERCENTILE))
        for frame in range(first, last):
            if (
                levels[frame] > levels[first - 1]
                or smooth[frame] > smooth[frame - 1] * _TAIL_DECAY_PER_FRAME
                or levels[frame] <= settled + VOICE_FLOOR_OVER_ROOM_DB
            ):
                break
            kept[frame] = False
    return kept


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
    defaults: EffectiveConfig,
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
        defaults=defaults,
    )
    if levels is None:
        return None
    peer = project.track_by_id(peer_track_id)
    gain = peer.gain_db if peer else 0.0
    own = levels > DIGITAL_SILENCE_DB + gain
    refs = _voice_refs(project, [peer_track_id, *owner_track_ids], caches)
    peer_voice = gain + refs[peer_track_id]
    dominated = np.zeros(levels.size, dtype=bool)
    for tid in owner_track_ids:
        owner = timeline_frame_levels_db(
            project,
            tid,
            start,
            end,
            frame_sec=LEVEL_FRAME_SEC,
            hop_sec=LEVEL_FRAME_SEC,
            caches=caches,
            defaults=defaults,
        )
        if owner is None:
            continue
        track = project.track_by_id(tid)
        owner_gain = track.gain_db if track else 0.0
        owner_voice = owner_gain + refs[tid]
        size = min(levels.size, owner.size)
        # Which mic is louder is read on the recordings against each one's own voice, with no
        # balance gain: a gain is a listening choice (#1549).
        owner_louder = (owner[:size] > DIGITAL_SILENCE_DB + owner_gain) & (
            (owner[:size] - owner_voice) - (levels[:size] - peer_voice) >= dominance_db
        )
        dominated[:size] |= owner_louder
        own[:size] &= ~owner_louder
    own = _without_bleed_tails(levels, own, dominated)
    return _PeerFrames(
        levels,
        own,
        lambda: _pitchless_independent_runs(
            project, peer_track_id, start, end, own, caches, defaults=defaults
        ),
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


# Three pitch probes (``PROBE_SEC`` long, a ``HOP_SEC`` apart) need this many level frames; a run
# under it holds no pitch for the pitch test to read.
_PITCH_READABLE_FRAMES = round((PROBE_SEC + 2 * HOP_SEC) / LEVEL_FRAME_SEC)


def _mean_level_db(levels: np.ndarray) -> float:
    return 10 * math.log10(float(np.mean(10 ** (levels / 10))))


def _run_reads(levels: np.ndarray, own: np.ndarray) -> np.ndarray:
    """The level of each pitch-probe window of the peer's own runs, and the mean level of each run
    too short to read a pitch from, which is read by its mean."""
    reads = [np.empty(0)]
    for first, last in bool_runs(own):
        if last - first < _PITCH_READABLE_FRAMES:
            reads.append(np.array([_mean_level_db(levels[first:last])]))
        else:
            reads.extend(
                windows for _, windows in _run_windows(levels[first:last], own[first:last])
            )
    return np.concatenate(reads)


def _independent_frames_are_room(block: _PeerSpan, references: Sequence[_PeerSpan]) -> bool:
    """Whether every frame of ``block`` that is the peer's own is quiet room, not speech.

    Called only where the room cannot be read from the peer's reference frames, because
    the owner's bleed fills them. The peer's own frames then show its room: a run of them
    that carries no speech pitch, and no window of which rises more than
    :data:`~podcast_mcp.edits.audio_cache.VOICE_FLOOR_OVER_ROOM_DB` over the lower quartile
    of the peer's own windows, is room. A run that carries pitch or rises above that quiet may
    be a remark and is not. A run too short for three pitch probes has no pitch to read: it is
    room where its mean power stays within that margin, so the stray frames between the owner's
    words do not hold the decision open (#1361).
    """
    reads = [_run_reads(part.levels, part.own) for part in references]
    if not any(read.size for read in reads):
        return False
    ceiling = (
        room_floor_db(np.concatenate(reads), percentile=_OWN_ROOM_PERCENTILE)
        + VOICE_FLOOR_OVER_ROOM_DB
    )
    pitchless = block.pitchless()
    room_like = np.zeros(block.own.size, dtype=bool)
    for first, last in bool_runs(block.own):
        if last - first < _PITCH_READABLE_FRAMES:
            room_like[first:last] = _mean_level_db(block.levels[first:last]) <= ceiling
            continue
        windows = _run_windows(block.levels[first:last], block.own[first:last])
        if bool(pitchless[first:last].all()) and all(w.max() <= ceiling for _, w in windows):
            room_like[first:last] = True
    return not bool((block.own & ~room_like).any())


def _sustained_reaches(levels: np.ndarray, own: np.ndarray, threshold: float) -> bool:
    """Whether the peer's own frames hold ``threshold`` for a pitch-probe window, not one frame.

    A room's level flickers frame to frame by an amount that grows with how low and steady
    its sound is, so a single frame over a margin read from the room's quiet is the room's
    own peak, not a voice. A run shorter than a window is read by its mean power.
    """
    judged = _run_windows(levels, own)
    if any(bool((windows >= threshold).any()) for _, windows in judged):
        return True
    windowed = {span for span, _ in judged}
    return any(
        _mean_level_db(levels[first:last]) >= threshold
        for first, last in bool_runs(own)
        if (first, last) not in windowed
    )


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
    defaults: EffectiveConfig,
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
            defaults=defaults,
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
                defaults=defaults,
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
            project, peer_track_id, start, end, caches, removal_span=removal_span, defaults=defaults
        )
        decision_spans = removed.spans(removed.sole)
        if removed.shared:
            try:
                source = removed.removed_audio(project, peer_track_id, caches)
                decision_spans = merge_intervals([*decision_spans, *removed.spans(removed.shared)])
            except (OSError, ValueError):
                unavailable = True
    # Under the track's own voice floor a frame holds no voice, whatever its room is (#1549): a
    # peer whose room tone sits 40 dB under its speech never "speaks" in it.
    # A track with no recording, no live audio or no contrast has no voice level to read it against.
    cache = caches.get(peer_track_id) if caches else None
    audible = -math.inf
    if track is not None and (track.media is not None or cache is not None):
        try:
            audible = _peer_profile(project, peer_track_id, caches).audibility_floor_db + gain
        except (OSError, CodedValueError, subprocess.CalledProcessError):
            audible = -math.inf
    audible = audible if math.isfinite(audible) else -math.inf
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
                elif _sustained_reaches(levels, own, max(floor, audible)):
                    return True
            else:
                unavailable = True
    return None if unavailable else False


# A track whose voice level sits this far under the session's loudest voice carries residue,
# not a microphone. Relative, so the guard decides the same at any recording level (#1549).
_RESIDUE_UNDER_LOUDEST_DB = 40.0
# Contrast dialogue mics may sit just under the residue band after per-track level change;
# keep ``path_reference_db`` through this extra headroom so tighten proposals stay fixed (#1529).
_CONTRAST_MIC_RESIDUE_HEADROOM_DB = 12.0


def _gain_db(project: EpisodeProject, track_id: str) -> float:
    track = project.track_by_id(track_id)
    return track.gain_db if track else 0.0


def _peer_profile(
    project: EpisodeProject, track_id: str, caches: TrackRmsCacheSet | None
) -> LevelProfile:
    cache = caches.get(track_id) if caches else None
    return (
        cache.profile
        if cache is not None
        else track_level_profile(project, track_id, sample_rate=_RMS_SAMPLE_RATE)
    )


def _track_voice_db(
    project: EpisodeProject, track_id: str, caches: TrackRmsCacheSet | None
) -> float | None:
    """``track_id``'s ``path_reference_db``, or ``None`` where it has no recording to read."""
    track = project.track_by_id(track_id)
    if track is None:
        return None
    cache = caches.get(track_id) if caches else None
    if track.media is None:
        return cache.profile.path_reference_db if cache is not None else None
    try:
        return _peer_profile(project, track_id, caches).path_reference_db
    except (OSError, CodedValueError, subprocess.CalledProcessError):
        return None


def _voice_refs(
    project: EpisodeProject, track_ids: Iterable[str], caches: TrackRmsCacheSet | None
) -> dict[str, float]:
    """The offset (dB) that puts each track's own speaker at 0 on the common voice scale.

    A call recording can carry another speaker hotter than that speaker's own mic, so levels
    cannot be compared across mics as recorded; each track is read against its own voice
    (``LevelProfile.path_reference_db``), whenever the compared tracks all have a recording of
    their own to read. Otherwise (a track with no media reads its clips' sources, which have
    no voice level of their own; an unreadable file), all are read as recorded: a scale on one
    side of a comparison only is not a scale (#1495, #1549). A track with no contrast whose
    voice sits ``_RESIDUE_UNDER_LOUDEST_DB`` under the session's
    loudest carries residue, not a mic, and is read as recorded: scaled up by its own residue
    level it would out-sound every speaker. A contrast dialogue mic within that band plus
    ``_CONTRAST_MIC_RESIDUE_HEADROOM_DB`` keeps ``path_reference_db`` so tightening does not
    move when one track alone is scaled (#1529).
    """
    tracks = list(dict.fromkeys(track_ids))
    references = {tid: _track_voice_db(project, tid, caches) for tid in tracks}
    if any(reference is None for reference in references.values()):
        return dict.fromkeys(tracks, 0.0)
    loudest = max(
        (
            v
            for t in project.timeline.tracks
            if (v := _track_voice_db(project, t.id, caches)) is not None
        ),
        default=0.0,
    )
    profiles = {tid: _peer_profile(project, tid, caches) for tid in tracks}

    def reference_db(track_id: str, reference: float) -> float:
        profile = profiles[track_id]
        if reference > loudest - _RESIDUE_UNDER_LOUDEST_DB:
            return reference
        if profile.has_contrast and reference > loudest - (
            _RESIDUE_UNDER_LOUDEST_DB + _CONTRAST_MIC_RESIDUE_HEADROOM_DB
        ):
            return reference
        return 0.0

    return {
        tid: reference_db(tid, reference)
        for tid, reference in references.items()
        if reference is not None
    }


def _voice_reach_db(
    project: EpisodeProject, track_id: str, caches: TrackRmsCacheSet | None
) -> float:
    """The level the mean of a stretch must reach to hold ``track_id``'s voice, in recorded dB."""
    reach = _peer_profile(project, track_id, caches).voice_reach_db
    return reach + _gain_db(project, track_id)


# The window a short word is read in where the frame evidence is missing: inside the 40-100 ms
# a syllable fills, so a word is not diluted by the seconds of silence around it.
_FALLBACK_WINDOW_SEC = 0.1


def _loudest_window_db(
    project: EpisodeProject,
    track_id: str,
    span: tuple[float, float],
    mean_db: float,
    caches: TrackRmsCacheSet | None,
    *,
    defaults: EffectiveConfig,
) -> float:
    """The loudest 100 ms window of ``span`` on ``track_id`` (recorded dB, balance gain included), at least ``mean_db``.

    A span's mean is diluted by its silence: a peer word 15 dB under its voice, inside a 3 s
    span, reads under the voice's reach. The loudest window is what a listener hears (#1419).
    ``mean_db`` where the span cannot be read in windows.
    """
    read = timeline_window_samples(project, track_id, *span, caches=caches, defaults=defaults)
    if read is None:
        return mean_db
    samples, rate = read
    frame = max(1, round(rate * _FALLBACK_WINDOW_SEC))
    levels = frame_rms_db(samples, frame, max(1, frame // 2), floor_db=DIGITAL_SILENCE_DB)
    if not levels.size:
        return mean_db
    return max(mean_db, float(levels.max()) + _gain_db(project, track_id))


def _peer_voice_in_level(
    project: EpisodeProject, peer_track_id: str, level_db: float, caches: TrackRmsCacheSet | None
) -> bool | None:
    """Whether a peer's ``level_db`` (recorded dB over a span) holds its voice.

    Where no frame-by-frame calibration can be made, the level is held to the one the peer's
    voice reaches (:attr:`~podcast_mcp.engines.level_profile.LevelProfile.voice_reach_db`):
    a peer with no live audio never speaks. A peer whose loudest frames show no contrast with
    its room has no voice level of its own to read, so it is held to the voice level of the
    session's other tracks (the median of theirs), at any recording level. A lane with no
    recording to read has none to give. ``None`` when the session has no track to read it
    against.
    """
    reach = _voice_reach_db(project, peer_track_id, caches)
    if reach == -math.inf:
        session = []
        for tid in dialogue_track_ids(project):
            try:
                other = _voice_reach_db(project, tid, caches)
            except (OSError, CodedValueError, subprocess.CalledProcessError):
                continue
            if math.isfinite(other):
                session.append(other)
        if not session:
            return None
        reach = float(np.median(session))
    return level_db >= reach


def measure_peer_speech(
    project: EpisodeProject,
    timeline_spans: Sequence[tuple[float, float]],
    *,
    owner_track_ids: Collection[str],
    peer_track_ids: Iterable[str],
    defaults: EffectiveConfig,
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
                        project,
                        tid,
                        s,
                        e,
                        caches=caches,
                        floor_db=DIGITAL_SILENCE_DB,
                        defaults=defaults,
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
    peer_rms: dict[str, float] = {}
    speaking: list[str] = []
    unread: dict[str, list[tuple[float, float]]] = {}
    for tid in peer_track_ids:
        if tid in owner_track_ids:
            continue
        speaks = False
        refs = _voice_refs(project, [tid, *owner_track_ids], caches)
        peer_voice = _gain_db(project, tid) + refs[tid]

        # Which mic is louder is read on the recordings against each one's own voice, without
        # the balance gains (#1549). A peer with a voice of its own is read in the loudest window
        # of the span, so the owner is too: the two levels are of the same kind (#1419).
        def owner_raw(refs: dict[str, float], *, windowed: bool) -> list[float | None]:
            return [
                max(
                    (
                        (
                            _loudest_window_db(project, owner, (s, e), r, caches, defaults=defaults)
                            if windowed
                            else r
                        )
                        - _gain_db(project, owner)
                        - refs[owner]
                        for owner in owner_track_ids
                        if (
                            r := measure_timeline_rms_db(
                                project,
                                owner,
                                s,
                                e,
                                caches=caches,
                                floor_db=DIGITAL_SILENCE_DB,
                                defaults=defaults,
                            )
                        )
                        is not None
                    ),
                    default=None,
                )
                for s, e in checked
            ]

        span_owner_mean = owner_raw(refs, windowed=False)
        span_owner_loudest: list[float | None] | None = None
        for index, (tl_start, tl_end) in enumerate(checked):
            rms = measure_timeline_rms_db(
                project,
                tid,
                tl_start,
                tl_end,
                caches=caches,
                floor_db=DIGITAL_SILENCE_DB,
                defaults=defaults,
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
                defaults=defaults,
            )
            if calibrated is None:
                own_voice = math.isfinite(_voice_reach_db(project, tid, caches))
                if own_voice and span_owner_loudest is None:
                    span_owner_loudest = owner_raw(refs, windowed=True)
                heard = (
                    _loudest_window_db(
                        project, tid, (tl_start, tl_end), rms, caches, defaults=defaults
                    )
                    if own_voice
                    else rms
                )
                owner_levels = span_owner_loudest if own_voice else span_owner_mean
                assert owner_levels is not None
                span_owner = owner_levels[index]
                voiced = _peer_voice_in_level(project, tid, heard, caches)
                raw = heard - peer_voice
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
    *,
    caches: TrackRmsCacheSet | None = None,
    defaults: EffectiveConfig,
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
            project,
            track_id,
            start,
            end,
            frame_sec=FRAME_SEC,
            hop_sec=HOP_SEC,
            caches=caches,
            defaults=defaults,
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
    *,
    caches: TrackRmsCacheSet | None = None,
    defaults: EffectiveConfig,
) -> bool:
    span = (word.timeline_start, word.timeline_end)
    return any(
        word_voice_sounds_in(project, track_id, span, (a, b), caches=caches, defaults=defaults)
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
    caches: TrackRmsCacheSet | None = None,
    defaults: EffectiveConfig,
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
        words = [
            w
            for w in words
            if _voiced_in_parts(project, track_id, w, parts, caches=caches, defaults=defaults)
        ]
    return sorted(words, key=lambda w: w.timeline_start)


def guard_min_overlap_sec(defaults: EffectiveConfig) -> float:
    """Shortest overlap with a removed span that counts as cutting speech."""
    return float(_guard_cfg(defaults).get("min_overlap_sec", 0.03))


class PeerSpeechBlocked(ValueError):
    """``on_conflict: skip`` and peers are speaking over the cut."""

    def __init__(self, peers: tuple[str, ...]) -> None:
        super().__init__(
            f"cut blocked: other track(s) speaking in window ({', '.join(peers)}); "
            "leave in or review it"
        )
        self.peers = peers
