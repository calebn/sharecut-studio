"""The project ``shares.json`` sidecar: exact bytes, token stripping, no leftover temp files."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import Any

from podcast_mcp.models import EpisodeProject, save_project
from podcast_mcp.services.collaboration.review_shares import (
    _load,
    _save,
    create_share,
    revoke_share,
    usable_share_tokens,
)
from podcast_mcp.services.collaboration.share_registry import (
    RECORD_REVIEW_VERSION_SENTINEL,
    SHARE_KIND_RECORD,
)

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


def test_usable_share_tokens_skips_revoked_and_expired(tmp_workspace: Path) -> None:
    project = EpisodeProject.create("usable_tokens", str(tmp_workspace))
    project.ensure_dirs()
    save_project(project)

    def mint(**kwargs: Any) -> str:
        row = create_share(
            project,
            review_version_id=RECORD_REVIEW_VERSION_SENTINEL,
            kind=SHARE_KIND_RECORD,
            role="guest",
            session_id="s1",
            **kwargs,
        )
        return str(row["token"])

    live = mint()
    revoked = mint()
    mint(expires_at="2020-01-01T00:00:00Z")
    assert revoke_share(project, revoked)

    assert usable_share_tokens(project.workspace_path()) == frozenset({live})
