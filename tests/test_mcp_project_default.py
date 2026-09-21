"""Tests for PODCAST_MCP_PROJECT default project_path injection."""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("mcp.client")

from mcp.server.mcpserver.exceptions import ToolError

from podcast_mcp.mcp.project_default import (
    ENV_VAR,
    install_project_default,
    resolve_project_path,
    with_default_project,
)


def forward_referenced_extension_tool(project_path: Path) -> dict[str, str]:
    return {"project_name": project_path.name}


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
    with pytest.raises(ToolError, match=ENV_VAR):
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


def _tool_inventory(server: Any) -> dict[str, dict[str, Any]]:
    """Capture every externally visible registration field we must preserve."""
    return {
        tool.name: {
            "title": tool.title,
            "description": tool.description,
            "icons": tool.icons,
            "meta": tool.meta,
            "parameters": tool.parameters,
            "output_schema": tool.output_schema,
            "annotations": tool.annotations,
            "is_async": tool.is_async,
        }
        for tool in server._tool_manager.list_tools()
    }


def _without_project_path_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Remove precisely the schema change this feature is allowed to make."""
    copied = {**schema, "properties": dict(schema.get("properties", {}))}
    copied["properties"].pop("project_path", None)
    required = [name for name in copied.get("required", []) if name != "project_path"]
    if required:
        copied["required"] = required
    else:
        copied.pop("required", None)
    return copied


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
async def test_env_default_is_coerced_like_an_explicit_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mcp.client import Client
    from mcp.server import MCPServer

    class ExtensionPathTool:
        async def __call__(self, project_path: Path) -> str:
            return f"{project_path.name}:{isinstance(project_path, Path)}"

    monkeypatch.setenv(ENV_VAR, "/tmp/pinned.project.json")
    server = MCPServer("test-path-extension")
    install_project_default(server)
    # An extension may use an async callable instance and positional metadata.
    server.add_tool(
        ExtensionPathTool(),
        "extension_path",
        "Extension path",
        "Accept a pathlib project path.",
        None,
        None,
        {"source": "extension"},
        False,
    )
    async with Client(server) as client:
        result = await client.call_tool("extension_path", {})
        empty = await client.call_tool("extension_path", {"project_path": ""})
    assert result.content[0].text == "pinned.project.json:True"
    assert empty.content[0].text == "pinned.project.json:True"
    tool = server._tool_manager.get_tool("extension_path")
    assert tool is not None
    assert tool.title == "Extension path"
    assert tool.meta == {"source": "extension"}
    assert tool.is_async


def test_wrapper_resolves_extension_annotations_without_output_schema_drift() -> None:
    from mcp.server import MCPServer

    baseline = MCPServer("annotation-baseline")
    baseline.add_tool(forward_referenced_extension_tool, structured_output=True)
    wrapped = MCPServer("annotation-wrapped")
    install_project_default(wrapped)
    wrapped.add_tool(forward_referenced_extension_tool, structured_output=True)

    before = baseline._tool_manager.get_tool("forward_referenced_extension_tool")
    after = wrapped._tool_manager.get_tool("forward_referenced_extension_tool")
    assert before is not None
    assert after is not None
    assert before.output_schema == after.output_schema
    assert after.parameters["properties"]["project_path"]["anyOf"][0]["format"] == "path"


@pytest.mark.asyncio
async def test_installers_preserve_add_tool_contract_in_either_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mcp.client import Client
    from mcp.server import MCPServer

    from podcast_mcp.util.progress_install import install_mcp_progress

    monkeypatch.setenv(ENV_VAR, "/tmp/pinned.project.json")
    for installers in (
        (install_mcp_progress, install_project_default),
        (install_project_default, install_mcp_progress),
    ):
        server = MCPServer("test-installer-order")
        for install in installers:
            install(server)

        def positional_tool(project_path: str) -> str:
            return project_path

        server.add_tool(
            positional_tool,
            "positional_tool",
            "Positional tool",
            "All supported add_tool arguments remain positional.",
            None,
            None,
            {"order": "tested"},
            False,
        )
        async with Client(server) as client:
            result = await client.call_tool("positional_tool", {})
        tool = server._tool_manager.get_tool("positional_tool")
        assert result.content[0].text == "/tmp/pinned.project.json"
        assert tool is not None
        assert tool.title == "Positional tool"
        assert tool.meta == {"order": "tested"}


def test_registered_tool_inventory_changes_only_project_path_input_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mcp.server import MCPServer

    from podcast_mcp.mcp.tools import register_all

    # Production registration includes its built-in collaboration extension.
    # An empty allow-list from another test would hide that public contract.
    monkeypatch.delenv("PODCAST_EXTENSIONS", raising=False)
    baseline = MCPServer("baseline")
    register_all(baseline)
    wrapped = MCPServer("wrapped")
    install_project_default(wrapped)
    register_all(wrapped)

    before = _tool_inventory(baseline)
    after = _tool_inventory(wrapped)
    assert before.keys() == after.keys()
    for name, original in before.items():
        changed = after[name]
        for preserved_field in (
            "title",
            "description",
            "icons",
            "meta",
            "output_schema",
            "annotations",
            "is_async",
        ):
            assert original[preserved_field] == changed[preserved_field], (
                name,
                preserved_field,
            )
        assert _without_project_path_schema(original["parameters"]) == _without_project_path_schema(
            changed["parameters"]
        ), name
        has_project_path = "project_path" in original["parameters"].get("properties", {})
        if has_project_path:
            assert "project_path" not in (changed["parameters"].get("required") or []), name
        else:
            assert original["parameters"] == changed["parameters"], name


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
    # Note: description preservation through the wrapper is covered by
    # test_wrapper_makes_project_path_optional_and_preserves_metadata;
    # the real tool's docstring comes from a separate change.
