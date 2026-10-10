from __future__ import annotations

import math
import wave
from array import array

import pytest

from podcast_mcp.edits.source_removals import CutScopeHold, inspect_source_remove
from podcast_mcp.edits.timeline_ops import plan_ripple_delete
from podcast_mcp.edits.transcript_refine_status import mark_refine_done
from podcast_mcp.models import (
    Clip,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import SourceRecording
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from source_review_helpers import _cut, _project

pytestmark = pytest.mark.refine_gate


def test_real_planner_expansion_cannot_approve_unqualified_original_pause(tmp_path):
    project = _project(tmp_path)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="before", start=0.3, end=0.5),
                TranscriptWord(text="after", start=3.2, end=3.5),
            ],
        )
    ]
    pause = _cut(
        "pause", 1.5, 2.03, reason="pause:2.70s", replace_gap_sec=0.7, review_required=False
    )
    pause.boundary_mode = None
    project.edit_decisions = [pause]
    mark_refine_done(
        project, notes="Known synthetic transcript fixture; no real-project acceptance"
    )
    original = inspect_source_remove(project, pause)
    assert isinstance(original, CutScopeHold)
    assert original.reason == "pause_not_shorter"
    plan = plan_ripple_delete(project, 1.5, 2.03, edited_track_ids=["host"], use_inaudible_opt=True)
    assert plan.spans[0] == pytest.approx((1.46, 2.8))
    final = pause.model_copy(update={"start": plan.spans[0][0], "end": plan.spans[0][1]})
    assert inspect_source_remove(project, final) == pytest.approx((1.46, 2.8))
    ws = ProjectWorkspace.open(save_project(project))

    before_disk = ws.path.read_bytes()
    before_memory = ws.project.model_dump(mode="json")
    assert EditService(ws).apply_auto() == 0
    assert ws.path.read_bytes() == before_disk
    assert ws.project.model_dump(mode="json") == before_memory
    saved = load_project(ws.path)
    assert saved.timeline.duration_sec == 6
    assert [edit.id for edit in saved.edit_decisions] == ["pause"]
    assert saved.editorial.edit_log == []
    assert [(w.text, w.start, w.end) for w in saved.transcripts[0].words] == [
        ("before", 0.3, 0.5),
        ("after", 3.2, 3.5),
    ]


def test_original_pause_on_music_stays_pending_before_real_inward_planning(tmp_path):
    project = _project(tmp_path)
    samples = array(
        "h",
        (
            0
            if 1.2 <= index / 16000 < 2.3
            else int(6000 * math.sin(2 * math.pi * 440 * index / 16000))
            for index in range(96000)
        ),
    )
    with wave.open(str(tmp_path / "raw" / "host.wav"), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(samples.tobytes())
    project.tracks.append(
        Track(id="music", label="Music", role=TrackRole.MUSIC, timeline_empty=True)
    )
    project.sources = [SourceRecording(id="host-source", path="raw/host.wav")]
    project.clips = [
        Clip(
            id="head",
            track_id="host",
            source_id="host-source",
            source_start=0,
            source_end=2,
            timeline_start=0,
        ),
        Clip(
            id="tail",
            track_id="music",
            source_id="host-source",
            source_start=2,
            source_end=6,
            timeline_start=2,
        ),
    ]
    pause = _cut(
        "parked-pause", 1.5, 2.03, reason="pause:1.10s", replace_gap_sec=0.1, review_required=False
    )
    pause.boundary_mode = None
    project.edit_decisions = [pause]
    mark_refine_done(
        project, notes="Known synthetic transcript fixture; no real-project acceptance"
    )
    original = inspect_source_remove(project, pause)
    assert isinstance(original, CutScopeHold)
    assert original.reason == "operation_scope"
    plan = plan_ripple_delete(project, 1.5, 2.03, edited_track_ids=["host"], use_inaudible_opt=True)
    assert plan.spans[0] == pytest.approx((1.46, 1.99))
    final = pause.model_copy(update={"start": plan.spans[0][0], "end": plan.spans[0][1]})
    assert inspect_source_remove(project, final) == pytest.approx((1.46, 1.99))
    ws = ProjectWorkspace.open(save_project(project))
    before_disk = ws.path.read_bytes()
    before_memory = ws.project.model_dump(mode="json")

    assert EditService(ws).apply_auto() == 0

    assert ws.path.read_bytes() == before_disk
    assert ws.project.model_dump(mode="json") == before_memory
    assert [e.id for e in load_project(ws.path).edit_decisions] == ["parked-pause"]
    assert ws.project.editorial.edit_log == []
