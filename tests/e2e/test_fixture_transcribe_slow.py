from __future__ import annotations

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import load_project

pytestmark = [pytest.mark.e2e, pytest.mark.e2e_slow]
runner = CliRunner()


def test_live_transcribe(e2e_workspace) -> None:
    result = runner.invoke(
        app,
        ["transcribe", "--project", str(e2e_workspace)],
    )
    assert result.exit_code == 0, result.stdout + result.stderr
    proj = load_project(e2e_workspace)
    assert len(proj.transcripts) >= 1
    assert any(t.words for t in proj.transcripts)
