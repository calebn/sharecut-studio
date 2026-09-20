"""Regression tests for source-vs-timeline drift (podcast-cleanup-test-v2 class bugs)."""

from __future__ import annotations

import pytest

from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.transcript_gated_play import word_intervals
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.timebase import SourceSec


def _compressed_project(tmp_path) -> EpisodeProject:
    """30s cut at source 60-90; word A before cut, word B after."""
    p = EpisodeProject.create("drift", str(tmp_path / "ws"))
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            media=MediaAsset(path="raw/host.wav", duration_sec=200.0),
        )
    ]
    p.timeline.clips = [
        Clip(id="c1", track_id="host", source_start=0.0, source_end=60.0, timeline_start=0.0),
        Clip(id="c2", track_id="host", source_start=90.0, source_end=200.0, timeline_start=60.0),
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="before", start=10.0, end=12.0),
                TranscriptWord(text="after", start=100.0, end=102.0),
            ],
        )
    ]
    return p


def test_word_after_cut_maps_to_compressed_timeline(tmp_path):
    """Word B at source 100 must gate near timeline 70, not timeline 100."""
    p = _compressed_project(tmp_path)
    st = SessionTimeline(p)
    assert st.source_to_timeline("host", SourceSec(100.0)) == pytest.approx(70.0)

    intervals = word_intervals(p, "host", 0.0, 200.0)
    assert len(intervals) == 2
    assert intervals[0] == pytest.approx((10.0, 12.0))
    assert intervals[1] == pytest.approx((70.0, 72.0))


def test_follow_transcript_interval_not_at_source_position(tmp_path):
    """Gating must not use raw source seconds on a timeline stem."""
    p = _compressed_project(tmp_path)
    intervals = word_intervals(p, "host", 65.0, 75.0)
    assert intervals == [pytest.approx((70.0, 72.0))]
    assert not any(abs(s - 100.0) < 1.0 for s, _ in intervals)


def test_audibility_uses_timeline_not_source(monkeypatch, tmp_path):
    """compute_word_audibility_map must RMS the mapped timeline window."""
    from podcast_mcp.engines import audio_audit

    p = _compressed_project(tmp_path)
    seen: list[tuple[float, float]] = []

    def fake_rms(
        project,
        track_id,
        t_start,
        t_end,
        *,
        caches=None,
    ):
        seen.append((t_start, t_end))
        return -30.0

    monkeypatch.setattr(audio_audit, "_rms_for_track_at_timeline", fake_rms)
    monkeypatch.setattr(audio_audit, "build_track_rms_caches", lambda _p: {})

    rows = audio_audit.compute_word_audibility_map(p)
    assert len(rows) == 2
    assert (10.0, 12.0) in seen
    assert (70.0, 72.0) in seen
    assert not any(abs(s - 100.0) < 0.5 for s, _ in seen)
