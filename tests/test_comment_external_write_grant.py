from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.comment import comment_app
from podcast_mcp.mcp.tools import comments as comment_tools
from podcast_mcp.project.store import (
    WriteGrantKind,
    reset_write_counts_for_tests,
    write_counts,
    write_grant,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import CommentService

runner = CliRunner()


class _Registry:
    def __init__(self) -> None:
        self.tools: dict[str, Callable[..., Any]] = {}

    def tool(self) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def keep(fn: Callable[..., Any]) -> Callable[..., Any]:
            self.tools[fn.__name__] = fn
            return fn

        return keep


@pytest.fixture
def tools() -> dict[str, Callable[..., Any]]:
    registry = _Registry()
    comment_tools.register(registry)  # type: ignore[arg-type]
    return registry.tools


@pytest.fixture
def seeded(minimal_project: Path) -> tuple[str, str, str]:
    with write_grant(WriteGrantKind.DISPATCHER):
        comment = CommentService(ProjectWorkspace.open(minimal_project)).add(
            body="seed", author="host", timeline_start=1.0, action_texts=["do"]
        )
    reset_write_counts_for_tests()
    return str(minimal_project), comment.id, comment.action_items[0].id


def _cli(project: str, *args: str) -> dict[str, Any]:
    result = runner.invoke(comment_app, [*args, "--project", project])
    assert result.exit_code == 0, result.output
    return json.loads(result.output)


def _only(kind: str) -> None:
    counts = write_counts()
    assert counts.get(kind, 0) >= 1
    assert set(counts) <= {kind}


def test_mcp_add_takes_a_grant(tools, minimal_project: Path) -> None:
    tools["add_comment_tool"](str(minimal_project), "b", "a", 1.0)

    _only("legacy_comment")


def test_mcp_update_takes_a_grant(tools, seeded) -> None:
    project, cid, _ = seeded

    tools["update_comment_tool"](project, cid, body="new")

    _only("legacy_comment")


def test_mcp_resolve_takes_a_grant(tools, seeded) -> None:
    project, cid, _ = seeded

    tools["resolve_comment_tool"](project, cid, "h")

    _only("legacy_comment")


def test_mcp_add_action_takes_a_grant(tools, seeded) -> None:
    project, cid, _ = seeded

    tools["add_comment_action_tool"](project, cid, "more")

    _only("legacy_comment")


def test_mcp_reply_takes_a_grant(tools, seeded) -> None:
    project, cid, _ = seeded

    tools["add_comment_reply_tool"](project, cid, "r", "h")

    _only("legacy_comment")


def test_mcp_action_done_takes_a_grant(tools, seeded) -> None:
    project, cid, action = seeded

    tools["set_comment_action_done_tool"](project, cid, action, "h")

    _only("legacy_comment")


def test_mcp_delete_takes_a_grant(tools, seeded) -> None:
    project, cid, _ = seeded

    tools["delete_comment_tool"](project, cid)

    _only("legacy_comment")


def test_mcp_reads_need_no_grant(tools, seeded) -> None:
    project, cid, _ = seeded

    tools["list_comments_tool"](project)
    tools["get_comment_tool"](project, cid)

    assert write_counts() == {}


def test_cli_add_takes_a_grant(minimal_project: Path) -> None:
    _cli(str(minimal_project), "add", "--body", "b", "--author", "a", "--start", "1")

    _only("legacy_comment")


def test_cli_update_takes_a_grant(seeded) -> None:
    project, cid, _ = seeded

    _cli(project, "update", "--id", cid, "--body", "new")

    _only("legacy_comment")


def test_cli_add_action_takes_a_grant(seeded) -> None:
    project, cid, _ = seeded

    _cli(project, "add-action", "--id", cid, "--text", "more")

    _only("legacy_comment")


def test_cli_reply_takes_a_grant(seeded) -> None:
    project, cid, _ = seeded

    _cli(project, "reply", "--id", cid, "--body", "r", "--author", "h")

    _only("legacy_comment")


def test_cli_resolve_takes_a_grant(seeded) -> None:
    project, cid, _ = seeded

    _cli(project, "resolve", "--id", cid, "--by", "h")

    _only("legacy_comment")


def test_cli_done_takes_a_grant(seeded) -> None:
    project, cid, action = seeded

    _cli(project, "done", "--id", cid, "--action-id", action, "--by", "h")

    _only("legacy_comment")


def test_cli_delete_takes_a_grant(seeded) -> None:
    project, cid, _ = seeded

    _cli(project, "delete", "--id", cid)

    _only("legacy_comment")


def test_cli_reads_need_no_grant(seeded) -> None:
    project, cid, _ = seeded

    _cli(project, "list")
    _cli(project, "get", "--id", cid)

    assert write_counts() == {}


def test_cli_missing_comment_still_exits_one(seeded) -> None:
    project, _, _ = seeded

    result = runner.invoke(comment_app, ["delete", "--project", project, "--id", "nope"])

    assert result.exit_code == 1
