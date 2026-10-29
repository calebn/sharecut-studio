"""Home's recent episodes: the MRU file, the card summary and the routes (#2295)."""

from __future__ import annotations

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from functools import partial
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.app import recent_projects as recent
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.util.atomic_file import atomic_write

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


def test_default_workspace_reserves_and_numbers_a_taken_folder(tmp_path):
    root = tmp_path / "workspaces"
    first = recent.default_workspace_dir("Pilot")
    assert first == (root / "Pilot").resolve()
    assert first.is_dir()
    assert recent.default_workspace_dir("Pilot") == (root / "Pilot 2").resolve()
    (root / "Pilot 3").mkdir()
    assert recent.default_workspace_dir("Pilot") == (root / "Pilot 4").resolve()
    assert recent.default_workspace_dir("a/b:c") == (root / "abc").resolve()
    assert recent.default_workspace_dir("  ") == (root / "episode").resolve()


@pytest.mark.parametrize("name", ["con", "CON", "NUL.wav", "com1", "Lpt9.txt", " aux. "])
def test_a_reserved_windows_name_is_refused_and_creates_no_folder(local, tmp_path, name):
    res = local.post("/api/project/create", json={"name": name})
    assert res.status_code == 400
    assert res.headers[CODE] == "project_name_reserved"
    assert "Choose another episode name." in res.json()["detail"]
    assert not (tmp_path / "workspaces").exists() or not any((tmp_path / "workspaces").iterdir())


def test_a_reserved_name_with_a_lone_surrogate_is_a_400_not_a_500(local):
    res = local.post(
        "/api/project/create",
        content=b'{"name": "CON.\\ud800"}',
        headers={"content-type": "application/json"},
    )
    assert res.status_code == 400
    assert res.headers[CODE] == "project_name_reserved"


@pytest.mark.parametrize("name", ["console", "com10", "con 2", "Episode, 12 Mar", "nullable.wav"])
def test_names_that_only_start_like_a_reserved_one_are_kept(tmp_path, name):
    assert recent.default_workspace_dir(name).name == name


def test_concurrent_reservations_never_share_a_folder(tmp_path):
    with ThreadPoolExecutor(max_workers=8) as pool:
        got = list(pool.map(lambda _: recent.default_workspace_dir("Pilot"), range(24)))
    assert len(set(got)) == 24
    assert all(p.is_dir() for p in got)


def test_concurrent_creates_make_distinct_episodes(local, tmp_path):
    def create(_):
        res = TestClient(create_app(), client=LOOPBACK).post(
            "/api/project/create", json={"name": "Pilot"}
        )
        return res.status_code, res.json()["project_path"]

    with ThreadPoolExecutor(max_workers=4) as pool:
        got = list(pool.map(create, range(6)))
    assert {code for code, _ in got} == {200}
    assert len({path for _, path in got}) == 6


def test_blank_folder_create_refuses_an_existing_project_file(local, tmp_path, monkeypatch):
    existing = _make(tmp_path, "taken")
    before = existing.read_bytes()
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.default_workspace_dir", lambda name: existing.parent
    )
    res = local.post("/api/project/create", json={"name": "Pilot"})
    assert res.status_code == 400
    assert res.headers[CODE] == "project_create_failed"
    assert existing.read_bytes() == before


def test_failed_blank_folder_create_releases_the_reserved_folder(local, tmp_path, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("no")

    monkeypatch.setattr("podcast_mcp.gui.routes.project.ProjectWorkspace.create", boom)
    assert local.post("/api/project/create", json={"name": "Pilot"}).status_code == 400
    assert not (tmp_path / "workspaces" / "Pilot").exists()


def test_late_failure_releases_the_reserved_folder_with_its_contents(local, tmp_path, monkeypatch):
    def disk_full(self, *args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("podcast_mcp.services.app.workspace.HistoryManager.record", disk_full)
    res = local.post("/api/project/create", json={"name": "Pilot"})
    assert res.status_code == 400
    assert res.headers[CODE] == "project_create_failed"
    assert not (tmp_path / "workspaces" / "Pilot").exists()
    assert recent.read_recent() == []


def test_failed_create_keeps_a_folder_the_person_chose(local, tmp_path, monkeypatch):
    chosen = tmp_path / "mine"
    chosen.mkdir()
    (chosen / "notes.txt").write_text("keep", encoding="utf-8")

    def disk_full(self, *args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("podcast_mcp.services.app.workspace.HistoryManager.record", disk_full)
    res = local.post("/api/project/create", json={"workspace_dir": str(chosen)})
    assert res.status_code == 400
    assert (chosen / "notes.txt").read_text(encoding="utf-8") == "keep"


def test_blank_folder_create_with_a_file_as_workspace_root_is_a_coded_400(
    local, tmp_path, monkeypatch
):
    root = tmp_path / "root-is-a-file"
    root.write_text("x", encoding="utf-8")
    monkeypatch.setenv("PODCAST_WORKSPACE_ROOT", str(root))
    res = local.post("/api/project/create", json={"name": "Pilot"})
    assert res.status_code == 400
    assert res.headers[CODE] == "project_create_failed"


def test_blank_folder_create_with_an_overlong_name_is_a_coded_400(local):
    res = local.post("/api/project/create", json={"name": "n" * 400})
    assert res.status_code == 400
    assert res.headers[CODE] == "project_create_failed"


def test_delete_with_a_nul_byte_removes_nothing_and_does_not_fail(local):
    res = local.delete("/api/projects/recent", params={"path": "a\x00b"})
    assert res.status_code == 200
    assert res.json() == {"removed": False}


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


def _card_for(path: Path, jobs=None) -> dict:
    recent.record_recent(path)
    return recent.recent_project_cards(jobs)[0]


@pytest.mark.parametrize(
    "edit",
    [
        lambda d: d["render"].update(pipeline_runs={"a": 1}),
        lambda d: d["render"].update(pipeline_runs=[{"steps": {"a": 1}}]),
        lambda d: d["render"].update(pipeline_runs=[7]),
        lambda d: d["render"].update(artifacts=[1]),
        lambda d: d["timeline"].update(tracks={"a": 1}),
        lambda d: d["editorial"].update(edit_decisions="x"),
        lambda d: d.update(meta=[1]),
    ],
)
def test_hostile_project_fields_do_not_fail_the_card(tmp_path, edit):
    project = _make(tmp_path, "hostile")
    _edit_project(project, edit)
    card = _card_for(project)
    assert card["path"] == str(project.resolve())
    assert card["chip"]["text"] in ("Not started", "Needs attention", "Edited")


@pytest.mark.parametrize("raw", ["[]", "7", "null", '"x"', "{", ""])
def test_non_object_project_file_is_a_needs_attention_card(tmp_path, raw):
    project = _make(tmp_path, "weird")
    project.write_text(raw, encoding="utf-8")
    assert _card_for(project)["chip"] == {"text": "Needs attention", "state": "failed"}


def test_one_bad_card_does_not_fail_the_list(tmp_path, monkeypatch):
    good = _make(tmp_path, "good")
    bad = _make(tmp_path, "bad")
    recent.record_recent(good)
    recent.record_recent(bad)
    real = recent._summarize

    def flaky(path):
        if path.parent.name == "bad":
            raise KeyError(-1)
        return real(path)

    monkeypatch.setattr(recent, "_summarize", flaky)
    cards = {c["name"]: c for c in recent.recent_project_cards()}
    assert cards["bad"]["chip"]["text"] == "Needs attention"
    assert cards["good"]["chip"]["text"] == "Not started"


def test_card_builder_fault_is_caught_per_card(tmp_path, monkeypatch):
    project = _make(tmp_path, "fault")
    monkeypatch.setattr(recent, "_stage_chip", lambda **kw: 1 / 0)
    assert _card_for(project)["chip"]["text"] == "Needs attention"


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity", "1e999", "1" + "0" * 400])
def test_non_finite_duration_is_dropped_and_the_response_renders(local, tmp_path, token):
    project = _make(tmp_path, "dur")
    text = project.read_text(encoding="utf-8")
    data = json.loads(text)
    data["timeline"]["duration_sec"] = 1
    project.write_text(json.dumps(data).replace('"duration_sec": 1,', f'"duration_sec": {token},'))
    assert f'"duration_sec": {token}' in project.read_text(encoding="utf-8")
    recent.record_recent(project)
    res = local.get("/api/projects/recent")
    assert res.status_code == 200
    assert res.json()["projects"][0]["duration_sec"] is None


def _seed_unencodable(*good: Path) -> Path:
    """Save *good* (first = newest), then put an unreachable entry on top."""
    for path in reversed(good):
        recent.record_recent(path)
    saved = recent.recent_projects_path()
    data = json.loads(saved.read_text(encoding="utf-8"))
    data["projects"].insert(0, {"path": "/x/\ud800/episode.project.json", "opened_at": "t\ud800"})
    saved.write_text(json.dumps(data), encoding="utf-8")
    return saved


def _saved_paths(saved: Path) -> list[str]:
    return [p["path"] for p in json.loads(saved.read_text(encoding="utf-8"))["projects"]]


def test_an_unreachable_entry_is_left_out_of_the_list(local, tmp_path):
    good = _make(tmp_path, "good")
    _seed_unencodable(good)
    res = local.get("/api/projects/recent")
    assert res.status_code == 200
    cards = res.json()["projects"]
    assert [c["name"] for c in cards] == ["good"]
    assert not any("\ufffd" in c["name"] or "\ufffd" in c["path"] for c in cards)


def test_an_unreachable_entry_on_top_does_not_evict_a_valid_one(local, tmp_path):
    goods = [_make(tmp_path, f"g{n}") for n in range(recent.RECENT_LIMIT)]
    _seed_unencodable(*goods)
    res = local.get("/api/projects/recent")
    assert res.status_code == 200
    assert [c["name"] for c in res.json()["projects"]] == [f"g{n}" for n in range(20)]


def test_a_save_that_rewrites_the_list_drops_the_unreachable_entry_from_the_file(local, tmp_path):
    a, b, c = (_make(tmp_path, n) for n in "abc")
    saved = _seed_unencodable(a, b)
    before = saved.read_bytes()
    assert [e.path for e in recent.read_recent()] == [str(a.resolve()), str(b.resolve())]
    assert saved.read_bytes() == before
    assert not recent.forget_recent(c)
    assert saved.read_bytes() == before
    assert any("\ud800" in p for p in _saved_paths(saved))
    assert recent.forget_recent(b)
    assert _saved_paths(saved) == [str(a.resolve())]
    saved = _seed_unencodable(a)
    recent.record_recent(c)
    assert _saved_paths(saved) == [str(c.resolve()), str(a.resolve())]


def test_record_recent_does_not_raise_on_a_lone_surrogate_path(tmp_path):
    good = _make(tmp_path, "good")
    recent.record_recent(good)
    recent.record_recent("/x/\ud800/episode.project.json")
    assert [e.path for e in recent.read_recent()] == [str(good.resolve())]


def test_a_real_replacement_character_folder_is_kept(tmp_path):
    odd = _make(tmp_path, "a\ufffdb")
    recent.record_recent(odd)
    assert [e.path for e in recent.read_recent()] == [str(odd.resolve())]


def test_a_lone_surrogate_project_name_is_cleaned_on_its_card(local, tmp_path):
    project = _make(tmp_path, "named")
    _edit_project(project, lambda d: d["meta"].update(name="ep\ud800"))
    recent.record_recent(project)
    res = local.get("/api/projects/recent")
    assert res.status_code == 200
    assert res.json()["projects"][0]["name"] == "ep\ufffd"


def test_unchanged_project_file_is_parsed_once(tmp_path, monkeypatch):
    project = _make(tmp_path, "cached")
    recent.record_recent(project)
    calls = []
    real = recent._summarize
    monkeypatch.setattr(recent, "_summarize", lambda p: calls.append(p) or real(p))
    recent.recent_project_cards()
    recent.recent_project_cards()
    assert len(calls) == 1
    _edit_project(project, _with_track)
    assert recent.recent_project_cards()[0]["duration_sec"] == 3125.5
    assert len(calls) == 2


def _write_bytes(data: bytes, handle) -> None:
    handle.write(data)


def test_same_size_rewrite_with_restored_mtime_is_parsed_again(tmp_path, monkeypatch):
    project = _make(tmp_path, "aaaa")
    _edit_project(project, _with_track)
    recent.record_recent(project)
    calls = []
    real = recent._summarize
    monkeypatch.setattr(recent, "_summarize", lambda p: calls.append(p) or real(p))
    before = project.stat()
    assert recent.recent_project_cards()[0]["name"] == "aaaa"
    # Atomic writes cycle through a few inodes, so a few rewrites between reads bring back the
    # cached (dev, ino, size, mtime) revision; only the ctime tells them apart.
    atomic_write(project, lambda handle: handle.write(project.read_bytes()))
    os.utime(project, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert recent.recent_project_cards()[0]["name"] == "aaaa"
    before, current = project.stat(), "aaaa"
    for name in ("bbbb", "cccc", "dddd", "eeee", "ffff", "gggg"):
        swapped = project.read_text(encoding="utf-8").replace(current, name).encode()
        atomic_write(project, partial(_write_bytes, swapped))
        os.utime(project, ns=(before.st_atime_ns, before.st_mtime_ns))
        current = name
        if project.stat().st_ino == before.st_ino:
            break
    else:
        pytest.skip("this filesystem hands out a fresh inode for every rewrite")
    assert project.stat().st_size == before.st_size
    assert recent.recent_project_cards()[0]["name"] == current
    assert len(calls) == 3


def test_running_state_is_not_cached_with_the_summary(tmp_path):
    project = _make(tmp_path, "live")
    _edit_project(project, _with_track)
    assert _chip(project, _Jobs({"running": False}))[1]["text"] == "Edited"
    running = _Jobs({"running": True, "job": {"current": 1, "total": 4}})
    assert _chip(project, running)[1]["text"] == "Processing 25%"
    assert _chip(project, _Jobs({"running": False}))[1]["text"] == "Edited"


def test_twenty_large_projects_cost_one_parse_each(tmp_path, monkeypatch):
    paths = []
    for i in range(20):
        project = _make(tmp_path, f"big{i}")
        _edit_project(project, lambda d: d.update(blob="x" * 2_000_000))
        recent.record_recent(project)
        paths.append(project)
    calls = []
    real = recent._summarize
    monkeypatch.setattr(recent, "_summarize", lambda p: calls.append(p) or real(p))
    recent.recent_project_cards()
    first = len(calls)
    start = time.perf_counter()
    recent.recent_project_cards()
    assert len(calls) == first == 20
    assert time.perf_counter() - start < 1.0


def test_cache_forgets_projects_that_left_the_list(tmp_path):
    project = _make(tmp_path, "gone")
    recent.record_recent(project)
    recent.recent_project_cards()
    assert str(project.resolve()) in recent._SUMMARIES
    recent.forget_recent(project)
    recent.recent_project_cards()
    assert str(project.resolve()) not in recent._SUMMARIES


def test_mastered_path_outside_the_folder_is_not_followed(tmp_path):
    project = _make(tmp_path, "escape")
    outside = tmp_path / "outside.wav"
    outside.write_bytes(b"x")
    os.utime(outside, (1_000_000_000, 1_000_000_000))
    os.utime(project, (1_700_000_000, 1_700_000_000))
    stamp = recent._delivered_on("../outside.wav", project)
    assert stamp is not None
    assert stamp.timestamp() == 1_700_000_000


def test_a_missing_master_does_not_read_delivered(tmp_path):
    project = _make(tmp_path, "gone-master")
    _edit_project(project, _with_track)

    def point(data):
        data["render"]["artifacts"]["mastered"] = "artifacts/gone.wav"

    _edit_project(project, point)
    assert _chip(project) == ("edit", {"text": "Edited", "state": "done"})


def test_a_transient_read_failure_is_not_cached(tmp_path, monkeypatch):
    project = _make(tmp_path, "flaky")
    _edit_project(project, _with_track)
    recent.record_recent(project)
    real = Path.read_text
    failing = {"on": True}

    def flaky(self, *args, **kwargs):
        if failing["on"] and self.name == "episode.project.json":
            raise PermissionError("busy")
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", flaky)
    assert recent.recent_project_cards()[0]["chip"]["text"] == "Needs attention"
    failing["on"] = False
    assert recent.recent_project_cards()[0]["chip"]["text"] == "Edited"
