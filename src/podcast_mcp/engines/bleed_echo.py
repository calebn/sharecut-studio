"""Same-room bleed between dialogue mics, heard as a doubled voice in the mix.

Two people in one room each reach the other's mic a few milliseconds late and
some decibels down. Per-word bleed classification (``audio_audit``) says which
*words* are on the wrong mic; this module measures the *acoustic path*: in frames
where speaker A dominates and mic B is open but quieter, is B's audio a delayed
copy of A, and at one consistent lag? It runs on fresh timeline stems (the audio
the listener hears, on one clock for every track) over a bounded span around the
audition window, and the result is cached in-process by stem revision.

Design measured on the lab tape (#775): one correlation function summed over all
co-open frames did not separate the same-room pair from a remote one, because
Zoom's suppression makes bleed intermittent and each speaker's own speech
dominates the sum. Per-frame peaks with lag clustering did: the same-room pair
repeats one lag in a fifth of its correlated frames, remote pairs never repeat one
more than twice.
"""

from __future__ import annotations

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
    min_consistent_share: float = 0.12
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

    def echo_risk(self, config: EchoConfig) -> bool:
        return (
            self.copy_frames >= config.min_copy_frames
            and self.consistent_frames >= config.min_consistent_frames
            and self.consistent_frames >= config.min_consistent_share * self.copy_frames
        )

    def to_dict(self, config: EchoConfig) -> dict[str, Any]:
        d = asdict(self)
        d["examples"] = [round(t, 2) for t in self.examples]
        d["span_start"] = round(self.span_start, 2)
        d["span_end"] = round(self.span_end, 2)
        if self.lag_ms is not None:
            d["lag_ms"] = round(self.lag_ms, 2)
        if self.level_db is not None:
            d["level_db"] = round(self.level_db, 1)
        d["thresholds"] = {
            "copy_ncc": config.copy_ncc,
            "min_copy_frames": config.min_copy_frames,
            "min_consistent_frames": config.min_consistent_frames,
            "min_consistent_share": config.min_consistent_share,
            "lag_tolerance_ms": config.lag_tolerance_ms,
        }
        return d


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
    max_lag = max(1, round(cfg.max_lag_sec * sample_rate))
    n = min(source.size, bleed.size)
    src_db = frame_rms_db(source[:n], frame, frame)
    bld_db = frame_rms_db(bleed[:n], frame, frame)
    dominated = np.flatnonzero(
        (src_db > cfg.source_floor_db)
        & (bld_db > cfg.open_floor_db)
        & (src_db - bld_db >= cfg.dominance_db)
    )
    copies: list[tuple[int, float, float]] = []  # frame, lag_ms, ncc
    for i in dominated:
        s = int(i) * frame
        a = source[s : s + frame].astype(np.float64)
        b = bleed[s : s + frame].astype(np.float64)
        a -= a.mean()
        b -= b.mean()
        norm = float(np.sqrt(np.dot(a, a) * np.dot(b, b)))
        if norm <= 0.0:
            continue
        corr, center = xcorr_lag_window(a, b, max_lag)
        k = int(np.argmax(corr))
        peak = float(corr[k]) / norm
        if peak >= cfg.copy_ncc:
            copies.append((int(i), (center - k) / sample_rate * 1000.0, peak))
    if not copies:
        return EchoPairProfile(
            source_track_id,
            bleed_track_id,
            t0,
            t0 + n / sample_rate,
            int(dominated.size),
            0,
            0,
            None,
            None,
            (),
        )
    # Cluster lags in half-millisecond bins; the mode is the candidate acoustic path.
    bins = Counter(round(lag * 2.0) / 2.0 for _, lag, _ in copies)
    mode = bins.most_common(1)[0][0]
    consistent = [c for c in copies if abs(c[1] - mode) <= cfg.lag_tolerance_ms]
    lag_ms = float(np.median([c[1] for c in consistent]))
    level_db = float(np.median([bld_db[c[0]] - src_db[c[0]] for c in consistent]))
    strongest = sorted(consistent, key=lambda c: -c[2])[: cfg.max_examples]
    examples = tuple(t0 + c[0] * frame / sample_rate for c in strongest)
    return EchoPairProfile(
        source_track_id,
        bleed_track_id,
        t0,
        t0 + n / sample_rate,
        int(dominated.size),
        len(copies),
        len(consistent),
        lag_ms,
        level_db,
        examples,
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
