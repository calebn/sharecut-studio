from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError
from typer.testing import CliRunner

from podcast_mcp.cli.history import history_app
from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools.history import history_diff_tool, history_list, history_status_tool
from podcast_mcp.models import Track
from podcast_mcp.project.history import HistoryManager
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.document.history_results import HistoryGroup, HistoryStatusResult
from podcast_mcp.services.document_sync import DocumentSyncService
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


def test_history_moves_keep_dictionary_status_and_optional_preview(minimal_project):
    service = HistoryService(ProjectWorkspace.open(minimal_project))
    service.ws.record_snapshot("one", force=True)
    service.ws.record_snapshot("two", force=True)

    undone = service.undo()
    status_keys = {"cursor", "total", "can_undo", "can_redo", "current_label", "head_id"}
    assert type(undone) is dict
    assert set(undone) == status_keys
    with (
        patch("podcast_mcp.services.document.history.rerender_preview"),
        patch(
            "podcast_mcp.services.document.history.render_preview_result",
            return_value='{"ready": true}',
        ),
    ):
        redone = service.redo(rerender=True)
    assert type(redone) is dict
    assert set(redone) == status_keys | {"preview"}
    assert redone["preview"] == {"ready": True}


def test_history_mcp_retains_unicode_and_nested_params(minimal_project):
    workspace = ProjectWorkspace.open(minimal_project)
    HistoryManager(minimal_project).record(
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
    HistoryManager(minimal_project).record(
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
