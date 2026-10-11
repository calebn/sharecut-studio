from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.e2e_fixture import DEFAULT_CANNED, KNOWN_PHRASES
from podcast_mcp.engines.audio_audit import _played_window
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
    guest_track = proj.track_by_id("guest")
    guest_clips = [clip for clip in proj.clips if clip.track_id == "guest"]
    guest_words = proj.transcript_for_track("guest")
    duration = proj.timeline.duration_sec
    guest_audio = _played_window(proj, "guest", 0.0, duration)
    edit_ids = [e.id for e in proj.edit_decisions]
    assert edit_ids
    assert all(e.scope == "track" for e in proj.edit_decisions)
    approve_args = ["edit", "approve", "--project", str(e2e_workspace)]
    approve_args += ["--ids", ",".join(edit_ids)]
    approve = runner.invoke(app, approve_args)
    assert approve.exit_code == 0, approve.output
    applied = load_project(e2e_workspace)
    assert applied.editorial.edit_log[-1].params["scope"] == "track"
    assert applied.track_by_id("guest") == guest_track
    assert [clip for clip in applied.clips if clip.track_id == "guest"] == guest_clips
    assert applied.transcript_for_track("guest") == guest_words
    assert applied.timeline.duration_sec == duration
    played = _played_window(applied, "guest", 0.0, duration)
    assert guest_audio.size == played.size == 480_000
    assert played.tobytes() == guest_audio.tobytes()

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
