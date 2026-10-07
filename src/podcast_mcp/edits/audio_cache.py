from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass
from functools import cached_property

import numpy as np

from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.dsp import db_to_amplitude, frame_rms_db_stream
from podcast_mcp.util.tracks import track_audio_path

log = logging.getLogger(__name__)

# Matches measure_window_rms_db's default (engines/audio_audit.py) -- used for
# RMS-based join-jump measurement (edits/cut_quality.py).
JUMP_SAMPLE_RATE = 8000
# Matches the existing boundary-snap/breath-detection resolution (edits/inaudible_cuts.py,
# edits/breath_detect.py) -- kept distinct from JUMP_SAMPLE_RATE so results are
# numerically identical to today's per-window ffmpeg reads, not just "close enough".
WAVEFORM_SAMPLE_RATE = 16000

# A level profile: 10 ms frames, the 10th percentile of the live (not digitally
# silent) frames as the room floor and the 90th as the speech level. Breath
# detection reads it from 5 s of kept audio either side of a cut (#814); the voice
# walks in edits/word_onset.py read it over the whole track (#1064).
LEVEL_FRAME_SEC = 0.01
DIGITAL_SILENCE_DB = -200.0
_MIN_LIVE_SEC = 0.5
_ROOM_PERCENTILE = 10.0
_SPEECH_PERCENTILE = 90.0
# A whole track is framed a minute at a time, never as one hour-long float64 copy.
_PROFILE_CHUNK_SEC = 60.0


def level_profile(
    samples: np.ndarray, sample_rate: int, *, whole_track: bool = False
) -> tuple[float, float] | None:
    """``(noise_floor_rms, speech_rms)`` of the live 10 ms frames, or ``None`` when too few.

    A ``whole_track`` profile reads the room over every frame, digital silence
    included: on a track a noise gate holds at digital zero between words (Zoom), the
    quietest live frames are the words' own soft edges, not a room. Any live audio is
    enough for it: its percentiles cover the whole recording, not a few seconds.
    """
    frame = max(1, round(sample_rate * LEVEL_FRAME_SEC))
    chunk = frame * round(_PROFILE_CHUNK_SEC / LEVEL_FRAME_SEC)
    levels = frame_rms_db_stream(
        (samples[i : i + chunk] for i in range(0, samples.size, chunk)),
        frame,
        frame,
        floor_db=DIGITAL_SILENCE_DB,
    )
    live = levels[levels > DIGITAL_SILENCE_DB]
    if live.size == 0 or (not whole_track and live.size < _MIN_LIVE_SEC / LEVEL_FRAME_SEC):
        return None
    floor_db = np.percentile(levels if whole_track else live, _ROOM_PERCENTILE)
    speech_db = np.percentile(live, _SPEECH_PERCENTILE)
    return db_to_amplitude(float(floor_db)), db_to_amplitude(float(speech_db))


@dataclass(frozen=True)
class TrackAudioCache:
    """One dialogue track's raw source audio, decoded once at each resolution
    tighten/cut-quality analysis actually needs, instead of spawning a fresh
    ffmpeg subprocess (~70ms) per tiny window read. See docs/pipeline.md#performance.

    Two separate decodes (not one shared rate) so behavior stays numerically
    identical to the uncached path: jump/RMS measurement and waveform-boundary
    scoring historically ran at different sample rates.
    """

    jump: TrackRmsCache  # JUMP_SAMPLE_RATE -- feeds measure_join_jump_db
    waveform: TrackRmsCache  # WAVEFORM_SAMPLE_RATE -- feeds boundary snap + breath detection

    def window(self, t_start: float, t_end: float) -> np.ndarray:
        """Raw samples at WAVEFORM_SAMPLE_RATE for [t_start, t_end)."""
        return self.waveform.window(t_start, t_end)

    @cached_property
    def track_profile(self) -> tuple[float, float] | None:
        """The whole track's :func:`level_profile`, measured once."""
        return level_profile(
            self.waveform.samples, int(self.waveform.sample_rate), whole_track=True
        )


def build_track_audio_caches(
    project: EpisodeProject, track_ids: Iterable[str]
) -> dict[str, TrackAudioCache]:
    """Decode each track's raw source audio once, for reuse across many
    per-candidate window reads. Build this once up front (e.g. before a
    parallel gather phase) and share it read-only across candidates/threads --
    numpy arrays are safe for concurrent reads with no locking needed.

    Tracks whose media can't be resolved OR whose audio fails to decode (missing
    file, unreadable format, ffmpeg not on PATH, etc.) are silently skipped --
    callers that look up a missing track_id in the returned dict get None and
    fall back to the uncached (subprocess-per-call) path, exactly as if no cache
    were built. This mirrors the existing fault-tolerance of the per-window
    functions (measure_join_jump_db, _snap_boundary_to_waveform) it replaces,
    so a fixture/test with a nonexistent media path degrades gracefully instead
    of raising during cache construction.
    """
    caches: dict[str, TrackAudioCache] = {}
    for tid in track_ids:
        if tid in caches:
            continue
        try:
            path = track_audio_path(project, tid)
            cache = TrackAudioCache(
                jump=TrackRmsCache.from_timeline_stem(path, sample_rate=JUMP_SAMPLE_RATE),
                waveform=TrackRmsCache.from_timeline_stem(path, sample_rate=WAVEFORM_SAMPLE_RATE),
            )
        except Exception as exc:
            log.debug("audio cache skipped for track %s: %s", tid, exc)
            continue
        caches[tid] = cache
    return caches
