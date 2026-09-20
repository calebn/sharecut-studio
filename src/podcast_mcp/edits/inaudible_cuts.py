from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject, Track
from podcast_mcp.util.timebase import SourceSec, TimelineSec
from podcast_mcp.util.tracks import track_audio_path

CutMode = Literal["vocal_transcript_guided", "waveform_only"]


@dataclass(frozen=True)
class InaudibleCutConfig:
    enabled: bool = True
    search_window_ms: int = 40
    max_shift_ms: int = 80
    min_word_margin_ms: int = 5
    micro_fade_ms: int = 10
    weight_energy: float = 0.65
    weight_zero_cross: float = 0.2
    weight_continuity: float = 0.15
    # Short filler/NL cuts: extend end through a voiced blob that straddles the
    # word-timed boundary (ASR often ends "um" early while energy continues).
    short_cut_max_sec: float = 1.2
    trailing_energy_extend_ms: int = 350
    trailing_energy_hot_db: float = -36.0
    trailing_energy_quiet_db: float = -45.0
    trailing_energy_hop_ms: int = 10
    # After a cut ends at a word boundary, absorb quiet dead air up to the next
    # word so restarts/ripples do not leave a double-breath. Only runs when the
    # entire gap to the next word is within max_sec (skips long silences).
    absorb_trailing_silence: bool = True
    absorb_trailing_silence_retain_sec: float = 0.4
    absorb_trailing_silence_max_sec: float = 2.0
    absorb_trailing_silence_quiet_db: float = -45.0

    @classmethod
    def from_defaults(cls) -> InaudibleCutConfig:
        cfg = load_defaults().get("inaudible_cuts", {})
        w = cfg.get("weights", {})
        return cls(
            enabled=bool(cfg.get("enabled", True)),
            search_window_ms=int(cfg.get("search_window_ms", 40)),
            max_shift_ms=int(cfg.get("max_shift_ms", 80)),
            min_word_margin_ms=int(cfg.get("min_word_margin_ms", 5)),
            micro_fade_ms=int(cfg.get("micro_fade_ms", 10)),
            weight_energy=float(w.get("energy", 0.65)),
            weight_zero_cross=float(w.get("zero_cross", 0.2)),
            weight_continuity=float(w.get("continuity", 0.15)),
            short_cut_max_sec=float(cfg.get("short_cut_max_sec", 1.2)),
            trailing_energy_extend_ms=int(cfg.get("trailing_energy_extend_ms", 350)),
            trailing_energy_hot_db=float(cfg.get("trailing_energy_hot_db", -36.0)),
            trailing_energy_quiet_db=float(cfg.get("trailing_energy_quiet_db", -45.0)),
            trailing_energy_hop_ms=int(cfg.get("trailing_energy_hop_ms", 10)),
            absorb_trailing_silence=bool(cfg.get("absorb_trailing_silence", True)),
            absorb_trailing_silence_retain_sec=float(
                cfg.get("absorb_trailing_silence_retain_sec", 0.4)
            ),
            absorb_trailing_silence_max_sec=float(cfg.get("absorb_trailing_silence_max_sec", 2.0)),
            absorb_trailing_silence_quiet_db=float(
                cfg.get("absorb_trailing_silence_quiet_db", -45.0)
            ),
        )


@dataclass(frozen=True)
class OptimizedCutRange:
    start: float
    end: float
    mode: CutMode
    shifted_start_ms: float
    shifted_end_ms: float
    confidence: float
    details: dict[str, float | str]


def detect_track_cut_mode(track: Track) -> CutMode:
    return "vocal_transcript_guided" if track.role.value == "dialogue" else "waveform_only"


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _nearest_word_boundary(
    project: EpisodeProject, track_id: str, t: float, max_shift: float
) -> float:
    tr = project.transcript_for_track(track_id)
    if not tr or not tr.words:
        return t
    boundaries: list[float] = []
    for w in tr.words:
        if not w.suppressed:
            boundaries.append(w.start)
            boundaries.append(w.end)
    in_window = [b for b in boundaries if abs(b - t) <= max_shift]
    if not in_window:
        return t
    return min(in_window, key=lambda b: abs(b - t))


def _retained_word_boundaries(
    project: EpisodeProject,
    track_id: str,
    *,
    exclude_start: float | None = None,
    exclude_end: float | None = None,
) -> list[float]:
    tr = project.transcript_for_track(track_id)
    if not tr:
        return []
    bounds: list[float] = []
    for w in tr.words:
        if w.suppressed:
            continue
        if exclude_start is not None and exclude_end is not None:
            if w.end <= exclude_start + 1e-6 or w.start >= exclude_end - 1e-6:
                bounds.extend([w.start, w.end])
        else:
            bounds.extend([w.start, w.end])
    return bounds


def _distance_to_nearest_boundary(t: float, boundaries: list[float]) -> float:
    if not boundaries:
        return float("inf")
    return min(abs(t - b) for b in boundaries)


def _enforce_word_margin(
    t: float,
    orig_t: float,
    boundaries: list[float],
    margin_sec: float,
    max_shift: float,
) -> float:
    if margin_sec <= 0 or not boundaries:
        return t
    if _distance_to_nearest_boundary(t, boundaries) >= margin_sec:
        return t
    candidates = [b for b in boundaries if abs(b - orig_t) <= max_shift + 1e-9]
    safe = [b for b in candidates if _distance_to_nearest_boundary(b, boundaries) >= margin_sec]
    if safe:
        return min(safe, key=lambda b: abs(b - orig_t))
    return orig_t


def _zero_crossing_score(samples: np.ndarray, idx: int) -> float:
    if idx <= 0 or idx >= samples.size - 1:
        return abs(float(samples[idx]))
    prev_v = float(samples[idx - 1])
    cur_v = float(samples[idx])
    nxt_v = float(samples[idx + 1])
    crossed = (prev_v <= 0 <= cur_v) or (cur_v <= 0 <= nxt_v) or (prev_v * cur_v < 0)
    if crossed:
        return 0.0
    return min(abs(prev_v), abs(cur_v), abs(nxt_v))


def _score_samples(samples: np.ndarray, idx: int, config: InaudibleCutConfig) -> float:
    left = max(0, idx - 16)
    right = min(samples.size, idx + 16)
    local = samples[left:right] if right > left else samples
    local_rms = float(np.sqrt(np.mean(local**2))) if local.size else 1.0
    amp = abs(float(samples[idx]))
    zero_cross = _zero_crossing_score(samples, idx)
    continuity = abs(float(samples[min(samples.size - 1, idx + 1)] - samples[max(0, idx - 1)]))
    return (
        config.weight_energy * (amp + local_rms)
        + config.weight_zero_cross * zero_cross
        + config.weight_continuity * continuity
    )


def _snap_boundary_to_waveform(
    path: Path,
    center_time: float,
    *,
    config: InaudibleCutConfig,
    sample_rate: int = 16000,
    side_window_sec: float | None = None,
    audio_cache: TrackAudioCache | None = None,
) -> float:
    window = side_window_sec if side_window_sec is not None else config.search_window_ms / 1000.0
    start = max(0.0, center_time - window)
    duration = max(0.01, window * 2)
    if audio_cache is not None and audio_cache.waveform.sample_rate == sample_rate:
        samples = audio_cache.window(start, start + duration)
    else:
        samples = load_mono_window(
            path, start_sec=start, duration_sec=duration, sample_rate=sample_rate
        )
    if samples.size < 8:
        return center_time
    best = 0
    best_score = math.inf
    for i in range(samples.size):
        s = _score_samples(samples, i, config)
        if s < best_score:
            best = i
            best_score = s
    return start + (best / sample_rate)


def _rms_db_hops(
    samples: np.ndarray,
    sample_rate: int,
    *,
    hop_ms: int,
) -> list[tuple[float, float]]:
    """Return (offset_sec_from_window_start, rms_db) hops."""
    hop = max(1, int(sample_rate * hop_ms / 1000.0))
    out: list[tuple[float, float]] = []
    for i in range(0, max(0, samples.size - hop + 1), hop):
        seg = samples[i : i + hop]
        rms = float(np.sqrt(np.mean(seg.astype(np.float64) ** 2)) + 1e-12)
        out.append((i / sample_rate, 20.0 * math.log10(rms)))
    return out


def _next_word_start_at_or_after(project: EpisodeProject, track_id: str, t: float) -> float | None:
    """Start of the first transcript word with ``start >= t``."""
    tr = project.transcript_for_track(track_id)
    if not tr:
        return None
    for w in tr.words:
        if w.end <= w.start:
            continue
        if w.start >= t - 1e-9:
            return float(w.start)
    return None


def _quietest_hop_end(
    path: Path,
    cut_end: float,
    search_limit: float,
    *,
    config: InaudibleCutConfig,
    sample_rate: int,
    audio_cache: TrackAudioCache | None,
) -> tuple[float, float, float] | None:
    """Return (new_end, end_db, quietest_db) for hops in ``[cut_end, search_limit]``.

    Picks the absolute quietest hop; earliest wins only on near-ties (≤0.5 dB).
    """
    if search_limit <= cut_end + 0.005:
        return None
    look_start = max(0.0, cut_end - 0.02)
    look_dur = search_limit - look_start
    if look_dur < 0.02:
        return None
    try:
        if audio_cache is not None and audio_cache.waveform.sample_rate == sample_rate:
            samples = audio_cache.window(look_start, look_start + look_dur)
        else:
            samples = load_mono_window(
                path,
                start_sec=look_start,
                duration_sec=look_dur,
                sample_rate=sample_rate,
            )
    except Exception:
        return None
    if samples.size < 8:
        return None

    hops = _rms_db_hops(samples, sample_rate, hop_ms=config.trailing_energy_hop_ms)
    if not hops:
        return None

    end_rel = cut_end - look_start
    near_end = [db for t, db in hops if abs(t - end_rel) <= 0.015]
    after = [(t, db) for t, db in hops if t >= end_rel - 1e-9]
    if not after:
        return None
    end_db = max(near_end) if near_end else after[0][1]
    quietest_db = min(db for _, db in after)
    # Absolute quietest; earliest only among near-ties so we don't stop on a
    # shallow trough that sits 1-2 dB above a deeper quiet later in the window.
    plateau = [(t, db) for t, db in after if db <= quietest_db + 0.5]
    best_t = min(plateau, key=lambda x: x[0])[0]
    return look_start + best_t, end_db, quietest_db


def _extend_end_past_trailing_energy(
    path: Path,
    cut_start: float,
    cut_end: float,
    *,
    config: InaudibleCutConfig,
    sample_rate: int = 16000,
    audio_cache: TrackAudioCache | None = None,
    search_until: float | None = None,
) -> tuple[float, bool]:
    """Push cut_end to the quietest place before the next word (within max extend).

    Prefers the quietest RMS hop in ``[cut_end, min(next_word_start, cut_end+max)]``.
    If that window is still hot (overlapping next-word onset), may chew further
    within ``trailing_energy_extend_ms`` to clear the blob.

    Returns (new_end, extended).
    """
    max_extend = config.trailing_energy_extend_ms / 1000.0
    if max_extend <= 0 or (cut_end - cut_start) > config.short_cut_max_sec:
        return cut_end, False

    hard_cap = cut_end + max_extend
    search_limit = hard_cap
    if search_until is not None and search_until > cut_end:
        search_limit = min(hard_cap, search_until)

    picked = _quietest_hop_end(
        path,
        cut_end,
        search_limit,
        config=config,
        sample_rate=sample_rate,
        audio_cache=audio_cache,
    )
    if picked is None:
        return cut_end, False
    new_end, end_db, quietest_db = picked

    hot = config.trailing_energy_hot_db
    quiet = config.trailing_energy_quiet_db
    improve_db = 3.0
    # Still hot at the next-word boundary: allow chewing into the next token
    # within hard_cap so overlapping filler energy is cleared.
    if quietest_db >= hot and search_limit < hard_cap - 0.01:
        expanded = _quietest_hop_end(
            path,
            cut_end,
            hard_cap,
            config=config,
            sample_rate=sample_rate,
            audio_cache=audio_cache,
        )
        if expanded is not None:
            new_end, end_db, quietest_db = expanded

    needs = end_db >= hot or end_db > quiet or quietest_db < end_db - improve_db
    if not needs or quietest_db >= end_db - 0.5:
        return cut_end, False
    if new_end <= cut_end + 1e-4:
        return cut_end, False
    return min(new_end, hard_cap), True


def _region_is_quiet(
    path: Path,
    start: float,
    end: float,
    *,
    quiet_db: float,
    hop_ms: int,
    sample_rate: int,
    audio_cache: TrackAudioCache | None,
) -> bool:
    """True when every RMS hop in ``[start, end]`` is at or below ``quiet_db``."""
    if end <= start + 0.01:
        return True
    try:
        if audio_cache is not None and audio_cache.waveform.sample_rate == sample_rate:
            samples = audio_cache.window(start, end)
        else:
            samples = load_mono_window(
                path,
                start_sec=start,
                duration_sec=end - start,
                sample_rate=sample_rate,
            )
    except Exception:
        return False
    if samples.size < 8:
        return False
    hops = _rms_db_hops(samples, sample_rate, hop_ms=hop_ms)
    if not hops:
        return False
    return max(db for _, db in hops) <= quiet_db


def _absorb_trailing_silence(
    project: EpisodeProject,
    track_id: str,
    path: Path,
    cut_end: float,
    *,
    config: InaudibleCutConfig,
    sample_rate: int = 16000,
    audio_cache: TrackAudioCache | None = None,
) -> tuple[float, bool]:
    """Extend ``cut_end`` through quiet air before the next word, keeping a breath.

    Only absorbs when the next transcript word is within
    ``absorb_trailing_silence_max_sec`` so long silences / peer tracks with a
    distant next word are left alone (safe for multitrack ripple medians).
    """
    if not config.absorb_trailing_silence:
        return cut_end, False
    retain = max(0.05, float(config.absorb_trailing_silence_retain_sec))
    max_gap = max(retain + 0.05, float(config.absorb_trailing_silence_max_sec))
    next_start = _next_word_start_at_or_after(project, track_id, cut_end)
    if next_start is None:
        return cut_end, False
    gap = next_start - cut_end
    if gap <= retain + 0.02 or gap > max_gap:
        return cut_end, False
    target = next_start - retain
    if not _region_is_quiet(
        path,
        cut_end,
        next_start,
        quiet_db=config.absorb_trailing_silence_quiet_db,
        hop_ms=config.trailing_energy_hop_ms,
        sample_rate=sample_rate,
        audio_cache=audio_cache,
    ):
        return cut_end, False
    return target, True


def optimize_source_cut_range(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    config: InaudibleCutConfig | None = None,
    force_enabled: bool | None = None,
    audio_cache: TrackAudioCache | None = None,
) -> OptimizedCutRange:
    cfg = config or InaudibleCutConfig.from_defaults()
    enabled = cfg.enabled if force_enabled is None else force_enabled
    track = project.track_by_id(track_id)
    if not track:
        return OptimizedCutRange(
            start=start,
            end=end,
            mode="waveform_only",
            shifted_start_ms=0.0,
            shifted_end_ms=0.0,
            confidence=0.0,
            details={"strategy": "passthrough:no-track"},
        )
    mode = detect_track_cut_mode(track)
    if end <= start:
        raise ValueError("end must be after start")
    max_shift = cfg.max_shift_ms / 1000.0
    orig_start, orig_end = start, end
    trailing_extended = False
    silence_absorbed = False
    src: Path | None = None
    if enabled and mode == "vocal_transcript_guided":
        start = _nearest_word_boundary(project, track_id, start, max_shift)
        end = _nearest_word_boundary(project, track_id, end, max_shift)
    if enabled:
        try:
            src = track_audio_path(project, track_id)
            start = _snap_boundary_to_waveform(src, start, config=cfg, audio_cache=audio_cache)
            end = _snap_boundary_to_waveform(src, end, config=cfg, audio_cache=audio_cache)
        except Exception:
            src = None
    start = _clamp(start, max(0.0, orig_start - max_shift), orig_start + max_shift)
    end = _clamp(end, max(start + 0.001, orig_end - max_shift), orig_end + max_shift)
    if end <= start + 1e-4:
        end = max(orig_end, start + 0.01)
    margin_sec = cfg.min_word_margin_ms / 1000.0
    if enabled and mode == "vocal_transcript_guided" and margin_sec > 0:
        kept_bounds = _retained_word_boundaries(
            project, track_id, exclude_start=orig_start, exclude_end=orig_end
        )
        start = _enforce_word_margin(start, orig_start, kept_bounds, margin_sec, max_shift)
        end = _enforce_word_margin(end, orig_end, kept_bounds, margin_sec, max_shift)
        if end <= start + 1e-4:
            end = max(orig_end, start + 0.01)
    # After word-margin snap, short dialogue cuts may still end mid-filler energy
    # (ASR ends "um" early). Prefer the quietest point before the next word
    # (within trailing_energy_extend_ms); chew into the next token only when
    # that window is still hot.
    if enabled and mode == "vocal_transcript_guided" and src is not None:
        try:
            search_until = _next_word_start_at_or_after(project, track_id, end)
            end, trailing_extended = _extend_end_past_trailing_energy(
                src,
                start,
                end,
                config=cfg,
                audio_cache=audio_cache,
                search_until=search_until,
            )
        except Exception:
            trailing_extended = False
        if end <= start + 1e-4:
            end = max(orig_end, start + 0.01)
        try:
            end, silence_absorbed = _absorb_trailing_silence(
                project,
                track_id,
                src,
                end,
                config=cfg,
                audio_cache=audio_cache,
            )
        except Exception:
            silence_absorbed = False
        if end <= start + 1e-4:
            end = max(orig_end, start + 0.01)
    shifted_start_ms = (start - orig_start) * 1000.0
    shifted_end_ms = (end - orig_end) * 1000.0
    # Confidence: intentional extends should not tank score alone.
    shift_budget = cfg.max_shift_ms * 2 + (
        cfg.trailing_energy_extend_ms if trailing_extended else 0
    )
    if silence_absorbed:
        shift_budget += int(cfg.absorb_trailing_silence_max_sec * 1000)
    conf = max(0.0, 1.0 - (abs(shifted_start_ms) + abs(shifted_end_ms)) / max(1.0, shift_budget))
    strategy = "word+waveform" if mode == "vocal_transcript_guided" else "waveform"
    if trailing_extended:
        strategy = f"{strategy}+trailing_energy"
    if silence_absorbed:
        strategy = f"{strategy}+absorb_silence"
    return OptimizedCutRange(
        start=start,
        end=end,
        mode=mode,
        shifted_start_ms=shifted_start_ms,
        shifted_end_ms=shifted_end_ms,
        confidence=round(conf, 3),
        details={
            "strategy": strategy,
            "search_window_ms": float(cfg.search_window_ms),
            "max_shift_ms": float(cfg.max_shift_ms),
            "trailing_energy_extended": trailing_extended,
            "absorb_trailing_silence": silence_absorbed,
        },
    )


def _source_to_timeline(project: EpisodeProject, track_id: str, source_sec: float) -> float:
    return float(
        SessionTimeline(project).source_to_timeline_clamped(track_id, SourceSec(source_sec))
    )


def optimize_timeline_cut_range(
    project: EpisodeProject,
    track_id: str,
    timeline_start: float,
    timeline_end: float,
    *,
    config: InaudibleCutConfig | None = None,
    force_enabled: bool | None = None,
) -> OptimizedCutRange:
    if timeline_end <= timeline_start:
        raise ValueError("timeline_end must be after timeline_start")
    st = SessionTimeline(project)
    source_start = st.timeline_to_source(track_id, TimelineSec(timeline_start))
    source_end = st.timeline_to_source(track_id, TimelineSec(timeline_end))
    if source_start is None or source_end is None:
        track = project.track_by_id(track_id)
        return OptimizedCutRange(
            start=timeline_start,
            end=timeline_end,
            mode=detect_track_cut_mode(track) if track else "waveform_only",
            shifted_start_ms=0.0,
            shifted_end_ms=0.0,
            confidence=0.0,
            details={"strategy": "passthrough"},
        )
    optimized = optimize_source_cut_range(
        project,
        track_id,
        source_start,
        source_end,
        config=config,
        force_enabled=force_enabled,
    )
    return OptimizedCutRange(
        start=_source_to_timeline(project, track_id, optimized.start),
        end=_source_to_timeline(project, track_id, optimized.end),
        mode=optimized.mode,
        shifted_start_ms=(optimized.start - source_start) * 1000.0,
        shifted_end_ms=(optimized.end - source_end) * 1000.0,
        confidence=optimized.confidence,
        details=optimized.details,
    )


def recommend_micro_fades(config: InaudibleCutConfig | None = None) -> dict[str, int]:
    cfg = config or InaudibleCutConfig.from_defaults()
    fade = max(1, cfg.micro_fade_ms)
    return {"fade_in_ms": fade, "fade_out_ms": fade}
