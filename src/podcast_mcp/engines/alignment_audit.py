from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from podcast_mcp.engines.align import AudioWindowUnavailableError, load_mono_window
from podcast_mcp.engines.audio import At, MixAudio, SourceAudio
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.session_clock import file_time_for_session
from podcast_mcp.engines.transcript_align import (
    offset_turn_taking_score,
    overlap_duration,
)
from podcast_mcp.util.binaries import FFmpegPair
from podcast_mcp.util.dsp import bool_runs, bridge_short_dips
from podcast_mcp.util.fingerprint import file_stamp
from podcast_mcp.util.process import CalledProcessError


@dataclass
class SessionStartScore:
    session_start_in_file_sec: float
    simultaneous_speech_sec: float
    correlation_peak: float | None = None


@dataclass
class DriftReport:
    offset_window_a: float
    offset_window_b: float
    drift_sec: float
    warning: str | None = None


@dataclass
class WaveformRenderResult:
    per_speaker: dict[str, Path] = field(default_factory=dict)
    stack_path: Path | None = None
    sweep_paths: list[Path] = field(default_factory=list)


@dataclass
class VADWindowRMSCache:
    values: dict[tuple[object, ...], float | None] = field(default_factory=dict)

    @staticmethod
    def file_identity(path: Path) -> tuple[object, ...] | None:
        absolute = path.absolute()
        try:
            stamp = file_stamp(absolute)
        except OSError:
            return None
        return (str(absolute), str(absolute.resolve()), *stamp)


_BLOCK_SEC = 30.0


def _blocks(
    todo: list[int], chunks: list[tuple[float, float]], block_sec: float
) -> list[list[int]]:
    """Group consecutive chunk indices so one decode covers at most ``block_sec``."""
    blocks: list[list[int]] = []
    for i in todo:
        if (
            blocks
            and blocks[-1][-1] == i - 1
            and chunks[i][0] - chunks[blocks[-1][0]][0] < block_sec
        ):
            blocks[-1].append(i)
        else:
            blocks.append([i])
    return blocks


def _block_rms(
    path: Path,
    block: list[int],
    chunks: list[tuple[float, float]],
    *,
    sample_rate: int,
    ffmpeg: str | None,
) -> dict[int, float | None]:
    """RMS of each chunk in ``block`` from one decode of the block's span.

    Stops at the first chunk the file has no audio for (so a short file keeps its earlier
    speech), returning only the chunks before it. A window or chunk that decodes empty reads None.
    """
    t0 = chunks[block[0]][0]
    end = max(chunks[i][0] + chunks[i][1] for i in block)
    try:
        window = load_mono_window(
            path, start_sec=t0, duration_sec=end - t0, sample_rate=sample_rate, ffmpeg=ffmpeg
        )
    except AudioWindowUnavailableError:
        return {}
    if not window.size:
        return dict.fromkeys(block)
    out: dict[int, float | None] = {}
    for i in block:
        t, dur = chunks[i]
        first = round((t - t0) * sample_rate)
        last = round((t - t0 + dur) * sample_rate)
        if first >= window.size:
            # Either the end of the file or a reader that clamps a wide window (a WAV read
            # is capped in bytes). Decode from here again: the end of the file then
            # raises, and a clamped window moves on.
            if i != block[0]:
                rest = block[block.index(i) :]
                out.update(_block_rms(path, rest, chunks, sample_rate=sample_rate, ffmpeg=ffmpeg))
            break
        piece = window[first:last]
        out[i] = float(np.sqrt(np.mean(piece**2))) if piece.size else None
    return out


def vad_speech_intervals(
    path: Path,
    *,
    start_sec: float = 0.0,
    duration_sec: float = 120.0,
    chunk_sec: float = 0.25,
    rms_threshold: float = 0.015,
    min_run_sec: float = 0.2,
    sample_rate: int = 8000,
    rms_cache: VADWindowRMSCache | None = None,
    ffmpeg: str | None = None,
) -> list[tuple[float, float]]:
    """Energy-based speech intervals relative to ``start_sec`` on the file."""
    if duration_sec <= 0:
        return []
    n_chunks = max(1, int(duration_sec / chunk_sec))
    file_identity = rms_cache.file_identity(path) if rms_cache is not None else None
    cache_values = rms_cache.values if rms_cache is not None and file_identity is not None else None
    chunks = [
        (
            start_sec + i * chunk_sec,
            min(chunk_sec, start_sec + duration_sec - (start_sec + i * chunk_sec)),
        )
        for i in range(n_chunks)
    ]
    keys = [(file_identity, t, dur, sample_rate) for t, dur in chunks]
    rms_values: list[float | None] = [None] * n_chunks
    todo = list(range(n_chunks))
    if cache_values is not None:
        todo = []
        for i, key in enumerate(keys):
            if key in cache_values:
                rms_values[i] = cache_values[key]
            else:
                todo.append(i)
    reached = n_chunks
    for block in _blocks(todo, chunks, _BLOCK_SEC):
        decoded = _block_rms(path, block, chunks, sample_rate=sample_rate, ffmpeg=ffmpeg)
        for i, rms in decoded.items():
            rms_values[i] = rms
            if cache_values is not None:
                cache_values[keys[i]] = rms
        if len(decoded) < len(block):
            # Past EOF on short files: retain prior speech and stop decoding. (#146)
            reached = block[len(decoded)]
            break
    loud = [rms is not None and rms >= rms_threshold for rms in rms_values[:reached]]

    # The old merge joined loud chunks separated by exactly one quiet chunk.
    active = bridge_short_dips(np.asarray(loud, dtype=bool), 1)
    return [
        (start_sec + start * chunk_sec, start_sec + end * chunk_sec)
        for start, end in bool_runs(active)
        if (end - start) * chunk_sec >= min_run_sec
    ]


def simultaneous_speech_sec(
    intervals_a: list[tuple[float, float]],
    intervals_b: list[tuple[float, float]],
    *,
    shift_b_sec: float = 0.0,
) -> float:
    shifted = [(s + shift_b_sec, e + shift_b_sec) for s, e in intervals_b]
    return overlap_duration(intervals_a, shifted)


def score_session_start_candidate(
    reference_path: Path,
    source_path: Path,
    *,
    session_start_source: float,
    session_start_reference: float = 0.0,
    window_start_sec: float = 0.0,
    window_duration_sec: float = 90.0,
    content_align_source: float = 0.0,
    rms_cache: VADWindowRMSCache | None = None,
    ffmpeg_pair: FFmpegPair | None = None,
) -> SessionStartScore:
    ref_file_start = file_time_for_session(session_start_reference, window_start_sec, 0.0)
    src_file_start = file_time_for_session(
        session_start_source, window_start_sec, content_align_source
    )
    ref_iv = vad_speech_intervals(
        reference_path,
        start_sec=ref_file_start,
        duration_sec=window_duration_sec,
        rms_cache=rms_cache,
        ffmpeg=ffmpeg_pair.ffmpeg if ffmpeg_pair else None,
    )
    src_iv = vad_speech_intervals(
        source_path,
        start_sec=src_file_start,
        duration_sec=window_duration_sec,
        rms_cache=rms_cache,
        ffmpeg=ffmpeg_pair.ffmpeg if ffmpeg_pair else None,
    )
    overlap = simultaneous_speech_sec(ref_iv, src_iv)
    peak: float | None = None
    try:
        from podcast_mcp.engines.align import estimate_offset_sec

        result = estimate_offset_sec(
            reference_path,
            source_path,
            analysis_start_sec=ref_file_start,
            analysis_duration_sec=min(window_duration_sec, 60.0),
            max_lag_sec=30.0,
            ffmpeg=ffmpeg_pair.ffmpeg if ffmpeg_pair else None,
        )
        peak = result.correlation_peak
    except (ValueError, CalledProcessError):
        peak = None
    return SessionStartScore(
        session_start_in_file_sec=session_start_source,
        simultaneous_speech_sec=overlap,
        correlation_peak=peak,
    )


def sweep_session_starts(
    reference_path: Path,
    source_path: Path,
    candidate_starts: list[float],
    *,
    session_start_reference: float = 0.0,
    window_start_sec: float = 0.0,
    window_duration_sec: float = 90.0,
    content_align_source: float = 0.0,
    rms_cache: VADWindowRMSCache | None = None,
    ffmpeg_pair: FFmpegPair | None = None,
    on_candidate_complete: Callable[[int, SessionStartScore], None] | None = None,
) -> list[SessionStartScore]:
    scores: list[SessionStartScore] = []
    for index, candidate in enumerate(candidate_starts, 1):
        score = score_session_start_candidate(
            reference_path,
            source_path,
            session_start_source=candidate,
            session_start_reference=session_start_reference,
            window_start_sec=window_start_sec,
            window_duration_sec=window_duration_sec,
            content_align_source=content_align_source,
            rms_cache=rms_cache,
            ffmpeg_pair=ffmpeg_pair,
        )
        scores.append(score)
        if on_candidate_complete is not None:
            on_candidate_complete(index, score)
    return sorted(scores, key=lambda s: s.simultaneous_speech_sec)


def sweep_content_offset(
    reference_path: Path,
    source_path: Path,
    *,
    session_start_reference: float = 0.0,
    session_start_source: float = 0.0,
    window_start_sec: float = 0.0,
    window_duration_sec: float = 90.0,
    max_offset_sec: float = 60.0,
    step_sec: float = 0.5,
    rms_cache: VADWindowRMSCache | None = None,
    ffmpeg_pair: FFmpegPair | None = None,
) -> float:
    ref_file = file_time_for_session(session_start_reference, window_start_sec, 0.0)
    src_file = file_time_for_session(session_start_source, window_start_sec, 0.0)
    ref_iv = vad_speech_intervals(
        reference_path,
        start_sec=ref_file,
        duration_sec=window_duration_sec,
        rms_cache=rms_cache,
        ffmpeg=ffmpeg_pair.ffmpeg if ffmpeg_pair else None,
    )
    src_iv = vad_speech_intervals(
        source_path,
        start_sec=src_file,
        duration_sec=window_duration_sec,
        rms_cache=rms_cache,
        ffmpeg=ffmpeg_pair.ffmpeg if ffmpeg_pair else None,
    )
    if not ref_iv or not src_iv:
        return 0.0
    result = offset_turn_taking_score(
        ref_iv,
        src_iv,
        max_offset_sec=max_offset_sec,
        step_sec=step_sec,
    )
    return result.offset_sec


def check_drift(
    reference_path: Path,
    source_path: Path,
    *,
    session_start_reference: float,
    session_start_source: float,
    window_duration_sec: float = 60.0,
    window_a_start: float = 0.0,
    window_b_start: float = 240.0,
    max_offset_sec: float = 60.0,
    rms_cache: VADWindowRMSCache | None = None,
    ffmpeg_pair: FFmpegPair | None = None,
) -> DriftReport:
    eng = FFmpegEngine(_admitted_pair=ffmpeg_pair) if ffmpeg_pair else FFmpegEngine()
    min_duration = min(
        eng.probe(reference_path).duration_sec,
        eng.probe(source_path).duration_sec,
    )
    off_a = sweep_content_offset(
        reference_path,
        source_path,
        session_start_reference=session_start_reference,
        session_start_source=session_start_source,
        window_start_sec=window_a_start,
        window_duration_sec=window_duration_sec,
        max_offset_sec=max_offset_sec,
        rms_cache=rms_cache,
        ffmpeg_pair=ffmpeg_pair,
    )
    if window_b_start + window_duration_sec > min_duration:
        return DriftReport(
            offset_window_a=off_a,
            offset_window_b=off_a,
            drift_sec=0.0,
            warning=None,
        )
    off_b = sweep_content_offset(
        reference_path,
        source_path,
        session_start_reference=session_start_reference,
        session_start_source=session_start_source,
        window_start_sec=window_b_start,
        window_duration_sec=window_duration_sec,
        max_offset_sec=max_offset_sec,
        rms_cache=rms_cache,
        ffmpeg_pair=ffmpeg_pair,
    )
    drift = abs(off_b - off_a)
    warning = None
    if drift > 3.0:
        warning = (
            f"content align differs by {drift:.1f}s between windows "
            f"({window_a_start}s vs {window_b_start}s); single global offset may not fit"
        )
    return DriftReport(
        offset_window_a=off_a,
        offset_window_b=off_b,
        drift_sec=drift,
        warning=warning,
    )


def render_comparison_waveforms(
    tracks: list[tuple[str, Path, float]],
    output_dir: Path,
    *,
    window_start_sec: float,
    window_duration_sec: float,
    stack_name: str = "alignment_stack.png",
    colors: list[str] | None = None,
    engine: FFmpegEngine | None = None,
) -> WaveformRenderResult:
    """Render per-speaker showwavespic PNGs and a vertical stack for the same session window.

    Each track is ``(label, source_path, file_start_sec)`` where ``file_start_sec`` is the
    file time for session time 0. It may be negative when the track starts after session 0;
    the window head is then padded with silence.
    """
    eng = engine or FFmpegEngine()
    output_dir.mkdir(parents=True, exist_ok=True)
    default_colors = ["0x4a9eff", "0xe67e22", "0x2ecc71", "0x9b59b6"]
    palette = colors or default_colors
    per: dict[str, Path] = {}
    tmp_windows: list[Path] = []
    try:
        for i, (label, src, file_start) in enumerate(tracks):
            safe = "".join(c if c.isalnum() else "_" for c in label) or f"spk{i}"
            window_wav = output_dir / f".window_{safe}.wav"
            out_png = output_dir / f"{safe}.png"
            trim = file_time_for_session(file_start, window_start_sec, 0.0)
            if trim < 0:
                # Track starts later on the session clock: silence before its audio.
                lead = min(-trim, max(0.0, window_duration_sec - 0.01))
                eng.render_timeline(
                    window_wav,
                    MixAudio(At(lead, SourceAudio(src, 0.0, window_duration_sec - lead)), ()),
                    "anull",
                )
            else:
                eng.extract_segment(
                    src,
                    window_wav,
                    trim,
                    trim + window_duration_sec,
                )
            tmp_windows.append(window_wav)
            color = palette[i % len(palette)]
            eng.render_showwavespic(
                window_wav,
                out_png,
                colors=color,
            )
            per[label] = out_png

        stack_path = None
        if len(tmp_windows) >= 2:
            stack_path = output_dir / stack_name
            eng.render_stacked_showwavespic(
                tmp_windows,
                stack_path,
                colors=palette[: len(tmp_windows)],
            )
        elif len(tmp_windows) == 1:
            stack_path = next(iter(per.values()))

        return WaveformRenderResult(per_speaker=per, stack_path=stack_path)
    finally:
        for p in tmp_windows:
            p.unlink(missing_ok=True)
