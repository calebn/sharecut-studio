from __future__ import annotations

import wave

import numpy as np
import pytest

from podcast_mcp.edits.pending_preview import apply_for_suggested, resolve_pending_preview
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.models.episode import SourceRecording
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from source_review_helpers import _cut, _project


def _parked_project(tmp_path, role):
    project = _project(tmp_path)
    project.tracks[0].timeline_empty = True
    project.tracks.append(
        Track(id="destination", label="Destination", role=role, timeline_empty=True)
    )
    project.sources = [SourceRecording(id="host-source", path="raw/host.wav")]
    project.clips = [
        Clip(
            id="parked",
            track_id="destination",
            source_id="host-source",
            source_start=0,
            source_end=6,
            timeline_start=0,
        )
    ]
    project.edit_decisions = [_cut("parked-cut", reason="filler:um")]
    return project


@pytest.mark.parametrize("delivery", ["saved", "auto", "suggested", "proposal"])
def test_parked_music_cannot_report_success_without_consuming_selected_audio(tmp_path, delivery):
    project = _parked_project(tmp_path, TrackRole.MUSIC)
    ws = ProjectWorkspace.open(save_project(project))
    before = ws.path.read_bytes()
    if delivery == "auto":
        assert EditService(ws).apply_auto() == 0
    else:
        with pytest.raises(ScopeChangedAtApproval) as held:
            if delivery == "saved":
                EditService(ws).approve(["parked-cut"], confirm_cut_speech=True)
            elif delivery == "suggested":
                snapshot = ws.project.model_copy(deep=True)
                apply_for_suggested(snapshot, resolve_pending_preview(snapshot, "parked-cut"))
            else:
                EditService(ws).suggest_pending_edit("host", 1, 2)
        assert held.value.held[0].reason == "operation_scope"
    assert ws.path.read_bytes() == before or delivery == "auto"
    saved = load_project(ws.path)
    assert [
        (c.id, c.track_id, c.source_start, c.source_end, c.timeline_start) for c in saved.clips
    ] == [("parked", "destination", 0, 6, 0)]
    assert saved.timeline.duration_sec == 6
    assert [e.id for e in saved.edit_decisions] == ["parked-cut"]
    assert saved.editorial.edit_log == []


def test_quiet_parked_dialogue_is_consumed_by_canonical_ripple(tmp_path):
    ws = ProjectWorkspace.open(save_project(_parked_project(tmp_path, TrackRole.DIALOGUE)))
    assert EditService(ws).approve(["parked-cut"]) == 1
    saved = load_project(ws.path)
    assert [(c.track_id, c.source_start, c.source_end, c.timeline_start) for c in saved.clips] == [
        ("destination", 0, 1, 0),
        ("destination", 2, 6, 1),
    ]
    assert saved.timeline.duration_sec == 5
    assert [record.decision_ids for record in saved.editorial.edit_log] == [["parked-cut"]]
    assert saved.edit_decisions == []


@pytest.mark.parametrize("overlay", [False, True])
def test_voiced_parked_dialogue_stays_pending_under_current_scope_policy(tmp_path, overlay):
    project = _parked_project(tmp_path, TrackRole.DIALOGUE)
    samples = np.zeros(96_000, dtype=np.float32)
    samples[16_000:32_000] = 0.2 * np.sin(2 * np.pi * 180 * np.arange(16_000) / 16_000)
    with wave.open(str(tmp_path / "raw" / "host.wav"), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16_000)
        handle.writeframes((samples * 32767).astype("<i2").tobytes())
    if overlay:
        foreign = tmp_path / "raw" / "foreign.wav"
        with wave.open(str(foreign), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(16_000)
            handle.writeframes((samples * 32767).astype("<i2").tobytes())
        project.tracks[1].media = MediaAsset(path="raw/foreign.wav", duration_sec=6)
        project.clips.append(
            Clip(
                id="foreign", track_id="destination", source_start=0, source_end=6, timeline_start=0
            )
        )
    ws = ProjectWorkspace.open(save_project(project))
    before = ws.project.model_dump(mode="json")
    saved_before = ws.path.read_bytes()
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["parked-cut"], confirm_cut_speech=True)
    assert held.value.held[0].reason in ("peer_speech", "scope_unavailable")
    assert ws.path.read_bytes() == saved_before
    assert ws.project.model_dump(mode="json") == before
    assert [e.id for e in ws.project.edit_decisions] == ["parked-cut"]
    assert ws.project.editorial.edit_log == []
