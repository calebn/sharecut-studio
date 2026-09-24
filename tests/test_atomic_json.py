from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.util import atomic_json
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic, write_text_atomic


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
