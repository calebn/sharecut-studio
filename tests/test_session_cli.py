from __future__ import annotations

import json

from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.models import load_project
from podcast_mcp.services.session_sync.viewer import publish_agent_play

runner = CliRunner()


def test_session_cli_status_seek_stop(minimal_project) -> None:
    empty = runner.invoke(app, ["session", "status", "--project", str(minimal_project)])
    assert empty.exit_code == 0
    assert json.loads(empty.stdout)["available"] is False

    seek = runner.invoke(
        app,
        [
            "session",
            "seek",
            "--project",
            str(minimal_project),
            "--playhead",
            "3.5",
        ],
    )
    assert seek.exit_code == 0
    assert json.loads(seek.stdout)["playhead_sec"] == 3.5

    mode = runner.invoke(app, ["session", "mode", "mix", "--project", str(minimal_project)])
    assert mode.exit_code == 0
    assert json.loads(mode.stdout)["audition_mode"] == "mix"

    bad_mode = runner.invoke(app, ["session", "mode", "nope", "--project", str(minimal_project)])
    assert bad_mode.exit_code == 1

    region = runner.invoke(
        app,
        [
            "session",
            "region",
            "--project",
            str(minimal_project),
            "--start",
            "1",
            "--end",
            "2",
            "--playing",
        ],
    )
    assert region.exit_code == 0
    assert json.loads(region.stdout)["is_playing"] is True

    play = runner.invoke(
        app,
        ["session", "play", "--project", str(minimal_project), "--pause"],
    )
    assert play.exit_code == 0
    assert json.loads(play.stdout)["is_playing"] is False

    stop = runner.invoke(app, ["session", "stop", "--project", str(minimal_project)])
    assert stop.exit_code == 0
    assert json.loads(stop.stdout)["region"] is None

    status = runner.invoke(app, ["session", "status", "--project", str(minimal_project)])
    assert status.exit_code == 0
    assert "playhead_sec" in json.loads(status.stdout)


def test_session_cli_region_invalid(minimal_project) -> None:
    proj = load_project(minimal_project)
    publish_agent_play(
        proj,
        timeline_start_sec=0.0,
        timeline_end_sec=1.0,
        source="premix",
        tier="premix",
        dry_run=True,
    )
    bad = runner.invoke(
        app,
        [
            "session",
            "region",
            "--project",
            str(minimal_project),
            "--start",
            "5",
            "--end",
            "5",
        ],
    )
    assert bad.exit_code == 1
