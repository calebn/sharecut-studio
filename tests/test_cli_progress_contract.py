from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.util.progress import CancelledProgress


@pytest.mark.parametrize("flags", [[], ["--json-progress"], ["--no-progress", "--json-progress"]])
def test_registered_command_keeps_result_and_progress_modes(minimal_project, monkeypatch, flags):
    class StatusService:
        def __init__(self, ws):
            pass

        def status(self):
            return {"ok": True, "answer": 7}

    monkeypatch.setattr("podcast_mcp.cli.align_cmd.AlignAcceptService", StatusService)
    result = CliRunner().invoke(app, [*flags, "align", "status", "--project", str(minimal_project)])
    assert result.exit_code == 0
    assert result.stdout == '{\n  "ok": true,\n  "answer": 7\n}\n'
    if flags == ["--json-progress"]:
        events = [json.loads(line) for line in result.stderr.splitlines()]
        assert [
            (e["kind"], e["task_id"], e["label"]) for e in events if e["kind"] != "message"
        ] == [
            ("start", "align.status", "podcast align status"),
            ("end", "align.status", "podcast align status"),
        ]
        assert all(e["total"] is None and e["current"] == 0 for e in events)
        assert events[0]["elapsed_sec"] == 0.0
    else:
        assert result.stderr == ""


@pytest.mark.parametrize(
    ("exception", "terminal", "message"),
    [
        (RuntimeError("boom"), "fail", "podcast align status failed: boom"),
        (CancelledProgress("stop now"), "cancel", "stop now"),
    ],
)
def test_registered_command_keeps_failure_and_cancel(
    minimal_project, monkeypatch, exception, terminal, message
):
    class StatusService:
        def __init__(self, ws):
            pass

        def status(self):
            raise exception

    monkeypatch.setattr("podcast_mcp.cli.align_cmd.AlignAcceptService", StatusService)
    result = CliRunner().invoke(
        app, ["--json-progress", "align", "status", "--project", str(minimal_project)]
    )
    assert result.exit_code == 1
    if terminal == "cancel":
        assert result.exception is exception
    else:
        assert isinstance(result.exception, SystemExit)
        assert "boom" in result.stderr
    events = [json.loads(line) for line in result.stderr.splitlines() if line.startswith("{")]
    assert [e["kind"] for e in events if e["kind"] != "message"] == ["start", terminal]
    assert events[-1]["task_id"] == "align.status"
    assert events[-1]["message"] == message


def test_default_play_keeps_result(minimal_project, monkeypatch):
    class Player:
        def __init__(self, ws):
            pass

        def play(self, request, *, dry_run, player):
            assert request.start_sec == 1.0
            assert request.end_sec == 2.0
            assert dry_run is True
            return SimpleNamespace(
                wav_path=Path("/tmp/clip.wav"),
                source_label="premix",
                tier="premix",
                render_busy=False,
                start_sec=1.0,
                end_sec=2.0,
                player_cmd=None,
                compare_segments=None,
            )

    monkeypatch.setattr("podcast_mcp.cli.play.PlayService", Player)
    result = CliRunner().invoke(
        app,
        [
            "--json-progress",
            "play",
            "--project",
            str(minimal_project),
            "--start",
            "1",
            "--end",
            "2",
            "--dry-run",
        ],
    )
    assert result.exit_code == 0
    assert json.loads(result.stdout) == {
        "wav": "/tmp/clip.wav",
        "source": "premix",
        "tier": "premix",
        "render_busy": False,
        "start_sec": 1.0,
        "end_sec": 2.0,
        "player": None,
    }
