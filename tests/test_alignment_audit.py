from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from podcast_mcp.engines.align import AudioWindowUnavailableError
from podcast_mcp.engines.alignment_audit import (
    VADWindowRMSCache,
    render_comparison_waveforms,
    score_session_start_candidate,
    simultaneous_speech_sec,
    sweep_content_offset,
    sweep_session_starts,
    vad_speech_intervals,
)
from podcast_mcp.engines.audio import At, MixAudio, SourceAudio
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


def test_vad_window_rms_cache_reuses_only_identical_successful_windows(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "source.aac"
    source.write_bytes(b"fixture")
    calls: list[tuple[float, float, int]] = []

    def load_window(_path, *, start_sec, duration_sec, sample_rate, **_kwargs):
        calls.append((start_sec, duration_sec, sample_rate))
        chunk = round(start_sec / 0.25)
        return np.full(4, 0.03 if chunk in {0, 3, 4} else 0.0, dtype=np.float32)

    monkeypatch.setattr("podcast_mcp.engines.alignment_audit.load_mono_window", load_window)
    cache = VADWindowRMSCache()

    first_uncached = vad_speech_intervals(
        source, start_sec=0.0, duration_sec=1.0, rms_threshold=0.01
    )
    second_uncached = vad_speech_intervals(
        source, start_sec=0.5, duration_sec=1.0, rms_threshold=0.01
    )
    uncached_calls = len(calls)
    calls.clear()

    first_cached = vad_speech_intervals(
        source, start_sec=0.0, duration_sec=1.0, rms_threshold=0.01, rms_cache=cache
    )
    second_cached = vad_speech_intervals(
        source, start_sec=0.5, duration_sec=1.0, rms_threshold=0.01, rms_cache=cache
    )
    assert first_cached == [(0.0, 0.25), (0.75, 1.0)]
    assert second_cached == [(0.75, 1.25)]
    assert (first_cached, second_cached) == (first_uncached, second_uncached)
    assert uncached_calls == 8
    assert len(calls) == 6


def test_vad_rms_cache_does_not_cache_unavailable_and_preserves_empty_windows(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "source.aac"
    source.write_bytes(b"fixture")
    calls = 0

    def unavailable(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        raise AudioWindowUnavailableError("past EOF")

    monkeypatch.setattr("podcast_mcp.engines.alignment_audit.load_mono_window", unavailable)
    cache = VADWindowRMSCache()
    assert (
        vad_speech_intervals(source, duration_sec=0.25, rms_threshold=0.01, rms_cache=cache) == []
    )
    assert (
        vad_speech_intervals(source, duration_sec=0.25, rms_threshold=0.01, rms_cache=cache) == []
    )
    assert calls == 2

    empty_calls = 0

    def empty_window(*_args, **_kwargs):
        nonlocal empty_calls
        empty_calls += 1
        return np.array([], dtype=np.float32)

    monkeypatch.setattr("podcast_mcp.engines.alignment_audit.load_mono_window", empty_window)
    assert (
        vad_speech_intervals(source, duration_sec=0.25, rms_threshold=-1.0, rms_cache=cache) == []
    )
    assert (
        vad_speech_intervals(source, duration_sec=0.25, rms_threshold=-1.0, rms_cache=cache) == []
    )
    assert empty_calls == 1


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
        side_effect=[speech, speech, AudioWindowUnavailableError("no audio decoded")],
    ) as load_window:
        intervals = vad_speech_intervals(sample_wav, duration_sec=90.0, rms_threshold=0.5)

    assert intervals == [(0.0, 0.5)]
    assert load_window.call_count == 3


def test_vad_speech_intervals_bridges_one_quiet_chunk_only(sample_wav: Path):
    """A single quiet chunk joins runs; two quiet chunks split them."""
    loud = np.ones(2000, dtype=np.float32)
    quiet = np.zeros(2000, dtype=np.float32)
    windows = [loud, quiet, loud, quiet, quiet, loud, quiet]
    with patch("podcast_mcp.engines.alignment_audit.load_mono_window", side_effect=windows):
        intervals = vad_speech_intervals(
            sample_wav, start_sec=2.0, duration_sec=1.75, min_run_sec=0.2, rms_threshold=0.5
        )
    assert intervals == [(2.0, 2.75), (3.25, 3.5)]


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


def test_render_comparison_waveforms_pads_late_track(tmp_path: Path) -> None:
    eng = MagicMock()
    ref, late = tmp_path / "ref.wav", tmp_path / "late.wav"
    render_comparison_waveforms(
        [("ref", ref, 0.0), ("late", late, -3.0)],
        tmp_path / "diag",
        window_start_sec=0.0,
        window_duration_sec=5.0,
        engine=eng,
    )
    assert eng.extract_segment.call_args.args[0] == ref
    assert eng.extract_segment.call_args.args[2:] == (0.0, 5.0)
    call = eng.render_timeline.call_args
    assert call.args[1] == MixAudio(At(3.0, SourceAudio(late, 0.0, 2.0)), ())


def test_render_comparison_waveforms_window_before_track_start(tmp_path: Path) -> None:
    eng = MagicMock()
    render_comparison_waveforms(
        [("late", tmp_path / "late.wav", -10.0)],
        tmp_path / "diag",
        window_start_sec=0.0,
        window_duration_sec=5.0,
        engine=eng,
    )
    assert eng.render_timeline.call_args.args[1] == MixAudio(
        At(4.99, SourceAudio(tmp_path / "late.wav", 0.0, pytest.approx(0.01))), ()
    )
    eng.extract_segment.assert_not_called()


def test_vad_speech_intervals_propagates_other_value_errors(sample_wav: Path) -> None:
    with (
        patch(
            "podcast_mcp.engines.alignment_audit.load_mono_window", side_effect=ValueError("boom")
        ),
        pytest.raises(ValueError, match="boom"),
    ):
        vad_speech_intervals(sample_wav, duration_sec=1.0)
