"""``list_clips`` rows say which recording a clip plays and how long it is.

The DAW's trim preview (gui/web/src/edit/trimLimits.ts) mirrors ``trim_edge_limits``,
which stops an edge at the clip's own recording, so every row carries the two facts
that function reads: ``source_duration_sec`` and ``recording_path``.
"""

from __future__ import annotations

from podcast_mcp.edits.timeline_ops import list_clips
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
)


def _project() -> EpisodeProject:
    p = EpisodeProject.create("rows", "/tmp/rows")
    p.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host_t1.wav", duration_sec=600.0),
        ),
        Track(id="bare", label="Bare", role=TrackRole.DIALOGUE),
    ]
    p.sources = [
        SourceRecording(id="host_t1", path="raw/host_t1.wav", duration_sec=600.0),
        SourceRecording(id="host_t2", path="raw/host_t2.wav", duration_sec=60.0),
        SourceRecording(id="unmeasured", path="raw/unmeasured.wav", duration_sec=None),
    ]
    p.timeline.clips = [
        Clip(id="own", track_id="host", timeline_start=0, source_start=0, source_end=10),
        Clip(
            id="same_file",
            track_id="host",
            source_id="host_t1",
            timeline_start=10,
            source_start=20,
            source_end=30,
        ),
        Clip(
            id="take2",
            track_id="host",
            source_id="host_t2",
            timeline_start=20,
            source_start=0,
            source_end=30,
        ),
        Clip(
            id="no_length",
            track_id="host",
            source_id="unmeasured",
            timeline_start=50,
            source_start=0,
            source_end=5,
        ),
        Clip(id="no_media", track_id="bare", timeline_start=0, source_start=0, source_end=5),
    ]
    return p


def _rows() -> dict[str, dict]:
    lanes = list_clips(_project())["tracks"]
    return {row["id"]: row for lane in lanes.values() for row in lane}


def test_a_clip_without_a_source_plays_its_track_media() -> None:
    row = _rows()["own"]
    assert (row["source_duration_sec"], row["recording_path"]) == (600.0, "raw/host_t1.wav")


def test_a_clip_names_its_source_recording() -> None:
    row = _rows()["take2"]
    assert (row["source_duration_sec"], row["recording_path"]) == (60.0, "raw/host_t2.wav")


def test_a_source_over_the_track_media_file_shares_its_recording_path() -> None:
    rows = _rows()
    assert rows["same_file"]["recording_path"] == rows["own"]["recording_path"] == "raw/host_t1.wav"


def test_an_unmeasured_source_has_no_length() -> None:
    row = _rows()["no_length"]
    assert (row["source_duration_sec"], row["recording_path"]) == (None, "raw/unmeasured.wav")


def test_a_track_with_no_media_has_neither() -> None:
    row = _rows()["no_media"]
    assert (row["source_duration_sec"], row["recording_path"]) == (None, None)
