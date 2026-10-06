"""Extension matrix: every supported PODCAST_EXTENSIONS composition registers each surface once."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest

from podcast_mcp.extensions import loader
from podcast_mcp.extensions.features import (
    FEATURE_ONLINE_ACCOUNT,
    FEATURE_SHARE_CLI,
    FEATURE_SHARE_MCP_TOOLS,
    FEATURE_SHARE_ROUTES,
)

ROOT = Path(__file__).resolve().parents[1]
MODES = ("none", "collaboration", "default")


@pytest.fixture
def extensions_mode(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> str:
    """Select a composition without depending on which entry points the venv exposes."""
    mode: str = request.param
    if mode == "none":
        monkeypatch.setenv("PODCAST_EXTENSIONS", "")
    elif mode == "collaboration":
        monkeypatch.setenv("PODCAST_EXTENSIONS", "collaboration")
    else:
        monkeypatch.delenv("PODCAST_EXTENSIONS", raising=False)
    monkeypatch.setattr(loader, "_iter_entry_points", lambda: [])
    return mode


@pytest.mark.parametrize("extensions_mode", MODES, indirect=True)
def test_each_feature_id_is_contributed_once_per_source(extensions_mode: str) -> None:
    registry = loader.load_extensions()
    ids = registry.feature_ids()
    if extensions_mode == "none":
        assert ids == []
    else:
        assert {FEATURE_SHARE_ROUTES, FEATURE_SHARE_CLI, FEATURE_SHARE_MCP_TOOLS} <= set(ids)
    assert FEATURE_ONLINE_ACCOUNT not in ids
    for feature_id in ids:
        sources = [c.source for c in registry.get(feature_id)]
        assert len(sources) == len(set(sources)), feature_id


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
    has_share_routes = any(p.startswith("/api/review/") for p in app.openapi()["paths"])
    assert has_share_routes is (extensions_mode != "none")


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
    assert ("create_review_share_tool" in names) is (extensions_mode != "none")


_CLI_DUPLICATES = """
import json
from podcast_mcp.cli.main import app

def walk(typer_app, path=""):
    names = [c.name or c.callback.__name__.replace("_", "-") for c in typer_app.registered_commands]
    groups = {g.name: g.typer_instance for g in typer_app.registered_groups}
    names += [g.name for g in typer_app.registered_groups]
    out = [path + "/" + n for n in sorted(set(names)) if names.count(n) > 1]
    for name, child in groups.items():
        out += walk(child, path + "/" + name)
    return out

print(json.dumps(walk(app)))
"""


@pytest.mark.parametrize("value", ["", "collaboration", None])
def test_cli_registers_each_command_once(value: str | None) -> None:
    env = {k: v for k, v in os.environ.items() if k != "PODCAST_EXTENSIONS"}
    env["PYTHONPATH"] = str(ROOT / "src") + os.pathsep + env.get("PYTHONPATH", "")
    if value is not None:
        env["PODCAST_EXTENSIONS"] = value
    result = subprocess.run(
        [sys.executable, "-c", _CLI_DUPLICATES],
        check=True,
        capture_output=True,
        text=True,
        cwd=str(ROOT),
        env=env,
    )
    assert json.loads(result.stdout.strip().splitlines()[-1]) == []
