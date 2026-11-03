"""Generic agent reach: any document command, derived from the registry (#3115 slice 3).

The generic tool and the CLI submit through ``submit_host_document_command``, the path the
named tools use, so the edit is a typed journal row, one history step, undoable and host only.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools import document as mcp_document
from podcast_mcp.mcp.tools import history as mcp_history
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.services.document_sync import (
    COMMANDS,
    DocumentSyncService,
    describe_document_commands,
    document_command_schema,
    submit_generic_document_command,
)
from podcast_mcp.services.remote_mcp.allowlist import ALL_GUEST_TOOLS
from podcast_mcp.services.remote_mcp.tools import TOOL_HANDLERS
from podcast_mcp.util.coded_error import CodedValueError

runner = CliRunner()

REFUSED = {"InsertSegment"}


@pytest.fixture
def project(tmp_path: Path) -> str:
    return mcp_server.episode_create(str(tmp_path / "ws"))


def _journal(path: str) -> list[dict]:
    return DocumentSyncService.open(path).store.commands_after(0)


def _history(path: str) -> dict:
    return json.loads(mcp_history.history_status_tool(path))


def test_every_registry_type_is_submittable_or_has_a_reasoned_refusal() -> None:
    rows = {row.type: row for row in describe_document_commands()}
    assert set(rows) == set(COMMANDS)
    refused = {t for t, row in rows.items() if not row.submittable}
    assert refused == REFUSED
    for command_type, row in rows.items():
        spec = COMMANDS[command_type]
        assert row.submittable is (spec.generic_refusal is None)
        if not row.submittable:
            assert row.refusal and row.refusal == spec.generic_refusal
            assert "segment_insert_tool" in row.refusal


@pytest.mark.parametrize("command_type", sorted(COMMANDS))
def test_every_type_has_a_payload_schema_agents_can_read(command_type: str) -> None:
    described = document_command_schema(command_type)
    assert described.type == command_type
    assert described.payload_schema == COMMANDS[command_type].payload.model_json_schema()
    assert described.submittable is (command_type not in REFUSED)


def test_the_schema_of_an_unknown_type_is_a_coded_refusal() -> None:
    with pytest.raises(CodedValueError) as caught:
        document_command_schema("Nope")
    assert caught.value.code == "document_command_unknown"


def test_discovery_tool_lists_types_and_returns_one_schema() -> None:
    listed = json.loads(mcp_document.document_command_schema_tool())
    assert {row["type"] for row in listed["commands"]} == set(COMMANDS)
    one = json.loads(mcp_document.document_command_schema_tool("AddChapter"))
    assert one["payload_schema"]["required"] == ["time", "title"]


def test_submit_journals_one_typed_row_and_one_history_step(project: str) -> None:
    before = _history(project)
    seq_before = len(_journal(project))
    out = json.loads(
        mcp_document.submit_document_command_tool(
            project, "AddChapter", {"time": 1.5, "title": "Intro"}
        )
    )
    assert out["ok"] is True
    assert out["type"] == "AddChapter"
    assert out["result"]["title"] == "Intro"
    rows = _journal(project)
    assert [r["type"] for r in rows[seq_before:]] == ["AddChapter"]
    assert rows[-1]["server_seq"] == out["server_seq"]
    assert rows[-1]["role"] == "agent"
    after = _history(project)
    assert after["total"] == before["total"] + 1
    assert after["head_id"] != before["head_id"] and after["head_id"] == out["history_head_id"]
    assert json.loads(mcp_timeline.list_chapters_tool(project)) == [
        {"time": 1.5, "title": "Intro", "image_url": None}
    ]


def test_a_generic_submit_is_undoable(project: str) -> None:
    mcp_document.submit_document_command_tool(project, "AddChapter", {"time": 1.0, "title": "A"})
    assert _history(project)["can_undo"] is True
    mcp_history.history_undo(project)
    assert json.loads(mcp_timeline.list_chapters_tool(project)) == []


def test_a_command_id_makes_a_retry_return_the_first_row(project: str) -> None:
    args = (project, "AddChapter", {"time": 1.0, "title": "A"})
    first = json.loads(mcp_document.submit_document_command_tool(*args, command_id="retry-1"))
    again = json.loads(mcp_document.submit_document_command_tool(*args, command_id="retry-1"))
    assert again["server_seq"] == first["server_seq"]
    assert [r["type"] for r in _journal(project)] == ["AddChapter"]


@pytest.mark.parametrize(
    ("command_type", "payload", "fragment"),
    [
        ("AddChapter", {"time": 1.0}, "title"),
        ("AddChapter", {"time": "soon", "title": "A"}, "time"),
        ("AddChapter", {"time": 1.0, "title": "A", "titel": "typo"}, "titel"),
        (
            "AddChapter",
            {"time": 1.0, "title": "A", "_structural_mode": "apply"},
            "_structural_mode",
        ),
        ("FadeJoins", {"dry_run": True}, "dry_run"),
        ("ReconcileTranscript", {"dry_run": True}, "dry_run"),
    ],
)
def test_a_bad_payload_is_refused_before_anything_is_journaled(
    project: str, command_type: str, payload: dict, fragment: str
) -> None:
    with pytest.raises(CodedValueError) as caught:
        mcp_document.submit_document_command_tool(project, command_type, payload)
    assert caught.value.code == "invalid_payload"
    assert fragment in str(caught.value)
    assert _journal(project) == []


def test_an_unknown_type_is_refused(project: str) -> None:
    with pytest.raises(CodedValueError) as caught:
        mcp_document.submit_document_command_tool(project, "Nope", {})
    assert caught.value.code == "document_command_unknown"


def test_a_type_with_preview_semantics_is_refused_and_names_the_named_tool(project: str) -> None:
    with pytest.raises(CodedValueError) as caught:
        mcp_document.submit_document_command_tool(
            project, "InsertSegment", {"segment_id": "x", "at": "start"}
        )
    assert caught.value.code == "document_command_not_generic"
    assert "segment_insert_tool" in str(caught.value)
    assert _journal(project) == []


def test_the_service_function_is_what_both_surfaces_call(project: str) -> None:
    out = submit_generic_document_command(
        project, "AddChapter", {"time": 2.0, "title": "S"}, client_id="test"
    )
    assert out.result["title"] == "S"
    assert _journal(project)[-1]["client_id"] == "test"


def test_the_generic_tools_are_host_only_and_never_reach_a_guest() -> None:
    names = {"submit_document_command_tool", "document_command_schema_tool"}
    assert names.isdisjoint(ALL_GUEST_TOOLS)
    assert names.isdisjoint(TOOL_HANDLERS)
    assert not any(n.startswith("guest_") for n in names)


def test_the_generic_tools_are_registered_on_the_server() -> None:
    from podcast_mcp.mcp.tools import register_all

    class Recorder:
        def __init__(self) -> None:
            self.names: list[str] = []

        def tool(self, *a: object, **k: object):
            def deco(fn):
                self.names.append(fn.__name__)
                return fn

            return deco

        def add_tool(self, fn, name=None, **k: object) -> None:
            self.names.append(name or fn.__name__)

    rec = Recorder()
    register_all(rec)  # type: ignore[arg-type]
    assert {"submit_document_command_tool", "document_command_schema_tool"} <= set(rec.names)


def test_cli_list_and_schema_match_the_service() -> None:
    listed = runner.invoke(app, ["doc", "list"])
    assert listed.exit_code == 0, listed.output
    assert {row["type"] for row in json.loads(listed.output)["commands"]} == set(COMMANDS)
    one = runner.invoke(app, ["doc", "schema", "AddChapter"])
    assert one.exit_code == 0, one.output
    assert json.loads(one.output) == document_command_schema("AddChapter").model_dump()
    bad = runner.invoke(app, ["doc", "schema", "Nope"])
    assert bad.exit_code != 0


def test_cli_submit_matches_the_mcp_tool_row_for_row(tmp_path: Path) -> None:
    mcp_path = mcp_server.episode_create(str(tmp_path / "mcp"))
    cli_path = mcp_server.episode_create(str(tmp_path / "cli"))
    payload = {"time": 3.0, "title": "Same"}
    mcp_document.submit_document_command_tool(mcp_path, "AddChapter", payload)
    result = runner.invoke(
        app,
        ["doc", "submit", "AddChapter", "--project", cli_path, "--payload", json.dumps(payload)],
    )
    assert result.exit_code == 0, result.output
    out = json.loads(result.output)
    assert out["type"] == "AddChapter" and out["result"]["title"] == "Same"
    assert [r["type"] for r in _journal(cli_path)] == [r["type"] for r in _journal(mcp_path)]
    assert json.loads(mcp_timeline.list_chapters_tool(cli_path)) == json.loads(
        mcp_timeline.list_chapters_tool(mcp_path)
    )
    assert _journal(cli_path)[-1]["client_id"] == "cli:host"
    assert _history(cli_path)["can_undo"] is True


def test_cli_submit_reads_a_payload_file(tmp_path: Path) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    body = tmp_path / "chapter.json"
    body.write_text(json.dumps({"time": 4.0, "title": "From file"}))
    result = runner.invoke(
        app, ["doc", "submit", "AddChapter", "--project", path, "--payload", f"@{body}"]
    )
    assert result.exit_code == 0, result.output
    assert json.loads(mcp_timeline.list_chapters_tool(path))[0]["title"] == "From file"


@pytest.mark.parametrize(
    ("args", "fragment"),
    [
        (["--payload", "{not json"], "JSON"),
        (["--payload", "[1]"], "object"),
        (["--payload", '{"time": 1.0}'], "title"),
        (["--payload", "@/nonexistent/payload.json"], "payload"),
    ],
)
def test_cli_submit_refuses_a_bad_payload_and_journals_nothing(
    tmp_path: Path, args: list[str], fragment: str
) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    result = runner.invoke(app, ["doc", "submit", "AddChapter", "--project", path, *args])
    assert result.exit_code != 0
    assert fragment in result.output
    assert _journal(path) == []


def test_cli_submit_refuses_a_type_with_preview_semantics(tmp_path: Path) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    result = runner.invoke(
        app,
        ["doc", "submit", "InsertSegment", "--project", path, "--payload", '{"segment_id": "x"}'],
    )
    assert result.exit_code != 0
    assert "podcast segment insert" in result.output
    assert _journal(path) == []
