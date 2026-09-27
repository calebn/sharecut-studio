from __future__ import annotations

import json

import pytest

from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    Clip,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    SpeakerIngestAlignment,
    Track,
    TrackRole,
    load_project,
    save_project,
)


def test_speaker_ingest_alignment_shift_round_trip():
    raw = SpeakerIngestAlignment(session_start_in_file_sec=4.0, content_align_sec=1.5)
    assert raw.source_to_timeline_shift_sec == pytest.approx(-2.5)
    late = SpeakerIngestAlignment.from_source_to_timeline_shift(3.0, align_method="gap")
    assert (late.session_start_in_file_sec, late.content_align_sec) == (0.0, 3.0)
    assert late.align_method == "gap"
    lead = SpeakerIngestAlignment.from_source_to_timeline_shift(-2.5, align_method="bleed")
    assert (lead.session_start_in_file_sec, lead.content_align_sec) == (2.5, 0.0)
    assert lead.source_to_timeline_shift_sec == pytest.approx(-2.5)
    assert "source_to_timeline_shift_sec" not in lead.model_dump()


def test_automation_point_id_is_stable():
    point = AutomationPoint(time=0.0, value=1.0)
    assert point.id
    with pytest.raises(ValueError, match="Field is frozen"):
        point.id = "different"


def test_legacy_envelope_points_get_stable_distinct_ids():
    legacy = {
        "track_id": "host",
        "points": [
            {"time": 0.0, "value": 1.0},
            {"time": 0.0, "value": 1.0},
        ],
    }
    first = AutomationEnvelope.model_validate(legacy)
    second = AutomationEnvelope.model_validate(legacy)
    first_ids = [point.id for point in first.points]
    assert first_ids == [point.id for point in second.points]
    assert len(set(first_ids)) == 2
    assert all(first_ids)


def test_load_legacy_envelope_ids_stay_stable_until_saved(minimal_project):
    raw = json.loads(minimal_project.read_text(encoding="utf-8"))
    raw["mix"]["automation_envelopes"] = [
        {
            "track_id": "host",
            "points": [{"time": 0.0, "value": 1.0}, {"time": 5.0, "value": 0.5}],
        }
    ]
    minimal_project.write_text(json.dumps(raw), encoding="utf-8")

    first = load_project(minimal_project)
    second = load_project(minimal_project)
    ids = [point.id for point in first.automation_envelopes[0].points]
    assert ids == [point.id for point in second.automation_envelopes[0].points]
    assert (
        "id"
        not in json.loads(minimal_project.read_text(encoding="utf-8"))["mix"][
            "automation_envelopes"
        ][0]["points"][0]
    )

    save_project(first, minimal_project)
    stored = json.loads(minimal_project.read_text(encoding="utf-8"))
    assert [point["id"] for point in stored["mix"]["automation_envelopes"][0]["points"]] == ids


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


def test_source_by_id(minimal_project):
    from podcast_mcp.models import SourceRecording

    proj = load_project(minimal_project)
    proj.sources.append(SourceRecording(id="src-a", path="raw/a.wav"))
    found = proj.source_by_id("src-a")
    assert found is not None and found.path == "raw/a.wav"
    assert proj.source_by_id("missing") is None


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
