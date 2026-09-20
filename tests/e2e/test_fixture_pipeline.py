from __future__ import annotations

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.e2e_fixture import DEFAULT_CANNED
from podcast_mcp.fixture_seed import seed_canned_transcript
from podcast_mcp.models import load_project

pytestmark = [pytest.mark.e2e, pytest.mark.e2e_slow]
runner = CliRunner()


def test_pipeline_ingest_and_assemble(e2e_workspace) -> None:
    seed_canned_transcript(e2e_workspace, DEFAULT_CANNED)
    for step in ("ingest_tracks", "assemble_timeline"):
        result = runner.invoke(
            app,
            [
                "pipeline",
                "run",
                "--project",
                str(e2e_workspace),
                "--only",
                step,
            ],
        )
        assert result.exit_code == 0, result.stdout + result.stderr

    proj = load_project(e2e_workspace)
    meta = proj.artifacts_dir() / "track_outputs.json"
    assert meta.is_file()
