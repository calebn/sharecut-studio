from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.inaudible_cuts import (
    InaudibleCutConfig,
    _distance_to_nearest_boundary,
    _retained_word_boundaries,
    optimize_source_cut_range,
)
from podcast_mcp.engines.audio_audit import measure_window_rms_db
from podcast_mcp.util.tracks import track_audio_path


@dataclass(frozen=True)
class CutRisk:
    score: float
    reasons: list[str] = field(default_factory=list)

    @property
    def too_risky(self) -> bool:
        return self.score >= 1.0


def _heuristics(defaults: dict[str, Any] | None) -> dict[str, float | int]:
    cfg = defaults or load_defaults()
    h = cfg.get("analysis", {}).get("heuristics", {})
    return {
        "boundary_jump_db": float(h.get("boundary_jump_db", 12.0)),
        "min_fade_ms": int(h.get("min_fade_ms", 10)),
        "recommended_fade_ms": int(h.get("recommended_fade_ms", 20)),
        "audibility_rms_db": float(h.get("audibility_rms_db", -42.0)),
    }


def _tighten_cfg(defaults: dict[str, Any] | None) -> dict[str, Any]:
    cfg = defaults or load_defaults()
    return cfg.get("tighten", {})


def word_margin_violation_sec(
    project,
    track_id: str,
    start: float,
    end: float,
    *,
    config: InaudibleCutConfig | None = None,
) -> float:
    cfg = config or InaudibleCutConfig.from_defaults()
    margin = cfg.min_word_margin_ms / 1000.0
    if margin <= 0:
        return 0.0
    bounds = _retained_word_boundaries(project, track_id, exclude_start=start, exclude_end=end)
    start_gap = margin - _distance_to_nearest_boundary(start, bounds)
    end_gap = margin - _distance_to_nearest_boundary(end, bounds)
    return max(0.0, start_gap, end_gap)


def measure_join_jump_db(
    project,
    track_id: str,
    join_time: float,
    *,
    audio_cache: TrackAudioCache | None = None,
) -> float | None:
    if audio_cache is not None:
        pre = audio_cache.jump.rms_db(max(0.0, join_time - 0.05), join_time)
        post = audio_cache.jump.rms_db(join_time, join_time + 0.05)
        return None if (pre is None or post is None) else abs(post - pre)
    try:
        path = track_audio_path(project, track_id)
    except ValueError:
        return None
    pre = measure_window_rms_db(path, max(0.0, join_time - 0.05), join_time)
    post = measure_window_rms_db(path, join_time, join_time + 0.05)
    if pre is None or post is None:
        return None
    return abs(post - pre)


JumpCache = dict[tuple[str, float], "float | None"]


def _measure_join_jump_cached(
    project,
    track_id: str,
    join_time: float,
    cache: JumpCache | None,
    *,
    audio_cache: TrackAudioCache | None = None,
) -> float | None:
    """measure_join_jump_db, memoized per (track_id, join_time) when a cache is
    given. assess_cut_risk and recommend_cut_fade_ms are both called for the same
    candidate's boundaries and would otherwise each independently re-measure the
    same join -- callers processing one candidate should pass a fresh dict shared
    across both calls (see edits/fillers.py::_analyze_candidate).
    """
    if cache is None:
        return measure_join_jump_db(project, track_id, join_time, audio_cache=audio_cache)
    key = (track_id, round(join_time, 6))
    if key not in cache:
        cache[key] = measure_join_jump_db(project, track_id, join_time, audio_cache=audio_cache)
    return cache[key]


def recommend_cut_fade_ms(
    project,
    track_id: str,
    start: float,
    end: float,
    *,
    cut_kind: str = "filler",
    defaults: dict[str, Any] | None = None,
    cache: JumpCache | None = None,
    audio_cache: TrackAudioCache | None = None,
) -> int:
    h = _heuristics(defaults)
    tighten = _tighten_cfg(defaults)
    base = int(tighten.get("crossfade_ms", h["min_fade_ms"]))
    duration_ms = int((end - start) * 1000)
    if cut_kind == "pause":
        fade = max(base, min(150, duration_ms // 2 or base))
    else:
        fade = max(int(h["min_fade_ms"]), min(50, base + duration_ms // 4))

    start_jump = _measure_join_jump_cached(project, track_id, start, cache, audio_cache=audio_cache)
    end_jump = _measure_join_jump_cached(project, track_id, end, cache, audio_cache=audio_cache)
    jump = (
        max(j for j in (start_jump, end_jump) if j is not None)
        if (start_jump is not None or end_jump is not None)
        else 0.0
    )

    if jump >= float(h["boundary_jump_db"]):
        fade = max(fade, int(h["recommended_fade_ms"]), min(150, int(jump * 2)))
    return fade


def _resume_edge_rms_db(
    project,
    track_id: str,
    source_resume_sec: float,
    start_off: float,
    end_off: float,
    *,
    audio_cache: TrackAudioCache | None = None,
) -> float | None:
    t0 = max(0.0, source_resume_sec + start_off)
    t1 = max(t0 + 0.005, source_resume_sec + end_off)
    if audio_cache is not None:
        return audio_cache.jump.rms_db(t0, t1)
    try:
        path = track_audio_path(project, track_id)
    except ValueError:
        return None
    return measure_window_rms_db(path, t0, t1)


def recommend_post_pad_fade_in_ms(
    project,
    track_id: str,
    source_resume_sec: float,
    *,
    defaults: dict[str, Any] | None = None,
    audio_cache: TrackAudioCache | None = None,
) -> int:
    """Silence/room-tone pad → speech: fade length from resume-edge energy.

    Scans a short look-ahead after ``source_resume_sec``. Quiet air keeps a
    tiny declick; a hot onset (and how late it arrives) lengthens the fade so
    it still covers the consonant - not a fixed 50/100 ms rule.

    Legacy ``tighten.filler_post_pad_fade_in_ms`` forces a fixed length when
    min/max are unset (tests / old configs).
    """
    tighten = _tighten_cfg(defaults)
    h = _heuristics(defaults)
    if (
        "filler_post_pad_fade_in_ms" in tighten
        and "filler_post_pad_fade_in_min_ms" not in tighten
        and "filler_post_pad_fade_in_max_ms" not in tighten
    ):
        return max(0, int(tighten["filler_post_pad_fade_in_ms"]))

    min_ms = int(tighten.get("filler_post_pad_fade_in_min_ms", 15))
    max_ms = int(tighten.get("filler_post_pad_fade_in_max_ms", 120))
    if max_ms < min_ms:
        min_ms, max_ms = max_ms, min_ms
    if max_ms <= 0:
        return 0

    quiet_db = float(tighten.get("filler_post_pad_quiet_db", h["audibility_rms_db"]))
    hot_db = float(tighten.get("filler_post_pad_hot_db", -22.0))
    look_ahead = float(tighten.get("filler_post_pad_look_ahead_ms", 120)) / 1000.0
    hop = 0.02

    peak_db: float | None = None
    peak_at = 0.0
    t = 0.0
    while t < look_ahead - 1e-9:
        db = _resume_edge_rms_db(
            project,
            track_id,
            source_resume_sec,
            t,
            min(t + hop, look_ahead),
            audio_cache=audio_cache,
        )
        if db is not None and (peak_db is None or db > peak_db):
            peak_db = db
            peak_at = t
        t += hop

    if peak_db is None:
        return min_ms

    span = max(1e-6, hot_db - quiet_db)
    energy_t = max(0.0, min(1.0, (peak_db - quiet_db) / span))
    energy_fade = round(min_ms + energy_t * (max_ms - min_ms))
    # Cover into a real onset (not quiet lead-in air) so a late L still softens.
    cover_fade = 0
    if peak_db > quiet_db + 3.0:
        cover_fade = round((peak_at + 0.025) * 1000)
    return max(min_ms, min(max_ms, max(energy_fade, cover_fade)))


def recommend_prev_word_lead_out_ms(
    project,
    track_id: str,
    prev_end_sec: float,
    *,
    defaults: dict[str, Any] | None = None,
    audio_cache: TrackAudioCache | None = None,
    max_available_sec: float | None = None,
) -> int:
    """How far past ASR ``prev_end`` to keep before a replace-gap cut.

    Nasals/releases often ring past the transcript end. Fixed 60 ms still cuts
    through a hot N; scan until energy reaches the quiet floor (clamped).

    Legacy ``tighten.filler_prev_word_lead_out_ms`` alone forces a fixed length.
    """
    tighten = _tighten_cfg(defaults)
    h = _heuristics(defaults)
    if (
        "filler_prev_word_lead_out_ms" in tighten
        and "filler_prev_word_lead_out_min_ms" not in tighten
        and "filler_prev_word_lead_out_max_ms" not in tighten
    ):
        return max(0, int(tighten["filler_prev_word_lead_out_ms"]))

    min_ms = int(
        tighten.get(
            "filler_prev_word_lead_out_min_ms",
            tighten.get("filler_prev_word_lead_out_ms", 40),
        )
    )
    max_ms = int(tighten.get("filler_prev_word_lead_out_max_ms", 250))
    if max_ms < min_ms:
        min_ms, max_ms = max_ms, min_ms
    if max_ms <= 0:
        return 0

    quiet_db = float(tighten.get("filler_prev_word_quiet_db", h["audibility_rms_db"]))
    look = float(tighten.get("filler_prev_word_look_ahead_ms", 300)) / 1000.0
    if max_available_sec is not None:
        look = min(look, max(0.0, max_available_sec))
    hop = 0.02

    saw_energy = False
    quiet_at: float | None = None
    t = 0.0
    while t < look - 1e-9:
        db = _resume_edge_rms_db(
            project,
            track_id,
            prev_end_sec,
            t,
            min(t + hop, look),
            audio_cache=audio_cache,
        )
        if db is not None:
            saw_energy = True
            if db <= quiet_db:
                quiet_at = t
                break
        t += hop

    if not saw_energy:
        return min_ms
    out = max_ms if quiet_at is None else round((quiet_at + 0.02) * 1000)
    return max(min_ms, min(max_ms, out))


def assess_cut_risk(
    project,
    track_id: str,
    start: float,
    end: float,
    *,
    filler_confidence: float | None = None,
    boundary_confidence: float | None = None,
    defaults: dict[str, Any] | None = None,
    cache: JumpCache | None = None,
    audio_cache: TrackAudioCache | None = None,
) -> CutRisk:
    tighten = _tighten_cfg(defaults)
    max_score = float(tighten.get("max_cut_risk_score", 0.65))
    reasons: list[str] = []
    score = 0.0

    if boundary_confidence is not None and boundary_confidence < 0.35:
        score += 0.35
        reasons.append(f"low boundary confidence ({boundary_confidence:.2f})")

    margin_violation = word_margin_violation_sec(project, track_id, start, end)
    if margin_violation > 0:
        score += min(0.35, margin_violation * 20.0)
        reasons.append(f"within word margin ({margin_violation * 1000:.0f}ms)")

    min_filler_conf = float(tighten.get("min_filler_confidence", 0.15))
    if filler_confidence is not None and filler_confidence < min_filler_conf:
        score += 0.25
        reasons.append(f"low filler ASR confidence ({filler_confidence:.2f})")

    start_jump = _measure_join_jump_cached(project, track_id, start, cache, audio_cache=audio_cache)
    end_jump = _measure_join_jump_cached(project, track_id, end, cache, audio_cache=audio_cache)
    h = _heuristics(defaults)
    for label, jump in (("start", start_jump), ("end", end_jump)):
        if jump is not None and jump >= float(h["boundary_jump_db"]):
            score += 0.2
            reasons.append(f"harsh {label} join (~{jump:.1f} dB)")

    if end - start < 0.02:
        score += 0.15
        reasons.append("very short cut window")

    normalized = min(1.0, score / max(max_score, 1e-6))
    risk = CutRisk(score=normalized, reasons=reasons)
    if normalized >= 1.0:
        return CutRisk(score=1.0, reasons=reasons)
    return risk


def optimize_and_assess(
    project,
    track_id: str,
    start: float,
    end: float,
    *,
    filler_confidence: float | None = None,
    defaults: dict[str, Any] | None = None,
    force_enabled: bool | None = None,
    cache: JumpCache | None = None,
    audio_cache: TrackAudioCache | None = None,
):
    tighten = _tighten_cfg(defaults)
    use_opt = tighten.get("inaudible_opt", True)
    if force_enabled is None:
        force_enabled = use_opt
    opt = optimize_source_cut_range(
        project,
        track_id,
        start,
        end,
        force_enabled=force_enabled,
        audio_cache=audio_cache,
    )
    risk = assess_cut_risk(
        project,
        track_id,
        opt.start,
        opt.end,
        filler_confidence=filler_confidence,
        boundary_confidence=opt.confidence,
        defaults=defaults,
        cache=cache,
        audio_cache=audio_cache,
    )
    return opt, risk
