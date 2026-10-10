from __future__ import annotations

import copy
import math
from types import SimpleNamespace

import pytest

from pause_policy_public_helpers import (
    configure,
    defaults,
    files,
    pause,
    primary_spans,
    project,
    room,
    voice,
    workspace,
    write_wav,
)
from podcast_mcp.edits.pending_preview import apply_for_suggested, resolve_pending_preview
from podcast_mcp.models import EditDecisionType, TranscriptWord, load_project
from podcast_mcp.services.document import EditService


def _stored_remove(tmp_path, *, db=-70, seconds=6, seed=1214):
    result = project(tmp_path)
    audio = room(seconds, db=db, seed=seed)
    intervals = [(0, 0.2), (5, 5.2), (5.4, 5.8)]
    if seconds == 12:
        intervals = [(0, 0.2), (5, 5.2), (11, 11.2), (11.4, 11.8)]
    for start, end in intervals:
        voice(audio, start, end)
    write_wav(tmp_path / "raw/host.wav", audio)
    result.track_by_id("host").media.duration_sec = seconds
    result.clips[0].source_end = seconds
    result.timeline.duration_sec = seconds
    result.transcripts[0].words = [
        TranscriptWord(text=f"word-{index}", start=start, end=end)
        for index, (start, end) in enumerate(intervals)
    ]
    result.edit_decisions = [pause("stored-remove", start=0.3, end=4.7, gap=None)]
    return result


def _assert_original_splice(edited, *, operation):
    assert edited.edit_decisions == []
    assert len(edited.editorial.edit_log) == 1
    record = edited.editorial.edit_log[0]
    assert record.operation == operation
    assert record.decision_ids == ["stored-remove"]
    assert record.params.get("mute", False) is False
    assert (record.source_start, record.source_end) == pytest.approx((0.3, 4.45))
    assert (record.timeline_start, record.timeline_end) == pytest.approx((0.3, 4.45))
    assert record.params["loss_sec"] == pytest.approx(4.15)
    assert 4.8 - record.params["loss_sec"] == pytest.approx(0.65)
    assert 4.8 - record.params["loss_sec"] >= 0.55
    assert record.params["replace_gap_sec"] is None
    assert record.params["pad_samples"] == []
    assert all(clip.source_id is None for clip in edited.clips)
    assert primary_spans(edited) == [
        pytest.approx((0, 0.3, 0)),
        pytest.approx((4.45, 6, 0.3)),
    ]
    assert edited.timeline.duration_sec == pytest.approx(1.85)
    effects = record.params["edge_fades"]
    assert [(edge["track_id"], edge["source_id"], edge["side"]) for edge in effects] == [
        ("host", None, "left"),
        ("host", None, "right"),
    ]
    for edge in effects:
        assert all(
            math.isfinite(edge[key])
            for key in ("source_sec", "timeline_sec", "source_start", "source_end", "milliseconds")
        )
        assert 0 < edge["milliseconds"] <= 150
        assert edge["source_end"] - edge["source_start"] == pytest.approx(
            edge["milliseconds"] / 1000
        )
        assert edge["timeline_sec"] == pytest.approx(0.3)
    assert effects[0]["source_sec"] == pytest.approx(0.3)
    assert effects[1]["source_sec"] == pytest.approx(4.45)
    left, right = sorted(edited.clips, key=lambda clip: clip.timeline_start)
    assert left.fade_out_ms == effects[0]["milliseconds"]
    assert right.fade_in_ms == effects[1]["milliseconds"]


@pytest.mark.parametrize("delivery", ["saved", "automatic", "suggested"])
def test_saved_remove_uses_ripple_policy_after_current_proposal_mode_changes_to_mute(
    tmp_path, monkeypatch, delivery
):
    cfg = defaults(acoustic=False)
    cfg["tighten"]["edit_mode"] = "mute"
    configure(monkeypatch, cfg)
    monkeypatch.setattr("podcast_mcp.edits.source_removals.load_defaults", lambda: cfg)
    original_config = copy.deepcopy(cfg)
    ws = workspace(_stored_remove(tmp_path, db=-40))
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    if delivery == "suggested":
        edited = ws.project.model_copy(deep=True)
        assert apply_for_suggested(edited, resolve_pending_preview(edited, "stored-remove")) == (
            pytest.approx(1.05)
        )
        assert files(tmp_path) == before_files
        assert ws.project.model_dump(mode="json") == before_model
    else:
        service = EditService(ws)
        applied = (
            service.approve(["stored-remove"]) if delivery == "saved" else service.apply_auto()
        )
        if delivery == "automatic":
            assert applied == 0
            assert files(tmp_path) == before_files
            assert ws.project.model_dump(mode="json") == before_model
            assert load_project(ws.path).model_dump(mode="json") == before_model
            assert cfg == original_config
            return
        assert applied == 1
        edited = load_project(ws.path)
    _assert_original_splice(
        edited, operation="apply_prefix_edits" if delivery == "automatic" else "approve_edits"
    )
    assert cfg == original_config
    assert files(tmp_path)["raw/host.wav"] == before_files["raw/host.wav"]


def test_explicit_stored_mute_still_keeps_time_and_has_no_ripple_effects(tmp_path, monkeypatch):
    cfg = defaults(acoustic=False)
    cfg["tighten"]["edit_mode"] = "mute"
    configure(monkeypatch, cfg)
    result = _stored_remove(tmp_path, db=-40)
    edit = result.edit_decisions[0]
    edit.type = EditDecisionType.MUTE
    edit.reason = "filler:um"
    ws = workspace(result)
    before_spans = primary_spans(ws.project)
    assert EditService(ws).approve(["stored-remove"]) == 1
    saved = load_project(ws.path)
    assert primary_spans(saved) == before_spans == [(0, 6, 0)]
    assert saved.timeline.duration_sec == 6
    assert saved.edit_decisions == []
    assert saved.clips[0].mute_regions
    record = saved.editorial.edit_log[0]
    assert record.params["mute"] is True
    assert "edge_fades" not in record.params


def _fresh_join_review(monkeypatch, *, independent=False):
    cfg = defaults(acoustic=True)
    cfg["tighten"].update(leave_in_if_risky=True, join_continuity_gate=True)
    configure(monkeypatch, cfg)
    observed = []

    def verdict(_project, track_id, cut_start, cut_end, **kwargs):
        observed.append((track_id, cut_start, cut_end, kwargs["timebase"]))
        return SimpleNamespace(verdict="pass" if independent and cut_start > 5 else "review")

    monkeypatch.setattr("podcast_mcp.edits.join_continuity.assess_proposed_cut", verdict)
    return observed


def test_fresh_automatic_join_review_holds_before_any_saved_mutation(tmp_path, monkeypatch):
    observed = _fresh_join_review(monkeypatch)
    ws = workspace(_stored_remove(tmp_path, seed=1512))
    before_files = files(tmp_path)
    before_model = ws.project.model_dump(mode="json")
    assert ws.project.edit_decisions[0].review_required is False
    assert EditService(ws).apply_auto() == 0
    assert ("host", pytest.approx(0.3), pytest.approx(4.45), "source") in observed
    assert files(tmp_path) == before_files
    assert ws.project.model_dump(mode="json") == before_model
    saved = load_project(ws.path)
    assert saved.model_dump(mode="json") == before_model
    assert primary_spans(saved) == [(0, 6, 0)]
    assert saved.editorial.edit_log == []
    assert [edit.id for edit in saved.edit_decisions] == ["stored-remove"]
    assert saved.edit_decisions[0].review_required is False


def test_explicitly_selected_manual_approval_keeps_its_fresh_review_authorization(
    tmp_path, monkeypatch
):
    observed = _fresh_join_review(monkeypatch)
    ws = workspace(_stored_remove(tmp_path, seed=1512))
    assert ws.project.edit_decisions[0].review_required is False
    assert EditService(ws).approve(["stored-remove"]) == 1
    assert ("host", pytest.approx(0.3), pytest.approx(4.45), "source") in observed
    _assert_original_splice(load_project(ws.path), operation="approve_edits")


def test_fresh_review_hold_does_not_prevent_an_independent_auto_survivor(tmp_path, monkeypatch):
    observed = _fresh_join_review(monkeypatch, independent=True)
    result = _stored_remove(tmp_path, seconds=12, seed=1512)
    result.edit_decisions.append(pause("independent", start=5.4, end=10.7, gap=None))
    ws = workspace(result)
    held_row = ws.project.edit_decisions[0].model_dump(mode="json")
    raw = (tmp_path / "raw/host.wav").read_bytes()
    assert EditService(ws).apply_auto() == 1
    saved = load_project(ws.path)
    assert [edit.model_dump(mode="json") for edit in saved.edit_decisions] == [held_row]
    assert [record.decision_ids for record in saved.editorial.edit_log] == [["independent"]]
    record = saved.editorial.edit_log[0]
    assert (record.source_start, record.source_end) == pytest.approx((5.4, 10.45))
    assert record.params["loss_sec"] == pytest.approx(5.05)
    assert record.params["replace_gap_sec"] is None
    assert len(record.params["edge_fades"]) == 2
    assert primary_spans(saved) == [
        pytest.approx((0, 5.4, 0)),
        pytest.approx((10.45, 12, 5.4)),
    ]
    assert ("host", pytest.approx(0.3), pytest.approx(4.45), "source") in observed
    assert ("host", pytest.approx(5.4), pytest.approx(10.45), "source") in observed
    stable_files = files(tmp_path)
    stable_model = ws.project.model_dump(mode="json")
    assert EditService(ws).apply_auto() == 0
    assert files(tmp_path) == stable_files
    assert ws.project.model_dump(mode="json") == stable_model
    assert (tmp_path / "raw/host.wav").read_bytes() == raw
