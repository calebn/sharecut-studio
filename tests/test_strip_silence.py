from __future__ import annotations

from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.strip_silence import _kept_source_ranges, strip_silence
from podcast_mcp.engines.silence import SilenceInterval
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
)


def test_kept_source_ranges_preserves_short_speech_between_silences() -> None:
    """Padding must come from silence interiors — not eat speech islands."""
    silences = [
        SilenceInterval(0.0, 1.0),
        SilenceInterval(1.2, 2.0),
        SilenceInterval(2.5, 5.0),
    ]
    kept = _kept_source_ranges(5.0, silences, keep_padding_sec=0.05)
    # Leading/trailing silence retain `keep_padding_sec` of air; speech islands stay intact.
    assert kept == [(0.0, 0.05), (0.95, 1.25), (1.95, 2.55), (4.95, 5.0)]


def test_kept_source_ranges_no_silence_keeps_all() -> None:
    assert _kept_source_ranges(10.0, [], 0.05) == [(0.0, 10.0)]


def test_kept_source_ranges_leading_and_trailing_speech() -> None:
    silences = [SilenceInterval(1.0, 2.0)]
    kept = _kept_source_ranges(3.0, silences, keep_padding_sec=0.1)
    assert kept == [(0.0, 1.1), (1.9, 3.0)]


def test_kept_source_ranges_short_silence_fully_retained() -> None:
    """Silence shorter than 2x padding emits no remove and stays intact."""
    silences = [SilenceInterval(1.0, 1.08)]  # 80ms < 2x0.05
    kept = _kept_source_ranges(3.0, silences, keep_padding_sec=0.05)
    assert kept == [(0.0, 3.0)]


def test_strip_silence_splits_clips(tmp_path, sample_wav) -> None:
    ws = tmp_path / "ws"
    raw = ws / "raw"
    raw.mkdir(parents=True)
    (raw / "host.wav").write_bytes(sample_wav.read_bytes())

    p = EpisodeProject.create("strip", str(ws))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    ]
    p.timeline.clips = [
        Clip(
            id="full",
            track_id="host",
            source_start=0.0,
            source_end=2.0,
            timeline_start=0.0,
        )
    ]
    result = strip_silence(p, "host", min_duration_sec=0.1, defaults=load_defaults())
    assert result["clips_created"] >= 1
    assert len([c for c in p.clips if c.track_id == "host"]) >= 1


_RATE = 16_000


def _speech_and_noisy_room(gain_db: float = 0.0) -> np.ndarray:
    """1 s of speech at -20 dBFS RMS, then 1 s of white room tone at -55 dBFS RMS, four times.

    Room-tone peaks sit about 10 dB over its RMS, so a sample-peak silence test at the
    frame-RMS voice floor (-47 dBFS here) would find no silence at all.
    """
    rng = np.random.default_rng(11)
    t = np.arange(_RATE) / _RATE
    speech = 0.1 * np.sqrt(2) * np.sin(2 * np.pi * 180 * t)
    parts = []
    for _ in range(4):
        parts += [speech, rng.standard_normal(_RATE) * 10 ** (-55 / 20)]
    return np.concatenate(parts) * 10 ** (gain_db / 20)


def _strip(tmp_path, samples: np.ndarray) -> dict:
    ws = tmp_path / "ws"
    (ws / "raw").mkdir(parents=True)
    # Only the file's revision is read: decode and probe are stubbed with ``samples``.
    (ws / "raw" / "host.wav").write_bytes(b"x")
    p = EpisodeProject.create("strip-noisy", str(ws))
    p.timeline.tracks = [
        Track(
            id="host", label="Host", role=TrackRole.DIALOGUE, media=MediaAsset(path="raw/host.wav")
        )
    ]
    duration = samples.size / _RATE
    p.timeline.clips = [
        Clip(id="full", track_id="host", source_start=0.0, source_end=duration, timeline_start=0.0)
    ]
    with (
        patch("podcast_mcp.edits.strip_silence.load_mono_full", return_value=samples),
        patch("podcast_mcp.engines.ffmpeg.FFmpegEngine") as eng_cls,
    ):
        eng_cls.return_value.probe.return_value = type("Probe", (), {"duration_sec": duration})()
        return strip_silence(p, "host", defaults=load_defaults())


def test_strip_silence_finds_the_room_between_words_on_a_noisy_track(tmp_path) -> None:
    result = _strip(tmp_path, _speech_and_noisy_room())

    assert result["silence_intervals"] == 4
    # Four words, then the trailing silence's kept padding of air.
    assert result["clips_created"] == 5
    assert result["removed_sec"] == pytest.approx(3.6, abs=0.05)


@pytest.mark.parametrize("gain_db", [-12.0, -24.0])
def test_strip_silence_keeps_the_same_islands_at_any_recording_gain(tmp_path, gain_db) -> None:
    unscaled = _strip(tmp_path / "unscaled", _speech_and_noisy_room())
    scaled = _strip(tmp_path / "scaled", _speech_and_noisy_room(gain_db))

    assert scaled == unscaled


def test_strip_silence_on_a_track_with_no_live_audio_removes_it_end_to_end(tmp_path) -> None:
    result = _strip(tmp_path, np.zeros(2 * _RATE))

    assert result["silence_intervals"] == 1
    assert result["removed_sec"] == pytest.approx(1.9, abs=1e-6)


def test_strip_silence_keeps_a_track_whose_voice_does_not_stand_out_of_its_room(tmp_path) -> None:
    rng = np.random.default_rng(13)
    flat = rng.standard_normal(4 * _RATE) * 10 ** (-30 / 20)

    result = _strip(tmp_path, flat)

    assert result["silence_intervals"] == 0
    assert result["removed_sec"] == pytest.approx(0.0)
