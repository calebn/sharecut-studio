"""Tests for Sharecut Studio Extensions API (FeatureRegistry, soft-load, absent=no-mount)."""

from __future__ import annotations

import os
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def test_registry_ignores_unknown_feature_ids() -> None:
    from podcast_mcp.extensions.registry import FeatureRegistry

    reg = FeatureRegistry()
    reg.add("not.a.real.feature", source="x")
    assert reg.feature_ids() == []


def test_registry_get_and_manifest() -> None:
    from podcast_mcp.extensions.api_version import HOST_API_VERSION
    from podcast_mcp.extensions.features import FEATURE_SHARE_UI_MENU
    from podcast_mcp.extensions.registry import FeatureRegistry

    reg = FeatureRegistry()
    assert reg.get(FEATURE_SHARE_UI_MENU) == []
    reg.add(FEATURE_SHARE_UI_MENU, source="t", payload={"ok": True})
    assert len(reg.get(FEATURE_SHARE_UI_MENU)) == 1
    m = reg.to_manifest()
    assert m["api_version"] == HOST_API_VERSION
    assert FEATURE_SHARE_UI_MENU in m["features"]


def test_registry_mcp_cli_spa_helpers() -> None:
    from podcast_mcp.extensions.registry import FeatureRegistry

    reg = FeatureRegistry()
    called: list[str] = []

    def mcp_reg(_mcp: object) -> None:
        called.append("mcp")

    def cli_reg(_app: object) -> None:
        called.append("cli")

    def spa(**_kwargs: object) -> str:
        return "html"

    reg.add_mcp_registrar(mcp_reg, source="t")
    reg.add_cli_registrar(cli_reg, source="t")
    reg.add_spa_hook(spa, source="t")
    assert reg.has("share.mcp_tools")
    assert reg.has("share.cli")
    assert reg.has("share.ui.routes")
    assert len(reg.mcp_registrars) == 1
    assert len(reg.cli_registrars) == 1
    assert len(reg.spa_hooks) == 1
    reg.mcp_registrars[0](object())
    reg.cli_registrars[0](object())
    assert called == ["mcp", "cli"]


def test_caps_module_exports() -> None:
    from podcast_mcp.extensions import caps

    assert "play" in caps.ALL_CAPABILITIES
    assert "edit" in caps.HOST_OWNER_CAPABILITIES


def test_example_extension_contributes_status_slot() -> None:
    from podcast_mcp.extensions.example import ExampleExtension, create
    from podcast_mcp.extensions.features import FEATURE_EXTENSION_STATUS_0
    from podcast_mcp.extensions.registry import FeatureRegistry

    assert create().name == "example"
    reg = FeatureRegistry()
    ExampleExtension().contribute(reg)
    assert reg.has(FEATURE_EXTENSION_STATUS_0)
    assert ExampleExtension().compatible(1) is True
    assert ExampleExtension().compatible(0) is False


def test_broken_extension_soft_skips() -> None:
    from podcast_mcp.extensions import loader
    from podcast_mcp.extensions.registry import FeatureRegistry

    class Boom:
        api_version = 1
        name = "boom"

        def compatible(self, host_api_version: int) -> bool:
            return True

        def contribute(self, registry: FeatureRegistry) -> None:
            raise RuntimeError("nope")

    reg = loader.load_extensions(extra_backends=[Boom()])  # type: ignore[list-item]
    assert isinstance(reg, FeatureRegistry)


def test_incompatible_extension_skipped() -> None:
    from podcast_mcp.extensions.loader import load_extensions
    from podcast_mcp.extensions.registry import FeatureRegistry

    class Old:
        api_version = 99
        name = "old"

        def compatible(self, host_api_version: int) -> bool:
            return False

        def contribute(self, registry: FeatureRegistry) -> None:
            registry.add("share.ui.menu", source="old")

    reg = load_extensions(extra_backends=[Old()])  # type: ignore[list-item]
    # May still have online/example from default load
    assert not any(c.source == "old" for c in reg.get("share.ui.menu"))


def test_allowlist_filters_extras(monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.extensions.example import ExampleExtension
    from podcast_mcp.extensions.features import FEATURE_EXTENSION_STATUS_0
    from podcast_mcp.extensions.loader import load_extensions

    monkeypatch.setenv("PODCAST_EXTENSIONS", "example")
    reg = load_extensions(extra_backends=[ExampleExtension()])
    assert reg.has(FEATURE_EXTENSION_STATUS_0)
    assert not reg.has("share.ui.routes")


def test_empty_extensions_env_loads_none(monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.extensions.loader import load_extensions

    monkeypatch.setenv("PODCAST_EXTENSIONS", "")
    reg = load_extensions(extra_backends=[object()])  # type: ignore[list-item]
    assert reg.feature_ids() == []
    assert list(reg.routers) == []


def test_allowlist_none_parses_csv(monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.extensions import loader

    monkeypatch.setenv("PODCAST_EXTENSIONS", " online , example ")
    assert loader._allowlist() == {"online", "example"}


def test_default_loader_does_not_import_online(monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.extensions import loader

    monkeypatch.delenv("PODCAST_EXTENSIONS", raising=False)
    monkeypatch.setattr(loader, "_iter_entry_points", lambda: [])
    real_import = __import__

    def guarded_import(name: str, *args: object, **kwargs: object) -> object:
        if name.startswith("podcast_online"):
            raise AssertionError("FOSS default imported podcast_online")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr("builtins.__import__", guarded_import)
    reg = loader.load_extensions()

    assert reg.has("share.routes")
    assert not reg.has("online.account")


def test_foss_wheel_config_omits_online_package_and_entry_point() -> None:
    root = Path(__file__).resolve().parents[1]
    config = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))

    wheel_packages = config["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"]
    entry_points = config["project"]["entry-points"]["podcast_mcp.extensions"]
    assert "src/podcast_online" not in wheel_packages
    assert entry_points["collaboration"] == "podcast_mcp.extensions.collaboration:create"
    assert "online" not in entry_points


def test_apply_gui_extensions_sets_state() -> None:
    from fastapi import APIRouter

    from podcast_mcp.extensions.loader import apply_gui_extensions
    from podcast_mcp.extensions.registry import FeatureRegistry

    app = FastAPI()
    reg = FeatureRegistry()
    r = APIRouter()

    @r.get("/ext-probe")
    def _probe() -> dict[str, str]:
        return {"ok": "1"}

    reg.add_router(r, source="t")
    apply_gui_extensions(app, reg)
    assert app.state.feature_registry is reg
    client = TestClient(app)
    assert client.get("/ext-probe").json() == {"ok": "1"}


def test_create_app_without_extensions_has_no_review_routes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PODCAST_EXTENSIONS", "")
    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    feats = client.get("/api/features").json()
    assert feats["features"] == []
    paths = {getattr(r, "path", None) for r in create_app().routes}
    assert not any(
        isinstance(p, str) and ("/api/review" in p or p.startswith("/auth")) for p in paths if p
    )


def test_create_app_default_loads_collaboration_features(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from podcast_mcp.extensions import loader

    monkeypatch.delenv("PODCAST_EXTENSIONS", raising=False)
    monkeypatch.setattr(loader, "_iter_entry_points", lambda: [])
    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    feats = client.get("/api/features").json()
    assert "share.ui.routes" in feats["features"]
    assert "share.routes" in feats["features"]
    assert "online.account" not in feats["features"]


def test_create_app_review_spa_when_collaboration(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from podcast_mcp.extensions import loader

    monkeypatch.delenv("PODCAST_EXTENSIONS", raising=False)
    monkeypatch.setattr(loader, "_iter_entry_points", lambda: [])
    from podcast_mcp.gui.server import create_app

    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html></html>", encoding="utf-8")
    (dist / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    app = create_app(static_dir=dist)
    client = TestClient(app)
    # Unknown tokens 404 after prefix↔kind lookup (same as a revoked share).
    res = client.get("/r/not-a-real-token")
    assert res.status_code == 404
    assert client.get("/rec/not-a-real-token").status_code == 404


def test_empty_extensions_omit_share_mcp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mcp.server import MCPServer

    from podcast_mcp.mcp.tools import register_all

    monkeypatch.setenv("PODCAST_EXTENSIONS", "")
    mcp = MCPServer("t")
    register_all(mcp)
    names = {t.name for t in mcp._tool_manager.list_tools()}
    assert "create_review_share_tool" not in names
    assert "publish_review_version_tool" in names


def test_empty_extensions_has_no_share_cli(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from podcast_mcp.extensions.features import FEATURE_SHARE_CLI
    from podcast_mcp.extensions.loader import load_extensions

    monkeypatch.setenv("PODCAST_EXTENSIONS", "")
    reg = load_extensions()
    assert not reg.has(FEATURE_SHARE_CLI)
    assert list(reg.cli_registrars) == []


def test_collaboration_contribute_registers_share_cli() -> None:
    from podcast_mcp.extensions.collaboration import CollaborationExtension
    from podcast_mcp.extensions.features import FEATURE_SHARE_CLI
    from podcast_mcp.extensions.registry import FeatureRegistry

    reg = FeatureRegistry()
    CollaborationExtension().contribute(reg)
    assert reg.has(FEATURE_SHARE_CLI)
    assert len(reg.cli_registrars) == 1


def test_collaboration_contribute_cli_without_gui_extra(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CLI share mint must register even when FastAPI/gui imports fail."""
    from podcast_mcp.extensions.collaboration import CollaborationExtension
    from podcast_mcp.extensions.features import FEATURE_SHARE_CLI, FEATURE_SHARE_UI_ROUTES
    from podcast_mcp.extensions.registry import FeatureRegistry

    def _boom(_self: CollaborationExtension, _registry: FeatureRegistry) -> None:
        raise ImportError("fastapi missing")

    monkeypatch.setattr(CollaborationExtension, "_contribute_gui", _boom)
    reg = FeatureRegistry()
    CollaborationExtension().contribute(reg)
    assert reg.has(FEATURE_SHARE_CLI)
    assert reg.has("share.mcp_tools")
    assert not reg.has(FEATURE_SHARE_UI_ROUTES)
    assert list(reg.routers) == []
    assert list(reg.middlewares) == []


def test_register_share_cli_adds_share_help() -> None:
    import typer
    from typer.testing import CliRunner

    from podcast_mcp.cli.review import register_share_cli

    iso = typer.Typer()
    register_share_cli(iso)
    result = CliRunner().invoke(iso, ["share", "--help"])
    assert result.exit_code == 0
    assert "share" in result.output.lower()


def test_collaboration_cli_registrar_uses_host_and_is_idempotent() -> None:
    import typer
    from typer.main import get_command
    from typer.testing import CliRunner

    from podcast_mcp.extensions.collaboration import CollaborationExtension
    from podcast_mcp.extensions.loader import apply_cli_extensions
    from podcast_mcp.extensions.registry import FeatureRegistry

    root = typer.Typer()
    review = typer.Typer()
    root.add_typer(review, name="review")
    reg = FeatureRegistry()
    CollaborationExtension().contribute(reg)

    apply_cli_extensions(root, reg)
    apply_cli_extensions(root, reg)

    result = CliRunner().invoke(root, ["review", "share", "--help"])
    assert result.exit_code == 0, result.output
    review_group = get_command(root).commands["review"]
    command_names = list(review_group.commands)
    assert len(command_names) == len(set(command_names))


def test_loader_skips_duplicate_canonical_backend_names(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    from podcast_mcp.extensions import loader
    from podcast_mcp.extensions.collaboration import CollaborationExtension

    class CollaborationEP:
        name = "collaboration"

        def load(self):
            return CollaborationExtension

    monkeypatch.setenv("PODCAST_EXTENSIONS", "collaboration")
    monkeypatch.setattr(loader, "_iter_entry_points", lambda: [CollaborationEP()])
    reg = loader.load_extensions(extra_backends=[CollaborationExtension()])

    assert len(reg.get("share.routes")) == 1
    assert len(reg.routers) == 4
    assert len(reg.middlewares) == 1
    assert len(reg.mcp_registrars) == 1
    assert len(reg.cli_registrars) == 1
    assert len(reg.spa_hooks) == 1
    assert "skip duplicate extension collaboration" in caplog.text


def test_cli_share_commands_gated_in_subprocess() -> None:
    """Fresh process: share mint CLI only when collaboration loads."""
    root = Path(__file__).resolve().parents[1]
    src = str(root / "src")
    py_path = src + (os.pathsep + os.environ["PYTHONPATH"] if os.environ.get("PYTHONPATH") else "")
    code = (
        "import sys\n"
        "from podcast_mcp.cli.main import app\n"
        "raise SystemExit(app(standalone_mode=False))\n"
    )

    def _run(env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-c", code, *args],
            check=False,
            capture_output=True,
            text=True,
            cwd=str(root),
            env=env,
        )

    base = {k: v for k, v in os.environ.items() if k != "PODCAST_EXTENSIONS"}
    base["PYTHONPATH"] = py_path

    missing = _run({**base, "PODCAST_EXTENSIONS": ""}, "review", "share", "--help")
    assert missing.returncode != 0, missing.stdout + missing.stderr

    core = _run({**base, "PODCAST_EXTENSIONS": ""}, "review", "list-versions", "--help")
    assert core.returncode == 0, core.stdout + core.stderr

    present = _run(base, "review", "share", "--help")
    assert present.returncode == 0, present.stdout + present.stderr


def test_contracts_caps_json_sync() -> None:
    root = Path(__file__).resolve().parents[1]
    proc = subprocess.run(
        [sys.executable, str(root / "scripts" / "check_extension_contracts.py")],
        check=False,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout


def test_protocol_version_exported() -> None:
    from podcast_relay.protocol import PROTOCOL_VERSION, msg

    assert PROTOCOL_VERSION >= 1
    h = msg("hello", protocol_version=PROTOCOL_VERSION)
    assert h["type"] == "hello"
    assert h["protocol_version"] == PROTOCOL_VERSION


def test_iter_entry_points_legacy_api(monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.extensions import loader

    class Legacy:
        def get(self, group: str, default: list | None = None) -> list:
            assert group == loader.ENTRY_POINT_GROUP
            return []

    monkeypatch.setattr(loader, "entry_points", lambda: Legacy())
    assert loader._iter_entry_points() == []


def test_entry_point_load_failure_soft_skips(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from podcast_mcp.extensions import loader

    class BadEP:
        name = "bad"

        def load(self) -> None:
            raise RuntimeError("boom")

    monkeypatch.setenv("PODCAST_EXTENSIONS", "bad")
    monkeypatch.setattr(loader, "_iter_entry_points", lambda: [BadEP()])
    reg = loader.load_extensions()
    assert reg.feature_ids() == []


def test_builtin_fallbacks_when_import_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from podcast_mcp.extensions import loader

    monkeypatch.delenv("PODCAST_EXTENSIONS", raising=False)
    monkeypatch.setattr(loader, "_iter_entry_points", lambda: [])

    real_import = __import__

    def fake_import(name: str, *args: object, **kwargs: object) -> object:
        if name.endswith("extensions.collaboration") or name.endswith("extensions.example"):
            raise ImportError("forced")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr("builtins.__import__", fake_import)
    # Still should not raise
    from podcast_mcp.extensions.loader import load_extensions

    load_extensions()


def test_extra_backend_filtered_by_allowlist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from podcast_mcp.extensions.example import ExampleExtension
    from podcast_mcp.extensions.loader import load_extensions

    monkeypatch.setenv("PODCAST_EXTENSIONS", "online")
    reg = load_extensions(extra_backends=[ExampleExtension()])
    assert not reg.has("extension.status.0")


def test_relay_package_getattr() -> None:
    import podcast_relay as pr

    assert pr.PROTOCOL_VERSION >= 1
    assert callable(pr.create_relay_app)
    with pytest.raises(AttributeError):
        _ = pr.not_a_thing  # type: ignore[attr-defined]
