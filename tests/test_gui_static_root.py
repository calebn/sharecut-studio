"""PODCAST_GUI_DIST vs repo-layout Sharecut Studio static root."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.gui import static_assets
from podcast_mcp.gui.static_assets import repo_gui_dist, resolve_gui_static_root


def test_repo_layout_is_gui_web_dist(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PODCAST_GUI_DIST", raising=False)
    root = repo_gui_dist()
    assert root.parts[-3:] == ("gui", "web", "dist")
    assert resolve_gui_static_root() == root


@pytest.fixture
def packaged_dist(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Where an installed wheel keeps the web build ``hatch_build.py`` copied in."""
    dist = tmp_path / "site-packages" / "podcast_mcp" / "gui" / "web_dist"
    monkeypatch.setattr(static_assets, "_PACKAGED_GUI_DIST", dist)
    monkeypatch.delenv("PODCAST_GUI_DIST", raising=False)
    return dist


def test_wheel_web_build_resolves_before_repo_layout(packaged_dist: Path) -> None:
    packaged_dist.mkdir(parents=True)
    (packaged_dist / "index.html").write_text("<html>wheel</html>", encoding="utf-8")
    assert resolve_gui_static_root() == packaged_dist


def test_wheel_without_web_build_falls_back_to_repo_layout(packaged_dist: Path) -> None:
    packaged_dist.mkdir(parents=True)
    assert resolve_gui_static_root() == repo_gui_dist()


def test_podcast_gui_dist_overrides_wheel_web_build(
    packaged_dist: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    packaged_dist.mkdir(parents=True)
    (packaged_dist / "index.html").write_text("<html>wheel</html>", encoding="utf-8")
    override = tmp_path / "override"
    monkeypatch.setenv("PODCAST_GUI_DIST", str(override))
    assert resolve_gui_static_root() == override.resolve()


def test_podcast_gui_dist_overrides_repo_layout(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    bundled = tmp_path / "sharecut-runtime" / "web-dist"
    bundled.mkdir(parents=True)
    (bundled / "index.html").write_text("<html>bundled</html>", encoding="utf-8")
    monkeypatch.setenv("PODCAST_GUI_DIST", str(bundled))
    assert resolve_gui_static_root() == bundled.resolve()


def test_blank_podcast_gui_dist_falls_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PODCAST_GUI_DIST", "   ")
    assert resolve_gui_static_root() == repo_gui_dist()


def test_create_app_serves_bundled_dist(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    bundled = tmp_path / "web-dist"
    bundled.mkdir()
    (bundled / "index.html").write_text("<html>from-env</html>", encoding="utf-8")
    monkeypatch.setenv("PODCAST_GUI_DIST", str(bundled))
    client = TestClient(create_app(served_project=None))
    res = client.get("/")
    assert res.status_code == 200
    assert "from-env" in res.text


def test_explicit_static_dir_wins_over_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    env_dist = tmp_path / "env"
    env_dist.mkdir()
    (env_dist / "index.html").write_text("<html>env</html>", encoding="utf-8")
    arg_dist = tmp_path / "arg"
    arg_dist.mkdir()
    (arg_dist / "index.html").write_text("<html>arg</html>", encoding="utf-8")
    monkeypatch.setenv("PODCAST_GUI_DIST", str(env_dist))
    client = TestClient(create_app(static_dir=arg_dist, served_project=None))
    res = client.get("/")
    assert res.status_code == 200
    assert "arg" in res.text
    assert "env" not in res.text


@pytest.fixture
def empty_dist(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """A wheel install: ``PODCAST_GUI_DIST`` unset and no ``index.html`` anywhere."""
    dist = tmp_path / "no-web-build"
    monkeypatch.setenv("PODCAST_GUI_DIST", str(dist))
    return dist


@pytest.mark.parametrize("create_dir", [False, True])
def test_root_explains_missing_web_build(empty_dist: Path, create_dir: bool) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    if create_dir:
        empty_dist.mkdir()
    client = TestClient(create_app(served_project=None))
    res = client.get("/")
    assert res.status_code == 503
    assert res.headers["content-type"].startswith("text/html")
    assert res.headers["cache-control"] == "no-store"
    assert "cd gui/web &amp;&amp; npm ci &amp;&amp; npm run build" in res.text
    assert "PODCAST_GUI_DIST" in res.text
    assert str(empty_dist) in res.text
    assert client.get("/api/features").status_code == 200


def test_root_page_escapes_the_configured_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.setenv("PODCAST_GUI_DIST", str(tmp_path / "<script>alert(1)</script>"))
    res = TestClient(create_app(served_project=None)).get("/")
    assert "<script>alert(1)</script>" not in res.text
    assert "&lt;script&gt;" in res.text


def test_gui_command_prints_one_startup_line_when_web_build_missing(
    empty_dist: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("fastapi")
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    served: list[object] = []
    monkeypatch.setattr("podcast_mcp.gui.bind.run_gui_server", lambda a, **kw: served.append(a))
    result = CliRunner().invoke(app, ["gui", "--no-open"])
    assert result.exit_code == 0
    assert served
    lines = [line for line in result.output.splitlines() if "web build" in line]
    assert len(lines) == 1
    assert "cd gui/web && npm ci && npm run build" in lines[0]
    assert "PODCAST_GUI_DIST" in lines[0]
    assert str(empty_dist) in lines[0]


def test_gui_command_is_silent_when_web_build_present(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pytest.importorskip("fastapi")
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    dist = tmp_path / "web-dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html></html>", encoding="utf-8")
    monkeypatch.setenv("PODCAST_GUI_DIST", str(dist))
    monkeypatch.setattr("podcast_mcp.gui.bind.run_gui_server", lambda a, **kw: None)
    result = CliRunner().invoke(app, ["gui", "--no-open"])
    assert result.exit_code == 0
    assert "web build" not in result.output
