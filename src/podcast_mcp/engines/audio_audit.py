from __future__ import annotations

import contextlib
import logging
import math
import re
import tempfile
from collections import Counter
from collections.abc import Callable, Collection
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, get_args

import numpy as np

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.asr_timing import (
    ANOMALOUS_WORD_DURATION_REASON,
    DEFAULT_MAX_SHORT_TOKEN_SEC,
    DEFAULT_MAX_WORD_DURATION_SEC,
    DEFAULT_WORD_SPAN_END_SLACK_SEC,
    word_duration_is_anomalous,
)
from podcast_mcp.engines.audio_eval import evaluate_audio
from podcast_mcp.engines.copy_timbre import LIKENESS_FRAMES, confirmed_likeness, copy_similarity
from podcast_mcp.engines.envelope_lag import (
    COPY_FRAME_SEC,
    COPY_HOP_SEC,
    LEVEL_FLOOR_DB,
    MAX_COPY_LAG_SEC,
    PEER_OPEN_DB,
    copy_lag,
    copy_levels_db,
)
from podcast_mcp.engines.lane_words import (
    WordKey,
    lane_transcripts,
    lanes_transcripts,
    transcript_word_key,
    word_timeline_window,
)
from podcast_mcp.engines.level_profile import (
    LevelProfile,
    file_level_profile,
    speech_level_profile,
    track_profile,
)
from podcast_mcp.engines.session_timeline import SessionTimeline, TimelineClipSpan
from podcast_mcp.engines.timemap import timeline_to_source
from podcast_mcp.engines.ungated_audio import load_mono_full, raw_samples_on_timeline
from podcast_mcp.models import EpisodeProject, TrackRole
from podcast_mcp.util.binaries import resolve_ffmpeg
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.dsp import (
    DIGITAL_SILENCE_DB,
    SPEECH_BAND,
    band_filter,
    frame_rms_db,
    rms_db,
)
from podcast_mcp.util.pcm_stream import NoAudioDecodedError
from podcast_mcp.util.process import CalledProcessError, run
from podcast_mcp.util.progress import (
    ProgressReporter,
    raise_if_cancel_requested,
    resolve_progress_task,
)
from podcast_mcp.util.source_spans import source_span_timeline_bounds
from podcast_mcp.util.tracks import dialogue_track_ids, existing_stem_path, track_audio_path

_LOG = logging.getLogger(__name__)

if TYPE_CHECKING:
    from podcast_mcp.engines.bleed_echo import EchoPairProfile

_RMS_SAMPLE_RATE = 8000
# The transcript gate's overreach check judges a word only where its ungated audio is
# within this of the track's voice level, and calls the word lost where the gated stem
# sits this far under it (-60 and -80 dBFS on the lab tape, whose median voice level is
# -15.3 dBFS).
_GATE_JUDGED_UNDER_VOICE_DB = 45.0
_GATE_LOST_UNDER_VOICE_DB = 65.0
# Acoustic statuses that call for transcript suppression (used both for the flagged/
# bleed report and, via `word_targets`, for suggest-mode's suppression_recommendations).
# A path is a one-way leak when the reverse path has this many times fewer consistent frames.
# Frames count talk time as well as leak strength, so the ratio must exceed any plausible
# split of the talking (one speaker under 2% of it); the Daniela pair measures 164.
ONE_WAY_RATIO = 50
_FLAGGED_STATUSES = ("inaudible", "bleed")


BleedReduction = Literal["mute", "attenuate"]
"""What the transcript gate does to another speaker's copy on a lane (#945)."""
BleedHandling = Literal["auto", "mute", "attenuate"]
"""The configured reduction; ``auto`` picks one per lane from the lane's floor."""


def parse_bleed_handling(value: object) -> BleedHandling:
    for handling in get_args(BleedHandling):
        if value == handling:
            return handling
    raise CodedValueError(
        f"analysis.heuristics.bleed_handling must be one of {get_args(BleedHandling)}, not {value!r}",
        code="pipeline_config_value_invalid",
    )


@dataclass(frozen=True)
class AnalysisPolicy:
    bleed_dominance_db: float = 6.0
    # How the transcript gate reduces another speaker's voice on a lane (#945), and
    # how far ``attenuate`` turns it down.
    bleed_handling: BleedHandling = "auto"
    bleed_attenuation_db: float = 20.0
    gate_onset_drop_db: float = 15.0
    boundary_jump_db: float = 12.0
    min_fade_ms: int = 10
    recommended_fade_ms: int = 20
    # Cap for jump-scaled harsh-join recommendations (ms).
    harsh_fade_max_ms: int = 80
    # Words longer than this skip full-span mean RMS (ASR stretch); status deferred.
    max_word_audibility_sec: float = DEFAULT_MAX_WORD_DURATION_SEC
    # Filler, backchannel and discourse tokens longer than this are trimmed (#979).
    max_short_token_sec: float = DEFAULT_MAX_SHORT_TOKEN_SEC
    # The trim looks this far past a word's end for its voice (#979).
    word_span_end_slack_sec: float = DEFAULT_WORD_SPAN_END_SLACK_SEC
    ml_backend: str = "off"
    transcript_mode: str = "reconcile"
    reconcile_on_render: bool = True
    bleed_text_match_enabled: bool = True
    bleed_text_match_min_overlap_sec: float = 0.02
    bleed_text_match_min_dominance_db: float | None = None
    bleed_ratio_warn_threshold: float = 0.2

    @classmethod
    def from_defaults(cls, defaults: EffectiveConfig) -> AnalysisPolicy:
        cfg = defaults.get("analysis", {})
        heur = cfg.get("heuristics", {})
        min_dom = heur.get("bleed_text_match_min_dominance_db")
        return cls(
            bleed_dominance_db=float(heur.get("bleed_dominance_db", 6.0)),
            bleed_handling=parse_bleed_handling(heur.get("bleed_handling", "auto")),
            bleed_attenuation_db=float(heur.get("bleed_attenuation_db", 20.0)),
            gate_onset_drop_db=float(heur.get("gate_onset_drop_db", 15.0)),
            boundary_jump_db=float(heur.get("boundary_jump_db", 12.0)),
            min_fade_ms=int(heur.get("min_fade_ms", 10)),
            recommended_fade_ms=int(heur.get("recommended_fade_ms", 20)),
            harsh_fade_max_ms=int(heur.get("harsh_fade_max_ms", 80)),
            max_word_audibility_sec=float(
                heur.get("max_word_audibility_sec", DEFAULT_MAX_WORD_DURATION_SEC)
            ),
            max_short_token_sec=float(heur.get("max_short_token_sec", DEFAULT_MAX_SHORT_TOKEN_SEC)),
            word_span_end_slack_sec=float(
                heur.get("word_span_end_slack_sec", DEFAULT_WORD_SPAN_END_SLACK_SEC)
            ),
            ml_backend=str(cfg.get("ml_backend", "off")).lower(),
            transcript_mode=str(cfg.get("transcript_mode", "reconcile")),
            reconcile_on_render=bool(cfg.get("reconcile_on_render", True)),
            bleed_text_match_enabled=bool(heur.get("bleed_text_match_enabled", True)),
            bleed_text_match_min_overlap_sec=float(
                heur.get("bleed_text_match_min_overlap_sec", 0.02)
            ),
            bleed_text_match_min_dominance_db=(float(min_dom) if min_dom is not None else None),
            bleed_ratio_warn_threshold=float(heur.get("bleed_ratio_warn_threshold", 0.2)),
        )


def measure_astats(path: Path, *, ffmpeg: str | None = None) -> dict[str, float | int | None]:
    """Objective per-file health stats via ffmpeg's astats filter.

    Some fields (e.g. Crest factor, Dynamic range) are only printed once in the
    per-channel section for mono audio, not repeated under "Overall" - we take the
    last occurrence of each label across the full stderr output rather than slicing
    to the "Overall" section, so both kinds of fields are captured correctly.
    """
    cmd = [
        ffmpeg or resolve_ffmpeg(),
        "-i",
        str(path),
        "-af",
        "astats=metadata=1:reset=0",
        "-f",
        "null",
        "-",
    ]
    r = run(cmd, capture_output=True, text=True)
    text = r.stderr or ""

    def _grab(label: str) -> float | None:
        matches = re.findall(rf"{re.escape(label)}:\s*(-?inf|-?[\d.]+)", text)
        if not matches:
            return None
        val = matches[-1]
        if val in ("inf", "-inf"):
            return None
        return float(val)

    peak_count = _grab("Peak count")
    return {
        "dc_offset": _grab("DC offset"),
        "peak_level_db": _grab("Peak level dB"),
        "rms_level_db": _grab("RMS level dB"),
        "crest_factor": _grab("Crest factor"),
        "flat_factor": _grab("Flat factor"),
        "peak_count": round(peak_count) if peak_count is not None else None,
        "noise_floor_db": _grab("Noise floor dB"),
        "dynamic_range_db": _grab("Dynamic range"),
    }


# Peak at/above this dBFS, or a positive flat_factor, counts as clipping.
# ``peak_count`` is occasions at the file's own peak, not digital max — do not
# treat a positive count as clipping by itself.
CLIPPING_PEAK_LEVEL_DB = -0.3
# Below this peak nothing can be clipped: flat_factor also counts repeated sample
# values in dithered near-silence (a gated Zoom track peaked at -68.7 dBFS with
# flat_factor 6.0, #775), so the flat-factor test needs a level floor.
CLIPPING_MIN_PEAK_DB = -20.0


def clipping_indicated(astats: dict[str, Any] | None) -> bool:
    """True when astats show pinned crests or near-full-scale peaks.

    A missing ``peak_level_db`` is treated as loud enough, so an astats row that
    only carries ``flat_factor`` still counts.
    """
    if not astats:
        return False
    peak = astats.get("peak_level_db")
    if isinstance(peak, (int, float)):
        if peak >= CLIPPING_PEAK_LEVEL_DB:
            return True
        if peak < CLIPPING_MIN_PEAK_DB:
            return False
    flat = astats.get("flat_factor")
    return isinstance(flat, (int, float)) and flat > 0


def detect_mains_hum(
    path: Path,
    *,
    sample_rate: int = 8000,
    hum_freqs: tuple[float, ...] = (50.0, 60.0),
    harmonics: int = 3,
    bandwidth_hz: float = 2.0,
    threshold_ratio: float = 0.05,
) -> dict[str, Any]:
    """Flag mains hum (50/60Hz + harmonics) via narrowband FFT energy ratio."""
    samples = load_mono_full(path, sample_rate=sample_rate)
    if samples.size < sample_rate * 2:
        return {"hum_detected": False, "reason": "clip too short to analyze"}

    n = samples.size
    windowed = samples * np.hanning(n)
    spectrum = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(n, d=1.0 / sample_rate)
    total_energy = float(np.sum(spectrum**2)) or 1e-12

    ratios: dict[str, float] = {}
    for base in hum_freqs:
        band_energy = 0.0
        for h in range(1, harmonics + 1):
            f = base * h
            if f >= freqs[-1]:
                continue
            mask = np.abs(freqs - f) <= bandwidth_hz
            band_energy += float(np.sum(spectrum[mask] ** 2))
        ratios[f"{int(base)}hz_ratio"] = round(band_energy / total_energy, 5)

    dominant = max(ratios, key=lambda k: ratios[k])
    dominant_ratio = ratios[dominant]
    hum_detected = dominant_ratio >= threshold_ratio
    return {
        "hum_detected": hum_detected,
        "dominant_frequency": dominant,
        "energy_ratios": ratios,
        "threshold_ratio": threshold_ratio,
        "recommendation": (
            f"Mains hum detected around {dominant}; add a notch filter or raise the "
            "highpass cutoff."
            if hum_detected
            else None
        ),
    }


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
    sample_rate: int = _RMS_SAMPLE_RATE
    timeline_offset_sec: float = 0.0
    recording_profile: LevelProfile | None = field(default=None, repr=False)

    @cached_property
    def profile(self) -> LevelProfile:
        """The track's level profile: its recording's, else measured from these samples."""
        if self.recording_profile is not None:
            return self.recording_profile
        return track_profile(self.samples, int(self.sample_rate))

    @cached_property
    def speech_profile(self) -> LevelProfile:
        """Speech-band profile for reconcile audibility (#1377)."""
        return speech_level_profile(self.samples, int(self.sample_rate))

    @classmethod
    def from_samples(
        cls, samples: np.ndarray, *, sample_rate: int = _RMS_SAMPLE_RATE
    ) -> TrackRmsCache:
        return cls(
            samples=samples,
            sample_rate=sample_rate,
            recording_profile=track_profile(samples, sample_rate),
        )

    @classmethod
    def from_timeline_stem(
        cls, path: Path, *, sample_rate: int = _RMS_SAMPLE_RATE
    ) -> TrackRmsCache:
        samples = load_mono_full(path, sample_rate=sample_rate)
        profile = file_level_profile(path, samples, sample_rate=sample_rate)
        return cls(samples=samples, sample_rate=sample_rate, recording_profile=profile)

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

        The start and the length are each rounded to a sample, as ``session_air.lane_window``
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

            rate = next((c.sample_rate for c in self.caches.values()), _RMS_SAMPLE_RATE)
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


def build_reconciliation_caches(
    project: EpisodeProject, *, private_copy: bool = False, defaults: EffectiveConfig
) -> TrackRmsCacheSet:
    """The decodes reconcile and tighten read to tell whose voice a stretch of audio is.

    A gated track is read before its transcript gate, so tighten measures the copy lags of
    the stems reconcile made its audibility verdicts on.

    ``private_copy`` says ``project`` is a copy only the caller holds (``snapshot_project``),
    so the build takes no project lock: a pool worker inside a mutation, whose thread
    does not own the lock, can run it (#1471).
    """
    if any(track.transcript_gate for track in project.tracks):
        return build_track_rms_caches(
            project,
            before_transcript_gate=True,
            private_copy=private_copy,
            unprocessed=True,
            defaults=defaults,
        )
    return build_track_rms_caches(project, unprocessed=True, defaults=defaults)


def build_track_rms_caches(
    project: EpisodeProject,
    *,
    before_transcript_gate: bool = False,
    track_ids: Collection[str] | None = None,
    private_copy: bool = False,
    unprocessed: bool = False,
    defaults: EffectiveConfig,
) -> TrackRmsCacheSet:
    """One decoded cache per dialogue track, from its fresh stem, else its raw clips.

    ``unprocessed`` reads a track that has an effects chain from its clips with the chain
    left out, never from the stem: a compressor's threshold is an absolute dBFS level, so
    the processed audio does not move with the recording's gain (#1495).
    """
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

    caches: dict[str, TrackRmsCache] = {}
    sources: dict[Path, np.ndarray] = {}
    raw_tracks: dict[str, tuple[list[TimelineClipSpan], list[Path]]] = {}
    timeline = SessionTimeline(project)
    for tid in dict.fromkeys(dialogue_track_ids(project) if track_ids is None else track_ids):
        track = project.track_by_id(tid)
        if unprocessed and track is not None and _has_active_chain(project, tid):
            snapshot = project.model_copy(deep=True) if private_copy else _snapshot(project)
            try:
                caches[tid] = _ungated_cache(snapshot, tid, with_chain=False, defaults=defaults)
                continue
            except (OSError, CalledProcessError, NoAudioDecodedError, ValueError) as exc:
                # No unprocessed render: the track's evidence stays as before, processed.
                _LOG.warning(
                    "reconcile evidence for track %s keeps its effects chain: %s", tid, exc
                )
        if before_transcript_gate and track is not None:
            proc = _fresh_stem_path(project, tid, defaults=defaults)
            if not track.transcript_gate and proc is not None:
                caches[tid] = TrackRmsCache.from_timeline_stem(proc)
            elif private_copy:
                caches[tid] = _ungated_cache(project.model_copy(deep=True), tid, defaults=defaults)
            else:
                caches[tid] = _pre_transcript_gate_cache(project, tid, defaults=defaults)
            continue
        proc = _fresh_stem_path(project, tid, defaults=defaults)
        if proc is not None:
            caches[tid] = TrackRmsCache.from_timeline_stem(proc)
            continue

        track = project.track_by_id(tid)
        if track is None:
            continue
        try:
            spans = timeline.lane_clip_spans(tid)
            paths = (
                [resolve_clip_audio_path(project, track, span.clip) for span in spans]
                if spans
                else [track_audio_path(project, tid).resolve()]
            )
        except (OSError, ValueError):
            continue
        raw_tracks[tid] = spans, paths

    remaining_users = Counter(path for _, paths in raw_tracks.values() for path in set(paths))
    for tid, (spans, paths) in raw_tracks.items():
        try:
            samples = raw_samples_on_timeline(spans, paths, sources=sources)
        except (OSError, CalledProcessError, NoAudioDecodedError, ValueError):
            continue
        finally:
            for path in set(paths):
                remaining_users[path] -= 1
                if remaining_users[path] == 0:
                    sources.pop(path, None)
        if samples.size:
            caches[tid] = TrackRmsCache(samples=samples)
    return TrackRmsCacheSet(caches=caches)


def _snapshot(project: EpisodeProject) -> EpisodeProject:
    from podcast_mcp.util.project_state import snapshot_project

    return snapshot_project(project)


def _has_active_chain(project: EpisodeProject, track_id: str) -> bool:
    """Whether the track has a processing chain with an effect that is not bypassed."""
    return any(
        not fx.bypass
        for chain in project.processing_chains
        if chain.track_id == track_id
        for fx in chain.effects
    )


def _pre_transcript_gate_cache(
    project: EpisodeProject, track_id: str, *, defaults: EffectiveConfig
) -> TrackRmsCache:
    return _ungated_cache(_snapshot(project), track_id, defaults=defaults)


def _ungated_cache(
    snapshot: EpisodeProject, track_id: str, *, with_chain: bool = True, defaults: EffectiveConfig
) -> TrackRmsCache:
    """``track_id`` rendered with its transcript gate off, from a private copy it may change.

    ``with_chain=False`` also leaves the track's effects chain out of the render.
    """
    from podcast_mcp.engines.timeline_render import (
        render_track_from_timeline,
        unfiltered_track_audio,
    )

    track = snapshot.track_by_id(track_id)
    if track is None:
        raise CodedValueError(
            f"track {track_id!r} is unavailable. Add media to that track first.",
            code="track_has_no_media",
        )
    track.transcript_gate = False
    if not with_chain:
        snapshot.processing_chains = [
            chain for chain in snapshot.processing_chains if chain.track_id != track_id
        ]
        plain = unfiltered_track_audio(snapshot, track, defaults)
        if plain is not None:
            samples = evaluate_audio(plain[0], crossfade_curve=plain[1], load_source=load_mono_full)
            if samples is not None and samples.size:
                return TrackRmsCache.from_samples(samples)
    with tempfile.TemporaryDirectory(prefix="podcast-ungated-evidence-") as directory:
        path = Path(directory) / "evidence.wav"
        render_track_from_timeline(snapshot, track, path, defaults)
        return TrackRmsCache.from_timeline_stem(path)


def measure_window_rms_db(
    path: Path,
    start_sec: float,
    end_sec: float,
    *,
    sample_rate: int = _RMS_SAMPLE_RATE,
    cache: TrackRmsCache | None = None,
    floor_db: float = DIGITAL_SILENCE_DB,
) -> float | None:
    if cache is not None:
        return cache.rms_db(start_sec, end_sec, floor_db=floor_db)
    dur = end_sec - start_sec
    if dur <= 0.005:
        return None
    try:
        window = load_mono_window(
            path, start_sec=start_sec, duration_sec=dur, sample_rate=sample_rate, antialias=True
        )
    except (ValueError, CalledProcessError):
        return None
    if window.size == 0:
        return None
    return rms_db(window, floor_db=floor_db)


def _speech_rms_from_file(
    path: Path,
    start_sec: float,
    end_sec: float,
    *,
    sample_rate: int = _RMS_SAMPLE_RATE,
    floor_db: float = DIGITAL_SILENCE_DB,
) -> float | None:
    dur = end_sec - start_sec
    if dur <= 0.005:
        return None
    try:
        window = load_mono_window(
            path, start_sec=start_sec, duration_sec=dur, sample_rate=sample_rate, antialias=True
        )
    except (ValueError, CalledProcessError):
        return None
    if window.size == 0:
        return None
    filtered = band_filter(window, sample_rate, SPEECH_BAND)
    return rms_db(filtered, floor_db=floor_db)


def _processed_track_path(project: EpisodeProject, track_id: str) -> Path | None:
    return existing_stem_path(project, track_id)


def _fresh_stem_path(
    project: EpisodeProject, track_id: str, *, defaults: EffectiveConfig
) -> Path | None:
    """The rendered stem when audio may be read from it: it exists and is fresh.

    A stem is the timeline as it was rendered. After an edit moves the timeline it holds
    other audio at the same seconds, so every read of a stem's audio asks here.
    """
    from podcast_mcp.engines.play_audit import stem_is_fresh

    stem = _processed_track_path(project, track_id)
    return (
        stem if stem is not None and stem_is_fresh(project, track_id, defaults=defaults) else None
    )


def _effective_rms_db(rms: float | None, gain_db: float) -> float | None:
    if rms is None:
        return None
    return rms + gain_db


def _word_timeline_span(
    st: SessionTimeline,
    track_id: str,
    src_start: float,
    src_end: float,
) -> tuple[float, float] | None:
    """Map a source-clock word span to a timeline window for stem RMS."""
    start, end = source_span_timeline_bounds(st, track_id, src_start, src_end)
    return (start, end) if start is not None and end is not None else None


def timeline_window_samples(
    project: EpisodeProject,
    track_id: str,
    t_start: float,
    t_end: float,
    *,
    caches: TrackRmsCacheSet | None = None,
    defaults: EffectiveConfig,
) -> tuple[np.ndarray, int] | None:
    """One track's mono samples over timeline ``[t_start, t_end)`` and their rate."""
    cache = caches.get(track_id) if caches else None
    if cache is not None:
        return cache.window(t_start, t_end), cache.sample_rate
    try:
        return _played_window(
            project, track_id, t_start, t_end, defaults=defaults
        ), _RMS_SAMPLE_RATE
    except Exception:
        return None


def _played_window(
    project: EpisodeProject,
    track_id: str,
    t_start: float,
    t_end: float,
    *,
    defaults: EffectiveConfig,
) -> np.ndarray:
    """What plays on ``track_id`` over timeline ``[t_start, t_end)`` now.

    A rendered stem is the timeline as it was when it was rendered, so it is read only while
    it is fresh. After an edit moves the timeline it holds other audio at these seconds, and
    the lane's own recordings are read through its clips instead (the mapping a pause trim's
    air is read through, ``edits/session_air.lane_window``).
    """
    from podcast_mcp.edits.session_air import lane_window

    stem = _fresh_stem_path(project, track_id, defaults=defaults)
    if stem is not None:
        return load_mono_window(
            stem,
            start_sec=t_start,
            duration_sec=t_end - t_start,
            sample_rate=_RMS_SAMPLE_RATE,
            antialias=True,
        )
    track = project.track_by_id(track_id)
    if track is None:
        raise KeyError(track_id)
    return lane_window(project, track, t_start, t_end, _RMS_SAMPLE_RATE)


def _recorded_gain_db(project: EpisodeProject, track_id: str) -> float:
    # The recording's level, not the mix: volume and mute are listening choices.
    track = project.track_by_id(track_id)
    return track.gain_db if track else 0.0


def _rms_for_track_at_timeline(
    project: EpisodeProject,
    track_id: str,
    t_start: float,
    t_end: float,
    *,
    caches: TrackRmsCacheSet | None = None,
    floor_db: float = DIGITAL_SILENCE_DB,
    recorded_gain: bool = True,
    defaults: EffectiveConfig,
) -> float | None:
    cache = caches.get(track_id) if caches else None
    if cache is not None:
        rms = cache.rms_db(t_start, t_end, floor_db=floor_db)
    elif t_end - t_start <= 0.005:
        return None
    else:
        read = timeline_window_samples(project, track_id, t_start, t_end, defaults=defaults)
        if read is None or read[0].size == 0:
            return None
        rms = rms_db(read[0], floor_db=floor_db)
    return _effective_rms_db(rms, _recorded_gain_db(project, track_id) if recorded_gain else 0.0)


def _speech_rms_for_track_at_timeline(
    project: EpisodeProject,
    track_id: str,
    t_start: float,
    t_end: float,
    *,
    caches: TrackRmsCacheSet | None = None,
    floor_db: float = DIGITAL_SILENCE_DB,
    recorded_gain: bool = True,
    defaults: EffectiveConfig,
) -> float | None:
    cache = caches.get(track_id) if caches else None
    if cache is not None:
        rms = cache.speech_rms_db(t_start, t_end, floor_db=floor_db)
    elif t_end - t_start <= 0.005:
        return None
    else:
        read = timeline_window_samples(project, track_id, t_start, t_end, defaults=defaults)
        if read is None or read[0].size == 0:
            return None
        filtered = band_filter(read[0], read[1], SPEECH_BAND)
        rms = rms_db(filtered, floor_db=floor_db)
    return _effective_rms_db(rms, _recorded_gain_db(project, track_id) if recorded_gain else 0.0)


def timeline_frame_levels_db(
    project: EpisodeProject,
    track_id: str,
    t_start: float,
    t_end: float,
    *,
    frame_sec: float,
    hop_sec: float,
    caches: TrackRmsCacheSet | None = None,
    defaults: EffectiveConfig,
) -> np.ndarray | None:
    """Recorded level (dB) of each ``frame_sec`` frame every ``hop_sec`` from ``t_start``.

    Only frames wholly inside timeline ``[t_start, t_end)`` count. ``None`` when the
    track cannot be read there or no frame fits.
    """
    read = timeline_window_samples(
        project, track_id, t_start, t_end, caches=caches, defaults=defaults
    )
    if read is None:
        return None
    samples, rate = read
    levels = frame_rms_db(samples, max(1, round(rate * frame_sec)), max(1, round(rate * hop_sec)))
    if levels.size == 0:
        return None
    return levels + _recorded_gain_db(project, track_id)


def measure_timeline_rms_db(
    project: EpisodeProject,
    track_id: str,
    t_start: float,
    t_end: float,
    *,
    caches: TrackRmsCacheSet | None = None,
    floor_db: float = DIGITAL_SILENCE_DB,
    defaults: EffectiveConfig,
) -> float | None:
    """Public RMS (dB) for a timeline window on one dialogue track.

    A digitally silent window reads ``floor_db``. A caller that compares the level with a
    track's own floor passes ``DIGITAL_SILENCE_DB``: the default sits above the voice floor
    of a recording quiet enough to put its speech near -80 dBFS.
    """
    return _rms_for_track_at_timeline(
        project, track_id, t_start, t_end, caches=caches, floor_db=floor_db, defaults=defaults
    )


def _classify_word_audibility(
    own_track_id: str,
    own_rms: float | None,
    track_rms: dict[str, float],
    *,
    policy: AnalysisPolicy,
    bleed_sources: Collection[str],
    voice_floors: dict[str, float],
    own_speech_level: float | None = None,
    inaudibility_floors: dict[str, float] | None = None,
) -> tuple[str, str | None]:
    """The acoustic verdict for one word window.

    A word is ``inaudible`` under its own track's voice floor and a mic is a bleed source
    only while it sounds above its own (``voice_floors``, effective dBFS per track; a
    track with no floor never judges a word inaudible).

    ``bleed`` needs a louder mic *and* a measured bleed path from that mic to this one
    (``bleed_sources``): a word quieter than another mic on a pair with no path is two
    people talking, not a copy, and keeps its own audibility (#774). A source mic's
    level is read at its copy lag (#1052). The levels stay in the row's
    ``track_rms_db`` for review.

    Bleed dominance uses full-band levels and floors. The inaudible verdict alone can use
    ``own_speech_level`` and ``inaudibility_floors`` (speech-band) so low-band room
    noise does not mask whispered speech (#1377).
    """
    if own_rms is None:
        return "inaudible", None

    dominant_tid = max(track_rms, key=lambda tid: track_rms.get(tid, -math.inf))
    dominant_rms = track_rms.get(dominant_tid, -math.inf)

    if dominant_tid != own_track_id and dominant_tid in bleed_sources:
        own_val = track_rms.get(own_track_id, own_rms)
        if dominant_rms - own_val >= policy.bleed_dominance_db and dominant_rms >= voice_floors.get(
            dominant_tid, -math.inf
        ):
            return "bleed", dominant_tid

    if own_rms < voice_floors.get(own_track_id, -math.inf):
        if (
            own_speech_level is not None
            and inaudibility_floors is not None
            and own_speech_level >= inaudibility_floors.get(own_track_id, -math.inf)
        ):
            return "audible", None
        return "inaudible", None

    return "audible", None


def _voice_offsets(track_ids: Collection[str], caches: TrackRmsCacheSet) -> dict[str, float]:
    """Each decoded track's fixed offset (dB) onto the common voice scale, from its own profile.

    Raw levels cannot be compared across mics: a call recording can carry another speaker
    hotter than that speaker's own quiet mic, so their copy always outranks them. One static
    offset per track, its own voice level (``LevelProfile.path_reference_db``), puts every
    mic's own speaker at 0 dB. It is a constant of the recording, not a gain on the audio
    (no compression, no normalization), and it moves with the file's gain, so a verdict
    never depends on how loud the file was recorded (#1495).
    """
    return {
        tid: cache.profile.path_reference_db
        for tid in track_ids
        if (cache := caches.get(tid)) is not None
    }


def _voice_floors(
    track_ids: Collection[str], caches: TrackRmsCacheSet, offsets: dict[str, float]
) -> dict[str, float]:
    """Each decoded track's audibility floor, on the same voice scale as its word levels."""
    return {
        tid: cache.profile.audibility_floor_db - offsets.get(tid, 0.0)
        for tid in track_ids
        if (cache := caches.get(tid)) is not None
    }


def _speech_voice_offsets(track_ids: Collection[str], caches: TrackRmsCacheSet) -> dict[str, float]:
    """Speech-band path references for the inaudibility floor check (#1377)."""
    return {
        tid: cache.speech_profile.path_reference_db
        for tid in track_ids
        if (cache := caches.get(tid)) is not None
    }


def _inaudibility_floors(
    track_ids: Collection[str], caches: TrackRmsCacheSet, speech_offsets: dict[str, float]
) -> dict[str, float]:
    """Speech-band audibility floors on the speech voice scale."""
    return {
        tid: cache.speech_profile.audibility_floor_db - speech_offsets.get(tid, 0.0)
        for tid in track_ids
        if (cache := caches.get(tid)) is not None
    }


# Short words (about 40-100 ms) dilute in a span mean; read the loudest frame instead (#1594).
_SHORT_WORD_AUDIBILITY_MAX_SEC = 0.10
_SHORT_WORD_FRAME_SEC = 0.01
_MIN_WORD_RMS_DUR_SEC = 0.005


def _track_levels(
    project: EpisodeProject,
    track_ids: list[str],
    t_start: float,
    t_end: float,
    lags: dict[str, float],
    caches: TrackRmsCacheSet,
    offsets: dict[str, float],
    *,
    word_dur: float | None = None,
    defaults: EffectiveConfig,
) -> dict[str, float]:
    """Each track's level for a timeline window on the voice scale, a lagged source read later."""
    use_peak = (
        word_dur is not None and _MIN_WORD_RMS_DUR_SEC < word_dur <= _SHORT_WORD_AUDIBILITY_MAX_SEC
    )
    levels: dict[str, float] = {}
    for tid in track_ids:
        lag = lags.get(tid, 0.0)
        win_start, win_end = t_start + lag, t_end + lag
        if use_peak:
            frame_levels = timeline_frame_levels_db(
                project,
                tid,
                win_start,
                win_end,
                frame_sec=_SHORT_WORD_FRAME_SEC,
                hop_sec=_SHORT_WORD_FRAME_SEC,
                caches=caches,
                defaults=defaults,
            )
            if frame_levels is not None and frame_levels.size:
                levels[tid] = float(frame_levels.max()) - offsets.get(tid, 0.0)
                continue
        rms = _rms_for_track_at_timeline(
            project, tid, win_start, win_end, caches=caches, recorded_gain=False, defaults=defaults
        )
        if rms is not None:
            levels[tid] = rms - offsets.get(tid, 0.0)
    return levels


def compute_word_audibility_map(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
    caches: TrackRmsCacheSet | None = None,
    defaults: EffectiveConfig,
) -> list[dict[str, Any]]:
    """Per-word audibility across all dialogue tracks at each word's timeline window.

    The ``inaudible`` verdict alone compares speech-band level to a speech-band floor so
    low-band room noise does not mask whispered speech (#1377). Bleed dominance still
    uses full-band levels and floors.

    A ``bleed`` verdict needs a measured path from the louder mic into the word's own
    (``TrackRmsCacheSet.echo_pairs``), so it needs rendered stems for both mics.

    A path's source is read at its copy lag (``TrackRmsCacheSet.copy_path``): a remote
    participant's own track can trail their voice on an in-room mic, so at 0 lag their
    copy reads as the mic owner's word and an owner's word just after them reads as
    theirs (#1052). The lag can only take a word the 0-lag reading leaves with its owner
    when the word also carries the source's fine spectrum, at least the copy's
    likeness: during crosstalk a soft own word sits under a louder peer at the lag but
    sounds like its own speaker. Such a word keeps its 0-lag verdict, ``reason:
    unlike_copy``. ``copy_lag_ms`` reports the lags used.

    A track without a cache is read window by window from its clips, with the same
    samples a cache serves (#1560). Voice floors and mic paths come from the caches, so a
    set with no cache for a track cannot judge ``inaudible`` or ``bleed`` there.
    """
    pol = policy or AnalysisPolicy.from_defaults(defaults=defaults)
    if pol.transcript_mode == "off":
        return []

    caches = caches if caches is not None else build_track_rms_caches(project, defaults=defaults)
    st = SessionTimeline(project)
    out: list[dict[str, Any]] = []
    all_tracks = dialogue_track_ids(project)
    targets = [track_id] if track_id else all_tracks
    offsets = _voice_offsets(all_tracks, caches)
    floors = _voice_floors(all_tracks, caches, offsets)
    speech_offsets = _speech_voice_offsets(all_tracks, caches)
    inaudibility_floors = _inaudibility_floors(all_tracks, caches, speech_offsets)

    lanes = lanes_transcripts(project, targets)
    total_words = sum(len(lane.transcript.words) for lane in lanes)

    # RMS windows shorter than this cannot be measured (see TrackRmsCache.rms_db).
    _min_rms_dur = _MIN_WORD_RMS_DUR_SEC

    with resolve_progress_task(
        "audibility",
        "Analyzing word audibility",
        total=total_words or None,
        prefer_parent=False,
        progress=progress,
    ) as task:
        done = 0

        def _tick() -> None:
            if done % 50 == 0 or done == total_words:
                task.advance_to(done, total=total_words)

        for lane in lanes:
            tid, tr = lane.track_id, lane.transcript
            paths = caches.leak_paths(tid)
            steady_lags = {src: path.lag_sec for src, path in paths.items() if path.lag_sec}
            segment_lags = {src: caches.lane_lag_steps(project, src) for src in steady_lags}
            for i, w in enumerate(tr.words):
                # Degenerate ASR timestamps (start==end) never produce an RMS window.
                # Isolated junk → inaudible/suppress. Sandwiched between normal-duration
                # neighbors → deferred so merge keeps glue words (e.g. "what").
                if w.end <= w.start + _min_rms_dur:
                    sandwiched = (
                        i > 0
                        and i < len(tr.words) - 1
                        and tr.words[i - 1].end > tr.words[i - 1].start + _min_rms_dur
                        and tr.words[i + 1].end > tr.words[i + 1].start + _min_rms_dur
                    )
                    out.append(
                        {
                            "track_id": tid,
                            "source_id": tr.source_id,
                            "word_index": i,
                            "text": w.text,
                            "start": w.start,
                            "end": w.end,
                            "own_rms_db": None,
                            "track_rms_db": {},
                            "audibility_status": "deferred" if sandwiched else "inaudible",
                            "dominant_track": None,
                            "suppressed": w.suppressed,
                            "reason": (
                                "sandwiched_zero_duration_word"
                                if sandwiched
                                else "zero_duration_word"
                            ),
                        }
                    )
                    done += 1
                    _tick()
                    continue

                word_dur = w.end - w.start
                if word_duration_is_anomalous(word_dur, pol.max_word_audibility_sec):
                    # Full-span mean RMS on stretched ASR tokens is unreliable (speech +
                    # silence + peer talk). Do not suppress from that mean.
                    out.append(
                        {
                            "track_id": tid,
                            "source_id": tr.source_id,
                            "word_index": i,
                            "text": w.text,
                            "start": w.start,
                            "end": w.end,
                            "own_rms_db": None,
                            "track_rms_db": {},
                            "audibility_status": "deferred",
                            "dominant_track": None,
                            "suppressed": w.suppressed,
                            "reason": ANOMALOUS_WORD_DURATION_REASON,
                        }
                    )
                    done += 1
                    _tick()
                    continue

                tl_span = word_timeline_window(st, lane, w.start, w.end)
                if tl_span is None:
                    done += 1
                    _tick()
                    continue
                tl_start, tl_end = tl_span
                from podcast_mcp.engines.bleed_audibility_lag import copy_lag_at_timeline

                tl_mid = (tl_start + tl_end) / 2
                lags = {
                    src: copy_lag_at_timeline(
                        project,
                        caches,
                        src,
                        tid,
                        tl_mid,
                        lag_steps=segment_lags,
                    )
                    for src in steady_lags
                }
                track_rms = _track_levels(
                    project,
                    all_tracks,
                    tl_start,
                    tl_end,
                    lags,
                    caches,
                    offsets,
                    word_dur=word_dur,
                    defaults=defaults,
                )
                own_rms = track_rms.get(tid)
                own_speech: float | None = None
                if own_rms is not None and own_rms < floors.get(tid, -math.inf):
                    raw_speech = _speech_rms_for_track_at_timeline(
                        project,
                        tid,
                        tl_start,
                        tl_end,
                        caches=caches,
                        recorded_gain=False,
                        defaults=defaults,
                    )
                    if raw_speech is not None:
                        own_speech = raw_speech - speech_offsets.get(tid, 0.0)
                status, dominant = _classify_word_audibility(
                    tid,
                    own_rms,
                    track_rms,
                    policy=pol,
                    bleed_sources=paths,
                    voice_floors=floors,
                    own_speech_level=own_speech,
                    inaudibility_floors=inaudibility_floors,
                )
                unlike_copy = False
                if status == "bleed" and dominant in lags:
                    at_zero = _track_levels(
                        project,
                        all_tracks,
                        tl_start,
                        tl_end,
                        {},
                        caches,
                        offsets,
                        word_dur=word_dur,
                        defaults=defaults,
                    )
                    zero_speech: float | None = None
                    zero_own = at_zero.get(tid)
                    if zero_own is not None and zero_own < floors.get(tid, -math.inf):
                        raw_zero = _speech_rms_for_track_at_timeline(
                            project,
                            tid,
                            tl_start,
                            tl_end,
                            caches=caches,
                            recorded_gain=False,
                            defaults=defaults,
                        )
                        if raw_zero is not None:
                            zero_speech = raw_zero - speech_offsets.get(tid, 0.0)
                    zero = _classify_word_audibility(
                        tid,
                        at_zero.get(tid),
                        at_zero,
                        policy=pol,
                        bleed_sources=paths,
                        voice_floors=floors,
                        own_speech_level=zero_speech,
                        inaudibility_floors=inaudibility_floors,
                    )
                    unlike_copy = zero[0] != "bleed" and not paths[dominant].carries(
                        caches.copy_match(dominant, tid, tl_start, tl_end, lag_sec=lags[dominant])
                    )
                    if unlike_copy:
                        status, dominant = zero

                entry: dict[str, Any] = {
                    "track_id": tid,
                    "source_id": tr.source_id,
                    "word_index": i,
                    "text": w.text,
                    "start": w.start,
                    "end": w.end,
                    "own_rms_db": round(own_rms, 2) if own_rms is not None else None,
                    "track_rms_db": {k: round(v, 2) for k, v in track_rms.items()},
                    "audibility_status": status,
                    "dominant_track": dominant,
                    "suppressed": w.suppressed,
                }
                if steady_lags:
                    entry["copy_lag_ms"] = {k: round(v * 1000) for k, v in lags.items()}
                if status == "inaudible":
                    entry["reason"] = "below_audibility_threshold"
                elif status == "bleed":
                    entry["reason"] = "cross_track_bleed"
                elif unlike_copy:
                    entry["reason"] = "unlike_copy"
                out.append(entry)
                done += 1
                _tick()

    return out


def list_bleed_words(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    policy: AnalysisPolicy | None = None,
    defaults: EffectiveConfig,
) -> list[dict[str, Any]]:
    return [
        row
        for row in compute_word_audibility_map(
            project, track_id=track_id, policy=policy, defaults=defaults
        )
        if row["audibility_status"] == "bleed"
    ]


def list_flagged_words(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
    caches: TrackRmsCacheSet | None = None,
    defaults: EffectiveConfig,
) -> list[dict[str, Any]]:
    return [
        row
        for row in compute_word_audibility_map(
            project,
            track_id=track_id,
            policy=policy,
            progress=progress,
            caches=caches,
            defaults=defaults,
        )
        if row["audibility_status"] in _FLAGGED_STATUSES
    ]


def _track_has_gate(project: EpisodeProject, track_id: str) -> bool:
    track = project.track_by_id(track_id)
    if track is not None and track.transcript_gate:
        return True
    chain = next((c for c in project.processing_chains if c.track_id == track_id), None)
    if not chain:
        return False
    return any(e.effect == "agate" for e in chain.effects)


def list_low_audibility_words(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    progress: ProgressReporter | None = None,
    caches: TrackRmsCacheSet | None = None,
    defaults: EffectiveConfig,
) -> list[dict[str, Any]]:
    """Flag transcript words whose timeline windows are under their track's voice floor."""

    caches = caches if caches is not None else build_track_rms_caches(project, defaults=defaults)
    st = SessionTimeline(project)
    out: list[dict[str, Any]] = []
    tracks = [track_id] if track_id else dialogue_track_ids(project)
    lanes = lanes_transcripts(project, tracks)
    total_words = sum(len([w for w in lane.transcript.words if not w.suppressed]) for lane in lanes)

    with resolve_progress_task(
        "low-audibility",
        "Scanning low audibility",
        total=total_words or None,
        prefer_parent=False,
        progress=progress,
    ) as task:
        done = 0

        def _tick() -> None:
            if done % 50 == 0 or done == total_words:
                task.advance_to(done, total=total_words)

        for lane in lanes:
            tid, tr = lane.track_id, lane.transcript
            proc_cache = caches.get(tid)
            floor_db: float | None = (
                proc_cache.profile.audibility_floor_db if proc_cache is not None else None
            )
            for i, w in enumerate(tr.words):
                if w.suppressed:
                    continue
                word_dur = w.end - w.start
                tl_span = word_timeline_window(st, lane, w.start, w.end)
                rms: float | None
                if proc_cache is not None:
                    if tl_span is None:
                        done += 1
                        _tick()
                        continue
                    if (
                        _MIN_WORD_RMS_DUR_SEC < word_dur <= _SHORT_WORD_AUDIBILITY_MAX_SEC
                        and (
                            frame_levels := timeline_frame_levels_db(
                                project,
                                tid,
                                tl_span[0],
                                tl_span[1],
                                frame_sec=_SHORT_WORD_FRAME_SEC,
                                hop_sec=_SHORT_WORD_FRAME_SEC,
                                caches=caches,
                                defaults=defaults,
                            )
                        )
                        is not None
                        and frame_levels.size
                    ):
                        rms = float(frame_levels.max())
                    else:
                        rms = proc_cache.rms_db(tl_span[0], tl_span[1])
                else:
                    try:
                        path = track_audio_path(project, tid)
                        rms = measure_window_rms_db(path, w.start, w.end)
                        if floor_db is None:
                            floor_db = file_level_profile(
                                path, sample_rate=_RMS_SAMPLE_RATE
                            ).audibility_floor_db
                    except Exception:
                        done += 1
                        _tick()
                        continue
                done += 1
                _tick()
                if rms is None or floor_db is None or rms >= floor_db:
                    continue
                ctx_before = " ".join(
                    x.text for x in tr.words[max(0, i - 3) : i] if not x.suppressed
                )
                ctx_after = " ".join(
                    x.text for x in tr.words[i + 1 : min(len(tr.words), i + 4)] if not x.suppressed
                )
                out.append(
                    {
                        "track_id": tid,
                        "source_id": tr.source_id,
                        "word_index": i,
                        "text": w.text,
                        "start": w.start,
                        "end": w.end,
                        "rms_db": round(rms, 2),
                        "threshold_db": round(floor_db, 2),
                        "context_before": ctx_before,
                        "context_after": ctx_after,
                        "reason": "below_audibility_threshold",
                    }
                )

    return out


def analyze_gate_overreach(
    project: EpisodeProject,
    track_id: str,
    *,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
    caches: TrackRmsCacheSet | None = None,
    defaults: EffectiveConfig,
) -> dict[str, Any]:
    """Attribute transcript and noise-gate loss to separate audio comparisons."""
    pol = policy or AnalysisPolicy.from_defaults(defaults=defaults)
    track = project.track_by_id(track_id)
    if track is None or not track.transcript_gate:
        return _noise_gate_overreach(
            project, track_id, policy=pol, progress=progress, caches=caches, defaults=defaults
        )
    noise_project = project.model_copy(deep=True)
    noise_track = noise_project.track_by_id(track_id)
    assert noise_track is not None
    noise_track.transcript_gate = False
    if not _track_has_gate(noise_project, track_id):
        return _transcript_gate_overreach(
            project, track_id, pol, progress=progress, defaults=defaults
        )
    try:
        before = _pre_transcript_gate_cache(project, track_id, defaults=defaults)
    except (OSError, CalledProcessError, NoAudioDecodedError, ValueError):
        return {
            "track_id": track_id,
            "gate_present": True,
            "gate_type": "combined",
            "risk": "unknown",
            "issue_count": 0,
            "issues": [],
            "components": [],
            "advice": "Evidence before transcript gating is unavailable; neither gate is verified safe.",
        }
    transcript = _transcript_gate_overreach(
        project, track_id, pol, progress=progress, before=before, defaults=defaults
    )
    noise = _noise_gate_overreach(
        noise_project,
        track_id,
        policy=pol,
        progress=progress,
        caches=TrackRmsCacheSet(caches={track_id: before}),
        defaults=defaults,
    )
    noise["gate_type"] = "noise"
    components = [noise, transcript]
    issues = [
        dict(issue, gate_type=part["gate_type"]) for part in components for issue in part["issues"]
    ]
    rank = {"none": 0, "unknown": 1, "moderate": 2, "high": 3}
    return {
        "track_id": track_id,
        "gate_present": True,
        "gate_type": "combined",
        "risk": max((part["risk"] for part in components), key=lambda risk: rank[risk]),
        "issue_count": len(issues),
        "issues": issues[:30],
        "components": components,
        "advice": "Review each gate separately; noise-gate tuning only uses the noise component.",
    }


def _noise_gate_overreach(
    project: EpisodeProject,
    track_id: str,
    *,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
    caches: TrackRmsCacheSet | None = None,
    defaults: EffectiveConfig,
) -> dict[str, Any]:
    """Detect likely gate clipping on syllable onsets/offsets."""
    pol = policy or AnalysisPolicy.from_defaults(defaults=defaults)
    if not _track_has_gate(project, track_id):
        return {
            "track_id": track_id,
            "gate_present": False,
            "risk": "none",
            "issues": [],
            "advice": "No noise gate on this track.",
        }

    tr = project.transcript_for_track(track_id)
    if not tr or not tr.words:
        return {
            "track_id": track_id,
            "gate_present": True,
            "risk": "unknown",
            "issues": [],
            "advice": "No transcript words to analyze gate behavior.",
        }

    issues: list[dict[str, Any]] = []
    st = SessionTimeline(project)
    proc = _processed_track_path(project, track_id)
    proc_cache = None
    if proc is not None:
        proc_cache = caches.get(track_id) if caches is not None else None
        if proc_cache is None:
            proc_cache = TrackRmsCache.from_timeline_stem(proc)

    raw_path: Path | None
    try:
        raw_path = track_audio_path(project, track_id)
    except Exception:
        raw_path = None
    raw_cache: TrackRmsCache | None = None
    if raw_path is not None:
        with contextlib.suppress(Exception):
            raw_cache = TrackRmsCache.from_timeline_stem(raw_path)

    candidates = [
        (i, w) for i, w in enumerate(tr.words) if not w.suppressed and w.end - w.start >= 0.08
    ]

    with resolve_progress_task(
        "gate-overreach",
        f"Analyzing gate on {track_id}",
        total=len(candidates) or None,
        prefer_parent=False,
        progress=progress,
    ) as task:
        for n, (i, w) in enumerate(candidates, start=1):
            src_start, src_end = w.start, w.end
            tl_span = _word_timeline_span(st, track_id, src_start, src_end)

            body_start = src_start + (src_end - src_start) * 0.35
            body_end = src_start + (src_end - src_start) * 0.65
            onset_end = min(src_start + 0.03, body_start)

            if raw_path is not None:
                body_db = measure_window_rms_db(raw_path, body_start, body_end, cache=raw_cache)
                onset_db = measure_window_rms_db(raw_path, src_start, onset_end, cache=raw_cache)
            else:
                body_db = onset_db = None
            if body_db is None or onset_db is None:
                if n % 50 == 0 or n == len(candidates):
                    task.advance_to(n, total=len(candidates))
                continue

            if body_db - onset_db >= pol.gate_onset_drop_db:
                issues.append(
                    {
                        "word_index": i,
                        "text": w.text,
                        "start": w.start,
                        "end": w.end,
                        "kind": "clipped_onset",
                        "body_rms_db": round(body_db, 2),
                        "onset_rms_db": round(onset_db, 2),
                        "drop_db": round(body_db - onset_db, 2),
                    }
                )

            if proc_cache is not None and tl_span is not None:
                tl_start, tl_end = tl_span
                tl_onset = proc_cache.rms_db(tl_start, min(tl_start + 0.03, tl_end))
                tl_body = proc_cache.rms_db(
                    tl_start + (tl_end - tl_start) * 0.35,
                    tl_start + (tl_end - tl_start) * 0.65,
                )
                if (
                    tl_onset is not None
                    and tl_body is not None
                    and tl_body - tl_onset >= pol.gate_onset_drop_db + 3
                ):
                    issues.append(
                        {
                            "word_index": i,
                            "text": w.text,
                            "start": w.start,
                            "end": w.end,
                            "kind": "processed_onset_chop",
                            "body_rms_db": round(tl_body, 2),
                            "onset_rms_db": round(tl_onset, 2),
                        }
                    )

            if n % 50 == 0 or n == len(candidates):
                task.advance_to(n, total=len(candidates))

    risk = "none"
    if len(issues) >= 5:
        risk = "high"
    elif issues:
        risk = "moderate"

    advice = "Gate settings look acceptable for analyzed words."
    if risk == "high":
        advice = (
            "Lower gate threshold, increase hold (80-120 ms) and release (200-400 ms); "
            "audition with play --source processed:<track>."
        )
    elif risk == "moderate":
        advice = "Review flagged words; consider slightly longer hold/release."

    return {
        "track_id": track_id,
        "gate_present": True,
        "risk": risk,
        "issue_count": len(issues),
        "issues": issues[:30],
        "advice": advice,
    }


def _transcript_gate_overreach(
    project: EpisodeProject,
    track_id: str,
    policy: AnalysisPolicy,
    *,
    progress: ProgressReporter | None,
    before: TrackRmsCache | None = None,
    defaults: EffectiveConfig,
) -> dict[str, Any]:
    transcript = project.transcript_for_track(track_id)
    processed = _processed_track_path(project, track_id)
    result: dict[str, Any] = {
        "track_id": track_id,
        "gate_present": True,
        "gate_type": "transcript",
        "risk": "unknown",
        "issue_count": 0,
        "issues": [],
        "analyzed_words": 0,
        "advice": "Ungated and processed audio evidence is required to assess this transcript gate.",
    }
    if transcript is None or not transcript.words or processed is None:
        return result
    try:
        raw = (
            before
            if before is not None
            else _pre_transcript_gate_cache(project, track_id, defaults=defaults)
        )
        final = TrackRmsCache.from_timeline_stem(processed)
    except (OSError, CalledProcessError, NoAudioDecodedError, ValueError):
        return result
    timeline = SessionTimeline(project)
    issues: list[dict[str, Any]] = []
    words = [(index, word) for index, word in enumerate(transcript.words) if not word.suppressed]
    judged_db = raw.profile.voice_db - _GATE_JUDGED_UNDER_VOICE_DB
    lost_db = raw.profile.voice_db - _GATE_LOST_UNDER_VOICE_DB
    with resolve_progress_task(
        "gate-overreach",
        f"Comparing transcript gate on {track_id}",
        total=len(words) or None,
        prefer_parent=False,
        progress=progress,
    ) as task:
        for index, (word_index, word) in enumerate(words):
            span = _word_timeline_span(timeline, track_id, word.start, word.end)
            if span is None:
                continue
            start, end = span
            width = end - start
            body_start, body_end = (
                (start, end) if width < 0.08 else (start + width * 0.35, start + width * 0.65)
            )
            raw_body = raw.rms_db(body_start, body_end)
            final_body = final.rms_db(body_start, body_end)
            if raw_body is None or final_body is None or raw_body < judged_db:
                continue
            result["analyzed_words"] += 1
            if final_body <= lost_db and raw_body - final_body >= policy.gate_onset_drop_db:
                issues.append(
                    {
                        "word_index": word_index,
                        "text": word.text,
                        "start": word.start,
                        "end": word.end,
                        "kind": "processed_word_loss",
                        "raw_body_rms_db": round(raw_body, 2),
                        "processed_body_rms_db": round(final_body, 2),
                    }
                )
            body_gain = final_body - raw_body
            for kind, lo, hi in (
                ("processed_onset_chop", max(0, start - 0.04), min(end, start + 0.03)),
                ("processed_offset_chop", max(start, end - 0.03), end + 0.04),
            ):
                raw_edge = raw.rms_db(lo, hi)
                final_edge = final.rms_db(lo, hi)
                if raw_edge is None or final_edge is None or raw_edge < judged_db:
                    continue
                loss = body_gain - (final_edge - raw_edge)
                if loss >= policy.gate_onset_drop_db:
                    issues.append(
                        {
                            "word_index": word_index,
                            "text": word.text,
                            "start": word.start,
                            "end": word.end,
                            "kind": kind,
                            "added_loss_db": round(loss, 2),
                            "raw_edge_rms_db": round(raw_edge, 2),
                            "processed_edge_rms_db": round(final_edge, 2),
                        }
                    )
            task.advance_to(index + 1, total=len(words))
    result.update(
        issue_count=len(issues),
        issues=issues[:30],
        risk="high"
        if len(issues) >= 5
        else "moderate"
        if issues
        else "none"
        if result["analyzed_words"]
        else "unknown",
        advice="Review added onset/tail loss against ungated audio; preserve speech before accepting this gate."
        if issues
        else "No added onset/tail loss found in the compared words."
        if result["analyzed_words"]
        else result["advice"],
    )
    return result


def fade_ms_for_level_jump(jump_db: float, policy: AnalysisPolicy | None = None) -> int:
    """Scale boundary fade length with measured level jump (same idea as cut fades)."""
    pol = policy or AnalysisPolicy()
    base = int(pol.recommended_fade_ms)
    if jump_db < float(pol.boundary_jump_db):
        return base
    # ~2 ms per dB of jump, floored at recommended_fade_ms, capped for dialogue.
    scaled = max(base, min(int(pol.harsh_fade_max_ms), int(jump_db * 2)))
    return scaled


def recommend_boundary_fades(
    project: EpisodeProject,
    *,
    policy: AnalysisPolicy | None = None,
    track_id: str | None = None,
    caches: TrackRmsCacheSet | None = None,
    defaults: EffectiveConfig,
) -> list[dict[str, Any]]:
    """Recommend clip fades where joins have large level jumps or no fades."""
    # Deferred: edits/clips_ops.py sits behind the edits package __init__, which
    # imports edits/cut_quality.py, which imports back from this module -- a
    # module-level import here would make that a real circular import depending
    # on which module a process happens to touch first. Deferring it until this
    # function actually runs sidesteps the cycle: by then audio_audit has already
    # finished initializing.
    from podcast_mcp.edits.clips_ops import clips_abut, clips_for_track

    pol = policy or AnalysisPolicy.from_defaults(defaults=defaults)
    recs: list[dict[str, Any]] = []
    tracks = [track_id] if track_id else dialogue_track_ids(project)

    for tid in tracks:
        clips = clips_for_track(project, tid)
        if len(clips) < 2:
            continue
        proc = _processed_track_path(project, tid)
        audio_path = proc
        use_timeline = proc is not None

        # One join-audio source per track (the processed stem, or else the raw
        # source file -- timeline_to_source only offsets the timestamp, never
        # changes path) -- decode it once instead of spawning an ffmpeg subprocess
        # per clip join below. Falls back to per-call reads if decoding fails.
        join_cache: TrackRmsCache | None = None
        if use_timeline and caches is not None:
            join_cache = caches.get(tid)
        if join_cache is None:
            with contextlib.suppress(Exception):
                join_cache = TrackRmsCache.from_timeline_stem(
                    audio_path if use_timeline and audio_path else track_audio_path(project, tid)
                )

        for i in range(len(clips) - 1):
            left, right = clips[i], clips[i + 1]
            if not clips_abut(left, right):
                gap = right.timeline_start - left.timeline_end
                recs.append(
                    {
                        "track_id": tid,
                        "clip_id": right.id,
                        "timeline_time": right.timeline_start,
                        "kind": "gap_between_clips",
                        "gap_sec": round(gap, 3),
                        "recommended_fade_in_ms": pol.recommended_fade_ms,
                        "recommended_fade_out_ms": pol.recommended_fade_ms,
                        "reason": "Timeline gap between clips; fade to silence or fill room tone.",
                    }
                )
                continue

            needs_fade = left.fade_out_ms < pol.min_fade_ms or right.fade_in_ms < pol.min_fade_ms
            pre: float | None = None
            post: float | None = None
            if use_timeline and audio_path:
                t_join = left.timeline_end
                pre = measure_window_rms_db(
                    audio_path, max(0.0, t_join - 0.05), t_join, cache=join_cache
                )
                post = measure_window_rms_db(
                    audio_path, t_join, min(t_join + 0.05, t_join + 0.1), cache=join_cache
                )
            else:
                track = project.track_by_id(tid)
                if track and track.media:
                    t_join = left.timeline_end
                    try:
                        raw_path, src_join = timeline_to_source(project, tid, t_join)
                    except Exception:
                        raw_path = None
                    if raw_path:
                        pre = measure_window_rms_db(
                            raw_path, max(0.0, src_join - 0.05), src_join, cache=join_cache
                        )
                        post = measure_window_rms_db(
                            raw_path, src_join, src_join + 0.05, cache=join_cache
                        )

            jump = 0.0
            if pre is not None and post is not None:
                jump = abs(post - pre)

            harsh = jump >= pol.boundary_jump_db

            if not needs_fade and not harsh:
                continue

            reason_parts = []
            if harsh:
                reason_parts.append(f"level jump ~{jump:.1f} dB at join")
            if needs_fade:
                reason_parts.append("missing boundary fades")
            fade_ms = fade_ms_for_level_jump(jump, pol) if harsh else int(pol.recommended_fade_ms)
            recs.append(
                {
                    "track_id": tid,
                    "clip_id": right.id,
                    "left_clip_id": left.id,
                    "timeline_time": left.timeline_end,
                    "kind": "harsh_join",
                    "level_jump_db": round(jump, 2) if harsh else None,
                    "recommended_fade_in_ms": fade_ms,
                    "recommended_fade_out_ms": fade_ms,
                    "current_fade_in_ms": right.fade_in_ms,
                    "current_fade_out_ms": left.fade_out_ms,
                    "reason": "; ".join(reason_parts),
                }
            )

    return recs


def analyze_cleanup(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
    cancel_check: Callable[[], bool] | None = None,
    defaults: EffectiveConfig,
) -> dict[str, Any]:
    """Full cleanup analysis report for one or all dialogue tracks.

    ``cancel_check`` is polled before each track; true raises ``CancelledProgress``.
    """

    pol = policy or AnalysisPolicy.from_defaults(defaults=defaults)
    tracks = [track_id] if track_id else dialogue_track_ids(project)
    caches = build_track_rms_caches(project, defaults=defaults)
    per_track: list[dict[str, Any]] = []

    raise_if_cancel_requested(cancel_check, "Cleanup analysis cancelled")
    flagged_by_track: dict[str, list[dict[str, Any]]] = {}
    targets: dict[WordKey, dict[str, Any]] = {}
    if pol.transcript_mode != "off":
        # Whole project, not just `tracks`: a text-match loser's winner may sit on a
        # track outside this report's scope, and `word_targets` judges every pair
        # regardless of scope (#805, #806). Computed once and reused below instead of
        # a second per-track acoustic pass.
        audibility_map = compute_word_audibility_map(
            project, policy=pol, progress=None, caches=caches, defaults=defaults
        )
        for row in audibility_map:
            if row["audibility_status"] in _FLAGGED_STATUSES:
                flagged_by_track.setdefault(row["track_id"], []).append(row)

        from podcast_mcp.engines.transcript_reconcile import word_targets

        targets = word_targets(
            project, policy=pol, audibility_map=audibility_map, caches=caches, defaults=defaults
        )

    with resolve_progress_task(
        "analyze-cleanup",
        "Running cleanup analysis",
        total=len(tracks) or None,
        prefer_parent=True,
        progress=progress,
    ) as task:
        for tid in tracks:
            raise_if_cancel_requested(cancel_check, "Cleanup analysis cancelled")
            track = project.track_by_id(tid)
            if not track or track.role != TrackRole.DIALOGUE:
                task.advance(1, total=len(tracks), message=f"track {tid}")
                continue
            gate = analyze_gate_overreach(
                project, tid, policy=pol, progress=None, caches=caches, defaults=defaults
            )
            low_aud = list_low_audibility_words(
                project, track_id=tid, progress=None, caches=caches, defaults=defaults
            )
            flagged = flagged_by_track.get(tid, [])
            bleed = [f for f in flagged if f["audibility_status"] == "bleed"]
            lanes = lane_transcripts(project, tid)
            total_words = sum(len(lane.transcript.words) for lane in lanes)
            bleed_ratio = round(len(bleed) / total_words, 3) if total_words else None
            fades = recommend_boundary_fades(
                project, policy=pol, track_id=tid, caches=caches, defaults=defaults
            )
            chain = next((c for c in project.processing_chains if c.track_id == tid), None)
            effects = [e.effect for e in chain.effects] if chain else []

            proc_path = _processed_track_path(project, tid)
            health: dict[str, Any] | None = None
            if proc_path is not None:
                stats: dict[str, Any] = dict(measure_astats(proc_path))
                stats["hum"] = detect_mains_hum(proc_path)
                voice = file_level_profile(proc_path).voice_db
                stats["voice_db"] = round(voice, 2) if math.isfinite(voice) else None
                health = stats

            track_row: dict[str, Any] = {
                "track_id": tid,
                "effects": effects,
                "health": health,
                "gate_analysis": gate,
                "low_audibility_count": len(low_aud),
                "low_audibility_sample": low_aud[:10],
                "flagged_count": len(flagged),
                "bleed_count": len(bleed),
                "bleed_ratio": bleed_ratio,
                "flagged_sample": flagged[:10],
                "fade_recommendations": fades,
            }
            if bleed_ratio is not None and bleed_ratio >= pol.bleed_ratio_warn_threshold:
                track_row["high_bleed_warning"] = (
                    f"{bleed_ratio:.0%} of words are cross-track bleed - this looks like a "
                    "multi-mic bleed session, not isolated crosstalk. Transcript suppression "
                    "alone won't remove it from the audio; see podcast-mute-bleed to gate "
                    "stems, and check mic gain staging/placement for future recordings."
                )
            if pol.transcript_mode == "suggest" and lanes:
                recs = [
                    {"track_id": tid, "source_id": lane.transcript.source_id, "word_index": i}
                    for lane in lanes
                    for i, w in enumerate(lane.transcript.words)
                    if not (w.ignored or w.audibility_locked or w.suppressed)
                    and (target := targets.get(transcript_word_key(lane.transcript, i))) is not None
                    and target["audibility_status"] in _FLAGGED_STATUSES
                ]
                if recs:
                    track_row["suppression_recommendations"] = recs
            per_track.append(track_row)
            task.advance(1, total=len(tracks), message=f"track {tid}")

    from podcast_mcp.engines.reconciliation_state import reconciliation_status

    result: dict[str, Any] = {
        "tracks": per_track,
        "policy": {
            "bleed_dominance_db": pol.bleed_dominance_db,
            "bleed_ratio_warn_threshold": pol.bleed_ratio_warn_threshold,
            "ml_backend": pol.ml_backend,
            "transcript_mode": pol.transcript_mode,
            "reconcile_on_render": pol.reconcile_on_render,
        },
        "reconciliation": reconciliation_status(project, defaults=defaults),
        "summary": _summarize_report(per_track),
    }
    return result


def _summarize_report(per_track: list[dict[str, Any]]) -> str:
    if not per_track:
        return "No dialogue tracks to analyze."
    parts: list[str] = []
    for row in per_track:
        tid = row["track_id"]
        gate = row["gate_analysis"]
        if gate.get("risk") in ("moderate", "high"):
            parts.append(f"{tid}: gate risk {gate['risk']}")
        if row["low_audibility_count"]:
            parts.append(f"{tid}: {row['low_audibility_count']} low-audibility words")
        if row.get("flagged_count"):
            parts.append(f"{tid}: {row['flagged_count']} flagged words")
        if row.get("bleed_count"):
            parts.append(f"{tid}: {row['bleed_count']} bleed words")
        if row.get("high_bleed_warning"):
            parts.append(f"{tid}: HIGH BLEED ({row['bleed_ratio']:.0%} of words)")
        if row["fade_recommendations"]:
            parts.append(f"{tid}: {len(row['fade_recommendations'])} boundary fade suggestions")
    return "; ".join(parts) if parts else "No significant cleanup issues detected."
