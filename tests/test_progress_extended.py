from __future__ import annotations

import json
from io import StringIO
from unittest.mock import MagicMock, patch

from podcast_mcp.util.progress import (
    CliProgressReporter,
    JsonProgressReporter,
    NullProgress,
    ProgressEvent,
    default_progress_enabled,
    make_progress_reporter,
)


def test_json_progress_message_and_heartbeat():
    buf = StringIO()
    reporter = JsonProgressReporter(stream=buf)
    reporter.start("task", "Working", total=10)
    reporter.message("task", "mid-flight")
    reporter._emit_heartbeat("task", reporter._tasks["task"], 12.0)  # type: ignore[attr-defined]
    reporter.end("task")
    kinds = [json.loads(line)["kind"] for line in buf.getvalue().strip().splitlines()]
    assert "message" in kinds
    assert "heartbeat" in kinds
    reporter.close()


def test_cli_progress_reporter_disabled():
    reporter = CliProgressReporter(enabled=False)
    reporter.start("t", "Label", total=5)
    reporter.update("t", 1)
    reporter.message("t", "note")
    # Exercise disabled heartbeat early-return
    from podcast_mcp.util.progress import _TaskState

    reporter._emit_heartbeat("t", _TaskState(label="Label", total=5), 1.0)
    reporter.end("t")
    reporter.close()


def test_cli_progress_reporter_non_tty_fallback():
    with patch("sys.stderr.isatty", return_value=False):
        reporter = CliProgressReporter(enabled=True)
    reporter.start("job", "Job", total=3)
    reporter.update("job", 2, message="half")
    reporter.end("job")
    reporter.close()


def test_make_progress_reporter_cli_default(monkeypatch):
    monkeypatch.setattr("sys.stderr.isatty", lambda: True)
    reporter = make_progress_reporter(enabled=True, json_mode=False)
    assert isinstance(reporter, CliProgressReporter)


def test_make_progress_reporter_piped_is_null(monkeypatch):
    monkeypatch.setattr("sys.stderr.isatty", lambda: False)
    reporter = make_progress_reporter(enabled=True, json_mode=False)
    assert isinstance(reporter, NullProgress)


def test_default_progress_enabled_env(monkeypatch):
    monkeypatch.setenv("PODCAST_PROGRESS", "0")
    assert default_progress_enabled() is False
    monkeypatch.setenv("PODCAST_PROGRESS", "false")
    assert default_progress_enabled() is False
    monkeypatch.setenv("PODCAST_PROGRESS", "no")
    assert default_progress_enabled() is False
    monkeypatch.delenv("PODCAST_PROGRESS", raising=False)
    assert default_progress_enabled() is True


def test_null_progress_all_methods():
    reporter = NullProgress()
    reporter.start("t", "Task", total=5)
    reporter.update("t", 1, message="x")
    reporter.message("t", "note")
    reporter.end("t", message="done")


def test_json_progress_unknown_task_is_noop():
    buf = StringIO()
    reporter = JsonProgressReporter(stream=buf)
    reporter.update("missing", 1)
    reporter.message("missing", "hi")
    reporter.end("missing")
    assert buf.getvalue() == ""
    reporter.close()


def test_json_progress_heartbeat_loop():
    import time

    buf = StringIO()
    reporter = JsonProgressReporter(stream=buf)
    reporter._heartbeat_sec = 0.0  # type: ignore[attr-defined]
    reporter.start("slow", "Slow task", total=1)
    with reporter._lock:
        reporter._tasks["slow"].last_emit = 0.0

    state = {"count": 0}

    def wait_short(_timeout: float) -> bool:
        state["count"] += 1
        if state["count"] >= 2:
            reporter._stop.set()
        time.sleep(0.02)
        return reporter._stop.is_set()

    reporter._stop.wait = wait_short  # type: ignore[method-assign]
    reporter._heartbeat_loop()
    kinds = [json.loads(line)["kind"] for line in buf.getvalue().strip().splitlines()]
    assert "heartbeat" in kinds
    reporter.end("slow")
    reporter.close()


class _RecordingFakeProgress:
    """Fake rich Progress that records add_task/update calls and ctor kwargs."""

    _bar_seq = 0

    def __init__(self, *args, **kwargs):
        self.ctor_kwargs = kwargs
        self.add_task_calls: list[dict] = []
        self.update_calls: list[tuple] = []
        self._bars: dict = {}

    def start(self):
        return None

    def stop(self):
        return None

    def add_task(self, label, total=0):
        type(self)._bar_seq += 1
        bar = type(self)._bar_seq
        self.add_task_calls.append({"label": label, "total": total})
        return bar

    def update(self, bar, **kwargs):
        self.update_calls.append((bar, kwargs))
        return None

    def remove_task(self, bar):
        return None


def _patched_rich_progress_module():
    return MagicMock(
        BarColumn=MagicMock(),
        Progress=_RecordingFakeProgress,
        SpinnerColumn=MagicMock(),
        TaskProgressColumn=MagicMock(),
        TextColumn=MagicMock(),
        TimeElapsedColumn=MagicMock(),
    )


def test_cli_progress_reporter_rich_mode(monkeypatch):
    fake_bar = object()
    fake_progress = MagicMock()
    fake_progress.add_task.return_value = fake_bar

    class FakeProgress:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            return None

        def stop(self):
            return None

        def add_task(self, label, total=0):
            return fake_bar

        def update(self, bar, **kwargs):
            return None

        def remove_task(self, bar):
            return None

    monkeypatch.setattr("sys.stderr.isatty", lambda: True)
    with patch.dict(
        "sys.modules",
        {
            "rich.progress": MagicMock(
                BarColumn=MagicMock(),
                Progress=FakeProgress,
                SpinnerColumn=MagicMock(),
                TaskProgressColumn=MagicMock(),
                TextColumn=MagicMock(),
                TimeElapsedColumn=MagicMock(),
            )
        },
    ):
        reporter = CliProgressReporter(enabled=True)
    reporter.start("rich", "Rich job", total=4)
    reporter.update("rich", 2, total=4, message="half")
    reporter.message("rich", "status line")
    reporter._emit_heartbeat("rich", reporter._tasks["rich"], 65.0)  # type: ignore[attr-defined]
    reporter.end("rich")
    reporter.close()


def test_cli_rich_indeterminate_row_pulses(monkeypatch):
    monkeypatch.setattr("sys.stderr.isatty", lambda: True)
    with patch.dict("sys.modules", {"rich.progress": _patched_rich_progress_module()}):
        reporter = CliProgressReporter(enabled=True)
    reporter.start("w", "Wrap")
    reporter.start("p", "Pipeline", total=4)
    fake = reporter._progress
    assert fake.add_task_calls[0] == {"label": "Wrap", "total": None}
    assert fake.add_task_calls[1] == {"label": "Pipeline", "total": 4}
    reporter.close()


def test_cli_rich_message_updates_row_not_stderr(monkeypatch, capsys):
    monkeypatch.setattr("sys.stderr.isatty", lambda: True)
    with patch.dict("sys.modules", {"rich.progress": _patched_rich_progress_module()}):
        reporter = CliProgressReporter(enabled=True)
    reporter.start("p", "Pipeline", total=4)
    fake = reporter._progress
    bar = fake.add_task_calls  # noqa: F841 - keep for clarity
    reporter.message("p", "Running align")
    assert fake.update_calls[-1][1] == {"description": "Running align"}
    assert capsys.readouterr().err == ""
    reporter.close()


def test_cli_rich_heartbeat_is_silent(monkeypatch, capsys):
    monkeypatch.setattr("sys.stderr.isatty", lambda: True)
    with patch.dict("sys.modules", {"rich.progress": _patched_rich_progress_module()}):
        reporter = CliProgressReporter(enabled=True)
    reporter.start("p", "Pipeline", total=4)
    reporter._emit_heartbeat("p", reporter._tasks["p"], 30.0)  # type: ignore[attr-defined]
    assert capsys.readouterr().err == ""
    reporter.close()


def test_cli_rich_renders_on_stderr(monkeypatch):
    monkeypatch.setattr("sys.stderr.isatty", lambda: True)
    with patch.dict("sys.modules", {"rich.progress": _patched_rich_progress_module()}):
        reporter = CliProgressReporter(enabled=True)
    console = reporter._progress.ctor_kwargs["console"]
    assert console.stderr is True
    reporter.close()


def test_json_message_without_phase_counts_as_activity():
    buf = StringIO()
    reporter = JsonProgressReporter(stream=buf)
    reporter.start("t", "T")
    reporter._tasks["t"].last_emit = 0.0  # type: ignore[attr-defined]
    reporter.message("t", "hi")
    assert reporter._tasks["t"].last_emit > 0  # type: ignore[attr-defined]
    reporter.end("t")
    reporter.close()


def test_cli_progress_reporter_import_error_fallback(monkeypatch):
    monkeypatch.setattr("sys.stderr.isatty", lambda: True)

    def broken_import(name, *args, **kwargs):
        raise ImportError("no rich")

    monkeypatch.setattr("builtins.__import__", broken_import)
    reporter = CliProgressReporter(enabled=True)
    assert reporter._progress is None
    reporter.start("plain", "Plain job", total=2)
    reporter.update("plain", 1)
    reporter.end("plain")
    reporter.close()


def test_cli_progress_heartbeat_with_total(monkeypatch):
    monkeypatch.setattr("sys.stderr.isatty", lambda: False)
    reporter = CliProgressReporter(enabled=True)
    reporter.start("job", "Job", total=4)
    reporter._emit_heartbeat("job", reporter._tasks["job"], 90.0)  # type: ignore[attr-defined]
    reporter.end("job")
    reporter.close()


def test_cli_progress_update_unknown_task():
    reporter = CliProgressReporter(enabled=True)
    reporter.update("missing", 1)
    reporter.close()


def test_make_progress_reporter_disabled_returns_null():
    reporter = make_progress_reporter(enabled=False)
    assert isinstance(reporter, NullProgress)


def test_progress_event_to_dict_without_message():
    event = ProgressEvent(
        kind="start",
        task_id="x",
        label="Label",
        current=0,
        total=None,
        elapsed_sec=0.123,
    )
    assert event.to_dict()["message"] is None
