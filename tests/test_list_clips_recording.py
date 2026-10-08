"""``list_clips`` rows say which recording a clip plays and how long it is.

The DAW's trim preview (gui/web/src/edit/trimLimits.ts) mirrors ``trim_edge_limits``,
which stops an edge at the clip's own recording, so every row carries the two facts
that function reads: ``source_duration_sec`` and ``recording_key``, an opaque identity
that two clips share exactly when they play the same file. It names no file, so a share
guest, who never sees a track's ``media_path``, learns no file name from a clip row.
"""

from __future__ import annotations

import json

from podcast_mcp.edits.timeline_ops import list_clips
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
)
from podcast_mcp.services.collaboration.share import sanitize_guest_project_view


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


HOST_T1_KEY = "rec_b9935362a00ace29"
HOST_T2_KEY = "rec_bca09517d0d9c96e"
UNMEASURED_KEY = "rec_97ea32f45d708e13"


def test_a_clip_without_a_source_plays_its_track_media() -> None:
    row = _rows()["own"]
    assert (row["source_duration_sec"], row["recording_key"]) == (600.0, HOST_T1_KEY)


def test_a_clip_names_its_source_recording() -> None:
    row = _rows()["take2"]
    assert (row["source_duration_sec"], row["recording_key"]) == (60.0, HOST_T2_KEY)


def test_a_source_over_the_track_media_file_shares_its_recording_key() -> None:
    rows = _rows()
    assert rows["same_file"]["recording_key"] == rows["own"]["recording_key"] == HOST_T1_KEY
    assert rows["take2"]["recording_key"] != rows["own"]["recording_key"]


def test_an_unmeasured_source_has_no_length() -> None:
    row = _rows()["no_length"]
    assert (row["source_duration_sec"], row["recording_key"]) == (None, UNMEASURED_KEY)


def test_a_track_with_no_media_has_neither() -> None:
    row = _rows()["no_media"]
    assert (row["source_duration_sec"], row["recording_key"]) == (None, None)


def test_a_row_carries_no_file_name() -> None:
    for row in _rows().values():
        assert "recording_path" not in row
        key = row["recording_key"]
        assert key is None or (len(key) == 20 and "/" not in key and "." not in key)


def test_a_guest_view_of_the_rows_shows_identity_but_no_file_name() -> None:
    view = {
        "tracks": [{"id": "host", "media_path": "raw/host_t1.wav"}],
        "clips": list_clips(_project()),
    }
    out = sanitize_guest_project_view(view)
    assert out["tracks"][0]["media_path"] is None
    rows = {r["id"]: r for lane in out["clips"]["tracks"].values() for r in lane}
    assert {i: r["recording_key"] for i, r in rows.items()} == {
        "own": HOST_T1_KEY,
        "same_file": HOST_T1_KEY,
        "take2": HOST_T2_KEY,
        "no_length": UNMEASURED_KEY,
        "no_media": None,
    }
    text = json.dumps(out["clips"])
    assert ".wav" not in text
    assert "raw/" not in text
