from __future__ import annotations

import threading
from io import StringIO

import pytest

from podcast_mcp.util import progress as progress_mod
from podcast_mcp.util.progress import (
    CancelledProgress,
    JsonProgressReporter,
    RecordingProgress,
    bind_progress,
    clear_compliance_log,
    clear_wrapped_ids,
    progress_task,
)


@pytest.fixture(autouse=True)
def _clean_progress_state():
    from podcast_mcp.cli import context as cli_context

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


@pytest.fixture
def frozen_clock(monkeypatch):
    t = [0.0]
    monkeypatch.setattr(progress_mod, "_update_clock", lambda: t[0])
    return t


def _updates(rec: RecordingProgress) -> list[progress_mod.ProgressEvent]:
    return [e for e in rec.events if e.kind == "update"]


def test_burst_of_advances_collapses_to_first_and_final(frozen_clock):
    rec = RecordingProgress()
    with progress_task("audibility", "Audibility", total=500, reporter=rec) as p:
        for n in range(50, 501, 50):
            p.advance_to(n, total=500)
    currents = [e.current for e in _updates(rec)]
    assert currents == [50, 500]


def test_pending_update_flushes_before_end_with_latest_message(frozen_clock):
    rec = RecordingProgress()
    with progress_task("t", "T", reporter=rec) as p:
        for i in range(10):
            p.advance(1, message=f"m{i}")
    updates = _updates(rec)
    assert [(e.current, e.message) for e in updates] == [(1, "m0"), (10, "m9")]
    kinds_after_last_update = [e.kind for e in rec.events]
    last_update_idx = max(i for i, e in enumerate(rec.events) if e.kind == "update")
    assert kinds_after_last_update[last_update_idx + 1] == "end"


def test_interval_elapsed_emits_every_update(frozen_clock):
    rec = RecordingProgress()
    with progress_task("t", "T", reporter=rec) as p:
        for _i in range(5):
            frozen_clock[0] += 0.3
            p.advance(1)
    currents = [e.current for e in _updates(rec)]
    assert currents == [1, 2, 3, 4, 5]


def test_total_change_emits_immediately(frozen_clock):
    rec = RecordingProgress()
    with progress_task("t", "T", reporter=rec) as p:
        p.advance(1)
        p.advance(1, total=9)
    currents = [(e.current, e.total) for e in _updates(rec)]
    assert currents == [(1, None), (2, 9)]


def test_flush_before_set_phase_message_and_child(frozen_clock):
    rec = RecordingProgress()
    with progress_task("t", "T", reporter=rec) as p:
        p.advance(1)
        p.advance(1)  # pending, coalesced
        p.set_phase("ph", "headline")
    kinds = [e.kind for e in rec.events]
    update_idx = max(i for i, k in enumerate(kinds) if k == "update")
    assert kinds[update_idx + 1] == "message"

    rec2 = RecordingProgress()
    with progress_task("t2", "T2", reporter=rec2) as p2:
        p2.advance(1)
        p2.advance(1)
        p2.message("hi")
    kinds2 = [e.kind for e in rec2.events]
    update_idx2 = max(i for i, k in enumerate(kinds2) if k == "update")
    assert kinds2[update_idx2 + 1] == "message"

    rec3 = RecordingProgress()
    with progress_task("t3", "T3", reporter=rec3) as p3:
        p3.advance(1)
        p3.advance(1)
        with p3.child("c3", "Child"):
            pass
    kinds3 = [e.kind for e in rec3.events]
    update_idx3 = max(i for i, k in enumerate(kinds3) if k == "update")
    assert kinds3[update_idx3 + 1] == "start"


def test_flush_before_fail_and_cancel(frozen_clock):
    rec = RecordingProgress()
    with pytest.raises(RuntimeError), progress_task("t", "T", reporter=rec) as p:
        p.advance(1)
        p.advance(1)
        raise RuntimeError("boom")
    kinds = [e.kind for e in rec.events]
    update_idx = max(i for i, k in enumerate(kinds) if k == "update")
    assert kinds[update_idx + 1] == "fail"

    rec2 = RecordingProgress()
    with pytest.raises(CancelledProgress), progress_task("t2", "T2", reporter=rec2) as p2:
        p2.advance(1)
        p2.advance(1)
        raise CancelledProgress("stop")
    kinds2 = [e.kind for e in rec2.events]
    update_idx2 = max(i for i, k in enumerate(kinds2) if k == "update")
    assert kinds2[update_idx2 + 1] == "cancel"


def test_json_reporter_event_count_is_bounded(frozen_clock):
    stream = StringIO()
    rep = JsonProgressReporter(stream=stream)
    try:
        with bind_progress(rep), progress_task("t", "T", reporter=rep) as p:
            for _ in range(1000):
                p.advance(1)
        lines = [line for line in stream.getvalue().splitlines() if line]
        update_lines = [line for line in lines if '"kind": "update"' in line]
        assert len(update_lines) == 2
    finally:
        rep.close()


def test_coalesced_update_keeps_latest_non_none_message(frozen_clock):
    rec = RecordingProgress()
    with progress_task("t", "T", reporter=rec) as p:
        p.advance(1, message="x")  # first update, sent
        p.advance(1, message="y")  # pending
        p.advance(1)  # pending, message None keeps "y"
    assert [(e.current, e.message) for e in _updates(rec)] == [(1, "x"), (3, "y")]


def test_coalesced_update_without_messages_flushes_none(frozen_clock):
    rec = RecordingProgress()
    with progress_task("t", "T", reporter=rec) as p:
        p.advance(1, message="x")
        p.advance(1)
    assert [(e.current, e.message) for e in _updates(rec)] == [(1, "x"), (2, None)]


def test_concurrent_advance_loses_no_counts_and_stays_ordered(frozen_clock):
    rec = RecordingProgress()
    clock_lock = threading.Lock()
    with progress_task("t", "T", reporter=rec) as p:

        def worker() -> None:
            for _ in range(500):
                with clock_lock:  # keep the fake clock monotonic; only advance() should race
                    frozen_clock[0] += 0.001
                p.advance(1)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    currents = [e.current for e in _updates(rec)]
    assert currents[-1] == 4000
    assert currents == sorted(currents)


def test_advance_to_reenters_update_lock(frozen_clock):
    rec = RecordingProgress()
    with progress_task("t", "T", total=10, reporter=rec) as p:
        done = threading.Event()

        def run() -> None:
            p.advance_to(3, message="m")
            done.set()

        t = threading.Thread(target=run, daemon=True)
        t.start()
        assert done.wait(2.0), "advance_to deadlocked on _update_lock"
    assert next((e.current, e.message) for e in _updates(rec)) == (3, "m")
