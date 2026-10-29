"""Renaming a project changes ``meta.name`` only: undoable, validated, host-only."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from podcast_mcp.models import PROJECT_NAME_MAX_CHARS
from podcast_mcp.services.app import recent_projects as recent
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.document_sync.capabilities import (
    EDIT_COMMANDS,
    SUGGEST_COMMANDS,
)
from podcast_mcp.services.document_sync.handlers import apply_command
from podcast_mcp.services.document_sync.payloads import DOCUMENT_COMMAND_ADAPTER
from podcast_mcp.util.coded_error import CodedValueError


def test_rename_sets_the_trimmed_name_and_persists_it(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    out = apply_command(ws, "RenameProject", {"name": "  Season 2 Finale \n"})
    assert out == {"name": "Season 2 Finale"}
    assert ProjectWorkspace.open(minimal_project).project.meta.name == "Season 2 Finale"


def test_rename_moves_no_folder_or_file(minimal_project):
    def tree() -> set[Path]:
        return {p.relative_to(minimal_project.parent) for p in minimal_project.parent.rglob("*")}

    before = tree()
    apply_command(ProjectWorkspace.open(minimal_project), "RenameProject", {"name": "Other"})
    assert before <= tree()
    assert minimal_project.is_file()


def test_rename_is_one_undo_step(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    original = ws.project.meta.name
    apply_command(ws, "RenameProject", {"name": "Renamed"})
    assert HistoryService(ws).status().can_undo is True
    HistoryService(ws).undo()
    assert ProjectWorkspace.open(minimal_project).project.meta.name == original
    HistoryService(ws).redo()
    assert ProjectWorkspace.open(minimal_project).project.meta.name == "Renamed"


@pytest.mark.parametrize(
    "name",
    [
        "",
        "   \t\n",
        "x" * (PROJECT_NAME_MAX_CHARS + 1),
        "bad\x00name",
        "tab\there",
        "bell\x07",
        "a‮b",
        "a\u2028b",
        "a\u2029b",
        "a​b",
        "a\ufeffb",
    ],
)
def test_rename_rejects_invalid_names_and_leaves_the_project(minimal_project, name):
    ws = ProjectWorkspace.open(minimal_project)
    original = ws.project.meta.name
    with pytest.raises(CodedValueError) as err:
        apply_command(ws, "RenameProject", {"name": name})
    assert err.value.code == "invalid_project_name"
    assert ProjectWorkspace.open(minimal_project).project.meta.name == original


def test_rename_refusal_names_invisible_formatting_characters(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    with pytest.raises(CodedValueError, match="control or invisible formatting characters"):
        apply_command(ws, "RenameProject", {"name": "a\u200bb"})


def test_rename_accepts_a_zwj_emoji_sequence(minimal_project):
    name = "Family \U0001f468\u200d\U0001f469\u200d\U0001f467 show"
    ws = ProjectWorkspace.open(minimal_project)
    assert apply_command(ws, "RenameProject", {"name": name}) == {"name": name}


def test_rename_accepts_the_longest_name(minimal_project):
    name = "n" * PROJECT_NAME_MAX_CHARS
    ws = ProjectWorkspace.open(minimal_project)
    assert apply_command(ws, "RenameProject", {"name": name}) == {"name": name}


def test_rename_command_validates_as_an_envelope():
    body = DOCUMENT_COMMAND_ADAPTER.validate_python(
        {
            "type": "RenameProject",
            "payload": {"name": "Pilot"},
            "client_id": "c1",
            "client_seq": 1,
        }
    )
    assert body.payload.name == "Pilot"


def test_guests_cannot_rename():
    assert "RenameProject" not in EDIT_COMMANDS | SUGGEST_COMMANDS


def test_recent_projects_lists_the_new_name(tmp_path: Path):
    path = ProjectWorkspace.create(tmp_path / "folder", name="Old name").path
    recent.record_recent(path)
    assert recent.recent_project_cards()[0]["name"] == "Old name"
    apply_command(ProjectWorkspace.open(path), "RenameProject", {"name": "New name"})
    cards = recent.recent_project_cards()
    assert cards[0]["name"] == "New name"
    assert json.loads(path.read_text(encoding="utf-8"))["meta"]["name"] == "New name"
    assert path.parent.name == "folder"
