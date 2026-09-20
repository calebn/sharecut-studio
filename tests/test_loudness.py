from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from podcast_mcp.edits.loudness import check_loudness


def test_check_loudness_pass(sample_wav: Path):
    with patch(
        "podcast_mcp.edits.loudness.FFmpegEngine.measure_loudness",
        return_value=-16.2,
    ):
        result = check_loudness(sample_wav, target_lufs=-16.0)
    assert result["lufs_pass"] is True
    assert result["pass"] is True
    assert result["measured_lufs"] == -16.2


def test_check_loudness_fail(sample_wav: Path):
    with patch(
        "podcast_mcp.edits.loudness.FFmpegEngine.measure_loudness",
        return_value=-22.0,
    ):
        result = check_loudness(sample_wav, target_lufs=-16.0, true_peak_db=-1.0)
    assert result["lufs_pass"] is False
    assert result["true_peak_limit_db"] == -1.0


def test_check_loudness_none_measurement(sample_wav: Path):
    with patch(
        "podcast_mcp.edits.loudness.FFmpegEngine.measure_loudness",
        return_value=None,
    ):
        result = check_loudness(sample_wav)
    assert result["lufs_pass"] is False
