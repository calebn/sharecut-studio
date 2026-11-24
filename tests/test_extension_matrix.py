"""Extension matrix: every supported PODCAST_EXTENSIONS composition registers each surface once.

The provider extension is not in this repository, so `extension_stub_provider` stands
in for it. This does not replace the private overlay's own check.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest
from tests.extension_stub_provider import (
    STUB_CLI_COMMAND,
    STUB_MCP_TOOL,
    STUB_NAME,
    STUB_PATH,
    StubAccountMiddleware,
    StubEntryPoint,
)

from podcast_mcp.extensions import loader
from podcast_mcp.extensions.features import (
    FEATURE_EXTENSION_STATUS_0,
    FEATURE_ONLINE_ACCOUNT,
    FEATURE_SHARE_CLI,
    FEATURE_SHARE_MCP_TOOLS,
    FEATURE_SHARE_REMOTE_MCP,
    FEATURE_SHARE_ROUTES,
    FEATURE_SHARE_UI_BANNER,
    FEATURE_SHARE_UI_MENU,
    FEATURE_SHARE_UI_ROUTES,
    FEATURE_TUNNEL_STATUS,
)

ROOT = Path(__file__).resolve().parents[1]
MODES = ("none", "collaboration", "default", f"collaboration,{STUB_NAME}", STUB_NAME)
COLLABORATION_FEATURES = {
    FEATURE_SHARE_CLI,
    FEATURE_SHARE_MCP_TOOLS,
    FEATURE_SHARE_REMOTE_MCP,
    FEATURE_SHARE_ROUTES,
    FEATURE_SHARE_UI_BANNER,
    FEATURE_SHARE_UI_MENU,
    FEATURE_SHARE_UI_ROUTES,
    FEATURE_TUNNEL_STATUS,
}


def _has_collaboration(mode: str) -> bool:
    return mode in ("collaboration", "default") or "collaboration," in mode


def _has_stub(mode: str) -> bool:
    return STUB_NAME in mode


@pytest.fixture
def extensions_mode(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> str:
    """Select a composition without depending on which entry points the venv exposes."""
    mode: str = request.param
    if mode == "none":
        monkeypatch.setenv("PODCAST_EXTENSIONS", "")
    elif mode == "default":
        monkeypatch.delenv("PODCAST_EXTENSIONS", raising=False)
    else:
        monkeypatch.setenv("PODCAST_EXTENSIONS", mode)
    entry_points = [StubEntryPoint()] if _has_stub(mode) else []
    monkeypatch.setattr(loader, "_iter_entry_points", lambda: entry_points)
    return mode


@pytest.mark.parametrize("extensions_mode", MODES, indirect=True)
def test_each_feature_id_is_contributed_once_per_source(extensions_mode: str) -> None:
    registry = loader.load_extensions()
    ids = registry.feature_ids()
    expected = set()
    if _has_collaboration(extensions_mode):
        expected |= COLLABORATION_FEATURES
    if _has_stub(extensions_mode):
        expected.add(FEATURE_ONLINE_ACCOUNT)
    assert set(ids) == expected
    assert FEATURE_EXTENSION_STATUS_0 not in ids
    for feature_id in ids:
        sources = [c.source for c in registry.get(feature_id)]
        assert len(sources) == len(set(sources)), feature_id
        assert len(set(sources)) == 1, feature_id
    for feature_id in COLLABORATION_FEATURES & set(ids):
        assert [c.source for c in registry.get(feature_id)] == ["collaboration"]


def test_second_owner_of_a_share_slot_is_kept_and_warned(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("PODCAST_EXTENSIONS", f"collaboration,{STUB_NAME}")
    monkeypatch.setattr(loader, "_iter_entry_points", lambda: [StubEntryPoint(claims_share=True)])
    with caplog.at_level(logging.WARNING, logger="podcast_mcp.extensions.registry"):
        registry = loader.load_extensions()
    sources = sorted(c.source for c in registry.get(FEATURE_SHARE_ROUTES))
    assert sources == ["collaboration", STUB_NAME]
    warnings = [r.getMessage() for r in caplog.records]
    assert len(warnings) == 1
    assert FEATURE_SHARE_ROUTES in warnings[0]


def test_example_extension_loads_only_when_named(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(loader, "_iter_entry_points", lambda: [])
    monkeypatch.setenv("PODCAST_EXTENSIONS", "collaboration,example")
    ids = loader.load_extensions().feature_ids()
    assert set(ids) == COLLABORATION_FEATURES | {FEATURE_EXTENSION_STATUS_0}
    monkeypatch.setenv("PODCAST_EXTENSIONS", "example")
    assert loader.load_extensions().feature_ids() == [FEATURE_EXTENSION_STATUS_0]


@pytest.mark.parametrize("extensions_mode", MODES, indirect=True)
def test_gui_registers_each_route_operation_and_middleware_once(extensions_mode: str) -> None:
    from podcast_mcp.gui.server import create_app

    app = create_app()
    operation_ids = [
        op["operationId"]
        for item in app.openapi()["paths"].values()
        for op in item.values()
        if isinstance(op, dict) and "operationId" in op
    ]
    duplicated = sorted({o for o in operation_ids if operation_ids.count(o) > 1})
    assert duplicated == []
    middleware = [m.cls for m in app.user_middleware]
    assert len(middleware) == len(set(middleware))
    assert (StubAccountMiddleware in middleware) is _has_stub(extensions_mode)
    paths = app.openapi()["paths"]
    has_share_routes = any(p.startswith("/api/review/") for p in paths)
    assert has_share_routes is _has_collaboration(extensions_mode)
    assert (STUB_PATH in paths) is _has_stub(extensions_mode)


@pytest.mark.parametrize("extensions_mode", MODES, indirect=True)
def test_mcp_registers_each_tool_once(
    extensions_mode: str, caplog: pytest.LogCaptureFixture
) -> None:
    from mcp.server import MCPServer

    from podcast_mcp.mcp.tools import register_all

    mcp = MCPServer("matrix")
    with caplog.at_level(logging.WARNING):
        register_all(mcp)
    assert [r.getMessage() for r in caplog.records if "already exists" in r.getMessage()] == []
    names = {t.name for t in mcp._tool_manager.list_tools()}
    assert ("create_review_share_tool" in names) is _has_collaboration(extensions_mode)
    assert (STUB_MCP_TOOL in names) is _has_stub(extensions_mode)


_CLI_DUPLICATES = """
import json
import sys

if sys.argv[1:] == ["stub"]:
    from podcast_mcp.extensions import loader
    from tests.extension_stub_provider import StubEntryPoint

    loader._iter_entry_points = lambda: [StubEntryPoint()]

from podcast_mcp.cli.main import app

def walk(typer_app, path=""):
    names = [c.name or c.callback.__name__.replace("_", "-") for c in typer_app.registered_commands]
    groups = {g.name: g.typer_instance for g in typer_app.registered_groups}
    names += [g.name for g in typer_app.registered_groups]
    out = [path + "/" + n for n in sorted(set(names)) if names.count(n) > 1]
    for name, child in groups.items():
        out += walk(child, path + "/" + name)
    return out

top = [c.name or c.callback.__name__.replace("_", "-") for c in app.registered_commands]
print(json.dumps({"duplicates": walk(app), "top": top}))
"""


@pytest.mark.parametrize(
    "value", ["", "collaboration", None, f"collaboration,{STUB_NAME}", STUB_NAME]
)
def test_cli_registers_each_command_once(value: str | None) -> None:
    env = {k: v for k, v in os.environ.items() if k != "PODCAST_EXTENSIONS"}
    env["PYTHONPATH"] = (
        str(ROOT / "src") + os.pathsep + str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    )
    if value is not None:
        env["PODCAST_EXTENSIONS"] = value
    stub = value is not None and STUB_NAME in value
    result = subprocess.run(
        [sys.executable, "-c", _CLI_DUPLICATES, *(["stub"] if stub else [])],
        check=True,
        capture_output=True,
        text=True,
        cwd=str(ROOT),
        env=env,
    )
    out = json.loads(result.stdout.strip().splitlines()[-1])
    assert out["duplicates"] == []
    assert out["top"].count(STUB_CLI_COMMAND) == (1 if stub else 0)
