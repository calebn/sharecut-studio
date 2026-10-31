"""Regression tests for #2026 and #2067."""

from __future__ import annotations

import json

import pytest

from podcast_mcp.edits import cut_application
from podcast_mcp.edits.cut_speech import UnconfirmedCutSpeech
from podcast_mcp.mcp.tools import edits as edits_tools
from podcast_mcp.mcp.tools.edits import approve_edits_tool
from podcast_mcp.models import EditDecision, EditDecisionType, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document import edit as edit_service
from podcast_mcp.util.coded_error import CodedValueError
from test_edit_modes import CUT_REVIEW, GUEST_WORDS, _geometry, _quiet_guest
from test_edit_modes import episode as _episode_fixture

episode = _episode_fixture


def _remove(edit_id, start, end, *, scope, boundary_mode="exact"):
    return EditDecision(
        id=edit_id,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        reason="filler:um",
        review_required=True,
        applied=False,
        scope=scope,
        boundary_mode=boundary_mode,
    )


def _set_decisions(path, *edits):
    project = load_project(path)
    project.edit_decisions = list(edits)
    save_project(project)


def _pending_ids(path):
    return sorted(d.id for d in load_project(path).edit_decisions if not d.applied)


def _assert_ids_match(path, reply):
    pending = _pending_ids(path)
    assert not set(reply["ids"]) & set(pending)
    for held in reply["held"]:
        assert held["id"] in pending
    for confirm_id in reply.get("confirm_ids", []):
        assert confirm_id in pending


def test_held_cut_is_not_in_the_replied_ids(episode):
    _set_decisions(
        episode, _remove("a", 10.0, 11.0, scope="session"), _remove("b", 2.0, 2.5, scope="session")
    )

    reply = json.loads(approve_edits_tool(str(episode), ["a", "b"]))

    assert reply["ids"] == ["b"]
    assert reply["approved_count"] == 1
    assert reply["held"][0]["id"] == "a"
    _assert_ids_match(episode, reply)


def test_asked_cut_is_not_in_the_replied_ids(episode):
    _quiet_guest(episode)
    _set_decisions(episode, _remove("a", 10.0, 11.0, scope="session"))
    before = _geometry(episode)

    reply = json.loads(approve_edits_tool(str(episode), ["a"]))

    assert reply["ids"] == []
    assert reply["approved_count"] == 0
    assert reply["confirm_ids"] == ["a"]
    assert reply["needs_confirmation"]["reason"] == "cuts_other_speech"
    assert reply["needs_confirmation"]["message"] == GUEST_WORDS + CUT_REVIEW
    assert "apply_anyway" in reply
    assert _geometry(episode) == before
    assert _pending_ids(episode) == ["a"]
    _assert_ids_match(episode, reply)


def test_cut_waiting_beside_the_asked_one_is_not_in_the_replied_ids(episode):
    _quiet_guest(episode)
    _set_decisions(
        episode,
        _remove("a", 10.0, 11.0, scope="session"),
        _remove("b", 11.02, 11.3, scope="session"),
    )

    reply = json.loads(approve_edits_tool(str(episode), ["a", "b"]))

    assert reply["ids"] == []
    assert reply["approved_count"] == 0
    assert reply["confirm_ids"] == ["a"]
    (held,) = reply["held"]
    assert held["id"] == "b"
    assert "waits with it" in held["reason"]
    _assert_ids_match(episode, reply)


def test_cut_rejected_just_before_the_apply_is_not_in_the_replied_ids(episode, monkeypatch):
    _set_decisions(
        episode,
        _remove("a", 2.0, 2.5, scope="track"),
        _remove("b", 5.0, 5.5, scope="track"),
        _remove("c", 14.0, 14.4, scope="track"),
    )
    real = edits_tools.submit_host_command_result

    def reject_first(path, *args, **kwargs):
        EditService(ProjectWorkspace.open(path)).reject(["b"])
        return real(path, *args, **kwargs)

    monkeypatch.setattr(edits_tools, "submit_host_command_result", reject_first)

    reply = json.loads(approve_edits_tool(str(episode), ["a", "b", "c"]))

    assert reply["ids"] == ["a", "c"]
    assert reply["approved_count"] == 2
    _assert_ids_match(episode, reply)


def test_held_cut_retired_as_unplayed_is_not_in_the_replied_ids(episode):
    _set_decisions(episode, _remove("r", 2.0, 2.5, scope="track"))
    assert json.loads(approve_edits_tool(str(episode), ["r"]))["ids"] == ["r"]
    _set_decisions(
        episode,
        _remove("s", 2.1, 2.4, scope="track"),
        _remove("t", 5.0, 5.5, scope="track"),
    )

    reply = json.loads(approve_edits_tool(str(episode), ["s", "t"]))

    assert reply["ids"] == ["t"]
    assert reply["approved_count"] == 1
    assert reply["held"][0]["id"] == "s"
    assert reply["held"][0]["reason"] == "its audio was already cut away, so it no longer plays"
    assert "t" not in _pending_ids(episode)


def test_approve_all_replies_only_the_approved_subset(episode):
    _set_decisions(
        episode, _remove("a", 10.0, 11.0, scope="session"), _remove("b", 2.0, 2.5, scope="session")
    )

    reply = json.loads(approve_edits_tool(str(episode), all_pending=True))

    assert reply["ids"] == ["b"]
    assert reply["approved_count"] == 1
    assert [h["id"] for h in reply["held"]] == ["a"]
    _assert_ids_match(episode, reply)


def test_duplicate_requested_ids_are_replied_once(episode):
    _set_decisions(episode, _remove("a", 2.0, 2.5, scope="track"))

    reply = json.loads(approve_edits_tool(str(episode), ["a", "a"]))

    assert reply["ids"] == ["a"]
    assert reply["approved_count"] == 1
    assert reply["held"] == []
    assert _pending_ids(episode) == []
    _assert_ids_match(episode, reply)


def test_unknown_requested_id_is_reported_beside_the_approved_ones(episode):
    _set_decisions(episode, _remove("a", 2.0, 2.5, scope="track"))

    reply = json.loads(approve_edits_tool(str(episode), ["a", "nope", "nope"]))

    assert reply["ids"] == ["a"]
    assert reply["unknown_ids"] == ["nope"]
    assert reply["approved_count"] == 1
    assert _pending_ids(episode) == []
    _assert_ids_match(episode, reply)


def test_every_requested_id_unknown_is_an_error_and_changes_nothing(episode):
    _set_decisions(episode, _remove("a", 2.0, 2.5, scope="track"))

    with pytest.raises(CodedValueError) as raised:
        approve_edits_tool(str(episode), ["nope", "gone"])

    assert raised.value.code == "approve_unknown_ids"
    assert "nope" in str(raised.value) and "gone" in str(raised.value)
    assert _pending_ids(episode) == ["a"]


def test_retrying_an_already_approved_id_is_not_unknown(episode):
    _set_decisions(episode, _remove("a", 2.0, 2.5, scope="track"))
    approve_edits_tool(str(episode), ["a"])

    reply = json.loads(approve_edits_tool(str(episode), ["a"]))

    assert reply["ids"] == []
    assert reply["unknown_ids"] == []
    assert reply["approved_count"] == 0


def test_reply_without_unknown_requested_ids_lists_none(episode):
    _set_decisions(episode, _remove("a", 2.0, 2.5, scope="track"))

    reply = json.loads(approve_edits_tool(str(episode), ["a"]))

    assert reply["unknown_ids"] == []


def test_approve_all_with_nothing_pending_replies_no_ids(episode):
    applied = _remove("done", 2.0, 2.5, scope="track")
    applied.applied = True
    unreviewed = _remove("auto", 5.0, 5.5, scope="track")
    unreviewed.review_required = False
    _set_decisions(episode, applied, unreviewed)

    reply = json.loads(approve_edits_tool(str(episode), all_pending=True))

    assert reply["ids"] == []
    assert reply["approved_count"] == 0
    assert reply["held"] == []


def test_unchanged_confirmation_is_replied_verbatim(episode, monkeypatch):
    """Defensive: unreachable through the real handler, because the tool always sends
    hold_blocked=True and the engine demotes every leaning cut before leaned_on is checked
    (cut_application.py:941-959)."""
    _quiet_guest(episode)
    _set_decisions(episode, _remove("a", 10.0, 11.0, scope="session"))
    before = _geometry(episode)
    real = cut_application.approve_edits

    def leaning(project, ids, *, asked_out=None, **kwargs):
        asked = []
        real(project, ids, asked_out=asked, **kwargs)
        raise UnconfirmedCutSpeech(asked[0].confirmation)

    monkeypatch.setattr(cut_application, "approve_edits", leaning)
    monkeypatch.setattr(edit_service, "approve_edits", leaning)

    reply = json.loads(approve_edits_tool(str(episode), ["a", "nope"]))

    assert set(reply) == {
        "operation",
        "unchanged",
        "needs_confirmation",
        "apply_anyway",
        "unknown_ids",
    }
    assert reply["unchanged"] is True
    assert reply["unknown_ids"] == ["nope"]
    assert reply["needs_confirmation"]["message"] == GUEST_WORDS + CUT_REVIEW
    assert _geometry(episode) == before
    assert _pending_ids(episode) == ["a"]
