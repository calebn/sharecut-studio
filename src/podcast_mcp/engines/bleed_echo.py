"""Same-room bleed between dialogue mics, heard as a doubled voice in the mix.

Two people in one room each reach the other's mic a few milliseconds late and
some decibels down. Per-word bleed classification (``audio_audit``) says which
*words* are on the wrong mic; this module measures the *acoustic path*: in frames
where speaker A dominates and mic B is open but quieter, is B's audio a delayed
copy of A, at one consistent lag, and far more often than chance? It runs on fresh
timeline stems (the audio the listener hears, on one clock for every track) over a
bounded span around the audition window, and the result is cached in-process by
stem revision.

Design measured on the lab tape (#775): one correlation function summed over all
co-open frames did not separate the same-room pair from a remote one, because
Zoom's suppression makes bleed intermittent and each speaker's own speech
dominates the sum. Per-frame correlation peaks with lag clustering did, but chance
peaks between independent voices also cluster near 0 ms (full overlap gives the
normalised correlation its largest variance at small lags), which is where a
same-room path sits. So every pair is scored against its own null: the same
statistic on the same two mics with one of them shifted by several seconds, where
independence holds by construction. A pair is a risk only when its rate of
lag-consistent copy frames beats the largest null rate by a margin: a stationary
periodic voice correlates with itself at any shift, but at lags spread over its
period multiples, so the one-lag cluster is what a real acoustic path adds.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import asdict, dataclass
from functools import lru_cache
from itertools import permutations
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp.engines.align import xcorr_lag_window
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.play_audit import stem_is_fresh
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.dsp import frame_rms_db
from podcast_mcp.util.project_state import FileRevision, file_revision
from podcast_mcp.util.tracks import dialogue_track_ids, existing_stem_path


@dataclass(frozen=True)
class EchoConfig:
    sample_rate: int = 8000
    frame_sec: float = 0.05
    max_lag_sec: float = 0.04
    # A frame counts when the source speaker is above this, the other mic is open
    # (above ``open_floor_db``: not gated or digital silence) and at least
    # ``dominance_db`` quieter, so what it carries is likely bleed, not its own voice.
    source_floor_db: float = -40.0
    open_floor_db: float = -60.0
    dominance_db: float = 6.0
    # Per-frame peak NCC at which the other mic holds a copy of the source.
    copy_ncc: float = 0.25
    lag_tolerance_ms: float = 1.5
    min_copy_frames: int = 20
    min_consistent_frames: int = 12
    # The null: the same pair with the bleed mic shifted by these many seconds (wrapped
    # inside the span), sampled on at most ``null_max_frames`` dominated frames each and
    # pooled into one rate.
    null_shifts_sec: tuple[float, ...] = (-31.7, -23.3, -13.1, -7.3, 7.3, 13.1, 23.3, 31.7)
    null_max_frames: int = 400
    null_min_dominated: int = 10
    # The observed count of lag-consistent copies must be improbable under the pooled
    # null rate (one-sided binomial tail at most ``null_p_max``) and at least
    # ``null_margin`` times the null rate, so a long span cannot flag a small excess.
    null_p_max: float = 0.001
    null_margin: float = 1.5
    # Timeline seconds analysed, centred on the audition window.
    analysis_span_sec: float = 600.0
    max_examples: int = 3


@dataclass(frozen=True)
class EchoPairProfile:
    """How much of ``source_track_id``'s voice ``bleed_track_id`` carries, and at what lag."""

    source_track_id: str
    bleed_track_id: str
    span_start: float
    span_end: float
    dominated_frames: int
    copy_frames: int
    consistent_frames: int
    lag_ms: float | None
    level_db: float | None
    examples: tuple[float, ...]
    null_runs: int
    null_copy_rate: float | None
    null_consistent_rate: float | None

    @property
    def copy_rate(self) -> float:
        return self.copy_frames / self.dominated_frames if self.dominated_frames else 0.0

    @property
    def consistent_rate(self) -> float:
        return self.consistent_frames / self.dominated_frames if self.dominated_frames else 0.0

    @property
    def null_ratio(self) -> float | None:
        if not self.null_consistent_rate:
            return None
        return self.consistent_rate / self.null_consistent_rate

    @property
    def p_value(self) -> float | None:
        """One-sided binomial tail: consistent frames this many or more under the null rate."""
        if self.null_consistent_rate is None or not self.dominated_frames:
            return None
        return binomial_tail(
            self.consistent_frames, self.dominated_frames, self.null_consistent_rate
        )

    def echo_risk(self, config: EchoConfig) -> bool:
        p, ratio = self.p_value, self.null_ratio
        if p is None or ratio is None:
            return False
        return (
            self.copy_frames >= config.min_copy_frames
            and self.consistent_frames >= config.min_consistent_frames
            and p <= config.null_p_max
            and ratio >= config.null_margin
        )

    def to_dict(self, config: EchoConfig) -> dict[str, Any]:
        d = asdict(self)
        d["examples"] = [round(t, 2) for t in self.examples]
        d["span_start"] = round(self.span_start, 2)
        d["span_end"] = round(self.span_end, 2)
        d["copy_rate"] = round(self.copy_rate, 3)
        d["consistent_rate"] = round(self.consistent_rate, 3)
        d["null_ratio"] = None if self.null_ratio is None else round(self.null_ratio, 2)
        d["p_value"] = None if self.p_value is None else float(f"{self.p_value:.3g}")
        for key in ("lag_ms", "level_db", "null_copy_rate", "null_consistent_rate"):
            if d[key] is not None:
                d[key] = round(d[key], 3 if key.startswith("null") else 2)
        d["thresholds"] = {
            "copy_ncc": config.copy_ncc,
            "min_copy_frames": config.min_copy_frames,
            "min_consistent_frames": config.min_consistent_frames,
            "lag_tolerance_ms": config.lag_tolerance_ms,
            "null_p_max": config.null_p_max,
            "null_margin": config.null_margin,
        }
        return d


def binomial_tail(k: int, n: int, p: float) -> float:
    """P(X >= k) for X ~ Binomial(n, p), summed exactly in log space."""
    if k <= 0:
        return 1.0
    if k > n or p <= 0.0:
        return 0.0
    if p >= 1.0:
        return 1.0
    log_p, log_q = math.log(p), math.log1p(-p)
    total = 0.0
    for j in range(k, n + 1):
        log_term = (
            math.lgamma(n + 1)
            - math.lgamma(j + 1)
            - math.lgamma(n - j + 1)
            + j * log_p
            + (n - j) * log_q
        )
        total += math.exp(log_term)
    return min(1.0, total)


def _copy_rows(
    source: np.ndarray,
    bleed: np.ndarray,
    src_db: np.ndarray,
    bld_db: np.ndarray,
    *,
    sample_rate: int,
    frame: int,
    shift_frames: int,
    cfg: EchoConfig,
    limit: int | None,
) -> tuple[int, list[tuple[int, float, float]]]:
    """Dominated frame count and ``(frame, lag_ms, ncc)`` copy rows.

    ``shift_frames`` pairs source frame ``i`` with bleed frame ``i + shift`` (wrapped),
    so a non-zero shift measures two independent stretches of the same two mics.
    """
    n = min(src_db.size, bld_db.size)
    idx = np.arange(n)
    partner = (idx + shift_frames) % n if n else idx
    selected = idx[
        (src_db[:n] > cfg.source_floor_db)
        & (bld_db[partner] > cfg.open_floor_db)
        & (src_db[:n] - bld_db[partner] >= cfg.dominance_db)
    ]
    dominated = int(selected.size)
    if limit is not None and selected.size > limit:
        selected = selected[np.linspace(0, selected.size - 1, limit).astype(int)]
    max_lag = max(1, round(cfg.max_lag_sec * sample_rate))
    rows: list[tuple[int, float, float]] = []
    for i in selected:
        a = source[i * frame : (i + 1) * frame].astype(np.float64)
        b = bleed[partner[i] * frame : (partner[i] + 1) * frame].astype(np.float64)
        if a.size < frame or b.size < frame:
            continue
        a -= a.mean()
        b -= b.mean()
        norm = float(np.sqrt(np.dot(a, a) * np.dot(b, b)))
        if norm <= 0.0:
            continue
        corr, center = xcorr_lag_window(a, b, max_lag)
        k = int(np.argmax(corr))
        peak = float(corr[k]) / norm
        if peak >= cfg.copy_ncc:
            rows.append((int(i), (center - k) / sample_rate * 1000.0, peak))
    return dominated, rows


def _consistent(
    copies: list[tuple[int, float, float]], cfg: EchoConfig
) -> list[tuple[int, float, float]]:
    """Copies within ``lag_tolerance_ms`` of the most common half-millisecond lag bin."""
    if not copies:
        return []
    bins = Counter(round(lag * 2.0) / 2.0 for _, lag, _ in copies)
    mode = bins.most_common(1)[0][0]
    return [c for c in copies if abs(c[1] - mode) <= cfg.lag_tolerance_ms]


def _null_rates(
    source: np.ndarray,
    bleed: np.ndarray,
    src_db: np.ndarray,
    bld_db: np.ndarray,
    *,
    sample_rate: int,
    frame: int,
    cfg: EchoConfig,
) -> tuple[int, float | None, float | None]:
    """``(runs, pooled copy rate, pooled consistent rate)`` over the time-shifted null pairs.

    Rates are per measured dominated frame, pooled over every null run so the estimate
    rests on a few thousand frames and compares with the observed pair's rate over all
    of its frames. A run that saw no cluster still counts one frame, so no observed
    cluster reads as infinitely rare.
    """
    n = min(src_db.size, bld_db.size)
    runs = 0
    measured_total = 0
    copies_total = 0
    consistent_total = 0
    for shift_sec in cfg.null_shifts_sec:
        shift = round(shift_sec / cfg.frame_sec) % n if n else 0
        if shift == 0:
            continue
        dominated, rows = _copy_rows(
            source,
            bleed,
            src_db,
            bld_db,
            sample_rate=sample_rate,
            frame=frame,
            shift_frames=shift,
            cfg=cfg,
            limit=cfg.null_max_frames,
        )
        if dominated < cfg.null_min_dominated:
            continue
        runs += 1
        measured_total += min(dominated, cfg.null_max_frames)
        copies_total += len(rows)
        consistent_total += max(len(_consistent(rows, cfg)), 1)
    if not runs:
        return 0, None, None
    return runs, copies_total / measured_total, consistent_total / measured_total


def echo_pair_profile(
    source: np.ndarray,
    bleed: np.ndarray,
    *,
    sample_rate: int,
    t0: float,
    source_track_id: str,
    bleed_track_id: str,
    config: EchoConfig | None = None,
) -> EchoPairProfile:
    """Profile one direction of one mic pair from timeline-aligned samples starting at ``t0``."""
    cfg = config or EchoConfig()
    frame = max(1, round(cfg.frame_sec * sample_rate))
    n = min(source.size, bleed.size)
    src_db = frame_rms_db(source[:n], frame, frame)
    bld_db = frame_rms_db(bleed[:n], frame, frame)
    dominated, copies = _copy_rows(
        source,
        bleed,
        src_db,
        bld_db,
        sample_rate=sample_rate,
        frame=frame,
        shift_frames=0,
        cfg=cfg,
        limit=None,
    )
    null_runs, null_copy, null_consistent = _null_rates(
        source, bleed, src_db, bld_db, sample_rate=sample_rate, frame=frame, cfg=cfg
    )
    span_end = t0 + n / sample_rate
    if not copies:
        return EchoPairProfile(
            source_track_id,
            bleed_track_id,
            t0,
            span_end,
            dominated,
            0,
            0,
            None,
            None,
            (),
            null_runs,
            null_copy,
            null_consistent,
        )
    # The most common lag is the candidate acoustic path.
    consistent = _consistent(copies, cfg)
    lag_ms = float(np.median([c[1] for c in consistent]))
    level_db = float(np.median([bld_db[c[0]] - src_db[c[0]] for c in consistent]))
    strongest = sorted(consistent, key=lambda c: -c[2])[: cfg.max_examples]
    examples = tuple(t0 + c[0] * frame / sample_rate for c in strongest)
    return EchoPairProfile(
        source_track_id,
        bleed_track_id,
        t0,
        span_end,
        dominated,
        len(copies),
        len(consistent),
        lag_ms,
        level_db,
        examples,
        null_runs,
        null_copy,
        null_consistent,
    )


def _analysis_span(project: EpisodeProject, start_sec: float, end_sec: float, cfg: EchoConfig):
    st = SessionTimeline(project)
    extents = [st.timeline_extent(tid) for tid in dialogue_track_ids(project)]
    total = max((float(e[0]) for e in extents if e is not None), default=0.0)
    half = cfg.analysis_span_sec / 2.0
    mid = (start_sec + end_sec) / 2.0
    span_start = max(0.0, min(mid - half, total - cfg.analysis_span_sec))
    span_end = min(total, span_start + cfg.analysis_span_sec)
    return span_start, span_end


@lru_cache(maxsize=16)
def _cached_profiles(
    stems: tuple[tuple[str, str, FileRevision], ...],
    span_start: float,
    span_end: float,
    cfg: EchoConfig,
) -> tuple[EchoPairProfile, ...]:
    """Decode each fresh stem once for the span, then profile every directed pair.

    ``stems`` is ``(track_id, path, file_revision)`` per fresh stem: the revision is a
    cache key only, so a re-rendered stem is measured again.
    """
    eng = FFmpegEngine()
    frames = max(0, round((span_end - span_start) * cfg.sample_rate))
    audio: dict[str, np.ndarray] = {}
    for tid, path, _revision in stems:
        block = eng.decode_window_f32(
            Path(path),
            round(span_start * cfg.sample_rate),
            frames,
            cfg.sample_rate,
            1,
        )
        audio[tid] = block[:, 0] if block.ndim == 2 else block.reshape(-1)
    return tuple(
        echo_pair_profile(
            audio[a],
            audio[b],
            sample_rate=cfg.sample_rate,
            t0=span_start,
            source_track_id=a,
            bleed_track_id=b,
            config=cfg,
        )
        for a, b in permutations(audio, 2)
    )


def echo_profiles(
    project: EpisodeProject,
    *,
    start_sec: float,
    end_sec: float,
    config: EchoConfig | None = None,
) -> tuple[list[EchoPairProfile], list[str]]:
    """Directed bleed profiles for every pair of dialogue tracks with a fresh stem.

    Returns ``(profiles, skipped_track_ids)``; a track whose stem is missing or stale
    is skipped (its pairs are not measured) because only fresh stems share the timeline
    clock the listener hears.
    """
    cfg = config or EchoConfig()
    fresh: list[tuple[str, str, FileRevision]] = []
    skipped: list[str] = []
    for tid in dialogue_track_ids(project):
        stem = existing_stem_path(project, tid)
        if stem is None or not stem_is_fresh(project, tid):
            skipped.append(tid)
            continue
        fresh.append((tid, str(stem), file_revision(stem)))
    if len(fresh) < 2:
        return [], skipped
    span_start, span_end = _analysis_span(project, start_sec, end_sec, cfg)
    if span_end <= span_start:
        return [], skipped
    return list(_cached_profiles(tuple(fresh), span_start, span_end, cfg)), skipped
