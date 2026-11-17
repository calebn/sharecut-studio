from __future__ import annotations

import json
import zipfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.support import diagnostics as diagnostics_mod
from podcast_mcp.services.support.doctor import DoctorReport

STATEMENT = "The episode could not be opened, so this report holds nothing from it."
HEALTHY_KEYS = [
    "app_version",
    "bootstrap",
    "created_at",
    "disk_free_bytes",
    "doctor",
    "env",
    "ffmpeg",
    "gpu",
    "gui_dist_present",
    "hardware",
    "jobs",
    "os",
    "project",
    "python",
    "whisper",
]


@pytest.fixture
def bundle_env(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.services.support.diagnostics.run_doctor_checks",
        lambda _p=None: DoctorReport(),
    )
    monkeypatch.setattr(
        "podcast_mcp.services.support.diagnostics.component_status",
        lambda: {"ready": True, "models": [], "tools": {}},
    )
    monkeypatch.setattr(
        "podcast_mcp.services.support.diagnostics.ffmpeg_probe_info",
        lambda: {"ffmpeg": {"ok": True}, "ffprobe": {"ok": True}},
    )
    out = tmp_path / "out"
    for target in (
        "podcast_mcp.gui.routes.diagnostics.default_bundle_dir",
        "podcast_mcp.services.support.diagnostics.default_bundle_dir",
    ):
        monkeypatch.setattr(target, lambda: out)
    monkeypatch.setattr(diagnostics_mod, "sidecar_log_candidates", lambda: [])
    return out


def _break(project_file: Path, state: str) -> None:
    if state == "truncated":
        project_file.write_bytes(project_file.read_bytes()[:150])
        return
    if state == "renamed":
        project_file.parent.rename(project_file.parent.with_name("moved-away"))
        return
    data = json.loads(project_file.read_text())
    data["version"] = {"newer": "99.0", "unsupported": "two"}[state]
    project_file.write_text(json.dumps(data))


CODES = {
    "newer": "project_version_newer",
    "unsupported": "project_version_unsupported",
    "truncated": "project_unreadable",
    "renamed": "project_not_found",
}


def _members(path: str) -> dict[str, str]:
    with zipfile.ZipFile(path) as zf:
        return {name: zf.read(name).decode() for name in zf.namelist()}


def _client(project_file: Path, jobs=None) -> TestClient:
    app = create_app(served_project=project_file)
    app.state.jobs = jobs
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize("state", list(CODES))
def test_an_episode_that_will_not_open_still_gets_a_bundle(minimal_project, bundle_env, state):
    folder = str(minimal_project.parent)
    _break(minimal_project, state)
    served = minimal_project.parent.with_name("moved-away") if state == "renamed" else None
    with _client(minimal_project) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    assert response.status_code == 200, response.text
    members = _members(response.json()["path"])
    assert response.json()["files"] == ["report.json", "README.txt"]
    assert set(members) == {"report.json", "README.txt"}
    report = json.loads(members["report.json"])
    assert sorted(report) == sorted([*HEALTHY_KEYS, "episode_not_opened"])
    assert report["project"] is None
    assert report["episode_not_opened"] == {"code": CODES[state], "statement": STATEMENT}
    assert STATEMENT in members["README.txt"]
    for text in members.values():
        assert folder not in text
    assert "schema_version" not in members["report.json"]
    assert served is None or served.exists()


@pytest.mark.parametrize("state", list(CODES))
def test_the_folder_is_still_redacted_in_jobs_and_logs_of_an_unopened_bundle(
    minimal_project, bundle_env, monkeypatch, tmp_path, state
):
    folder = str(minimal_project.parent)
    log = tmp_path / "state" / "sidecar.log"
    log.parent.mkdir()
    log.write_text(f"failed to open {folder}/episode.sharecut\n")
    monkeypatch.setattr(diagnostics_mod, "sidecar_log_candidates", lambda: [log])
    jobs = MagicMock()
    jobs.recent_snapshots.return_value = [
        {"kind": "pipeline", "status": "failed", "message": f"no audio under {folder}/raw"}
    ]
    _break(minimal_project, state)
    with _client(minimal_project, jobs) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    assert response.status_code == 200, response.text
    members = _members(response.json()["path"])
    assert "<workspace>/episode.sharecut" in members["sidecar.log"]
    job = json.loads(members["report.json"])["jobs"][0]
    assert job["message"] == "no audio under <workspace>/raw"
    for text in members.values():
        assert folder not in text


def test_a_gone_folder_still_reports_free_space(minimal_project, bundle_env):
    _break(minimal_project, "renamed")
    with _client(minimal_project) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    report = json.loads(_members(response.json()["path"])["report.json"])
    assert isinstance(report["disk_free_bytes"], int)


def test_a_healthy_bundle_has_exactly_its_fifteen_keys_and_no_statement(
    minimal_project, bundle_env
):
    with _client(minimal_project) as client:
        response = client.post("/api/diagnostics/bundle", json={})
    assert response.status_code == 200
    members = _members(response.json()["path"])
    report = json.loads(members["report.json"])
    assert sorted(report) == HEALTHY_KEYS
    assert report["project"]["schema_version"] == "2.2"
    assert STATEMENT not in members["README.txt"]


def test_another_path_and_an_invalid_path_get_no_bundle(minimal_project, bundle_env, tmp_path):
    other = tmp_path / "other" / "episode.sharecut"
    with _client(minimal_project) as client:
        forbidden = client.post("/api/diagnostics/bundle", json={"path": str(other)})
        invalid = client.post("/api/diagnostics/bundle", json={"path": "bad\x00path"})
    assert forbidden.status_code in (403, 404)
    assert invalid.status_code in (400, 422)
    assert not bundle_env.exists() or list(bundle_env.glob("*.zip")) == []


@pytest.mark.parametrize("state", ["newer", "truncated", "renamed"])
def test_who_may_export_is_unchanged_for_an_unopenable_episode(
    minimal_project, bundle_env, monkeypatch, state
):
    _break(minimal_project, state)
    with _client(minimal_project) as client:
        evil = client.post(
            "/api/diagnostics/bundle",
            json={},
            headers={"Host": "127.0.0.1:8765", "Origin": "https://evil.example"},
        )
    assert evil.status_code == 403
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setattr("podcast_mcp.gui.routes.deps.peer_host", lambda _request: "10.0.0.5")
    with _client(minimal_project) as client:
        remote = client.post("/api/diagnostics/bundle", json={})
    assert remote.status_code == 403
    assert not bundle_env.exists() or list(bundle_env.glob("*.zip")) == []
