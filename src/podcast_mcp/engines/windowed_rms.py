"""A track's 8 kHz samples over one stretch of the timeline, read as the whole track would read them (#2357).

An approve check reads a few seconds around its cut, but the whole-track build behind
``TrackRmsCache`` evaluates and resamples the entire track. :class:`WindowedTrackRmsCache` holds
only a stretch of that track and answers a read inside the stretch with the samples the
whole-track cache holds, bit for bit. A read outside it raises :class:`WindowMiss`, never an
empty or partial answer, so a consumer that needs more than the stretch falls back to the
whole-track build instead of judging a hole.

The cache reports the level profile it was given (a batch's base profile, see
``cut_proof.BatchBase``); a profile measured from the stretch would not be the track's.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np

from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.engines.audio_eval import Piece
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.level_profile import LevelProfile
from podcast_mcp.engines.ungated_audio import resampler_locality

_NO_SAMPLES = np.empty(0, dtype=np.float32)


@dataclass(frozen=True)
class TimelineWindow:
    """The stretch of the timeline a check reads, and the profile each track reports (#2357)."""

    start_sec: float
    end_sec: float
    profiles: Mapping[str, LevelProfile]


class WindowMiss(RuntimeError):
    """A read needed samples the windowed cache does not hold.

    Not an ``OSError`` or ``ValueError``: the checks that tolerate an unreadable file must not
    take a miss for one.
    """


class WindowedTrackRmsCache(TrackRmsCache):
    """``window`` samples starting at ``first_index`` of a ``total_size``-sample track at ``sample_rate``.

    ``window`` and ``_index_range`` follow ``TrackRmsCache`` for the index arithmetic, so a read
    that lands inside the held stretch returns the slice the whole-track cache returns, and a
    read past the end of the track returns what it returns there. Anything that wants the
    whole array (``samples``, ``speech_profile``) raises ``WindowMiss``.
    """

    def __init__(
        self,
        window: np.ndarray,
        *,
        first_index: int,
        total_size: int,
        sample_rate: int,
        profile: LevelProfile,
    ) -> None:
        super().__init__(samples=_NO_SAMPLES, sample_rate=sample_rate, recording_profile=profile)
        self.held = window
        self.first_index = first_index
        self.total_size = total_size

    @property
    def samples(self) -> np.ndarray:
        raise WindowMiss("the whole track was asked of a windowed cache")

    @samples.setter
    def samples(self, value: np.ndarray) -> None:
        """The dataclass constructor assigns the field; the windowed cache keeps ``held`` instead."""

    def __repr__(self) -> str:
        return (
            f"WindowedTrackRmsCache({self.coverage[0]}..{self.coverage[1]} "
            f"of {self.total_size} at {self.sample_rate} Hz)"
        )

    def __eq__(self, other: object) -> bool:
        return self is other

    __hash__ = object.__hash__

    @property
    def coverage(self) -> tuple[int, int]:
        return self.first_index, self.first_index + self.held.size

    @property
    def speech_profile(self) -> LevelProfile:
        raise WindowMiss("the speech profile needs the whole track")

    def with_profile(self, profile: LevelProfile) -> TrackRmsCache:
        if profile is self.profile:
            return self
        return WindowedTrackRmsCache(
            self.held,
            first_index=self.first_index,
            total_size=self.total_size,
            sample_rate=self.sample_rate,
            profile=profile,
        )

    def _index_range(self, t_start: float, t_end: float) -> tuple[int, int] | None:
        lo = max(0.0, t_start - self.timeline_offset_sec)
        hi = max(0.0, t_end - self.timeline_offset_sec)
        i0 = round(lo * self.sample_rate)
        i1 = i0 + round((hi - lo) * self.sample_rate)
        if i1 <= i0 or i0 >= self.total_size:
            return None
        return i0, min(i1, self.total_size)

    def window(self, t_start: float, t_end: float) -> np.ndarray:
        rng = self._index_range(t_start, t_end)
        if rng is None:
            return np.empty(0, dtype=self.held.dtype)
        first, last = self.coverage
        if rng[0] < first or rng[1] > last:
            raise WindowMiss(
                f"samples {rng[0]}..{rng[1]} lie outside the window {first}..{last} "
                f"of a {self.total_size}-sample track"
            )
        return self.held[rng[0] - first : rng[1] - first]


def resampled_window(
    piece: Piece, from_rate: int, rate: int, first: int, last: int
) -> tuple[np.ndarray, int, int] | None:
    """Samples ``[first, last)`` of ``piece`` converted to ``rate`` as the whole conversion gives them.

    Returns ``(samples, first, total)``: the samples, the index of the first one (``first``
    kept inside the track), and the length of the whole conversion. The range is clipped
    to the track. ``None`` when the conversion is not local on this ffmpeg build
    (``resampler_locality``), so the caller keeps the whole-track build.

    The conversion restarts ``warm_up`` input samples before the first wanted output and
    feeds ``guard`` samples past the last one, both calibrated by ``resampler_locality``; the
    restart is on a multiple of the grid, counted from the start of the track, because a
    restart on another sample changes the resampler's phase. A window that stops short of
    the end of the track learns the length of the conversion from a restart near the end.
    """
    if from_rate == rate:
        stop = min(last, piece.size)
        begin = min(first, stop)
        return piece.read(begin, stop), begin, piece.size
    found = resampler_locality(from_rate, rate)
    if found is None:
        return None
    warm_up, guard = found
    grid = from_rate // rate
    size = piece.size

    def convert(begin: int, stop: int) -> np.ndarray:
        return FFmpegEngine.resample_streams(iter([piece.read(begin, stop)]), from_rate, [rate])[
            rate
        ]

    # A run of under a couple of hundred samples emits fewer outputs than its length implies, so
    # every run is at least a few widths long, whatever the window asks.
    shortest = 4 * (warm_up + guard)
    reachable = size // grid * grid
    begin = max(0, min(max(first, 0) * grid, reachable) - warm_up)
    begin = min(begin, max(0, (size - shortest) // grid * grid))
    stop = min(size, max(last * grid + guard, begin + shortest))
    got = convert(begin, stop)
    if stop == size:
        total = begin // grid + got.size
    else:
        tail = max(0, (size - shortest) // grid * grid)
        total = tail // grid + convert(tail, size).size
    kept_first = min(max(first, 0), total)
    kept_last = min(last, total)
    lo = kept_first - begin // grid
    if lo + max(0, kept_last - kept_first) > got.size:
        return None
    return got[lo : lo + max(0, kept_last - kept_first)], kept_first, total
