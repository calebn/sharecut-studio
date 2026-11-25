from __future__ import annotations

import dataclasses
from collections.abc import Hashable
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from podcast_mcp.engines.copy_timbre import LIKENESS_FRAMES, confirmed_likeness, copy_similarity
from podcast_mcp.engines.decode_memo import decode_once
from podcast_mcp.engines.envelope_lag import (
    COPY_FRAME_SEC,
    COPY_HOP_SEC,
    LEVEL_FLOOR_DB,
    MAX_COPY_LAG_SEC,
    PEER_OPEN_DB,
    copy_lag,
    copy_levels_db,
)
from podcast_mcp.engines.level_profile import (
    LevelProfile,
    file_level_profile,
    speech_level_profile,
    track_profile,
)
from podcast_mcp.engines.ungated_audio import keep_mono_full, load_mono_full
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.dsp import DIGITAL_SILENCE_DB, SPEECH_BAND, band_filter, rms_db
from podcast_mcp.util.fingerprint import file_stamp

if TYPE_CHECKING:
    from podcast_mcp.engines.bleed_echo import EchoPairProfile

RMS_SAMPLE_RATE = 8000
# A path is a one-way leak when the reverse path has this many times fewer consistent frames.
# Frames count talk time as well as leak strength, so the ratio must exceed any plausible
# split of the talking (one speaker under 2% of it); the Daniela pair measures 164.
ONE_WAY_RATIO = 50


@dataclass
class TrackRmsCache:
    """Decoded mono audio for fast repeated window reads (timeline seconds).

    Decoding a track once (~1-2s for an hour of audio) and slicing the resulting
    array in memory avoids repeated decoding for RMS windows. WAV windows are
    already read in-process; other containers may use the existing decoder
    fallback. This cache backs both RMS-level measurements (`rms_db`) and
    raw-sample access (`window`, for waveform-boundary scoring) used throughout
    tighten/inaudible-cut analysis.
    See docs/pipeline.md#performance.
    """

    samples: np.ndarray
    sample_rate: int = RMS_SAMPLE_RATE
    timeline_offset_sec: float = 0.0
    recording_profile: LevelProfile | None = field(default=None, repr=False)

    @cached_property
    def profile(self) -> LevelProfile:
        """The track's level profile: the one it was given (its recording's, or a batch's base profile), else measured from these samples."""
        if self.recording_profile is not None:
            return self.recording_profile
        return track_profile(self.samples, int(self.sample_rate))

    def with_profile(self, profile: LevelProfile) -> TrackRmsCache:
        """The same samples reporting ``profile``; this cache, which a build may share, is left as it is."""
        return dataclasses.replace(self, recording_profile=profile)

    @cached_property
    def speech_profile(self) -> LevelProfile:
        """Speech-band profile for reconcile audibility (#1377)."""
        return speech_level_profile(self.samples, int(self.sample_rate))

    @classmethod
    def from_timeline_stem(cls, path: Path, *, sample_rate: int = RMS_SAMPLE_RATE) -> TrackRmsCache:
        samples = load_mono_full(path, sample_rate=sample_rate)
        profile = file_level_profile(path, samples, sample_rate=sample_rate)
        return cls(samples=samples, sample_rate=sample_rate, recording_profile=profile)

    @classmethod
    def from_recording(cls, path: Path, *, sample_rate: int = RMS_SAMPLE_RATE) -> TrackRmsCache:
        """:meth:`from_timeline_stem` for a raw workspace recording, decoded once per process.

        A repeat call while the file is unchanged gets a fresh cache over the first decode
        (``engines/decode_memo.py``). A symlinked recording is decoded through its resolved path.
        Never use it for a temp render or a processed stem.
        """
        before = file_stamp(path) if path.is_file() else None
        cache = decode_once(
            path,
            sample_rate,
            lambda decoded: cls.from_timeline_stem(decoded, sample_rate=sample_rate),
        )
        keep_mono_full(path, cache.samples, sample_rate=sample_rate, unchanged_since=before)
        return cache

    def _index_range(self, t_start: float, t_end: float) -> tuple[int, int] | None:
        lo = max(0.0, t_start - self.timeline_offset_sec)
        hi = max(0.0, t_end - self.timeline_offset_sec)
        i0 = round(lo * self.sample_rate)
        i1 = i0 + round((hi - lo) * self.sample_rate)
        if i1 <= i0 or i0 >= self.samples.size:
            return None
        return i0, min(i1, self.samples.size)

    def window(self, t_start: float, t_end: float) -> np.ndarray:
        """Raw sample slice for [t_start, t_end) timeline seconds; empty if out of range.

        The start and the length are each rounded to a sample, as ``lane_window.lane_window``
        reads the same window uncached, so both readers return the same samples (#1560).
        """
        rng = self._index_range(t_start, t_end)
        if rng is None:
            return np.empty(0, dtype=self.samples.dtype)
        return self.samples[rng[0] : rng[1]]

    def rms_db(
        self, t_start: float, t_end: float, *, floor_db: float = DIGITAL_SILENCE_DB
    ) -> float | None:
        dur = t_end - t_start
        if dur <= 0.005:
            return None
        window = self.window(t_start, t_end)
        if window.size == 0:
            return None
        return rms_db(window, floor_db=floor_db)

    def speech_rms_db(
        self, t_start: float, t_end: float, *, floor_db: float = DIGITAL_SILENCE_DB
    ) -> float | None:
        """RMS (dB) of the speech-band content in ``[t_start, t_end)``."""
        dur = t_end - t_start
        if dur <= 0.005:
            return None
        window = self.window(t_start, t_end)
        if window.size == 0:
            return None
        filtered = band_filter(window, int(self.sample_rate), SPEECH_BAND)
        return rms_db(filtered, floor_db=floor_db)


@dataclass(frozen=True)
class CopyPath:
    """How a source mic's voice reaches a bleed mic, measured from the audio (#1052).

    ``lag_sec`` is how far the source's own track trails its copy here (a remote
    participant's track arrives after the room carries their voice); 0.0 when the
    shared envelope estimator is not confident or the copy's timbre does not confirm
    its lag (``copy_timbre.confirmed_likeness``, #1070). ``likeness`` is the
    fine-spectrum match a typical stretch of the copy reaches; None when the lag is 0.0.
    """

    lag_sec: float = 0.0
    likeness: float | None = None

    def carries(self, match: float) -> bool:
        """Whether a window with this fine-spectrum match sounds like the copy."""
        return self.likeness is not None and match >= self.likeness


@dataclass
class TrackRmsCacheSet:
    caches: dict[str, TrackRmsCache] = field(default_factory=dict)
    audio_identity: Hashable | None = field(default=None, compare=False, repr=False)
    _echo_pairs: list[EchoPairProfile] | None = field(
        default=None, init=False, repr=False, compare=False
    )
    _copy_paths: dict[tuple[str, str], CopyPath] = field(
        default_factory=dict, init=False, repr=False, compare=False
    )
    _lag_steps: dict[str, object] = field(
        default_factory=dict, init=False, repr=False, compare=False
    )
    _path_samples: dict[str, np.ndarray] = field(
        default_factory=dict, init=False, repr=False, compare=False
    )

    def get(self, track_id: str) -> TrackRmsCache | None:
        return self.caches.get(track_id)

    def path_samples(self, track_id: str) -> np.ndarray:
        """The track's samples with its voice level at 0 dB, as the bleed path reads them.

        Each track is read against its own voice (``LevelProfile.voice_db``), so the bleed
        path's levels mean the same at any recording gain, whichever track it is.
        """
        if track_id not in self._path_samples:
            cache = self.caches[track_id]
            gain = cache.profile.voice_gain
            self._path_samples[track_id] = (
                cache.samples if gain == 1.0 else cache.samples * np.float32(gain)
            )
        return self._path_samples[track_id]

    def echo_pairs(self) -> list[EchoPairProfile]:
        """Directed mic pairs with a measured bleed path, from cached timeline audio.

        ``echo_risk_pairs`` over the whole timeline-clock tracks, measured once per cache
        set: the acoustic verdict and the text-match rule both read it (#774).
        """
        if self._echo_pairs is None:
            # bleed_echo reaches this module through the edits package; import lazily.
            from podcast_mcp.engines.bleed_echo import echo_risk_pairs

            rate = next((c.sample_rate for c in self.caches.values()), RMS_SAMPLE_RATE)
            self._echo_pairs = echo_risk_pairs(
                {tid: self.path_samples(tid) for tid in self.caches},
                {tid: cache.profile.path_reference_db for tid, cache in self.caches.items()},
                sample_rate=rate,
            )
        return self._echo_pairs

    def bleed_paths(self, track_id: str) -> dict[str, CopyPath]:
        """Mics whose voice reaches ``track_id`` over a measured path, and how."""
        return {
            p.source_track_id: self.copy_path(p.source_track_id, track_id)
            for p in self.echo_pairs()
            if p.bleed_track_id == track_id
        }

    def leak_paths(self, track_id: str) -> dict[str, CopyPath]:
        """``bleed_paths`` less the mics whose path into ``track_id`` only echoes its own.

        Two mics that hear one sound at a fixed level ratio (a call recording carries the
        remote voice, and the room mic carries the host) measure a path both ways, but one
        way is a leak and the other is the co-timed speech of the same moments. A mic
        whose reverse path (from ``track_id`` into it) rests on at least ``ONE_WAY_RATIO``
        times this path's consistent frames is not a source for the words on ``track_id``:
        a word there is not judged its copy because that mic sounds louder (#1495).
        """
        evidence = {
            (p.source_track_id, p.bleed_track_id): p.consistent_frames for p in self.echo_pairs()
        }
        return {
            source: path
            for source, path in self.bleed_paths(track_id).items()
            if evidence.get((track_id, source), 0) < ONE_WAY_RATIO * evidence[(source, track_id)]
        }

    def path_lag_sec(self, source_track_id: str, bleed_track_id: str) -> float:
        """How far the source's own track trails its copy on the bleed mic; 0.0 off a measured path."""
        path = self.bleed_paths(bleed_track_id).get(source_track_id)
        return 0.0 if path is None else path.lag_sec

    def copy_path(self, source_track_id: str, bleed_track_id: str) -> CopyPath:
        """The source's copy lag and likeness on the bleed mic, measured once per pair.

        The lag comes from the bleed gate's envelope estimator (``envelope_lag.copy_lag``)
        over every frame near the source's speech. The likeness is read where the
        source, at that lag, talks in its louder half and out-levels this open mic:
        there the mic carries the copy, whoever its transcript says is talking.
        """
        key = (source_track_id, bleed_track_id)
        if key not in self._copy_paths:
            self._copy_paths[key] = self._measure_copy_path(source_track_id, bleed_track_id)
        return self._copy_paths[key]

    def lane_lag_steps(self, project: EpisodeProject, lane_id: str):
        if lane_id not in self._lag_steps:
            from podcast_mcp.engines.bleed_audibility_lag import lag_steps_for_lane

            self._lag_steps[lane_id] = lag_steps_for_lane(project, self, lane_id)
        return self._lag_steps[lane_id]

    def copy_match(
        self,
        source_track_id: str,
        bleed_track_id: str,
        t_start: float,
        t_end: float,
        *,
        lag_sec: float | None = None,
    ) -> float:
        """Median fine-spectrum match of a bleed-mic window with the source at its lag."""
        bleed = self.caches[bleed_track_id]
        lag_value = (
            lag_sec
            if lag_sec is not None
            else self.copy_path(source_track_id, bleed_track_id).lag_sec
        )
        lag = round(lag_value / COPY_HOP_SEC)
        first = round((t_start - bleed.timeline_offset_sec) / COPY_HOP_SEC)
        last = round((t_end - bleed.timeline_offset_sec - COPY_FRAME_SEC) / COPY_HOP_SEC)
        frames = np.arange(first, max(first, last) + 1)
        return float(
            np.median(
                copy_similarity(
                    self.path_samples(bleed_track_id),
                    self.path_samples(source_track_id),
                    frames,
                    lag,
                    sample_rate=bleed.sample_rate,
                )
            )
        )

    def _measure_copy_path(self, source_track_id: str, bleed_track_id: str) -> CopyPath:
        source, bleed = self.caches.get(source_track_id), self.caches.get(bleed_track_id)
        if (
            source is None
            or bleed is None
            or source.sample_rate != bleed.sample_rate
            or source.timeline_offset_sec != bleed.timeline_offset_sec
        ):
            return CopyPath()
        own_samples = self.path_samples(bleed_track_id)
        peer_samples = self.path_samples(source_track_id)
        own = copy_levels_db(own_samples, sample_rate=bleed.sample_rate)
        peer = copy_levels_db(peer_samples, sample_rate=source.sample_rate)
        reach = round(MAX_COPY_LAG_SEC / COPY_HOP_SEC)
        count = min(own.size, peer.size)
        talking = np.zeros(own.size)
        talking[:count] = peer[:count] > PEER_OPEN_DB
        near = np.convolve(talking, np.ones(2 * reach + 1), mode="same") > 0
        lag = copy_lag(own, peer, np.flatnonzero(near))
        if not lag:
            return CopyPath()
        direct = np.full(own.size, LEVEL_FLOOR_DB)
        lo, hi = max(0, -lag), min(own.size, peer.size - lag)
        direct[lo:hi] = peer[lo + lag : hi + lag]
        # The copy is quieter than its source as recorded: each level back at its own voice.
        gap = bleed.profile.path_reference_db - source.profile.path_reference_db
        frames = (direct > PEER_OPEN_DB) & (own > LEVEL_FLOOR_DB) & (own + gap < direct)
        if not frames.any():
            return CopyPath()
        loud_db = float(np.median(direct[frames]))
        loud = np.flatnonzero(frames & (direct >= loud_db))
        sample = loud[:: max(1, loud.size // LIKENESS_FRAMES)]
        likeness = confirmed_likeness(
            own_samples, peer_samples, sample, lag, peer, loud_db, sample_rate=bleed.sample_rate
        )
        return CopyPath() if likeness is None else CopyPath(lag * COPY_HOP_SEC, likeness)
