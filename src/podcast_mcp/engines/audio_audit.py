from __future__ import annotations

import contextlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp.config import load_defaults
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.asr_timing import (
    ANOMALOUS_WORD_DURATION_REASON,
    DEFAULT_MAX_WORD_DURATION_SEC,
    word_duration_is_anomalous,
)
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.timemap import timeline_to_source
from podcast_mcp.models import EpisodeProject, TrackRole
from podcast_mcp.util.binaries import resolve_ffmpeg
from podcast_mcp.util.dsp import rms_db
from podcast_mcp.util.process import CalledProcessError, run
from podcast_mcp.util.progress import (
    ProgressReporter,
    resolve_progress_task,
)
from podcast_mcp.util.timebase import SourceSec
from podcast_mcp.util.tracks import dialogue_track_ids, track_audio_path

_RMS_SAMPLE_RATE = 8000


@dataclass(frozen=True)
class AnalysisPolicy:
    audibility_rms_db: float = -42.0
    bleed_dominance_db: float = 6.0
    bleed_min_other_rms_db: float = -50.0
    gate_onset_drop_db: float = 15.0
    boundary_jump_db: float = 12.0
    min_fade_ms: int = 10
    recommended_fade_ms: int = 20
    # Cap for jump-scaled harsh-join recommendations (ms).
    harsh_fade_max_ms: int = 80
    # Words longer than this skip full-span mean RMS (ASR stretch); status deferred.
    max_word_audibility_sec: float = DEFAULT_MAX_WORD_DURATION_SEC
    ml_backend: str = "off"
    transcript_mode: str = "reconcile"
    reconcile_on_render: bool = True
    bleed_text_match_enabled: bool = True
    bleed_text_match_min_overlap_sec: float = 0.02
    bleed_text_match_min_dominance_db: float | None = None
    bleed_ratio_warn_threshold: float = 0.2

    @classmethod
    def from_defaults(cls, defaults: dict[str, Any] | None = None) -> AnalysisPolicy:
        cfg = (defaults or load_defaults()).get("analysis", {})
        heur = cfg.get("heuristics", {})
        min_dom = heur.get("bleed_text_match_min_dominance_db")
        return cls(
            audibility_rms_db=float(heur.get("audibility_rms_db", -42.0)),
            bleed_dominance_db=float(heur.get("bleed_dominance_db", 6.0)),
            bleed_min_other_rms_db=float(heur.get("bleed_min_other_rms_db", -50.0)),
            gate_onset_drop_db=float(heur.get("gate_onset_drop_db", 15.0)),
            boundary_jump_db=float(heur.get("boundary_jump_db", 12.0)),
            min_fade_ms=int(heur.get("min_fade_ms", 10)),
            recommended_fade_ms=int(heur.get("recommended_fade_ms", 20)),
            harsh_fade_max_ms=int(heur.get("harsh_fade_max_ms", 80)),
            max_word_audibility_sec=float(
                heur.get("max_word_audibility_sec", DEFAULT_MAX_WORD_DURATION_SEC)
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


def load_mono_full(
    path: Path,
    *,
    sample_rate: int = _RMS_SAMPLE_RATE,
    ffmpeg: str | None = None,
) -> np.ndarray:
    cmd = [
        ffmpeg or resolve_ffmpeg(),
        "-v",
        "error",
        "-i",
        str(path),
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "f32le",
        "pipe:1",
    ]
    r = run(cmd, capture_output=True, check=True)
    samples = np.frombuffer(r.stdout, dtype=np.float32)
    if samples.size == 0:
        raise ValueError(f"no audio decoded from {path}")
    return samples


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


def clipping_indicated(astats: dict[str, Any] | None) -> bool:
    """True when astats show pinned crests or near-full-scale peaks."""
    if not astats:
        return False
    peak = astats.get("peak_level_db")
    if isinstance(peak, (int, float)) and peak >= CLIPPING_PEAK_LEVEL_DB:
        return True
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

    @classmethod
    def from_timeline_stem(
        cls, path: Path, *, sample_rate: int = _RMS_SAMPLE_RATE
    ) -> TrackRmsCache:
        return cls(samples=load_mono_full(path, sample_rate=sample_rate), sample_rate=sample_rate)

    def _index_range(self, t_start: float, t_end: float) -> tuple[int, int] | None:
        i0 = int(max(0.0, t_start - self.timeline_offset_sec) * self.sample_rate)
        i1 = int(max(0.0, t_end - self.timeline_offset_sec) * self.sample_rate)
        if i1 <= i0 or i0 >= self.samples.size:
            return None
        return i0, min(i1, self.samples.size)

    def window(self, t_start: float, t_end: float) -> np.ndarray:
        """Raw sample slice for [t_start, t_end) timeline seconds; empty if out of range."""
        rng = self._index_range(t_start, t_end)
        if rng is None:
            return np.empty(0, dtype=self.samples.dtype)
        return self.samples[rng[0] : rng[1]]

    def rms_db(self, t_start: float, t_end: float) -> float | None:
        dur = t_end - t_start
        if dur <= 0.005:
            return None
        window = self.window(t_start, t_end)
        if window.size == 0:
            return None
        return rms_db(window)


@dataclass
class TrackRmsCacheSet:
    caches: dict[str, TrackRmsCache] = field(default_factory=dict)

    def get(self, track_id: str) -> TrackRmsCache | None:
        return self.caches.get(track_id)


def build_track_rms_caches(project: EpisodeProject) -> TrackRmsCacheSet:
    caches: dict[str, TrackRmsCache] = {}
    for tid in dialogue_track_ids(project):
        proc = _processed_track_path(project, tid)
        if proc is not None:
            caches[tid] = TrackRmsCache.from_timeline_stem(proc)
    return TrackRmsCacheSet(caches=caches)


def measure_window_rms_db(
    path: Path,
    start_sec: float,
    end_sec: float,
    *,
    sample_rate: int = _RMS_SAMPLE_RATE,
    cache: TrackRmsCache | None = None,
) -> float | None:
    if cache is not None:
        return cache.rms_db(start_sec, end_sec)
    dur = end_sec - start_sec
    if dur <= 0.005:
        return None
    try:
        window = load_mono_window(
            path, start_sec=start_sec, duration_sec=dur, sample_rate=sample_rate
        )
    except (ValueError, CalledProcessError):
        return None
    if window.size == 0:
        return None
    return rms_db(window)


def _processed_track_path(project: EpisodeProject, track_id: str) -> Path | None:
    p = project.artifacts_dir() / "tracks" / f"{track_id}.wav"
    return p if p.is_file() else None


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
    spans = st.map_source_span(track_id, SourceSec(src_start), SourceSec(src_end))
    if not spans:
        return None
    return float(spans[0][0]), float(spans[-1][1])


def _rms_for_track_at_timeline(
    project: EpisodeProject,
    track_id: str,
    t_start: float,
    t_end: float,
    *,
    caches: TrackRmsCacheSet | None = None,
) -> float | None:
    track = project.track_by_id(track_id)
    cache = caches.get(track_id) if caches else None
    if cache is not None:
        rms = cache.rms_db(t_start, t_end)
    else:
        proc = _processed_track_path(project, track_id)
        if proc is not None:
            rms = measure_window_rms_db(proc, t_start, t_end)
        else:
            try:
                path, src0 = timeline_to_source(project, track_id, t_start)
                _, src1 = timeline_to_source(project, track_id, t_end)
                rms = measure_window_rms_db(path, src0, src1)
            except Exception:
                return None
    # The recording's level, not the mix: volume and mute are listening choices.
    gain = track.gain_db if track else 0.0
    return _effective_rms_db(rms, gain)


def measure_timeline_rms_db(
    project: EpisodeProject,
    track_id: str,
    t_start: float,
    t_end: float,
    *,
    caches: TrackRmsCacheSet | None = None,
) -> float | None:
    """Public RMS (dB) for a timeline window on one dialogue track."""
    return _rms_for_track_at_timeline(project, track_id, t_start, t_end, caches=caches)


def _classify_word_audibility(
    own_track_id: str,
    own_rms: float | None,
    track_rms: dict[str, float],
    *,
    policy: AnalysisPolicy,
) -> tuple[str, str | None]:
    if own_rms is None:
        return "inaudible", None

    dominant_tid = max(track_rms, key=lambda tid: track_rms.get(tid, -80.0))
    dominant_rms = track_rms.get(dominant_tid, -80.0)

    if dominant_tid != own_track_id:
        own_val = track_rms.get(own_track_id, own_rms)
        if (
            dominant_rms - own_val >= policy.bleed_dominance_db
            and dominant_rms >= policy.bleed_min_other_rms_db
        ):
            return "bleed", dominant_tid

    if own_rms < policy.audibility_rms_db:
        return "inaudible", None

    return "audible", None


def compute_word_audibility_map(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
) -> list[dict[str, Any]]:
    """Per-word audibility across all dialogue tracks at each word's timeline window."""
    pol = policy or AnalysisPolicy.from_defaults()
    if pol.transcript_mode == "off":
        return []

    caches = build_track_rms_caches(project)
    st = SessionTimeline(project)
    out: list[dict[str, Any]] = []
    all_tracks = dialogue_track_ids(project)
    targets = [track_id] if track_id else all_tracks

    total_words = sum(len(tr.words) for tid in targets if (tr := project.transcript_for_track(tid)))

    # RMS windows shorter than this cannot be measured (see TrackRmsCache.rms_db).
    _min_rms_dur = 0.005

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

        for tid in targets:
            tr = project.transcript_for_track(tid)
            if not tr:
                continue
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

                tl_span = _word_timeline_span(st, tid, w.start, w.end)
                if tl_span is None:
                    done += 1
                    _tick()
                    continue
                tl_start, tl_end = tl_span
                track_rms: dict[str, float] = {}
                for other_tid in all_tracks:
                    rms = _rms_for_track_at_timeline(
                        project, other_tid, tl_start, tl_end, caches=caches
                    )
                    if rms is not None:
                        track_rms[other_tid] = rms

                own_rms = track_rms.get(tid)
                status, dominant = _classify_word_audibility(tid, own_rms, track_rms, policy=pol)

                entry: dict[str, Any] = {
                    "track_id": tid,
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
                if status == "inaudible":
                    entry["reason"] = "below_audibility_threshold"
                elif status == "bleed":
                    entry["reason"] = "cross_track_bleed"
                out.append(entry)
                done += 1
                _tick()

    return out


def list_bleed_words(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    policy: AnalysisPolicy | None = None,
) -> list[dict[str, Any]]:
    return [
        row
        for row in compute_word_audibility_map(project, track_id=track_id, policy=policy)
        if row["audibility_status"] == "bleed"
    ]


def list_flagged_words(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
) -> list[dict[str, Any]]:
    return [
        row
        for row in compute_word_audibility_map(
            project, track_id=track_id, policy=policy, progress=progress
        )
        if row["audibility_status"] in ("inaudible", "bleed")
    ]


def _track_has_gate(project: EpisodeProject, track_id: str) -> bool:
    chain = next((c for c in project.processing_chains if c.track_id == track_id), None)
    if not chain:
        return False
    return any(e.effect == "agate" for e in chain.effects)


def list_low_audibility_words(
    project: EpisodeProject,
    *,
    policy: AnalysisPolicy | None = None,
    track_id: str | None = None,
    progress: ProgressReporter | None = None,
) -> list[dict[str, Any]]:
    """Flag transcript words whose timeline windows are below audibility threshold."""

    pol = policy or AnalysisPolicy.from_defaults()
    caches = build_track_rms_caches(project)
    st = SessionTimeline(project)
    out: list[dict[str, Any]] = []
    tracks = [track_id] if track_id else dialogue_track_ids(project)
    total_words = sum(
        len([w for w in tr.words if not w.suppressed])
        for tid in tracks
        if (tr := project.transcript_for_track(tid))
    )

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

        for tid in tracks:
            tr = project.transcript_for_track(tid)
            if not tr:
                continue
            proc_cache = caches.get(tid)
            for i, w in enumerate(tr.words):
                if w.suppressed:
                    continue
                tl_span = _word_timeline_span(st, tid, w.start, w.end)
                if proc_cache is not None:
                    if tl_span is None:
                        done += 1
                        _tick()
                        continue
                    rms = proc_cache.rms_db(tl_span[0], tl_span[1])
                else:
                    try:
                        path = track_audio_path(project, tid)
                        rms = measure_window_rms_db(path, w.start, w.end)
                    except Exception:
                        done += 1
                        _tick()
                        continue
                done += 1
                _tick()
                if rms is None or rms >= pol.audibility_rms_db:
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
                        "word_index": i,
                        "text": w.text,
                        "start": w.start,
                        "end": w.end,
                        "rms_db": round(rms, 2),
                        "threshold_db": pol.audibility_rms_db,
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
) -> dict[str, Any]:
    """Detect likely gate clipping on syllable onsets/offsets."""
    pol = policy or AnalysisPolicy.from_defaults()
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
) -> list[dict[str, Any]]:
    """Recommend clip fades where joins have large level jumps or no fades."""
    # Deferred: edits/clips_ops.py sits behind the edits package __init__, which
    # imports edits/cut_quality.py, which imports back from this module -- a
    # module-level import here would make that a real circular import depending
    # on which module a process happens to touch first. Deferring it until this
    # function actually runs sidesteps the cycle: by then audio_audit has already
    # finished initializing.
    from podcast_mcp.edits.clips_ops import clips_abut, clips_for_track

    pol = policy or AnalysisPolicy.from_defaults()
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
) -> dict[str, Any]:
    """Full cleanup analysis report for one or all dialogue tracks."""

    pol = policy or AnalysisPolicy.from_defaults()
    tracks = [track_id] if track_id else dialogue_track_ids(project)
    per_track: list[dict[str, Any]] = []

    with resolve_progress_task(
        "analyze-cleanup",
        "Running cleanup analysis",
        total=len(tracks) or None,
        prefer_parent=True,
        progress=progress,
    ) as task:
        for tid in tracks:
            track = project.track_by_id(tid)
            if not track or track.role != TrackRole.DIALOGUE:
                task.advance(1, total=len(tracks), message=f"track {tid}")
                continue
            gate = analyze_gate_overreach(project, tid, policy=pol, progress=None)
            low_aud = list_low_audibility_words(project, policy=pol, track_id=tid, progress=None)
            flagged = (
                list_flagged_words(project, policy=pol, track_id=tid, progress=None)
                if pol.transcript_mode != "off"
                else []
            )
            bleed = [f for f in flagged if f["audibility_status"] == "bleed"]
            tr_for_ratio = project.transcript_for_track(tid)
            total_words = len(tr_for_ratio.words) if tr_for_ratio else 0
            bleed_ratio = round(len(bleed) / total_words, 3) if total_words else None
            fades = recommend_boundary_fades(project, policy=pol, track_id=tid)
            chain = next((c for c in project.processing_chains if c.track_id == tid), None)
            effects = [e.effect for e in chain.effects] if chain else []

            proc_path = _processed_track_path(project, tid)
            health: dict[str, Any] | None = None
            if proc_path is not None:
                stats: dict[str, Any] = dict(measure_astats(proc_path))
                stats["hum"] = detect_mains_hum(proc_path)
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
            if pol.transcript_mode == "suggest" and flagged:
                track_row["suppression_recommendations"] = [
                    {"track_id": f["track_id"], "word_index": f["word_index"]} for f in flagged
                ]
            per_track.append(track_row)
            task.advance(1, total=len(tracks), message=f"track {tid}")

    from podcast_mcp.engines.reconciliation_state import reconciliation_status

    result: dict[str, Any] = {
        "tracks": per_track,
        "policy": {
            "audibility_rms_db": pol.audibility_rms_db,
            "bleed_dominance_db": pol.bleed_dominance_db,
            "bleed_min_other_rms_db": pol.bleed_min_other_rms_db,
            "bleed_ratio_warn_threshold": pol.bleed_ratio_warn_threshold,
            "ml_backend": pol.ml_backend,
            "transcript_mode": pol.transcript_mode,
            "reconcile_on_render": pol.reconcile_on_render,
        },
        "reconciliation": reconciliation_status(project),
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
