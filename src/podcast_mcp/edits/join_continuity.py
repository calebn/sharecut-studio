"""Perceptual join-continuity scoring for dialogue splices (FOSS, fail-closed).

Literature grounding (not PEAQ/POLQA parity):

- Unit-selection TTS join cost: spectral / MFCC / LSF / MCA distance across a
  concat (Vepa & King) - see ``join_cost_spectral``.
- Forensic multi-detector fusion (click, spectral flux, noise floor, F0, MFCC,
  bicoherence proxy, late-energy / RIR proxy).

Fail-closed: when unsure, verdict drifts toward review/fail. Not a human-ear
guarantee - disclaimer on every report.
"""

from __future__ import annotations

import json
import logging
import tempfile
import wave
from collections.abc import Callable, Iterator, Sequence
from contextlib import ExitStack, contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.audio_cache import (
    WAVEFORM_SAMPLE_RATE,
    TrackAudioCache,
    build_track_audio_caches,
)
from podcast_mcp.edits.clips_ops import clips_for_track, splice_joins
from podcast_mcp.edits.join_cost_spectral import SpectralJoinDetector
from podcast_mcp.edits.join_detectors import DetectorHit, JoinDetector
from podcast_mcp.edits.join_speech import find_speech_crossings
from podcast_mcp.engines.align import read_open_wav_mono_window
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.binaries import resolve_ffmpeg, resolve_ffprobe
from podcast_mcp.util.dsp import autocorr_peak, clamp01, linear_rms, rms_db
from podcast_mcp.util.process import DEVNULL, run
from podcast_mcp.util.timebase import TimelineSec
from podcast_mcp.util.tracks import dialogue_track_ids, track_audio_path

Verdict = Literal["pass", "review", "fail"]

SplicePoints = tuple[float, float]
"""``(left_source_end, right_source_start)`` in source seconds: the audio the render
abuts at a join. Equal values describe one continuous point (a proposed or source-clock
join with no clip boundary)."""

_DEFAULT_SIDE_SEC = 0.045
# Edge placements a verdict must hold for; see _worst_placement.
_DEFAULT_EDGE_TOLERANCE_MS = 3.0
_CALIBRATE_N = 24
_CALIBRATE_MARGIN = 1.15
# Digital-silence level for splice-side measurements (matches 20*log10(1e-20)).
_SILENT_DB = -400.0
# Speech F0 search range for the f0_jump detector.
_F0_MIN_HZ = 70.0
_F0_MAX_HZ = 400.0
_DISCLAIMER = (
    "Fail-closed multi-detector join cost (TTS/forensic fusion). "
    "Not PEAQ/POLQA and not a human-ear guarantee - prefer leave-in when unsure."
)
_CLICK_BATCH_SIZE = 16
_LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class JoinContinuityConfig:
    side_sec: float = _DEFAULT_SIDE_SEC
    edge_tolerance_ms: float = _DEFAULT_EDGE_TOLERANCE_MS
    sample_rate: int = WAVEFORM_SAMPLE_RATE
    pass_below: float = 0.28
    review_below: float = 0.48
    calibrate: bool = True
    calibrate_n: int = _CALIBRATE_N
    calibrate_margin: float = _CALIBRATE_MARGIN
    force_review_multi_hot: bool = True
    enable_enf: bool = False
    neural: bool = True
    weight_click: float = 1.35
    weight_level: float = 0.85
    weight_spectral_flux: float = 1.1
    weight_mfcc: float = 1.25
    weight_lsf: float = 1.2
    weight_mca: float = 1.15
    weight_weighted_spectral: float = 1.3
    weight_noise_floor: float = 0.7
    weight_f0: float = 0.9
    weight_onset: float = 1.15
    weight_bicoherence: float = 0.6
    weight_late_energy: float = 0.55
    weight_nisqa: float = 1.4
    weight_wavlm: float = 1.4
    # Both splice sides below this RMS (dBFS) cannot be heard: room tone against
    # gated digital silence passes as "inaudible splice" instead of scoring a level jump.
    inaudible_floor_db: float = -60.0

    @classmethod
    def from_defaults(cls, defaults: dict[str, Any] | None = None) -> JoinContinuityConfig:
        cfg = (defaults or load_defaults()).get("join_continuity") or {}
        return cls(
            side_sec=float(cfg.get("side_sec", _DEFAULT_SIDE_SEC)),
            edge_tolerance_ms=float(cfg.get("edge_tolerance_ms", _DEFAULT_EDGE_TOLERANCE_MS)),
            sample_rate=int(cfg.get("sample_rate", WAVEFORM_SAMPLE_RATE)),
            pass_below=float(cfg.get("pass_below", 0.28)),
            review_below=float(cfg.get("review_below", 0.48)),
            calibrate=bool(cfg.get("calibrate", True)),
            calibrate_n=int(cfg.get("calibrate_n", _CALIBRATE_N)),
            calibrate_margin=float(cfg.get("calibrate_margin", _CALIBRATE_MARGIN)),
            force_review_multi_hot=bool(cfg.get("force_review_multi_hot", True)),
            enable_enf=bool(cfg.get("enable_enf", False)),
            neural=bool(cfg.get("neural", True)),
            weight_click=float(cfg.get("weight_click", 1.35)),
            weight_level=float(cfg.get("weight_level", 0.85)),
            weight_spectral_flux=float(cfg.get("weight_spectral_flux", 1.1)),
            weight_mfcc=float(cfg.get("weight_mfcc", 1.25)),
            weight_lsf=float(cfg.get("weight_lsf", 1.2)),
            weight_mca=float(cfg.get("weight_mca", 1.15)),
            weight_weighted_spectral=float(cfg.get("weight_weighted_spectral", 1.3)),
            weight_noise_floor=float(cfg.get("weight_noise_floor", 0.7)),
            weight_f0=float(cfg.get("weight_f0", 0.9)),
            weight_onset=float(cfg.get("weight_onset", 1.15)),
            weight_bicoherence=float(cfg.get("weight_bicoherence", 0.6)),
            weight_late_energy=float(cfg.get("weight_late_energy", 0.55)),
            weight_nisqa=float(cfg.get("weight_nisqa", 1.4)),
            weight_wavlm=float(cfg.get("weight_wavlm", 1.4)),
            inaudible_floor_db=float(cfg.get("inaudible_floor_db", -60.0)),
        )


@dataclass
class JoinContinuityReport:
    track_id: str
    mode: str
    join_sec: float
    timebase: str
    risk: float
    invisibility: float
    verdict: Verdict
    reasons: list[str]
    detectors: list[DetectorHit]
    calibrated: bool
    natural_p95: float | None
    side_sec: float
    disclaimer: str
    neural: dict[str, Any] | None = None
    ranker: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["detectors"] = [h.to_dict() for h in self.detectors]
        d["risk"] = round(self.risk, 4)
        d["invisibility"] = round(self.invisibility, 4)
        if self.natural_p95 is not None:
            d["natural_p95"] = round(self.natural_p95, 4)
        return d


_clamp01 = clamp01


def _rms(x: np.ndarray) -> float:
    if x.size == 0:  # pragma: no cover
        return 0.0
    return linear_rms(x, epsilon=1e-20)


def _hann(n: int) -> np.ndarray:
    if n <= 1:  # pragma: no cover
        return np.ones(max(n, 0), dtype=np.float64)
    return 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n) / (n - 1))


def _stft_mags(samples: np.ndarray, *, n_fft: int = 256, hop: int = 64) -> np.ndarray:
    if samples.size < n_fft:  # pragma: no cover
        return np.empty((0, n_fft // 2 + 1), dtype=np.float64)
    win = _hann(n_fft)
    frames = 1 + (samples.size - n_fft) // hop
    out = np.empty((frames, n_fft // 2 + 1), dtype=np.float64)
    for i in range(frames):
        s = i * hop
        frame = samples[s : s + n_fft].astype(np.float64) * win
        out[i] = np.abs(np.fft.rfft(frame))
    return out


def _estimate_f0(samples: np.ndarray, sr: int) -> float | None:
    if samples.size < sr * 0.02 or _rms(samples) < 1e-4:
        return None
    peak = autocorr_peak(samples, sr, fmin=_F0_MIN_HZ, fmax=_F0_MAX_HZ)
    if peak is None or peak[1] < 0.3:  # pragma: no cover
        return None
    return peak[0]


def _bicoherence_proxy(left: np.ndarray, right: np.ndarray, sr: int) -> float:
    """Band-limited magnitude correlation change (200 Hz-2 kHz) across splice."""
    n_fft = 256
    if left.size < n_fft or right.size < n_fft:
        return 0.3
    win = _hann(n_fft)
    la = np.abs(np.fft.rfft(left[-n_fft:].astype(np.float64) * win))
    ra = np.abs(np.fft.rfft(right[:n_fft].astype(np.float64) * win))
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    mask = (freqs >= 200.0) & (freqs <= 2000.0)
    if not np.any(mask):  # pragma: no cover
        return 0.3
    a, b = la[mask], ra[mask]
    a = a / (np.linalg.norm(a) + 1e-20)
    b = b / (np.linalg.norm(b) + 1e-20)
    corr = float(np.dot(a, b))
    return _clamp01(1.0 - corr)


def _late_energy_ratio(right: np.ndarray, sr: int) -> float:
    """RIR proxy: late energy 50-200 ms vs early peak after resume."""
    if right.size < int(0.05 * sr):
        return 0.0
    early_n = int(0.05 * sr)
    late0 = int(0.05 * sr)
    late1 = min(right.size, int(0.20 * sr))
    early = _rms(right[:early_n])
    late = _rms(right[late0:late1]) if late1 > late0 else 0.0
    if early < 1e-6:
        return _clamp01(late * 50.0)
    ratio = late / (early + 1e-20)
    # Natural speech decay vs mismatched bed - elevated late energy scores higher
    return _clamp01((ratio - 0.15) / 0.85)


def score_splice_samples(
    left: np.ndarray,
    right: np.ndarray,
    *,
    sample_rate: int,
    config: JoinContinuityConfig,
) -> tuple[float, list[DetectorHit]]:
    if left.size < 8 or right.size < 8:
        hit = DetectorHit(
            "insufficient_audio",
            1.0,
            2.0,
            {"left": int(left.size), "right": int(right.size)},
        )
        return 1.0, [hit]

    hits: list[DetectorHit] = []

    # Click on raw abutment (pre-fade) - micro-fades mask impulses.
    mid = left.size
    raw_join = np.concatenate([left.astype(np.float64), right.astype(np.float64)])
    w = min(32, mid, raw_join.size - mid)
    if w >= 4:
        region = raw_join[mid - w : mid + w]
        d2 = np.diff(np.diff(region))
        local = _rms(region) + 1e-8
        spike = float(np.max(np.abs(d2))) / local if d2.size else 0.0
        hits.append(
            DetectorHit(
                "click",
                _clamp01(spike / 12.0),
                config.weight_click,
                {"spike_over_rms": round(spike, 4)},
            )
        )

    pre_db = rms_db(left[-min(left.size, int(0.05 * sample_rate)) :], floor_db=_SILENT_DB)
    post_db = rms_db(right[: min(right.size, int(0.05 * sample_rate))], floor_db=_SILENT_DB)
    jump = abs(post_db - pre_db)
    hits.append(
        DetectorHit(
            "level_jump",
            _clamp01(jump / 12.0),
            config.weight_level,
            {"jump_db": round(jump, 3), "pre_db": round(pre_db, 2), "post_db": round(post_db, 2)},
        )
    )

    n_fft = 256
    pre_m = _stft_mags(left[-(n_fft * 2) :], n_fft=n_fft, hop=n_fft // 2)
    post_m = _stft_mags(right[: n_fft * 2], n_fft=n_fft, hop=n_fft // 2)
    if pre_m.size and post_m.size:
        a, b = pre_m[-1], post_m[0]
        flux = float(np.linalg.norm(b - a) / (np.linalg.norm(a) + np.linalg.norm(b) + 1e-9))
        hits.append(
            DetectorHit(
                "spectral_flux",
                _clamp01(flux * 1.8),
                config.weight_spectral_flux,
                {"flux": round(flux, 4)},
            )
        )
    else:  # pragma: no cover - short windows
        hits.append(
            DetectorHit("spectral_flux", 0.5, config.weight_spectral_flux, {"error": "short"})
        )

    spectral: JoinDetector = SpectralJoinDetector(
        left,
        right,
        sample_rate,
        {
            "mfcc_join_cost": config.weight_mfcc,
            "lsf_mahalanobis": config.weight_lsf,
            "mca_join_cost": config.weight_mca,
            "weighted_spectral_join": config.weight_weighted_spectral,
        },
    )
    hits.extend(spectral.detect())

    def floor_db(x: np.ndarray) -> float:
        hop = max(1, int(0.01 * sample_rate))
        vals = [_rms(x[i : i + hop]) for i in range(0, max(0, x.size - hop), hop)]
        if not vals:  # pragma: no cover
            return rms_db(x, floor_db=_SILENT_DB)
        return 20.0 * float(np.log10(float(np.percentile(vals, 10)) + 1e-20))

    nf = abs(floor_db(left) - floor_db(right))
    hits.append(
        DetectorHit(
            "noise_floor",
            _clamp01(nf / 10.0),
            config.weight_noise_floor,
            {"floor_delta_db": round(nf, 3)},
        )
    )

    f0_l = _estimate_f0(left, sample_rate)
    f0_r = _estimate_f0(right, sample_rate)
    if f0_l and f0_r:
        ratio = max(f0_l, f0_r) / (min(f0_l, f0_r) + 1e-9)
        hits.append(
            DetectorHit(
                "f0_jump",
                _clamp01((ratio - 1.0) / 0.5),
                config.weight_f0,
                {"f0_left": round(f0_l, 1), "f0_right": round(f0_r, 1), "ratio": round(ratio, 3)},
            )
        )
    else:
        hits.append(
            DetectorHit(
                "f0_jump",
                0.0,
                config.weight_f0 * 0.25,
                {"f0_left": f0_l, "f0_right": f0_r, "voiced": False},
            )
        )

    edge = right[: min(right.size, int(0.03 * sample_rate))]
    if edge.size >= 8:
        early_db = rms_db(edge[: max(1, edge.size // 3)], floor_db=_SILENT_DB)
        onset_score = _clamp01((early_db + 45.0) / 20.0) if early_db > -50 else 0.0
        hits.append(
            DetectorHit(
                "onset_collision",
                onset_score,
                config.weight_onset,
                {"early_db": round(early_db, 2)},
            )
        )
    else:  # pragma: no cover
        hits.append(DetectorHit("onset_collision", 0.5, config.weight_onset, {"error": "short"}))

    bic = _bicoherence_proxy(left, right, sample_rate)
    hits.append(
        DetectorHit(
            "bicoherence_proxy",
            bic,
            config.weight_bicoherence,
            {"score": round(bic, 4)},
        )
    )
    late = _late_energy_ratio(right, sample_rate)
    hits.append(
        DetectorHit(
            "late_energy_ratio",
            late,
            config.weight_late_energy,
            {"score": round(late, 4)},
        )
    )

    wsum = sum(h.weight for h in hits) or 1.0
    risk = sum(h.score * h.weight for h in hits) / wsum
    return float(risk), hits


def _inaudible_splice(
    left: np.ndarray, right: np.ndarray, cfg: JoinContinuityConfig
) -> DetectorHit | None:
    """The one hit for a splice whose two sides are both below ``inaudible_floor_db``."""
    left_db = rms_db(left, floor_db=_SILENT_DB)
    right_db = rms_db(right, floor_db=_SILENT_DB)
    if left_db >= cfg.inaudible_floor_db or right_db >= cfg.inaudible_floor_db:
        return None
    return DetectorHit(
        "inaudible_splice",
        0.0,
        1.0,
        {
            "left_db": round(max(left_db, -200.0), 1),
            "right_db": round(max(right_db, -200.0), 1),
            "floor_db": cfg.inaudible_floor_db,
        },
    )


def _verdict(
    risk: float, cfg: JoinContinuityConfig, hits: list[DetectorHit]
) -> tuple[Verdict, list[str], float]:
    reasons: list[str] = []
    adj = risk
    if cfg.force_review_multi_hot:
        hot = sum(1 for h in hits if h.score >= 0.65)
        if hot >= 2 and adj < cfg.review_below:
            reasons.append(f"multi_hot={hot} forcing >= review")
            # Force at least the review band (fail-closed elevation only).
            adj = max(adj, cfg.pass_below)
    if adj < cfg.pass_below:
        return "pass", reasons, adj
    if adj < cfg.review_below:
        reasons.append(f"risk {adj:.2f} in review band [{cfg.pass_below}, {cfg.review_below})")
        return "review", reasons, adj
    reasons.append(f"risk {adj:.2f} >= fail threshold {cfg.review_below}")
    return "fail", reasons, adj


def _apply_calibration(
    risk: float,
    reasons: list[str],
    samples: np.ndarray,
    cfg: JoinContinuityConfig,
    *,
    natural_p95: float | None = None,
    baseline_ready: bool = False,
) -> tuple[float, bool, float | None]:
    if not cfg.calibrate:
        return risk, False, None
    natural = (
        natural_p95 if baseline_ready else _natural_baseline_p95(samples, cfg.sample_rate, cfg)
    )
    if natural is None:
        return risk, False, None
    gate = natural * cfg.calibrate_margin
    if risk > gate and risk < cfg.review_below:
        reasons.append(
            f"above natural p95xmargin ({natural:.2f}x{cfg.calibrate_margin:.2f}={gate:.2f})"
        )
        risk = max(risk, cfg.review_below)
    return risk, True, natural


def _natural_baseline_p95(
    samples: np.ndarray,
    sr: int,
    config: JoinContinuityConfig,
) -> float | None:
    """p95 risk of ``calibrate_n`` natural (uncut) points, scored like a join.

    The points come from a fixed-seed generator, so the baseline and every verdict
    it calibrates are the same on every run over the same audio (#812).
    """
    side = max(8, int(config.side_sec * sr))
    need = side * 2 + 8
    if samples.size < need * 4:
        return None
    gen = np.random.default_rng(0)
    lo = side + 1
    hi = samples.size - side - 1
    if hi <= lo:  # pragma: no cover
        return None
    risks: list[float] = []
    for _ in range(config.calibrate_n):
        mid = int(gen.integers(lo, hi))
        risks.append(_worst_placement(samples, sr, mid, mid, config, inaudible=False).risk)
    if len(risks) < 5:  # pragma: no cover
        return None
    return float(np.percentile(risks, 95))


@dataclass(frozen=True)
class _Placement:
    """The detector result for one placement of a splice's two edges."""

    risk: float
    hits: list[DetectorHit]
    inaudible: bool
    left_shift: int
    right_shift: int

    def reasons(self, cfg: JoinContinuityConfig, sr: int) -> list[str]:
        out: list[str] = []
        if self.inaudible:
            out.append(f"inaudible splice: both sides below {cfg.inaudible_floor_db:.0f} dBFS")
        if self.left_shift or self.right_shift:
            out.append(
                f"worst edge placement {self.left_shift * 1000.0 / sr:+.0f}/"
                f"{self.right_shift * 1000.0 / sr:+.0f} ms within +-{cfg.edge_tolerance_ms:g} ms"
            )
        return out


def _edge_shifts(cfg: JoinContinuityConfig, sr: int) -> tuple[int, ...]:
    tol = round(cfg.edge_tolerance_ms * sr / 1000.0)
    return (0, -tol, tol) if tol > 0 else (0,)


def _sides(
    samples: np.ndarray, left_i: int, right_i: int, side: int
) -> tuple[np.ndarray, np.ndarray]:
    left_i, right_i = max(0, left_i), max(0, right_i)
    return samples[max(0, left_i - side) : left_i], samples[right_i : right_i + side]


def _worst_placement(
    samples: np.ndarray,
    sr: int,
    left_i: int,
    right_i: int,
    cfg: JoinContinuityConfig,
    *,
    inaudible: bool = True,
    fail_at: float | None = None,
) -> _Placement:
    """Score the splice at ``(left_i, right_i)`` and at every edge placement within
    ``cfg.edge_tolerance_ms``; the riskiest placement decides (fail-closed), which
    roughly halves the verdict flips a few-millisecond edge move causes (#822). Ties
    keep the placement as proposed, which is scored first.

    Inaudibility is decided at the proposed edges only: a splice both of whose sides
    sit below the floor there passes, whatever the detectors read 3 ms away (the floor
    is a hard threshold, so taking the worst placement across it would turn a clean
    quiet-air cut into a fail). With ``fail_at`` the scan stops at the first placement
    at or above it: the verdict is already fail, so the remaining placements cannot
    change it.
    """
    side = max(8, int(cfg.side_sec * sr))
    left, right = _sides(samples, left_i, right_i, side)
    quiet = _inaudible_splice(left, right, cfg) if inaudible else None
    if quiet is not None:
        return _Placement(0.0, [quiet], True, 0, 0)
    shifts = _edge_shifts(cfg, sr)
    worst: _Placement | None = None
    for dl in shifts:
        for dr in shifts:
            left, right = _sides(samples, left_i + dl, right_i + dr, side)
            risk, hits = score_splice_samples(left, right, sample_rate=sr, config=cfg)
            if worst is None or risk > worst.risk:
                worst = _Placement(risk, hits, False, dl, dr)
            if fail_at is not None and risk >= fail_at:
                return worst
    assert worst is not None
    return worst


def _resolve_source_samples(
    project: EpisodeProject,
    track_id: str,
    sr: int,
    audio_caches: dict[str, TrackAudioCache] | None = None,
) -> np.ndarray:
    caches = (
        audio_caches if audio_caches is not None else build_track_audio_caches(project, [track_id])
    )
    cache = caches.get(track_id)
    if cache is not None and cache.waveform.sample_rate == sr:
        return cache.waveform.samples
    path = track_audio_path(project, track_id)
    from podcast_mcp.engines.audio_audit import TrackRmsCache

    return TrackRmsCache.from_timeline_stem(path, sample_rate=sr).samples


def _splice_indices(points: SplicePoints, sr: int) -> tuple[int, int]:
    return int(max(0.0, points[0]) * sr), int(max(0.0, points[1]) * sr)


def _splice_points(
    project: EpisodeProject,
    track_id: str,
    join_sec: float,
    *,
    timebase: Literal["source", "timeline"],
    timeline: SessionTimeline | None = None,
) -> SplicePoints:
    """Source audio on each side of ``join_sec``.

    A timeline join that sits on a clip splice scores the two clip edges the render
    abuts (left clip ``source_end``, right clip ``source_start``); any other point
    scores the source on both sides of one instant.
    """
    if timebase == "source":
        return float(join_sec), float(join_sec)
    for prev, cur in splice_joins(clips_for_track(project, track_id)):
        if abs(float(cur.timeline_start) - float(join_sec)) <= 1e-3:
            return float(prev.source_end), float(cur.source_start)
    st = timeline or SessionTimeline(project)
    mapped = st.timeline_to_source(track_id, TimelineSec(join_sec))
    if mapped is None:
        raise ValueError(f"timeline join {join_sec} falls in a gap on track {track_id!r}")
    return float(mapped), float(mapped)


def _click_check_hires(
    project: EpisodeProject, track_id: str, points: SplicePoints, *, side_sec: float = 0.02
) -> float | None:
    path = track_audio_path(project, track_id)
    return _score_single_highrate_window(path, points, side_sec=side_sec)


_CLICK_RATE = 48000


def _splice_window(left: np.ndarray, right: np.ndarray, *, side_sec: float) -> np.ndarray:
    """The audio a render abuts: ``side_sec`` before the left edge, then after the right."""
    side = int(side_sec * _CLICK_RATE)
    return np.concatenate([np.asarray(left)[-side:], np.asarray(right)[:side]]).astype(np.float32)


def _score_single_highrate_window(
    path: Path, points: SplicePoints, *, side_sec: float
) -> float | None:
    from podcast_mcp.engines.align import load_mono_window

    try:
        left = load_mono_window(
            path,
            start_sec=max(0.0, points[0] - side_sec),
            duration_sec=side_sec,
            sample_rate=_CLICK_RATE,
        )
        right = load_mono_window(
            path, start_sec=max(0.0, points[1]), duration_sec=side_sec, sample_rate=_CLICK_RATE
        )
    except Exception:  # pragma: no cover - decode failures
        return None
    return _click_spike_from_window(_splice_window(left, right, side_sec=side_sec))


def _click_spike_from_window(win: np.ndarray) -> float | None:
    if win.size < 64:  # pragma: no cover
        return None
    d2 = np.diff(np.diff(win.astype(np.float64)))
    local = float(np.sqrt(np.mean(win.astype(np.float64) ** 2)) + 1e-8)
    return float(np.max(np.abs(d2))) / local


@contextmanager
def _highrate_click_scorer(
    path: Path, *, source_joins: Sequence[SplicePoints] = (), side_sec: float = 0.02
) -> Iterator[Callable[[SplicePoints], float | None]]:
    """Keep one bounded WAV reader or batch seeked windows for a join sweep."""
    with ExitStack() as stack:
        try:
            reader = stack.enter_context(wave.open(str(path), "rb"))
        except (OSError, wave.Error):
            reader = None
        if reader is not None:
            probe, _ = read_open_wav_mono_window(
                reader, start_sec=0.0, duration_sec=0.001, out_rate=48000
            )
            if probe.size:

                def score_wav(points: SplicePoints) -> float | None:
                    try:
                        left, _ = read_open_wav_mono_window(
                            reader,
                            start_sec=max(0.0, points[0] - side_sec),
                            duration_sec=side_sec,
                            out_rate=_CLICK_RATE,
                        )
                        right, _ = read_open_wav_mono_window(
                            reader,
                            start_sec=max(0.0, points[1]),
                            duration_sec=side_sec,
                            out_rate=_CLICK_RATE,
                        )
                    except (OSError, ValueError, wave.Error):
                        return None
                    return _click_spike_from_window(_splice_window(left, right, side_sec=side_sec))

                yield score_wav
                return

    # Unsupported containers use one seek per join side. Keep only a small batch
    # of short outputs at a time, never a decoded copy of the full recording.
    scores = _score_highrate_batches(path, source_joins, side_sec=side_sec)

    def score_seeked(points: SplicePoints) -> float | None:
        if points in scores:
            return scores[points]
        return _score_single_highrate_window(path, points, side_sec=side_sec)

    yield score_seeked


def _preferred_audio_stream(path: Path) -> int:
    """Match FFmpeg's default audio stream choice for a single input."""
    result = run(
        [
            resolve_ffprobe(),
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_entries",
            "stream=channels:stream_disposition=default",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        check=True,
    )
    streams = json.loads(result.stdout).get("streams", [])
    if not streams:
        raise ValueError(f"no audio stream in {path}")
    return max(
        range(len(streams)),
        key=lambda i: (
            int(streams[i].get("disposition", {}).get("default") or 0),
            int(streams[i].get("channels") or 0),
        ),
    )


def _score_highrate_batches(
    path: Path, source_joins: Sequence[SplicePoints], *, side_sec: float
) -> dict[SplicePoints, float | None]:
    """One ffmpeg run per batch of joins, two seeked side windows per join."""
    scores: dict[SplicePoints, float | None] = {}
    if not source_joins:
        return scores
    try:
        stream = _preferred_audio_stream(path)
    except Exception as exc:
        _LOG.debug("high-rate click stream probe failed for %s: %s", path, exc)
        return {
            join: _score_single_highrate_window(path, join, side_sec=side_sec)
            for join in source_joins
        }
    for offset in range(0, len(source_joins), _CLICK_BATCH_SIZE):
        batch = source_joins[offset : offset + _CLICK_BATCH_SIZE]
        try:
            with tempfile.TemporaryDirectory(prefix="join-click-") as temp:
                outputs = [
                    (Path(temp) / f"{i}_left.f32le", Path(temp) / f"{i}_right.f32le")
                    for i in range(len(batch))
                ]
                command = [resolve_ffmpeg(), "-v", "error", "-y"]
                for left_end, right_start in batch:
                    command.extend(["-ss", str(max(0.0, left_end - side_sec)), "-i", str(path)])
                    command.extend(["-ss", str(max(0.0, right_start)), "-i", str(path)])
                for i, (left_out, right_out) in enumerate(outputs):
                    for k, output in ((2 * i, left_out), (2 * i + 1, right_out)):
                        command.extend(
                            [
                                "-map",
                                f"{k}:a:{stream}",
                                "-t",
                                str(max(0.1, side_sec)),
                                "-ac",
                                "1",
                                "-ar",
                                str(_CLICK_RATE),
                                "-f",
                                "f32le",
                                str(output),
                            ]
                        )
                run(command, stderr=DEVNULL, check=True)
                for join, (left_out, right_out) in zip(batch, outputs, strict=True):
                    left = np.fromfile(left_out, dtype=np.float32)
                    right = np.fromfile(right_out, dtype=np.float32)
                    scores[join] = _click_spike_from_window(
                        _splice_window(left, right, side_sec=side_sec)
                    )
        except Exception as exc:
            _LOG.debug("high-rate click batch failed for %s at offset %d: %s", path, offset, exc)
            # One bad output must not hide reports from the remaining joins.
            for join in batch:
                scores[join] = _score_single_highrate_window(path, join, side_sec=side_sec)
    return scores


def _maybe_neural(
    project: EpisodeProject,
    track_id: str,
    src_join_sec: float,
    cfg: JoinContinuityConfig,
) -> tuple[list[DetectorHit], dict[str, Any]]:
    neural_out: dict[str, Any] = {"available": False, "nisqa": None, "wavlm": None}
    hits: list[DetectorHit] = []
    if not cfg.neural:
        return hits, neural_out
    try:
        from podcast_mcp.edits.join_neural import (
            NeuralJoinDetector,
            nisqa_discontinuity_delta,
            wavlm_continuity_z,
        )
    except ImportError:  # pragma: no cover
        return hits, neural_out

    nisqa = nisqa_discontinuity_delta(project, track_id, src_join_sec)
    wavlm = wavlm_continuity_z(project, track_id, src_join_sec)
    neural_out["available"] = nisqa is not None or wavlm is not None
    neural_out["nisqa"] = nisqa
    neural_out["wavlm"] = wavlm
    neural: JoinDetector = NeuralJoinDetector(
        nisqa,
        wavlm,
        {"nisqa_discontinuity": cfg.weight_nisqa, "wavlm_continuity": cfg.weight_wavlm},
    )
    hits.extend(neural.detect())
    return hits, neural_out


def _maybe_ranker(
    report: JoinContinuityReport, *, artifacts_dir: Path | None = None
) -> JoinContinuityReport:
    try:
        from pathlib import Path as _Path

        from podcast_mcp.edits.join_ranker import apply_ranker_to_report, default_ranker_path

        path = default_ranker_path(artifacts_dir) if artifacts_dir else None
        if path is None or not _Path(path).is_file():
            return report
        return apply_ranker_to_report(report, model_path=_Path(path))
    except Exception:  # pragma: no cover
        return report


def _finalize(
    *,
    track_id: str,
    mode: str,
    join_sec: float,
    timebase: str,
    risk: float,
    hits: list[DetectorHit],
    samples: np.ndarray,
    cfg: JoinContinuityConfig,
    extra_reasons: list[str] | None = None,
    neural: dict[str, Any] | None = None,
    artifacts_dir: Path | None = None,
    natural_p95: float | None = None,
    baseline_ready: bool = False,
) -> JoinContinuityReport:
    reasons: list[str] = list(extra_reasons or [])
    risk, calibrated, natural = _apply_calibration(
        risk, reasons, samples, cfg, natural_p95=natural_p95, baseline_ready=baseline_ready
    )
    verdict, vreasons, risk = _verdict(risk, cfg, hits)
    reasons.extend(vreasons)
    for h in hits:
        if h.score >= 0.65:
            reasons.append(f"{h.name}={h.score:.2f}")
    report = JoinContinuityReport(
        track_id=track_id,
        mode=mode,
        join_sec=float(join_sec),
        timebase=timebase,
        risk=risk,
        invisibility=_clamp01(1.0 - risk),
        verdict=verdict,
        reasons=reasons,
        detectors=hits,
        calibrated=calibrated,
        natural_p95=natural,
        side_sec=cfg.side_sec,
        disclaimer=_DISCLAIMER,
        neural=neural,
    )
    return _maybe_ranker(report, artifacts_dir=artifacts_dir)


def assess_existing_join(
    project: EpisodeProject,
    track_id: str,
    join_sec: float,
    *,
    timebase: Literal["source", "timeline"] = "timeline",
    config: JoinContinuityConfig | None = None,
    defaults: dict[str, Any] | None = None,
) -> JoinContinuityReport:
    return _assess_existing_join(
        project, track_id, join_sec, timebase=timebase, config=config, defaults=defaults
    )


def _assess_existing_join(
    project: EpisodeProject,
    track_id: str,
    join_sec: float,
    *,
    timebase: Literal["source", "timeline"],
    config: JoinContinuityConfig | None,
    defaults: dict[str, Any] | None,
    samples: np.ndarray | None = None,
    natural_p95: float | None = None,
    baseline_ready: bool = False,
    timeline: SessionTimeline | None = None,
    points: SplicePoints | None = None,
    click_score: Callable[[SplicePoints], float | None] | None = None,
) -> JoinContinuityReport:
    cfg = config or JoinContinuityConfig.from_defaults(defaults)
    if samples is None:
        samples = _resolve_source_samples(project, track_id, cfg.sample_rate)
    if points is None:
        points = _splice_points(project, track_id, join_sec, timebase=timebase, timeline=timeline)
    left_i, right_i = _splice_indices(points, cfg.sample_rate)
    worst = _worst_placement(samples, cfg.sample_rate, left_i, right_i, cfg)
    reasons = worst.reasons(cfg, cfg.sample_rate)
    risk, hits = worst.risk, worst.hits
    if worst.inaudible:
        return _finalize(
            track_id=track_id,
            mode="existing_join",
            join_sec=float(join_sec),
            timebase=timebase,
            risk=risk,
            hits=hits,
            samples=samples,
            cfg=cfg,
            extra_reasons=reasons,
            artifacts_dir=project.artifacts_dir(),
            natural_p95=natural_p95,
            baseline_ready=baseline_ready,
        )
    spike = (
        click_score(points)
        if click_score is not None
        else _click_check_hires(project, track_id, points)
    )
    if spike is not None and spike > 12.0:  # pragma: no branch
        hits.append(
            DetectorHit(
                "click_hires",
                _clamp01(spike / 24.0),
                cfg.weight_click,
                {"spike_over_rms": round(spike, 4)},
            )
        )
        wsum = sum(h.weight for h in hits) or 1.0
        risk = sum(h.score * h.weight for h in hits) / wsum
    neural_hits, neural_info = _maybe_neural(project, track_id, points[1], cfg)
    if neural_hits:
        hits.extend(neural_hits)
        wsum = sum(h.weight for h in hits) or 1.0
        risk = sum(h.score * h.weight for h in hits) / wsum
    return _finalize(
        track_id=track_id,
        mode="existing_join",
        join_sec=float(join_sec),
        timebase=timebase,
        risk=risk,
        hits=hits,
        samples=samples,
        cfg=cfg,
        extra_reasons=reasons,
        neural=neural_info,
        artifacts_dir=project.artifacts_dir(),
        natural_p95=natural_p95,
        baseline_ready=baseline_ready,
    )


def assess_proposed_cut(
    project: EpisodeProject,
    track_id: str,
    cut_start: float,
    cut_end: float,
    *,
    timebase: Literal["source", "timeline"] = "source",
    config: JoinContinuityConfig | None = None,
    defaults: dict[str, Any] | None = None,
    audio_caches: dict[str, TrackAudioCache] | None = None,
) -> JoinContinuityReport:
    cfg = config or JoinContinuityConfig.from_defaults(defaults)
    if cut_end <= cut_start:
        raise ValueError("cut_end must be > cut_start")
    samples = _resolve_source_samples(project, track_id, cfg.sample_rate, audio_caches=audio_caches)
    st = SessionTimeline(project)
    if timebase == "timeline":
        mapped0 = st.timeline_to_source(track_id, TimelineSec(cut_start))
        mapped1 = st.timeline_to_source(track_id, TimelineSec(cut_end))
        if mapped0 is None or mapped1 is None:
            raise ValueError(
                f"timeline cut {cut_start}->{cut_end} falls in a gap on track {track_id!r}"
            )
        src0, src1 = float(mapped0), float(mapped1)
    else:
        src0, src1 = float(cut_start), float(cut_end)
    i0, i1 = _splice_indices((src0, src1), cfg.sample_rate)
    # No hit is added after this point, so a placement at the fail line settles the
    # verdict; the existing-join path adds hits afterwards and keeps the full scan.
    worst = _worst_placement(samples, cfg.sample_rate, i0, i1, cfg, fail_at=cfg.review_below)
    return _finalize(
        track_id=track_id,
        mode="proposed_cut",
        join_sec=float(cut_start),
        timebase=timebase,
        risk=worst.risk,
        hits=worst.hits,
        samples=samples,
        cfg=cfg,
        extra_reasons=[
            f"cut {cut_start:.3f}->{cut_end:.3f} ({timebase})",
            *worst.reasons(cfg, cfg.sample_rate),
        ],
        artifacts_dir=project.artifacts_dir(),
    )


def assess_project_joins(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    config: JoinContinuityConfig | None = None,
    defaults: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cfg = config or JoinContinuityConfig.from_defaults(defaults)
    tids = [track_id] if track_id else dialogue_track_ids(project)
    reports: list[dict[str, Any]] = []
    worst: dict[str, Any] | None = None
    timeline = SessionTimeline(project)
    for tid in tids:
        joins = splice_joins(clips_for_track(project, tid))
        if not joins:
            continue
        samples = _resolve_source_samples(project, tid, cfg.sample_rate)
        natural_p95 = (
            _natural_baseline_p95(samples, cfg.sample_rate, cfg) if cfg.calibrate else None
        )
        source_joins: list[SplicePoints] = [
            (float(prev.source_end), float(cur.source_start)) for prev, cur in joins
        ]
        crossings = find_speech_crossings(
            project, tid, joins, samples=samples, sample_rate=cfg.sample_rate
        )
        with _highrate_click_scorer(
            track_audio_path(project, tid), source_joins=source_joins
        ) as click_score:
            for (_prev, cur), points in zip(joins, source_joins, strict=True):
                join_t = float(cur.timeline_start)
                rep = _assess_existing_join(
                    project,
                    tid,
                    join_t,
                    timebase="timeline",
                    config=cfg,
                    defaults=defaults,
                    samples=samples,
                    natural_p95=natural_p95,
                    baseline_ready=True,
                    timeline=timeline,
                    points=points,
                    click_score=click_score,
                )
                d = rep.to_dict()
                d["source_gap_sec"] = round(abs(points[1] - points[0]), 4)
                d["speech"] = [
                    c.to_dict() for c in crossings if abs(c.join_timeline_sec - join_t) <= 1e-6
                ]
                # Continuity detectors score the splice's texture; a cut through the
                # track's own voice is a defect whatever they say, so such a row never passes.
                if d["speech"] and d["verdict"] == "pass":
                    d["verdict"] = "review"
                    d["reasons"] = [
                        *d["reasons"],
                        "voiced speech cut through this join (see speech); never a pass",
                    ]
                reports.append(d)
                if worst is None or d["risk"] > worst["risk"]:
                    worst = d
    fails = [r for r in reports if r["verdict"] == "fail"]
    reviews = [r for r in reports if r["verdict"] == "review"]
    return {
        "join_count": len(reports),
        "fail_count": len(fails),
        "review_count": len(reviews),
        "pass_count": len(reports) - len(fails) - len(reviews),
        "speech_cross_count": sum(len(r["speech"]) for r in reports),
        "worst": worst,
        "joins": reports,
        "disclaimer": _DISCLAIMER,
    }
