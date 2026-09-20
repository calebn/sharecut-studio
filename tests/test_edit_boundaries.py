"""Tests for map_edit_boundaries projection."""

from __future__ import annotations

from podcast_mcp.gui.mapper import map_edit_boundaries
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services.workspace import ProjectWorkspace


def test_map_edit_boundaries_includes_cutaway_words(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=40.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        ),
        Clip(
            id="c2",
            track_id="host",
            source_start=15.0,
            source_end=25.0,
            timeline_start=5.0,
        ),
    ]
    ws.project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="keep", start=1.0, end=1.5),
                TranscriptWord(text="gone", start=8.0, end=8.5),
                TranscriptWord(text="later", start=16.0, end=16.5),
            ],
        )
    ]
    boundaries = map_edit_boundaries(ws.project)
    assert len(boundaries) == 1
    assert all(b["right_clip_id"] is not None for b in boundaries)
    assert not any(b["id"].endswith(":end") for b in boundaries)
    join = next(b for b in boundaries if b["left_clip_id"] == "c1")
    assert join["has_cutaway"] is True
    assert join["cutaway_source_start"] == 5.0
    assert join["cutaway_source_end"] == 15.0
    assert join["timeline_join_sec"] == 5.0
    assert any(w["text"] == "gone" for w in join["cutaway_word_ids"])
    assert not any(w["text"] == "keep" for w in join["cutaway_word_ids"])


def test_map_edit_boundaries_skips_track_end_without_neighbor(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=40.0),
        )
    ]
    ws.project.timeline.clips = [
        Clip(
            id="only",
            track_id="host",
            source_start=0.0,
            source_end=5.0,
            timeline_start=0.0,
        ),
    ]
    assert map_edit_boundaries(ws.project) == []
