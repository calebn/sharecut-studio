from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from podcast_mcp.util import atomic_json
from podcast_mcp.util.atomic_json import (
    copy_file_atomic,
    load_json_object,
    write_json_atomic,
    write_text_atomic,
)


def test_write_text_atomic_replaces_and_fsyncs_directory(tmp_path: Path) -> None:
    target = tmp_path / "nested" / "context.yaml"
    with patch.object(atomic_json.os, "fsync", wraps=atomic_json.os.fsync) as fsync:
        write_text_atomic(target, "terms: [A]\n")
    assert target.read_text(encoding="utf-8") == "terms: [A]\n"
    assert fsync.call_count >= 2
    assert list(target.parent.glob(".context.yaml.*.tmp")) == []


def test_write_text_atomic_removes_temp_on_failure(tmp_path: Path) -> None:
    target = tmp_path / "context.yaml"
    with (
        patch.object(atomic_json.os, "replace", side_effect=OSError("disk")),
        pytest.raises(OSError),
    ):
        write_text_atomic(target, "x")
    assert list(tmp_path.glob(".context.yaml.*.tmp")) == []


def test_write_json_atomic_roundtrip(tmp_path: Path) -> None:
    target = tmp_path / "status.json"
    write_json_atomic(target, {"a": 1})
    assert load_json_object(target) == {"a": 1}


def test_copy_file_atomic_replaces_whole_file(tmp_path: Path) -> None:
    src = tmp_path / "src.wav"
    src.write_bytes(b"new-bytes")
    src.chmod(0o640)
    dest = tmp_path / "nested" / "dest.wav"
    dest.parent.mkdir()
    dest.write_bytes(b"old-bytes-that-are-longer")

    result = copy_file_atomic(src, dest)

    assert result == dest
    assert dest.read_bytes() == b"new-bytes"
    assert list(dest.parent.glob(".dest.wav.*.tmp")) == []
    assert (dest.stat().st_mode & 0o777) == 0o640


def test_copy_file_atomic_keeps_previous_on_failure(tmp_path: Path) -> None:
    src = tmp_path / "src.wav"
    src.write_bytes(b"new-bytes")
    dest = tmp_path / "dest.wav"
    dest.write_bytes(b"old-bytes")

    def partial_copy(fsrc: Any, fdst: Any, length: int = 0) -> None:
        fdst.write(b"partial")
        raise OSError("disk full")

    with (
        patch.object(atomic_json.shutil, "copyfileobj", side_effect=partial_copy),
        pytest.raises(OSError),
    ):
        copy_file_atomic(src, dest)

    assert dest.read_bytes() == b"old-bytes"
    assert list(tmp_path.glob(".dest.wav.*.tmp")) == []
