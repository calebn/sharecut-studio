"""Unsure words (#2293 gap 3): one server-owned line, a flag per word, a list per cut, a bulk guard."""

from __future__ import annotations

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.config.defaults import bundled_defaults, unsure_word_confidence
from podcast_mcp.edits.transcript_correct import list_low_confidence
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE, build_refine_brief
from podcast_mcp.edits.unsure_words import is_unsure_word, unsure_words_by_edit
from podcast_mcp.gui.assembler import ViewProjection, build_project_view, dump_project_projection
from podcast_mcp.gui.mapper import map_pending_edits_to_timeline
from podcast_mcp.models import (
    EditDecision,
    EditDecisionType,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import HistoryService, TranscriptService
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.document_sync.handlers import edits as handlers
from podcast_mcp.services.document_sync.host_submit import host_command_result
from podcast_mcp.services.document_sync.payloads import ApproveEditsPayload
from source_review_helpers import _cut, _project

pytestmark = pytest.mark.refine_gate

# word index: (text, start, confidence)
WORDS = [
    ("so", 0.5, 0.95),
    ("uncle", 3.0, 0.4),
    ("said", 3.5, 0.95),
    ("fine", 4.0, 0.95),
    ("well", 5.0, 0.69),
    ("okay", 5.5, 0.7),
]


def _words(overrides: dict[int, dict] | None = None) -> list[TranscriptWord]:
    out = []
    for i, (text, start, conf) in enumerate(WORDS):
        fields = {"text": text, "start": start, "end": start + 0.3, "confidence": conf}
        fields.update((overrides or {}).get(i, {}))
        out.append(TranscriptWord(**fields))
    return out


def _open(tmp_path, cuts=None, words=None) -> ProjectWorkspace:
    project = _project(tmp_path)
    project.transcripts = [Transcript(track_id="host", words=words or _words())]
    project.edit_decisions = cuts or [
        _cut("clean", 4.0, 4.4, review_required=True),  # "fine" only
        _cut("uncle", 3.0, 3.2, review_required=True),  # inside the 0.4 word
        _cut("edge", 3.3, 3.45, review_required=True),  # starts where "uncle" ends: half-open
    ]
    REFINE_GATE.mark_done(project, notes="Known synthetic transcript fixture; no real-project test")
    return ProjectWorkspace.open(save_project(project))


def _history_len(ws: ProjectWorkspace) -> int:
    return len(HistoryService(ProjectWorkspace.open(ws.path)).list_entries().entries)


# --- the one line -------------------------------------------------------------------------


def test_the_shipped_line_is_seven_tenths_and_only_a_config_key():
    assert bundled_defaults()["analysis"]["unsure_word_confidence"] == 0.7
    assert unsure_word_confidence() == 0.7
    assert unsure_word_confidence({"analysis": {"unsure_word_confidence": 0.5}}) == 0.5
    # A merged config without the key reads the shipped default, not a second constant.
    assert unsure_word_confidence({"analysis": {}}) == 0.7


@pytest.mark.parametrize("bad", [-0.1, 1.5])
def test_a_line_outside_zero_to_one_is_refused(bad):
    with pytest.raises(ValueError, match=r"0\.\.1"):
        unsure_word_confidence({"analysis": {"unsure_word_confidence": bad}})


def test_a_word_is_unsure_below_the_line_unless_suppressed_or_unscored():
    word = TranscriptWord(text="a", start=0, end=1, confidence=0.69)
    assert is_unsure_word(word, 0.7)
    assert not is_unsure_word(word.model_copy(update={"confidence": 0.7}), 0.7)
    assert not is_unsure_word(word.model_copy(update={"confidence": None}), 0.7)
    assert not is_unsure_word(word.model_copy(update={"suppressed": True}), 0.7)
    assert not is_unsure_word(word.model_copy(update={"confidence": 1.0}), 0.7)


def test_list_brief_flag_and_edit_list_all_follow_the_config_key(tmp_path, monkeypatch):
    ws = _open(tmp_path)
    project = load_project(ws.path)
    shipped = ws.effective_config()
    assert [w["word_index"] for w in list_low_confidence(project, 0.7)] == [1, 4]
    assert build_refine_brief(project, shipped)["low_confidence_open_words"] == 2

    loose = {**shipped, "analysis": {**shipped["analysis"], "unsure_word_confidence": 0.5}}
    monkeypatch.setattr(ProjectWorkspace, "effective_config", lambda self: loose)
    assert build_refine_brief(project, loose)["low_confidence_open_words"] == 1
    assert [w["word_index"] for w in TranscriptService(ws).low_confidence_words()] == [1]
    view = build_project_view(ws)
    flagged = [
        w["word_index"] for u in view.transcript["utterances"] for w in u["words"] if w["unsure"]
    ]
    assert flagged == [1]
    by_id = {e["id"]: e for e in view.pending_edits}
    assert by_id["uncle"]["unsure_count"] == 1
    # "well" (0.69) is clean at 0.5, so a cut over it would carry none.
    assert unsure_words_by_edit(project, [_cut("w", 5.0, 5.2)], 0.5)["w"] == []
    assert len(unsure_words_by_edit(project, [_cut("w", 5.0, 5.2)], 0.7)["w"]) == 1


def test_the_cli_and_tool_default_to_the_config_line(tmp_path):
    ws = _open(tmp_path)
    assert [w["word_index"] for w in TranscriptService(ws).low_confidence_words()] == [1, 4]
    assert [w["word_index"] for w in TranscriptService(ws).low_confidence_words(0.5)] == [1]
    out = CliRunner().invoke(app, ["transcript", "review", "--project", str(ws.path)])
    assert out.exit_code == 0, out.output
    assert out.output.count('"word_index"') == 2


# --- per word and per edit view -----------------------------------------------------------


def test_mapped_words_carry_the_unsure_flag_and_guests_keep_it(tmp_path):
    ws = _open(tmp_path)
    view = build_project_view(ws)
    words = {w["word_index"]: w for u in view.transcript["utterances"] for w in u["words"]}
    assert {i: w["unsure"] for i, w in words.items()} == {
        0: False,
        1: True,
        2: False,
        3: False,
        4: True,
        5: False,
    }
    detail = dump_project_projection(ws, projection=ViewProjection.DETAIL)
    assert any(w["unsure"] for u in detail["transcript"]["utterances"] for w in u["words"])
    from podcast_mcp.gui.mapper import guest_transcript

    shown = guest_transcript(detail["transcript"], words=True)
    assert any(w["unsure"] for u in shown["utterances"] for w in u["words"])


def test_a_suppressed_word_is_not_unsure_in_the_view(tmp_path):
    ws = _open(tmp_path, words=_words({1: {"suppressed": True}}))
    view = build_project_view(ws)
    assert not any(
        w["unsure"]
        for u in view.transcript["utterances"]
        for w in u.get("words", [])
        if w["word_index"] == 1
    )


def test_each_pending_cut_lists_the_unsure_words_it_covers(tmp_path):
    ws = _open(tmp_path)
    rows = {r["id"]: r for r in build_project_view(ws).pending_edits}
    assert rows["clean"]["unsure_words"] == [] and rows["clean"]["unsure_count"] == 0
    assert rows["edge"]["unsure_count"] == 0
    assert rows["uncle"]["unsure_count"] == 1
    assert rows["uncle"]["unsure_words"] == [
        {
            "track_id": "host",
            "source_id": None,
            "word_index": 1,
            "text": "uncle",
            "confidence": 0.4,
        }
    ]


def test_a_cut_over_several_unsure_words_lists_them_in_word_order(tmp_path):
    ws = _open(tmp_path, cuts=[_cut("wide", 2.9, 5.4, review_required=True)])
    row = build_project_view(ws).pending_edits[0]
    assert [w["word_index"] for w in row["unsure_words"]] == [1, 4]
    assert row["unsure_count"] == 2


def test_timeline_cuts_and_exact_ranges_name_no_transcript_words(tmp_path):
    ws = _open(tmp_path)
    project = load_project(ws.path)
    blade = EditDecision(
        id="blade",
        track_id="host",
        type=EditDecisionType.SPLIT,
        start=3.1,
        end=3.1,
        timebase="timeline",
    )
    assert unsure_words_by_edit(project, [blade], 0.7) == {"blade": []}


def test_the_mapper_without_a_verdict_adds_no_unsure_keys(tmp_path):
    ws = _open(tmp_path)
    project = load_project(ws.path)
    row = map_pending_edits_to_timeline(project, project.edit_decisions)[0]
    assert "unsure_words" not in row and "unsure_count" not in row


def test_the_cut_view_is_linear_in_the_cuts(tmp_path):
    # 2000 words, every 7th unsure, 1000 cuts: one index per transcript, a lookup per cut.
    words = [
        TranscriptWord(
            text=f"w{i}", start=i * 0.1, end=i * 0.1 + 0.08, confidence=0.3 if i % 7 == 0 else 0.9
        )
        for i in range(2000)
    ]
    project = _project(tmp_path)
    project.transcripts = [Transcript(track_id="host", words=words)]
    cuts = [_cut(f"c{i}", i * 0.2, i * 0.2 + 0.15) for i in range(1000)]
    found = unsure_words_by_edit(project, cuts, 0.7)
    expected = {
        c.id: [
            i
            for i, w in enumerate(words)
            if w.confidence < 0.7 and w.start < c.end and w.end > c.start
        ]
        for c in cuts
    }
    assert {k: [w["word_index"] for w in v] for k, v in found.items()} == expected


# --- the bulk guard -----------------------------------------------------------------------


def test_skip_unsure_holds_the_cut_over_an_unsure_word_and_applies_the_rest(tmp_path):
    ws = _open(tmp_path)
    steps = _history_len(ws)

    result = handlers.approve_edits(
        ws, {"ids": ["clean", "uncle", "edge"], "hold_blocked": True, "skip_unsure": True}
    )

    assert result["count"] == 2
    assert result["held"] == [
        {"id": "uncle", "label": "Host's cut at 0:03.0", "reason": "unsure_word"}
    ]
    assert sorted(result["approved_ids"]) == ["clean", "edge"]
    saved = load_project(ws.path)
    assert [(e.id, e.applied) for e in saved.edit_decisions] == [("uncle", False)]
    assert _history_len(ws) - steps == 2  # one before/after pair for the whole bulk approve


def test_without_the_flag_the_same_batch_cuts_the_unsure_word(tmp_path):
    ws = _open(tmp_path)
    result = handlers.approve_edits(ws, {"ids": ["clean", "uncle", "edge"], "hold_blocked": True})
    assert result["count"] == 3 and result["held"] == []
    assert load_project(ws.path).edit_decisions == []


def test_a_single_named_cut_over_an_unsure_word_still_cuts(tmp_path):
    ws = _open(tmp_path)
    result = handlers.approve_edits(ws, {"ids": ["uncle"], "hold_blocked": True})
    assert result["count"] == 1 and result["held"] == []


def test_skip_unsure_alone_reports_what_it_held(tmp_path):
    ws = _open(tmp_path)
    result = handlers.approve_edits(ws, {"ids": ["clean", "uncle"], "skip_unsure": True})
    assert result["count"] == 1
    assert [h["id"] for h in result["held"]] == ["uncle"]
    assert result["approved_ids"] == ["clean"]


def test_when_every_cut_is_held_nothing_is_saved_or_stepped(tmp_path):
    ws = _open(
        tmp_path,
        cuts=[_cut("a", 3.0, 3.2, review_required=True), _cut("b", 5.0, 5.2, review_required=True)],
    )
    before, steps = ws.path.read_bytes(), _history_len(ws)
    result = handlers.approve_edits(
        ws, {"ids": ["a", "b"], "hold_blocked": True, "skip_unsure": True}
    )
    assert result["count"] == 0
    assert [h["id"] for h in result["held"]] == ["a", "b"]
    assert result["approved_ids"] == []
    assert ws.path.read_bytes() == before
    assert _history_len(ws) == steps


def test_the_guard_reads_the_saved_words_not_the_clients_view(tmp_path):
    # The client saw "fine" as clean; a re-transcription since lowered it. The guard still holds.
    ws = _open(tmp_path)
    stale_view = build_project_view(ws).pending_edits
    assert {r["id"]: r["unsure_count"] for r in stale_view}["clean"] == 0
    project = load_project(ws.path)
    project.transcripts[0].words[3].confidence = 0.2
    save_project(project)

    result = handlers.approve_edits(
        ProjectWorkspace.open(ws.path),
        {"ids": ["clean", "edge"], "hold_blocked": True, "skip_unsure": True},
    )

    assert [h["id"] for h in result["held"]] == ["clean"]
    assert result["approved_ids"] == ["edge"]


def test_a_confirmed_word_no_longer_holds_its_cut(tmp_path):
    ws = _open(tmp_path)
    TranscriptService(ws).correct_word("host", 1, "uncle")
    result = handlers.approve_edits(
        ProjectWorkspace.open(ws.path),
        {"ids": ["clean", "uncle"], "hold_blocked": True, "skip_unsure": True},
    )
    assert result["held"] == [] and result["count"] == 2


def test_the_payload_defaults_the_flag_off_and_documents_it():
    assert ApproveEditsPayload(ids=["a"]).skip_unsure is False
    field = ApproveEditsPayload.model_fields["skip_unsure"]
    assert "unsure" in (field.description or "")


def test_the_reason_is_the_wire_value_the_tools_compare_to():
    from podcast_mcp.edits.decisions import UNSURE_WORD_REASON

    assert UNSURE_WORD_REASON == "unsure_word"


# --- who may bypass it ---------------------------------------------------------------------


def _guest(ids: list[str], **extra) -> DocumentCommand:
    return DocumentCommand(
        type="ApproveEdits",
        payload={"ids": ids, **extra},
        client_id="guest",
        client_seq=None,
        role="guest",
    )


def test_an_editor_guest_cannot_cut_unsure_words_in_bulk_by_leaving_the_flag_off(tmp_path):
    ws = _open(tmp_path)
    svc = DocumentSyncService.open(ws.path)
    outcome = svc.submit(
        _guest(["clean", "uncle"], skip_unsure=False),
        capabilities=capabilities_for_role("editor"),
        range_policy="apply",
    )
    assert [h["reason"] for h in host_command_result(outcome)["held"]] == ["unsure_word"]
    assert {e.id for e in load_project(ws.path).edit_decisions} == {"uncle", "edge"}


def test_an_editor_guest_naming_one_cut_still_cuts_it(tmp_path):
    ws = _open(tmp_path)
    svc = DocumentSyncService.open(ws.path)
    svc.submit(
        _guest(["uncle"]), capabilities=capabilities_for_role("editor"), range_policy="apply"
    )
    assert [e.id for e in load_project(ws.path).edit_decisions] == ["clean", "edge"]


def test_a_commenter_cannot_approve_at_all(tmp_path):
    ws = _open(tmp_path)
    svc = DocumentSyncService.open(ws.path)
    with pytest.raises(PermissionError, match="ApproveEdits"):
        svc.submit(
            _guest(["clean", "uncle"]),
            capabilities=capabilities_for_role("commenter"),
            range_policy="apply",
        )


def test_the_host_decides_for_itself(tmp_path):
    from podcast_mcp.services.document_sync.policy import must_skip_unsure

    assert must_skip_unsure(None, ["a", "b"], False) is False
    assert must_skip_unsure(None, ["a", "b"], True) is True
    assert must_skip_unsure(["edit"], ["a", "b"], False) is True
    assert must_skip_unsure(["edit"], ["a", "a"], False) is False
    assert must_skip_unsure(["edit"], ["a"], False) is False


# --- CLI and MCP ---------------------------------------------------------------------------


def test_cli_approve_all_leaves_unsure_cuts_pending_and_says_how_to_cut_one(tmp_path):
    ws = _open(tmp_path)
    done = CliRunner().invoke(app, ["edit", "approve", "--project", str(ws.path), "--all"])
    assert done.exit_code == 0, done.output
    assert "Approved 2 edit(s)." in done.output
    assert "Held uncle:" in done.output
    assert "--ids <id>" in done.output
    assert "override-audio-checks" not in done.output
    assert [e.id for e in load_project(ws.path).edit_decisions] == ["uncle"]


def test_cli_approve_one_id_cuts_the_unsure_word(tmp_path):
    ws = _open(tmp_path)
    done = CliRunner().invoke(app, ["edit", "approve", "--project", str(ws.path), "--ids", "uncle"])
    assert done.exit_code == 0, done.output
    assert "Approved 1 edit(s)." in done.output


def test_mcp_approve_all_pending_holds_unsure_cuts_without_the_override_hint(tmp_path):
    import json

    from podcast_mcp.mcp.tools.edits import approve_edits_tool

    ws = _open(tmp_path)
    out = json.loads(approve_edits_tool(str(ws.path), all_pending=True))
    assert out["approved_count"] == 2
    assert [(h["id"], h["reason"]) for h in out["held"]] == [("uncle", "unsure_word")]
    assert "apply_anyway" not in out
    single = json.loads(approve_edits_tool(str(ws.path), ids=["uncle"]))
    assert single["approved_count"] == 1 and single["held"] == []


def test_the_tool_descriptions_cite_the_config_key_not_a_number():
    from podcast_mcp.mcp.tools.edits import approve_edits_tool
    from podcast_mcp.mcp.tools.timeline import low_confidence_words_tool

    assert "analysis.unsure_word_confidence" in (low_confidence_words_tool.__doc__ or "")
    assert "analysis.unsure_word_confidence" in (approve_edits_tool.__doc__ or "")


# --- review fixes: guest word text, single-cut bulk ---------------------------------------


def _view_with_unsure_edit(tmp_path):
    return build_project_view(_open(tmp_path)).model_dump()


def test_a_guest_without_the_word_grant_gets_the_count_but_not_the_words(tmp_path):
    from podcast_mcp.services.collaboration.share import sanitize_guest_project_view

    view = _view_with_unsure_edit(tmp_path)
    assert any(r["unsure_words"] for r in view["pending_edits"])
    shown = sanitize_guest_project_view(view)
    rows = {r["id"]: r for r in shown["pending_edits"]}
    assert all("unsure_words" not in r for r in rows.values())
    assert rows["uncle"]["unsure_count"] == 1
    patch = sanitize_guest_project_view({"pending_edits": view["pending_edits"]})
    assert all("unsure_words" not in r for r in patch["pending_edits"])
    assert "uncle" not in str(shown["pending_edits"])


def test_a_guest_with_the_word_grant_keeps_the_per_cut_words(tmp_path):
    from podcast_mcp.services.collaboration.share import sanitize_guest_project_view

    view = _view_with_unsure_edit(tmp_path)
    shown = sanitize_guest_project_view(view, transcript_words=True)
    rows = {r["id"]: r for r in shown["pending_edits"]}
    assert rows["uncle"]["unsure_words"][0]["text"] == "uncle"


def test_cli_all_with_one_pending_unsure_cut_holds_it(tmp_path):
    ws = _open(tmp_path, cuts=[_cut("only", 3.0, 3.2, review_required=True)])
    done = CliRunner().invoke(app, ["edit", "approve", "--project", str(ws.path), "--all"])
    assert done.exit_code == 0, done.output
    assert "Approved 0 edit(s)." in done.output and "Held only:" in done.output
    assert [e.id for e in load_project(ws.path).edit_decisions] == ["only"]


def test_mcp_all_pending_with_one_pending_unsure_cut_holds_it(tmp_path):
    import json

    from podcast_mcp.mcp.tools.edits import approve_edits_tool

    ws = _open(tmp_path, cuts=[_cut("only", 3.0, 3.2, review_required=True)])
    out = json.loads(approve_edits_tool(str(ws.path), all_pending=True))
    assert out["approved_count"] == 0
    assert [h["reason"] for h in out["held"]] == ["unsure_word"]
