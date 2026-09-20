from __future__ import annotations

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
    result = strip_silence(p, "host", threshold_db=-50, min_duration_sec=0.1)
    assert result["clips_created"] >= 1
    assert len([c for c in p.clips if c.track_id == "host"]) >= 1
