from __future__ import annotations

from podcast_mcp.engines.silence import SilenceInterval, detect_silence


def test_detect_silence_parses_ffmpeg_output(tmp_path, sample_wav) -> None:
    intervals = detect_silence(sample_wav, threshold_db=-50, min_duration_sec=0.1)
    assert isinstance(intervals, list)
    for iv in intervals:
        assert isinstance(iv, SilenceInterval)
        assert iv.end > iv.start
