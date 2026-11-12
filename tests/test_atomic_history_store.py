from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.project.history.manager import snapshot_from_project, write_snapshot
from podcast_mcp.project.store import ProjectStore, history_index_path, history_snapshot_path
from podcast_mcp.util import atomic_file


def _umask() -> int:
    current = os.umask(0)
    os.umask(current)
    return current


def _leftovers(directory: Path) -> list[str]:
    return sorted(p.name for p in directory.iterdir() if p.name.endswith(".tmp"))


def test_write_snapshot_bytes_and_mode_match_plain_write(minimal_project) -> None:
    project = ProjectStore(minimal_project).load()
    snapshot = snapshot_from_project(project)
    rel = write_snapshot(project, snapshot, "entry-a")
    path = project.workspace_path() / rel
    assert path.read_bytes() == snapshot.model_dump_json(indent=2, by_alias=True).encode("utf-8")
    plain = path.with_name("plain.json")
    plain.write_text(snapshot.model_dump_json(indent=2, by_alias=True), encoding="utf-8")
    if os.name == "posix":
        assert path.stat().st_mode & 0o777 == plain.stat().st_mode & 0o777 == 0o666 & ~_umask()


def test_write_snapshot_failure_keeps_previous_and_leaves_no_temp(minimal_project) -> None:
    project = ProjectStore(minimal_project).load()
    snapshot = snapshot_from_project(project)
    path = history_snapshot_path(history_index_path(project), "entry-b")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("previous", encoding="utf-8")
    with (
        patch.object(atomic_file.os, "replace", side_effect=OSError("disk full")),
        pytest.raises(OSError),
    ):
        write_snapshot(project, snapshot, "entry-b")
    assert path.read_text(encoding="utf-8") == "previous"
    assert _leftovers(path.parent) == []


def test_write_cache_bytes_and_mode_match_plain_write(tmp_path: Path) -> None:
    target = tmp_path / "sub" / "combined.json"
    content = b'{"utterances": []}\r\n\xc3\xa9'
    ProjectStore._write_cache_if_changed(target, content)
    assert target.read_bytes() == content
    plain = tmp_path / "plain.json"
    plain.write_bytes(content)
    if os.name == "posix":
        assert target.stat().st_mode & 0o777 == plain.stat().st_mode & 0o777


def test_write_cache_failure_keeps_previous_and_leaves_no_temp(tmp_path: Path) -> None:
    target = tmp_path / "combined.json"
    target.write_bytes(b"previous")
    with (
        patch.object(atomic_file.os, "replace", side_effect=OSError("disk full")),
        pytest.raises(OSError),
    ):
        ProjectStore._write_cache_if_changed(target, b"new")
    assert target.read_bytes() == b"previous"
    assert _leftovers(tmp_path) == []
