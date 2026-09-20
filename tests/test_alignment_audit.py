from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

import numpy as np

from podcast_mcp.engines.alignment_audit import (
    render_comparison_waveforms,
    score_session_start_candidate,
    simultaneous_speech_sec,
    sweep_content_offset,
    sweep_session_starts,
    vad_speech_intervals,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine


def _tone_with_speech_burst(
    out: Path,
    *,
    silence_sec: float,
    tone_sec: float,
    total_sec: float = 3.0,
) -> None:
    """Mono WAV: silence then loud tone (acts as 'speech' for energy VAD)."""
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"anullsrc=r=8000:cl=mono:d={silence_sec}",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency=800:duration={tone_sec}",
        "-f",
        "lavfi",
        "-i",
        f"anullsrc=r=8000:cl=mono:d={max(0.0, total_sec - silence_sec - tone_sec)}",
        "-filter_complex",
        "[0:a][1:a][2:a]concat=n=3:v=0:a=1",
        str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _delayed_copy(src: Path, dst: Path, delay_sec: float) -> None:
    ms = int(delay_sec * 1000)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-af",
        f"adelay={ms}|{ms}",
        str(dst),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def test_vad_and_overlap_metric(tmp_path: Path) -> None:
    ref = tmp_path / "ref.wav"
    src = tmp_path / "src.wav"
    _tone_with_speech_burst(ref, silence_sec=0.2, tone_sec=0.4)
    _tone_with_speech_burst(src, silence_sec=0.7, tone_sec=0.4)
    ref_iv = vad_speech_intervals(ref, start_sec=0.0, duration_sec=2.0, rms_threshold=0.01)
    src_iv = vad_speech_intervals(src, start_sec=0.0, duration_sec=2.0, rms_threshold=0.01)
    overlap_aligned = simultaneous_speech_sec(ref_iv, src_iv, shift_b_sec=0.0)
    overlap_shifted = simultaneous_speech_sec(ref_iv, src_iv, shift_b_sec=0.5)
    assert overlap_shifted < overlap_aligned


def test_sweep_session_start_recovers_delay(tmp_path: Path) -> None:
    ref = tmp_path / "ref.wav"
    late = tmp_path / "late.wav"
    base = tmp_path / "base.wav"
    _tone_with_speech_burst(ref, silence_sec=0.1, tone_sec=0.5)
    _tone_with_speech_burst(base, silence_sec=0.1, tone_sec=0.5)
    _delayed_copy(base, late, 0.5)

    candidates = [round(x * 0.1, 1) for x in range(0, 11)]
    scored = sweep_session_starts(
        ref,
        late,
        candidates,
        window_start_sec=0.0,
        window_duration_sec=1.5,
    )
    best = scored[0]
    at_zero = next(s for s in scored if s.session_start_in_file_sec == 0.0)
    assert best.simultaneous_speech_sec < at_zero.simultaneous_speech_sec
    assert best.session_start_in_file_sec >= 0.3


def test_sweep_content_offset(tmp_path: Path) -> None:
    ref = tmp_path / "ref.wav"
    late = tmp_path / "late.wav"
    _tone_with_speech_burst(ref, silence_sec=0.0, tone_sec=0.3)
    base = tmp_path / "base.wav"
    _tone_with_speech_burst(base, silence_sec=0.2, tone_sec=0.3)
    _delayed_copy(base, late, 0.2)
    off = sweep_content_offset(
        ref,
        late,
        session_start_reference=0.0,
        session_start_source=0.2,
        window_start_sec=0.0,
        window_duration_sec=1.0,
        max_offset_sec=1.0,
        step_sec=0.1,
    )
    assert abs(off) <= 0.5


def test_render_comparison_waveforms_writes_png(tmp_path: Path) -> None:
    ref = tmp_path / "ref.wav"
    src = tmp_path / "src.wav"
    _tone_with_speech_burst(ref, silence_sec=0.0, tone_sec=0.4)
    _tone_with_speech_burst(src, silence_sec=0.1, tone_sec=0.4)
    out_dir = tmp_path / "diag"
    result = render_comparison_waveforms(
        [("ref", ref, 0.0), ("src", src, 0.0)],
        out_dir,
        window_start_sec=0.0,
        window_duration_sec=0.8,
    )
    assert result.stack_path and result.stack_path.is_file()
    assert result.stack_path.stat().st_size > 500
    for p in result.per_speaker.values():
        assert p.is_file()


def test_ffmpeg_showwavespic(sample_wav: Path, tmp_path: Path) -> None:
    png = tmp_path / "wave.png"
    FFmpegEngine().render_showwavespic(sample_wav, png)
    assert png.is_file() and png.stat().st_size > 200


def test_vad_speech_intervals_edge_cases(sample_wav: Path):
    assert vad_speech_intervals(sample_wav, start_sec=0.0, duration_sec=0.0) == []
    with patch(
        "podcast_mcp.engines.alignment_audit.load_mono_window",
        return_value=__import__("numpy").zeros(0),
    ):
        assert vad_speech_intervals(sample_wav, start_sec=0.0, duration_sec=1.0) == []


def test_vad_speech_intervals_stops_at_past_eof_and_keeps_prior_speech(sample_wav: Path):
    """#146: past EOF stops decoding without losing earlier speech."""
    speech = np.ones(2000, dtype=np.float32)
    with patch(
        "podcast_mcp.engines.alignment_audit.load_mono_window",
        side_effect=[speech, speech, ValueError("no audio decoded")],
    ) as load_window:
        intervals = vad_speech_intervals(sample_wav, duration_sec=90.0)

    assert intervals == [(0.0, 0.5)]
    assert load_window.call_count == 3


def test_score_session_start_handles_estimate_failure(sample_wav: Path):
    with patch(
        "podcast_mcp.engines.align.estimate_offset_sec",
        side_effect=ValueError("bad"),
    ):
        score = score_session_start_candidate(
            sample_wav,
            sample_wav,
            session_start_source=0.0,
            window_duration_sec=0.5,
        )
    assert score.correlation_peak is None
