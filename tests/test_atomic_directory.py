import os
import sys
from pathlib import Path

import pytest

from podcast_mcp.util.atomic_directory import rename_noreplace
from podcast_mcp.util.host_platform import GENERIC_NT, GENERIC_POSIX, WINDOWS, using

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


def test_two_descriptor_move_and_nested_restore_preserve_collision(tmp_path):
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    (source / "stage").mkdir()
    (source / "stage" / "keep").write_bytes(b"owned")
    source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
    destination_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
    try:
        rename_noreplace("stage", "moved", source_fd, dst_root_fd=destination_fd)
        (source / "stage").mkdir()
        with pytest.raises(FileExistsError):
            rename_noreplace("moved", "stage", destination_fd, dst_root_fd=source_fd)
        (source / "nested").mkdir()
        rename_noreplace("moved", "nested/restored", destination_fd, dst_root_fd=source_fd)
    finally:
        os.close(source_fd)
        os.close(destination_fd)
    assert (source / "nested/restored/keep").read_bytes() == b"owned"
    assert (source / "stage").is_dir()


@pytest.mark.parametrize("row", [WINDOWS, GENERIC_POSIX, GENERIC_NT])
def test_a_host_without_a_no_replace_rename_refuses(tmp_path: Path, row):
    (tmp_path / "staged").mkdir()
    root_fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        with using(row), pytest.raises(OSError, match="atomic no-replace rename is unavailable"):
            rename_noreplace("staged", "published", root_fd)
    finally:
        os.close(root_fd)
    assert (tmp_path / "staged").is_dir()
