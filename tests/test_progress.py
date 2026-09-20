from __future__ import annotations

import json
from io import StringIO

from podcast_mcp.util.progress import (
    JsonProgressReporter,
    NullProgress,
    ProgressEvent,
    make_progress_reporter,
)


def test_null_progress_no_op():
    p = NullProgress()
    p.start("t", "Task", total=10)
    p.update("t", 5)
    p.end("t")


def test_json_progress_emits_events():
    buf = StringIO()
    reporter = JsonProgressReporter(stream=buf)
    reporter.start("reconcile", "Reconciling", total=100)
    reporter.update("reconcile", 50, message="half")
    reporter.end("reconcile")
    lines = [json.loads(line) for line in buf.getvalue().strip().splitlines()]
    assert lines[0]["kind"] == "start"
    assert lines[1]["current"] == 50
    assert lines[-1]["kind"] == "end"


def test_progress_event_roundtrip():
    ev = ProgressEvent(
        kind="update",
        task_id="x",
        label="Test",
        current=1,
        total=2,
        elapsed_sec=1.5,
        message="ok",
    )
    data = ev.to_dict()
    assert data["task_id"] == "x"
    assert data["elapsed_sec"] == 1.5


def test_make_progress_reporter_disabled():
    assert isinstance(make_progress_reporter(enabled=False), NullProgress)


def test_make_progress_reporter_json():
    assert isinstance(make_progress_reporter(enabled=True, json_mode=True), JsonProgressReporter)
