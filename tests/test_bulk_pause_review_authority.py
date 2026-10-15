from __future__ import annotations

from types import SimpleNamespace

import pytest

from pause_policy_public_helpers import primary_spans, workspace
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.models import EditDecisionType, load_project
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document_sync import (
    host_command_result,
    submit_host_document_command,
)
from test_pause_current_operation_contract import (
    _assert_original_splice,
    _fresh_join_review,
    _stored_remove,
)


@pytest.mark.parametrize("filtered_ids", [None, ["stored-remove"]])
def test_bulk_leaves_a_fresh_pause_review_pending_without_writing(
    tmp_path, monkeypatch, filtered_ids
):
    observed = _fresh_join_review(monkeypatch)
    ws = workspace(_stored_remove(tmp_path, seed=1512))
    before_audio = (tmp_path / "raw/host.wav").read_bytes()
    assert ws.project.edit_decisions[0].review_required is False

    result = EditService(ws).apply_suggested_actions(filtered_ids)

    assert result["held"] == ["stored-remove"]
    assert result["applied"] == {}
    assert ("host", pytest.approx(0.3), pytest.approx(4.45), "source") in observed
    assert (tmp_path / "raw/host.wav").read_bytes() == before_audio
    saved = load_project(ws.path)
    assert primary_spans(saved) == [(0, 6, 0)]
    assert saved.editorial.edit_log == []
    assert [(e.id, e.review_required) for e in saved.edit_decisions] == [("stored-remove", False)]


def test_safe_bulk_approves_a_pause_that_passes_the_current_join_check(tmp_path, monkeypatch):
    observed = _fresh_join_review(monkeypatch)

    def passed(_project, track_id, cut_start, cut_end, **kwargs):
        observed.append((track_id, cut_start, cut_end, kwargs["timebase"]))
        return SimpleNamespace(verdict="pass")

    monkeypatch.setattr("podcast_mcp.edits.join_continuity.assess_proposed_cut", passed)
    ws = workspace(_stored_remove(tmp_path, seed=1512))
    result = EditService(ws).apply_suggested_actions()
    assert result["applied"] == {"shorten": 1}
    assert result["held"] == []
    assert ("host", pytest.approx(0.3), pytest.approx(4.45), "source") in observed
    _assert_original_splice(load_project(ws.path), operation="approve_edits")


@pytest.mark.parametrize("allow_review", [None, True])
def test_selected_approval_keeps_fresh_review_authority(tmp_path, monkeypatch, allow_review):
    observed = _fresh_join_review(monkeypatch)
    ws = workspace(_stored_remove(tmp_path, seed=1512))
    kwargs = {} if allow_review is None else {"allow_review": allow_review}
    assert EditService(ws).approve(["stored-remove"], **kwargs) == 1
    assert ("host", pytest.approx(0.3), pytest.approx(4.45), "source") in observed
    _assert_original_splice(load_project(ws.path), operation="approve_edits")


def test_bulk_applies_a_mute_and_leaves_the_pause_that_needs_fresh_review(tmp_path, monkeypatch):
    _fresh_join_review(monkeypatch)
    result = _stored_remove(tmp_path, seed=1512)
    result.edit_decisions.append(
        result.edit_decisions[0].model_copy(
            update={
                "id": "safe-mute",
                "type": EditDecisionType.MUTE,
                "start": 5.4,
                "end": 5.8,
                "reason": "filler:um",
            }
        )
    )
    ws = workspace(result)

    out = EditService(ws).apply_suggested_actions(["safe-mute", "stored-remove"])

    assert out["held"] == ["stored-remove"]
    assert out["applied"] == {"cut": 1}
    saved = load_project(ws.path)
    assert primary_spans(saved) == [(0, 6, 0)]
    assert len(saved.clips[0].mute_regions) == 1
    assert [e.id for e in saved.edit_decisions] == ["stored-remove"]


def test_bulk_mute_keeps_its_ordinary_timeline_behavior(tmp_path, monkeypatch):
    _fresh_join_review(monkeypatch)
    result = _stored_remove(tmp_path, seed=1512)
    result.edit_decisions[0].type = EditDecisionType.MUTE
    result.edit_decisions[0].reason = "filler:um"
    ws = workspace(result)

    assert EditService(ws).apply_suggested_actions()["applied"] == {"cut": 1}

    saved = load_project(ws.path)
    assert primary_spans(saved) == [(0, 6, 0)]
    assert saved.timeline.duration_sec == 6
    assert saved.edit_decisions == []
    assert len(saved.clips[0].mute_regions) == 1
    record = saved.editorial.edit_log[0]
    assert record.decision_ids == ["stored-remove"]
    assert record.params["mute"] is True
    assert "edge_fades" not in record.params


@pytest.mark.parametrize("confirm_cut_speech", [False, True])
def test_normal_document_command_preserves_bulk_review_refusal(
    tmp_path, monkeypatch, confirm_cut_speech
):
    observed = _fresh_join_review(monkeypatch)
    ws = workspace(_stored_remove(tmp_path, seed=1512))
    before_model = ws.project.model_dump(mode="json")
    before_file = ws.path.read_bytes()
    before_audio = (tmp_path / "raw/host.wav").read_bytes()
    assert ws.project.edit_decisions[0].review_required is False

    with pytest.raises(ScopeChangedAtApproval) as held:
        submit_host_document_command(
            ws.path,
            "ApproveEdits",
            {
                "ids": ["stored-remove"],
                "allow_review": False,
                "confirm_cut_speech": confirm_cut_speech,
            },
        )

    assert held.value.ids == ("stored-remove",)
    assert [(h.reason, h.detail) for h in held.value.held] == [("pause_join", "review_required")]
    assert ("host", pytest.approx(0.3), pytest.approx(4.45), "source") in observed
    assert ws.path.read_bytes() == before_file
    assert (tmp_path / "raw/host.wav").read_bytes() == before_audio
    saved = load_project(ws.path)
    assert saved.model_dump(mode="json") == before_model
    assert primary_spans(saved) == [(0, 6, 0)]
    assert saved.editorial.edit_log == []
    assert [(e.id, e.review_required) for e in saved.edit_decisions] == [("stored-remove", False)]


@pytest.mark.parametrize("allow_review", [None, True])
def test_normal_selected_document_command_retains_review_authority(
    tmp_path, monkeypatch, allow_review
):
    observed = _fresh_join_review(monkeypatch)
    ws = workspace(_stored_remove(tmp_path, seed=1512))
    payload = {"ids": ["stored-remove"]}
    if allow_review is not None:
        payload["allow_review"] = allow_review

    reply = submit_host_document_command(ws.path, "ApproveEdits", payload)

    assert host_command_result(reply) == {"count": 1}
    assert ("host", pytest.approx(0.3), pytest.approx(4.45), "source") in observed
    _assert_original_splice(load_project(ws.path), operation="approve_edits")


def test_bulk_applies_a_filler_cut_right_beside_a_pause_it_holds(tmp_path, monkeypatch):
    _fresh_join_review(monkeypatch)
    result = _stored_remove(tmp_path, seed=1512)
    result.edit_decisions.append(
        result.edit_decisions[0].model_copy(
            update={"id": "next-filler", "start": 4.5, "end": 4.8, "reason": "filler:um"}
        )
    )
    ws = workspace(result)

    out = EditService(ws).apply_suggested_actions()

    assert out["held"] == ["stored-remove"]
    assert out["applied"] == {"cut": 1}
    assert [e.id for e in load_project(ws.path).edit_decisions] == ["stored-remove"]
