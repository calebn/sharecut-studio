from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from podcast_mcp.util import atomic_file


def test_atomic_write_uses_unique_siblings_and_replaces(tmp_path: Path) -> None:
    dest = tmp_path / "nested" / "project.json"
    names: list[str] = []

    def fill(handle) -> None:
        names.append(Path(handle.name).name)
        handle.write(b"new")

    dest.parent.mkdir()
    dest.write_bytes(b"corrupt")
    assert atomic_file.atomic_write(dest, fill) == dest
    assert atomic_file.atomic_write(dest, fill) == dest
    assert len(set(names)) == 2
    assert all(name.startswith(".project.json.") and name.endswith(".tmp") for name in names)
    assert dest.read_bytes() == b"new"
    assert list(dest.parent.iterdir()) == [dest]


def test_atomic_write_failure_leaves_destination_and_cleans_temp(tmp_path: Path) -> None:
    dest = tmp_path / "state.json"
    dest.write_bytes(b"old")

    def fail(handle) -> None:
        handle.write(b"partial")
        raise RuntimeError("write failed")

    with pytest.raises(RuntimeError, match="write failed"):
        atomic_file.atomic_write(dest, fail)
    with (
        patch.object(atomic_file.os, "replace", side_effect=OSError("replace failed")),
        pytest.raises(OSError, match="replace failed"),
    ):
        atomic_file.atomic_write(dest, lambda handle: handle.write(b"new"))
    assert dest.read_bytes() == b"old"
    assert list(tmp_path.glob(".state.json.*.tmp")) == []


def test_atomic_write_fsyncs_before_publishing_mode_zero(tmp_path: Path) -> None:
    dest = tmp_path / "private.bin"
    atomic_file.atomic_write(dest, lambda handle: handle.write(b"secret"), mode=0)
    assert dest.stat().st_mode & 0o777 == 0
    dest.chmod(0o600)
    assert dest.read_bytes() == b"secret"


def test_publish_completed_file_fsyncs_then_calls_hook_then_replaces(tmp_path: Path) -> None:
    temp = tmp_path / "render.partial.wav"
    dest = tmp_path / "render.wav"
    temp.write_bytes(b"RIFF")
    events: list[str] = []
    real_fsync = os.fsync
    real_replace = os.replace

    def fsync(fd: int) -> None:
        events.append("fsync")
        real_fsync(fd)

    def replace(src: Path, target: Path) -> None:
        events.append("replace")
        real_replace(src, target)

    with (
        patch.object(atomic_file.os, "fsync", side_effect=fsync),
        patch.object(atomic_file.os, "replace", side_effect=replace),
    ):
        atomic_file.publish_completed_file(temp, dest, before_replace=lambda: events.append("hook"))
    assert events == ["fsync", "hook", "replace", "fsync"]
    assert dest.read_bytes() == b"RIFF"
    assert not temp.exists()


def test_publish_completed_file_preserves_old_dest_on_hook_error(tmp_path: Path) -> None:
    temp = tmp_path / "render.partial.wav"
    dest = tmp_path / "render.wav"
    temp.write_bytes(b"new")
    dest.write_bytes(b"old")

    def fail() -> None:
        raise ValueError("stale source")

    with pytest.raises(ValueError, match="stale source"):
        atomic_file.publish_completed_file(temp, dest, before_replace=fail)
    assert dest.read_bytes() == b"old"
    assert not temp.exists()


def test_publish_completed_file_keeps_old_dest_when_file_fsync_fails(tmp_path: Path) -> None:
    temp = tmp_path / "render.partial.wav"
    dest = tmp_path / "render.wav"
    temp.write_bytes(b"new")
    dest.write_bytes(b"old")
    with (
        patch.object(atomic_file.os, "fsync", side_effect=OSError("sync failed")),
        pytest.raises(OSError, match="sync failed"),
    ):
        atomic_file.publish_completed_file(temp, dest)
    assert dest.read_bytes() == b"old"
    assert not temp.exists()


def test_atomic_write_cancellation_keeps_primary_error(tmp_path: Path) -> None:
    dest = tmp_path / "state.json"
    dest.write_bytes(b"old")

    def cancel(handle) -> None:
        handle.write(b"partial")
        raise KeyboardInterrupt("cancelled")

    with pytest.raises(KeyboardInterrupt, match="cancelled"):
        atomic_file.atomic_write(dest, cancel)
    assert dest.read_bytes() == b"old"
    assert list(tmp_path.glob(".state.json.*.tmp")) == []


def test_publish_directory_sync_failure_is_best_effort(tmp_path: Path) -> None:
    temp = tmp_path / "render.partial.wav"
    dest = tmp_path / "render.wav"
    temp.write_bytes(b"new")
    with patch.object(atomic_file.os, "open", side_effect=OSError("directory unavailable")):
        assert atomic_file.publish_completed_file(temp, dest) == dest
    assert dest.read_bytes() == b"new"


@pytest.mark.skipif(os.name != "posix", reason="requires POSIX descriptor flags")
def test_windows_publication_syncs_writable_descriptor(tmp_path: Path) -> None:
    import fcntl

    temp = tmp_path / "completed.tmp"
    dest = tmp_path / "published.bin"
    temp.write_bytes(b"new")
    real_fsync = os.fsync

    def require_writable(fd: int) -> None:
        assert fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDWR
        real_fsync(fd)

    windows_os = Mock(wraps=os)
    windows_os.name = "nt"
    windows_os.fsync = require_writable
    with patch.object(atomic_file, "os", windows_os):
        assert atomic_file.publish_completed_file(temp, dest) == dest
    assert dest.read_bytes() == b"new"


@pytest.mark.skipif(os.name != "posix", reason="POSIX read-only temp contract")
def test_posix_publication_accepts_read_only_completed_temp(tmp_path: Path) -> None:
    temp = tmp_path / "completed.tmp"
    dest = tmp_path / "published.bin"
    temp.write_bytes(b"read only")
    temp.chmod(0o400)
    assert atomic_file.publish_completed_file(temp, dest) == dest
    assert dest.read_bytes() == b"read only"
    assert dest.stat().st_mode & 0o777 == 0o400


@pytest.mark.skipif(os.name != "posix", reason="requires POSIX umask")
@pytest.mark.parametrize(("mask", "public_mode"), [("022", 0o644), ("027", 0o640), ("077", 0o600)])
def test_creation_modes_follow_caller_policy_under_umask(
    tmp_path: Path, mask: str, public_mode: int
) -> None:
    script = """
import json
import os
import sys
from pathlib import Path
from podcast_mcp.util.atomic_file import atomic_write
from podcast_mcp.util.atomic_json import copy_file_atomic, write_text_atomic

root = Path(sys.argv[1])
os.umask(int(sys.argv[2], 8))
atomic_write(root / "private", lambda handle: handle.write(b"private"))
atomic_write(root / "public", lambda handle: handle.write(b"public"), creation_mode=0o666)
write_text_atomic(root / "text", "text", creation_mode=0o666)
source = root / "source"
source.write_bytes(b"source")
source.chmod(0o640)
copy_file_atomic(source, root / "copy")
assert (root / "private").read_bytes() == b"private"
assert (root / "public").read_bytes() == b"public"
assert (root / "text").read_text() == "text"
assert (root / "copy").read_bytes() == b"source"
print(json.dumps({name: (root / name).stat().st_mode & 0o777
                  for name in ("private", "public", "text", "copy")}))
"""
    result = subprocess.check_output([sys.executable, "-c", script, str(tmp_path), mask], text=True)
    assert json.loads(result) == {
        "private": 0o600,
        "public": public_mode,
        "text": public_mode,
        "copy": 0o640,
    }
