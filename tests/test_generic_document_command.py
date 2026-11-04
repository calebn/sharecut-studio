"""The generic tool and CLI submit any registry type through the named tools' journal path."""

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
from podcast_mcp.models import load_project
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


def test_generic_submits_perform_the_edits_the_gui_sends_with_the_same_payloads(
    tmp_path: Path, sample_wav: Path
) -> None:
    from test_agent_document import _seed

    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)

    mcp_document.submit_document_command_tool(
        path, "SplitAtTime", {"at_time": 2.0, "track_ids": ["host"]}
    )
    assert sorted(c.timeline_start for c in load_project(Path(path)).clips) == [0.0, 2.0]

    mcp_document.submit_document_command_tool(path, "AddTrack", {"track_id": "music"})
    assert {t.id for t in load_project(Path(path)).tracks} == {"host", "music"}

    mcp_document.submit_document_command_tool(path, "RemoveTrack", {"track_id": "music"})
    assert {t.id for t in load_project(Path(path)).tracks} == {"host"}

    assert [r["type"] for r in _journal(path)] == ["SplitAtTime", "AddTrack", "RemoveTrack"]


def test_the_cli_reads_the_envelope_baseline_that_a_generic_set_envelope_needs(
    tmp_path: Path, sample_wav: Path
) -> None:
    from test_agent_document import _seed

    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)

    def listed() -> list[dict]:
        result = runner.invoke(app, ["edit", "list-envelope", "--project", path, "--track", "host"])
        assert result.exit_code == 0, result.output
        return json.loads(result.output)["points"]

    assert listed() == []
    first = {"track_id": "host", "points": [{"time": 1.0, "value": 0.5}], "expected_points": []}
    done = runner.invoke(
        app, ["doc", "submit", "SetEnvelope", "--project", path, "--payload", json.dumps(first)]
    )
    assert done.exit_code == 0, done.output
    baseline = listed()
    assert [(p["time"], p["value"]) for p in baseline] == [(1.0, 0.5)]
    assert all(p["id"] for p in baseline)

    second = {
        "track_id": "host",
        "points": [{"time": 2.0, "value": 0.25}],
        "expected_points": baseline,
    }
    done = runner.invoke(
        app, ["doc", "submit", "SetEnvelope", "--project", path, "--payload", json.dumps(second)]
    )
    assert done.exit_code == 0, done.output
    assert [(p["time"], p["value"]) for p in listed()] == [(2.0, 0.25)]


def test_the_cli_lists_social_clip_ids_that_a_generic_update_and_delete_need(
    tmp_path: Path, sample_wav: Path
) -> None:
    from test_agent_document import _seed

    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    mcp_document.submit_document_command_tool(
        path, "AddSocialClip", {"track_id": "host", "start": 1.0, "end": 3.0, "title": "Intro"}
    )

    def listed() -> list[dict]:
        result = runner.invoke(app, ["clips", "list", "--project", path])
        assert result.exit_code == 0, result.output
        return json.loads(result.output)

    (clip,) = listed()
    assert (clip["start"], clip["end"], clip["title"], clip["status"]) == (
        1.0,
        3.0,
        "Intro",
        "pending",
    )
    update = {"id": clip["id"], "start": 1.5, "end": 3.5}
    done = runner.invoke(
        app,
        ["doc", "submit", "UpdateSocialClip", "--project", path, "--payload", json.dumps(update)],
    )
    assert done.exit_code == 0, done.output
    assert [(c["start"], c["end"]) for c in listed()] == [(1.5, 3.5)]

    done = runner.invoke(
        app,
        [
            "doc",
            "submit",
            "DeleteSocialClip",
            "--project",
            path,
            "--payload",
            json.dumps({"id": clip["id"]}),
        ],
    )
    assert done.exit_code == 0, done.output
    assert listed() == []


def test_a_reused_command_id_with_another_edit_is_refused(tmp_path: Path, sample_wav: Path) -> None:
    from test_agent_document import _seed

    path = mcp_server.episode_create(str(tmp_path / "ws"))
    _seed(path, sample_wav)
    mcp_document.submit_document_command_tool(
        path, "AddTrack", {"track_id": "music"}, command_id="retry-1"
    )
    again = json.loads(
        mcp_document.submit_document_command_tool(
            path, "AddTrack", {"track_id": "music"}, command_id="retry-1"
        )
    )
    assert again["command_id"] == "retry-1"
    with pytest.raises(Exception, match="command_id already names a different edit"):
        mcp_document.submit_document_command_tool(
            path, "AddTrack", {"track_id": "other"}, command_id="retry-1"
        )
    with pytest.raises(Exception, match="command_id already names a different edit"):
        mcp_document.submit_document_command_tool(
            path, "RemoveTrack", {"track_id": "music"}, command_id="retry-1"
        )
    assert [r["type"] for r in _journal(path)] == ["AddTrack"]


@pytest.mark.parametrize(
    ("command_type", "field", "words"),
    [
        ("TrimClipEdge", "expected_token", ("trim_clip_edge_tool", "podcast edit trim-clip")),
        ("SetClipFade", "expected", ("podcast edit list-clips", "fade_in_ms")),
        ("SetEnvelope", "expected_points", ("podcast edit list-envelope", "set_envelope")),
    ],
)
def test_a_baseline_field_says_how_to_read_it(
    command_type: str, field: str, words: tuple[str, ...]
) -> None:
    description = document_command_schema(command_type).payload_schema["properties"][field][
        "description"
    ]
    for word in words:
        assert word in description
