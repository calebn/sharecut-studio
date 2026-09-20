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

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

import numpy as np

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.audio_cache import (
    WAVEFORM_SAMPLE_RATE,
    TrackAudioCache,
    build_track_audio_caches,
)
from podcast_mcp.edits.join_cost_spectral import score_spectral_join
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.timebase import TimelineSec
from podcast_mcp.util.tracks import dialogue_track_ids, track_audio_path

Verdict = Literal["pass", "review", "fail"]

_DEFAULT_SIDE_SEC = 0.045
_CALIBRATE_N = 24
_CALIBRATE_MARGIN = 1.15
_DISCLAIMER = (
    "Fail-closed multi-detector join cost (TTS/forensic fusion). "
    "Not PEAQ/POLQA and not a human-ear guarantee - prefer leave-in when unsure."
)


@dataclass(frozen=True)
class JoinContinuityConfig:
    side_sec: float = _DEFAULT_SIDE_SEC
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

    @classmethod
    def from_defaults(cls, defaults: dict[str, Any] | None = None) -> JoinContinuityConfig:
        cfg = (defaults or load_defaults()).get("join_continuity") or {}
        return cls(
            side_sec=float(cfg.get("side_sec", _DEFAULT_SIDE_SEC)),
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
        )


@dataclass
class DetectorHit:
    name: str
    score: float
    weight: float
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "score": round(self.score, 4),
            "weight": round(self.weight, 4),
            "detail": self.detail,
        }


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


def _clamp01(x: float) -> float:
    return float(max(0.0, min(1.0, x)))


def _rms(x: np.ndarray) -> float:
    if x.size == 0:  # pragma: no cover
        return 0.0
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)) + 1e-20))


def _rms_db(x: np.ndarray) -> float:
    return 20.0 * float(np.log10(_rms(x) + 1e-20))


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
    x = samples.astype(np.float64)
    x = x - np.mean(x)
    min_lag = int(sr / 400)
    max_lag = min(int(sr / 70), x.size // 2)
    if max_lag <= min_lag + 2:  # pragma: no cover
        return None
    corr = np.correlate(x, x, mode="full")
    mid = corr.size // 2
    seg = corr[mid + min_lag : mid + max_lag]
    if seg.size == 0:  # pragma: no cover
        return None
    lag = int(np.argmax(seg)) + min_lag
    peak = float(seg[lag - min_lag])
    if peak < 0.3 * float(corr[mid] + 1e-20):  # pragma: no cover
        return None
    return float(sr) / float(lag)


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

    pre_db = _rms_db(left[-min(left.size, int(0.05 * sample_rate)) :])
    post_db = _rms_db(right[: min(right.size, int(0.05 * sample_rate))])
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

    spec = score_spectral_join(left, right, sample_rate=sample_rate)
    hits.append(
        DetectorHit("mfcc_join_cost", spec.mfcc, config.weight_mfcc, {"score": round(spec.mfcc, 4)})
    )
    hits.append(
        DetectorHit("lsf_mahalanobis", spec.lsf, config.weight_lsf, {"score": round(spec.lsf, 4)})
    )
    hits.append(
        DetectorHit("mca_join_cost", spec.mca, config.weight_mca, {"score": round(spec.mca, 4)})
    )
    hits.append(
        DetectorHit(
            "weighted_spectral_join",
            spec.weighted,
            config.weight_weighted_spectral,
            {"score": round(spec.weighted, 4)},
        )
    )

    def floor_db(x: np.ndarray) -> float:
        hop = max(1, int(0.01 * sample_rate))
        vals = [_rms(x[i : i + hop]) for i in range(0, max(0, x.size - hop), hop)]
        if not vals:  # pragma: no cover
            return _rms_db(x)
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
        early_db = _rms_db(edge[: max(1, edge.size // 3)])
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
) -> tuple[float, bool, float | None]:
    if not cfg.calibrate:
        return risk, False, None
    natural = _natural_baseline_p95(samples, cfg.sample_rate, cfg)
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
    *,
    rng: np.random.Generator | None = None,
) -> float | None:
    side = max(8, int(config.side_sec * sr))
    need = side * 2 + 8
    if samples.size < need * 4:
        return None
    gen = rng or np.random.default_rng(0)
    lo = side + 1
    hi = samples.size - side - 1
    if hi <= lo:  # pragma: no cover
        return None
    risks: list[float] = []
    for _ in range(config.calibrate_n):
        mid = int(gen.integers(lo, hi))
        left = samples[mid - side : mid]
        right = samples[mid : mid + side]
        r, _ = score_splice_samples(left, right, sample_rate=sr, config=config)
        risks.append(r)
    if len(risks) < 5:  # pragma: no cover
        return None
    return float(np.percentile(risks, 95))


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


def _load_sides(
    samples: np.ndarray, sr: int, join_sample: int, side_sec: float
) -> tuple[np.ndarray, np.ndarray]:
    side = max(8, int(side_sec * sr))
    left = samples[max(0, join_sample - side) : join_sample]
    right = samples[join_sample : min(samples.size, join_sample + side)]
    return left, right


def _click_check_hires(
    project: EpisodeProject, track_id: str, src_join_sec: float, *, side_sec: float = 0.02
) -> float | None:
    from podcast_mcp.engines.align import load_mono_window

    path = track_audio_path(project, track_id)
    try:
        win = load_mono_window(
            path,
            start_sec=max(0.0, src_join_sec - side_sec),
            duration_sec=side_sec * 2,
            sample_rate=48000,
        )
    except Exception:  # pragma: no cover - decode failures
        return None
    if win.size < 64:  # pragma: no cover
        return None
    d2 = np.diff(np.diff(win.astype(np.float64)))
    local = float(np.sqrt(np.mean(win.astype(np.float64) ** 2)) + 1e-8)
    return float(np.max(np.abs(d2))) / local


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
    if nisqa is not None:
        delta = float(nisqa.get("discontinuity_delta", 0.0))
        hits.append(
            DetectorHit(
                "nisqa_discontinuity",
                _clamp01(delta / 1.0),
                cfg.weight_nisqa,
                nisqa,
            )
        )
    if wavlm is not None:
        z = float(wavlm.get("z", 0.0))
        hits.append(
            DetectorHit(
                "wavlm_continuity",
                _clamp01((z - 2.0) / 4.0),
                cfg.weight_wavlm,
                wavlm,
            )
        )
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
) -> JoinContinuityReport:
    reasons: list[str] = list(extra_reasons or [])
    risk, calibrated, natural = _apply_calibration(risk, reasons, samples, cfg)
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
    cfg = config or JoinContinuityConfig.from_defaults(defaults)
    samples = _resolve_source_samples(project, track_id, cfg.sample_rate)
    src_join = float(join_sec)
    if timebase == "timeline":
        st = SessionTimeline(project)
        mapped = st.timeline_to_source(track_id, TimelineSec(join_sec))
        if mapped is None:
            raise ValueError(f"timeline join {join_sec} falls in a gap on track {track_id!r}")
        src_join = float(mapped)
    join_i = int(max(0.0, src_join) * cfg.sample_rate)
    left, right = _load_sides(samples, cfg.sample_rate, join_i, cfg.side_sec)
    risk, hits = score_splice_samples(left, right, sample_rate=cfg.sample_rate, config=cfg)
    spike = _click_check_hires(project, track_id, float(src_join))
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
    neural_hits, neural_info = _maybe_neural(project, track_id, float(src_join), cfg)
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
        neural=neural_info,
        artifacts_dir=project.artifacts_dir(),
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
    side = max(8, int(cfg.side_sec * cfg.sample_rate))
    i0 = int(max(0.0, src0) * cfg.sample_rate)
    i1 = int(max(0.0, src1) * cfg.sample_rate)
    left = samples[max(0, i0 - side) : i0]
    right = samples[i1 : min(samples.size, i1 + side)]
    risk, hits = score_splice_samples(left, right, sample_rate=cfg.sample_rate, config=cfg)
    return _finalize(
        track_id=track_id,
        mode="proposed_cut",
        join_sec=float(cut_start),
        timebase=timebase,
        risk=risk,
        hits=hits,
        samples=samples,
        cfg=cfg,
        extra_reasons=[f"cut {cut_start:.3f}->{cut_end:.3f} ({timebase})"],
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
    for tid in tids:
        clips = sorted(
            (c for c in project.timeline.clips if c.track_id == tid),
            key=lambda c: c.timeline_start,
        )
        for i in range(1, len(clips)):
            prev, cur = clips[i - 1], clips[i]
            join_t = float(cur.timeline_start)
            gap = abs(float(cur.source_start) - float(prev.source_end))
            if gap < 1e-4:  # pragma: no cover - abutting clips skipped
                continue
            rep = assess_existing_join(
                project, tid, join_t, timebase="timeline", config=cfg, defaults=defaults
            )
            d = rep.to_dict()
            d["source_gap_sec"] = round(gap, 4)
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
        "worst": worst,
        "joins": reports,
        "disclaimer": _DISCLAIMER,
    }
