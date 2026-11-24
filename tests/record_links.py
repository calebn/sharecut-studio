"""Mint record links without media, so tests of the share path need no FFmpeg."""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.models import EpisodeProject, load_project, save_project
from podcast_mcp.services.collaboration.review_shares import create_share
from podcast_mcp.services.collaboration.share_registry import (
    RECORD_REVIEW_VERSION_SENTINEL,
    SHARE_KIND_RECORD,
)


def make_project(workspace: Path, name: str = "episode") -> Path:
    project = EpisodeProject.create(name, str(workspace))
    project.ensure_dirs()
    return save_project(project)


def mint_record_link(project_path: Path) -> str:
    row = create_share(
        load_project(project_path),
        review_version_id=RECORD_REVIEW_VERSION_SENTINEL,
        kind=SHARE_KIND_RECORD,
        role="guest",
        session_id="session-1",
    )
    return str(row["token"])
