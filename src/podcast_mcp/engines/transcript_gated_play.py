from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp.engines.session_timeline import DEFAULT_MERGE_GAP_SEC, SessionTimeline
from podcast_mcp.models import EpisodeProject, TrackRole
from podcast_mcp.util.binaries import resolve_ffmpeg
from podcast_mcp.util.dsp import db_to_amplitude
from podcast_mcp.util.process import run
from podcast_mcp.util.timebase import TimelineSec
from podcast_mcp.util.tracks import mixed_dialogue_track_ids

GATE_FADE_SEC = 0.012
GATE_MERGE_GAP_SEC = DEFAULT_MERGE_GAP_SEC
GATE_SAMPLE_RATE = 48_000


def word_intervals(
    project: EpisodeProject,
    track_id: str,
    start_sec: float,
    end_sec: float,
    *,
    merge_gap_sec: float = GATE_MERGE_GAP_SEC,
) -> list[tuple[float, float]]:
    """Timeline spans of non-suppressed words within [start_sec, end_sec), merged.

    ``start_sec``/``end_sec`` and the returned intervals are TIMELINE seconds
    (the clock of rendered stems/premix). Stored word times are source-clock
    and are projected through the clip map before windowing.
    """
    return [
        (float(s), float(e))
        for s, e in SessionTimeline(project).word_intervals_timeline(
            track_id,
            TimelineSec(start_sec),
            TimelineSec(end_sec),
            merge_gap_sec=merge_gap_sec,
        )
    ]


def source_word_intervals(
    project: EpisodeProject,
    track_id: str,
    start_sec: float,
    end_sec: float,
    *,
    merge_gap_sec: float = GATE_MERGE_GAP_SEC,
) -> list[tuple[float, float]]:
    """Source-clock spans of non-suppressed words within [start_sec, end_sec)."""
    tr = project.transcript_for_track(track_id)
    if not tr:
        return []
    raw: list[tuple[float, float]] = []
    for w in tr.words:
        if w.suppressed:
            continue
        if w.end <= start_sec or w.start >= end_sec:
            continue
        raw.append((max(start_sec, w.start), min(end_sec, w.end)))
    if not raw:
        return []
    raw.sort()
    merged: list[tuple[float, float]] = [raw[0]]
    for s, e in raw[1:]:
        ps, pe = merged[-1]
        if s <= pe + merge_gap_sec:
            merged[-1] = (ps, max(pe, e))
        else:
            merged.append((s, e))
    return merged


def transcript_gate_fingerprint(
    project: EpisodeProject,
    track_ids: list[str],
    start_sec: float,
    end_sec: float,
) -> str:
    """Cache key for gated renders: mapped word intervals + suppression state.

    Built from the *timeline-projected* intervals so the key changes when
    clips move words on the deliverable clock, not just when word metadata
    changes.
    """
    st = SessionTimeline(project)
    parts: list[dict[str, Any]] = []
    for tid in sorted(track_ids):
        tr = project.transcript_for_track(tid)
        if not tr:
            continue
        intervals = st.word_intervals_timeline(tid, TimelineSec(start_sec), TimelineSec(end_sec))
        parts.append(
            {
                "track_id": tid,
                "suppressed_count": sum(1 for w in tr.words if w.suppressed),
                "intervals": [(round(float(s), 4), round(float(e), 4)) for s, e in intervals],
            }
        )
    raw = json.dumps(parts, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _load_segment(
    path: Path,
    start_sec: float,
    duration_sec: float,
    *,
    sample_rate: int = GATE_SAMPLE_RATE,
    ffmpeg: str | None = None,
) -> np.ndarray:
    cmd = [
        ffmpeg or resolve_ffmpeg(),
        "-v",
        "error",
        "-ss",
        str(start_sec),
        "-t",
        str(duration_sec),
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
    return np.frombuffer(r.stdout, dtype=np.float32)


def _apply_gate(
    samples: np.ndarray,
    intervals: list[tuple[float, float]],
    *,
    timeline_start: float,
    sample_rate: int = GATE_SAMPLE_RATE,
    fade_sec: float = GATE_FADE_SEC,
) -> np.ndarray:
    n = samples.size
    if n == 0:
        return samples
    t = np.arange(n, dtype=np.float64) / sample_rate + timeline_start
    env = np.zeros(n, dtype=np.float32)
    fade = int(fade_sec * sample_rate)
    for s, e in intervals:
        mask = (t >= s) & (t < e)
        if not mask.any():
            continue
        idx = np.where(mask)[0]
        env[idx] = 1.0
        if fade > 0:
            i0, i1 = int(idx[0]), int(idx[-1]) + 1
            up = min(fade, i1 - i0)
            env[i0 : i0 + up] *= np.linspace(0, 1, up, dtype=np.float32)
            dn = min(fade, i1 - i0)
            env[i1 - dn : i1] *= np.linspace(1, 0, dn, dtype=np.float32)
    return samples * env


def _write_wav(
    samples: np.ndarray,
    output_path: Path,
    *,
    sample_rate: int = GATE_SAMPLE_RATE,
    ffmpeg: str | None = None,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(samples, -1.0, 1.0)
    pcm16 = (pcm * 32767).astype(np.int16)
    run(
        [
            ffmpeg or resolve_ffmpeg(),
            "-y",
            "-f",
            "s16le",
            "-ar",
            str(sample_rate),
            "-ac",
            "1",
            "-i",
            "pipe:0",
            str(output_path),
        ],
        input=pcm16.tobytes(),
        check=True,
        capture_output=True,
    )
    return output_path


def _normalize_peak(samples: np.ndarray, peak: float = 0.95) -> np.ndarray:
    max_val = float(np.max(np.abs(samples))) if samples.size else 0.0
    if max_val < 1e-10:
        return samples
    return samples * (peak / max_val)


def _apply_gain_db(samples: np.ndarray, gain_db: float) -> np.ndarray:
    """Scale ``samples`` by ``gain_db``; 0 dB returns them unchanged."""
    if not gain_db:
        return samples
    return samples * np.float32(db_to_amplitude(gain_db))


def render_gated_track(
    stem_path: Path,
    intervals: list[tuple[float, float]],
    output_path: Path,
    *,
    timeline_start: float,
    timeline_end: float,
    gain_db: float = 0.0,
) -> Path:
    """Gate one stem and play it at ``gain_db`` (the track's output gain; no normalisation)."""
    duration = timeline_end - timeline_start
    seg = _load_segment(stem_path, timeline_start, duration)
    gated = _apply_gate(seg, intervals, timeline_start=timeline_start)
    _write_wav(_apply_gain_db(gated, gain_db), output_path)
    return output_path


def gate_stem_window(
    stem_path: Path,
    intervals: list[tuple[float, float]],
    output_path: Path,
    *,
    duration_sec: float,
    win_start: float,
    win_end: float,
) -> Path:
    """Gate only ``[win_start, win_end)``; audio outside the window is unchanged."""
    seg = _load_segment(stem_path, 0.0, duration_sec)
    if seg.size == 0:
        _write_wav(seg, output_path)
        return output_path

    win_start = max(0.0, win_start)
    win_end = min(duration_sec, win_end)
    if win_end <= win_start:
        if stem_path.resolve() != output_path.resolve():
            output_path.write_bytes(stem_path.read_bytes())
        return output_path

    gated = _apply_gate(seg.copy(), intervals, timeline_start=0.0)
    i0 = round(win_start * GATE_SAMPLE_RATE)
    i1 = round(win_end * GATE_SAMPLE_RATE)
    i0 = max(0, min(i0, seg.size))
    i1 = max(i0, min(i1, seg.size))
    out = seg.copy()
    out[i0:i1] = gated[i0:i1]
    _write_wav(out, output_path)
    return output_path


def gate_rendered_wav(
    wav_path: Path,
    intervals: list[tuple[float, float]],
    *,
    timeline_start: float,
    timeline_end: float,
) -> Path:
    """In-place gate a rendered WAV whose samples start at ``timeline_start``."""
    duration = max(0.0, timeline_end - timeline_start)
    if duration <= 0:
        return wav_path
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        seg = _load_segment(wav_path, 0.0, duration)
        gated = _apply_gate(seg, intervals, timeline_start=timeline_start)
        _write_wav(gated, tmp_path)
        tmp_path.replace(wav_path)
    finally:
        if tmp_path.is_file():
            tmp_path.unlink(missing_ok=True)
    return wav_path


def apply_track_transcript_gate(
    project: EpisodeProject,
    track_id: str,
    wav_path: Path,
    *,
    timeline_start: float,
    timeline_end: float,
) -> Path:
    """Apply project word-interval gate to a rendered WAV when track.transcript_gate."""
    track = project.track_by_id(track_id)
    if not track or not track.transcript_gate:
        return wav_path
    if timeline_end <= timeline_start:
        return wav_path
    intervals = word_intervals(project, track_id, timeline_start, timeline_end)
    return gate_rendered_wav(
        wav_path,
        intervals,
        timeline_start=timeline_start,
        timeline_end=timeline_end,
    )


def render_gated_mix(
    stems: list[tuple[str, Path]],
    intervals_by_track: dict[str, list[tuple[float, float]]],
    output_path: Path,
    *,
    timeline_start: float,
    timeline_end: float,
    gains_db: dict[str, float] | None = None,
) -> Path:
    """Sum the gated stems, each at its ``gains_db`` entry (dB, default 0), then peak-normalise.

    Stems don't bake a track's output gain, so the caller passes it here and the
    gated mix keeps the track balance every other mix path plays.
    Peak normalisation keeps the balance but not the absolute level: a uniform
    gain change renders the same audio.
    """
    duration = timeline_end - timeline_start
    gains = gains_db or {}
    mix: np.ndarray | None = None
    for tid, path in stems:
        seg = _load_segment(path, timeline_start, duration)
        gated = _apply_gate(seg, intervals_by_track.get(tid, []), timeline_start=timeline_start)
        gated = _apply_gain_db(gated, float(gains.get(tid, 0.0)))
        mix = gated if mix is None else mix + gated
    if mix is None:
        raise ValueError("no stems to mix")
    mix = _normalize_peak(mix)
    _write_wav(mix, output_path)
    return output_path


def dialogue_tracks_for_play(project: EpisodeProject) -> list[str]:
    return [
        t.id for t in project.tracks if t.role == TrackRole.DIALOGUE and t.media and not t.muted
    ] or mixed_dialogue_track_ids(project)
