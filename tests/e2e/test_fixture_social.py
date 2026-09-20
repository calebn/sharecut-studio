from __future__ import annotations

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.e2e_fixture import DEFAULT_CANNED
from podcast_mcp.fixture_seed import seed_canned_transcript
from podcast_mcp.models import load_project

pytestmark = pytest.mark.e2e
runner = CliRunner()


def test_social_clip_export(e2e_workspace) -> None:
    seed_canned_transcript(e2e_workspace, DEFAULT_CANNED)
    runner.invoke(app, ["render-preview", "--project", str(e2e_workspace)])

    # Ensure at least one sentence-like utterance in the social duration band.
    from podcast_mcp.models import CombinedTranscript, CombinedUtterance
    from podcast_mcp.project_store import ProjectStore

    proj = load_project(e2e_workspace)
    proj.combined_transcript = CombinedTranscript(
        utterances=[
            CombinedUtterance(
                track_id="reference",
                speaker="Host",
                start=2.0,
                end=18.0,
                text=(
                    "Welcome to the show. So here is why this matters for people "
                    "who care about learning from each other?"
                ),
            )
        ]
    )
    ProjectStore(e2e_workspace).commit(proj)

    propose = runner.invoke(
        app,
        ["clips", "propose", "--project", str(e2e_workspace)],
    )
    assert propose.exit_code == 0, propose.stdout + propose.stderr

    proj = load_project(e2e_workspace)
    ids = [c.id for c in proj.social_clip_candidates[:1]]
    assert ids

    approve = runner.invoke(
        app,
        [
            "clips",
            "approve",
            "--project",
            str(e2e_workspace),
            "--ids",
            ",".join(ids),
        ],
    )
    assert approve.exit_code == 0

    export = runner.invoke(
        app,
        [
            "clips",
            "export",
            "--project",
            str(e2e_workspace),
            "--ids",
            ",".join(ids),
        ],
    )
    assert export.exit_code == 0
    proj = load_project(e2e_workspace)
    exported = [c for c in proj.social_clip_candidates if c.exported_path]
    assert exported
    path = proj.workspace_path() / exported[0].exported_path
    assert path.is_file()

    approve = runner.invoke(
        app,
        [
            "clips",
            "approve",
            "--project",
            str(e2e_workspace),
            "--ids",
            ",".join(ids),
        ],
    )
    assert approve.exit_code == 0

    export = runner.invoke(
        app,
        [
            "clips",
            "export",
            "--project",
            str(e2e_workspace),
            "--ids",
            ",".join(ids),
        ],
    )
    assert export.exit_code == 0
    proj = load_project(e2e_workspace)
    exported = [c for c in proj.social_clip_candidates if c.exported_path]
    assert exported
    path = proj.workspace_path() / exported[0].exported_path
    assert path.is_file()
