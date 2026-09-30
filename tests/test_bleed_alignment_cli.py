from __future__ import annotations

import json

from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.services import ProjectWorkspace
from test_bleed_alignment_surfaces import _workspace


def test_cli_preview_decline_and_default_preserves_choice(tmp_path):
    ws = _workspace(tmp_path)
    common = ["--project", str(ws.path), "--track", "uncertain", "--start", "0.8", "--end", "3.5"]
    runner = CliRunner()
    before = ws.path.read_bytes()
    preview = runner.invoke(app, ["edit", "align-retained-bleed", *common, "--dry-run"])
    assert preview.exit_code == 0, preview.output
    decision = json.loads(preview.output)["proposals"][0]["decision_id"]
    assert ws.path.read_bytes() == before
    choice = runner.invoke(
        app,
        ["edit", "bleed-alignment-choice", *common, "--decision", decision, "--mode", "declined"],
    )
    assert choice.exit_code == 0, choice.output
    assert json.loads(choice.output)["mode"] == "declined"
    result = runner.invoke(app, ["edit", "align-retained-bleed", *common])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["applied_count"] == 0
    assert (
        ProjectWorkspace.open(ws.path).project.editorial.retained_bleed_alignments[0].mode
        == "declined"
    )


def test_cli_rejects_invalid_choice_before_any_project_write(tmp_path):
    ws = _workspace(tmp_path)
    before = ws.path.read_bytes()
    result = CliRunner().invoke(
        app,
        [
            "edit",
            "bleed-alignment-choice",
            "--project",
            str(ws.path),
            "--decision",
            "missing",
            "--mode",
            "oops",
        ],
    )
    assert result.exit_code != 0
    assert "mode must be auto, manual, or declined" in result.output
    assert ws.path.read_bytes() == before
