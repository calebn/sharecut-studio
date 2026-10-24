from __future__ import annotations

import json

from pydantic import BaseModel
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools.history import history_list, history_status_tool
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService


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

    path = str(minimal_project)
    assert json.loads(history_status_tool(path)) == status.model_dump()
    assert json.loads(history_list(path)) == listing.model_dump()
    cli = CliRunner().invoke(app, ["history-status", "--project", path])
    assert cli.exit_code == 0
    assert json.loads(cli.stdout) == status.model_dump()
