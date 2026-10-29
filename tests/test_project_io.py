from __future__ import annotations

import json

import pytest

from podcast_mcp.project.io import (
    RETIRED_PROJECT_FILENAME,
    copy_relocated_workspace,
    open_project,
    require_episode_project_file,
    resolve_project_path,
    rewrite_workspace_dir,
)
from podcast_mcp.project.store import ProjectStore
from podcast_mcp.services.app.workspace import ProjectWorkspace


def test_resolve_project_path_dir(tmp_path):
    ws = tmp_path / "ep"
    ws.mkdir()
    (ws / "episode.sharecut").write_text(
        json.dumps(
            {
                "version": "2.0",
                "meta": {
                    "name": "t",
                    "workspace_dir": str(ws),
                    "created_at": "2026-01-01T00:00:00+00:00",
                },
            }
        ),
        encoding="utf-8",
    )
    assert resolve_project_path(ws).name == "episode.sharecut"


def test_resolve_project_path_renames_a_folder_holding_only_the_retired_file(tmp_path):
    (tmp_path / RETIRED_PROJECT_FILENAME).write_bytes(b'{"version": "2.0"}\n')
    resolved = resolve_project_path(tmp_path)
    assert resolved == (tmp_path / "episode.sharecut").resolve()
    assert resolved.read_bytes() == b'{"version": "2.0"}\n'
    assert sorted(child.name for child in tmp_path.iterdir()) == ["episode.sharecut"]


def test_resolve_project_path_renames_the_retired_file_given_directly(tmp_path):
    retired = tmp_path / RETIRED_PROJECT_FILENAME
    retired.write_bytes(b"{}")
    resolved = resolve_project_path(retired)
    assert resolved == (tmp_path / "episode.sharecut").resolve()
    assert resolved.read_bytes() == b"{}"
    assert not retired.exists()


def test_resolve_project_path_rename_is_a_no_op_the_second_time(tmp_path):
    (tmp_path / RETIRED_PROJECT_FILENAME).write_bytes(b"{}")
    first = resolve_project_path(tmp_path)
    second = resolve_project_path(tmp_path)
    assert first == second == (tmp_path / "episode.sharecut").resolve()
    assert sorted(child.name for child in tmp_path.iterdir()) == ["episode.sharecut"]


def test_resolve_project_path_leaves_the_retired_file_when_the_current_one_exists(tmp_path):
    (tmp_path / RETIRED_PROJECT_FILENAME).write_bytes(b"old")
    (tmp_path / "episode.sharecut").write_bytes(b"new")
    retired = tmp_path / RETIRED_PROJECT_FILENAME
    assert resolve_project_path(retired) == (tmp_path / "episode.sharecut").resolve()
    assert (tmp_path / RETIRED_PROJECT_FILENAME).read_bytes() == b"old"
    assert (tmp_path / "episode.sharecut").read_bytes() == b"new"


def test_resolve_project_path_does_not_rename_a_missing_retired_file(tmp_path):
    missing = tmp_path / RETIRED_PROJECT_FILENAME
    assert resolve_project_path(missing) == missing.resolve()
    assert list(tmp_path.iterdir()) == []


def test_resolve_project_path_asks_for_a_hand_rename_when_the_rename_fails(tmp_path, monkeypatch):
    (tmp_path / RETIRED_PROJECT_FILENAME).write_bytes(b"{}")

    def refuse(src, dst):
        raise PermissionError("read-only")

    monkeypatch.setattr("podcast_mcp.project.io.os.rename", refuse)
    with pytest.raises(ValueError) as raised:
        resolve_project_path(tmp_path)
    assert raised.value.code == "project_old_filename"
    assert str(raised.value) == (
        "episode.project.json could not be renamed automatically. "
        "Rename it to episode.sharecut by hand and open it again."
    )
    assert [child.name for child in tmp_path.iterdir()] == [RETIRED_PROJECT_FILENAME]


def test_resolve_project_path_treats_losing_the_rename_race_as_success(tmp_path, monkeypatch):
    (tmp_path / RETIRED_PROJECT_FILENAME).write_bytes(b"{}")

    def another_process_wins(src, dst):
        (tmp_path / "episode.sharecut").write_bytes(b"{}")
        (tmp_path / RETIRED_PROJECT_FILENAME).unlink()
        raise FileNotFoundError(src)

    monkeypatch.setattr("podcast_mcp.project.io.os.rename", another_process_wins)
    assert resolve_project_path(tmp_path) == (tmp_path / "episode.sharecut").resolve()


def test_resolve_project_path_prefers_the_current_file_over_a_retired_sibling(tmp_path):
    (tmp_path / RETIRED_PROJECT_FILENAME).write_text("{}", encoding="utf-8")
    (tmp_path / "episode.sharecut").write_text("{}", encoding="utf-8")
    assert resolve_project_path(tmp_path) == (tmp_path / "episode.sharecut").resolve()


def test_resolve_project_path_leaves_an_empty_folder_to_the_caller(tmp_path):
    assert resolve_project_path(tmp_path) == (tmp_path / "episode.sharecut").resolve()


def test_workspace_create_works_beside_a_retired_file(tmp_path):
    (tmp_path / RETIRED_PROJECT_FILENAME).write_text("{}", encoding="utf-8")
    ws = ProjectWorkspace.create(tmp_path, name="fresh")
    assert ws.path == (tmp_path / "episode.sharecut").resolve()
    assert ws.project.name == "fresh"


def test_open_and_persist_roundtrip(minimal_project):
    path, proj = open_project(minimal_project)
    proj.name = "renamed"
    ProjectStore(path).commit(proj)
    _, loaded = open_project(path)
    assert loaded.name == "renamed"


def test_workspace_reload_skips_unchanged_file_and_reads_external_write(
    minimal_project, monkeypatch
):
    ws = ProjectWorkspace.open(minimal_project)
    original_load = ws._store.load
    loads = 0

    def counted_load():
        nonlocal loads
        loads += 1
        return original_load()

    monkeypatch.setattr(ws._store, "load", counted_load)
    original = ws.project
    assert ws.reload() is original
    assert loads == 0

    external = ProjectStore(minimal_project).load()
    external.name = "external update"
    ProjectStore(minimal_project).commit(external)
    assert ws.reload().name == "external update"
    assert loads == 1
    assert ws.reload() is ws.project
    assert loads == 1

    ws.project.name = "workspace update"
    ws.save()
    # save() records the exact committed revision (writers are locked out), so no re-read.
    assert ws.reload().name == "workspace update"
    assert loads == 1

    ws.mutate("before rename", "after rename", lambda project: setattr(project, "name", "mutated"))
    assert ws.reload().name == "mutated"
    assert loads == 1

    external = ProjectStore(minimal_project).load()
    external.name = "later external"
    ProjectStore(minimal_project).commit(external)
    assert ws.reload().name == "later external"
    assert loads == 2


def test_workspace_mutation_records_its_own_revision_and_sees_later_writers(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.mutate("before rename", "after rename", lambda project: setattr(project, "name", "first"))
    assert ws.reload().name == "first"

    external = ProjectStore(minimal_project).load()
    external.name = "later writer"
    ProjectStore(minimal_project).commit(external)
    assert ws.reload().name == "later writer"


def test_a_failed_save_doesnt_leave_its_change_for_the_next_reload(minimal_project, monkeypatch):
    import podcast_mcp.services.app.workspace as workspace_module

    ws = ProjectWorkspace.open(minimal_project)
    saved_name = ws.project.name

    def change_then_fail(path, project, *args, **kwargs):
        project.name = "never saved"
        raise OSError("disk full")

    monkeypatch.setattr(workspace_module, "run_mutation", change_then_fail)
    with pytest.raises(OSError, match="disk full"):
        ws.mutate("before", "after", lambda project: None)
    assert ws.project.name == "never saved"
    assert ws.reload().name == saved_name


def test_require_episode_project_file_basename(tmp_path):
    junk = tmp_path / "other.json"
    junk.write_text("{}", encoding="utf-8")
    try:
        require_episode_project_file(junk)
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "episode.sharecut" in str(exc)


def test_require_episode_project_file_renames_the_retired_name(tmp_path):
    retired = tmp_path / RETIRED_PROJECT_FILENAME
    retired.write_text("{}", encoding="utf-8")
    assert require_episode_project_file(retired) == (tmp_path / "episode.sharecut").resolve()
    assert not retired.exists()


def test_require_episode_project_file_dir(tmp_path):
    target = tmp_path / "episode.sharecut"
    target.write_text("{}", encoding="utf-8")
    assert require_episode_project_file(tmp_path) == target.resolve()


def test_require_episode_project_file_empty_dir(tmp_path):
    try:
        require_episode_project_file(tmp_path)
        raise AssertionError("expected FileNotFoundError")
    except FileNotFoundError as exc:
        assert "episode.sharecut" in str(exc)
        assert str(tmp_path.resolve()) in str(exc)


def test_require_episode_project_file_missing(tmp_path):
    try:
        require_episode_project_file(tmp_path / "episode.sharecut")
        raise AssertionError("expected FileNotFoundError")
    except FileNotFoundError:
        pass


def test_copy_relocated_workspace_rewrites_dir_and_rejects_source(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "episode.sharecut").write_text(
        json.dumps(
            {
                "version": "2.0",
                "meta": {
                    "name": "t",
                    "workspace_dir": str(src),
                    "created_at": "2026-01-01T00:00:00+00:00",
                },
            }
        ),
        encoding="utf-8",
    )
    (src / "keep.txt").write_text("ok", encoding="utf-8")
    dest = tmp_path / "dest"
    copied = copy_relocated_workspace(src, dest)
    assert copied == dest / "episode.sharecut"
    data = json.loads(copied.read_text(encoding="utf-8"))
    assert data["meta"]["workspace_dir"] == str(dest.resolve())
    assert (dest / "keep.txt").read_text(encoding="utf-8") == "ok"
    rewrite_workspace_dir(copied)
    try:
        copy_relocated_workspace(src, src)
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "source project" in str(exc)
    try:
        copy_relocated_workspace(src, src / "nested")
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "inside the source" in str(exc)
    try:
        copy_relocated_workspace(src, dest)
        raise AssertionError("expected FileExistsError")
    except FileExistsError:
        pass


def test_rewrite_workspace_dir_rejects_non_object(tmp_path):
    path = tmp_path / "episode.sharecut"
    path.write_text("[1]", encoding="utf-8")
    try:
        rewrite_workspace_dir(path)
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "JSON object" in str(exc)
