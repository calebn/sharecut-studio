from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from podcast_mcp.edits.audio_cache import level_profile
from podcast_mcp.edits.breath_detect import (
    LevelBand,
    _find_breath_in_window,
    _find_breath_in_window_silero,
    _frame_rms,
    breath_level_band,
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


def test_adjacent_silero_abstains_when_level_band_cannot_be_formed() -> None:
    from podcast_mcp.edits.breath_detect import BreathSpan, classify_breath_samples

    with (
        patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=MagicMock()),
        patch(
            "podcast_mcp.edits.breath_detect._find_breath_in_window_silero",
            return_value=BreathSpan(start=1.0, end=1.1, side="detected"),
        ) as silero,
    ):
        result = classify_breath_samples(
            np.zeros(1600, dtype=np.float32),
            1.0,
            sample_rate=16000,
            vad_backend="silero",
            speech_reference_rms=0.001,
            noise_floor_rms=0.001,
            cut_edge="end",
        )

    assert result is None
    silero.assert_not_called()


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


def _bandpass_noise(n: int, rms: float, lo_hz: float, hi_hz: float) -> np.ndarray:
    """Noise confined to ``[lo_hz, hi_hz]``: a `sh` at 2-3.5 kHz sits under the 4 kHz split."""
    spectrum = np.fft.rfft(np.random.default_rng(814).normal(0.0, 1.0, n))
    freqs = np.fft.rfftfreq(n, d=1 / 16000)
    spectrum[(freqs < lo_hz) | (freqs > hi_hz)] = 0.0
    return _constant_envelope(np.fft.irfft(spectrum, n), rms)


def _vocal_fry(n: int, rms: float, pulse_hz: float = 45.0) -> np.ndarray:
    """Glottal pulses every 22 ms, the loudest 10 ms frame at ``rms``: creaky speech the
    70-350 Hz pitch probe scores below 0.4, with in-band frames between the pulses."""
    pulses = np.zeros(n)
    pulses[:: round(16000 / pulse_hz)] = 1.0
    burst = np.exp(-np.arange(48) / 8.0) * np.sin(2 * np.pi * 900.0 * np.arange(48) / 16000)
    fry = np.convolve(pulses, burst)[:n]
    frames = fry[: n - n % 160].reshape(-1, 160)
    return (fry * rms / np.sqrt(np.mean(frames**2, axis=1)).max()).astype(np.float32)


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
    placed: tuple[tuple[np.ndarray, float], ...] = (),
):
    """load_mono_window stand-in over :func:`_track_signal` with frame-aligned blobs.

    ``before`` lands at 4.7 (100 ms into the 400 ms window before the cut) and
    ``before_tail`` ends at the cut; ``after`` lands at 5.23 (30 ms into the 250 ms
    window after it); ``placed`` blobs land at their own times. Blob levels of 0.026
    (-31.7 dBFS) sit inside the level band the fixture track yields (-55 to -22 dBFS).
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
        for blob, at in placed:
            place(blob, at)
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


def test_level_profile_of_a_whole_track_reads_it_a_minute_at_a_time():
    from podcast_mcp.util.dsp import frame_rms_db

    # 150 s: three chunks, the last one partial.
    rng = np.random.default_rng(4)
    samples = rng.standard_normal(150 * 16000) * np.repeat(rng.uniform(0.001, 0.2, 1500), 1600)
    levels = frame_rms_db(samples.astype(np.float32), 160, 160)

    floor, speech = level_profile(samples.astype(np.float32), 16000)

    assert 20 * np.log10([floor, speech]) == pytest.approx(np.percentile(levels, (10, 90)))


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


def test_vocal_fry_between_breath_and_cut_is_not_a_breath():
    from podcast_mcp.edits.breath_detect import BreathSpan, detect_adjacent_breath

    breath = _shaped_noise(1600, 0.026)
    fry = _vocal_fry(3200, _dbfs(-17.0))
    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(before=breath, before_tail=fry),
    ):
        assert detect_adjacent_breath(_host_project(), "host", 5.0, 5.2) == []
    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(before=breath),
    ):
        spans = detect_adjacent_breath(_host_project(), "host", 5.0, 5.2)

    assert spans == [BreathSpan(start=pytest.approx(4.7), end=pytest.approx(4.8), side="before")]


def test_kept_word_decay_tail_is_not_a_breath():
    from podcast_mcp.edits.breath_detect import BreathSpan, detect_adjacent_breath

    word = _harmonic_tone(3200, _SPEECH_RMS)
    decay = _shaped_noise(2400, _dbfs(-35.0))
    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(placed=((word, 4.5), (decay, 4.7))),
    ):
        assert detect_adjacent_breath(_host_project([("she", 4.5, 4.7)]), "host", 5.0, 5.2) == []
    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(placed=((word[:1600], 4.5), (decay, 4.7))),
    ):
        spans = detect_adjacent_breath(_host_project([("she", 4.5, 4.6)]), "host", 5.0, 5.2)

    assert spans == [BreathSpan(start=pytest.approx(4.7), end=pytest.approx(4.85), side="before")]


def test_fricative_onset_of_the_next_kept_word_is_not_a_breath():
    from podcast_mcp.edits.breath_detect import BreathSpan, detect_adjacent_breath

    onset = _bandpass_noise(2240, _dbfs(-30.0), 2000.0, 3500.0)
    word = _harmonic_tone(3200, _SPEECH_RMS)
    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(placed=((onset, 5.23), (word, 5.37))),
    ):
        assert detect_adjacent_breath(_host_project([("she", 5.37, 5.57)]), "host", 5.0, 5.2) == []
    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(placed=((onset, 5.23), (word, 5.57))),
    ):
        spans = detect_adjacent_breath(_host_project([("she", 5.57, 5.77)]), "host", 5.0, 5.2)

    assert spans == [BreathSpan(start=pytest.approx(5.23), end=pytest.approx(5.37), side="after")]


_SILERO_WINDOW = 512
_SILERO_FRAME_SEC = _SILERO_WINDOW / 16000


def _silero_band() -> LevelBand:
    band = breath_level_band(_FLOOR_RMS, _SPEECH_RMS)
    assert band is not None
    return band


def test_silero_vocal_fry_between_breath_and_cut_is_not_a_breath():
    band = _silero_band()
    breath = _shaped_noise(_SILERO_WINDOW * 3, 0.026)
    fry = _vocal_fry(_SILERO_WINDOW * 6, _dbfs(-17.0))
    vad = _fake_silero_vad([0.3] * 3 + [0.9] * 6)
    hit = _find_breath_in_window_silero(
        np.concatenate([breath, fry]),
        4.7,
        min_duration_sec=0.05,
        max_duration_sec=0.15,
        vad=vad,
        cut_edge="end",
        band=band,
    )
    assert hit is None

    quiet_gap = _shaped_noise(_SILERO_WINDOW * 6, _FLOOR_RMS)
    vad = _fake_silero_vad([0.3] * 3 + [0.9] * 6)
    hit = _find_breath_in_window_silero(
        np.concatenate([breath, quiet_gap]),
        4.7,
        min_duration_sec=0.05,
        max_duration_sec=0.15,
        vad=vad,
        cut_edge="end",
        band=band,
    )
    assert (hit.start, hit.end) == pytest.approx((4.7, 4.7 + 3 * _SILERO_FRAME_SEC))


def test_silero_kept_word_decay_tail_is_not_a_breath():
    band = _silero_band()
    word = _harmonic_tone(_SILERO_WINDOW * 6, _SPEECH_RMS)
    decay = _shaped_noise(_SILERO_WINDOW * 3, _dbfs(-35.0))
    trail = _shaped_noise(_SILERO_WINDOW, _FLOOR_RMS)
    window_start = 4.4
    keep_out = [(window_start, window_start + 6 * _SILERO_FRAME_SEC)]

    vad = _fake_silero_vad([0.9] * 6 + [0.3] * 3 + [0.9])
    hit = _find_breath_in_window_silero(
        np.concatenate([word, decay, trail]),
        window_start,
        min_duration_sec=0.05,
        max_duration_sec=0.15,
        vad=vad,
        cut_edge="end",
        keep_out=keep_out,
        band=band,
    )
    assert hit is None

    floor_gap = _shaped_noise(_SILERO_WINDOW, _FLOOR_RMS)
    vad = _fake_silero_vad([0.9] * 6 + [0.9] + [0.3] * 3 + [0.9])
    hit = _find_breath_in_window_silero(
        np.concatenate([word, floor_gap, decay, trail]),
        window_start,
        min_duration_sec=0.05,
        max_duration_sec=0.15,
        vad=vad,
        cut_edge="end",
        keep_out=keep_out,
        band=band,
    )
    assert (hit.start, hit.end) == pytest.approx(
        (window_start + 7 * _SILERO_FRAME_SEC, window_start + 10 * _SILERO_FRAME_SEC)
    )


def test_silero_fricative_onset_of_the_next_kept_word_is_not_a_breath():
    band = _silero_band()
    lead_gap = _shaped_noise(_SILERO_WINDOW, _FLOOR_RMS)
    onset = _bandpass_noise(_SILERO_WINDOW * 3, _dbfs(-30.0), 2000.0, 3500.0)
    word = _harmonic_tone(_SILERO_WINDOW * 6, _SPEECH_RMS)
    window_start = 5.23
    keep_out = [(window_start + 4 * _SILERO_FRAME_SEC, window_start + 10 * _SILERO_FRAME_SEC)]

    vad = _fake_silero_vad([0.9] + [0.3] * 3 + [0.9] * 6)
    hit = _find_breath_in_window_silero(
        np.concatenate([lead_gap, onset, word]),
        window_start,
        min_duration_sec=0.05,
        max_duration_sec=0.15,
        vad=vad,
        cut_edge="start",
        keep_out=keep_out,
        band=band,
    )
    assert hit is None

    floor_gap = _shaped_noise(_SILERO_WINDOW, _FLOOR_RMS)
    keep_out = [(window_start + 5 * _SILERO_FRAME_SEC, window_start + 11 * _SILERO_FRAME_SEC)]
    vad = _fake_silero_vad([0.9] + [0.3] * 3 + [0.9] + [0.9] * 6)
    hit = _find_breath_in_window_silero(
        np.concatenate([lead_gap, onset, floor_gap, word]),
        window_start,
        min_duration_sec=0.05,
        max_duration_sec=0.15,
        vad=vad,
        cut_edge="start",
        keep_out=keep_out,
        band=band,
    )
    assert (hit.start, hit.end) == pytest.approx(
        (window_start + 1 * _SILERO_FRAME_SEC, window_start + 4 * _SILERO_FRAME_SEC)
    )


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


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
def test_complete_breath_crossing_cut_end_keeps_its_onset(backend: str) -> None:
    from podcast_mcp.edits.breath_detect import classify_breath_samples

    samples = _shaped_noise(16000, _FLOOR_RMS)
    samples[3200:7040] = _shaped_noise(3840, 0.026)
    vad = _fake_silero_vad([0.0] * 6 + [0.2] * 8 + [0.0] * 18)
    with patch("podcast_mcp.engines.vad_silero.get_shared_vad", return_value=vad):
        hit = classify_breath_samples(
            samples,
            4.8,
            sample_rate=16000,
            vad_backend=backend,
            speech_reference_rms=_SPEECH_RMS,
            noise_floor_rms=_FLOOR_RMS,
            cut_edge="start",
            search_sec=(5.15, 5.3),
        )

    assert hit is not None
    assert hit.start == pytest.approx(5.0, abs=0.01)
    assert hit.end == pytest.approx(5.24, abs=0.01)


def test_final_end_protection_reads_before_boundary() -> None:
    from podcast_mcp.edits.breath_detect import protect_cut_breaths

    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(placed=((_shaped_noise(3840, 0.026), 5.1),)),
    ):
        protected = protect_cut_breaths(_host_project(), "host", 5.0, 5.2)
    assert protected == pytest.approx((5.0, 5.1))


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
@pytest.mark.parametrize("protected", ["voiced", "sibilant", "onset", "decay", "long"])
def test_crossing_breath_keeps_speech_protection(backend: str, protected: str) -> None:
    from podcast_mcp.edits.breath_detect import classify_breath_samples

    samples = _shaped_noise(16000, _FLOOR_RMS)
    samples[3200:7040] = _shaped_noise(3840, 0.026)
    keep_out = []
    probs = [0.0] * 6 + [0.2] * 8 + [0.0] * 18
    if protected == "voiced":
        samples[3200:7040] = _harmonic_tone(3840, 0.026)
    elif protected == "sibilant":
        samples[3200:7040] = _sibilant_noise(3840, 0.026)
    elif protected == "onset":
        samples[7040:10240] = _harmonic_tone(3200, _SPEECH_RMS)
        keep_out = [(5.24, 5.44)]
    elif protected == "decay":
        samples[0:3200] = _harmonic_tone(3200, _SPEECH_RMS)
        keep_out = [(4.8, 5.0)]
    else:
        samples[3200:12800] = _shaped_noise(9600, 0.026)
        probs = [0.0] * 6 + [0.2] * 19 + [0.0] * 7

    with patch(
        "podcast_mcp.engines.vad_silero.get_shared_vad", return_value=_fake_silero_vad(probs)
    ):
        hit = classify_breath_samples(
            samples,
            4.8,
            sample_rate=16000,
            vad_backend=backend,
            speech_reference_rms=_SPEECH_RMS,
            noise_floor_rms=_FLOOR_RMS,
            cut_edge="start",
            search_sec=(4.8, 5.3),
            crossing_sec=5.2,
            keep_out=keep_out,
        )

    assert hit is None
    control = _shaped_noise(16000, _FLOOR_RMS)
    control[3200:7040] = _shaped_noise(3840, 0.026)
    with patch(
        "podcast_mcp.engines.vad_silero.get_shared_vad",
        return_value=_fake_silero_vad([0.0] * 6 + [0.2] * 8 + [0.0] * 18),
    ):
        valid = classify_breath_samples(
            control,
            4.8,
            sample_rate=16000,
            vad_backend=backend,
            speech_reference_rms=_SPEECH_RMS,
            noise_floor_rms=_FLOOR_RMS,
            cut_edge="start",
            search_sec=(4.8, 5.3),
            crossing_sec=5.2,
        )
    assert valid is not None
    assert valid.start == pytest.approx(5.0, abs=0.01)


def test_final_protection_is_unchanged_when_disabled() -> None:
    from podcast_mcp.edits.breath_detect import protect_cut_breaths

    with patch("podcast_mcp.edits.breath_detect.load_mono_window") as read:
        disabled = protect_cut_breaths(
            _host_project(),
            "host",
            5.0,
            5.2,
            defaults={"tighten": {"breath_handling": {"enabled": False}}},
        )
    assert disabled == (5.0, 5.2)
    read.assert_not_called()


@pytest.mark.parametrize("backend", ["heuristic", "silero"])
@pytest.mark.parametrize(
    "protection", ["quiet", "voiced", "onset", "decay", "noise_floor", "window", "search", "long"]
)
def test_crossing_breath_refines_only_a_safe_quiet_onset(backend: str, protection: str) -> None:
    from podcast_mcp.edits.breath_detect import classify_breath_samples

    samples = _shaped_noise(16000, _FLOOR_RMS)
    samples[3200:4800] = _shaped_noise(1600, 0.0008)
    samples[4800:7040] = _shaped_noise(2240, 0.026)
    keep_out = []
    search = (4.8, 5.6)
    window_start = 4.8
    probs = [0.0] * 9 + [0.2] * 5 + [0.0] * 18
    if protection == "voiced":
        samples[3200:4800] = _harmonic_tone(1600, 0.0008)
    elif protection == "onset":
        samples[7040:8640] = _shaped_noise(1600, 0.0008)
        samples[8640:10240] = _harmonic_tone(1600, _SPEECH_RMS)
        keep_out = [(5.34, 5.44)]
    elif protection == "decay":
        samples[1600:3200] = _harmonic_tone(1600, _SPEECH_RMS)
        keep_out = [(4.9, 5.0)]
    elif protection == "noise_floor":
        samples[:4800] = _shaped_noise(4800, 0.0008)
    elif protection == "window":
        samples = samples[3200:]
        window_start = 5.0
        probs = [0.0] * 3 + [0.2] * 5 + [0.0] * 18
    elif protection == "search":
        search = (5.05, 5.6)
    elif protection == "long":
        samples[160:4800] = _shaped_noise(4640, 0.0008)

    def classify(crossing):
        with patch(
            "podcast_mcp.engines.vad_silero.get_shared_vad",
            return_value=_fake_silero_vad(probs),
        ):
            return classify_breath_samples(
                samples,
                window_start,
                sample_rate=16000,
                max_duration_sec=0.4,
                vad_backend=backend,
                speech_reference_rms=_SPEECH_RMS,
                noise_floor_rms=_FLOOR_RMS,
                cut_edge="start",
                keep_out=keep_out,
                search_sec=search,
                crossing_sec=crossing,
            )

    seed = classify(None)
    if protection != "decay":
        assert seed is not None
        assert seed.start == pytest.approx(5.1, abs=0.015)
    refined = classify(5.2)
    if protection == "quiet":
        assert refined is not None
        assert refined.start == pytest.approx(5.0)
        assert refined.end == pytest.approx(5.24)
    else:
        assert refined is None


# Pause trims (#1055). A pause trim removes only the air inside it, measured from the
# pause itself: its quiet is the 20th percentile of its own 10 ms frames (digital silence
# included), and a sound is a run more than 6 dB over that quiet, dips of up to 30 ms
# bridged, that peaks at least 10 dB over it. No edge may sit inside a sound. A sound
# that reaches 40 dB under the track's speech level stays whole and the trim is the
# longest run between such sounds; a quieter sound is removed whole or left whole. The
# same rule runs on every dialogue track a session ripple removes. The fixture track's
# room tone is -70 dBFS and its speech -15 dBFS, so that ceiling is -55 dBFS; its words
# sit at 4.0-4.3 and 5.45-5.75 around the pause.


def _protect(cut: tuple[float, float], *, placed=(), gap_floor=_FLOOR_RMS, **kw):
    from podcast_mcp.edits.breath_detect import protect_cut_breaths

    with patch(
        "podcast_mcp.edits.breath_detect.load_mono_window",
        side_effect=_fake_windows(placed=placed, gap_floor=gap_floor),
    ):
        return protect_cut_breaths(_host_project(), "host", *cut, **kw)


def _with_guest(project):
    from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole

    project.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/guest.wav", duration_sec=30.0),
        )
    )
    project.clips.append(
        Clip(id="c2", track_id="guest", source_start=0.0, source_end=30.0, timeline_start=0.0)
    )
    return project


def _air(cut, *, placed=(), gap_floor=_FLOOR_RMS, pause=(4.3, 5.45), guest=None):
    """``pause_air_span`` over the fixture track; ``guest`` is a second dialogue track's
    window fake, the peer a session ripple also cuts."""
    from podcast_mcp.edits.breath_detect import pause_air_span

    host = _fake_windows(placed=placed, gap_floor=gap_floor)
    project = _host_project() if guest is None else _with_guest(_host_project())

    def windows(path, start_sec, duration_sec, sample_rate=16000):
        reader = guest if guest is not None and "guest" in str(path) else host
        return reader(path, start_sec, duration_sec, sample_rate)

    with patch("podcast_mcp.edits.breath_detect.load_mono_window", side_effect=windows):
        return pause_air_span(project, "host", *cut, pause=pause)


def _frames_at(levels_db, *, voiced: bool = False) -> np.ndarray:
    """One 10 ms frame per entry at exactly that dBFS: a sound and its fade."""
    n = 160 * len(levels_db)
    source = _harmonic_tone(n, 1.0) if voiced else _shaped_noise(n, 1.0)
    out = np.empty(n, dtype=np.float32)
    for i, level in enumerate(levels_db):
        chunk = source[i * 160 : (i + 1) * 160]
        out[i * 160 : (i + 1) * 160] = _dbfs(level) * chunk / np.sqrt(np.mean(chunk**2))
    return out


def _wandering_room_tone(n: int) -> np.ndarray:
    """Room tone whose 10 ms level ramps between -76 and -66 dBFS and back every 200 ms,
    like the noise-suppressed air on the lab tape: most of it above its own 20th
    percentile, its peaks under 10 dB over it."""
    steps = np.concatenate([np.linspace(-76.0, -66.0, 11), np.linspace(-66.0, -76.0, 11)[1:-1]])
    out = _shaped_noise(n, 1.0)
    for i, start in enumerate(range(0, n, 160)):
        chunk = out[start : start + 160]
        out[start : start + 160] = _dbfs(steps[i % steps.size]) * chunk / np.sqrt(np.mean(chunk**2))
    return out


def _wandering_track(*placed: tuple[np.ndarray, float]) -> tuple[tuple[np.ndarray, float], ...]:
    """``placed`` blobs for :func:`_fake_windows`: wandering room tone throughout, under
    the fixture's words from 3.0 s; the first 3 s hold only room tone."""
    room = _wandering_room_tone(round(10.2 * 16000))
    tone = _harmonic_tone(4800, _SPEECH_RMS)
    words = [(tone, at) for at in [*np.arange(3.0, 4.3, 0.5), *np.arange(5.45, 9.9, 0.5)]]
    return ((room, 0.0), *words, *placed)


def _room_frame() -> np.ndarray:
    """One 10 ms frame at the fixture's room tone: a dip to air inside a sound."""
    return _shaped_noise(160, _FLOOR_RMS)


def test_a_pause_trim_in_its_own_quiet_keeps_its_edges() -> None:
    assert _air((5.0, 5.2)) == pytest.approx((5.0, 5.2))


def test_room_tone_wandering_over_its_quiet_is_air_not_sound() -> None:
    assert _air((5.0, 5.2), placed=_wandering_track()) == pytest.approx((5.0, 5.2))


def test_the_air_a_gate_lets_through_is_sound_against_a_gated_pause() -> None:
    # The gate is closed from 4.3 to 5.0 and opens onto room tone that runs into the
    # next word. Against the pause's own digital silence that stretch is one sound
    # that reaches the speech level, so the trim ends before the gate opens.
    gated = np.zeros(11200, dtype=np.float32)

    assert _air((4.8, 5.2), placed=_wandering_track((gated, 4.3))) == pytest.approx((4.8, 4.99))


def test_a_breath_whose_fade_crosses_an_edge_stays_whole() -> None:
    # A breath at 5.0: a 100 ms body 17 dB under the speech, then a fade of 2 dB per
    # frame into the room tone, over the pause's quiet until 5.26. It reaches the
    # ceiling, so it stays whole whether the trim's end falls in its fade or past it.
    breath = _frames_at([-32.0] * 10 + [-33.0 - 2.0 * k for k in range(19)])

    assert _air((4.4, 5.1), placed=((breath, 5.0),)) == pytest.approx((4.4, 4.99))
    assert _air((4.4, 5.4), placed=((breath, 5.0),)) == pytest.approx((4.4, 4.99))


def test_a_quiet_breath_goes_whole_or_stays_whole_never_cut_through() -> None:
    # A breath 43 dB under the speech may be removed, but only whole: it goes when the
    # trim holds all of it and stays when its fade crosses the trim's end.
    breath = _frames_at([-58.0] * 10 + [-59.0, -61.0, -63.0, -65.0, -67.0])

    assert _air((4.4, 5.3), placed=((breath, 5.0),)) == pytest.approx((4.4, 5.3))
    assert _air((4.4, 5.1), placed=((breath, 5.0),)) == pytest.approx((4.4, 4.99))


def test_a_word_tail_next_to_a_louder_stretch_is_not_cut_partway() -> None:
    # The word at 4.0-4.3 decays 1 dB per frame to the room tone over 4.3-4.85, and the
    # room is 12 dB louder for 3 s on each side of the pause. Measured against the
    # surrounding 10 s that fade's last 60 ms read as air; against the pause's own
    # quiet the trim starts after the whole fade.
    tail = _frames_at([-15.5 - k for k in range(55)], voiced=True)
    louder = _shaped_noise(round(3.0 * 16000), _dbfs(-58.0))

    assert _air((4.5, 5.3), placed=((louder, 0.0), (louder, 6.5), (tail, 4.3))) == pytest.approx(
        (4.8, 5.3)
    )


def test_a_pause_trim_starts_after_the_previous_words_audible_tail() -> None:
    # The word at 4.0-4.3 rings on at -35 dBFS until 5.08, past the trim's start.
    tail = _harmonic_tone(12480, _dbfs(-35.0))

    assert _protect((5.0, 5.4), placed=((tail, 4.3),)) is None
    assert _air((5.0, 5.4), placed=((tail, 4.3),)) == pytest.approx((5.09, 5.4))


def test_a_breath_into_the_next_word_stays_whole_before_a_pause_trim() -> None:
    # A breath at 5.25 runs straight into the word at 5.45 without falling to air.
    breath = _shaped_noise(3200, 0.026)

    assert _protect((4.4, 5.3), placed=((breath, 5.25),)) is None
    assert _air((4.4, 5.3), placed=((breath, 5.25),)) == pytest.approx((4.4, 5.24))


def test_a_complete_breath_at_a_pause_trim_end_stays_whole() -> None:
    breath = _shaped_noise(3200, 0.026)

    assert _protect((4.4, 5.3), placed=((breath, 5.2),)) == pytest.approx((4.4, 5.2))
    assert _air((4.4, 5.3), placed=((breath, 5.2),)) == pytest.approx((4.4, 5.19))


def test_a_breath_in_wandering_room_tone_stays_whole_after_a_pause_trim() -> None:
    breath = _shaped_noise(2400, 0.026)

    assert _air((4.4, 5.3), placed=_wandering_track((breath, 5.2))) == pytest.approx((4.4, 5.19))


def test_bleed_at_a_pause_trim_end_is_sound_not_a_breath() -> None:
    # A peer's voice on this track at -45 dBFS: in the breath band, but voiced.
    bleed = _harmonic_tone(4000, _dbfs(-45.0))

    assert _protect((4.4, 5.2), placed=((bleed, 5.1),)) is None
    assert _air((4.4, 5.2), placed=((bleed, 5.1),)) == pytest.approx((4.4, 5.09))
    # A mute's edge moves only out of a breath, so the bleed leaves it in place.
    assert _protect((4.4, 5.2), placed=((bleed, 5.1),), strict=False) == pytest.approx((4.4, 5.2))


@pytest.mark.parametrize(
    ("cut", "placed", "kept"),
    [
        pytest.param(
            (4.4, 5.28),
            ((_shaped_noise(4800, 0.026), 5.0), (_room_frame(), 5.25)),
            (4.4, 4.99),
            id="breath-body-end",
        ),
        pytest.param(
            (4.405, 5.2),
            ((_harmonic_tone(4800, _dbfs(-45.0)), 4.3), (_room_frame(), 4.4)),
            (4.61, 5.2),
            id="voiced-decay-start",
        ),
        pytest.param(
            (4.4, 5.2),
            (
                (_shaped_noise(1280, _dbfs(-40.0)), 4.9),
                (_room_frame(), 4.98),
                (_room_frame(), 4.99),
                (_shaped_noise(4800, 0.026), 5.0),
            ),
            (4.4, 4.89),
            id="bump-before-breath",
        ),
    ],
)
def test_a_dip_of_up_to_30_ms_does_not_end_a_sound(cut, placed, kept) -> None:
    # A breath or a voiced decay flutters across the quiet for 10-20 ms; the sound
    # goes on after the dip, so no edge may sit in it.
    assert _air(cut, placed=placed) == pytest.approx(kept)


def test_a_gated_track_keeps_its_word_tails_and_breaths_from_a_pause_trim() -> None:
    # A tight gate: digital silence except each word, its 150 ms tail and a breath, both
    # 25 dB under the speech. Against the pause's own silence every live run is a sound.
    tail = _harmonic_tone(2400, _dbfs(-40.0))
    tails = [(tail, at + 0.3) for at in [*np.arange(0.0, 4.3, 0.5), *np.arange(5.45, 9.9, 0.5)]]
    breath = _shaped_noise(4800, _dbfs(-40.0))

    assert _air((4.35, 5.1), placed=(*tails, (breath, 5.0)), gap_floor=0.0) == pytest.approx(
        (4.46, 4.99)
    )


def test_a_pause_trim_keeps_an_untranscribed_voiced_sound_whole() -> None:
    # A hum at the speech level in the middle of the pause that no transcript word covers.
    hum = _harmonic_tone(1600, _SPEECH_RMS)

    assert _air((4.4, 5.3), placed=((hum, 4.7),)) == pytest.approx((4.81, 5.3))


def test_a_pause_trim_with_no_air_left_is_dropped() -> None:
    breath = _shaped_noise(6400, 0.026)

    assert _air((5.0, 5.2), placed=((breath, 4.9),)) is None


def test_a_peers_onset_at_a_ripple_edge_shrinks_the_trim() -> None:
    # A session ripple removes the same window from every dialogue track. The gated
    # guest's word at 5.2 starts inside the trim's end, so the trim ends before it.
    guest = _fake_windows(gap_floor=0.0, placed=((_harmonic_tone(3200, _SPEECH_RMS), 5.2),))

    assert _air((4.4, 5.3), guest=guest) == pytest.approx((4.4, 5.19))


def test_a_peers_sound_inside_the_trim_is_left_to_the_speech_guard() -> None:
    # Only the edges are the air rule's: a peer's word wholly inside the span does not
    # split the air (the speech guard and the interior checks judge it), and a quiet
    # peer sound inside goes whole with the air.
    word = _fake_windows(gap_floor=0.0, placed=((_harmonic_tone(1600, _SPEECH_RMS), 4.6),))
    quiet = _fake_windows(gap_floor=0.0, placed=((_shaped_noise(1600, _dbfs(-58.0)), 4.6),))

    assert _air((4.4, 5.3), guest=word) == pytest.approx((4.4, 5.3))
    assert _air((4.4, 5.3), guest=quiet) == pytest.approx((4.4, 5.3))


def test_a_pause_a_peer_talks_through_is_skipped() -> None:
    guest = _fake_windows(gap_floor=0.0, placed=((_harmonic_tone(16000, _SPEECH_RMS), 4.35),))

    assert _air((4.4, 5.3), guest=guest) is None


def test_a_peers_quiet_sound_over_the_whole_trim_leaves_no_air() -> None:
    # Gate-passed noise 43 dB under the guest's speech from 4.4 to 5.05 covers the trim.
    noise = _fake_windows(gap_floor=0.0, placed=((_shaped_noise(10400, _dbfs(-58.0)), 4.4),))

    assert _air((4.45, 4.9), guest=noise) is None


def test_a_silent_peer_track_never_blocks_a_pause_trim() -> None:
    def silent(path, start_sec, duration_sec, sample_rate=16000):
        return np.zeros(round(duration_sec * sample_rate), dtype=np.float32)

    assert _air((4.4, 5.3), guest=silent) == pytest.approx((4.4, 5.3))


def _fixture_words() -> list[tuple[str, float, float]]:
    """The fixture track's words (300 ms every 500 ms around the 4.3-5.45 pause)."""
    starts = [*np.arange(0.0, 4.3, 0.5), *np.arange(5.45, 9.9, 0.5)]
    return [(f"w{i}", float(at), float(at) + 0.3) for i, at in enumerate(starts)]


def _air_with_words(cut, *, placed=(), pause=(4.3, 5.45), guest=None):
    """:func:`_air` over a project whose transcript names the fixture words, so each
    track's room is read between its own words."""
    from podcast_mcp.edits.breath_detect import pause_air_span

    host = _fake_windows(placed=placed)
    project = _host_project(_fixture_words())
    if guest is not None:
        project = _with_guest(project)

    def windows(path, start_sec, duration_sec, sample_rate=16000):
        reader = guest if guest is not None and "guest" in str(path) else host
        return reader(path, start_sec, duration_sec, sample_rate)

    with patch("podcast_mcp.edits.breath_detect.load_mono_window", side_effect=windows):
        return pause_air_span(project, "host", *cut, pause=pause)


def test_a_pause_mostly_its_own_sound_is_not_its_own_air() -> None:
    # A breath 42 dB under the speech fills 87% of the pause (4.36-5.34): the pause's
    # 20th percentile sits inside it. Against the track's room tone (-70 dBFS, 13 dB
    # under the breath) it is a sound, so a trim keeps its edges out of it.
    breath = _frames_at([-72.0] + [-57.0] * 98 + [-72.0])

    assert _air_with_words((4.5, 5.3), placed=((breath, 4.35),)) is None
    assert _air_with_words((4.4, 5.44), placed=((breath, 4.35),)) == pytest.approx((5.35, 5.44))
    # Whole, a sound that quiet may go with the air around it.
    assert _air_with_words((4.31, 5.44), placed=((breath, 4.35),)) == pytest.approx((4.31, 5.44))


def test_a_peer_breathing_through_the_pause_leaves_no_air_on_its_track() -> None:
    # The guest's room is -70 dBFS and it breathes at -57 from 4.36 to 5.5, past both
    # edges of the trim. The guest's own 20th percentile of the pause is the breath.
    breath = _frames_at([-57.0] * 114)
    guest = _fake_windows(placed=((breath, 4.36),))

    assert _air_with_words((4.45, 5.3), guest=guest) is None
    assert _air_with_words((4.4, 5.44), guest=guest) is None


def test_a_peer_breath_that_ends_inside_the_pause_moves_the_end_edge_out_of_it() -> None:
    # The same breath ends at 5.0 with a 60 ms fade, and the trim's start sits inside it:
    # the start moves to the end of the breath's sound, a guard frame past its fade.
    breath = _frames_at([-57.0] * 60 + [-60.0, -63.0, -66.0, -68.0, -69.0, -70.0])
    guest = _fake_windows(placed=((breath, 4.36),))

    assert _air_with_words((4.45, 5.3), guest=guest) == pytest.approx((4.99, 5.3))


def test_a_silent_peer_mic_with_only_room_tone_never_blocks_a_pause_trim() -> None:
    # An ungated second mic that carries -70 dBFS room tone and never speaks nearby:
    # its room tone is its air.
    def room_only(path, start_sec, duration_sec, sample_rate=16000):
        return _shaped_noise(round(duration_sec * sample_rate), _FLOOR_RMS, sample_rate)

    assert _air_with_words((4.4, 5.3), guest=room_only) == pytest.approx((4.4, 5.3))
