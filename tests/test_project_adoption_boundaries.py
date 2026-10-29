"""The retired entry file is renamed only where a project is really opened.

Discovery and polls resolve the name without touching the disk; every opener adopts it once
before its first read.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.gui import gui_app
from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.cli.setup_cmd import setup_app
from podcast_mcp.gui.routes import handoff
from podcast_mcp.gui.server import create_app
from podcast_mcp.project.io import RETIRED_PROJECT_FILENAME, adopt_retired_entry_file
from podcast_mcp.services.app import (
    ProjectWorkspace,
    ensure_viewer,
    locate_studio,
    read_studio_host,
    studio_host_path,
)
from podcast_mcp.services.app.recent_projects import (
    RecentEntry,
    read_recent,
    recent_projects_path,
    record_recent,
)
from podcast_mcp.services.app.studio_host import HANDOFF_TOKEN_HEADER
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import (
    ShareService,
    lookup_share,
    workspace_from_share_row,
)
from podcast_mcp.services.collaboration.tunnel import TunnelClient, run_tunnel_sync
from podcast_mcp.services.support.doctor import _load_project

LOOPBACK = ("127.0.0.1", 50000)
CODE = "x-sharecut-error-code"
runner = CliRunner()


def _files(folder: Path) -> list[str]:
    return sorted(child.name for child in folder.iterdir() if child.is_file())


@pytest.fixture
def legacy(minimal_project: Path) -> Path:
    """The retired entry file of a project that has not been opened since the rename."""
    return minimal_project.rename(minimal_project.with_name(RETIRED_PROJECT_FILENAME))


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(), client=LOOPBACK)


def _renames(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith("renamed ")]


def test_cli_info_with_the_retired_file_path_succeeds_and_renames_once(
    legacy: Path, caplog: pytest.LogCaptureFixture
):
    with caplog.at_level(logging.INFO, logger="podcast_mcp.project.io"):
        first = runner.invoke(cli_app, ["info", "--project", str(legacy)])
        again = runner.invoke(cli_app, ["info", "--project", str(legacy)])
    assert (first.exit_code, again.exit_code) == (0, 0), first.output + again.output
    assert '"name": "test_episode"' in first.stdout
    assert _files(legacy.parent) == ["episode.sharecut"]
    assert _renames(caplog) == [
        f"renamed {legacy.resolve()} to {legacy.with_name('episode.sharecut').resolve()}"
    ]


def test_cli_gui_serves_the_resolved_path_for_the_retired_file(legacy: Path):
    entry = legacy.with_name("episode.sharecut").resolve()
    with (
        patch("podcast_mcp.gui.server.create_app") as create,
        patch("podcast_mcp.gui.bind.run_gui_server"),
        patch("podcast_mcp.cli.gui.webbrowser.open"),
    ):
        result = runner.invoke(gui_app, ["--project", str(legacy), "--no-open", "--port", "18999"])
    assert result.exit_code == 0, result.output
    assert create.call_args.kwargs["served_project"] == entry
    assert f"Viewer: http://127.0.0.1:18999/?project={quote(str(entry), safe='')}" in result.stdout
    assert _files(legacy.parent) == ["episode.sharecut"]


def test_cli_gui_refuses_with_the_coded_message_when_the_rename_fails(legacy: Path, monkeypatch):
    def refuse(src, dst):
        raise PermissionError("read-only")

    monkeypatch.setattr("podcast_mcp.project.io.os.rename", refuse)
    result = runner.invoke(gui_app, ["--project", str(legacy), "--no-open"])
    assert result.exit_code == 1
    assert "Rename it to episode.sharecut by hand and open it again." in result.output
    assert _files(legacy.parent) == [RETIRED_PROJECT_FILENAME]


def test_create_app_pins_the_resolved_path_for_the_retired_file(legacy: Path):
    served = create_app(served_project=legacy).state.served_project
    assert served == legacy.with_name("episode.sharecut").resolve()
    assert served.is_file()


def test_ensure_viewer_reports_the_resolved_path_for_the_retired_file(legacy: Path):
    entry = legacy.with_name("episode.sharecut").resolve()
    with (
        patch("podcast_mcp.services.app.gui_launch.is_viewer_up", return_value=True),
        patch("podcast_mcp.services.app.gui_launch.webbrowser.open", return_value=True),
    ):
        result = ensure_viewer(legacy, open_browser=False)
    assert result.ok is True
    assert result.project_path == str(entry)
    assert f"project={quote(str(entry), safe='')}" in result.url
    assert _files(legacy.parent) == ["episode.sharecut"]


@pytest.mark.parametrize("route", ["/api/project/meta", "/api/session/meta"])
def test_meta_polls_do_not_rename_the_retired_file(client: TestClient, legacy: Path, route: str):
    res = client.get(route, params={"path": str(legacy)})
    assert res.status_code == 200, res.text
    assert _files(legacy.parent) == [RETIRED_PROJECT_FILENAME]


def test_studio_discovery_does_not_rename_the_retired_file(legacy: Path):
    ws = legacy.parent
    assert studio_host_path(legacy) == ws.resolve() / "artifacts" / "studio-host.json"
    assert studio_host_path(ws) == studio_host_path(legacy)
    assert read_studio_host(legacy) is None
    assert locate_studio(legacy) is None
    assert _files(ws) == [RETIRED_PROJECT_FILENAME]


def test_handoff_ping_does_not_rename_a_project_it_does_not_serve(
    minimal_project: Path, tmp_path: Path
):
    other = tmp_path / "other"
    other.mkdir()
    other_legacy = other / RETIRED_PROJECT_FILENAME
    other_legacy.write_text("{}", encoding="utf-8")
    app = create_app(served_project=minimal_project)
    res = TestClient(app, client=LOOPBACK).get(
        "/api/handoff/ping",
        params={"project": str(other_legacy)},
        headers={HANDOFF_TOKEN_HEADER: app.state.studio_host.token},
    )
    assert res.status_code == 200, res.text
    assert res.json()["serves"] is False
    assert _files(other) == [RETIRED_PROJECT_FILENAME]


def test_handoff_ping_names_the_served_project_by_its_retired_file(minimal_project: Path):
    app = create_app(served_project=minimal_project)
    retired = minimal_project.with_name(RETIRED_PROJECT_FILENAME)
    retired.write_bytes(minimal_project.read_bytes())
    answers: list[tuple[str, bool]] = []

    def spy(request, project: str) -> bool:
        answers.append((project, real_serves(request, project)))
        return answers[-1][1]

    real_serves = handoff._serves
    with patch("podcast_mcp.gui.routes.handoff._serves", spy):
        res = TestClient(app, client=LOOPBACK).get(
            "/api/handoff/ping",
            params={"project": str(retired)},
            headers={HANDOFF_TOKEN_HEADER: app.state.studio_host.token},
        )
    assert res.json()["serves"] is True
    assert answers == [(str(retired), True)]
    assert _files(minimal_project.parent) == sorted(["episode.sharecut", RETIRED_PROJECT_FILENAME])


def _share_token(minimal_project: Path, sample_wav: Path) -> str:
    artifacts = minimal_project.parent / "artifacts"
    artifacts.mkdir(exist_ok=True)
    (artifacts / "premix.wav").write_bytes(sample_wav.read_bytes())
    ws = ProjectWorkspace.open(minimal_project)
    version = ReviewService(ws).publish(label="v1")
    created = ShareService(ws).create(review_version_id=version["id"], capabilities=["view"])
    return str(created["token"])


def test_share_lookup_adopts_the_retired_file_of_a_project_not_reopened(
    minimal_project: Path, sample_wav: Path
):
    token = _share_token(minimal_project, sample_wav)
    legacy = minimal_project.rename(minimal_project.with_name(RETIRED_PROJECT_FILENAME))
    row = lookup_share(token)
    assert Path(row["project_workspace"]).resolve() == legacy.parent.resolve()
    assert _files(legacy.parent) == ["episode.sharecut"]


def test_share_workspace_opens_a_project_holding_only_the_retired_file(
    minimal_project: Path, sample_wav: Path
):
    _share_token(minimal_project, sample_wav)
    legacy = minimal_project.rename(minimal_project.with_name(RETIRED_PROJECT_FILENAME))
    row = {"project_workspace": str(legacy.parent)}
    ws = workspace_from_share_row(row)
    assert ws.path == minimal_project.resolve()
    assert ws.project.name == "test_episode"
    assert _files(legacy.parent) == ["episode.sharecut"]


def test_share_lookup_reads_as_missing_when_the_rename_fails(
    minimal_project: Path, sample_wav: Path, monkeypatch
):
    token = _share_token(minimal_project, sample_wav)
    legacy = minimal_project.rename(minimal_project.with_name(RETIRED_PROJECT_FILENAME))

    def refuse(src, dst):
        raise PermissionError("read-only")

    monkeypatch.setattr("podcast_mcp.project.io.os.rename", refuse)
    assert lookup_share(token)["project_workspace"] == str(legacy.parent)
    with pytest.raises(FileNotFoundError):
        workspace_from_share_row({"project_workspace": str(legacy.parent)})
    assert _files(legacy.parent) == [RETIRED_PROJECT_FILENAME]


def test_recording_the_adopted_project_drops_its_retired_name_entry(legacy: Path):
    entry = legacy.with_name("episode.sharecut").resolve()
    record_recent(legacy)
    assert [e.path for e in read_recent()] == [str(legacy.resolve())]
    record_recent(entry)
    assert [e.path for e in read_recent()] == [str(entry)]


def test_opening_a_retired_project_leaves_one_recents_card(client: TestClient, legacy: Path):
    record_recent(legacy)
    res = client.post("/api/project/open", json={"path": str(legacy)})
    assert res.status_code == 200, res.text
    cards = client.get("/api/projects/recent").json()
    entry = str(legacy.with_name("episode.sharecut").resolve())
    assert [(c["path"], c["folder_missing"]) for c in cards["projects"]] == [(entry, False)]


@pytest.mark.parametrize("target", ["folder", "file"])
def test_open_route_refuses_with_the_coded_header_when_the_rename_fails(
    client: TestClient, legacy: Path, monkeypatch, target: str
):
    def refuse(src, dst):
        raise PermissionError("read-only")

    monkeypatch.setattr("podcast_mcp.project.io.os.rename", refuse)
    path = legacy.parent if target == "folder" else legacy
    res = client.post("/api/project/open", json={"path": str(path)})
    assert res.status_code == 400
    assert res.headers[CODE] == "project_old_filename"
    assert _files(legacy.parent) == [RETIRED_PROJECT_FILENAME]


def _write_recents(*entries: tuple[Path, str]) -> str:
    body = json.dumps(
        {"version": 1, "projects": [{"path": str(p), "opened_at": at} for p, at in entries]}
    )
    recent_projects_path().parent.mkdir(parents=True, exist_ok=True)
    recent_projects_path().write_text(body, encoding="utf-8")
    return body


def test_recents_present_a_retired_entry_as_the_adopted_file_without_writing(
    client: TestClient, legacy: Path
):
    stored = _write_recents((legacy.resolve(), "2026-05-01T10:00:00+00:00"))
    adopt_retired_entry_file(legacy)
    entry = legacy.with_name("episode.sharecut").resolve()
    assert read_recent() == [RecentEntry(str(entry), "2026-05-01T10:00:00+00:00")]
    cards = client.get("/api/projects/recent").json()["projects"]
    assert [(c["path"], c["folder_missing"]) for c in cards] == [(str(entry), False)]
    assert recent_projects_path().read_text(encoding="utf-8") == stored


def test_recents_merge_a_retired_entry_into_the_adopted_one_keeping_the_newer_time(
    minimal_project: Path, tmp_path: Path
):
    other = ProjectWorkspace.create(tmp_path / "other", name="other").path
    retired = minimal_project.with_name(RETIRED_PROJECT_FILENAME)
    _write_recents(
        (other, "2026-05-03T00:00:00+00:00"),
        (retired.resolve(), "2026-05-02T00:00:00+00:00"),
        (minimal_project.resolve(), "2026-05-01T00:00:00+00:00"),
    )
    assert read_recent() == [
        RecentEntry(str(other.resolve()), "2026-05-03T00:00:00+00:00"),
        RecentEntry(str(minimal_project.resolve()), "2026-05-02T00:00:00+00:00"),
    ]


def test_recents_keep_a_retired_entry_whose_folder_holds_only_the_old_file(
    client: TestClient, legacy: Path
):
    _write_recents((legacy.resolve(), "2026-05-01T10:00:00+00:00"))
    cards = client.get("/api/projects/recent").json()["projects"]
    assert [(c["path"], c["folder_missing"]) for c in cards] == [(str(legacy.resolve()), False)]
    assert _files(legacy.parent) == [RETIRED_PROJECT_FILENAME]


def test_forgetting_a_presented_entry_removes_the_stored_retired_one(
    client: TestClient, legacy: Path
):
    _write_recents((legacy.resolve(), "2026-05-01T10:00:00+00:00"))
    adopt_retired_entry_file(legacy)
    entry = legacy.with_name("episode.sharecut").resolve()
    res = client.delete("/api/projects/recent", params={"path": str(entry)})
    assert res.json() == {"removed": True}
    assert read_recent() == []


def test_tunnel_resolves_the_retired_file_once_at_entry(minimal_project: Path, published_share):
    published_share(label="tunnel")
    legacy = minimal_project.rename(minimal_project.with_name(RETIRED_PROJECT_FILENAME))
    built: list[TunnelClient] = []

    def capture(client: TunnelClient):
        built.append(client)

    with (
        patch("podcast_mcp.services.collaboration.tunnel._run_until_signalled", capture),
        patch("podcast_mcp.services.collaboration.tunnel.asyncio.run", lambda coro: None),
    ):
        run_tunnel_sync(
            legacy, relay_url="wss://relay.test/tunnel", host_token="tok", config_path=None
        )
    entry = minimal_project.resolve()
    assert [c._project_path for c in built] == [entry]
    assert _files(legacy.parent) == ["episode.sharecut"]
    assert len(built[0]._build_shares()) == 1


def test_doctor_bundle_with_the_retired_file_opens_and_renames_it(legacy: Path, tmp_path: Path):
    opened = []

    def build(self, project, *, out_dir):
        opened.append(project.meta.name)
        return SimpleNamespace(path=out_dir / "bundle.zip", support_url="https://support.test")

    with patch("podcast_mcp.services.support.DiagnosticsService.build_bundle", build):
        result = runner.invoke(
            setup_app,
            ["doctor", "--bundle", "--project", str(legacy), "--out", str(tmp_path / "out")],
        )
    assert result.exit_code == 0, result.output
    assert opened == ["test_episode"]
    assert _files(legacy.parent) == ["episode.sharecut"]


def test_doctor_checks_open_a_project_given_by_its_retired_file(legacy: Path):
    assert _load_project(legacy).meta.name == "test_episode"
    assert _files(legacy.parent) == ["episode.sharecut"]


@pytest.mark.parametrize("workspace", ["a\0b", "~nosuchuser/x"])
def test_a_corrupt_share_row_workspace_reads_as_missing(workspace: str):
    with pytest.raises(FileNotFoundError):
        workspace_from_share_row({"project_workspace": workspace})


def test_a_refused_share_adoption_is_logged_once_per_workspace(
    legacy: Path, monkeypatch, caplog: pytest.LogCaptureFixture
):
    def refuse(src, dst):
        raise PermissionError("read-only")

    monkeypatch.setattr("podcast_mcp.project.io.os.rename", refuse)
    row = {"project_workspace": str(legacy.parent)}
    with caplog.at_level(logging.WARNING, logger="podcast_mcp.services.collaboration.share"):
        for _ in range(3):
            with pytest.raises(FileNotFoundError):
                workspace_from_share_row(row)
    assert [r.getMessage() for r in caplog.records] == [
        f"Cannot adopt the entry file in {str(legacy.parent)!r}"
    ]
