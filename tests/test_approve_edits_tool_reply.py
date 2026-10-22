"""approve_edits_tool replies the ids it approved, so ids always matches approved_count (#2026)."""

from __future__ import annotations

import json

from podcast_mcp.edits import cut_application
from podcast_mcp.edits.cut_speech import UnconfirmedCutSpeech
from podcast_mcp.mcp.tools import edits as edits_tools
from podcast_mcp.mcp.tools.edits import approve_edits_tool
from podcast_mcp.models import EditDecision, EditDecisionType, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document import edit as edit_service
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


def _pend(path, *edits):
    project = load_project(path)
    project.edit_decisions = list(edits)
    save_project(project)


def _pending_ids(path):
    return [e.id for e in EditService(ProjectWorkspace.open(path)).list_decisions(applied=False)]


def _assert_ids_match(path, reply):
    assert reply["approved_count"] == len(reply["ids"])
    pending = _pending_ids(path)
    assert not set(reply["ids"]) & set(pending)
    for held in reply["held"]:
        assert held["id"] in pending
    for confirm_id in reply.get("confirm_ids", []):
        assert confirm_id in pending


def test_held_cut_is_not_in_the_replied_ids(episode):
    _pend(
        episode, _remove("a", 10.0, 11.0, scope="session"), _remove("b", 2.0, 2.5, scope="session")
    )

    reply = json.loads(approve_edits_tool(str(episode), ["a", "b"]))

    assert reply["ids"] == ["b"]
    assert reply["approved_count"] == 1
    assert reply["held"][0]["id"] == "a"
    _assert_ids_match(episode, reply)


def test_asked_cut_is_not_in_the_replied_ids(episode):
    _quiet_guest(episode)
    _pend(episode, _remove("a", 10.0, 11.0, scope="session"))
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
    _pend(
        episode,
        _remove("a", 10.0, 11.0, scope="session"),
        _remove("b", 11.02, 11.3, scope="session"),
    )

    reply = json.loads(approve_edits_tool(str(episode), ["a", "b"]))

    assert reply["ids"] == []
    assert reply["confirm_ids"] == ["a"]
    (held,) = reply["held"]
    assert held["id"] == "b"
    assert "waits with it" in held["reason"]
    _assert_ids_match(episode, reply)


def test_cut_rejected_while_the_call_runs_is_not_in_the_replied_ids(episode, monkeypatch):
    _pend(
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
    _pend(episode, _remove("r", 2.0, 2.5, scope="track"))
    assert json.loads(approve_edits_tool(str(episode), ["r"]))["ids"] == ["r"]
    _pend(
        episode,
        _remove("s", 2.1, 2.4, scope="track"),
        _remove("t", 5.0, 5.5, scope="track"),
    )

    reply = json.loads(approve_edits_tool(str(episode), ["s", "t"]))

    assert reply["ids"] == ["t"]
    assert reply["approved_count"] == 1
    assert reply["held"][0]["id"] == "s"
    assert reply["held"][0]["reason"] == "its audio was already cut away, so it no longer plays"
    _assert_ids_match(episode, reply)


def test_approve_all_replies_only_the_approved_subset(episode):
    _pend(
        episode, _remove("a", 10.0, 11.0, scope="session"), _remove("b", 2.0, 2.5, scope="session")
    )

    reply = json.loads(approve_edits_tool(str(episode), all_pending=True))

    assert reply["ids"] == ["b"]
    assert reply["approved_count"] == 1
    assert [h["id"] for h in reply["held"]] == ["a"]
    _assert_ids_match(episode, reply)


def test_unchanged_confirmation_is_replied_verbatim(episode, monkeypatch):
    """Defensive: unreachable through the real handler, because the tool always sends
    hold_blocked=True and the engine demotes every leaning cut before leaned_on is checked
    (cut_application.py:941-959)."""
    _quiet_guest(episode)
    _pend(episode, _remove("a", 10.0, 11.0, scope="session"))
    before = _geometry(episode)
    real = cut_application.approve_edits

    def leaning(project, ids, *, asked_out=None, **kwargs):
        asked = []
        real(project, ids, asked_out=asked, **kwargs)
        raise UnconfirmedCutSpeech(asked[0].confirmation)

    monkeypatch.setattr(cut_application, "approve_edits", leaning)
    monkeypatch.setattr(edit_service, "approve_edits", leaning)

    reply = json.loads(approve_edits_tool(str(episode), ["a"]))

    assert set(reply) == {"operation", "unchanged", "needs_confirmation", "apply_anyway"}
    assert reply["unchanged"] is True
    assert reply["needs_confirmation"]["message"] == GUEST_WORDS + CUT_REVIEW
    assert _geometry(episode) == before
    assert _pending_ids(episode) == ["a"]
