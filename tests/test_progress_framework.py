from __future__ import annotations

import asyncio
import json
import sys
from io import StringIO

import pytest

from podcast_mcp.util.progress import (
    CancelledProgress,
    JsonProgressReporter,
    McpNotificationProgress,
    MultiProgress,
    NullProgress,
    RecordingProgress,
    bind_progress,
    clear_compliance_log,
    clear_wrapped_ids,
    current_progress,
    current_progress_task_id,
    drain_compliance_log,
    install_cli_progress,
    install_guest_tool_progress,
    install_mcp_progress,
    mark_wrapped,
    progress_task,
    resolve_progress,
    wrapped_ids,
)
from podcast_mcp.util.progress_install import install_all_progress_adapters


@pytest.fixture(autouse=True)
def _clean_progress_state():
    from podcast_mcp.cli import context as cli_context
    from podcast_mcp.util import progress as progress_mod

    clear_wrapped_ids()
    clear_compliance_log()
    progress_mod.clear_progress_sinks()
    cli_context.reset_progress()
    progress_mod._reporter_var.set(None)
    progress_mod._compliance_var.set(None)
    yield
    clear_wrapped_ids()
    clear_compliance_log()
    progress_mod.clear_progress_sinks()
    cli_context.reset_progress()
    progress_mod._reporter_var.set(None)
    progress_mod._compliance_var.set(None)


def test_progress_task_emits_phases_and_marks_wrapped():
    rec = RecordingProgress()
    with bind_progress(rec):
        with progress_task("align", "Aligning", total=2, reporter=rec) as p:
            p.set_phase("search_bleed", "Scoring bleed…")
            p.advance(1, message="clip 1")
            with p.child("refine", "Refinement") as child:
                child.set_phase("pass_2", "Pass 2 of 2")
    kinds = [e.kind for e in rec.events]
    assert kinds[0] == "start"
    assert "message" in kinds
    assert "update" in kinds
    assert kinds[-1] == "end"
    assert "align" in wrapped_ids()
    records = drain_compliance_log()
    assert any(r.task_id == "align" and r.rich for r in records)


def test_progress_task_fail_on_exception():
    rec = RecordingProgress()
    with bind_progress(rec):
        with pytest.raises(RuntimeError, match="boom"):
            with progress_task("job", "Job", reporter=rec) as p:
                p.set_phase("work", "Working…")
                raise RuntimeError("boom")
    assert any(e.kind == "fail" for e in rec.events)
    assert any(e.phase == "work" for e in rec.events if e.kind == "fail")
    assert any(e.message and "boom" in e.message for e in rec.events if e.kind == "fail")


def test_progress_task_cancel():
    rec = RecordingProgress()
    with bind_progress(rec):
        with pytest.raises(CancelledProgress):
            with progress_task("job", "Job", reporter=rec) as p:
                p.cancel("stop now")
                raise CancelledProgress("stop now")
    kinds = [e.kind for e in rec.events]
    assert kinds.count("cancel") == 1
    assert "fail" not in kinds


def test_progress_task_cancel_then_runtime_error_does_not_fail():
    """Pipeline cancel used to raise RuntimeError after cancel(); must not emit fail."""
    rec = RecordingProgress()
    with bind_progress(rec):
        with pytest.raises(RuntimeError, match="Pipeline cancelled"):
            with progress_task("pipeline", "Pipeline", reporter=rec) as pipe:
                pipe.cancel("Pipeline cancelled")
                raise RuntimeError("Pipeline cancelled")
    kinds = [e.kind for e in rec.events]
    assert "cancel" in kinds
    assert "fail" not in kinds


def test_resolve_progress_uses_contextvar():
    rec = RecordingProgress()
    assert isinstance(resolve_progress(None), NullProgress)
    with bind_progress(rec):
        assert resolve_progress(None) is rec
        assert current_progress() is rec
    outer = RecordingProgress()
    assert resolve_progress(outer) is outer


def test_multi_progress_fans_out():
    a = RecordingProgress()
    b = RecordingProgress()
    multi = MultiProgress(a, b)
    multi.start("t", "Task", total=1)
    multi.message("t", "hi", phase="p1")
    multi.end("t")
    assert len(a.events) == len(b.events) == 3


def test_json_progress_includes_phase_and_fail():
    buf = StringIO()
    reporter = JsonProgressReporter(stream=buf)
    reporter.start("t", "Task", total=3)
    reporter.message("t", "Phase A", phase="a")
    reporter.fail("t", message="died", phase="a")
    lines = [json.loads(line) for line in buf.getvalue().strip().splitlines()]
    assert lines[1]["phase"] == "a"
    assert lines[-1]["kind"] == "fail"
    reporter.close()


def test_mark_wrapped_registry():
    mark_wrapped("pipeline_run")
    assert "pipeline_run" in wrapped_ids()


def test_current_progress_task_id_tracks_active_task():
    rec = RecordingProgress()
    assert current_progress_task_id() is None
    with bind_progress(rec), progress_task("op", "Op", reporter=rec):
        assert current_progress_task_id() == "op"
    assert current_progress_task_id() is None


def test_multi_progress_fail_and_cancel():
    a = RecordingProgress()
    b = RecordingProgress()
    multi = MultiProgress(a, b)
    multi.start("t", "Task")
    multi.fail("t", message="nope", phase="x")
    multi.cancel("t", message="stop")
    assert any(e.kind == "fail" for e in a.events)
    assert any(e.kind == "cancel" for e in b.events)


def test_compliance_log_is_capped():
    from podcast_mcp.util import progress as progress_mod

    old_max = progress_mod._COMPLIANCE_LOG_MAX
    progress_mod._COMPLIANCE_LOG_MAX = 3
    try:
        rec = RecordingProgress()
        for i in range(5):
            with progress_task(f"t{i}", f"T{i}", reporter=rec):
                pass
        records = drain_compliance_log()
        assert len(records) <= 3
    finally:
        progress_mod._COMPLIANCE_LOG_MAX = old_max
        clear_compliance_log()


def test_mcp_notification_progress_no_loop_is_noop():
    class Ctx:
        async def report_progress(self, progress, total, message):
            return None

    reporter = McpNotificationProgress(Ctx())
    reporter.start("t", "Task", total=2)
    reporter.update("t", 1, message="mid")
    reporter.message("t", "hi")
    reporter.end("t")
    reporter.fail("t", message="x")
    reporter.cancel("t")


@pytest.mark.asyncio
async def test_mcp_notification_progress_schedules_and_cancels_prior():
    calls: list[tuple] = []

    class Ctx:
        async def report_progress(self, progress, total, message):
            calls.append((progress, total, message))

    reporter = McpNotificationProgress(Ctx())
    reporter.start("t", "Task", total=2)
    reporter.update("t", 1, message="a")
    reporter.update("t", 2, message="b")
    reporter.end("t", message="done")
    # Let scheduled tasks run

    await asyncio.sleep(0)
    assert calls
    assert calls[-1][2] == "done"


@pytest.mark.asyncio
async def test_install_mcp_progress_wraps_add_and_call_tool():
    class FakeServer:
        def __init__(self) -> None:
            self.tools: list[str] = []

        def add_tool(self, fn, name=None, **kwargs):
            self.tools.append(name or fn.__name__)

        async def call_tool(self, name, arguments, context=None, *args, **kwargs):
            return {"ok": name, "bound": type(current_progress()).__name__}

    server = FakeServer()
    install_mcp_progress(server)
    install_mcp_progress(server)  # idempotent

    def sample_tool():
        return None

    server.add_tool(sample_tool, name="sample_tool")
    assert "sample_tool" in wrapped_ids()

    result = await server.call_tool("sample_tool", {})
    assert result["ok"] == "sample_tool"


def test_install_cli_progress_wraps_callbacks():
    class Cmd:
        def __init__(self, name, callback):
            self.name = name
            self.callback = callback

    class Group:
        def __init__(self, name, typer_instance):
            self.name = name
            self.typer_instance = typer_instance

    class App:
        def __init__(self):
            self.registered_commands = []
            self.registered_groups = []

    seen: list[str] = []

    def cb():
        seen.append(current_progress_task_id() or "")
        return "done"

    app = App()
    app.registered_commands.append(Cmd("hello", cb))
    inner = App()
    inner.registered_commands.append(Cmd("sub", cb))
    app.registered_groups.append(Group("grp", inner))
    install_cli_progress(app)
    assert app.registered_commands[0].callback() == "done"
    assert seen[0] == "hello"
    assert inner.registered_commands[0].callback() == "done"
    assert seen[1] == "grp.sub"


def test_install_guest_tool_progress_binds_reporter():
    seen: list[str] = []

    def impl(name, arguments=None):
        seen.append(type(current_progress()).__name__)
        return {"name": name, "args": arguments}

    wrapped = install_guest_tool_progress(impl)
    out = wrapped("guest_get_project", {"x": 1})
    assert out["name"] == "guest_get_project"
    assert seen == ["NullProgress"]
    assert "guest_get_project" in wrapped_ids()


def test_install_all_progress_adapters():
    class FakeServer:
        def add_tool(self, fn, name=None, **kwargs):
            return None

        async def call_tool(self, name, arguments, context=None, *args, **kwargs):
            return None

    class App:
        def __init__(self) -> None:
            self.registered_commands = []
            self.registered_groups = []

    mcp = FakeServer()
    app = App()
    install_all_progress_adapters(mcp=mcp, cli_app=app)
    assert getattr(mcp, "_podcast_progress_installed", False)
    install_all_progress_adapters()  # no-op both None
    install_all_progress_adapters(mcp=None, cli_app=app)


def test_wrap_operation_decorator():
    from podcast_mcp.util.progress import wrap_operation

    rec = RecordingProgress()

    @wrap_operation("decorated_op", "Decorated")
    def work():
        return current_progress_task_id()

    with bind_progress(rec):
        assert work() == "decorated_op"
    assert "decorated_op" in wrapped_ids()


def test_progress_task_explicit_fail_and_message():
    rec = RecordingProgress()
    with progress_task("job", "Job", reporter=rec) as p:
        p.message("hello")
        p.fail("gave up", phase="mid")
    assert any(e.kind == "fail" and e.message == "gave up" for e in rec.events)


def test_progress_task_cancelled_progress_without_prior_cancel():
    rec = RecordingProgress()
    with bind_progress(rec):
        with pytest.raises(CancelledProgress):
            with progress_task("job", "Job", reporter=rec):
                raise CancelledProgress("user abort")
    assert any(e.kind == "cancel" for e in rec.events)
    assert "fail" not in {e.kind for e in rec.events}


def test_json_progress_cancel_and_fail_unknown_task():
    buf = StringIO()
    reporter = JsonProgressReporter(stream=buf)
    reporter.fail("missing", message="nope")
    reporter.cancel("missing", message="stop")
    reporter.start("t", "Task")
    reporter.cancel("t", message="bye")
    reporter.close()
    kinds = [json.loads(line)["kind"] for line in buf.getvalue().strip().splitlines()]
    assert "cancel" in kinds


def test_cli_progress_fail_and_cancel(capsys):
    from podcast_mcp.util.progress import CliProgressReporter

    reporter = CliProgressReporter(enabled=True)
    reporter.start("t", "Task", total=2)
    reporter.update("t", 1, message="mid", phase="p")
    reporter.fail("t", message="boom", phase="p")
    reporter.start("u", "Other")
    reporter.cancel("u", message="nope")
    reporter.fail("gone")
    reporter.cancel("gone")
    reporter.close()
    err = capsys.readouterr().err
    assert "boom" in err or "failed" in err or "nope" in err or "cancelled" in err


@pytest.mark.asyncio
async def test_install_mcp_progress_with_context_uses_notification_reporter():
    class Meta:
        progressToken = "tok-1"

    class Ctx:
        def __init__(self) -> None:
            self.calls: list[tuple] = []
            self.meta = Meta()

        async def report_progress(self, progress, total, message):
            self.calls.append((progress, total, message))

    class FakeServer:
        def add_tool(self, fn, name=None, **kwargs):
            return None

        async def call_tool(self, name, arguments, context=None, *args, **kwargs):
            return {"ctx": context is not None}

    server = FakeServer()
    # Fresh install attribute
    install_mcp_progress(server)
    ctx = Ctx()
    result = await server.call_tool("t", {}, context=ctx)
    assert result["ctx"] is True

    await asyncio.sleep(0)
    assert ctx.calls


@pytest.mark.asyncio
async def test_install_mcp_progress_skips_notifications_without_token():
    class Ctx:
        def __init__(self) -> None:
            self.calls: list[tuple] = []

        async def report_progress(self, progress, total, message):
            self.calls.append((progress, total, message))

    class FakeServer:
        def add_tool(self, fn, name=None, **kwargs):
            return None

        async def call_tool(self, name, arguments, context=None, *args, **kwargs):
            from podcast_mcp.util.progress import NullProgress, current_progress

            return {"null": isinstance(current_progress(), NullProgress)}

    server = FakeServer()
    install_mcp_progress(server)
    ctx = Ctx()
    result = await server.call_tool("t", {}, context=ctx)
    await asyncio.sleep(0)
    assert result["null"] is True
    assert ctx.calls == []


def test_default_progress_enabled_env(monkeypatch):
    from podcast_mcp.util.progress import default_progress_enabled

    monkeypatch.delenv("PODCAST_PROGRESS", raising=False)
    assert default_progress_enabled() is True
    monkeypatch.setenv("PODCAST_PROGRESS", "0")
    assert default_progress_enabled() is False
    monkeypatch.setenv("PODCAST_PROGRESS", "false")
    assert default_progress_enabled() is False


def test_multi_progress_update():
    a = RecordingProgress()
    b = RecordingProgress()
    multi = MultiProgress(a, b)
    multi.start("t", "Task", total=2)
    multi.update("t", 1, total=2, message="mid", phase="p")
    assert any(e.kind == "update" for e in a.events)
    assert any(e.kind == "update" for e in b.events)


def test_mcp_notification_progress_skips_without_report_progress():
    reporter = McpNotificationProgress(object())
    reporter.start("t", "Task")
    reporter.update("t", 1, total=3)
    reporter._schedule(1.0, 3.0, "x")  # no running loop / no report_progress


def test_install_cli_progress_skips_null_callback_and_double_wrap():
    class Cmd:
        def __init__(self, name, callback):
            self.name = name
            self.callback = callback

    class Group:
        def __init__(self, name, typer_instance):
            self.name = name
            self.typer_instance = typer_instance

    class App:
        def __init__(self):
            self.registered_commands = []
            self.registered_groups = []

    def cb():
        return "ok"

    app = App()
    app.registered_commands.append(Cmd("hello", cb))
    app.registered_commands.append(Cmd("noop", None))
    app.registered_groups.append(Group("empty", None))
    install_cli_progress(app)
    first = app.registered_commands[0].callback
    install_cli_progress(app)  # second pass should not re-wrap
    assert app.registered_commands[0].callback is first
    assert first() == "ok"


def test_cli_progress_message_and_end(capsys):
    from podcast_mcp.util.progress import CliProgressReporter

    reporter = CliProgressReporter(enabled=True)
    reporter.start("t", "Task", total=None)
    reporter.message("t", "phase headline", phase="p1")
    reporter.end("t", message="all done")
    reporter.close()
    err = capsys.readouterr().err
    assert "phase headline" in err or "all done" in err or "Task" in err


def test_progress_task_advance_without_message():
    rec = RecordingProgress()
    with progress_task("job", "Job", total=3, reporter=rec) as p:
        p.advance(1)
        p.advance(1, total=4)
    assert any(e.kind == "update" for e in rec.events)


def test_cli_progress_rich_fail_cancel(monkeypatch):
    from podcast_mcp.util.progress import CliProgressReporter

    monkeypatch.setattr(sys.stderr, "isatty", lambda: True)
    reporter = CliProgressReporter(enabled=True)
    reporter.start("t", "Task", total=3)
    reporter.update("t", 1)
    reporter.message("t", "heading", phase="p")
    reporter.fail("t", message="rich-fail")
    reporter.start("u", "Other", total=2)
    reporter.cancel("u", message="rich-cancel")
    # Heartbeat path with total set
    reporter.start("v", "HB", total=5)
    reporter._emit_heartbeat("v", reporter._tasks["v"], 12.0)
    reporter.close()
    assert True


def test_current_progress_task_and_resolve_prefer_parent():
    from podcast_mcp.util.progress import (
        RecordingProgress,
        bind_progress,
        current_progress_task,
        progress_task,
        resolve_progress_task,
    )

    rec = RecordingProgress()
    with bind_progress(rec), progress_task("parent", "Parent", total=2, reporter=rec) as parent:
        assert current_progress_task() is parent
        with resolve_progress_task(
            "child-id",
            "Child",
            total=5,
            prefer_parent=True,
        ) as task:
            assert task is parent
            assert parent.total == 2  # already had total; prefer_parent does not overwrite
            task.set_phase("work", "Working…")
            task.advance(1, message="unit 1", total=99)
            assert parent.total == 2  # borrowed parent ignores advance(..., total=)
        with resolve_progress_task("nested", "Nested", total=3) as child:
            assert child is not parent
            assert child.task_id == "nested"
            child.advance(1)
    kinds = [e.kind for e in rec.events]
    assert "start" in kinds and "end" in kinds
    assert any(e.phase == "work" for e in rec.events)
    assert any(e.task_id == "nested" for e in rec.events)


def test_resolve_progress_task_prefer_parent_sets_total_when_unset():
    from podcast_mcp.util.progress import (
        RecordingProgress,
        bind_progress,
        progress_task,
        resolve_progress_task,
    )

    rec = RecordingProgress()
    with bind_progress(rec), progress_task("parent", "Parent", reporter=rec) as parent:
        assert parent.total is None
        with resolve_progress_task(
            "ignored",
            "Ignored",
            total=4,
            prefer_parent=True,
        ) as task:
            assert task is parent
            assert parent.total == 4
            task.advance(1, message="u1")
    assert any(e.kind == "update" and e.total == 4 for e in rec.events)


def test_nested_child_does_not_inflate_parent_total():
    from podcast_mcp.util.progress import (
        RecordingProgress,
        bind_progress,
        progress_task,
        resolve_progress_task,
    )

    rec = RecordingProgress()
    with bind_progress(rec), progress_task("wrap", "Wrap", total=3, reporter=rec) as wrap:
        with resolve_progress_task(
            "precorrect",
            "Precorrect",
            total=3,
            prefer_parent=True,
        ) as orch:
            assert orch is wrap
            with resolve_progress_task("audibility", "Words", total=100) as child:
                assert child is not wrap
                assert child.task_id == "audibility"
                child.advance(50, total=100)
                child.advance_to(100)
                child.advance_to(100)  # already at 100 — no-op
                assert child.current == 100
                assert child.total == 100
            wrap.advance(1)
        assert wrap.total == 3
        assert wrap.current == 1


def test_resolve_progress_task_binds_explicit_reporter():
    from podcast_mcp.util.progress import RecordingProgress, resolve_progress_task

    rec = RecordingProgress()
    with resolve_progress_task(
        "standalone",
        "Standalone",
        total=2,
        progress=rec,
    ) as task:
        task.advance_to(2, message="done")
        assert task.current == 2
    kinds = [e.kind for e in rec.events]
    assert kinds[0] == "start"
    assert kinds[-1] == "end"


def test_progress_task_reset_tokens_is_idempotent():
    from podcast_mcp.util.progress import RecordingProgress, progress_task

    rec = RecordingProgress()
    with progress_task("t", "T", reporter=rec) as p:
        p._reset_tokens()
        p._reset_tokens()  # tokens already None — cover False branches
    assert any(e.kind == "start" for e in rec.events)


def test_json_progress_contract_omits_unknown_total(capsys):
    """Machine channel: total omitted when unknown; stdout stays clean."""
    from io import StringIO

    from podcast_mcp.util.progress import JsonProgressReporter, bind_progress, progress_task

    buf = StringIO()
    reporter = JsonProgressReporter(stream=buf)
    with bind_progress(reporter), progress_task("job", "Long job", reporter=reporter) as p:
        p.set_phase("align", "Scoring bleed…")
        p.advance(1)  # no total
    lines = [json.loads(line) for line in buf.getvalue().strip().splitlines()]
    assert lines[0]["kind"] == "start"
    assert lines[0]["total"] is None
    assert any(e.get("phase") == "align" for e in lines)
    assert all("elapsed_sec" in e for e in lines)
    # No fake percent: updates without total must not invent one
    updates = [e for e in lines if e["kind"] == "update"]
    assert updates
    assert all(e["total"] is None for e in updates)
    assert capsys.readouterr().out == ""


def test_json_progress_never_leaks_to_stdout(capsys):
    from podcast_mcp.cli.context import configure, reset_progress
    from podcast_mcp.util.progress import progress_task

    configure(progress=True, json_progress=True)
    try:
        with progress_task("op", "Op", total=2) as p:
            p.set_phase("a", "Phase A")
            p.advance(1, message="one")
        out = capsys.readouterr()
        assert out.out == ""
        events = [json.loads(line) for line in out.err.splitlines() if line.strip()]
        assert events
        assert all("kind" in e and "task_id" in e and "elapsed_sec" in e for e in events)
        assert any(e.get("message") == "Phase A" or e.get("phase") == "a" for e in events)
    finally:
        reset_progress()


def test_progress_disabled_is_null_consumer(monkeypatch):
    from podcast_mcp.util.progress import (
        NullProgress,
        default_progress_enabled,
        make_progress_reporter,
    )

    monkeypatch.setenv("PODCAST_PROGRESS", "0")
    assert default_progress_enabled() is False
    assert isinstance(make_progress_reporter(enabled=False), NullProgress)
    assert isinstance(
        make_progress_reporter(enabled=default_progress_enabled()),
        NullProgress,
    )


def test_compose_progress_zero_sinks_is_null():
    from podcast_mcp.util.progress import NullProgress, compose_progress

    assert isinstance(compose_progress(), NullProgress)
    assert isinstance(compose_progress(None, NullProgress()), NullProgress)


def test_compose_progress_fans_to_live_sinks():
    from podcast_mcp.util.progress import RecordingProgress, compose_progress

    a = RecordingProgress()
    b = RecordingProgress()
    multi = compose_progress(a, b)
    multi.start("t", "Task", total=2)
    multi.update("t", 1, total=2, message="mid")
    assert any(e.kind == "start" for e in a.events)
    assert any(e.kind == "update" for e in b.events)


def test_cli_progress_sink_skips_non_tty(monkeypatch):
    from podcast_mcp.util.progress import cli_progress_sink

    monkeypatch.setattr(sys.stderr, "isatty", lambda: False)
    assert cli_progress_sink(enabled=True, json_mode=False) is None
    assert cli_progress_sink(enabled=True, json_mode=True) is not None


def test_registered_progress_sink_composes():
    from podcast_mcp.util.progress import (
        RecordingProgress,
        adapter_progress_sinks,
        compose_progress,
        register_progress_sink,
    )

    rec = RecordingProgress()
    register_progress_sink(lambda: rec)
    multi = compose_progress(*adapter_progress_sinks())
    multi.start("t", "T", total=1)
    assert any(e.kind == "start" for e in rec.events)
