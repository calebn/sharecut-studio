from __future__ import annotations

import hashlib
import json
import math
import shutil
import tempfile
from bisect import bisect_left, bisect_right
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp.engines.bleed_gate import BleedGatePlan, build_bleed_gate_plan
from podcast_mcp.engines.session_timeline import DEFAULT_MERGE_GAP_SEC, SessionTimeline
from podcast_mcp.models import EpisodeProject, TrackRole
from podcast_mcp.util.timebase import TimelineSec
from podcast_mcp.util.tracks import mixed_dialogue_track_ids

GATE_FADE_SEC = 0.012
GATE_MERGE_GAP_SEC = DEFAULT_MERGE_GAP_SEC


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


def _gate_pcm_chunk(
    raw: bytes,
    frame_intervals: list[tuple[int, int]],
    *,
    first_frame: int,
    sample_rate: int,
    channels: int,
    plan: BleedGatePlan | None = None,
) -> bytes:
    """Gate one PCM16 chunk using fade positions on the whole stem clock."""
    samples = np.frombuffer(raw, dtype="<i2").reshape(-1, channels)
    if plan is not None:
        env = plan.gains_for_frames(first_frame, samples.shape[0], sample_rate)
        return (samples.astype(np.float32) * env[:, np.newaxis]).astype("<i2").tobytes()
    env = np.zeros(samples.shape[0], dtype=np.float32)
    last_frame = first_frame + samples.shape[0]
    fade = int(GATE_FADE_SEC * sample_rate)
    for lo, hi in frame_intervals:
        a, b = max(lo, first_frame), min(hi, last_frame)
        if b <= a:
            continue
        positions = np.arange(a, b, dtype=np.int64)
        gain = np.ones(b - a, dtype=np.float32)
        if fade:
            width = min(fade, hi - lo)
            if width > 1:
                up = positions < lo + width
                gain[up] *= (positions[up] - lo) / (width - 1)
                down = positions >= hi - width
                gain[down] *= (hi - 1 - positions[down]) / (width - 1)
            elif width == 1:
                gain[:] = 0.0
        env[a - first_frame : b - first_frame] = gain
    return (samples.astype(np.float32) * env[:, np.newaxis]).astype("<i2").tobytes()


def _pcm16_wave_info(source: Any) -> tuple[int, int, int, int]:
    """Read RIFF PCM16 format and data bounds, including extensible channel layouts."""
    if source.read(4) != b"RIFF":
        raise ValueError("transcript gate requires a RIFF PCM16 WAV stem")
    source.read(4)  # RIFF size
    if source.read(4) != b"WAVE":
        raise ValueError("transcript gate requires a RIFF PCM16 WAV stem")
    channels = rate = 0
    while header := source.read(8):
        if len(header) != 8:
            break
        chunk_size = int.from_bytes(header[4:], "little")
        chunk_start = source.tell()
        if header[:4] == b"fmt ":
            fmt = source.read(min(chunk_size, 40))
            if len(fmt) < 16:
                break
            tag = int.from_bytes(fmt[:2], "little")
            channels = int.from_bytes(fmt[2:4], "little")
            rate = int.from_bytes(fmt[4:8], "little")
            bits = int.from_bytes(fmt[14:16], "little")
            pcm_guid = bytes.fromhex("0100000000001000800000aa00389b71")
            if (
                not (tag == 1 or (tag == 65534 and len(fmt) >= 40 and fmt[24:40] == pcm_guid))
                or bits != 16
                or channels < 1
                or rate < 1
            ):
                raise ValueError("transcript gate requires an uncompressed PCM16 WAV stem")
        elif header[:4] == b"data" and channels:
            if chunk_size % (channels * 2):
                raise ValueError("transcript gate requires complete PCM16 WAV frames")
            return channels, rate, chunk_start, chunk_size
        source.seek(chunk_start + chunk_size + (chunk_size % 2))
    raise ValueError("transcript gate requires a valid PCM16 WAV stem")


def gate_stem_window(
    stem_path: Path,
    intervals: list[tuple[float, float]],
    output_path: Path,
    *,
    duration_sec: float,
    win_start: float,
    win_end: float,
    plan: BleedGatePlan | None = None,
    timeline_start: float = 0.0,
) -> Path:
    """Gate only ``[win_start, win_end)``; audio outside the window is unchanged."""
    if stem_path.resolve() == output_path.resolve():
        with tempfile.NamedTemporaryFile(
            suffix=".wav", dir=output_path.parent, delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
        try:
            gate_stem_window(
                stem_path,
                intervals,
                temporary_path,
                duration_sec=duration_sec,
                win_start=win_start,
                win_end=win_end,
                plan=plan,
                timeline_start=timeline_start,
            )
            temporary_path.replace(output_path)
        finally:
            temporary_path.unlink(missing_ok=True)
        return output_path
    win_start = max(0.0, win_start)
    win_end = min(duration_sec, win_end)
    if win_end <= win_start:
        if stem_path.resolve() != output_path.resolve():
            shutil.copyfile(stem_path, output_path)
        return output_path

    with stem_path.open("rb") as source:
        channels, rate, data_start, data_bytes = _pcm16_wave_info(source)
        origin_frame = round(timeline_start * rate)
        ordered_intervals = sorted(
            (math.ceil(start * rate) - origin_frame, math.ceil(end * rate) - origin_frame, ordinal)
            for ordinal, (start, end) in enumerate(intervals)
        )
        starts = [start for start, _end, _ordinal in ordered_intervals]
        max_ends: list[int] = []
        latest_end = -1
        for _start, end, _ordinal in ordered_intervals:
            latest_end = max(latest_end, end)
            max_ends.append(latest_end)
        bytes_per_frame = channels * 2
        frames = data_bytes // bytes_per_frame
        if data_start + data_bytes > stem_path.stat().st_size:
            raise ValueError("transcript gate requires complete PCM16 WAV data")
        first = max(0, min(frames, round(win_start * rate)))
        last = max(first, min(frames, round(win_end * rate)))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        source.seek(0)
        with output_path.open("wb") as target:
            remaining_header = data_start
            while remaining_header:
                chunk = source.read(min(64 * 1024, remaining_header))
                target.write(chunk)
                remaining_header -= len(chunk)
            frame = 0
            while frame < frames:
                count = min(rate, frames - frame)
                raw = source.read(count * bytes_per_frame)
                left = max(0, first - frame)
                right = min(count, last - frame)
                if right > left:
                    chunk_first = frame + left
                    chunk_last = frame + right
                    first_candidate = bisect_right(max_ends, chunk_first)
                    last_candidate = bisect_left(starts, chunk_last)
                    overlapping = sorted(
                        (
                            (ordinal, interval_start, interval_end)
                            for interval_start, interval_end, ordinal in ordered_intervals[
                                first_candidate:last_candidate
                            ]
                            if interval_end > chunk_first
                        )
                    )
                    gated_chunk = _gate_pcm_chunk(
                        raw[left * bytes_per_frame : right * bytes_per_frame],
                        [(start, end) for _ordinal, start, end in overlapping],
                        first_frame=chunk_first + origin_frame if plan is not None else chunk_first,
                        sample_rate=rate,
                        channels=channels,
                        plan=plan,
                    )
                    raw = (
                        raw[: left * bytes_per_frame] + gated_chunk + raw[right * bytes_per_frame :]
                    )
                target.write(raw)
                frame += count
            shutil.copyfileobj(source, target, length=64 * 1024)
    return output_path


def apply_track_transcript_gate(
    project: EpisodeProject,
    track_id: str,
    wav_path: Path,
    *,
    timeline_start: float,
    timeline_end: float,
) -> Path:
    """Attenuate verified foreign copies in a rendered WAV when the gate is enabled."""
    track = project.track_by_id(track_id)
    if not track or not track.transcript_gate:
        return wav_path
    if timeline_end <= timeline_start:
        return wav_path
    plan = build_bleed_gate_plan(project, track_id)
    return apply_bleed_gate_plan(
        wav_path,
        plan,
        timeline_start=timeline_start,
        timeline_end=timeline_end,
    )


def apply_bleed_gate_plan(
    wav_path: Path,
    plan: BleedGatePlan,
    *,
    timeline_start: float,
    timeline_end: float,
) -> Path:
    """Apply a single absolute plan without adding transitions at audition boundaries."""
    duration = max(0.0, timeline_end - timeline_start)
    if not plan.attenuation_spans or duration <= 0:
        return wav_path
    return gate_stem_window(
        wav_path,
        list(plan.attenuation_spans),
        wav_path,
        duration_sec=duration,
        win_start=0.0,
        win_end=duration,
        plan=plan,
        timeline_start=timeline_start,
    )


def dialogue_tracks_for_play(project: EpisodeProject) -> list[str]:
    return [
        t.id for t in project.tracks if t.role == TrackRole.DIALOGUE and t.media and not t.muted
    ] or mixed_dialogue_track_ids(project)
