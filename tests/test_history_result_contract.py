from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools.history import history_list, history_status_tool
from podcast_mcp.project.history import HistoryManager
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.document.history_results import HistoryGroup, HistoryStatusResult
from podcast_mcp.services.document_sync import DocumentSyncService


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
