from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.util.progress import (
    CancelledProgress,
    RecordingProgress,
    clear_progress_sinks,
    register_progress_sink,
)


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
        events = [json.loads(line) for line in result.stderr.splitlines() if line.startswith("{")]
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
    assert result.stdout == (
        '{\n  "wav": "/tmp/clip.wav",\n  "source": "premix",\n  "tier": "premix",\n'
        '  "render_busy": false,\n  "start_sec": 1.0,\n  "end_sec": 2.0,\n  "player": null\n}\n'
    )
    assert json.loads(result.stdout) == {
        "wav": "/tmp/clip.wav",
        "source": "premix",
        "tier": "premix",
        "render_busy": False,
        "start_sec": 1.0,
        "end_sec": 2.0,
        "player": None,
    }

    events = [json.loads(line) for line in result.stderr.splitlines() if line.startswith("{")]
    assert [(e["kind"], e["task_id"], e["label"]) for e in events] == [
        ("start", "play", "podcast play"),
        ("end", "play", "podcast play"),
    ]


@pytest.mark.parametrize(
    ("exception", "terminal", "message"),
    [
        (RuntimeError("boom"), "fail", "podcast play failed: boom"),
        (CancelledProgress("stop now"), "cancel", "stop now"),
    ],
)
def test_default_play_preserves_typed_failure_and_cancel(
    minimal_project, monkeypatch, exception, terminal, message
):
    class Player:
        def __init__(self, ws):
            pass

        def play(self, request, *, dry_run, player):
            raise exception

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
        env={"PODCAST_DEBUG": "1"},
    )
    assert result.exit_code == 1
    assert result.exception is exception
    assert result.stdout == ""
    events = [json.loads(line) for line in result.stderr.splitlines() if line.startswith("{")]
    assert [(e["kind"], e["task_id"]) for e in events] == [("start", "play"), (terminal, "play")]
    assert events[-1]["message"] == message


def test_play_subcommand_has_one_scope(minimal_project, monkeypatch):
    class Player:
        def __init__(self, ws):
            pass

        def audition_context(self, start, end, *, skew_warn_sec, detail):
            assert (start, end, skew_warn_sec, detail) == (1.0, 2.0, 0.05, "summary")
            return {"captions": ["hello"]}

    monkeypatch.setattr("podcast_mcp.cli.play.PlayService", Player)
    result = CliRunner().invoke(
        app,
        [
            "--json-progress",
            "play",
            "context",
            "--project",
            str(minimal_project),
            "--start",
            "1",
            "--end",
            "2",
        ],
    )
    assert result.exit_code == 0
    assert result.stdout == '{\n  "captions": [\n    "hello"\n  ]\n}\n'
    events = [json.loads(line) for line in result.stderr.splitlines() if line.startswith("{")]
    assert [(e["kind"], e["task_id"]) for e in events] == [
        ("start", "play.context"),
        ("end", "play.context"),
    ]


@pytest.mark.parametrize("command", ["align", "play"])
def test_quiet_tty_keeps_live_sink(minimal_project, monkeypatch, command):
    from click.testing import _NamedTextIOWrapper

    class Service:
        def __init__(self, ws):
            pass

        def status(self):
            import sys

            monkeypatch.setattr(sys.stderr, "isatty", lambda: True)
            return {"ok": True, "answer": 7}

        def play(self, request, *, dry_run, player):
            import sys

            monkeypatch.setattr(sys.stderr, "isatty", lambda: True)
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

    monkeypatch.setattr("podcast_mcp.cli.align_cmd.AlignAcceptService", Service)
    monkeypatch.setattr("podcast_mcp.cli.play.PlayService", Service)
    monkeypatch.setattr(_NamedTextIOWrapper, "isatty", lambda self: True)
    rec = RecordingProgress()
    clear_progress_sinks()
    register_progress_sink(lambda: rec)
    args = (
        ["align", "status"]
        if command == "align"
        else ["play", "--start", "1", "--end", "2", "--dry-run"]
    )
    try:
        result = CliRunner().invoke(
            app, ["--no-progress", "--json-progress", *args, "--project", str(minimal_project)]
        )
    finally:
        clear_progress_sinks()
    assert result.exit_code == 0
    assert json.loads(result.stdout) == (
        {"ok": True, "answer": 7}
        if command == "align"
        else {
            "wav": "/tmp/clip.wav",
            "source": "premix",
            "tier": "premix",
            "render_busy": False,
            "start_sec": 1.0,
            "end_sec": 2.0,
            "player": None,
        }
    )
    assert result.stderr == ""
    task_id = "align.status" if command == "align" else "play"
    assert [(e.kind, e.task_id) for e in rec.events] == [("start", task_id), ("end", task_id)]
