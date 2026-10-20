from __future__ import annotations

import json
import re

import pytest
from typer.testing import CliRunner

from e2e_fixture import DEFAULT_CANNED, KNOWN_PHRASES
from podcast_mcp.cli.fixture import seed_canned_transcript
from podcast_mcp.cli.main import app
from podcast_mcp.models import load_project
from podcast_mcp.services.document_sync import (
    INTERACTIVE_COMMAND,
    DocumentCommand,
    DocumentSyncService,
)


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
    guest_clips = [clip for clip in proj.clips if clip.track_id == "guest"]
    duration = proj.timeline.duration_sec
    edit_ids = [e.id for e in proj.edit_decisions]
    assert edit_ids
    assert all(e.scope == "session" and e.review_required for e in proj.edit_decisions)
    assert all("other_speaking" in (e.reason or "") for e in proj.edit_decisions)
    approve_args = ["edit", "approve", "--project", str(e2e_workspace)]
    approve_args += ["--ids", ",".join(edit_ids)]
    asked = runner.invoke(app, approve_args)
    assert asked.exit_code == 1, asked.output
    assert "guest is speaking where the session cut would remove it" in asked.output
    unchanged = load_project(e2e_workspace)
    assert [clip for clip in unchanged.clips if clip.track_id == "guest"] == guest_clips
    assert unchanged.timeline.duration_sec == duration
    approve = runner.invoke(app, [*approve_args, "--yes"])
    assert approve.exit_code == 2, approve.output
    assert "No such option: --yes" in re.sub(r"\x1b\[[0-9;]*m", "", approve.output)
    assert load_project(e2e_workspace).clips == unchanged.clips
    DocumentSyncService.open(e2e_workspace).submit(
        DocumentCommand(
            type="ApproveEdits",
            payload={"ids": edit_ids},
            client_id="host",
            role="viewer",
            client_seq=None,
        ),
        trusted_context=INTERACTIVE_COMMAND,
    )
    applied = load_project(e2e_workspace)
    assert applied.editorial.edit_log[-1].params["scope"] == "session"
    assert "guest" in applied.editorial.edit_log[-1].track_ids
    assert [clip for clip in applied.clips if clip.track_id == "guest"] != guest_clips
    assert applied.timeline.duration_sec < duration
    ends = {
        tid: max(c.timeline_end for c in applied.clips if c.track_id == tid)
        for tid in {c.track_id for c in applied.clips}
    }
    assert len(ends) > 1
    assert max(ends.values()) == pytest.approx(min(ends.values()))

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
