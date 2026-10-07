from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.e2e_fixture import DEFAULT_CANNED, KNOWN_PHRASES
from podcast_mcp.fixture_seed import seed_canned_transcript
from podcast_mcp.models import load_project


def _seed(project):
    return seed_canned_transcript(project, DEFAULT_CANNED)


pytestmark = pytest.mark.e2e
runner = CliRunner()


def test_nl_edit_and_preview_play(e2e_workspace) -> None:
    _seed(e2e_workspace)
    query = KNOWN_PHRASES[0]
    cut = runner.invoke(
        app,
        [
            "edit",
            "cut-text",
            "--project",
            str(e2e_workspace),
            "--query",
            query,
        ],
    )
    assert cut.exit_code == 0, cut.stdout + cut.stderr

    proj = load_project(e2e_workspace)
    edit_ids = [e.id for e in proj.edit_decisions]
    assert edit_ids
    approve_args = ["edit", "approve", "--project", str(e2e_workspace)]
    approve_args += ["--ids", ",".join(edit_ids)]
    asked = runner.invoke(app, approve_args)
    assert asked.exit_code == 1, asked.output
    assert 'This also cuts guest\'s speech at 0:08.5 ("antonia pointed up").' in asked.stderr
    assert "Run again with --yes to cut anyway." in asked.stderr
    assert [e.id for e in load_project(e2e_workspace).edit_decisions] == edit_ids

    approve = runner.invoke(app, [*approve_args, "--yes"])
    assert approve.exit_code == 0, approve.output

    preview = runner.invoke(
        app,
        ["render-preview", "--project", str(e2e_workspace)],
    )
    assert preview.exit_code == 0

    play = runner.invoke(
        app,
        [
            "play",
            "--project",
            str(e2e_workspace),
            "--source",
            "premix",
            "--start",
            "0",
            "--end",
            "5",
            "--dry-run",
        ],
    )
    assert play.exit_code == 0
    data = json.loads(play.stdout)
    assert data["wav"]

    proj = load_project(e2e_workspace)
    assert not any(e.review_required for e in proj.edit_decisions)
