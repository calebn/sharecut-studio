from __future__ import annotations

import math
import struct
import subprocess
import wave
from pathlib import Path

import pytest

from podcast_mcp.engines.audio_audit import clipping_indicated, measure_astats


def test_asymmetric_audio_counts_both_signed_peaks(tmp_path: Path) -> None:
    path = tmp_path / "asymmetric.wav"
    samples = [round(32767 * (0.25 + 0.5 * math.sin(math.tau * i / 48))) for i in range(48)]
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(48000)
        wav.writeframes(struct.pack("<48h", *samples) * 1000)

    stats = measure_astats(path)

    assert stats["peak_count"] == 2000
    assert stats["peak_level_db"] == pytest.approx(-2.499, abs=0.001)
    assert clipping_indicated(stats) is False


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ("Peak count: 4\nAbs Peak count: 99", 4),
        ("Abs Peak count: 99", None),
        ("Channel: 1\nPeak count: 4\nOverall\nPeak count: 6\nAbs Peak count: 99", 6),
        ("Overall\nPeak count: 6\nChannel: 1\nPeak count: 4\nAbs Peak count: 99", 4),
        (" \tPeak count: 4.6\n \tAbs Peak count: 99", 5),
        ("Peak count: 4\nPeak count: inf\nAbs Peak count: 99", None),
        ("Peak count: -inf\nAbs Peak count: 99", None),
    ],
)
def test_peak_count_uses_last_exact_label(
    monkeypatch: pytest.MonkeyPatch, payload: str, expected: int | None
) -> None:
    stderr = "\n".join(f"[Parsed_astats_0 @ 0x1] {line}" for line in payload.splitlines())
    monkeypatch.setattr(
        "podcast_mcp.engines.audio_audit.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, stderr=stderr),
    )

    assert measure_astats(Path("audio.wav"))["peak_count"] == expected


def test_exact_labels_preserve_other_health_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = [
        "Channel: 1",
        " \tDC offset: -0.25",
        "Peak level dB: -2.5",
        "RMS level dB: -7.27",
        "Crest factor: 1.73",
        "Flat factor: 0",
        "Peak count: 2000",
        "Abs Peak count: 1000",
        "Noise floor dB: -2.5",
        "Dynamic range: 28.81",
        "Overall",
        "DC offset: 0.25",
        "RMS level dB: -7.25",
        "Peak count: 2000.000000",
        "Abs Peak count: 1000.000000",
    ]
    stderr = "\n".join(f"[Parsed_astats_0 @ 0x1] {line}" for line in payload)
    monkeypatch.setattr(
        "podcast_mcp.engines.audio_audit.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, stderr=stderr),
    )

    assert measure_astats(Path("audio.wav")) == {
        "dc_offset": 0.25,
        "peak_level_db": -2.5,
        "rms_level_db": -7.25,
        "crest_factor": 1.73,
        "flat_factor": 0.0,
        "peak_count": 2000,
        "noise_floor_db": -2.5,
        "dynamic_range_db": 28.81,
    }
