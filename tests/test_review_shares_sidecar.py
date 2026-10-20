"""The project ``shares.json`` sidecar: exact bytes, token stripping, no leftover temp files."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Any

from podcast_mcp.services.collaboration.review_shares import _load, _save

ROWS: list[dict[str, Any]] = [
    {"id": "s1", "token": "secret-token", "label": "Café review", "capabilities": ["view"]},
    {"id": "s2", "revoked": True},
]


def test_save_writes_indented_utf8_without_tokens(tmp_path: Path) -> None:
    path = tmp_path / "artifacts" / "review" / "shares.json"
    _save(path, ROWS)
    assert path.read_text(encoding="utf-8") == (
        "[\n"
        "  {\n"
        '    "id": "s1",\n'
        '    "label": "Café review",\n'
        '    "capabilities": [\n'
        '      "view"\n'
        "    ]\n"
        "  },\n"
        "  {\n"
        '    "id": "s2",\n'
        '    "revoked": true\n'
        "  }\n"
        "]\n"
    )
    assert _load(path) == [
        {"id": "s1", "label": "Café review", "capabilities": ["view"]},
        {"id": "s2", "revoked": True},
    ]


def test_save_replaces_the_file_and_leaves_no_temp_files(tmp_path: Path) -> None:
    path = tmp_path / "shares.json"
    _save(path, ROWS)
    _save(path, [])
    assert path.read_text(encoding="utf-8") == "[]\n"
    assert [p.name for p in tmp_path.iterdir()] == ["shares.json"]


def test_save_follows_the_process_umask(tmp_path: Path) -> None:
    previous = os.umask(0o022)
    try:
        path = tmp_path / "shares.json"
        _save(path, ROWS)
    finally:
        os.umask(previous)
    assert stat.S_IMODE(path.stat().st_mode) == 0o644
