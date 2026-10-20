import os
import sys
from pathlib import Path

import pytest

from podcast_mcp.util.atomic_directory import rename_noreplace

pytestmark = pytest.mark.skipif(
    not (sys.platform.startswith("linux") or sys.platform == "darwin"),
    reason="atomic no-replace rename is supported on Linux and macOS",
)


def test_promotes_complete_directory_relative_to_pinned_parent(tmp_path: Path):
    staged = tmp_path / "staged"
    staged.mkdir()
    (staged / "chunk.mp3").write_bytes(b"complete")
    root_fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        rename_noreplace("staged", "published", root_fd)
    finally:
        os.close(root_fd)
    assert not staged.exists()
    assert (tmp_path / "published" / "chunk.mp3").read_bytes() == b"complete"


@pytest.mark.parametrize("occupied", ["file", "empty-directory", "directory", "symlink"])
def test_preserves_existing_destination_and_source(tmp_path: Path, occupied: str):
    staged = tmp_path / "staged"
    staged.mkdir()
    (staged / "chunk.mp3").write_bytes(b"new")
    destination = tmp_path / "published"
    if occupied == "file":
        destination.write_bytes(b"old")
    elif occupied == "symlink":
        target = tmp_path / "target"
        target.mkdir()
        (target / "chunk.mp3").write_bytes(b"old")
        destination.symlink_to(target, target_is_directory=True)
    else:
        destination.mkdir()
        if occupied == "directory":
            (destination / "chunk.mp3").write_bytes(b"old")
    before = destination.lstat()
    root_fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        with pytest.raises(FileExistsError):
            rename_noreplace("staged", "published", root_fd)
    finally:
        os.close(root_fd)
    assert destination.lstat() == before
    assert (staged / "chunk.mp3").read_bytes() == b"new"
    if occupied == "file":
        assert destination.read_bytes() == b"old"
    elif occupied != "empty-directory":
        assert (destination / "chunk.mp3").read_bytes() == b"old"
