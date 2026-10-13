"""Approving a filler a peer speaks over ripples every dialogue track behind Cut anyway (#1407)."""

from __future__ import annotations

import json

import pytest

from pause_policy_public_helpers import (
    configure,
    defaults,
    primary_spans,
    project,
    room,
    voice,
    workspace,
    write_wav,
)
from podcast_mcp.edits.cut_speech import CutSpeechConfirmation
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.mcp.tools.edits import approve_edits_tool
from podcast_mcp.models import EditDecisionType, TranscriptWord, load_project
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document_sync.handlers.edits import approve_edits


def _blocked_filler(tmp_path, monkeypatch, *, edit_mode: str = "ripple"):
    cfg = defaults()
    cfg["tighten"].update({"filler_words": ["um"], "max_pause_sec": 100})
    cfg["tighten"]["speech_energy_guard"].update({"enabled": True, "on_conflict": "review"})
    configure(monkeypatch, cfg)
    result = project(tmp_path, guest="quiet")
    result.transcripts[0].words.insert(1, TranscriptWord(text="um", start=1, end=1.5))
    host = room()
    for start, end in ((0, 0.2), (1.02, 1.46), (5, 5.2)):
        voice(host, start, end)
    write_wav(tmp_path / "raw" / "host.wav", host)
    peer = room(seed=1215)
    voice(peer, 1.1, 1.3)
    write_wav(tmp_path / "raw" / "guest.wav", peer)
    proposal = propose_tighten_edits(result, cfg, replace_existing=False, edit_mode=edit_mode)
    (decision,) = proposal.decisions
    return result, decision


def _lengths(saved) -> dict[str, float]:
    return {
        tid: max(
            c.timeline_start + (c.source_end - c.source_start)
            for c in saved.clips
            if c.track_id == tid
        )
        for tid in ("host", "guest")
    }


def test_a_filler_a_peer_speaks_over_waits_as_a_session_ripple_that_records_the_speech(
    tmp_path, monkeypatch
):
    _result, decision = _blocked_filler(tmp_path, monkeypatch)

    assert (decision.scope, decision.review_required) == ("session", True)
    assert "other_speaking:guest" in decision.reason
    assert decision.cut_speech is not None
    assert [t.track_id for t in decision.cut_speech.tracks] == ["guest"]


def test_approving_without_confirmation_asks_and_changes_nothing(tmp_path, monkeypatch):
    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    before = ws.project.model_dump(mode="json")

    asked = EditService(ws).approve([decision.id])

    assert isinstance(asked, CutSpeechConfirmation)
    assert (asked.status, asked.reason, asked.confirm_label) == (
        "needs_confirmation",
        "cuts_other_speech",
        "Cut anyway",
    )
    assert [t.track_id for t in asked.speech.tracks] == ["guest"]
    assert ws.project.model_dump(mode="json") == before
    assert ws.project.editorial.edit_log == []


def test_confirmed_approval_ripples_every_dialogue_track_and_records_no_one_track_cut(
    tmp_path, monkeypatch
):
    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    service = EditService(ws)
    before = _lengths(ws.project)

    assert service.approve([decision.id], confirm_cut_speech=True) == 1

    saved = load_project(ws.path)
    after = _lengths(saved)
    assert after["host"] == pytest.approx(after["guest"])
    assert after["host"] < before["host"]
    host_end, guest_end = primary_spans(saved, "host")[-1], primary_spans(saved, "guest")[-1]
    assert (guest_end[:2], guest_end[2]) == (
        pytest.approx((1.5, 6.0)),
        pytest.approx(host_end[2]),
    )
    (record,) = saved.editorial.edit_log
    assert record.decision_ids == [decision.id]
    assert sorted(record.track_ids) == ["guest", "host"]
    assert record.params["scope"] == "session"
    assert [t["track_id"] for t in record.params["cut_speech"]["tracks"]] == ["guest"]


def test_the_document_command_and_mcp_approve_ask_the_same_question(tmp_path, monkeypatch):
    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)

    gui = approve_edits(ws, {"ids": [decision.id]})
    agent = json.loads(approve_edits_tool(str(ws.path), [decision.id]))

    for asked in (gui, agent):
        assert asked["unchanged"] is True
        assert asked["needs_confirmation"]["confirm_field"] == "confirm_cut_speech"
        assert asked["needs_confirmation"]["confirm_label"] == "Cut anyway"
    assert ws.project.editorial.edit_log == []

    assert approve_edits(ws, {"ids": [decision.id], "confirm_cut_speech": True}) == {"count": 1}


def test_a_mute_a_peer_speaks_over_still_applies_in_place_without_asking(tmp_path, monkeypatch):
    result, decision = _blocked_filler(tmp_path, monkeypatch, edit_mode="mute")
    assert decision.type is EditDecisionType.MUTE
    assert decision.scope == "track"
    ws = workspace(result)
    before = _lengths(ws.project)

    assert EditService(ws).approve([decision.id]) == 1

    saved = load_project(ws.path)
    assert _lengths(saved) == pytest.approx(before)
    assert primary_spans(saved, "guest") == [pytest.approx((0, 6, 0))]
