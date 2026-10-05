"""Where the next word starts after a filler, read from the audio (#978).

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
* With no quiet between (continuous voice), the onset is the bottom of the dip
  between the filler and the next sound, once a rise out of it (in level or in the
  high band) shows a new sound began. The owner hears the filler's vowel run down
  the dip into a glide such as the "w" of "we" (lab, 706.32 vs 706.44, 2026-10-05).
"""

from __future__ import annotations

import math

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
# A high-band jump out of the quiet must also reach this level: room noise on the lab
# tape sits near -95 dB in that band and flickers by about 10 dB.
_BURST_FLOOR_DB = -70.0
_FILLER_TAIL_SEC = 0.15
# Frames read past ``end`` so a rise there can still confirm a dip before it.
_CONFIRM_SEC = 0.06


def next_onset_sec(
    cache: TrackAudioCache, filler_end: float, end: float, *, quiet_db: float
) -> float | None:
    """Source time where new sound begins after a filler, if it begins before ``end``.

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

    tail = max(1, round((filler_end - t0) / HOP_SEC) + 1)
    first = peak_k = int(np.argmax(levels[:tail]))
    dip_level = dip_band = math.inf
    quiet_band: float | None = None
    for k in range(first, levels.size):
        level, band = float(levels[k]), float(bands[k])
        if quiet_band is not None:
            if level >= quiet_db or (band >= _BURST_FLOOR_DB and band >= quiet_band + _BURST_DB):
                return at(k) if at(k) < end else None
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
            trough = peak_k + 1 + int(np.argmin(levels[peak_k + 1 : k + 1]))
            return at(trough) if at(trough) < end else None
    return None
