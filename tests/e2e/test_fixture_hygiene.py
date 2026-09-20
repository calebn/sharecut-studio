from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.models import load_project

pytestmark = pytest.mark.e2e

_COMMITTED = Path(__file__).resolve().parents[1] / "fixtures" / "aligned_dialogue"


def test_e2e_workspace_relocated_away_from_committed_tree(e2e_workspace: Path) -> None:
    """Copied workspaces must not point back at the committed fixture tree."""
    proj = load_project(e2e_workspace)
    ws = proj.workspace_path()

    assert ws == e2e_workspace.parent.resolve()
    assert ws != _COMMITTED.resolve()
    assert _COMMITTED.resolve() not in ws.parents


def test_e2e_workspace_writes_stay_in_tmp(e2e_workspace: Path) -> None:
    """A project write lands in the tmp copy, never the committed tree."""
    proj = load_project(e2e_workspace)
    before = {p.name for p in _COMMITTED.joinpath("transcripts").glob("*")}

    probe = proj.transcripts_dir() / "_probe.json"
    probe.parent.mkdir(parents=True, exist_ok=True)
    probe.write_text("{}", encoding="utf-8")

    assert probe.is_file()
    assert e2e_workspace.parent.resolve() in probe.resolve().parents
    after = {p.name for p in _COMMITTED.joinpath("transcripts").glob("*")}
    assert before == after
