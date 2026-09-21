from __future__ import annotations

import pytest

from podcast_mcp.models import (
    AutomationPoint,
    Clip,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)


def test_automation_point_id_is_stable():
    point = AutomationPoint(time=0.0, value=1.0)
    assert point.id
    with pytest.raises(ValueError, match="Field is frozen"):
        point.id = "different"


def test_clip_timeline_end_property():
    clip = Clip(
        id="c1",
        track_id="host",
        source_start=2.0,
        source_end=5.0,
        timeline_start=1.0,
    )
    assert clip.timeline_end == 4.0


def test_save_load_roundtrip(minimal_project):
    loaded = load_project(minimal_project)
    assert loaded.name == "test_episode"
    assert loaded.workspace_dir


def test_track_add_and_probe(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    proj.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            speaker="Host",
            media=MediaAsset(path=str(sample_wav)),
        )
    )
    path = save_project(proj, minimal_project)
    again = load_project(path)
    assert again.track_by_id("host") is not None


def test_edit_segments():
    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    eng = FFmpegEngine()
    edits = [
        EditDecision(
            id="1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.5,
            end=0.8,
            applied=True,
        )
    ]
    segs = eng.segments_after_edits(2.0, edits, "host")
    assert len(segs) == 2
    assert segs[0].start == 0.0 and segs[0].end == 0.5
    assert segs[1].start == 0.8 and segs[1].end == 2.0
