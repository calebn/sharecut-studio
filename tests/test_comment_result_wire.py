"""The comment CLI and document-sync handlers keep their JSON shape (#1811)."""

from __future__ import annotations

import json
from typing import Any

from typer.testing import CliRunner

from podcast_mcp.cli.comment import comment_app
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync.handlers.comments import HANDLERS


def _cli(project, *args: str) -> Any:
    result = CliRunner().invoke(comment_app, [*args, "--project", str(project)])
    assert result.exit_code == 0, result.output
    return json.loads(result.output)


def test_comment_cli_prints_plain_json_for_every_command(minimal_project):
    added = _cli(
        minimal_project,
        "add",
        "--body",
        "Café levels",
        "--author",
        "agent",
        "--start",
        "1.0",
        "--action",
        "Normalize",
    )
    cid = added["id"]
    aid = added["action_items"][0]["id"]
    assert added["body"] == "Café levels"

    assert [c["id"] for c in _cli(minimal_project, "list")] == [cid]
    assert _cli(minimal_project, "get", "--id", cid)["id"] == cid
    assert _cli(minimal_project, "update", "--id", cid, "--body", "Edited")["body"] == "Edited"

    new_action = _cli(minimal_project, "add-action", "--id", cid, "--text", "Trim")
    assert set(new_action) == {"comment_id", "action_item"}
    assert new_action["comment_id"] == cid
    assert new_action["action_item"]["text"] == "Trim"

    reply = _cli(minimal_project, "reply", "--id", cid, "--body", "On it", "--author", "bot")
    assert set(reply) == {"comment_id", "reply"}
    assert reply["comment_id"] == cid
    assert reply["reply"]["author"] == "bot"

    resolved = _cli(minimal_project, "resolve", "--id", cid, "--by", "agent")
    assert resolved["resolved"] is True

    done = _cli(minimal_project, "done", "--id", cid, "--action-id", aid, "--by", "agent")
    assert set(done) == {"comment_id", "action_item"}
    assert done["comment_id"] == cid
    assert done["action_item"]["done"] is True

    assert _cli(minimal_project, "delete", "--id", cid) == {"deleted": True, "id": cid}


def test_comment_sync_handlers_return_plain_dicts(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)

    added = HANDLERS["AddComment"](
        ws,
        {"body": "Hello", "author": "a", "timeline_start": 1.0, "action_texts": ["Fix"]},
    )
    assert isinstance(added, dict)
    cid = added["id"]
    aid = added["action_items"][0]["id"]

    updated = HANDLERS["UpdateComment"](ws, {"comment_id": cid, "body": "Upd"})
    assert isinstance(updated, dict)
    assert updated["body"] == "Upd"

    resolved = HANDLERS["ResolveComment"](ws, {"comment_id": cid, "by": "a"})
    assert isinstance(resolved, dict)
    assert resolved["resolved"] is True

    reply = HANDLERS["AddReply"](ws, {"comment_id": cid, "body": "r", "author": "a"})
    assert isinstance(reply, dict)
    assert reply["comment_id"] == cid
    assert reply["reply"]["body"] == "r"

    new_action = HANDLERS["AddAction"](ws, {"comment_id": cid, "text": "More"})
    assert isinstance(new_action, dict)
    assert new_action["comment_id"] == cid
    assert new_action["action_item"]["text"] == "More"

    done = HANDLERS["SetActionDone"](ws, {"comment_id": cid, "action_id": aid, "by": "a"})
    assert isinstance(done, dict)
    assert done["comment_id"] == cid
    assert done["action_item"]["done"] is True

    deleted = HANDLERS["DeleteComment"](ws, {"comment_id": cid})
    assert deleted == {"deleted": True, "id": cid}
