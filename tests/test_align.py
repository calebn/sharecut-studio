from __future__ import annotations

import subprocess
from pathlib import Path

from podcast_mcp.engines.align import (
    cross_speaker_offsets,
    estimate_offset_sec,
)
from podcast_mcp.ingest.consolidate import alignment_report, consolidate_speakers
from podcast_mcp.ingest.manifest import IngestManifest


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


def _nonperiodic_wav(dst: Path, *, duration_sec: float = 2.0) -> None:
    """Write a non-periodic mono chirp so correlation has a unique peak.

    A pure sine (used by ``sample_wav``) is a poor alignment fixture: many lag
    peaks look equally good and CI/ffmpeg versions can pick a spurious offset.
    """
    import math
    import struct
    import wave

    sr = 16000
    n = int(sr * duration_sec)
    with wave.open(str(dst), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        for i in range(n):
            t = i / sr
            # Decaying chirp + dither so the waveform is unique in time.
            env = math.exp(-1.5 * t)
            chirp = math.sin(2 * math.pi * (200 + 400 * t) * t)
            dither = ((i * 1103515245 + 12345) & 0x7FFF) / 0x7FFF - 0.5
            sample = int(12000 * env * (chirp + 0.15 * dither))
            sample = max(-32767, min(32767, sample))
            w.writeframes(struct.pack("<h", sample))


def test_estimate_offset_finds_delay(tmp_path: Path) -> None:
    ref = tmp_path / "ref.wav"
    late = tmp_path / "late.wav"
    _nonperiodic_wav(ref, duration_sec=2.0)
    _delayed_copy(ref, late, 0.5)
    result = estimate_offset_sec(
        ref,
        late,
        max_lag_sec=2.0,
        analysis_start_sec=0.0,
        analysis_duration_sec=1.5,
    )
    assert 0.35 <= result.offset_sec <= 0.65


def test_cross_speaker_offsets_detects_delay(tmp_path: Path) -> None:
    audio_dir = tmp_path / "xs"
    audio_dir.mkdir()
    ref = audio_dir / "ref.wav"
    late = audio_dir / "late.wav"
    _nonperiodic_wav(ref, duration_sec=2.0)
    _delayed_copy(ref, late, 0.5)
    results = cross_speaker_offsets(
        [("Ref", [ref]), ("Late", [late])],
        analysis_start_sec=0.0,
        analysis_duration_sec=1.5,
    )
    assert results["Ref"].offset_sec == 0.0
    assert 0.35 <= results["Late"].offset_sec <= 0.65


def test_cross_speaker_offsets_ignores_weak_peak(tmp_path: Path) -> None:
    audio_dir = tmp_path / "xs"
    audio_dir.mkdir()
    ref = audio_dir / "ref.wav"
    late = audio_dir / "late.wav"
    _nonperiodic_wav(ref, duration_sec=2.0)
    _delayed_copy(ref, late, 0.5)
    results = cross_speaker_offsets(
        [("Ref", [ref]), ("Late", [late])],
        analysis_start_sec=0.0,
        analysis_duration_sec=1.5,
        min_correlation_peak=2.0,
    )
    assert results["Late"].offset_sec == 0.0


def test_consolidate_two_speaker_manifest(sample_wav: Path, tmp_path: Path) -> None:
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    host_a = audio_dir / "host_a.wav"
    host_b = audio_dir / "host_b.wav"
    guest_a = audio_dir / "guest_a.wav"
    host_a.write_bytes(sample_wav.read_bytes())
    host_b.write_bytes(sample_wav.read_bytes())
    guest_a.write_bytes(sample_wav.read_bytes())

    manifest_path = tmp_path / "ingest.yaml"
    manifest_path.write_text(
        """
speakers:
  - name: Host
    sources: [host_a.wav, host_b.wav]
  - name: Guest
    sources: [guest_a.wav]
""",
        encoding="utf-8",
    )
    manifest = IngestManifest.load(manifest_path)
    out_dir = tmp_path / "raw"
    result = consolidate_speakers(
        manifest,
        audio_dir,
        out_dir,
        analysis_start_sec=0.0,
        analysis_duration_sec=1.5,
        extract_start_sec=0.0,
        extract_duration_sec=1.0,
    )
    assert len(result.speaker_tracks) == 2
    assert len(result.alignments[0].sources) == 2
    assert result.ignored_sources == []
    assert all(p.is_file() for p in result.speaker_tracks.values())
    rows = alignment_report(manifest, audio_dir, analysis_start_sec=0.0, analysis_duration_sec=1.5)
    assert len(rows) == 2
    assert rows[0]["ignored_sources"]


def test_xcorr_lag_window_matches_full_correlate() -> None:
    import numpy as np

    from podcast_mcp.engines.align import _xcorr_lag_window

    rng = np.random.default_rng(0)
    ref = rng.normal(size=800).astype(np.float64)
    src = np.roll(ref, 7)
    max_lag = 40
    window, center = _xcorr_lag_window(ref, src, max_lag)
    full = np.correlate(ref, src, mode="full")
    expected_center = len(src) - 1
    expected = full[expected_center - max_lag : expected_center + max_lag + 1]
    assert center == max_lag
    assert np.allclose(window, expected, atol=1e-6)


def test_cross_speaker_offsets_short_file_is_zero_peak(tmp_path: Path) -> None:
    ref = tmp_path / "ref.wav"
    other = tmp_path / "other.wav"
    _nonperiodic_wav(ref, duration_sec=2.0)
    _nonperiodic_wav(other, duration_sec=2.0)
    results = cross_speaker_offsets(
        [("Ref", [ref]), ("Guest", [other])],
        analysis_start_sec=60.0,
        analysis_duration_sec=5.0,
    )
    assert results["Guest"].correlation_peak == 0.0
    assert results["Guest"].offset_sec == 0.0
