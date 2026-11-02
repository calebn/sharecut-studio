from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.models import load_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.pipeline.service import PipelineService

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


def test_raw_e2e_seed_keeps_track_state_on_first_envelope_save(tmp_path: Path) -> None:
    fixture = _COMMITTED / "episode.sharecut"
    original = fixture.read_bytes()
    data = json.loads(original)
    data["meta"]["workspace_dir"] = str(tmp_path)
    project_path = tmp_path / "episode.sharecut"
    project_path.write_text(json.dumps(data))
    before = data["timeline"]["tracks"]

    workspace = ProjectWorkspace.open(project_path)
    PipelineService(workspace).set_envelope(
        "reference",
        [
            {"id": "start", "time": 0.0, "value": 1.0},
            {"id": "middle", "time": 30.0, "value": 1.0},
            {"id": "end", "time": 60.0, "value": 1.0},
        ],
    )

    saved = json.loads(project_path.read_text())
    assert fixture.read_bytes() == original
    assert saved["timeline"]["tracks"] == before
