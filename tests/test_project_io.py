from __future__ import annotations

import json
import logging
import os

import pytest

from podcast_mcp.project.io import (
    RETIRED_PROJECT_FILENAME,
    adopt_retired_entry_file,
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


def _names(folder):
    return sorted(child.name for child in folder.iterdir())


def test_resolve_project_path_maps_a_retired_file_to_its_sibling_without_renaming(tmp_path):
    retired = tmp_path / RETIRED_PROJECT_FILENAME
    retired.write_bytes(b"{}")
    assert resolve_project_path(retired) == (tmp_path / "episode.sharecut").resolve()
    assert resolve_project_path(tmp_path) == (tmp_path / "episode.sharecut").resolve()
    assert _names(tmp_path) == [RETIRED_PROJECT_FILENAME]


def test_resolve_project_path_maps_a_missing_retired_file_without_error(tmp_path):
    missing = tmp_path / RETIRED_PROJECT_FILENAME
    assert resolve_project_path(missing) == (tmp_path / "episode.sharecut").resolve()
    assert list(tmp_path.iterdir()) == []


def test_resolve_project_path_returns_any_other_path_unchanged(tmp_path):
    other = tmp_path / "notes.json"
    assert resolve_project_path(other) == other.resolve()


def test_adopt_renames_a_folder_holding_only_the_retired_file(tmp_path, caplog):
    (tmp_path / RETIRED_PROJECT_FILENAME).write_bytes(b'{"version": "2.0"}\n')
    with caplog.at_level(logging.INFO, logger="podcast_mcp.project.io"):
        adopted = adopt_retired_entry_file(tmp_path)
    assert adopted == (tmp_path / "episode.sharecut").resolve()
    assert adopted.read_bytes() == b'{"version": "2.0"}\n'
    assert _names(tmp_path) == ["episode.sharecut"]
    assert [r.getMessage() for r in caplog.records if r.levelno == logging.INFO] == [
        f"renamed {tmp_path.resolve() / RETIRED_PROJECT_FILENAME} to {adopted}"
    ]


def test_adopt_renames_the_retired_file_given_directly(tmp_path):
    retired = tmp_path / RETIRED_PROJECT_FILENAME
    retired.write_bytes(b"{}")
    adopted = adopt_retired_entry_file(retired)
    assert adopted == (tmp_path / "episode.sharecut").resolve()
    assert adopted.read_bytes() == b"{}"
    assert _names(tmp_path) == ["episode.sharecut"]


def test_adopt_is_a_silent_no_op_the_second_time(tmp_path, caplog):
    (tmp_path / RETIRED_PROJECT_FILENAME).write_bytes(b"{}")
    first = adopt_retired_entry_file(tmp_path)
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="podcast_mcp.project.io"):
        second = adopt_retired_entry_file(first)
    assert first == second == (tmp_path / "episode.sharecut").resolve()
    assert _names(tmp_path) == ["episode.sharecut"]
    assert caplog.records == []


def test_adopt_leaves_a_folder_without_either_file_alone(tmp_path):
    assert adopt_retired_entry_file(tmp_path) == (tmp_path / "episode.sharecut").resolve()
    assert list(tmp_path.iterdir()) == []


def test_adopt_ignores_a_file_that_is_not_an_entry_path(tmp_path):
    (tmp_path / RETIRED_PROJECT_FILENAME).write_bytes(b"{}")
    other = tmp_path / "notes.json"
    assert adopt_retired_entry_file(other) == other.resolve()
    assert _names(tmp_path) == [RETIRED_PROJECT_FILENAME]


def test_adopt_keeps_the_current_file_and_the_older_retired_file(tmp_path, caplog):
    retired = tmp_path / RETIRED_PROJECT_FILENAME
    retired.write_bytes(b"old")
    current = tmp_path / "episode.sharecut"
    current.write_bytes(b"new")
    os.utime(retired, (1_000, 1_000))
    os.utime(current, (2_000, 2_000))
    with caplog.at_level(logging.WARNING, logger="podcast_mcp.project.io"):
        assert adopt_retired_entry_file(retired) == current.resolve()
    assert retired.read_bytes() == b"old"
    assert current.read_bytes() == b"new"
    assert caplog.records == []


def test_adopt_warns_once_when_the_retired_file_is_newer_than_the_current_one(tmp_path, caplog):
    retired = tmp_path / RETIRED_PROJECT_FILENAME
    retired.write_bytes(b"edited by an older build")
    current = tmp_path / "episode.sharecut"
    current.write_bytes(b"new")
    os.utime(current, (1_000, 1_000))
    os.utime(retired, (2_000, 2_000))
    with caplog.at_level(logging.WARNING, logger="podcast_mcp.project.io"):
        assert adopt_retired_entry_file(tmp_path) == current.resolve()
    assert [r.getMessage() for r in caplog.records] == [
        f"{retired.resolve()} is newer than {current.resolve()} and is ignored; "
        "edits saved by an older build are not loaded"
    ]
    assert retired.read_bytes() == b"edited by an older build"
    assert current.read_bytes() == b"new"


def test_adopt_asks_for_a_hand_rename_when_the_rename_fails(tmp_path, monkeypatch):
    (tmp_path / RETIRED_PROJECT_FILENAME).write_bytes(b"{}")

    def refuse(src, dst):
        raise PermissionError("read-only")

    monkeypatch.setattr("podcast_mcp.project.io.os.rename", refuse)
    with pytest.raises(ValueError) as raised:
        adopt_retired_entry_file(tmp_path)
    assert raised.value.code == "project_old_filename"
    assert str(raised.value) == (
        "episode.project.json could not be renamed automatically. "
        "Rename it to episode.sharecut by hand and open it again."
    )
    assert _names(tmp_path) == [RETIRED_PROJECT_FILENAME]


@pytest.mark.parametrize("lost", [FileNotFoundError, FileExistsError])
def test_adopt_treats_losing_the_rename_race_as_success(tmp_path, monkeypatch, lost):
    (tmp_path / RETIRED_PROJECT_FILENAME).write_bytes(b"{}")

    def another_process_wins(src, dst):
        (tmp_path / "episode.sharecut").write_bytes(b"{}")
        (tmp_path / RETIRED_PROJECT_FILENAME).unlink()
        raise lost(src)

    monkeypatch.setattr("podcast_mcp.project.io.os.rename", another_process_wins)
    assert adopt_retired_entry_file(tmp_path) == (tmp_path / "episode.sharecut").resolve()


def test_workspace_open_adopts_the_retired_file_given_as_a_folder_or_a_file(minimal_project):
    retired = minimal_project.rename(minimal_project.with_name(RETIRED_PROJECT_FILENAME))
    ws = ProjectWorkspace.open(retired.parent)
    assert ws.path == minimal_project.resolve()
    assert minimal_project.is_file()
    assert not retired.exists()


def test_copy_relocated_workspace_adopts_the_source_and_copies_the_new_name(
    minimal_project, tmp_path
):
    retired = minimal_project.rename(minimal_project.with_name(RETIRED_PROJECT_FILENAME))
    dest = tmp_path / "copy"
    copy_relocated_workspace(retired, dest)
    assert minimal_project.is_file()
    assert not retired.exists()
    assert (dest / "episode.sharecut").is_file()
    assert not (dest / RETIRED_PROJECT_FILENAME).exists()


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
