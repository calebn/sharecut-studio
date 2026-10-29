"""A real non-UTF-8 project folder is refused before it is pinned (trail 2295i)."""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.gui.server import create_app
from podcast_mcp.project.io import ensure_utf8_path

CODE = "X-Sharecut-Error-Code"
LOOPBACK = ("127.0.0.1", 50000)
BAD = "caf\udce9"

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="needs a non-UTF-8 directory name")


def _project_in(parent: Path, name: str, source: Path) -> Path:
    raw = os.path.join(os.fsencode(parent), os.fsencode(name))
    try:
        os.mkdir(raw)
    except OSError:
        pytest.skip("filesystem refuses this directory name")
    dest = Path(os.fsdecode(raw)) / "episode.project.json"
    shutil.copy(source, dest)
    return dest


@pytest.fixture
def bad_project(tmp_path, minimal_project) -> Path:
    assert os.fsencode(BAD) == b"caf\xe9"
    return _project_in(tmp_path, BAD, minimal_project)


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(), client=LOOPBACK, raise_server_exceptions=False)


def _post(client: TestClient, url: str, **body):
    raw = json.dumps(body, ensure_ascii=True).encode()
    return client.post(url, content=raw, headers={"content-type": "application/json"})


def _refused(res) -> None:
    assert res.status_code == 400, res.text
    assert res.headers[CODE] == "project_path_invalid"
    assert "\\udce9" in res.text


def test_open_refuses_and_pins_nothing(client, bad_project):
    _refused(_post(client, "/api/project/open", path=str(bad_project)))
    assert client.app.state.served_project is None
    assert client.get("/api/projects/recent").status_code == 200


def test_pick_result_refused(client, bad_project, monkeypatch):
    from podcast_mcp.gui.host_file_dialog import HostPickResult
    from podcast_mcp.gui.routes import project as mod

    monkeypatch.setattr(
        mod, "pick_episode_project_path", lambda: HostPickResult(path=str(bad_project))
    )
    _refused(client.post("/api/project/pick"))


def test_resolve_project_refuses_without_pinning(bad_project):
    from fastapi import HTTPException

    from podcast_mcp.gui.routes.deps import resolve_project

    with pytest.raises(HTTPException) as info:
        resolve_project(str(bad_project))
    assert info.value.status_code == 400
    assert info.value.headers[CODE] == "project_path_invalid"


def test_create_refuses_without_making_the_directory(client, tmp_path):
    target = tmp_path / BAD
    _refused(_post(client, "/api/project/create", workspace_dir=str(target)))
    assert not os.path.lexists(os.fsencode(target))
    assert client.app.state.served_project is None


def test_root_still_redirects_to_pinned_project(tmp_path, minimal_project, bad_project):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html><head></head></html>", encoding="utf-8")
    client = TestClient(
        create_app(static_dir=dist, served_project=minimal_project),
        client=LOOPBACK,
        raise_server_exceptions=False,
        follow_redirects=False,
    )
    _refused(_post(client, "/api/project/open", path=str(bad_project)))
    res = client.get("/")
    assert res.status_code == 307
    assert str(minimal_project) in res.headers["location"].replace("%2F", "/")


def test_root_belt_for_programmatic_pin(tmp_path, bad_project):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html><head></head></html>", encoding="utf-8")
    client = TestClient(
        create_app(static_dir=dist, served_project=bad_project),
        client=LOOPBACK,
        raise_server_exceptions=False,
        follow_redirects=False,
    )
    assert client.get("/").status_code == 200


def test_valid_projects_still_open(client, tmp_path, minimal_project):
    res = _post(client, "/api/project/open", path=str(minimal_project))
    assert res.status_code == 200, res.text
    assert client.app.state.served_project == minimal_project.resolve()
    accented = _project_in(tmp_path, "café", minimal_project)
    res = _post(client, "/api/project/open", path=str(accented))
    assert res.status_code == 200, res.text


def test_cli_project_flag_fails_fast(bad_project, monkeypatch):
    from podcast_mcp.cli import gui as mod

    monkeypatch.setattr(mod, "packaged_cli_gui_refusal", lambda: None)
    monkeypatch.setattr(
        mod, "create_app", lambda **_: pytest.fail("must not build the app"), raising=False
    )
    res = CliRunner().invoke(mod.gui_app, ["--project", str(bad_project)])
    assert res.exit_code == 1
    assert "Error: " in res.output
    assert "\\udce9" in res.output


def test_ensure_utf8_path_unit():
    ensure_utf8_path("/x/café/episode.project.json")
    with pytest.raises(ValueError, match="not valid UTF-8"):
        ensure_utf8_path("/x/caf\udce9/episode.project.json")


def test_post_body_path_with_unencodable_surrogate_is_refused(client):
    res = _post(client, "/api/shares", path="/tmp/caf\ud800/episode.project.json", role="viewer")
    assert res.status_code == 400, res.text
    assert res.headers[CODE] == "project_path_invalid"


@pytest.mark.parametrize("given", [False, True])
def test_create_with_surrogate_name_is_refused_and_leaves_nothing(
    client, tmp_path, monkeypatch, given
):
    monkeypatch.setenv("PODCAST_WORKSPACE_ROOT", str(tmp_path / "root"))
    target = tmp_path / "given" / "ep"
    res = _post(
        client,
        "/api/project/create",
        name=BAD,
        workspace_dir=str(target) if given else "",
    )
    _refused(res)
    assert not target.exists()
    assert not (tmp_path / "root").exists() or not os.listdir(tmp_path / "root")
    assert client.app.state.served_project is None


def test_ensure_viewer_refuses_non_utf8_project(bad_project, monkeypatch):
    from podcast_mcp.services.app import gui_launch

    monkeypatch.setattr(gui_launch, "packaged_cli_gui_refusal", lambda: None)
    result = gui_launch.ensure_viewer(bad_project, open_browser=False)
    assert result.ok is False
    assert "not valid UTF-8" in result.error
    result.to_json().encode("utf-8")
