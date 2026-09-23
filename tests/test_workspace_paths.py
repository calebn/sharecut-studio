"""resolve_within / resolve_under_workspace path containment."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.workspace_paths import resolve_under_workspace, resolve_within


def test_resolve_within_relative_under_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    assert resolve_within(root, "a/x.wav") == (root / "a" / "x.wav").resolve()


def test_resolve_within_base_differs_from_root(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    root = ws / "artifacts" / "review"
    root.mkdir(parents=True)
    assert (
        resolve_within(root, "artifacts/review/v/mix.wav", base=ws)
        == (root / "v" / "mix.wav").resolve()
    )
    with pytest.raises(ValueError):
        resolve_within(root, "artifacts/premix.wav", base=ws)


@pytest.mark.parametrize("stored", ["../x.wav", "a/../../x.wav"])
def test_resolve_within_rejects_dotdot(tmp_path: Path, stored: str) -> None:
    root = tmp_path / "root"
    root.mkdir()
    with pytest.raises(ValueError, match="escapes"):
        resolve_within(root, stored)


def test_resolve_within_absolute(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    inside = root / "x.wav"
    assert resolve_within(root, str(inside)) == inside.resolve()
    outside = str(tmp_path / "outside.wav")
    with pytest.raises(ValueError):
        resolve_within(root, outside)


def test_resolve_within_rejects_symlink_escape(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.wav"
    outside.write_bytes(b"x")
    link = root / "mix.wav"
    try:
        link.symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"symlinks unsupported: {exc}")
    with pytest.raises(ValueError):
        resolve_within(root, "mix.wav")


def test_resolve_within_symlinked_root_ok(tmp_path: Path) -> None:
    real = tmp_path / "real"
    (real / "v").mkdir(parents=True)
    (real / "v" / "mix.wav").write_bytes(b"x")
    root = tmp_path / "root"
    try:
        root.symlink_to(real)
    except OSError as exc:
        pytest.skip(f"symlinks unsupported: {exc}")
    assert resolve_within(root, "v/mix.wav") == (real / "v" / "mix.wav").resolve()


def test_resolve_under_workspace_message_unchanged(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    project = EpisodeProject.create("t", str(ws))
    with pytest.raises(ValueError, match="path must be under workspace"):
        resolve_under_workspace(project, "../x")
    result = resolve_under_workspace(project, "raw/a.wav")
    assert result.is_relative_to(project.workspace_path().resolve())
