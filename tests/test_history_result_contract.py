from __future__ import annotations

import itertools
import json
import types
from unittest.mock import patch

import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError
from typer.testing import CliRunner

from podcast_mcp.cli.history import history_app
from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools.history import (
    history_diff_tool,
    history_goto_tool,
    history_list,
    history_redo,
    history_status_tool,
    history_undo,
)
from podcast_mcp.models import Track
from podcast_mcp.project.history import HistoryManager
from podcast_mcp.project.store import ProjectStore
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import (
    EmptyHistoryDiffResult,
    HistoryDiffResult,
    HistoryService,
    PopulatedHistoryDiffResult,
)
from podcast_mcp.services.document.history_results import (
    HistoryGroup,
    HistoryMoveRerenderedResult,
    HistoryMoveResult,
    HistoryStatusResult,
)
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.handlers.history import redo_history, undo_history
from podcast_mcp.util.coded_error import CodedValueError


def test_history_read_results_keep_distinct_wire_shapes(minimal_project):
    service = HistoryService(ProjectWorkspace.open(minimal_project))

    empty_status = service.status()
    empty_list = service.list_entries()
    assert isinstance(empty_status, BaseModel)
    assert isinstance(empty_list, BaseModel)
    assert empty_status.model_dump() == {
        "cursor": -1,
        "total": 0,
        "can_undo": False,
        "can_redo": False,
        "current_label": None,
        "head_id": "root",
    }
    assert empty_list.model_dump() == {
        "cursor": -1,
        "head_id": "root",
        "can_undo": False,
        "can_redo": False,
        "entries": [],
        "groups": [],
    }

    service.ws.record_snapshot("plain", force=True)
    service.ws.record_snapshot("before trim", force=True)
    service.ws.record_snapshot("after trim", force=True)
    status = service.status()
    listing = service.list_entries()
    assert isinstance(status, BaseModel)
    assert isinstance(listing, BaseModel)
    assert [group.kind for group in listing.groups] == ["snapshot", "mutation"]
    assert set(listing.groups[0].model_dump()) == {
        "kind",
        "index",
        "id",
        "label",
        "operation",
        "params",
        "created_at",
        "title",
    }
    assert set(listing.groups[1].model_dump()) == {
        "kind",
        "before_index",
        "after_index",
        "before_id",
        "after_id",
        "label",
        "operation",
        "params",
        "created_at",
        "title",
    }
    assert set(listing.entries[0].model_dump()) == {
        "index",
        "id",
        "label",
        "created_at",
        "operation",
        "params",
        "current",
    }
    assert listing.entries[0].operation is None
    assert listing.entries[0].params is None
    assert listing.groups[0].params is None

    path = str(minimal_project)
    assert json.loads(history_status_tool(path)) == status.model_dump()
    assert json.loads(history_list(path)) == listing.model_dump()
    cli = CliRunner().invoke(app, ["history-status", "--project", path])
    assert cli.exit_code == 0
    assert json.loads(cli.stdout) == status.model_dump()
    document_history = DocumentSyncService.open(minimal_project).document_snapshot(
        projection="comments"
    )["history"]
    assert set(document_history) == {"cursor", "head_id", "can_undo", "can_redo", "groups"}
    assert document_history["groups"] == [group.model_dump() for group in listing.groups]


def test_history_group_models_reject_missing_or_mixed_fields():
    snapshot = {
        "kind": "snapshot",
        "index": 0,
        "id": "entry",
        "label": "plain",
        "operation": None,
        "params": None,
        "created_at": "2026-10-24T00:00:00+00:00",
        "title": "plain",
    }
    group = TypeAdapter(HistoryGroup).validate_python(snapshot)
    assert group.model_dump() == snapshot
    adapter = TypeAdapter(HistoryGroup)
    for invalid in (
        {**snapshot, "kind": "other"},
        {key: value for key, value in snapshot.items() if key != "params"},
        {**snapshot, "after_id": "entry2"},
        {**snapshot, "kind": "mutation"},
    ):
        with pytest.raises(ValidationError):
            adapter.validate_python(invalid)
    with pytest.raises(ValidationError):
        HistoryStatusResult.model_validate(
            {"cursor": -1, "total": 0, "can_undo": False, "can_redo": False, "head_id": "root"}
        )


def test_history_move_results_validate_preview_presence():
    status = {
        "cursor": 1,
        "total": 2,
        "can_undo": True,
        "can_redo": False,
        "current_label": None,
        "head_id": "root",
    }
    plain = HistoryMoveResult.model_validate(status)
    assert list(plain.model_dump()) == [*status, "guest_step"]
    with pytest.raises(ValidationError):
        HistoryMoveResult.model_validate({**status, "preview": {}})
    with pytest.raises(ValidationError):
        HistoryMoveRerenderedResult.model_validate(status)
    rerendered = HistoryMoveRerenderedResult.model_validate({**status, "preview": {"ready": True}})
    assert list(rerendered.model_dump()) == [*status, "preview", "guest_step"]
    with pytest.raises(ValidationError):
        HistoryMoveRerenderedResult.model_validate({**status, "preview": None})


def test_history_moves_return_status_models_with_optional_preview(minimal_project):
    service = HistoryService(ProjectWorkspace.open(minimal_project))
    service.ws.record_snapshot("one", force=True)
    service.ws.record_snapshot("two", force=True)

    undone = service.undo()
    status_keys = {"cursor", "total", "can_undo", "can_redo", "current_label", "head_id"}
    assert type(undone) is HistoryMoveResult
    assert set(undone.model_dump()) == status_keys | {"guest_step"}
    with (
        patch("podcast_mcp.services.document.history.rerender_preview"),
        patch(
            "podcast_mcp.services.document.history.render_preview_result",
            return_value='{"ready": true}',
        ),
    ):
        redone = service.redo(rerender=True)
    assert type(redone) is HistoryMoveRerenderedResult
    assert set(redone.model_dump()) == status_keys | {"preview", "guest_step"}
    assert redone.preview == {"ready": True}


def test_history_mcp_retains_unicode_and_nested_params(minimal_project):
    workspace = ProjectWorkspace.open(minimal_project)
    HistoryManager(ProjectStore(minimal_project)).record(
        workspace.project,
        "café",
        force=True,
        operation="note",
        params={"text": "mañana", "nested": {"levels": [1, 2]}},
    )
    workspace.save()

    raw = history_list(str(minimal_project))
    assert "caf\\u00e9" in raw
    assert "ma\\u00f1ana" in raw
    entry = json.loads(raw)["entries"][0]
    assert entry["params"] == {"text": "mañana", "nested": {"levels": [1, 2]}}


@pytest.fixture(params=["cli", "mcp", "http"])
def assert_history_diff_reply(request, minimal_project):
    def assert_reply(expected, **indices):
        path = str(minimal_project)
        if request.param == "cli":
            args = ["diff", "--project", path]
            for key, value in indices.items():
                args.extend(["--" + key.replace("_", "-"), str(value)])
            result = CliRunner().invoke(history_app, args)
            assert result.exit_code == 0, result.output
            assert result.stdout == json.dumps(expected, indent=2) + "\n"
        elif request.param == "mcp":
            assert history_diff_tool(path, **indices) == json.dumps(expected, indent=2)
        else:
            from fastapi.testclient import TestClient

            from podcast_mcp.gui.server import create_app

            with TestClient(create_app(), client=("127.0.0.1", 50000)) as client:
                response = client.get("/api/history/diff", params={"path": path, **indices})
            assert response.status_code == 200, response.text
            assert response.text == json.dumps(expected, ensure_ascii=False, separators=(",", ":"))

    return assert_reply


def test_history_diff_empty_ignores_indices(assert_history_diff_reply):
    expected = {"diff": {}, "summary": [], "from_index": None, "to_index": None}
    assert_history_diff_reply(expected)
    assert_history_diff_reply(expected, from_index=-1, to_index=99)


def test_history_diff_comparison_wire_contract(minimal_project, assert_history_diff_reply):
    workspace = ProjectWorkspace.open(minimal_project)
    workspace.project.timeline.tracks = [Track(id="host", label="café")]
    workspace.record_snapshot("before café", force=True)
    workspace.project.timeline.tracks[0].label = "mañana"
    workspace.project.timeline.tracks[0].gain_db = -3.0
    params = {"text": "mañana", "nested": {"levels": [1, 2.5, True, None, {"é": "茶"}]}}
    HistoryManager(ProjectStore(minimal_project)).record(
        workspace.project, "after café", force=True, operation="rename_track", params=params
    )
    workspace.save()
    raw = {
        "clips": {"added": [], "removed": [], "changed": []},
        "edit_decisions": {"added": [], "removed": [], "changed": []},
        "edit_log": {"added": []},
        "tracks": {
            "changed": [
                {
                    "track_id": "host",
                    "fields": [
                        {"field": "gain_db", "old": 0.0, "new": -3.0},
                        {"field": "label", "old": "café", "new": "mañana"},
                    ],
                }
            ]
        },
        "mix_changed": False,
        "timeline_duration_sec": {"old": None, "new": None},
        "meta_changed": False,
    }
    expected = {
        "from_index": 0,
        "to_index": 1,
        "from_label": "before café",
        "to_label": "after café",
        "operation": "rename_track",
        "params": params,
        "diff": raw,
        "summary": ["track settings changed on host (gain_db, label)"],
    }
    assert_history_diff_reply(expected)
    assert_history_diff_reply(expected, from_index=0, to_index=1)
    workspace.record_snapshot("later", force=True)
    HistoryService(workspace).undo()
    assert_history_diff_reply(expected)
    identical = {
        **expected,
        "to_index": 0,
        "to_label": "before café",
        "operation": None,
        "params": None,
        "diff": {**raw, "tracks": {"changed": []}},
        "summary": ["café"],
    }
    assert_history_diff_reply(identical, from_index=0, to_index=0)


def test_history_diff_index_refusals_keep_code_and_cli_exit(minimal_project):
    workspace = ProjectWorkspace.open(minimal_project)
    workspace.record_snapshot("only", force=True)
    for indices in ({}, {"from_index": 0, "to_index": 99}, {"from_index": -1, "to_index": 0}):
        with pytest.raises(CodedValueError) as error:
            history_diff_tool(str(minimal_project), **indices)
        assert error.value.code == "history_index_out_of_range"
    result = CliRunner().invoke(history_app, ["diff", "--project", str(minimal_project)])
    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.stderr == "history diff index out of range\n"


def test_history_diff_typed_variants_preserve_selected_comparison(minimal_project):
    service = HistoryService(ProjectWorkspace.open(minimal_project))
    empty = service.diff(from_index=-1, to_index=99)
    assert isinstance(empty, EmptyHistoryDiffResult)
    assert empty.diff == {}
    assert empty.summary == []
    assert empty.from_index is None
    assert empty.to_index is None

    service.ws.record_snapshot("café", force=True)
    selected = service.diff(from_index=0, to_index=0)
    assert isinstance(selected, PopulatedHistoryDiffResult)
    assert selected.from_index == selected.to_index == 0
    assert selected.from_label == selected.to_label == "café"
    assert selected.operation is None
    assert selected.params is None
    assert selected.summary == ["café"]
    assert selected.diff["tracks"] == {"changed": []}


def test_history_diff_models_reject_incomplete_or_mixed_variants():
    empty = {"diff": {}, "summary": [], "from_index": None, "to_index": None}
    populated = {
        "from_index": 0,
        "to_index": 1,
        "from_label": "before",
        "to_label": "after",
        "operation": None,
        "params": None,
        "diff": {"nested": {"values": [1, 2.5, True, None, {"é": "茶"}]}},
        "summary": [],
    }
    adapter = TypeAdapter(HistoryDiffResult)
    for valid in (empty, populated):
        result = adapter.validate_python(valid)
        assert result.model_dump() == valid
        assert list(result.model_dump()) == list(valid)
        with pytest.raises(ValidationError, match="frozen"):
            result.summary = ["changed"]
    for invalid in (
        {**empty, "diff": {"changed": True}},
        {**empty, "summary": ["changed"]},
        {**empty, "from_index": 0},
        {**empty, "to_index": 0},
        {**empty, "from_label": "before"},
        {**populated, "from_index": None},
        {**populated, "to_index": None},
        {**populated, "unknown": True},
        *(
            {key: value for key, value in populated.items() if key != missing}
            for missing in populated
        ),
    ):
        with pytest.raises(ValidationError):
            adapter.validate_python(invalid)


# Wire pin for history undo, redo and goto (#1811): the exact JSON text at each edge.
STATUS_KEYS = ["cursor", "total", "can_undo", "can_redo", "current_label", "head_id"]
PREVIEW_JSON = '{"ready": true, "stems": ["host"], "nested": {"n": 1}}'
PREVIEW = {"ready": True, "stems": ["host"], "nested": {"n": 1}}


@pytest.fixture
def history_project(minimal_project, monkeypatch):
    """Three snapshots (one, two, three) with ids 000000000001..3, cursor at the tip."""
    counter = itertools.count(1)
    monkeypatch.setattr(
        "podcast_mcp.project.history.manager.uuid.uuid4",
        lambda: types.SimpleNamespace(hex=f"{next(counter):012x}" + "0" * 20),
    )
    ws = ProjectWorkspace.open(minimal_project)
    for label in ("one", "two", "three"):
        with ws.transaction():
            ws.record_snapshot(label, force=True)
    return minimal_project


@pytest.fixture
def stub_render():
    with (
        patch("podcast_mcp.services.document.history.rerender_preview"),
        patch(
            "podcast_mcp.services.document.history.render_preview_result",
            return_value=PREVIEW_JSON,
        ),
    ):
        yield


def _status_text(cursor, total, can_undo, can_redo, label, head, preview=None):
    lines = [
        "{",
        f'  "cursor": {cursor},',
        f'  "total": {total},',
        f'  "can_undo": {can_undo},',
        f'  "can_redo": {can_redo},',
        f'  "current_label": "{label}",',
        f'  "head_id": "{head}",',
    ]
    if preview:
        lines += [
            '  "preview": {',
            '    "ready": true,',
            '    "stems": [',
            '      "host"',
            "    ],",
            '    "nested": {',
            '      "n": 1',
            "    }",
            "  },",
        ]
    lines.append('  "guest_step": false')
    lines.append("}")
    return "\n".join(lines)


UNDO = _status_text(1, 3, "true", "true", "two", "000000000002")
REDO = _status_text(2, 3, "true", "false", "three", "000000000003")
GOTO0 = _status_text(0, 3, "false", "true", "one", "000000000001")
UNDO_RR = _status_text(1, 3, "true", "true", "two", "000000000002", preview=True)
REDO_RR = _status_text(2, 3, "true", "false", "three", "000000000003", preview=True)
GOTO0_RR = _status_text(0, 3, "false", "true", "one", "000000000001", preview=True)


def _dict(text: str) -> dict:
    return json.loads(text)


@pytest.mark.parametrize("rerender", [False, True])
def test_mcp_undo_redo_goto_wire_json(history_project, stub_render, rerender):
    path = str(history_project)
    undo, redo, goto = (UNDO, REDO, GOTO0) if not rerender else (UNDO_RR, REDO_RR, GOTO0_RR)

    assert history_undo(path, rerender=rerender) == undo
    assert history_redo(path, rerender=rerender) == redo
    assert history_goto_tool(path, 0, rerender=rerender) == goto
    assert history_goto_tool(path, 2, rerender=rerender) == (REDO_RR if rerender else REDO)

    expected_keys = STATUS_KEYS + (["preview"] if rerender else []) + ["guest_step"]
    assert list(_dict(undo)) == expected_keys


def test_mcp_move_default_is_not_rerendered(history_project):
    path = str(history_project)
    assert history_undo(path) == UNDO
    assert "preview" not in _dict(history_redo(path))


@pytest.mark.parametrize("rerender", [False, True])
def test_service_move_result_shape(history_project, stub_render, rerender):
    service = HistoryService(ProjectWorkspace.open(history_project))
    extra = (["preview"] if rerender else []) + ["guest_step"]
    model = HistoryMoveRerenderedResult if rerender else HistoryMoveResult

    undone = service.undo(rerender=rerender)
    assert type(undone) is model
    assert list(undone.model_dump()) == STATUS_KEYS + extra
    assert undone.model_dump() == {
        "cursor": 1,
        "total": 3,
        "can_undo": True,
        "can_redo": True,
        "current_label": "two",
        "head_id": "000000000002",
        **({"preview": PREVIEW} if rerender else {}),
        "guest_step": False,
    }
    redone = service.redo(rerender=rerender)
    assert type(redone) is model
    assert list(redone.model_dump()) == STATUS_KEYS + extra
    assert redone.cursor == 2 and redone.head_id == "000000000003"
    moved = service.goto(0, rerender=rerender)
    assert type(moved) is model
    assert list(moved.model_dump()) == STATUS_KEYS + extra
    assert (moved.cursor, moved.current_label, moved.can_undo) == (0, "one", False)
    if rerender:
        assert isinstance(moved, HistoryMoveRerenderedResult)
        assert moved.preview == PREVIEW


@pytest.mark.parametrize("rerender", [False, True])
def test_document_plane_handlers_wire_json(history_project, stub_render, rerender):
    ws = ProjectWorkspace.open(history_project)
    payload = {"rerender": rerender, "expected_head_id": "000000000003"}

    undone = undo_history(ws, payload)
    assert type(undone) is dict
    assert json.dumps(undone) == json.dumps(_dict(UNDO_RR if rerender else UNDO))
    assert list(undone) == STATUS_KEYS + (["preview"] if rerender else []) + ["guest_step"]

    redone = redo_history(ws, {**payload, "expected_head_id": "000000000002"})
    assert type(redone) is dict
    assert json.dumps(redone) == json.dumps(_dict(REDO_RR if rerender else REDO))
    assert json.dumps(redone) == (
        '{"cursor": 2, "total": 3, "can_undo": true, "can_redo": false, '
        '"current_label": "three", "head_id": "000000000003"'
        + (
            ', "preview": {"ready": true, "stems": ["host"], "nested": {"n": 1}}'
            if rerender
            else ""
        )
        + ', "guest_step": false}'
    )


@pytest.mark.parametrize("rerender", [False, True])
def test_cli_goto_output(history_project, stub_render, rerender):
    args = ["goto", "--project", str(history_project), "--index", "0"]
    result = CliRunner().invoke(history_app, args + (["--rerender"] if rerender else []))
    assert result.exit_code == 0, result.output
    assert result.stdout == "Goto → [0] one (3 snapshots)\n"
    assert result.stderr == ""


UNICODE_LABELS = ("caf\u00e9", "dash \u2014 \u65e5\u672c", "mic \U0001f399")
UNICODE_PREVIEW_JSON = (
    '{"title": "caf\\u00e9 \\u65e5\\u672c \\ud83c\\udf99", '
    '"ratio": 0.30000000000000004, "whole": 1.0, "nested": {"say": "\\u00e9"}}'
)
UNICODE_TWO = "dash \\u2014 \\u65e5\\u672c"
UNICODE_THREE = "mic \\ud83c\\udf99"
UNICODE_ONE = "caf\\u00e9"


def _unicode_status(cursor, can_undo, can_redo, label, head, rerender):
    tail = (
        ',\n  "preview": {\n    "title": "caf\\u00e9 \\u65e5\\u672c \\ud83c\\udf99",\n'
        '    "ratio": 0.30000000000000004,\n    "whole": 1.0,\n'
        '    "nested": {\n      "say": "\\u00e9"\n    }\n  }'
        if rerender
        else ""
    )
    return (
        f'{{\n  "cursor": {cursor},\n  "total": 3,\n  "can_undo": {can_undo},\n'
        f'  "can_redo": {can_redo},\n  "current_label": "{label}",\n  "head_id": "{head}"'
        f'{tail},\n  "guest_step": false\n}}'
    )


@pytest.fixture
def unicode_project(minimal_project, monkeypatch):
    counter = itertools.count(1)
    monkeypatch.setattr(
        "podcast_mcp.project.history.manager.uuid.uuid4",
        lambda: types.SimpleNamespace(hex=f"{next(counter):012x}" + "0" * 20),
    )
    ws = ProjectWorkspace.open(minimal_project)
    for label in UNICODE_LABELS:
        with ws.transaction():
            ws.record_snapshot(label, force=True)
    with (
        patch("podcast_mcp.services.document.history.rerender_preview"),
        patch(
            "podcast_mcp.services.document.history.render_preview_result",
            return_value=UNICODE_PREVIEW_JSON,
        ),
    ):
        yield minimal_project


@pytest.mark.parametrize("rerender", [False, True])
def test_mcp_move_wire_json_escapes_non_ascii(unicode_project, rerender):
    path = str(unicode_project)
    assert history_undo(path, rerender=rerender) == _unicode_status(
        1, "true", "true", UNICODE_TWO, "000000000002", rerender
    )
    assert history_redo(path, rerender=rerender) == _unicode_status(
        2, "true", "false", UNICODE_THREE, "000000000003", rerender
    )
    assert history_goto_tool(path, 0, rerender=rerender) == _unicode_status(
        0, "false", "true", UNICODE_ONE, "000000000001", rerender
    )


@pytest.mark.parametrize("rerender", [False, True])
def test_document_plane_wire_json_escapes_non_ascii(unicode_project, rerender):
    ws = ProjectWorkspace.open(unicode_project)
    undone = undo_history(ws, {"rerender": rerender, "expected_head_id": "000000000003"})
    assert type(undone) is dict
    text = json.dumps(undone)
    assert text == json.dumps(
        json.loads(_unicode_status(1, "true", "true", UNICODE_TWO, "000000000002", rerender))
    )
    assert "\\u2014" in text
    assert "\u2014" not in text
