from __future__ import annotations

import json

from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync import DocumentSyncService


def test_add_chapter_cli_saves_one_document_command(tmp_path):
    runner = CliRunner()
    workspace = tmp_path / "episode"
    initialized = runner.invoke(app, ["episode", "init", "--dir", str(workspace)])
    assert initialized.exit_code == 0, initialized.output
    path = workspace / "episode.project.json"
    assert DocumentSyncService.open(path).store.commands_after(0) == []

    result = runner.invoke(
        app,
        ["edit", "add-chapter", "--project", str(path), "--at-time", "1.5", "--title", "Intro"],
    )

    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {"time": 1.5, "title": "Intro", "image_url": None}
    saved = ProjectWorkspace.open(path).project
    assert [(chapter.time, chapter.title) for chapter in saved.chapters] == [(1.5, "Intro")]
    assert [entry.label for entry in saved.history.entries] == ["initial", "after add chapter"]
    rows = DocumentSyncService.open(path).store.commands_after(0)
    assert [row["type"] for row in rows] == ["AddChapter"]
    assert rows[0]["server_seq"] == 1
