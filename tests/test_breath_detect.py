from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from podcast_mcp.edits.breath_detect import (
    LevelBand,
    _find_breath_in_window,
    _find_breath_in_window_silero,
    _frame_rms,
    breath_level_band,
    level_profile,
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
        band=LevelBand(lo=0.006, hi=0.09),
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
        band=LevelBand(lo=0.006, hi=0.09),
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
        band=LevelBand(lo=0.006, hi=0.09),
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
        band=LevelBand(lo=0.006, hi=0.09),
        min_duration_sec=0.08,
        max_duration_sec=0.45,
    )
    assert hit is None


def test_find_breath_in_window_returns_first_qualifying_run():
    samples = np.full(30, 0.001, dtype=np.float32)
    samples[2:3] = 0.03  # Too short.
    samples[5:8] = 0.03
    samples[11:15] = 0.03
    hit = _find_breath_in_window(
        samples,
        4.0,
        sample_rate=100,
        band=LevelBand(lo=0.006, hi=0.09),
        min_duration_sec=0.02,
        max_duration_sec=0.04,
    )
    assert hit is not None
    assert (hit.start, hit.end) == pytest.approx((4.05, 4.08))


def test_detect_adjacent_breath_finds_before_and_after():
    from podcast_mcp.edits.breath_detect import BreathSpan, detect_adjacent_breath

    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(
            before=_shaped_noise(2560, 0.026), after=_shaped_noise(2560, 0.026)
        ),
    ):
        spans = detect_adjacent_breath(_host_project(), "host", 5.0, 5.2)

    assert spans == [
        BreathSpan(start=pytest.approx(4.7), end=pytest.approx(4.86), side="before"),
        BreathSpan(start=pytest.approx(5.23), end=pytest.approx(5.39), side="after"),
    ]


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


def test_find_breath_in_window_silero_returns_first_qualifying_run():
    vad = _fake_silero_vad([0.2, 0.9, 0.2, 0.2, 0.9, 0.2, 0.2])
    with patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=vad):
        hit = _find_breath_in_window_silero(
            np.zeros(3584, dtype=np.float32),
            4.0,
            min_duration_sec=0.05,
            max_duration_sec=0.08,
        )
    assert hit is not None
    assert (hit.start, hit.end) == pytest.approx((4.064, 4.128))


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
            side_effect=_fake_windows(),
        ),
        patch("podcast_mcp.engines.vad_silero.is_available", return_value=True),
        patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=MagicMock()),
        patch("podcast_mcp.edits.breath_detect._find_breath_in_window_silero") as mock_silero,
        patch("podcast_mcp.edits.breath_detect._find_breath_in_window") as mock_heuristic,
    ):
        mock_silero.return_value = None
        detect_adjacent_breath(project, "host", 5.0, 5.2, defaults=defaults)

    assert mock_silero.called
    mock_heuristic.assert_not_called()


def test_sample_classifier_falls_back_when_shared_silero_model_fails() -> None:
    from podcast_mcp.edits.breath_detect import classify_breath_samples

    with (
        patch("podcast_mcp.engines.vad_silero.is_available", return_value=True),
        patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=None),
        patch("podcast_mcp.edits.breath_detect._find_breath_in_window_silero") as silero,
        patch("podcast_mcp.edits.breath_detect._find_breath_in_window") as heuristic,
    ):
        classify_breath_samples(
            np.zeros(1600, dtype=np.float32),
            1.0,
            sample_rate=16000,
            vad_backend="silero",
            speech_reference_rms=0.1,
            noise_floor_rms=0.001,
        )

    silero.assert_not_called()
    heuristic.assert_called_once()


def test_sample_classifier_does_not_fallback_after_valid_silero_no_breath() -> None:
    from podcast_mcp.edits.breath_detect import classify_breath_samples

    with (
        patch("podcast_mcp.engines.vad_silero.is_available", return_value=True),
        patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=MagicMock()),
        patch("podcast_mcp.edits.breath_detect._find_breath_in_window_silero", return_value=None),
        patch("podcast_mcp.edits.breath_detect._find_breath_in_window") as heuristic,
    ):
        result = classify_breath_samples(
            np.zeros(1600, dtype=np.float32), 1.0, sample_rate=16000, vad_backend="silero"
        )

    assert result is None
    heuristic.assert_not_called()


def test_sample_classifier_looks_up_silero_once_and_falls_back_on_inference_error() -> None:
    from podcast_mcp.edits.breath_detect import classify_breath_samples

    vad = _fake_silero_vad([])
    vad.speech_probs.side_effect = RuntimeError("inference failed")
    with (
        patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=vad) as lookup,
        patch("podcast_mcp.edits.breath_detect._find_breath_in_window") as heuristic,
    ):
        classify_breath_samples(
            np.zeros(1600, dtype=np.float32),
            1.0,
            sample_rate=16000,
            vad_backend="silero",
            speech_reference_rms=0.1,
            noise_floor_rms=0.001,
        )

    lookup.assert_called_once()
    heuristic.assert_called_once()


def test_explicit_empty_defaults_do_not_reload_configuration() -> None:
    from podcast_mcp.edits.breath_detect import classify_breath_samples

    with patch("podcast_mcp.edits.breath_detect.load_defaults", side_effect=AssertionError):
        classify_breath_samples(
            np.zeros(1600, dtype=np.float32), 1.0, sample_rate=16000, defaults={}
        )


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
            side_effect=_fake_windows(),
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
            side_effect=_fake_windows(),
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


def _host_project(words: list[tuple[str, float, float]] = ()):
    from podcast_mcp.models import (
        Clip,
        EpisodeProject,
        MediaAsset,
        Track,
        TrackRole,
        Transcript,
        TranscriptWord,
    )

    project = EpisodeProject.create("breath", "/tmp/ws")
    if words:
        project.transcripts = [
            Transcript(
                track_id="host",
                words=[
                    TranscriptWord(text=text, start=start, end=end) for text, start, end in words
                ],
            )
        ]
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
    return project


def _dbfs(level_db: float) -> float:
    return float(10 ** (level_db / 20))


# The fixture track: -70 dBFS room tone between -15 dBFS words, like caleb's lab tape.
_FLOOR_RMS = _dbfs(-70.0)
_SPEECH_RMS = _dbfs(-15.0)


def _constant_envelope(x: np.ndarray, rms: float, frame: int = 160) -> np.ndarray:
    """Scale each 10 ms frame to exactly ``rms`` so the detector's level band sees a flat run."""
    out = np.empty(x.size, dtype=np.float32)
    for start in range(0, x.size, frame):
        chunk = x[start : start + frame]
        out[start : start + frame] = rms * chunk / np.sqrt(np.mean(chunk**2))
    return out


def _harmonic_tone(n: int, rms: float, hz: float = 140.0, sample_rate: int = 16000) -> np.ndarray:
    t = np.arange(n) / sample_rate
    tone = sum(np.sin(2 * np.pi * hz * k * t) / k for k in (1, 2, 3))
    return _constant_envelope(tone, rms, sample_rate // 100)


def _shaped_noise(n: int, rms: float, sample_rate: int = 16000) -> np.ndarray:
    """Low-passed noise (8-tap moving average): breath-like, energy below 4 kHz."""
    x = np.random.default_rng(798).normal(0.0, 1.0, n + 7)
    return _constant_envelope(np.convolve(x, np.ones(8) / 8, mode="valid"), rms, sample_rate // 100)


def _sibilant_noise(n: int, rms: float) -> np.ndarray:
    """High-passed noise (first difference): an `s`, energy above 4 kHz."""
    x = np.random.default_rng(798).normal(0.0, 1.0, n + 1)
    return _constant_envelope(np.diff(x), rms)


def _track_signal(gap_floor: float, sample_rate: int) -> np.ndarray:
    """10.2 s around a 5.0-5.2 cut: 300 ms tone words every 500 ms over room tone at
    ``gap_floor`` (0 for a noise-gated track), with only room tone in the 400 ms before
    and the 250 ms after the cut."""
    n = int(10.2 * sample_rate)
    if gap_floor > 0:
        signal = _shaped_noise(n, gap_floor, sample_rate)
    else:
        signal = np.zeros(n, dtype=np.float32)
    word = int(0.3 * sample_rate)
    tone = _harmonic_tone(word, _SPEECH_RMS, sample_rate=sample_rate)
    for start in list(np.arange(0.0, 4.3, 0.5)) + list(np.arange(5.45, 9.9, 0.5)):
        i = round(start * sample_rate)
        signal[i : i + word] = tone
    return signal


def _fake_windows(
    before: np.ndarray | None = None,
    after: np.ndarray | None = None,
    before_tail: np.ndarray | None = None,
    *,
    gap_floor: float = _FLOOR_RMS,
):
    """load_mono_window stand-in over :func:`_track_signal` with frame-aligned blobs.

    ``before`` lands at 4.7 (100 ms into the 400 ms window before the cut) and
    ``before_tail`` ends at the cut; ``after`` lands at 5.23 (30 ms into the 250 ms
    window after it). Blob levels of 0.026 (-31.7 dBFS) sit inside the level band
    the fixture track yields (-55 to -22 dBFS).
    """

    def fake_window(path, start_sec, duration_sec, sample_rate=16000):
        signal = _track_signal(gap_floor, sample_rate)

        def place(blob: np.ndarray, at: float) -> None:
            i = round(at * sample_rate)
            signal[i : i + blob.size] = blob

        if before is not None:
            place(before, 4.7)
        if before_tail is not None:
            place(before_tail, 5.0 - before_tail.size / sample_rate)
        if after is not None:
            place(after, 5.23)
        i = round(start_sec * sample_rate)
        return signal[i : i + round(duration_sec * sample_rate)]

    return fake_window


def test_voiced_tone_after_cut_is_not_a_breath():
    from podcast_mcp.edits.breath_detect import detect_adjacent_breath

    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(after=_harmonic_tone(2560, 0.026)),
    ):
        assert detect_adjacent_breath(_host_project(), "host", 5.0, 5.2) == []


def test_sibilant_noise_after_cut_is_not_a_breath():
    from podcast_mcp.edits.breath_detect import detect_adjacent_breath

    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(after=_sibilant_noise(2560, 0.026)),
    ):
        assert detect_adjacent_breath(_host_project(), "host", 5.0, 5.2) == []


def test_breath_before_cut_needs_unvoiced_audio_up_to_the_cut():
    from podcast_mcp.edits.breath_detect import BreathSpan, detect_adjacent_breath

    breath = _shaped_noise(1600, 0.026)
    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(before=breath, before_tail=_harmonic_tone(1600, 0.026)),
    ):
        assert detect_adjacent_breath(_host_project(), "host", 5.0, 5.2) == []
    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(before=breath),
    ):
        spans = detect_adjacent_breath(_host_project(), "host", 5.0, 5.2)

    assert spans == [BreathSpan(start=pytest.approx(4.7), end=pytest.approx(4.8), side="before")]


def test_breath_before_cut_is_not_extended_across_a_sibilant():
    from podcast_mcp.edits.breath_detect import BreathSpan, detect_adjacent_breath

    breath = _shaped_noise(1600, 0.026)
    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(before=breath, before_tail=_sibilant_noise(1600, 0.026)),
    ):
        assert detect_adjacent_breath(_host_project(), "host", 5.0, 5.2) == []
    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(before=breath, before_tail=_shaped_noise(1600, 0.026)),
    ):
        spans = detect_adjacent_breath(_host_project(), "host", 5.0, 5.2)

    assert spans == [BreathSpan(start=pytest.approx(4.7), end=pytest.approx(4.8), side="before")]


def test_find_breath_in_window_skips_voiced_run_for_later_unvoiced_run():
    samples = np.full(8000, 0.001, dtype=np.float32)
    samples[800:2400] = _harmonic_tone(1600, 0.035)
    samples[3200:4800] = _shaped_noise(1600, 0.035)

    hit = _find_breath_in_window(
        samples,
        2.0,
        sample_rate=16000,
        band=LevelBand(lo=0.006, hi=0.09),
        min_duration_sec=0.08,
        max_duration_sec=0.45,
    )

    assert hit is not None
    assert (hit.start, hit.end) == pytest.approx((2.2, 2.3))


def test_level_profile_reads_floor_and_speech_from_live_frames():
    frames = np.concatenate(
        [
            np.full(40 * 160, 0.001, dtype=np.float32),
            np.full(60 * 160, 0.1, dtype=np.float32),
            np.zeros(200 * 160, dtype=np.float32),
        ]
    )

    assert level_profile(frames, 16000) == pytest.approx((0.001, 0.1))


def test_level_profile_needs_half_a_second_of_live_audio():
    assert level_profile(np.zeros(16000, dtype=np.float32), 16000) is None
    assert level_profile(np.full(int(0.4 * 16000), 0.01, dtype=np.float32), 16000) is None


def test_breath_level_band_sits_between_room_tone_and_speech():
    band = breath_level_band(0.001, 0.1)

    assert band is not None
    assert (band.lo, band.hi) == pytest.approx((0.002985, 0.04467), rel=1e-3)
    assert breath_level_band(0.02, 0.1) is None


def test_quiet_breath_relative_to_the_track_floor_is_found():
    from podcast_mcp.edits.breath_detect import BreathSpan, detect_adjacent_breath

    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(before=_shaped_noise(2560, _dbfs(-48.0))),
    ):
        spans = detect_adjacent_breath(_host_project(), "host", 5.0, 5.2)

    assert spans == [BreathSpan(start=pytest.approx(4.7), end=pytest.approx(4.86), side="before")]


def test_loud_breath_below_the_speech_level_is_found():
    from podcast_mcp.edits.breath_detect import BreathSpan, detect_adjacent_breath

    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(after=_shaped_noise(2560, _dbfs(-26.0))),
    ):
        spans = detect_adjacent_breath(_host_project(), "host", 5.0, 5.2)

    assert spans == [BreathSpan(start=pytest.approx(5.23), end=pytest.approx(5.39), side="after")]


def test_noise_at_speech_level_next_to_the_cut_is_not_a_breath():
    from podcast_mcp.edits.breath_detect import detect_adjacent_breath

    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(after=_shaped_noise(2560, _dbfs(-18.0))),
    ):
        assert detect_adjacent_breath(_host_project(), "host", 5.0, 5.2) == []


def test_gated_digital_silence_around_the_cut_is_not_a_breath():
    from podcast_mcp.edits.breath_detect import detect_adjacent_breath

    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(gap_floor=0.0),
    ):
        assert detect_adjacent_breath(_host_project(), "host", 5.0, 5.2) == []


def test_no_breath_without_live_audio_around_the_cut():
    from podcast_mcp.edits.breath_detect import detect_adjacent_breath

    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        return_value=np.zeros(16000, dtype=np.float32),
    ):
        assert detect_adjacent_breath(_host_project(), "host", 5.0, 5.2) == []


def test_kept_word_next_to_the_cut_is_not_a_breath():
    from podcast_mcp.edits.breath_detect import BreathSpan, detect_adjacent_breath

    tail = _shaped_noise(4800, _dbfs(-30.0))
    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(before_tail=tail),
    ):
        assert detect_adjacent_breath(_host_project([("she", 4.7, 5.0)]), "host", 5.0, 5.2) == []
        spans = detect_adjacent_breath(_host_project(), "host", 5.0, 5.2)

    assert spans == [BreathSpan(start=pytest.approx(4.7), end=pytest.approx(5.0), side="before")]


def test_word_the_cut_removes_does_not_block_its_breath():
    from podcast_mcp.edits.breath_detect import BreathSpan, detect_adjacent_breath

    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(before=_shaped_noise(2560, 0.026)),
    ):
        spans = detect_adjacent_breath(_host_project([("um", 4.98, 5.2)]), "host", 5.0, 5.2)

    assert spans == [BreathSpan(start=pytest.approx(4.7), end=pytest.approx(4.86), side="before")]


def test_voicing_is_assessed_only_where_the_level_could_be_speech():
    from podcast_mcp.edits.breath_detect import BreathSpan, detect_adjacent_breath

    breath = _shaped_noise(1600, 0.026)
    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(
            before=breath, before_tail=_harmonic_tone(3200, _dbfs(-60.0), hz=120.0)
        ),
    ):
        spans = detect_adjacent_breath(_host_project(), "host", 5.0, 5.2)
    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(
            before=breath, before_tail=_harmonic_tone(3200, _dbfs(-30.0), hz=120.0)
        ),
    ):
        assert detect_adjacent_breath(_host_project(), "host", 5.0, 5.2) == []

    assert spans == [BreathSpan(start=pytest.approx(4.7), end=pytest.approx(4.8), side="before")]
