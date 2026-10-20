"""propose_edits says which proposals the approval's audio checks would hold (#1747)."""

from __future__ import annotations

import json

from pause_policy_public_helpers import workspace
from podcast_mcp.mcp.tools.edits import propose_edits
from podcast_mcp.models import load_project
from podcast_mcp.services.document import EditService
from test_approve_guard_blocked_ripple import _blocked_filler


def _proposal(tmp_path, monkeypatch):
    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    ws.project.edit_decisions = []
    return ws, decision


def test_a_proposal_the_approval_would_hold_is_not_offered_as_ready(tmp_path, monkeypatch):
    ws, _decision = _proposal(tmp_path, monkeypatch)

    proposal = EditService(ws).propose_tighten()
    payload = proposal.to_payload()

    (edit,) = payload["edits"]
    assert edit["audio_check"]["status"] == "held"
    assert "Guest is speaking" in edit["audio_check"]["reason"]
    assert "1 of them the audio checks would hold" in payload["summary"]
    # The check runs on a scratch copy: the proposal stays pending and nothing is applied.
    assert [e.applied for e in ws.project.edit_decisions] == [False]


def test_the_mcp_tool_returns_the_same_check(tmp_path, monkeypatch):
    ws, _decision = _proposal(tmp_path, monkeypatch)

    reply = json.loads(propose_edits(str(ws.path)))

    assert [e["audio_check"]["status"] for e in reply["edits"]] == ["held"]
    assert load_project(ws.path).edit_decisions[0].applied is False


def test_a_proposal_the_approval_accepts_says_clean(tmp_path, monkeypatch):
    ws, _decision = _proposal(tmp_path, monkeypatch)
    monkeypatch.setattr(EditService, "held_by_checks", lambda self, ids=None: ([], []))

    payload = EditService(ws).propose_tighten().to_payload()

    assert [e["audio_check"] for e in payload["edits"]] == [{"status": "clean"}]
    assert "would hold" not in payload["summary"]


def test_an_unreadable_check_never_claims_clean(tmp_path, monkeypatch):
    ws, _decision = _proposal(tmp_path, monkeypatch)

    def unreadable(self, ids=None):
        raise OSError("decode failed")

    monkeypatch.setattr(EditService, "held_by_checks", unreadable)

    payload = EditService(ws).propose_tighten().to_payload()

    assert len(payload["edits"]) == 1
    assert "audio_check" not in payload["edits"][0]
