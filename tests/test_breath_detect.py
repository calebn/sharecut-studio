from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from podcast_mcp.edits.breath_detect import (
    _find_breath_in_window,
    _find_breath_in_window_silero,
    _frame_rms,
)


def test_find_breath_trailing_active_cluster():
    samples = np.concatenate(
        [
            np.full(100, 0.001, dtype=np.float32),
            np.full(200, 0.03, dtype=np.float32),
        ]
    )
    hit = _find_breath_in_window(
        samples,
        0.0,
        sample_rate=100,
        noise_floor=0.002,
        speech_rms=0.2,
        min_duration_sec=0.5,
        max_duration_sec=3.0,
    )
    assert hit is not None


def test_frame_rms_empty_chunk():
    assert _frame_rms(np.zeros(5, dtype=np.float32), 10, 10) == 0.0


def test_find_breath_rejects_tiny_buffers():
    hit = _find_breath_in_window(
        np.zeros(2, dtype=np.float32),
        0.0,
        sample_rate=100,
        noise_floor=0.002,
        speech_rms=0.2,
        min_duration_sec=0.08,
        max_duration_sec=0.45,
    )
    assert hit is None


def test_detect_adjacent_breath_missing_track():
    from podcast_mcp.edits.breath_detect import detect_adjacent_breath
    from podcast_mcp.models import EpisodeProject

    project = EpisodeProject.create("empty", "/tmp/ws")
    assert detect_adjacent_breath(project, "host", 1.0, 1.2) == []


def test_extend_cut_reverts_when_extension_invalid():
    from podcast_mcp.edits.breath_detect import BreathSpan, extend_cut_for_breaths

    start, end = extend_cut_for_breaths(
        5.0,
        5.001,
        [BreathSpan(start=5.0, end=5.0005, side="detected")],
    )
    assert start == 5.0
    assert end == 5.001


def test_find_breath_in_window_detects_mid_energy_blob():
    sample_rate = 100
    duration = 1.0
    n = int(sample_rate * duration)
    samples = np.full(n, 0.001, dtype=np.float32)
    breath_start = int(0.2 * sample_rate)
    breath_end = int(0.35 * sample_rate)
    samples[breath_start:breath_end] = 0.04

    hit = _find_breath_in_window(
        samples,
        0.0,
        sample_rate=sample_rate,
        noise_floor=0.002,
        speech_rms=0.2,
        min_duration_sec=0.08,
        max_duration_sec=0.45,
    )
    assert hit is not None
    assert hit.start < 0.25
    assert hit.end > 0.3


def test_find_breath_in_window_rejects_silence_only():
    samples = np.full(200, 0.0005, dtype=np.float32)
    hit = _find_breath_in_window(
        samples,
        0.0,
        sample_rate=100,
        noise_floor=0.002,
        speech_rms=0.2,
        min_duration_sec=0.08,
        max_duration_sec=0.45,
    )
    assert hit is None


def test_detect_adjacent_breath_finds_before_and_after():
    from podcast_mcp.edits.breath_detect import detect_adjacent_breath
    from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole

    project = EpisodeProject.create("breath", "/tmp/ws")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/host.wav", duration_sec=30.0),
        )
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=30.0,
            timeline_start=0.0,
        )
    ]

    def fake_window(path, start_sec, duration_sec, sample_rate=16000):
        n = max(8, int(duration_sec * sample_rate))
        samples = np.full(n, 0.001, dtype=np.float32)
        mid = n // 2
        samples[mid - 1600 : mid + 1600] = 0.03
        return samples

    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=fake_window,
    ):
        spans = detect_adjacent_breath(project, "host", 5.0, 5.2)
    assert len(spans) >= 1


def test_extend_cut_overlapping_inside_range():
    from podcast_mcp.edits.breath_detect import BreathSpan, extend_cut_for_breaths

    start, end = extend_cut_for_breaths(
        1.0,
        1.5,
        [BreathSpan(start=1.1, end=1.2, side="detected")],
    )
    assert start == 1.0
    assert end == 1.5


def test_extend_cut_for_after_breath():
    from podcast_mcp.edits.breath_detect import BreathSpan, extend_cut_for_breaths

    _start, end = extend_cut_for_breaths(
        1.0,
        1.2,
        [BreathSpan(start=1.2, end=1.35, side="after")],
    )
    assert end == pytest.approx(1.35)


def test_extend_cut_overlapping_breath():
    from podcast_mcp.edits.breath_detect import BreathSpan, extend_cut_for_breaths

    start, end = extend_cut_for_breaths(
        1.0,
        1.3,
        [BreathSpan(start=1.1, end=1.25, side="detected")],
    )
    assert start == pytest.approx(1.0)
    assert end == pytest.approx(1.3)


def _fake_silero_vad(probs: list[float]) -> MagicMock:
    vad = MagicMock()
    vad.speech_probs.return_value = np.array(probs, dtype=np.float32)
    vad.WINDOW_SAMPLES = 512
    vad.SAMPLE_RATE = 16000
    return vad


def test_find_breath_in_window_silero_detects_mid_probability_dip():
    # 32ms/window: 0.9 (speech), 0.2/0.2 (breath, 64ms), 0.9 (speech)
    probs = [0.9, 0.2, 0.2, 0.9]
    vad = _fake_silero_vad(probs)
    with patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=vad):
        hit = _find_breath_in_window_silero(
            np.zeros(2048, dtype=np.float32),
            10.0,
            min_duration_sec=0.05,
            max_duration_sec=0.2,
        )
    assert hit is not None
    assert hit.start == pytest.approx(10.0 + 512 / 16000)
    assert hit.end == pytest.approx(10.0 + 3 * 512 / 16000)


def test_find_breath_in_window_silero_returns_none_without_shared_vad():
    with patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=None):
        hit = _find_breath_in_window_silero(
            np.zeros(2048, dtype=np.float32),
            0.0,
            min_duration_sec=0.05,
            max_duration_sec=0.2,
        )
    assert hit is None


def test_find_breath_in_window_silero_returns_none_for_empty_probs():
    vad = _fake_silero_vad([])
    with patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=vad):
        hit = _find_breath_in_window_silero(
            np.zeros(2048, dtype=np.float32),
            0.0,
            min_duration_sec=0.05,
            max_duration_sec=0.2,
        )
    assert hit is None


def test_find_breath_in_window_silero_rejects_dip_outside_duration_bounds():
    # Dip is only one 32ms window -- too short for a 50-200ms breath window.
    probs = [0.9, 0.2, 0.9]
    vad = _fake_silero_vad(probs)
    with patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=vad):
        hit = _find_breath_in_window_silero(
            np.zeros(1536, dtype=np.float32),
            0.0,
            min_duration_sec=0.05,
            max_duration_sec=0.2,
        )
    assert hit is None


def test_detect_adjacent_breath_uses_silero_backend_when_configured():
    from podcast_mcp.edits.breath_detect import detect_adjacent_breath
    from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole

    project = EpisodeProject.create("breath", "/tmp/ws")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/host.wav", duration_sec=30.0),
        )
    ]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=30.0, timeline_start=0.0)
    ]
    defaults = {"tighten": {"breath_handling": {"vad_backend": "silero"}}}

    with (
        patch(
            "podcast_mcp.edits.breath_detect.load_mono_window",
            return_value=np.zeros(16000, dtype=np.float32),
        ),
        patch("podcast_mcp.engines.vad_silero.is_available", return_value=True),
        patch("podcast_mcp.edits.breath_detect._find_breath_in_window_silero") as mock_silero,
        patch("podcast_mcp.edits.breath_detect._find_breath_in_window") as mock_heuristic,
    ):
        mock_silero.return_value = None
        detect_adjacent_breath(project, "host", 5.0, 5.2, defaults=defaults)

    assert mock_silero.called
    mock_heuristic.assert_not_called()


def test_detect_adjacent_breath_falls_back_to_heuristic_when_silero_unavailable():
    from podcast_mcp.edits.breath_detect import detect_adjacent_breath
    from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole

    project = EpisodeProject.create("breath", "/tmp/ws")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/host.wav", duration_sec=30.0),
        )
    ]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=30.0, timeline_start=0.0)
    ]
    defaults = {"tighten": {"breath_handling": {"vad_backend": "silero"}}}

    with (
        patch(
            "podcast_mcp.edits.breath_detect.load_mono_window",
            return_value=np.zeros(16000, dtype=np.float32),
        ),
        patch("podcast_mcp.engines.vad_silero.is_available", return_value=False),
        patch("podcast_mcp.edits.breath_detect._find_breath_in_window_silero") as mock_silero,
        patch(
            "podcast_mcp.edits.breath_detect._find_breath_in_window",
            return_value=None,
        ) as mock_heuristic,
    ):
        detect_adjacent_breath(project, "host", 5.0, 5.2, defaults=defaults)

    mock_silero.assert_not_called()
    assert mock_heuristic.called


def test_detect_adjacent_breath_falls_back_to_heuristic_for_non_16k_sample_rate():
    from podcast_mcp.edits.breath_detect import detect_adjacent_breath
    from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole

    project = EpisodeProject.create("breath", "/tmp/ws")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/host.wav", duration_sec=30.0),
        )
    ]
    project.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=30.0, timeline_start=0.0)
    ]
    defaults = {"tighten": {"breath_handling": {"vad_backend": "silero"}}}

    with (
        patch(
            "podcast_mcp.edits.breath_detect.load_mono_window",
            return_value=np.zeros(8000, dtype=np.float32),
        ),
        patch("podcast_mcp.engines.vad_silero.is_available", return_value=True),
        patch("podcast_mcp.edits.breath_detect._find_breath_in_window_silero") as mock_silero,
        patch(
            "podcast_mcp.edits.breath_detect._find_breath_in_window",
            return_value=None,
        ) as mock_heuristic,
    ):
        detect_adjacent_breath(project, "host", 5.0, 5.2, defaults=defaults, sample_rate=8000)

    mock_silero.assert_not_called()
    assert mock_heuristic.called
