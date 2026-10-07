"""Free-text MCP arguments reach tools verbatim through a real client (#1175).

The SDK JSON-decodes a string argument for any parameter not annotated exactly ``str``,
so without ``install_free_text_args`` a ``str | None`` parameter turned ``"null"`` into
``None`` (an update or guard silently skipped) and ``"[1]"`` into a rejected list.
These tests go through ``mcp.client.Client`` (in memory, and once over stdio) or the
registered tool's ``fn_metadata``, which a direct function call skips.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters
from mcp.server import MCPServer
from pydantic import TypeAdapter

from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.args import FreeTextFuncMetadata, install_free_text_args, is_free_text
from podcast_mcp.models import Transcript, TranscriptWord, load_project, save_project

# Strings an agent may legitimately write that are also valid JSON.
JSON_LOOKING_TEXT = ("null", "[1]", '{"a": 1}', "123", "true", "[laughter]")


def _result_json(result: Any) -> Any:
    assert not result.is_error, result.content
    return json.loads(result.content[0].text)


async def _seed_comment(client: Client, path: str) -> str:
    created = await client.call_tool(
        "add_comment_tool",
        {"project_path": path, "body": "seed", "author": "a", "timeline_start": 0.1},
    )
    return str(_result_json(created)["id"])


@pytest.mark.asyncio
@pytest.mark.parametrize("body", JSON_LOOKING_TEXT)
async def test_client_free_text_body_is_stored_verbatim(tmp_path, body) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    async with Client(mcp_server.mcp) as client:
        cid = await _seed_comment(client, path)
        updated = await client.call_tool(
            "update_comment_tool", {"project_path": path, "comment_id": cid, "body": body}
        )
        fetched = await client.call_tool(
            "get_comment_tool", {"project_path": path, "comment_id": cid}
        )

    assert _result_json(updated)["body"] == body
    assert _result_json(fetched)["body"] == body


@pytest.mark.asyncio
async def test_client_json_null_still_means_omitted(tmp_path) -> None:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    async with Client(mcp_server.mcp) as client:
        cid = await _seed_comment(client, path)
        updated = await client.call_tool(
            "update_comment_tool",
            {"project_path": path, "comment_id": cid, "body": None, "timeline_start": 0.2},
        )

    comment = _result_json(updated)
    assert comment["body"] == "seed"
    assert comment["timeline_start"] == pytest.approx(0.2)


def _seed_word(path: str, text: str) -> None:
    proj = load_project(Path(path))
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text=text, start=0.0, end=0.5, confidence=0.9)],
        )
    ]
    save_project(proj, Path(path))


@pytest.mark.asyncio
async def test_client_expected_text_null_is_checked(tmp_path, sample_wav) -> None:
    """``expected_text="null"`` is a guard against the text "null", not an omitted guard."""
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    mcp_server.track_add(path, "host", str(sample_wav), role="dialogue")
    _seed_word(path, "hello")
    args = {"project_path": path, "track_id": "host", "word_index": 0, "new_text": "Hi"}

    async with Client(mcp_server.mcp) as client:
        stale = await client.call_tool("correct_transcript_tool", {**args, "expected_text": "null"})
        unchanged = load_project(Path(path)).transcripts[0].words[0].text
        _seed_word(path, "null")
        matched = await client.call_tool(
            "correct_transcript_tool", {**args, "expected_text": "null"}
        )

    assert stale.is_error  # the guard refused: the word is "hello", not "null"
    assert unchanged == "hello"
    assert _result_json(matched)["text"] == "Hi"
    assert load_project(Path(path)).transcripts[0].words[0].text == "Hi"


@pytest.mark.asyncio
async def test_stdio_client_free_text_body_is_stored_verbatim(tmp_path) -> None:
    """The ``podcast-mcp`` stdio server applies the same contract as the in-memory one."""
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    params = StdioServerParameters(
        command=sys.executable, args=["-m", "podcast_mcp.mcp.server"], env=dict(os.environ)
    )
    async with Client(params) as client:
        cid = await _seed_comment(client, path)
        bodies = []
        for body in ("null", "[1]"):
            updated = await client.call_tool(
                "update_comment_tool", {"project_path": path, "comment_id": cid, "body": body}
            )
            bodies.append(_result_json(updated)["body"])

    assert bodies == ["null", "[1]"]


@pytest.mark.asyncio
async def test_install_free_text_args_covers_tools_added_later() -> None:
    """Install once before ``register_all``; every tool added afterwards is covered."""
    server = MCPServer("free-text-install")
    install_free_text_args(server)
    install_free_text_args(server)  # idempotent

    def echo_tool(text: str | None = None, items: list[int] | None = None) -> str:
        return json.dumps({"text": text, "items": items})

    server.add_tool(echo_tool)
    server.add_tool(echo_tool)  # a duplicate keeps the already-converted tool
    async with Client(server) as client:
        text = await client.call_tool("echo_tool", {"text": "[1]", "items": "[1]"})
        omitted = await client.call_tool("echo_tool", {"text": None})

    assert _result_json(text) == {"text": "[1]", "items": [1]}
    assert _result_json(omitted) == {"text": None, "items": None}


def test_free_text_metadata_keeps_every_sdk_field() -> None:
    """``_keep_free_text`` copies the whole ``FuncMetadata``, so a field added upstream survives."""
    from mcp.server.mcpserver.tools import Tool

    from podcast_mcp.mcp.args import _keep_free_text

    def typed_tool(text: str | None = None) -> dict[str, str | None]:
        return {"text": text}

    tool = Tool.from_function(typed_tool, structured_output=True)
    before = tool.fn_metadata
    after = _keep_free_text(tool).fn_metadata

    assert isinstance(after, FreeTextFuncMetadata)
    assert type(before).model_fields  # the SDK model still declares its fields
    for name in type(before).model_fields:
        assert getattr(after, name) == getattr(before, name), name


@pytest.mark.parametrize(
    ("annotation", "expected"),
    [
        (str, True),
        (str | None, True),
        (int | None, False),
        (str | int, False),
        (list[str] | None, False),
        (dict[str, str] | None, False),
    ],
)
def test_is_free_text(annotation, expected) -> None:
    assert is_free_text(annotation) is expected


# --- Every free-text parameter on every registered tool -------------------------------


def _registered_tools() -> list[Any]:
    return mcp_server.mcp._tool_manager.list_tools()


def _is_plain_text(schema: dict[str, Any]) -> bool:
    """A string parameter with no enum / pattern: any text the agent writes is valid."""
    variants = [s for s in schema.get("anyOf", [schema]) if s.get("type") != "null"]
    return bool(variants) and all(
        s.get("type") == "string" and not ({"enum", "const", "pattern"} & s.keys())
        for s in variants
    )


def _free_text_params() -> list[Any]:
    rows = []
    for tool in _registered_tools():
        for name, schema in tool.parameters.get("properties", {}).items():
            if _is_plain_text(schema):
                rows.append(pytest.param(tool, name, id=f"{tool.name}.{name}"))
    return rows


FREE_TEXT_PARAMS = _free_text_params()


def test_free_text_param_table_covers_the_1175_params() -> None:
    covered = {p.id for p in FREE_TEXT_PARAMS}
    for row in (
        "update_comment_tool.body",
        "correct_transcript_tool.expected_text",
        "correct_transcript_phrase_tool.expected_text",
        "set_word_suppressed_tool.expected_text",
        "set_words_ignored_tool.expected_text",
        "transcript_refine_done_tool.notes",
        "align_done_tool.notes",
        "play_audio_tool.query",
        "set_session_region_tool.query",
        "track_add.label",
    ):
        assert row in covered


@pytest.mark.parametrize(("tool", "name"), FREE_TEXT_PARAMS)
def test_free_text_param_keeps_json_looking_text(tool, name) -> None:
    """The SDK's own boundary (pre-parse + field validation) yields the string verbatim."""
    field = next(
        f for n, f in tool.fn_metadata.arg_model.model_fields.items() if (f.alias or n) == name
    )
    adapter = TypeAdapter(field.annotation)
    for sent in JSON_LOOKING_TEXT:
        parsed = tool.fn_metadata.pre_parse_json({name: sent})[name]
        assert adapter.validate_python(parsed) == sent
