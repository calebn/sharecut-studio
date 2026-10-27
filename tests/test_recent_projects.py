"""Home's recent episodes: the MRU file, the card summary and the routes (#2295)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.app import recent_projects as recent
from podcast_mcp.services.app.workspace import ProjectWorkspace

CODE = "X-Sharecut-Error-Code"
LOOPBACK = ("127.0.0.1", 50000)


@pytest.fixture
def local() -> TestClient:
    return TestClient(create_app(), client=LOOPBACK)


@pytest.fixture
def remote() -> TestClient:
    return TestClient(create_app(), client=("203.0.113.9", 50000))


def _make(tmp_path: Path, name: str) -> Path:
    return ProjectWorkspace.create(tmp_path / name, name=name).path


def _edit_project(path: Path, edit) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    edit(data)
    path.write_text(json.dumps(data), encoding="utf-8")


def test_list_lives_under_the_config_dir_override(tmp_path):
    assert recent.recent_projects_path() == tmp_path / "config" / "recent_projects.json"


def test_record_puts_newest_first_and_dedupes(tmp_path):
    a, b = _make(tmp_path, "a"), _make(tmp_path, "b")
    recent.record_recent(a)
    recent.record_recent(b)
    recent.record_recent(a, now=datetime(2026, 10, 27, 9, 0, tzinfo=UTC))
    entries = recent.read_recent()
    assert [e.path for e in entries] == [str(a.resolve()), str(b.resolve())]
    assert entries[0].opened_at == "2026-10-27T09:00:00+00:00"


def test_record_caps_the_list_at_twenty(tmp_path):
    for i in range(recent.RECENT_LIMIT + 3):
        recent.record_recent(tmp_path / f"p{i}" / "episode.project.json")
    entries = recent.read_recent()
    assert len(entries) == recent.RECENT_LIMIT
    assert entries[0].path.endswith("p22/episode.project.json")
    assert not any(e.path.endswith("p0/episode.project.json") for e in entries)


@pytest.mark.parametrize(
    "content",
    ["not json", "[]", '{"projects": "x"}', '{"projects": [1, {"path": 3}, {"opened_at": "x"}]}'],
)
def test_corrupt_file_reads_as_empty_and_heals_on_next_record(tmp_path, content):
    target = recent.recent_projects_path()
    target.parent.mkdir(parents=True)
    target.write_text(content, encoding="utf-8")
    assert recent.read_recent() == []
    project = _make(tmp_path, "fresh")
    recent.record_recent(project)
    assert [e.path for e in recent.read_recent()] == [str(project.resolve())]


def test_hand_edited_duplicates_and_overflow_are_trimmed(tmp_path):
    target = recent.recent_projects_path()
    target.parent.mkdir(parents=True)
    rows = [{"path": f"/x/{i % 30}", "opened_at": "t"} for i in range(60)]
    target.write_text(json.dumps({"projects": rows}), encoding="utf-8")
    entries = recent.read_recent()
    assert len(entries) == recent.RECENT_LIMIT
    assert len({e.path for e in entries}) == recent.RECENT_LIMIT


def test_unwritable_config_dir_never_fails_the_caller(tmp_path, monkeypatch):
    blocker = tmp_path / "blocked"
    blocker.write_text("a file, not a directory")
    monkeypatch.setenv("PODCAST_CONFIG_DIR", str(blocker / "sub"))
    recent.record_recent(tmp_path / "x" / "episode.project.json")
    assert recent.forget_recent(tmp_path / "x" / "episode.project.json") is False
    assert recent.read_recent() == []


def test_forget_removes_only_the_named_entry(tmp_path):
    a, b = _make(tmp_path, "a"), _make(tmp_path, "b")
    recent.record_recent(a)
    recent.record_recent(b)
    assert recent.forget_recent(a) is True
    assert recent.forget_recent(a) is False
    assert [e.path for e in recent.read_recent()] == [str(b.resolve())]


def test_default_workspace_numbers_a_taken_folder(tmp_path):
    root = tmp_path / "workspaces"
    assert recent.default_workspace_dir("Pilot") == root / "Pilot"
    (root / "Pilot").mkdir(parents=True)
    (root / "Pilot 2").mkdir()
    assert recent.default_workspace_dir("Pilot") == root / "Pilot 3"
    assert recent.default_workspace_dir("a/b:c") == root / "abc"
    assert recent.default_workspace_dir("  ") == root / "episode"


def test_get_lists_cards_for_opened_and_created_projects(local, tmp_path):
    made = local.post("/api/project/create", json={"workspace_dir": str(tmp_path / "one")})
    assert made.status_code == 200
    other = _make(tmp_path, "two")
    assert local.post("/api/project/open", json={"path": str(other)}).status_code == 200
    local.post("/api/project/open", json={"path": made.json()["project_path"]})

    res = local.get("/api/projects/recent")
    assert res.status_code == 200
    assert res.headers["Cache-Control"] == "no-store"
    cards = res.json()["projects"]
    assert [c["path"] for c in cards] == [
        str(Path(made.json()["project_path"]).resolve()),
        str(other.resolve()),
    ]
    first = cards[0]
    assert first["name"] == "episode"
    assert first["stage"] == "prepare"
    assert first["chip"] == {"text": "Not started", "state": "not-yet"}
    assert first["folder_missing"] is False
    assert first["peaks"] == []
    assert first["edited_at"]


def test_create_without_a_folder_uses_the_default_workspace(local, tmp_path):
    first = local.post("/api/project/create", json={"name": "Pilot"}).json()
    second = local.post("/api/project/create", json={"name": "Pilot"}).json()
    root = tmp_path / "workspaces"
    assert Path(first["project_path"]) == (root / "Pilot" / "episode.project.json").resolve()
    assert Path(second["project_path"]) == (root / "Pilot 2" / "episode.project.json").resolve()


def test_switching_by_pin_records_the_project(local, tmp_path):
    project = _make(tmp_path, "pinned")
    assert local.get("/api/project", params={"path": str(project)}).status_code == 200
    assert [e.path for e in recent.read_recent()] == [str(project.resolve())]


def test_missing_folder_is_flagged_not_dropped(local, tmp_path):
    project = _make(tmp_path, "gone")
    recent.record_recent(project)
    project.unlink()
    card = local.get("/api/projects/recent").json()["projects"][0]
    assert card["folder_missing"] is True
    assert card["name"] == "gone"
    assert card["edited_at"] is None


def test_unreadable_project_file_is_a_failed_card(local, tmp_path):
    project = _make(tmp_path, "broken")
    recent.record_recent(project)
    project.write_text("{nope", encoding="utf-8")
    card = local.get("/api/projects/recent").json()["projects"][0]
    assert card["folder_missing"] is False
    assert card["chip"]["state"] == "failed"


def test_corrupt_list_file_answers_an_empty_list(local):
    target = recent.recent_projects_path()
    target.parent.mkdir(parents=True)
    target.write_text("\x00\x01 not json", encoding="utf-8")
    assert local.get("/api/projects/recent").json() == {"projects": []}


def test_non_loopback_peer_gets_403(remote):
    res = remote.get("/api/projects/recent")
    assert res.status_code == 403
    assert res.headers[CODE] == "project_recent_not_allowed"
    res = remote.delete("/api/projects/recent", params={"path": "/x"})
    assert res.status_code == 403
    assert res.headers[CODE] == "project_recent_not_allowed"


def test_relayed_request_is_refused(tmp_path):
    client = TestClient(create_app(), client=LOOPBACK)
    res = client.get("/api/projects/recent", headers={"X-Sharecut-Relayed": "1"})
    assert res.status_code == 403


def test_host_binding_covers_the_list_route():
    from podcast_mcp.gui.middleware_host_binding import path_requires_host_binding

    assert path_requires_host_binding("/api/projects/recent")


def test_delete_forgets_the_entry(local, tmp_path):
    project = _make(tmp_path, "forget")
    recent.record_recent(project)
    res = local.delete("/api/projects/recent", params={"path": str(project)})
    assert res.json() == {"removed": True}
    assert local.get("/api/projects/recent").json() == {"projects": []}
    res = local.delete("/api/projects/recent", params={"path": str(project)})
    assert res.json() == {"removed": False}


class _Jobs:
    def __init__(self, status):
        self._status = status

    def status(self, project_path):
        return self._status


def _chip(path: Path, jobs=None) -> tuple[str, dict]:
    recent.record_recent(path)
    card = recent.recent_project_cards(jobs)[0]
    return card["stage"], card["chip"]


def _with_track(data: dict) -> None:
    data["timeline"]["tracks"] = [{"id": "t", "media": {"path": "raw/t.wav"}}]
    data["timeline"]["duration_sec"] = 3125.5


def test_chip_follows_the_landing_rule(tmp_path):
    project = _make(tmp_path, "rule")
    _edit_project(project, _with_track)
    assert _chip(project) == ("edit", {"text": "Edited", "state": "done"})
    card = recent.recent_project_cards()[0]
    assert card["duration_sec"] == 3125.5
    assert card["name"] == "rule"

    def pending(data):
        data["editorial"]["edit_decisions"] = [
            {"type": "remove", "applied": False, "review_required": True},
            {"type": "mute", "applied": False, "review_required": True},
            {"type": "remove", "applied": True, "review_required": True},
            {"type": "remove", "applied": False, "review_required": False},
        ]

    _edit_project(project, pending)
    assert _chip(project) == ("review", {"text": "Review 2", "state": "needs-you"})

    (project.parent / "artifacts").mkdir(exist_ok=True)
    (project.parent / "artifacts" / "mastered.wav").write_bytes(b"x")

    def delivered(data):
        data["editorial"]["edit_decisions"] = []
        data["render"]["artifacts"]["mastered"] = "artifacts/mastered.wav"

    _edit_project(project, delivered)
    stage, chip = _chip(project)
    assert stage == "deliver"
    assert chip["state"] == "done"
    assert chip["text"].startswith("Delivered ")


def test_running_job_and_failed_run_land_on_prepare(tmp_path):
    project = _make(tmp_path, "busy")
    _edit_project(project, _with_track)
    running = _Jobs({"running": True, "job": {"current": 2, "total": 5}})
    assert _chip(project, running) == (
        "prepare",
        {"text": "Processing 40%", "state": "running"},
    )
    no_total = _Jobs({"running": True, "job": {}})
    assert _chip(project, no_total)[1]["text"] == "Processing"

    def failed(data):
        data["render"]["pipeline_runs"] = [{"id": "r", "steps": [{"step": "x", "status": "error"}]}]

    _edit_project(project, failed)
    assert _chip(project, _Jobs({"running": False})) == (
        "prepare",
        {"text": "Needs attention", "state": "failed"},
    )


def test_job_table_fault_does_not_hide_the_list(tmp_path):
    class Boom:
        def status(self, project_path):
            raise RuntimeError("nope")

    project = _make(tmp_path, "boom")
    _edit_project(project, _with_track)
    assert _chip(project, Boom()) == ("edit", {"text": "Edited", "state": "done"})
