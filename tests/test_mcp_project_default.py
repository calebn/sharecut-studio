"""Tests for PODCAST_MCP_PROJECT default project_path injection."""

from __future__ import annotations

import inspect

import pytest

pytest.importorskip("mcp.client")

from podcast_mcp.mcp.project_default import (
    ENV_VAR,
    install_project_default,
    resolve_project_path,
    with_default_project,
)


def test_resolve_prefers_explicit_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_VAR, "/tmp/pinned.project.json")
    assert resolve_project_path("/tmp/explicit.project.json") == "/tmp/explicit.project.json"


def test_resolve_falls_back_to_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_VAR, "/tmp/pinned.project.json")
    assert resolve_project_path(None) == "/tmp/pinned.project.json"
    assert resolve_project_path("") == "/tmp/pinned.project.json"


def test_resolve_raises_helpfully_without_either(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ENV_VAR, raising=False)
    with pytest.raises(ValueError, match=ENV_VAR):
        resolve_project_path(None)


def _sample_tool(project_path: str, other: int = 1) -> str:
    """Sample tool docstring."""
    return f"{project_path}:{other}"


def test_wrapper_leaves_functions_without_project_path_alone() -> None:
    def no_path(other: str) -> str:
        return other

    assert with_default_project(no_path) is no_path


def test_wrapper_leaves_already_optional_alone() -> None:
    def already_optional(project_path: str | None = None) -> str:
        return str(project_path)

    assert with_default_project(already_optional) is already_optional


def test_wrapper_makes_project_path_optional_and_preserves_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(ENV_VAR, "/tmp/pinned.project.json")
    wrapped = with_default_project(_sample_tool)
    assert wrapped is not _sample_tool
    assert wrapped.__name__ == "_sample_tool"
    assert wrapped.__doc__ == "Sample tool docstring."

    sig = inspect.signature(wrapped)
    param = sig.parameters["project_path"]
    assert param.default is None
    # project_path moves after the other required params (a defaulted
    # parameter may not precede a required one); other params untouched
    assert list(sig.parameters) == ["other", "project_path"]
    assert sig.parameters["other"].default == 1

    # env default kicks in when omitted or empty ...
    assert wrapped() == "/tmp/pinned.project.json:1"
    assert wrapped(project_path="") == "/tmp/pinned.project.json:1"
    # ... explicit wins, by keyword or in the wrapper's parameter order
    assert (
        wrapped(project_path="/tmp/explicit.project.json", other=2)
        == "/tmp/explicit.project.json:2"
    )
    assert wrapped(2, "/tmp/explicit.project.json") == "/tmp/explicit.project.json:2"


def test_wrapper_raises_without_path_or_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ENV_VAR, raising=False)
    wrapped = with_default_project(_sample_tool)
    with pytest.raises(ValueError, match=ENV_VAR):
        wrapped()


@pytest.mark.asyncio
async def test_wrapper_supports_async_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ENV_VAR, "/tmp/pinned.project.json")

    async def async_tool(project_path: str) -> str:
        """Async sample."""
        return project_path

    wrapped = with_default_project(async_tool)
    assert inspect.iscoroutinefunction(wrapped)
    assert await wrapped() == "/tmp/pinned.project.json"


def _make_server():
    from mcp.server import MCPServer

    server = MCPServer("test-project-default")
    install_project_default(server)

    @server.tool()
    def echo_project_tool(project_path: str) -> str:
        """Echo the effective project path."""
        return project_path

    return server


@pytest.mark.asyncio
async def test_installed_server_schema_marks_project_path_optional() -> None:
    from mcp.client import Client

    async with Client(_make_server()) as client:
        (tool,) = [t for t in (await client.list_tools()).tools if t.name == "echo_project_tool"]
    assert "project_path" not in (tool.input_schema.get("required") or [])


@pytest.mark.asyncio
async def test_installed_server_injects_env_default(monkeypatch: pytest.MonkeyPatch) -> None:
    from mcp.client import Client

    monkeypatch.setenv(ENV_VAR, "/tmp/pinned.project.json")
    async with Client(_make_server()) as client:
        result = await client.call_tool("echo_project_tool", {})
        assert result.is_error in (None, False)
        assert result.content[0].text == "/tmp/pinned.project.json"

        explicit = await client.call_tool(
            "echo_project_tool", {"project_path": "/tmp/explicit.project.json"}
        )
        assert explicit.content[0].text == "/tmp/explicit.project.json"


@pytest.mark.asyncio
async def test_installed_server_errors_helpfully_without_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mcp.client import Client

    monkeypatch.delenv(ENV_VAR, raising=False)
    async with Client(_make_server()) as client:
        result = await client.call_tool("echo_project_tool", {})
    assert result.is_error
    assert ENV_VAR in result.content[0].text


def test_real_server_tool_schema_marks_project_path_optional() -> None:
    from podcast_mcp.mcp.server import mcp

    tool = mcp._tool_manager.get_tool("align_status_tool")
    assert tool is not None
    assert tool.name == "align_status_tool"  # name stability preserved
    assert "project_path" not in ((tool.parameters or {}).get("required") or [])
    # description from docstring preserved through the wrapper
    assert tool.description
