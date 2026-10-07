"""Where a voice begins and ends around a cut, and where the next word starts after a
filler, read from the audio (#978, #1061, #1064).

A cut's left edge has the mirror problem. The aligner starts a filler late: both lab
"um"s voice 320-350 ms before their word start (616.26, 713.00), so a cut from the
word start leaves the head of the "um" audible. :func:`voice_onset` walks back
from the word start to the last quiet frame before the filler's voice.

The kept words either side of a cut have the same problem in reverse. Word times
end a word before its voice does: the lab "So" at 230.78 voices for 200 ms more and
decays under the audibility floor only at 230.98, so a mute from 230.805 cut the
second half of the word. :func:`voice_end` walks forward from a kept word's end to
its first quiet frame, and :func:`voice_onset` walks back from the next kept word's
start, so a cut never starts or ends inside either word's voice.

A padded filler cut fades back in on whatever follows its right edge, so that edge
must keep the next word's first phoneme and a plosive's burst whole. Word times
cannot place it: Whisper and the forced aligner drift by up to ~1.2 s on the lab
tape, and "know, she" runs together with no quiet between. The scan starts at the
loudest frame of the filler's last ``_FILLER_TAIL_SEC`` by word time (so a filler end
the aligner placed inside the next word still starts inside the filler) and stops at
the first sign of new sound:

* After the filler decays below the audibility floor, the onset is the first frame
  that is audible again, or the first high-band jump out of the quiet. A plosive's
  closure is quiet; its burst is a short broadband transient that can stay under the
  audibility floor yet jumps clear of the room in the band above 2 kHz.
* With no quiet between (continuous voice), the onset is the foot of the rise: once a
  rise (in level or in the high band) shows a new sound began, walk back to where
  the level started to climb. The dip's trough is too early. The owner still heard
  "uh" when the cut ended at the trough, because the level falls into a low, dark
  stretch and the next word starts at the foot of the rise after it (lab "uh, we":
  trough 706.37, foot 706.42-706.44, 2026-10-05).

The onset's kind says how it can be faded over. A ``BURST`` rises at least
``_BURST_KIND_DB`` in the high band within one frame: a plosive out of closure jumps
from room noise at once (lab 22 and 40 dB), and a fade over it would soften the
burst. A ``GRADUAL`` onset (fricative, glide, nasal, vowel) ramps over several
frames, so a fade-in has room to cover it (lab "know, she" at 1441.71: +4 dB per
frame, the owner approved 112 ms; "uh, we" at 706.45: +10 to +14 dB per frame).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum

import numpy as np

from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.voiced_runs import FRAME_SEC, HOP_SEC
from podcast_mcp.util.dsp import frame_band_db, frame_rms_db

_HIGH_BAND_HZ = 2000.0
# A dip this far under the loudest filler frame since the scan began ends the filler.
_FALL_DB = 3.0
# A level rise this large out of a voiced dip, or a high-band jump this large out of
# a dip or the quiet, is a new sound.
_RISE_DB = 6.0
_BURST_DB = 12.0
# A single-frame high-band jump this large is a plosive's burst. A vowel or glide
# climbing out of a dark stretch gains 10-14 dB per frame, which _BURST_DB still
# calls a new sound, but a fade-in can cover it.
_BURST_KIND_DB = 18.0
# A high-band jump out of the quiet must also reach this level: room noise on the lab
# tape sits near -95 dB in that band and flickers by about 10 dB.
_BURST_FLOOR_DB = -70.0
# A frame counts as the climb's lower step only when it is this far under the next:
# the dark stretch before a rise is flat to a fraction of a dB, not a ramp.
_FOOT_DB = 0.5
_FILLER_TAIL_SEC = 0.15
# Frames read past ``end`` so a rise there can still confirm a dip before it.
_CONFIRM_SEC = 0.06


class OnsetKind(Enum):
    BURST = "burst"
    GRADUAL = "gradual"


@dataclass(frozen=True)
class Onset:
    """Where new sound begins (source seconds) and whether a fade-in may cover it."""

    sec: float
    kind: OnsetKind


def voice_onset(
    cache: TrackAudioCache, word_start: float, floor: float, *, quiet_db: float
) -> float | None:
    """Where a word's voice begins (source seconds), walking back from its word start.

    The word is a filler a cut starts at, or the kept word a cut must end before.
    The walk stops at the first frame under ``quiet_db``; the onset is the start of
    the audible frame after it. It does not bridge short dips the way voiced runs do:
    the "ss" of "digress." falls under the floor for only 20 ms before the
    owner-approved "uh" at 706.02 on the lab tape. ``word_start`` comes back when
    the voice begins at or after the word start, or inside the frame holding it.
    ``None`` means the level never drops under ``quiet_db`` back to ``floor``, so the
    voice runs on from whatever lies there with no quiet frame to cut in.
    """
    sr = int(cache.waveform.sample_rate)
    frame = max(1, round(sr * FRAME_SEC))
    hop = max(1, round(sr * HOP_SEC))
    t0 = math.floor(max(0.0, floor) / HOP_SEC) * HOP_SEC
    levels = frame_rms_db(cache.window(t0, word_start + FRAME_SEC), frame, hop)
    k = min(levels.size - 1, math.floor((word_start - t0) / HOP_SEC + 1e-9))
    if k < 0 or levels[k] < quiet_db:
        return word_start
    while k > 0 and levels[k - 1] >= quiet_db:
        k -= 1
    if k == 0:
        return None
    onset = t0 + k * hop / sr
    # The onset frame holds the voice somewhere in its 20 ms; only a frame wholly
    # before the word start shows the voice began earlier.
    return onset if onset + FRAME_SEC <= word_start + 1e-9 else word_start


def voice_end(
    cache: TrackAudioCache, word_end: float, ceiling: float, *, quiet_db: float
) -> float | None:
    """Where a kept word's voice ends (source seconds), walking forward from its word end.

    The mirror of :func:`voice_onset`. The walk stops at the first frame under
    ``quiet_db``; the voice ends with the audible frame before it, where a voiced
    run's edge would sit. ``word_end`` comes back when the voice ends at or before
    the word end, or inside the frame holding it. ``None`` means the level never
    drops under ``quiet_db`` before ``ceiling``: the voice runs on through
    everything up to there.
    """
    sr = int(cache.waveform.sample_rate)
    frame = max(1, round(sr * FRAME_SEC))
    hop = max(1, round(sr * HOP_SEC))
    t0 = math.floor(max(0.0, word_end) / HOP_SEC + 1e-9) * HOP_SEC
    levels = frame_rms_db(cache.window(t0, max(t0, ceiling) + FRAME_SEC), frame, hop)
    # Frames that start before the ceiling.
    last = min(levels.size, math.ceil((ceiling - t0) / HOP_SEC - 1e-9))
    if last <= 0 or levels[0] < quiet_db:
        return word_end
    k = 0
    while k + 1 < last and levels[k + 1] >= quiet_db:
        k += 1
    if k + 1 >= last:
        return None
    tail = t0 + k * hop / sr
    # The voice ends with its last audible frame, as a voiced run does. That frame
    # holds the voice somewhere in its 20 ms; only a frame wholly after the word end
    # shows the voice ran on.
    return tail + FRAME_SEC if tail >= word_end - 1e-9 else word_end


def next_onset(
    cache: TrackAudioCache, filler_end: float, end: float, *, quiet_db: float
) -> Onset | None:
    """Where new sound begins after a filler, if it begins before ``end``.

    ``filler_end`` is the filler's word-time end; ``quiet_db`` is the audibility floor.
    Times are frame starts on the absolute 10 ms grid, so the returned onset is never
    later than the sound it marks.
    """
    sr = int(cache.waveform.sample_rate)
    frame = max(1, round(sr * FRAME_SEC))
    hop = max(1, round(sr * HOP_SEC))
    t0 = math.floor(max(0.0, filler_end - _FILLER_TAIL_SEC) / HOP_SEC) * HOP_SEC
    samples = cache.window(t0, end + _CONFIRM_SEC + FRAME_SEC)
    levels = frame_rms_db(samples, frame, hop)
    bands = frame_band_db(samples, sr, frame, hop, lo_hz=_HIGH_BAND_HZ)
    if levels.size == 0:
        return None

    def at(k: int) -> float:
        return t0 + k * hop / sr

    def onset_at(k: int, foot: int) -> Onset | None:
        if at(foot) >= end:
            return None
        jumps = (bands[j] - bands[j - 1] >= _BURST_KIND_DB for j in (k, k - 1) if j >= 1)
        return Onset(at(foot), OnsetKind.BURST if any(jumps) else OnsetKind.GRADUAL)

    tail = max(1, round((filler_end - t0) / HOP_SEC) + 1)
    first = peak_k = int(np.argmax(levels[:tail]))
    dip_level = dip_band = math.inf
    quiet_band: float | None = None
    for k in range(first, levels.size):
        level, band = float(levels[k]), float(bands[k])
        if quiet_band is not None:
            if level >= quiet_db or (band >= _BURST_FLOOR_DB and band >= quiet_band + _BURST_DB):
                return onset_at(k, k)
            quiet_band = min(quiet_band, band)
            continue
        if level < quiet_db:
            quiet_band = band
            continue
        if level >= levels[peak_k]:
            peak_k = k
            dip_level, dip_band = level, band
            continue
        dip_level, dip_band = min(dip_level, level), min(dip_band, band)
        dipped = dip_level <= levels[peak_k] - _FALL_DB
        rose = (dipped and level >= dip_level + _RISE_DB) or band >= dip_band + _BURST_DB
        # A new sound goes on; the click of voice stopping dead falls quiet next frame.
        if rose and k + 1 < levels.size and levels[k + 1] >= quiet_db:
            foot = k
            while foot - 1 > peak_k and levels[foot - 1] <= levels[foot] - _FOOT_DB:
                foot -= 1
            return onset_at(k, foot)
    return None
