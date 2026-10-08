"""A track's room tone and the sounds that rise out of it, read from its own levels (#1055).

Air is a track's room tone: its levels where it is not sounding. Sound is whatever rises
out of the room, so the line between them is the room's own, never a level chosen in
advance: where the room's 10 ms frame levels sit and how far they spread, read in the
speech band (``frame_speech_band_db``) on both sides of every comparison. A steady room
has a tight line, a room that swings (pumping, HVAC, a compressor's release) a wide one.

The levels are averaged in power over ``SMOOTH_SEC`` before they are compared. A frame of
noise wanders by a dB or more, a decay into the room moves by tenths of a dB a frame, and
only the average lets the line sit close enough to the room to see the decay's tail.

Pure functions of level arrays: no audio, no project.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import NormalDist

import numpy as np

from podcast_mcp.edits.audio_cache import DIGITAL_SILENCE_DB, LEVEL_FRAME_SEC
from podcast_mcp.util.dsp import bool_runs, bridge_short_dips, frame_level_noise_db

SMOOTH_SEC = 0.05
# A sound is a run of averaged frames over the line, dips of up to 50 ms bridged (a
# breath's or a decay's level flutters for a frame or two, and creaky voice pulses about
# 20 times a second). No trim edge may sit inside one, so each carries a guard frame.
SOUND_DIP_SEC = 0.05
SOUND_GUARD_FRAMES = 1
# The line is four spreads over the room's median: a room whose high side mirrors its low
# side crosses it in one frame of 30,000. A normal room keeps 98% of its frames under two
# spreads, so a sound is traced out to there from where it crosses the line.
LINE_SPREADS = 4.0
REACH_SPREADS = 2.0
CLIP_SPREADS = 3.0
# Sound only adds energy, so a sample read between a track's words can only be too high.
# The room is read from its low side: it sits at the sample's 5th percentile (read as the
# median of a normal), and its spread comes from two low percentiles. A sample that is
# mostly sound reads wide, so the spread is also read from the track's densest low mode,
# which sound can only thin, and the lesser of the two stands.
ANCHOR_PERCENTILE = 5.0
PERCENTILES = (5.0, 25.0)
CLIP_ROUNDS = 10
# The mode must stand twice as tall as the median bin, and its spread is the distance up to
# where its count halves, as the half-height of a normal is 1.18 sigma.
MODE_PROMINENCE = 2.0
MIN_ROOM_SEC = 0.5

_NORMAL = NormalDist()
_ANCHOR_Z = -_NORMAL.inv_cdf(ANCHOR_PERCENTILE / 100.0)
_LOW_Z, _MID_Z = (-_NORMAL.inv_cdf(q / 100.0) for q in PERCENTILES)
_HALF_HEIGHT_SIGMAS = math.sqrt(2.0 * math.log(2.0))
_MIN_ROOM_FRAMES = round(MIN_ROOM_SEC / LEVEL_FRAME_SEC)
# A dip of 50 ms in the levels is shorter in their average: the 5 frames it spans lose the
# 4 that the average reaches in from each side.
_DIP_FRAMES = max(
    0, round(SOUND_DIP_SEC / LEVEL_FRAME_SEC) - (round(SMOOTH_SEC / LEVEL_FRAME_SEC) - 1)
)


@dataclass(frozen=True)
class Room:
    """Where a track's room-tone levels sit (their median) and how far they spread."""

    level_db: float
    spread_db: float

    @property
    def line_db(self) -> float:
        """Frames over this are not the room."""
        return self.level_db + LINE_SPREADS * self.spread_db

    @property
    def reach_db(self) -> float:
        """Where a sound that crossed the line is traced out to."""
        return self.level_db + REACH_SPREADS * self.spread_db


@dataclass(frozen=True)
class Sound:
    """A sound on one track's 10 ms frame grid, guard frames included.

    ``removable``: it peaks under the ceiling (40 dB below the track's speech level), so a
    pause trim may remove it whole. Any sound may only be removed whole or kept whole.
    """

    lo: int
    hi: int
    removable: bool


def smoothed(levels: np.ndarray) -> np.ndarray:
    """``levels`` averaged in power over ``SMOOTH_SEC`` (shorter at the ends of the window)."""
    width = round(SMOOTH_SEC / LEVEL_FRAME_SEC)
    power = np.where(levels > DIGITAL_SILENCE_DB, 10.0 ** (levels / 10.0), 0.0)
    kernel = np.ones(width)
    mean = np.convolve(power, kernel, mode="same") / np.convolve(
        np.ones_like(power), kernel, mode="same"
    )
    out = np.full(levels.shape, DIGITAL_SILENCE_DB)
    heard = mean > 0.0
    out[heard] = np.maximum(10.0 * np.log10(mean[heard]), DIGITAL_SILENCE_DB)
    return out


def least_spread(sample_rate: int) -> float:
    """The least spread a room can have: that of stationary noise averaged over ``SMOOTH_SEC``."""
    return frame_level_noise_db(sample_rate, SMOOTH_SEC)


def mode_spread(smooth: np.ndarray, ceiling_db: float, sample_rate: int) -> float | None:
    """The spread of the densest low mode of ``smooth``, or ``None`` when none stands clear.

    The room is the one place a track's levels pile up. Its mode is the tallest bin among
    the live frames under ``ceiling_db``. Sound adds counts above the mode only as a thin
    continuum, so the room's own half-height is where the count falls to half.
    """
    least = least_spread(sample_rate)
    live = smooth[(smooth > DIGITAL_SILENCE_DB) & (smooth <= ceiling_db)]
    if live.size < _MIN_ROOM_FRAMES:
        return None
    width = max(least / 2.0, 0.25)
    edges = np.arange(live.min(), live.max() + 2 * width, width)
    counts = np.convolve(
        np.histogram(live, bins=edges)[0].astype(float), np.ones(5) / 5.0, mode="same"
    )
    peak = int(np.argmax(counts))
    if counts[peak] < MODE_PROMINENCE * float(np.median(counts[counts > 0])):
        return None
    halved = np.flatnonzero(counts[peak:] <= counts[peak] / 2.0)
    if halved.size == 0:
        return None
    return max(float(halved[0]) * width / _HALF_HEIGHT_SIGMAS, least)


def _clipped_spread(smooth: np.ndarray, least: float) -> float:
    """The spread of the room in ``smooth``, read from its low side and clipped from above.

    Frames more than ``CLIP_SPREADS`` over the room's median (a normal room has one in a
    thousand there) are the tail of the word before or the breath after, so they are
    dropped and the spread is read again from what is left, until the same frames are
    left (a reverberant room's gaps are mostly decay, and read whole they put the room
    several dB too high). A room that swings flat through a range, with no peak, reads
    narrow and the clip takes its upper swings for sound: air is given up, never sound.
    """
    spread, left, kept = least, smooth.size, smooth
    for _ in range(CLIP_ROUNDS):
        low, mid = np.percentile(kept, PERCENTILES)
        spread = max(float(mid - low) / (_LOW_Z - _MID_Z), least)
        kept = smooth[smooth <= float(mid) + (_MID_Z + CLIP_SPREADS) * spread]
        if kept.size == left or kept.size < _MIN_ROOM_FRAMES:
            break
        left = kept.size
    return spread


def read_room(smooth: np.ndarray, sample_rate: int, prior: float | None = None) -> Room:
    """The room of the averaged levels ``smooth`` of a track's frames between its words.

    A gate's digital silence is a room with no spread at all. Otherwise the room sits at
    the sample's 5th percentile, read as a normal's median, and its spread is the lesser
    of what the sample says and ``prior``, the spread of the track's room mode over a
    wider window. It is never less than ``least_spread``.
    """
    least = least_spread(sample_rate)
    low = float(np.percentile(smooth, ANCHOR_PERCENTILE))
    if low <= DIGITAL_SILENCE_DB:
        return Room(low, least)
    spread = min(s for s in (_clipped_spread(smooth, least), prior) if s is not None)
    return Room(low + _ANCHOR_Z * spread, spread)


def find_sounds(
    levels: np.ndarray,
    room: Room,
    speech_db: float | None,
    pause: tuple[int, int],
    sample_rate: int,
    *,
    breath_below_speech_db: tuple[float, float],
) -> list[Sound]:
    """The sounds in ``levels``: where the room's line is crossed, traced out to its reach.

    The room is read between the track's words, where a transcript that misses speech (a
    mic that carries a loud room, a stretch the ASR dropped) leaves the sample mostly
    sound, and where a gate or expander closes less than it does in a long pause. The
    pause's own frames are read the same way, with the same spread, and the lower line of
    the two is the room's: sound in either only raises its line, so the quieter is the
    nearer to the room, and one that is mostly sound can never raise the other's.

    With no speech level (a peer with under 0.5 s of live audio nearby) every sound is
    kept whole. A track speaks when its speech level stands out of its quietest live
    frames by at least the nearest a breath sits under speech (``breath_below_speech_db``
    low end), whatever its room reads as: a window whose frames are mostly bleed or
    speech can misread its room tall. A track that speaks and whose line reaches within
    the far end of that range of its speech cannot tell air from sound, because breaths
    sit down to there: its whole window is one sound to keep. A track that never speaks
    nearby (a second mic that carries only its room tone) has no speech to protect. A
    sound quieter than that ceiling may be removed whole; digital silence is never a
    sound.
    """
    smooth = smoothed(levels)
    frames = smooth[pause[0] : pause[1]]
    if frames.size >= _MIN_ROOM_FRAMES:
        here = read_room(frames, sample_rate, room.spread_db)
        if here.line_db < room.line_db:
            room = here
    nearest, deepest = breath_below_speech_db
    ceiling = -math.inf if speech_db is None else speech_db - deepest
    live = smooth[smooth > DIGITAL_SILENCE_DB]
    speaks = (
        speech_db is not None
        and live.size > 0
        and speech_db - float(np.percentile(live, ANCHOR_PERCENTILE)) >= nearest
    )
    if room.level_db > DIGITAL_SILENCE_DB and speaks and room.line_db >= ceiling:
        return [Sound(0, levels.size, False)]
    reach = bridge_short_dips(smooth > room.reach_db, _DIP_FRAMES)
    crossed = smooth > room.line_db
    sounds: list[Sound] = []
    for lo, hi in bool_runs(reach):
        if not crossed[lo:hi].any():
            continue
        removable = float(levels[lo:hi].max()) < ceiling
        lo, hi = max(0, lo - SOUND_GUARD_FRAMES), min(levels.size, hi + SOUND_GUARD_FRAMES)
        if sounds and lo <= sounds[-1].hi:
            sounds[-1] = Sound(sounds[-1].lo, hi, sounds[-1].removable and removable)
        else:
            sounds.append(Sound(lo, hi, removable))
    return sounds
