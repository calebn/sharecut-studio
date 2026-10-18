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
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.tighten import propose_tighten_edits
from podcast_mcp.mcp.tools.edits import approve_edits_tool
from podcast_mcp.models import CutIntent, EditDecisionType, TranscriptWord, load_project
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


def test_programmatic_approval_holds_and_changes_nothing(tmp_path, monkeypatch):
    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    before = ws.project.model_dump(mode="json")

    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve([decision.id])
    assert held.value.held[0].reason == "peer_speech"
    assert held.value.held[0].peers == ("guest",)
    assert ws.project.model_dump(mode="json") == before
    assert ws.project.editorial.edit_log == []


def test_confirmed_approval_ripples_every_dialogue_track_and_records_no_one_track_cut(
    tmp_path, monkeypatch
):
    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    service = EditService(ws)
    before = _lengths(ws.project)

    assert service.approve([decision.id], application_intent=CutIntent.HUMAN_BOUNDARIES) == 1

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


def test_programmatic_document_and_mcp_approval_cannot_override_peer_speech(tmp_path, monkeypatch):
    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)

    before = ws.project.model_dump(mode="json")
    for payload in ({"ids": [decision.id]}, {"ids": [decision.id], "confirm_cut_speech": True}):
        with pytest.raises(ScopeChangedAtApproval):
            approve_edits(ws, payload)
    reply = json.loads(approve_edits_tool(str(ws.path), [decision.id]))
    assert reply["approved_count"] == 0
    assert "Guest is speaking" in reply["held"][0]["reason"]
    assert ws.project.model_dump(mode="json") == before
    assert ws.project.editorial.edit_log == []
    assert (
        EditService(ws).approve([decision.id], application_intent=CutIntent.HUMAN_BOUNDARIES) == 1
    )


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


def test_audio_check_override_lets_programmatic_callers_approve_and_records_who(
    tmp_path, monkeypatch
):
    from podcast_mcp.edits.audio_check_override import audio_check_override

    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    with pytest.raises(ScopeChangedAtApproval):
        EditService(ws).approve([decision.id])

    with audio_check_override("cli:owner", "cli"):
        assert EditService(ws).approve([decision.id]) == 1

    saved = load_project(ws.path)
    (record,) = saved.editorial.edit_log
    assert record.params["audio_check_override"] == {
        "kind": "owner_override",
        "actor": "cli:owner",
        "surface": "cli",
    }
    assert saved.edit_decisions == [] or all(e.applied for e in saved.edit_decisions)


def test_cli_approve_names_the_override_and_all_applies_it(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    base = ["edit", "approve", "--project", str(ws.path)]
    runner = CliRunner()

    held = runner.invoke(app, [*base, "--all"])
    assert held.exit_code == 0, held.output
    assert "Approved 0 edit(s)." in held.output
    assert f"Held {decision.id}" in held.output
    assert "--override-audio-checks" in held.output
    assert load_project(ws.path).editorial.edit_log == []

    done = runner.invoke(app, [*base, "--all", "--override-audio-checks"])
    assert done.exit_code == 0, done.output
    assert "Approved 1 edit(s)." in done.output
    (record,) = load_project(ws.path).editorial.edit_log
    assert record.params["audio_check_override"]["surface"] == "cli"
    assert record.params["audio_check_override"]["actor"].startswith("cli:")


def test_cli_held_lists_what_the_checks_hold_and_changes_nothing(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    before = ws.path.read_bytes()

    out = CliRunner().invoke(app, ["edit", "held", "--project", str(ws.path), "--json"])

    assert out.exit_code == 0, out.output
    assert [row["id"] for row in json.loads(out.output)] == [decision.id]
    assert ws.path.read_bytes() == before
