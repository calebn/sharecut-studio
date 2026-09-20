"""PODCAST_GUI_DIST vs repo-layout Sharecut Studio static root."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.gui.static_assets import repo_gui_dist, resolve_gui_static_root


def test_repo_layout_is_gui_web_dist(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PODCAST_GUI_DIST", raising=False)
    root = repo_gui_dist()
    assert root.parts[-3:] == ("gui", "web", "dist")
    assert resolve_gui_static_root() == root


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
