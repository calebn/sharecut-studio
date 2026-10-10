from __future__ import annotations

import wave

import numpy as np
import pytest

from podcast_mcp.edits.cut_speech import CutSpeechConfirmation, UnconfirmedCutSpeech
from podcast_mcp.edits.ripple import EditMode
from podcast_mcp.edits.source_removals import CutScopeHold, inspect_source_remove
from podcast_mcp.edits.timeline_ops import plan_ripple_delete
from podcast_mcp.edits.transcript_refine_status import mark_refine_done
from podcast_mcp.models import (
    Clip,
    CutSpeech,
    CutSpeechTrack,
    EditDecisionType,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import RangeInterval, SourceRecording
from podcast_mcp.project_store import history_index_path, history_snapshot_ids
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document_sync.handlers.edits import approve_edits as approve_command
from source_review_helpers import _cut, _project

pytestmark = pytest.mark.refine_gate


def test_new_manual_cut_preserves_disjoint_stale_pending_source_decision(tmp_path):
    project = _project(tmp_path)
    project.edit_decisions = [
        _cut(
            "old-pending",
            review_required=True,
            crossfade_ms=17,
            cut_confidence=0.73,
            next_burst_sec=2.1,
        )
    ]
    mark_refine_done(
        project, notes="Known synthetic transcript fixture; no real-project acceptance"
    )
    ws = ProjectWorkspace.open(save_project(project))
    original = load_project(ws.path).edit_decisions[0]
    original_model = original.model_dump(mode="json")
    original_bytes = original.model_dump_json().encode()
    assert (
        original.id,
        original.track_id,
        original.start,
        original.end,
        original.timebase,
        original.scope,
        original.applied,
    ) == ("old-pending", "host", 1, 2, "source", "session", False)

    EditService(ws).cut_range(1.4, 1.42, mode=EditMode.GAP, track_ids=["host"])

    after_punch = load_project(ws.path)
    assert [
        (c.track_id, c.source_start, c.source_end, c.timeline_start) for c in after_punch.clips
    ] == [("host", 0, 1.4, 0), ("host", 1.42, 6, 1.42)]
    assert after_punch.edit_decisions[0].model_dump(mode="json") == original_model
    assert after_punch.edit_decisions[0].model_dump_json().encode() == original_bytes
    clips_before = [c.model_dump(mode="json") for c in after_punch.clips]
    archive_before = [r.model_dump(mode="json") for r in after_punch.editorial.edit_log]

    EditService(ProjectWorkspace.open(ws.path)).cut_time_range(
        "host", 4, 5, reason="nl:range", use_inaudible_opt=False
    )

    saved = load_project(ws.path)
    assert len(saved.edit_decisions) == 2
    old = next(row for row in saved.edit_decisions if row.id == "old-pending")
    assert old.model_dump(mode="json") == original_model
    assert old.model_dump_json().encode() == original_bytes
    fresh = next(row for row in saved.edit_decisions if row.id != "old-pending")
    assert (
        fresh.track_id,
        fresh.type.value,
        fresh.start,
        fresh.end,
        fresh.reason,
        fresh.timebase,
        fresh.scope,
        fresh.applied,
        fresh.review_required,
    ) == ("host", "remove", 4, 5, "nl:range", "source", "session", False, True)
    assert [c.model_dump(mode="json") for c in saved.clips] == clips_before
    assert [r.model_dump(mode="json") for r in saved.editorial.edit_log] == archive_before
    assert saved.timeline.duration_sec == 6


class RecoveryInterrupted(BaseException):
    pass


def _speech_review_workspace(tmp_path):
    project = _project(tmp_path)
    samples = np.zeros(96_000, dtype=np.float32)
    samples[16_000:32_000] = 0.2 * np.sin(2 * np.pi * 330 * np.arange(16_000) / 16_000)
    with wave.open(str(tmp_path / "raw" / "guest.wav"), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16_000)
        handle.writeframes((samples * 32767).astype("<i2").tobytes())
    project.tracks.append(
        Track(
            id="guest",
            label="Guest",
            speaker="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=6, sample_rate=16_000, channels=1),
        )
    )
    project.clips.append(
        Clip(id="guest", track_id="guest", source_start=0, source_end=6, timeline_start=0)
    )
    project.transcripts = [
        Transcript(track_id="guest", words=[TranscriptWord(text="hello", start=1.1, end=1.8)])
    ]
    mute = _cut("mute-first", 0.1, 0.3, reason="filler:um")
    mute.type = EditDecisionType.MUTE
    review = _cut("speech-review", 1, 2, reason="nl:range", review_required=True)
    review.cut_speech = CutSpeech(
        spans=[RangeInterval(start=1, end=2)],
        tracks=[CutSpeechTrack(track_id="guest", speaker="Guest")],
    )
    project.edit_decisions = [mute, review]
    mark_refine_done(
        project, notes="Known synthetic transcript fixture; no real-project acceptance"
    )
    ws = ProjectWorkspace.open(save_project(project))
    ws.record_snapshot("initial", force=True)
    return ws


@pytest.mark.parametrize("delivery", ["service", "document"])
def test_restored_speech_review_batch_returns_truthful_confirmation(tmp_path, delivery):
    ws = _speech_review_workspace(tmp_path)
    before = ws.project.model_dump(mode="json")
    saved_before = ws.path.read_bytes()
    ids = ["mute-first", "speech-review"]

    if delivery == "service":
        outcome = EditService(ws).approve(ids)
        assert isinstance(outcome, CutSpeechConfirmation)
        confirmation = outcome.model_dump(mode="json")
    else:
        outcome = approve_command(ws, {"ids": ids})
        assert outcome["operation"] == "approve_edits"
        assert outcome["unchanged"] is True
        confirmation = outcome["needs_confirmation"]

    assert (confirmation["status"], confirmation["reason"]) == (
        "needs_confirmation",
        "cuts_other_speech",
    )
    assert confirmation["speech"]["spans"] == [{"start": 1, "end": 2}]
    assert [
        (track["track_id"], track["speaker"], track["words"])
        for track in confirmation["speech"]["tracks"]
    ] == [
        (
            "guest",
            "Guest",
            [{"text": "hello", "timeline_start": 1.1, "timeline_end": 1.8}],
        )
    ]
    assert ws.project.model_dump(mode="json") == before
    assert ws.path.read_bytes() == saved_before
    assert [row.id for row in load_project(ws.path).edit_decisions] == [
        "mute-first",
        "speech-review",
    ]
    assert load_project(ws.path).editorial.edit_log == []


@pytest.mark.parametrize("delivery", ["service", "document"])
@pytest.mark.parametrize("restore_error", [ValueError, RecoveryInterrupted])
def test_unknown_speech_review_recovery_preserves_primary_error(
    tmp_path, monkeypatch, delivery, restore_error
):
    from podcast_mcp.history import session as session_mod
    from podcast_mcp.services.document import edit as edit_mod

    ws = _speech_review_workspace(tmp_path)
    before = ws.project.model_dump(mode="json")
    saved_before = ws.path.read_bytes()
    index = history_index_path(ws.project)
    index_before = index.read_bytes()
    snapshots_before = history_snapshot_ids(index)
    original_errors = []
    actual_approve = edit_mod.approve_edits

    def capture_error(project, ids, **kwargs):
        try:
            return actual_approve(project, ids, **kwargs)
        except UnconfirmedCutSpeech as error:
            original_errors.append(error)
            assert [r.decision_ids for r in project.editorial.edit_log] == [["mute-first"]]
            assert project.editorial.edit_log[0].params["mute"] is True
            assert len(project.clips[0].mute_regions) == 1
            raise

    def fail_restore(_project, _snapshot):
        raise restore_error("editable restoration failed")

    monkeypatch.setattr(edit_mod, "approve_edits", capture_error)
    monkeypatch.setattr(session_mod, "apply_snapshot_to_project", fail_restore)

    with pytest.raises(UnconfirmedCutSpeech) as primary:
        if delivery == "service":
            EditService(ws).approve(["mute-first", "speech-review"])
        else:
            approve_command(ws, {"ids": ["mute-first", "speech-review"]})

    assert len(original_errors) == 1
    assert primary.value is original_errors[0]
    assert primary.value.confirmation.status == "needs_confirmation"
    assert primary.value.confirmation.reason == "cuts_other_speech"
    assert ws.path.read_bytes() == saved_before
    assert index.read_bytes() == index_before
    assert history_snapshot_ids(index) == snapshots_before
    assert ws.loaded_file_revision is None
    assert ws.project.render.model_dump(mode="json") == before["render"]
    assert [r.decision_ids for r in ws.project.editorial.edit_log] == [["mute-first"]]
    assert ws.project.editorial.edit_log[0].params["mute"] is True
    assert len(ws.project.clips[0].mute_regions) == 1
    assert [
        (c.track_id, c.source_start, c.source_end, c.timeline_start) for c in ws.project.clips
    ] == [
        ("host", 0, 6, 0),
        ("guest", 0, 6, 0),
    ]
    assert ws.reload().model_dump(mode="json") == before


def test_original_music_placement_stays_pending_before_real_inward_optimization(tmp_path):
    project = _project(tmp_path)
    project.tracks.append(
        Track(id="music", label="Music", role=TrackRole.MUSIC, timeline_empty=True)
    )
    project.sources = [SourceRecording(id="host-source", path="raw/host.wav")]
    project.clips = [
        Clip(
            id="host-head",
            track_id="host",
            source_id="host-source",
            source_start=0,
            source_end=2,
            timeline_start=0,
        ),
        Clip(
            id="parked-tail",
            track_id="music",
            source_id="host-source",
            source_start=2,
            source_end=6,
            timeline_start=2,
        ),
    ]
    edit = _cut("original-seed", 1.5, 2.03, reason="filler:um", review_required=False)
    edit.boundary_mode = None
    project.edit_decisions = [edit]
    mark_refine_done(
        project, notes="Known synthetic transcript fixture; no real-project acceptance"
    )
    original = inspect_source_remove(project, edit)
    assert isinstance(original, CutScopeHold) and original.reason == "operation_scope"
    plan = plan_ripple_delete(project, 1.5, 2.03, edited_track_ids=["host"], use_inaudible_opt=True)
    assert plan.spans[0] == pytest.approx((1.46, 1.99))
    ws = ProjectWorkspace.open(save_project(project))
    before = ws.path.read_bytes()
    before_model = ws.project.model_dump(mode="json")
    assert EditService(ws).apply_auto() == 0
    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == ["original-seed"]
    assert saved.editorial.edit_log == []
    assert ws.path.read_bytes() == before
    assert ws.project.model_dump(mode="json") == before_model
