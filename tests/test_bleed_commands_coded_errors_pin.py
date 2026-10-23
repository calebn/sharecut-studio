from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools import timeline
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.services.document_sync import (
    DocumentSyncService,
    submit_host_document_command,
)
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.util.coded_error import CodedValueError
from test_bleed_alignment_surfaces import _workspace

BAD_WORD = [{"nope": 1}]
GOOD_WORD = [{"track_id": "uncertain", "word_index": 0}]
WINDOW = {"track_id": "uncertain", "start_sec": 0.8, "end_sec": 3.5}


def _journal_types(path: Path) -> list[str]:
    return [row["type"] for row in DocumentSyncService.open(path).store.commands_after(0)]


def _plane_submit(ws, command_type: str, payload: dict) -> dict:
    command = DocumentCommand(
        type=command_type, payload=payload, client_id="pin", role="agent", client_seq=None
    )
    return DocumentSyncService(ws).submit(command)


def _conflict(excinfo) -> None:
    assert excinfo.value.code == "document_conflict"
    assert "target not found" in str(excinfo.value)


@pytest.mark.parametrize(
    "tool, field",
    [
        (timeline.apply_low_audibility_suppression_tool, "words"),
        (timeline.apply_bleed_suppression_tool, "words"),
        (timeline.apply_bleed_suppression_tool, "exclude_words"),
    ],
    ids=["low-words", "bleed-words", "bleed-exclude"],
)
def test_pins_today_mcp_malformed_word_item_is_document_conflict(tmp_path, tool, field):
    ws = _workspace(tmp_path)
    with pytest.raises(DocumentConflictError) as excinfo:
        tool(str(ws.path), **{field: BAD_WORD})
    _conflict(excinfo)
    assert _journal_types(ws.path) == []


@pytest.mark.parametrize("command_type", ["SuppressBleed", "SuppressLowAudibility"])
def test_pins_today_host_path_malformed_word_item_is_document_conflict(tmp_path, command_type):
    ws = _workspace(tmp_path)
    with pytest.raises(DocumentConflictError) as excinfo:
        submit_host_document_command(ws.path, command_type, {"words": BAD_WORD})
    _conflict(excinfo)
    assert _journal_types(ws.path) == []


@pytest.mark.parametrize("command_type", ["SuppressBleed", "SuppressLowAudibility"])
def test_pins_today_plane_malformed_word_item_is_document_conflict(tmp_path, command_type):
    ws = _workspace(tmp_path)
    with pytest.raises(DocumentConflictError) as excinfo:
        _plane_submit(ws, command_type, {"words": BAD_WORD})
    _conflict(excinfo)
    assert _journal_types(ws.path) == []


def test_pins_today_cli_malformed_words_json_is_a_bare_key_error(tmp_path):
    ws = _workspace(tmp_path)
    result = CliRunner().invoke(
        app,
        ["edit", "suppress-bleed", "--project", str(ws.path), "--words-json", json.dumps(BAD_WORD)],
    )
    assert result.exit_code == 1
    assert isinstance(result.exception, KeyError)
    assert result.exception.args == ("track_id",)
    assert _journal_types(ws.path) == []


def test_pins_today_mcp_invalid_mode_is_a_raw_validation_error(tmp_path):
    ws = _workspace(tmp_path)
    with pytest.raises(ValueError, match="SetBleedAlignmentModePayload") as excinfo:
        timeline.set_retained_bleed_alignment_mode_tool(str(ws.path), "d", "x")  # type: ignore[arg-type]
    assert not hasattr(excinfo.value, "code")
    assert type(excinfo.value).__name__ == "ValidationError"
    assert "Input should be 'auto', 'manual' or 'declined'" in str(excinfo.value)
    assert _journal_types(ws.path) == []


def test_pins_today_host_path_invalid_mode_is_a_raw_validation_error(tmp_path):
    ws = _workspace(tmp_path)
    with pytest.raises(ValueError, match="SetBleedAlignmentModePayload") as excinfo:
        submit_host_document_command(
            ws.path, "SetBleedAlignmentMode", {"decision_id": "d", "mode": "x"}
        )
    assert not hasattr(excinfo.value, "code")
    assert type(excinfo.value).__name__ == "ValidationError"
    assert _journal_types(ws.path) == []


def test_pins_today_plane_and_service_invalid_mode_is_coded_invalid_mode(tmp_path):
    ws = _workspace(tmp_path)
    message = "alignment mode must be auto, manual, or declined"
    with pytest.raises(CodedValueError, match=message) as plane:
        _plane_submit(ws, "SetBleedAlignmentMode", {"decision_id": "d", "mode": "x"})
    assert plane.value.code == "invalid_mode"
    with pytest.raises(CodedValueError, match=message) as service:
        AnalysisService(ws).set_bleed_alignment_mode("d", "x")  # type: ignore[arg-type]
    assert service.value.code == "invalid_mode"
    assert _journal_types(ws.path) == []


def test_pins_today_cli_invalid_mode_is_rejected_by_the_option_check(tmp_path):
    ws = _workspace(tmp_path)
    before = ws.path.read_bytes()
    result = CliRunner().invoke(
        app,
        [
            "edit",
            "bleed-alignment-choice",
            "--project",
            str(ws.path),
            "--decision",
            "d",
            "--mode",
            "x",
        ],
    )
    assert result.exit_code == 2
    assert "mode must be auto, manual, or declined" in result.output
    assert ws.path.read_bytes() == before
    assert _journal_types(ws.path) == []


def test_pins_today_cli_suppress_low_audibility_journals_no_row(tmp_path):
    ws = _workspace(tmp_path)
    result = CliRunner().invoke(app, ["edit", "suppress-low-audibility", "--project", str(ws.path)])
    assert result.exit_code == 0, result.output
    assert set(json.loads(result.output)) == {"suppressed_count"}
    assert _journal_types(ws.path) == []


def test_pins_today_cli_suppress_bleed_apply_and_dry_run_journal_no_row(tmp_path):
    ws = _workspace(tmp_path)
    runner = CliRunner()
    applied = runner.invoke(app, ["edit", "suppress-bleed", "--project", str(ws.path)])
    assert applied.exit_code == 0, applied.output
    assert json.loads(applied.output)["applied"] is True
    assert _journal_types(ws.path) == []
    preview = runner.invoke(app, ["edit", "suppress-bleed", "--project", str(ws.path), "--dry-run"])
    assert preview.exit_code == 0, preview.output
    assert json.loads(preview.output)["dry_run"] is True
    assert _journal_types(ws.path) == []


def test_pins_today_cli_bleed_alignment_choice_journals_no_row(tmp_path):
    ws = _workspace(tmp_path)
    common = ["--project", str(ws.path), "--track", "uncertain", "--start", "0.8", "--end", "3.5"]
    runner = CliRunner()
    preview = runner.invoke(app, ["edit", "align-retained-bleed", *common, "--dry-run"])
    assert preview.exit_code == 0, preview.output
    assert _journal_types(ws.path) == []
    decision = json.loads(preview.output)["proposals"][0]["decision_id"]
    choice = runner.invoke(
        app,
        ["edit", "bleed-alignment-choice", *common, "--decision", decision, "--mode", "declined"],
    )
    assert choice.exit_code == 0, choice.output
    assert json.loads(choice.output)["mode"] == "declined"
    assert _journal_types(ws.path) == []


def test_gap_fill_suppress_low_audibility_with_real_word_key_journals_one_row(tmp_path):
    ws = _workspace(tmp_path)
    reply = json.loads(
        timeline.apply_low_audibility_suppression_tool(str(ws.path), words=GOOD_WORD)
    )
    assert reply == {"suppressed_count": 1}
    assert _journal_types(ws.path) == ["SuppressLowAudibility"]


def test_gap_fill_suppress_bleed_journals_one_row_through_the_plane(tmp_path):
    ws = _workspace(tmp_path)
    reply = json.loads(timeline.apply_bleed_suppression_tool(str(ws.path), words=GOOD_WORD))
    assert reply["applied"] is True
    assert reply["dry_run"] is False
    assert _journal_types(ws.path) == ["SuppressBleed"]


def test_gap_fill_set_bleed_alignment_mode_journals_one_row_through_the_plane(tmp_path):
    ws = _workspace(tmp_path)
    preview = json.loads(timeline.align_retained_bleed_tool(str(ws.path), **WINDOW, apply=False))
    assert _journal_types(ws.path) == []
    decision_id = preview["proposals"][0]["decision_id"]
    reply = json.loads(
        timeline.set_retained_bleed_alignment_mode_tool(
            str(ws.path), decision_id, "declined", **WINDOW
        )
    )
    assert reply["mode"] == "declined"
    assert _journal_types(ws.path) == ["SetBleedAlignmentMode"]


def test_gap_fill_suppress_bleed_dry_run_returns_the_preview_unchanged(tmp_path):
    ws = _workspace(tmp_path)
    expected = {"dry_run": True, "would_suppress": 3, "candidates": [{"word_index": 0}]}
    with patch("podcast_mcp.mcp.tools.timeline.AnalysisService") as svc_cls:
        svc_cls.return_value.preview_suppress_bleed.return_value = expected
        for kwargs in ({"dry_run": True}, {"apply": False}):
            reply = json.loads(
                timeline.apply_bleed_suppression_tool(
                    str(ws.path), speaker="Host", words=GOOD_WORD, **kwargs
                )
            )
            assert reply == expected
        assert svc_cls.return_value.preview_suppress_bleed.call_count == 2
        svc_cls.return_value.preview_suppress_bleed.assert_called_with(
            track_id=None,
            speaker="Host",
            word_keys=GOOD_WORD,
            exclude_word_keys=None,
            start_sec=None,
            end_sec=None,
        )
    assert _journal_types(ws.path) == []
