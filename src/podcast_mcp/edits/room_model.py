"""A recording's room tone and the sounds that rise out of it, read from its own levels (#1055).

Air is a recording's room tone: its levels where nobody is sounding. Sound is whatever
rises out of the room, so the line between them is the room's own, never a level chosen
in advance: where the room's 10 ms frame levels sit and how far they spread, read through
one band (``frame_band_filtered_db``) on both sides of every comparison. A steady room has
a tight line, a room that swings frame to frame a wide one, and a room that wanders slowly
(pumping, HVAC, a compressor's release) a line that follows it down where it dips.

The room is read once for the whole recording, from the frames where nobody in the session
is speaking (:func:`read_recording_room`), so a stretch gets the same sounds whichever
track or pause asks about it. In a conversation a track's own gaps are mostly its peers'
speech bleeding into its mic; read as its room they put the line tens of dB too high.

The levels are averaged in power over ``SMOOTH_SEC`` before they are compared. A frame of
noise wanders by a dB or more, a decay into the room moves by tenths of a dB a frame, and
only the average lets the line sit close enough to the room to see the decay's tail.

Pure functions of level arrays: no audio, no project.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from enum import Enum
from statistics import NormalDist
from typing import NamedTuple

import numpy as np

from podcast_mcp.edits.audio_cache import DIGITAL_SILENCE_DB, LEVEL_FRAME_SEC
from podcast_mcp.util.dsp import (
    SPEECH_BAND,
    BandShape,
    bool_runs,
    bridge_short_dips,
    frame_level_noise_db,
)

SMOOTH_SEC = 0.05
# A breath sits this far under its speaker's speech level: from the nearest to the deepest
# (breaths on the lab tape sit 6 to 39 dB under it, #814). A sound that reaches the deepest
# is kept whole; a track whose room reaches it cannot tell air from sound.
BREATH_BELOW_SPEECH_DB = (7.0, 40.0)
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
# A room that wanders (pumping, HVAC, a compressor's release) reads wide over the whole
# recording, and where it dips its line and reach sit several dB over the room under a
# breath. So the room is read again within 0.25 s either side of each frame: short enough
# to follow a swing of a second or two, long enough that a breath leaves part of the window
# to the room. On the 29 wander, swell and steady scenes (20 trials each), 0.5 s left 21
# edges inside a sound in some third octave and 15 audible after the render's high-pass;
# 0.35 s left 11 and 7; 0.25 s left 5 and 3, at 0.014 less of the air kept than 0.5 s;
# 0.2 s and 0.15 s left 6 and 5 third-octave edges, 4 audible, and no more air. The floor
# is read every 0.1 s and drawn straight between.
LOCAL_ROOM_SEC = 0.25
LOCAL_HOP_SEC = 0.1
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
# A breath that sits only a few dB over a floor that jitters (a denoiser's) never crosses the
# line a frame must clear, which is four spreads up. But it stays up: a stretch of frames all
# over the room by a spread, and over it on average by what its length makes a few spreads
# (the average of ``n`` frames wanders ``SUSTAIN_CORRELATED_FRAMES / n`` as far as one, the
# 50 ms average being five frames deep) is a sound however low it runs.
SUSTAIN_FLOOR_SPREADS = 1.0
SUSTAIN_SPREADS = 4.0
SUSTAIN_CORRELATED_FRAMES = 5
SUSTAIN_MIN_SEC = 0.08
# A gate that holds a track at digital silence for most of the frames where nobody speaks has
# digital silence for a room: whatever the track does between those frames is sound. A few
# runs of it (a denoiser's mute, a gap in the file) are not a gate: on the lab tape a mic
# with 16% of its quiet at digital zero and a live floor between them was read as gated at
# one frame in twenty, and every live frame of it was a sound.
GATED_SHARE = 0.5

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
    """Where a recording's room-tone levels sit (their median) and how far they spread."""

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
    """A sound on one recording's 10 ms frame grid, guard frames included.

    ``removable``: it peaks under the ceiling (40 dB below the recording's speech level),
    so a pause trim may remove it whole. Any sound may only be removed whole or kept whole.
    """

    lo: int
    hi: int
    removable: bool


def merge_sounds(sounds: Iterable[Sound]) -> list[Sound]:
    """``sounds`` in order, those that overlap or touch made one.

    A merged sound is removable only when every part of it is.
    """
    merged: list[Sound] = []
    for sound in sorted(sounds, key=lambda s: (s.lo, s.hi)):
        if merged and sound.lo <= merged[-1].hi:
            last = merged[-1]
            merged[-1] = Sound(last.lo, max(last.hi, sound.hi), last.removable and sound.removable)
        else:
            merged.append(sound)
    return merged


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


def least_spread(sample_rate: int, band: BandShape = SPEECH_BAND) -> float:
    """The least spread a room can have: that of stationary noise in ``band`` averaged
    over ``SMOOTH_SEC``."""
    return frame_level_noise_db(band, sample_rate, SMOOTH_SEC)


class Mode(NamedTuple):
    """Where a recording's levels pile up: the median and spread of its room."""

    level_db: float
    spread_db: float


def read_mode(smooth: np.ndarray, ceiling_db: float, least: float) -> Mode | None:
    """The densest low mode of ``smooth``, or ``None`` when none stands clear.

    The room is the one place a recording's levels pile up. Its mode is the tallest bin
    among the live frames under ``ceiling_db``; its level is the median of the frames within
    a spread of it. Sound adds counts above the mode only as a thin continuum, so the room's
    own half-height is where the count falls to half.
    """
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
    spread = max(float(halved[0]) * width / _HALF_HEIGHT_SIGMAS, least)
    centre = float(edges[peak]) + width / 2.0
    near = live[np.abs(live - centre) <= spread]
    return Mode(float(np.median(near)) if near.size else centre, spread)


def mode_spread(smooth: np.ndarray, ceiling_db: float, least: float) -> float | None:
    """The spread of the densest low mode of ``smooth`` (:func:`read_mode`), if one stands clear."""
    mode = read_mode(smooth, ceiling_db, least)
    return None if mode is None else mode.spread_db


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


def _sample_spread(live: np.ndarray, least: float, prior: float | None) -> float:
    """The lesser of the spread ``live`` says and ``prior``, never under ``least``."""
    return min(s for s in (_clipped_spread(live, least), prior) if s is not None)


def _live_frames(smooth: np.ndarray) -> np.ndarray | None:
    """The live frames of ``smooth``, or ``None`` when a gate holds the track at digital
    silence for ``GATED_SHARE`` of them or more: that silence is its room."""
    live = smooth[smooth > DIGITAL_SILENCE_DB]
    return None if live.size == 0 or live.size <= (1.0 - GATED_SHARE) * smooth.size else live


def read_room(smooth: np.ndarray, least: float, prior: float | None = None) -> Room:
    """The room of the averaged levels ``smooth`` of frames where nobody is speaking.

    A gate's digital silence is a room with no spread at all (``GATED_SHARE``). Otherwise
    the room sits at the 5th percentile of the live frames, read as a normal's median, and
    its spread is the lesser of what the sample says and ``prior``, the spread of the
    recording's room mode. It is never less than ``least``. The odd frame of digital silence
    in a live room is not a level the room's median or spread should count.
    """
    live = _live_frames(smooth)
    if live is None:
        return Room(DIGITAL_SILENCE_DB, least)
    spread = _sample_spread(live, least, prior)
    return Room(float(np.percentile(live, ANCHOR_PERCENTILE)) + _ANCHOR_Z * spread, spread)


def read_conservative_room(smooth: np.ndarray, least: float, prior: float | None = None) -> Room:
    """The room of ``smooth`` when no frame of the session is quiet to read it from.

    The frames are a track's own gaps, where its peers talk and bleed into it, so their
    median is bleed, not room. The room is the sample's 5th percentile itself, not read up
    to a normal's median, with the spread :func:`read_room` would give: the lowest the
    sample can say, so the line sits as low as it can and more of the track is sound.
    """
    live = _live_frames(smooth)
    if live is None:
        return Room(DIGITAL_SILENCE_DB, least)
    return Room(float(np.percentile(live, ANCHOR_PERCENTILE)), _sample_spread(live, least, prior))


class RoomBasis(Enum):
    """Where a recording's room was read from."""

    SESSION_SILENCE = "session_silence"
    OWN_GAPS = "own_gaps"
    OWN_LEVELS = "own_levels"


def read_recording_room(
    smooth: np.ndarray,
    session_silent: np.ndarray,
    own_gaps: np.ndarray,
    least: float,
    ceiling_db: float,
) -> tuple[Room, RoomBasis] | None:
    """A recording's room, read once, and where it was read from; ``None`` when no frame can be.

    The room is read from the frames where nobody in the session is speaking
    (``session_silent``): there a track holds its room tone and nothing else, whatever its
    peers did a moment before. A recording with under ``MIN_ROOM_SEC`` of such frames falls
    back to its own gaps between its words (``own_gaps``), read conservatively
    (:func:`read_conservative_room`). ``ceiling_db`` bounds the recording's room mode,
    which gives the spread a sample that is mostly sound cannot.
    """
    prior = mode_spread(smooth, ceiling_db, least)
    if np.count_nonzero(session_silent) >= _MIN_ROOM_FRAMES:
        return read_room(smooth[session_silent], least, prior), RoomBasis.SESSION_SILENCE
    if np.count_nonzero(own_gaps) >= _MIN_ROOM_FRAMES:
        return read_conservative_room(smooth[own_gaps], least, prior), RoomBasis.OWN_GAPS
    return None


def speaks(live: np.ndarray, speech_db: float | None) -> bool:
    """Whether a recording's ``speech_db`` stands out of its quietest live frames by at least
    the nearest a breath sits under speech: it has speech to tell its air from."""
    return (
        speech_db is not None
        and live.size > 0
        and speech_db - float(np.percentile(live, ANCHOR_PERCENTILE)) >= BREATH_BELOW_SPEECH_DB[0]
    )


def read_unwatched_room(
    smooth: np.ndarray, least: float, speech_db: float | None
) -> tuple[Room, RoomBasis] | None:
    """The room of a recording with no words to say when it speaks; ``None`` when none reads.

    The frames the session calls quiet hold this recording's own speech, so they say nothing
    about its room: it is read from the recording's own levels. One that never speaks (its
    ``speech_db``, the 90th percentile of all its live frames, does not stand out of its
    quietest) is room throughout and reads like any room. One that speaks has its room where
    its levels pile up under 40 dB below that speech (:func:`read_mode`), else the low end
    of all its frames. A gate's digital silence is its room, as ever: digital silence
    fills ``GATED_SHARE`` of the quieter half of the frames.
    """
    live = smooth[smooth > DIGITAL_SILENCE_DB]
    quietest = np.sort(smooth)[: max(1, smooth.size // 2)]
    if live.size == 0 or float(np.mean(quietest <= DIGITAL_SILENCE_DB)) >= GATED_SHARE:
        return Room(DIGITAL_SILENCE_DB, least), RoomBasis.OWN_LEVELS
    if not speaks(live, speech_db):
        return read_room(smooth, least), RoomBasis.OWN_LEVELS
    assert speech_db is not None
    mode = read_mode(smooth, speech_db - BREATH_BELOW_SPEECH_DB[1], least)
    if mode is not None:
        return Room(mode.level_db, mode.spread_db), RoomBasis.OWN_LEVELS
    if live.size < _MIN_ROOM_FRAMES:
        return None
    return read_conservative_room(smooth, least), RoomBasis.OWN_LEVELS


class _Lines(NamedTuple):
    """The room as each frame of a recording sees it: the line and the reach, the level they
    stand over and the spread they are drawn at."""

    line: np.ndarray
    reach: np.ndarray
    level: np.ndarray
    spread: np.ndarray


def _local_lines(smooth: np.ndarray, room: Room, least: float) -> _Lines:
    """The line and the reach at each frame of ``smooth``: ``room``'s, or lower where the
    room near the frame is quieter.

    Within ``LOCAL_ROOM_SEC`` of each frame the room sits at the levels' 5th percentile,
    read as a normal's median as :func:`read_room` reads it. The spread is how far all the
    levels stand over that running floor: the wander is taken out, so it is the
    frame-to-frame spread of a room that swings slowly. Sound only raises a local read
    (more of it near the frame lifts the floor), so the lower of the two lines stands, and
    a stretch that is all sound keeps ``room``'s. A gate's digital silence has no local
    read: its line is its own.
    """
    width = 2 * round(LOCAL_ROOM_SEC / LEVEL_FRAME_SEC) + 1
    if room.level_db <= DIGITAL_SILENCE_DB or smooth.size < width:
        return _Lines(
            np.full(smooth.size, room.line_db),
            np.full(smooth.size, room.reach_db),
            np.full(smooth.size, room.level_db),
            np.full(smooth.size, room.spread_db),
        )
    frames = np.arange(smooth.size)
    centres = frames[:: round(LOCAL_HOP_SEC / LEVEL_FRAME_SEC)]
    starts = np.clip(centres - width // 2, 0, smooth.size - width)
    windows = np.lib.stride_tricks.sliding_window_view(smooth, width)[starts]
    floor = np.interp(frames, centres, np.percentile(windows, ANCHOR_PERCENTILE, axis=1))
    spread = _clipped_spread(smooth - floor, least)
    level = floor + _ANCHOR_Z * spread
    line = level + LINE_SPREADS * spread
    lower = line < room.line_db
    return _Lines(
        np.minimum(room.line_db, line),
        np.minimum(room.reach_db, level + REACH_SPREADS * spread),
        np.where(lower, level, room.level_db),
        np.where(lower, spread, room.spread_db),
    )


def sound_reach(levels: np.ndarray, room: Room, least: float) -> np.ndarray:
    """The unchanged local sound reach on the recording's native frame grid."""
    return _local_lines(smoothed(levels), room, least).reach


def _sustained(
    smooth: np.ndarray, lines: _Lines, ceiling: float, levels: np.ndarray
) -> list[Sound]:
    """Sounds that never cross the line but stay over the room: a run of frames all over it by
    ``SUSTAIN_FLOOR_SPREADS``, dips bridged, at least ``SUSTAIN_MIN_SEC`` long, whose mean
    stands ``SUSTAIN_SPREADS`` spreads of a mean of that many frames over the room."""
    elevated = bridge_short_dips(
        smooth > lines.level + SUSTAIN_FLOOR_SPREADS * lines.spread, _DIP_FRAMES
    )
    found: list[Sound] = []
    for lo, hi in bool_runs(elevated):
        n = hi - lo
        if n < round(SUSTAIN_MIN_SEC / LEVEL_FRAME_SEC):
            continue
        excess = float(np.mean(smooth[lo:hi] - lines.level[lo:hi]))
        need = (
            SUSTAIN_SPREADS
            * float(np.mean(lines.spread[lo:hi]))
            * math.sqrt(SUSTAIN_CORRELATED_FRAMES / n)
        )
        if excess >= need:
            found.append(
                Sound(
                    max(0, lo - SOUND_GUARD_FRAMES),
                    min(levels.size, hi + SOUND_GUARD_FRAMES),
                    bool(levels[lo:hi].max() < ceiling),
                )
            )
    return found


def find_sounds(
    levels: np.ndarray,
    room: Room,
    speech_db: float | None,
    least: float,
    *,
    breath_below_speech_db: tuple[float, float],
    gate_on_speech: bool = True,
) -> list[Sound]:
    """The sounds in ``levels``: where the room's line is crossed, traced out to its reach.

    Each frame's line is lowered where the room near it is quieter (:func:`_local_lines`),
    so a gate or expander that closes further in a long pause, or a room that wanders,
    still gives the quiet its own line.

    With no speech level (a recording with no words, or under half a second of them) every
    sound is kept whole. A track speaks when its speech level stands out of its quietest
    live frames by at least the nearest a breath sits under speech
    (``breath_below_speech_db`` low end). A track that speaks and whose line reaches within
    the far end of that range of its speech cannot tell air from sound, because breaths sit
    down to there: all of it is one sound to keep (``gate_on_speech``; the speech band only,
    since a band of a few tens of Hz has no speech to measure that against). That line is the
    recording's own, not a local one: a room that swings by several dB a second reads a line
    that high, and the local floors that follow its dips are not to be trusted to find every
    breath on a room like that. A track that never speaks (a second mic that carries only its
    room tone) has no speech to protect. A sound quieter than that ceiling may be removed
    whole; digital silence is never a sound.
    """
    smooth = smoothed(levels)
    ceiling = -math.inf if speech_db is None else speech_db - breath_below_speech_db[1]
    if (
        gate_on_speech
        and room.level_db > DIGITAL_SILENCE_DB
        and speaks(smooth[smooth > DIGITAL_SILENCE_DB], speech_db)
        and room.line_db >= ceiling
    ):
        return [Sound(0, levels.size, False)]
    lines = _local_lines(smooth, room, least)
    reach = bridge_short_dips(smooth > lines.reach, _DIP_FRAMES)
    crossed = smooth > lines.line
    sounds = [
        Sound(
            max(0, lo - SOUND_GUARD_FRAMES),
            min(levels.size, hi + SOUND_GUARD_FRAMES),
            bool(levels[lo:hi].max() < ceiling),
        )
        for lo, hi in bool_runs(reach)
        if crossed[lo:hi].any()
    ]
    sounds += _sustained(smooth, lines, ceiling, levels)
    return merge_sounds(sounds)
