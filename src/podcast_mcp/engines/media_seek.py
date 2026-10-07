"""Sample-exact ffmpeg seeks for every container (#1141).

An input-side ``-ss`` on its own is not sample-exact. ffmpeg's AAC decoder trims
the encoder priming that an ``.m4a`` signals (1024 samples from ffmpeg's encoder)
from the first packet it decodes. Read from the file start, that packet is the
priming. After a seek it is real audio, so the read starts up to about one frame
past the requested time, and a whole frame late for ``-ss 0``. Raw PCM outputs and
``asetpts=PTS-STARTPTS`` then close that gap, and the audio lands early. Files that
signal no priming, such as Zoom's, seek exactly.

Every ffmpeg read that starts past 0 goes through :class:`MediaSeek` instead. The
input seeks to a whole second at least ``SEEK_PREROLL_SEC`` before the start, so
the decoder settles inside the pre-roll, and the pre-roll is then dropped by
timestamp. A whole-second seek point keeps that trim on the microsecond grid that
ffmpeg parses times on, so the window holds the same samples as a decode from 0.
``tests/test_timebase_guards.py`` keeps ``-ss`` out of every other module.
"""

from __future__ import annotations

from dataclasses import dataclass

SEEK_PREROLL_SEC = 0.5
_US_PER_SEC = 1_000_000
_PREROLL_US = round(SEEK_PREROLL_SEC * _US_PER_SEC)


def _us(seconds: float) -> int:
    """Whole microseconds, truncated the way ffmpeg parses a time option."""
    return max(0, int(seconds * _US_PER_SEC + 1e-6))


def _time(us: int) -> str:
    return f"{us // _US_PER_SEC}.{us % _US_PER_SEC:06d}"


def _rescale(us: int, sample_rate: int) -> int:
    """Microseconds to samples, rounded half up like ffmpeg's ``av_rescale_q``."""
    return (us * sample_rate + _US_PER_SEC // 2) // _US_PER_SEC


@dataclass(frozen=True)
class MediaSeek:
    """A read that starts at ``start_us`` from an input seeked to ``seek_us``."""

    start_us: int
    seek_us: int

    @classmethod
    def at(cls, start_sec: float) -> MediaSeek:
        start = _us(start_sec)
        whole_seconds = max(0, start - _PREROLL_US) // _US_PER_SEC
        return cls(start_us=start, seek_us=whole_seconds * _US_PER_SEC)

    def input_args(self, end_sec: float | None = None) -> list[str]:
        """Options before ``-i``: seek to the pre-roll point, read through ``end_sec``."""
        args = ["-ss", _time(self.seek_us)] if self.seek_us else []
        if end_sec is not None:
            args += ["-t", _time(max(0, _us(end_sec) - self.seek_us))]
        return args

    def output_args(self, duration_sec: float | None = None) -> list[str]:
        """Options after ``-i`` for an output fed by this input: drop the pre-roll."""
        skip = self.start_us - self.seek_us
        args = ["-ss", _time(skip)] if skip else []
        if duration_sec is not None:
            args += ["-t", _time(_us(duration_sec))]
        return args

    def offset(self, t_sec: float) -> str:
        """Source time ``t_sec`` on the seeked input's clock, for a filtergraph ``atrim``."""
        return _time(max(0, _us(t_sec) - self.seek_us))

    def first_sample(self, t_sec: float, sample_rate: int) -> int:
        """Source sample that ``atrim=start=offset(t_sec)`` keeps first."""
        return _rescale(self.seek_us, sample_rate) + _rescale(
            max(0, _us(t_sec) - self.seek_us), sample_rate
        )
