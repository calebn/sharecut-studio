"""MCP tool refusals reach the agent with their message and code; crashes stay generic (#1178).

The SDK keeps an exception's text only for ``ToolError``: anything else becomes
``Error executing tool <name>``. ``install_tool_errors`` (``mcp/tool_errors.py``) returns a
``CodedError`` refusal as a structured ``is_error`` result instead, so these tests go through
a real ``mcp.client.Client`` (in memory, and once over stdio), which a direct call skips.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any

import pytest
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters

from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.args import FreeTextFuncMetadata
from podcast_mcp.models import Transcript, TranscriptWord, load_project, save_project
from podcast_mcp.util.coded_error import CodedValueError


def _seed_word(path: str, text: str) -> None:
    proj = load_project(Path(path))
    proj.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text=text, start=0.0, end=0.5, confidence=0.9)],
        )
    ]
    save_project(proj, Path(path))


@pytest.fixture
def project(tmp_path, sample_wav) -> str:
    path = mcp_server.episode_create(str(tmp_path / "ws"))
    mcp_server.track_add(path, "host", str(sample_wav), role="dialogue")
    _seed_word(path, "hello")
    return path


def _refusal(result: Any) -> tuple[str, str]:
    """``(text, error_code)`` of an ``is_error`` result, checking both channels agree."""
    assert result.is_error, result.content
    text = result.content[0].text
    structured = result.structured_content
    assert structured["ok"] is False
    assert structured["error"] == text
    return text, structured["error_code"]


def _correct(project: str, **overrides: Any) -> tuple[str, dict[str, Any]]:
    args = {"project_path": project, "track_id": "host", "word_index": 0, "new_text": "Hi"}
    return "correct_transcript_tool", {**args, **overrides}


# (tool call, text the agent must see, error_code) for each refusal in #1178.
REFUSALS = [
    pytest.param(
        lambda p, tmp: _correct(p, expected_text="goodbye"),
        "changed since you read it",
        "transcript_changed",
        id="stale-expected-text",
    ),
    pytest.param(
        lambda p, tmp: _correct(p, word_index=99),
        "word_index out of range: 99",
        "word_index_out_of_range",
        id="word-index-out-of-range",
    ),
    pytest.param(
        lambda p, tmp: _correct(p, track_id="nope"),
        "no transcript for track 'nope'",
        "transcript_not_found",
        id="unknown-track",
    ),
    pytest.param(
        lambda p, tmp: ("get_comment_tool", {"project_path": p, "comment_id": "missing"}),
        "comment not found: missing",
        "comment_not_found",
        id="get-unknown-comment",
    ),
    pytest.param(
        lambda p, tmp: (
            "update_comment_tool",
            {"project_path": p, "comment_id": "missing", "body": "x"},
        ),
        "comment not found: missing",
        "comment_not_found",
        id="update-unknown-comment",
    ),
    pytest.param(
        lambda p, tmp: (
            "track_add",
            {"project_path": p, "track_id": "guest", "file_path": str(tmp / "missing.wav")},
        ),
        "audio file not found:",
        "file_not_found",
        id="track-add-missing-file",
    ),
    pytest.param(
        lambda p, tmp: (
            "get_comment_tool",
            {"project_path": str(tmp / "gone" / "episode.project.json"), "comment_id": "c"},
        ),
        "Project not found:",
        "project_not_found",
        id="missing-project",
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("call", "message", "code"), REFUSALS)
async def test_refusal_reaches_the_agent(project, tmp_path, call, message, code) -> None:
    name, arguments = call(project, tmp_path)
    async with Client(mcp_server.mcp) as client:
        result = await client.call_tool(name, arguments)

    text, error_code = _refusal(result)
    assert message in text
    assert not text.startswith("Error executing tool")
    assert error_code == code


@pytest.mark.asyncio
async def test_refusal_leaves_the_project_unchanged(project) -> None:
    name, arguments = _correct(project, expected_text="goodbye")
    async with Client(mcp_server.mcp) as client:
        await client.call_tool(name, arguments)

    assert load_project(Path(project)).transcripts[0].words[0].text == "hello"


@pytest.mark.asyncio
async def test_stdio_refusal_reaches_the_agent(project) -> None:
    """The ``podcast-mcp`` stdio server reports a refusal the same way."""
    params = StdioServerParameters(
        command=sys.executable, args=["-m", "podcast_mcp.mcp.server"], env=dict(os.environ)
    )
    async with Client(params) as client:
        result = await client.call_tool(
            "get_comment_tool", {"project_path": project, "comment_id": "missing"}
        )

    assert _refusal(result) == ("comment not found: missing", "comment_not_found")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "crash",
    [
        RuntimeError("secret internal detail /Users/someone/.cache"),
        ValueError("secret internal detail: invalid literal for int()"),
        KeyError("secret_internal_key"),
    ],
    ids=["RuntimeError", "plain-ValueError", "plain-KeyError"],
)
async def test_unexpected_exception_stays_generic_and_is_logged(
    project, monkeypatch, caplog, crash
) -> None:
    """A bug's text stays on the server: the agent sees only the generic SDK message."""

    def boom(self: Any, comment_id: str) -> Any:
        raise crash

    monkeypatch.setattr("podcast_mcp.services.document.comment.CommentService.get", boom)
    with caplog.at_level(logging.ERROR):
        async with Client(mcp_server.mcp) as client:
            result = await client.call_tool(
                "get_comment_tool", {"project_path": project, "comment_id": "c1"}
            )

    assert result.is_error
    assert [c.text for c in result.content] == ["Error executing tool get_comment_tool"]
    assert "secret" not in str(result.structured_content)
    logged = [r.exc_info[1] for r in caplog.records if r.exc_info]
    assert any("secret" in str(exc.__cause__) for exc in logged)  # kept server-side


# --- Every registered tool goes through the mapping ----------------------------------


def _registered_tool_names() -> list[str]:
    return sorted(tool.name for tool in mcp_server.mcp._tool_manager.list_tools())


TOOL_NAMES = _registered_tool_names()


def test_tool_table_is_the_whole_server() -> None:
    assert len(TOOL_NAMES) > 150
    assert {"correct_transcript_tool", "get_comment_tool", "track_add"} <= set(TOOL_NAMES)


@pytest.mark.asyncio
async def test_every_registered_tool_maps_refusals_and_hides_crashes(monkeypatch) -> None:
    """Each tool body raises in turn: a refusal keeps its text and code, a crash does not."""
    raised: dict[str, BaseException] = {}

    def validate_arguments(self: Any, arguments: dict[str, Any]) -> dict[str, Any]:
        return {}

    async def call_fn(self: Any, *args: Any, **kwargs: Any) -> Any:
        raise raised["exc"]

    monkeypatch.setattr(FreeTextFuncMetadata, "validate_arguments", validate_arguments)
    monkeypatch.setattr(FreeTextFuncMetadata, "call_fn", call_fn)
    refused, crashed = {}, {}
    async with Client(mcp_server.mcp) as client:
        for name in TOOL_NAMES:
            raised["exc"] = CodedValueError(f"{name} refused", code="table_refusal")
            refused[name] = await client.call_tool(name, {})
            raised["exc"] = RuntimeError(f"{name} secret")
            crashed[name] = await client.call_tool(name, {})

    for name in TOOL_NAMES:
        assert _refusal(refused[name]) == (f"{name} refused", "table_refusal"), name
        assert crashed[name].is_error, name
        assert crashed[name].content[0].text == f"Error executing tool {name}", name
