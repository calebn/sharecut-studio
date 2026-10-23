from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines.lane_words import requested_word_keys
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools import timeline
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.services.document_sync import (
    DocumentSyncService,
    submit_host_document_command,
)
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.document_sync.payloads import (
    document_command_from_body,
    document_command_json_schema,
    parse_document_command_body,
    validate_payload,
)
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.services.remote_mcp.tools import tool_input_schema
from podcast_mcp.util.coded_error import CodedValueError
from test_bleed_alignment_surfaces import _workspace
from test_document_command_boundary import _edit_share, _seed_premix
from test_multi_take_reconcile import _two_take_project

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


def _invalid_payload(excinfo, loc: str) -> None:
    assert excinfo.value.code == "invalid_payload"
    assert f"{loc}.track_id: Field required" in str(excinfo.value)
    assert f"{loc}.word_index: Field required" in str(excinfo.value)
    assert "nope" not in str(excinfo.value)


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
def test_mcp_malformed_word_item_is_invalid_payload(tmp_path, tool, field):
    ws = _workspace(tmp_path)
    with pytest.raises(CodedValueError) as excinfo:
        tool(str(ws.path), **{field: BAD_WORD})
    _invalid_payload(excinfo, f"{field}.0")
    assert _journal_types(ws.path) == []


@pytest.mark.parametrize(
    "kwargs", [{"dry_run": True}, {"apply": False}], ids=["dry-run", "apply-false"]
)
def test_mcp_bleed_preview_refuses_a_malformed_word_item_too(tmp_path, kwargs):
    ws = _workspace(tmp_path)
    with pytest.raises(CodedValueError) as excinfo:
        timeline.apply_bleed_suppression_tool(str(ws.path), words=BAD_WORD, **kwargs)
    _invalid_payload(excinfo, "words.0")
    assert _journal_types(ws.path) == []


@pytest.mark.parametrize("command_type", ["SuppressBleed", "SuppressLowAudibility"])
def test_host_path_malformed_word_item_is_invalid_payload(tmp_path, command_type):
    ws = _workspace(tmp_path)
    with pytest.raises(CodedValueError) as excinfo:
        submit_host_document_command(ws.path, command_type, {"words": BAD_WORD})
    _invalid_payload(excinfo, "words.0")
    assert _journal_types(ws.path) == []


@pytest.mark.parametrize(
    ("item", "field"),
    [
        ({"track_id": "uncertain", "word_index": 2.7}, "word_index"),
        ({"track_id": "uncertain", "word_index": -1}, "word_index"),
        ({"track_id": 7, "word_index": 0}, "track_id"),
    ],
    ids=["fractional-index", "negative-index", "numeric-track-id"],
)
def test_word_item_type_checks_refuse_with_invalid_payload(tmp_path, item, field):
    ws = _workspace(tmp_path)
    with pytest.raises(CodedValueError) as excinfo:
        submit_host_document_command(ws.path, "SuppressBleed", {"words": [item]})
    assert excinfo.value.code == "invalid_payload"
    assert f"words.0.{field}:" in str(excinfo.value)
    assert _journal_types(ws.path) == []


def test_malformed_word_item_message_names_the_command_and_never_echoes_the_value(tmp_path):
    ws = _workspace(tmp_path)
    secret = "s3cret-value"
    with pytest.raises(CodedValueError) as excinfo:
        submit_host_document_command(
            ws.path,
            "SuppressBleed",
            {"words": [{"track_id": secret, "word_index": "x" + secret}]},
        )
    assert str(excinfo.value).startswith("SuppressBleed: words.0.word_index:")
    assert secret not in str(excinfo.value)


@pytest.mark.parametrize("command_type", ["SuppressBleed", "SuppressLowAudibility"])
def test_raw_service_submit_does_not_validate_a_malformed_word_item(tmp_path, command_type):
    ws = _workspace(tmp_path)
    with pytest.raises(DocumentConflictError) as excinfo:
        _plane_submit(ws, command_type, {"words": BAD_WORD})
    _conflict(excinfo)
    assert _journal_types(ws.path) == []


@pytest.mark.parametrize("extra", [[], ["--dry-run"]], ids=["apply", "dry-run"])
def test_cli_malformed_words_json_is_a_coded_error(tmp_path, extra):
    ws = _workspace(tmp_path)
    result = CliRunner().invoke(
        app,
        [
            "edit",
            "suppress-bleed",
            "--project",
            str(ws.path),
            "--words-json",
            json.dumps(BAD_WORD),
            *extra,
        ],
    )
    assert result.exit_code == 1
    assert not isinstance(result.exception, KeyError)
    assert "words.0.track_id: Field required" in result.output
    assert "invalid_payload" in result.output
    assert _journal_types(ws.path) == []


@pytest.mark.parametrize(
    "call",
    [
        lambda path: timeline.set_retained_bleed_alignment_mode_tool(str(path), "d", "x"),  # type: ignore[arg-type]
        lambda path: submit_host_document_command(
            path, "SetBleedAlignmentMode", {"decision_id": "d", "mode": "x"}
        ),
    ],
    ids=["mcp", "host"],
)
def test_invalid_mode_is_coded_invalid_mode_on_the_host_path(tmp_path, call):
    ws = _workspace(tmp_path)
    with pytest.raises(
        CodedValueError, match="alignment mode must be auto, manual, or declined"
    ) as e:
        call(ws.path)
    assert e.value.code == "invalid_mode"
    assert _journal_types(ws.path) == []


def test_invalid_payload_outside_the_mode_is_invalid_payload(tmp_path):
    ws = _workspace(tmp_path)
    with pytest.raises(CodedValueError) as excinfo:
        submit_host_document_command(ws.path, "SetBleedAlignmentMode", {"mode": "auto"})
    assert excinfo.value.code == "invalid_payload"
    assert str(excinfo.value) == "SetBleedAlignmentMode: decision_id: Field required"


def test_cli_invalid_mode_is_rejected_by_the_option_check(tmp_path):
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


def _invoke(*args: str):
    return CliRunner().invoke(app, ["edit", *args])


def _last_payload(path: Path) -> dict:
    return DocumentSyncService.open(path).store.commands_after(0)[-1]["payload"]


def test_cli_suppress_low_audibility_journals_one_row_and_keeps_stdout(tmp_path):
    expected = AnalysisService(_workspace(tmp_path / "direct")).suppress_low_audibility()
    ws = _workspace(tmp_path / "cli")
    result = _invoke("suppress-low-audibility", "--project", str(ws.path))
    assert result.exit_code == 0, result.output
    assert result.output == json.dumps(expected, indent=2) + "\n"
    assert _journal_types(ws.path) == ["SuppressLowAudibility"]


def test_cli_suppress_bleed_apply_journals_one_row_and_dry_run_none(tmp_path):
    expected = AnalysisService(_workspace(tmp_path / "direct")).suppress_bleed(apply=True)
    ws = _workspace(tmp_path / "cli")
    preview = _invoke("suppress-bleed", "--project", str(ws.path), "--dry-run")
    assert preview.exit_code == 0, preview.output
    assert json.loads(preview.output)["dry_run"] is True
    assert _journal_types(ws.path) == []
    applied = _invoke("suppress-bleed", "--project", str(ws.path))
    assert applied.exit_code == 0, applied.output
    assert applied.output == json.dumps(expected, indent=2) + "\n"
    assert _journal_types(ws.path) == ["SuppressBleed"]
    again = _invoke("suppress-bleed", "--project", str(ws.path))
    assert again.exit_code == 0, again.output
    assert _journal_types(ws.path) == ["SuppressBleed", "SuppressBleed"]


def test_cli_suppress_bleed_with_a_real_word_key_journals_the_validated_words(tmp_path):
    ws = _workspace(tmp_path)
    result = _invoke(
        "suppress-bleed", "--project", str(ws.path), "--words-json", json.dumps(GOOD_WORD)
    )
    assert result.exit_code == 0, result.output
    assert _journal_types(ws.path) == ["SuppressBleed"]
    assert _last_payload(ws.path)["words"] == GOOD_WORD


@pytest.mark.parametrize("lock", [False, True], ids=["default", "override-placement-lock"])
def test_cli_bleed_alignment_choice_journals_one_row_with_the_lock_flag(tmp_path, lock):
    ws = _workspace(tmp_path)
    common = ["--project", str(ws.path), "--track", "uncertain", "--start", "0.8", "--end", "3.5"]
    preview = _invoke("align-retained-bleed", *common, "--dry-run")
    assert preview.exit_code == 0, preview.output
    assert _journal_types(ws.path) == []
    decision = json.loads(preview.output)["proposals"][0]["decision_id"]
    flag = ["--override-placement-lock"] if lock else []
    choice = _invoke(
        "bleed-alignment-choice", *common, "--decision", decision, "--mode", "declined", *flag
    )
    assert choice.exit_code == 0, choice.output
    assert json.loads(choice.output)["mode"] == "declined"
    assert _journal_types(ws.path) == ["SetBleedAlignmentMode"]
    assert _last_payload(ws.path)["override_placement_lock"] is lock


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


def test_cli_suppress_bleed_dry_run_with_a_real_word_key_previews_without_journaling(tmp_path):
    ws = _workspace(tmp_path)
    before = ws.path.read_bytes()
    result = _invoke(
        "suppress-bleed",
        "--project",
        str(ws.path),
        "--words-json",
        json.dumps(GOOD_WORD),
        "--dry-run",
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["dry_run"] is True
    assert ws.path.read_bytes() == before
    assert _journal_types(ws.path) == []


def test_row_shaped_word_items_are_accepted_and_extra_keys_dropped(tmp_path):
    ws = _workspace(tmp_path)
    row = {**GOOD_WORD[0], "text": "hi", "start": 0.1, "end": 0.4, "rms_db": -60.0}
    reply = json.loads(timeline.apply_low_audibility_suppression_tool(str(ws.path), words=[row]))
    assert reply == {"suppressed_count": 1}
    assert _last_payload(ws.path)["words"] == GOOD_WORD


def test_absent_source_id_stays_absent_and_null_stays_null():
    absent = {"track_id": "vicky", "word_index": 1}
    null = {"track_id": "vicky", "source_id": None, "word_index": 1}
    named = {"track_id": "vicky", "source_id": "take3", "word_index": 1}
    for command_type, field in (("SuppressBleed", "words"), ("SuppressLowAudibility", "words")):
        out = validate_payload(command_type, {field: [absent, null, named]})
        assert out[field] == [absent, null, named]
    out = validate_payload("SuppressBleed", {"exclude_words": [absent, null]})
    assert out["exclude_words"] == [absent, null]
    body = parse_document_command_body(
        {
            "type": "SuppressBleed",
            "payload": {"words": [absent, null, named]},
            "client_id": "c",
            "client_seq": 1,
        }
    )
    assert document_command_from_body(body).payload["words"] == [absent, null, named]


def test_a_bare_word_index_on_a_two_take_lane_is_still_refused_after_validation(tmp_path):
    project = _two_take_project(tmp_path)
    words = validate_payload("SuppressBleed", {"words": [{"track_id": "vicky", "word_index": 1}]})[
        "words"
    ]
    with pytest.raises(CodedValueError) as refusal:
        requested_word_keys(project, words)
    assert refusal.value.code == "word_source_required"
    named = validate_payload(
        "SuppressBleed", {"words": [{"track_id": "vicky", "source_id": "take3", "word_index": 1}]}
    )["words"]
    assert requested_word_keys(project, named) == {("vicky", "take3", 1)}


def test_word_key_item_is_a_referenced_definition_in_the_published_schema():
    schema = document_command_json_schema()
    item = schema["$defs"]["WordKeyItem"]
    assert item["required"] == ["track_id", "word_index"]
    assert tool_input_schema("guest_submit_document_command") == schema
    for name in ("SuppressBleedPayload", "SuppressLowAudibilityPayload"):
        assert "#/$defs/WordKeyItem" in json.dumps(schema["$defs"][name]["properties"]["words"])


def test_host_http_malformed_word_item_is_a_422_and_mode_x_stays_a_422(tmp_path):
    ws = _workspace(tmp_path)
    client = TestClient(create_app())
    url = f"/api/document/command?path={quote(str(ws.path))}"
    base = {"client_id": "pin", "client_seq": 1}
    bad_word = client.post(
        url, json={"type": "SuppressBleed", "payload": {"words": BAD_WORD}, **base}
    )
    assert bad_word.status_code == 422
    assert "track_id" in bad_word.text
    assert "invalid_request" in bad_word.text
    bad_mode = client.post(
        url,
        json={
            "type": "SetBleedAlignmentMode",
            "payload": {"decision_id": "d", "mode": "x"},
            **base,
        },
    )
    assert bad_mode.status_code == 422
    assert _journal_types(ws.path) == []


def test_guest_mcp_malformed_word_item_is_invalid_arguments(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _edit_share(ws, monkeypatch, tmp_workspace)
    out = handle_mcp_jsonrpc(
        share["token"],
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "guest_submit_document_command",
                "arguments": {
                    "type": "SuppressBleed",
                    "payload": {"words": BAD_WORD},
                    "client_id": "pin",
                    "client_seq": 1,
                },
            },
        },
    )
    assert out["error"]["code"] == -32602
    assert out["error"]["data"]["error_code"] == "invalid_arguments"
    assert "words.0.track_id" in out["error"]["message"]


def test_bad_mode_does_not_mask_another_field_error(tmp_path):
    secret = "s3cret-mode"
    with pytest.raises(CodedValueError) as excinfo:
        validate_payload("SetBleedAlignmentMode", {"mode": secret})
    assert excinfo.value.code == "invalid_payload"
    assert "decision_id: Field required" in str(excinfo.value)
    assert secret not in str(excinfo.value)
