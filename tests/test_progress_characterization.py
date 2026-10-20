"""Golden event order for one scripted task tree across every sink.

The scenario drives the public task API only, so the same file pins the behaviour before and
after util/progress becomes a package.
"""

from __future__ import annotations

import asyncio
import json
import sys
from io import StringIO
from typing import Any

import pytest

from podcast_mcp.util.progress import (
    CancelledProgress,
    CliProgressReporter,
    JsonProgressReporter,
    McpNotificationProgress,
    MultiProgress,
    NullProgress,
    RecordingProgress,
    bind_progress,
    compose_progress,
    progress_task,
)


def _success_tree() -> None:
    with progress_task("op", "Operation", total=3) as task:
        task.set_phase("scan", "Scanning")
        task.advance(1, message="one")
        task.advance(2)
        with task.child("sub", "Sub", total=2) as child:
            child.message("child note")
            child.advance(2)


def _failure_tree() -> None:
    with pytest.raises(RuntimeError), progress_task("op", "Operation") as task:
        task.set_phase("scan", "Scanning")
        raise RuntimeError("boom")


def _cancel_tree() -> None:
    with pytest.raises(CancelledProgress), progress_task("op", "Operation"):
        raise CancelledProgress("stop now")


SUCCESS_EVENTS = [
    ("start", "op", "Operation", 0, 3, None, None),
    ("message", "op", "op", None, None, "Scanning", "scan"),
    ("update", "op", "op", 1, 3, "one", "scan"),
    ("update", "op", "op", 3, 3, None, "scan"),
    ("start", "sub", "Sub", 0, 2, None, None),
    ("message", "sub", "sub", None, None, "child note", None),
    ("update", "sub", "sub", 2, 2, None, None),
    ("end", "sub", "sub", None, None, None, None),
    ("end", "op", "op", None, None, None, None),
]
FAILURE_EVENTS = [
    ("start", "op", "Operation", 0, None, None, None),
    ("message", "op", "op", None, None, "Scanning", "scan"),
    ("fail", "op", "op", None, None, "Operation failed while scan: boom", "scan"),
]
CANCEL_EVENTS = [
    ("start", "op", "Operation", 0, None, None, None),
    ("cancel", "op", "op", None, None, "stop now", None),
]


def _rows(rec: RecordingProgress) -> list[tuple[Any, ...]]:
    return [
        (e.kind, e.task_id, e.label, e.current, e.total, e.message, e.phase) for e in rec.events
    ]


@pytest.mark.parametrize(
    ("scenario", "expected"),
    [
        (_success_tree, SUCCESS_EVENTS),
        (_failure_tree, FAILURE_EVENTS),
        (_cancel_tree, CANCEL_EVENTS),
    ],
)
def test_recording_sink_event_order(scenario, expected) -> None:
    rec = RecordingProgress()
    with bind_progress(rec):
        scenario()
    assert _rows(rec) == expected


def test_multi_fan_out_delivers_same_events_in_same_order_to_every_sink() -> None:
    first, second = RecordingProgress(), RecordingProgress()
    with bind_progress(MultiProgress(first, second)):
        _success_tree()
    assert _rows(first) == SUCCESS_EVENTS
    assert _rows(second) == SUCCESS_EVENTS


def test_recording_forwards_to_inner_sink() -> None:
    inner = RecordingProgress()
    with bind_progress(RecordingProgress(inner)):
        _success_tree()
    assert _rows(inner) == SUCCESS_EVENTS


def test_compose_drops_null_sinks_and_wraps_many() -> None:
    rec = RecordingProgress()
    assert isinstance(compose_progress(None, NullProgress()), NullProgress)
    assert compose_progress(None, rec) is rec
    assert isinstance(compose_progress(rec, RecordingProgress()), MultiProgress)


def _json_lines(buf: StringIO) -> list[dict[str, Any]]:
    out = []
    for line in buf.getvalue().splitlines():
        row = json.loads(line)
        assert isinstance(row.pop("elapsed_sec"), float)
        out.append(row)
    return out


def _json_row(kind, task_id, label, current, total, message, phase) -> dict[str, Any]:
    return {
        "kind": kind,
        "task_id": task_id,
        "label": label,
        "current": current,
        "total": total,
        "message": message,
        "phase": phase,
    }


def test_json_sink_success_order() -> None:
    buf = StringIO()
    reporter = JsonProgressReporter(stream=buf)
    with bind_progress(reporter):
        _success_tree()
    reporter.close()
    assert _json_lines(buf) == [
        _json_row("start", "op", "Operation", 0, 3, None, None),
        _json_row("message", "op", "Operation", 0, 3, "Scanning", "scan"),
        _json_row("update", "op", "Operation", 1, 3, "one", "scan"),
        _json_row("update", "op", "Operation", 3, 3, None, "scan"),
        _json_row("start", "sub", "Sub", 0, 2, None, None),
        _json_row("message", "sub", "Sub", 0, 2, "child note", None),
        _json_row("update", "sub", "Sub", 2, 2, None, None),
        _json_row("end", "sub", "Sub", 2, 2, None, None),
        _json_row("end", "op", "Operation", 3, 3, None, "scan"),
    ]


def test_json_sink_failure_and_cancel() -> None:
    buf = StringIO()
    reporter = JsonProgressReporter(stream=buf)
    with bind_progress(reporter):
        _failure_tree()
        _cancel_tree()
    reporter.close()
    assert _json_lines(buf) == [
        _json_row("start", "op", "Operation", 0, None, None, None),
        _json_row("message", "op", "Operation", 0, None, "Scanning", "scan"),
        _json_row("fail", "op", "Operation", 0, None, "Operation failed while scan: boom", "scan"),
        _json_row("start", "op", "Operation", 0, None, None, None),
        _json_row("cancel", "op", "Operation", 0, None, "stop now", None),
    ]


def test_cli_plain_sink_lines(monkeypatch, capsys) -> None:
    monkeypatch.setattr(sys.stderr, "isatty", lambda: False)
    reporter = CliProgressReporter(enabled=True)
    with bind_progress(reporter):
        _success_tree()
        _failure_tree()
        _cancel_tree()
    reporter.close()
    assert capsys.readouterr().err == (
        "Operation…\n"
        "Scanning\n"
        "Sub…\n"
        "child note\n"
        "Finished Sub (0:00)\n"
        "Finished Operation (0:00)\n"
        "Operation…\n"
        "Scanning\n"
        "Operation failed while scan: boom\n"
        "Operation…\n"
        "stop now\n"
    )


def test_cli_disabled_sink_is_silent(monkeypatch, capsys) -> None:
    monkeypatch.setattr(sys.stderr, "isatty", lambda: False)
    reporter = CliProgressReporter(enabled=False)
    with bind_progress(reporter):
        _success_tree()
    reporter.close()
    assert capsys.readouterr().err == ""


async def _settle() -> None:
    others = asyncio.all_tasks() - {asyncio.current_task()}
    await asyncio.gather(*others, return_exceptions=True)


class _Context:
    def __init__(self) -> None:
        self.calls: list[tuple[float, float | None, str | None]] = []

    async def report_progress(
        self, progress: float, total: float | None = None, message: str | None = None
    ) -> None:
        self.calls.append((progress, total, message))


def test_mcp_sink_notification_sequence() -> None:
    async def run() -> list[tuple[float, float | None, str | None]]:
        ctx = _Context()
        sink = McpNotificationProgress(ctx)
        sink.start("op", "Operation", 4)
        await _settle()
        sink.update("op", 1)
        await _settle()
        sink.update("op", 2, total=5, message="two")
        await _settle()
        sink.message("op", "note")
        await _settle()
        sink.end("op")
        await _settle()
        sink.start("op", "Again")
        await _settle()
        sink.fail("op", message="bad")
        await _settle()
        sink.end("op")
        await _settle()
        sink.cancel("op")
        await _settle()
        return ctx.calls

    assert asyncio.run(run()) == [
        (0.0, 4.0, "Operation"),
        (1.0, 4.0, "Operation"),
        (2.0, 5.0, "two"),
        (2.0, 5.0, "note"),
        (5.0, 5.0, "done"),
        (0.0, None, "Again"),
        (0.0, None, "bad"),
        (0.0, None, "cancelled"),
    ]


def test_mcp_sink_newest_notification_replaces_unsent_one() -> None:
    async def run() -> list[tuple[float, float | None, str | None]]:
        ctx = _Context()
        sink = McpNotificationProgress(ctx)
        sink.start("op", "Operation", 4)
        sink.update("op", 1)
        sink.update("op", 3, message="three")
        await _settle()
        return ctx.calls

    assert asyncio.run(run()) == [(3.0, 4.0, "three")]


def test_mcp_sink_without_running_loop_is_silent() -> None:
    ctx = _Context()
    McpNotificationProgress(ctx).start("op", "Operation", 1)
    assert ctx.calls == []
