from __future__ import annotations

import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import transcribe_pool
from podcast_mcp.engines.transcribe import TRANSCRIBE_CANCELLED, TranscribeJob, TranscriptionEngine
from podcast_mcp.engines.transcribe_pool import (
    DEFAULT_WORKER_RAM_BYTES,
    WORKER_CPU_THREADS,
    transcribe_worker_count,
)
from podcast_mcp.models import EpisodeProject, Transcript
from podcast_mcp.util.progress import CancelledProgress
from podcast_mcp.util.project_state import current_cancel_check, render_cancel_scope

GB = 1_000_000_000
WAIT = 10


@pytest.fixture
def engine(monkeypatch: pytest.MonkeyPatch) -> TranscriptionEngine:
    monkeypatch.setattr(
        "podcast_mcp.engines.transcribe.transcribe_worker_count",
        transcribe_pool.transcribe_worker_count,
    )
    monkeypatch.setattr(transcribe_pool, "cpu_budget", lambda: 16)
    monkeypatch.setattr(transcribe_pool, "available_ram_bytes", lambda: 64 * GB)
    return TranscriptionEngine(device="cpu", defaults=load_defaults())


def _jobs(count: int) -> list[TranscribeJob]:
    return [TranscribeJob(f"t{i}", None, Path(f"/nowhere/t{i}.wav")) for i in range(count)]


def _run(engine: TranscriptionEngine, jobs: list[TranscribeJob]) -> list[Transcript]:
    return engine.transcribe_all_dialogue(EpisodeProject.create("p", "/tmp/x"), jobs=jobs)


def _fake(monkeypatch: pytest.MonkeyPatch, body: Any) -> None:
    def transcribe_job(self: TranscriptionEngine, project: Any, job: TranscribeJob, **_: Any):
        body(self, job)
        return Transcript(track_id=job.track_id, words=[])

    monkeypatch.setattr(TranscriptionEngine, "transcribe_job", transcribe_job)


def test_jobs_overlap_and_results_keep_job_order(engine, monkeypatch):
    barrier = threading.Barrier(2, timeout=WAIT)
    _fake(monkeypatch, lambda self, job: barrier.wait())
    out = _run(engine, _jobs(2))
    assert [t.track_id for t in out] == ["t0", "t1"]


def test_each_worker_has_its_own_engine_state_and_four_threads(engine, monkeypatch):
    barrier = threading.Barrier(2, timeout=WAIT)
    seen: list[tuple[TranscriptionEngine, int | None]] = []

    def body(self: TranscriptionEngine, job: TranscribeJob) -> None:
        seen.append((self, self.cpu_threads))
        self.silence_filter_skipped.append(job.label)
        barrier.wait()

    _fake(monkeypatch, body)
    _run(engine, _jobs(2))
    assert len({id(e) for e, _ in seen}) == 2
    assert engine not in [e for e, _ in seen]
    assert {n for _, n in seen} == {WORKER_CPU_THREADS}
    assert engine.cpu_threads is None
    assert engine.silence_filter_skipped == sorted(engine.silence_filter_skipped)
    assert len(engine.silence_filter_skipped) == 2


def test_worker_count_follows_cpu_budget_and_memory(monkeypatch):
    monkeypatch.setattr(transcribe_pool, "cpu_budget", lambda: 12)
    monkeypatch.setattr(transcribe_pool, "available_ram_bytes", lambda: 64 * GB)
    assert transcribe_worker_count("large-v3-turbo", 10) == 3
    assert transcribe_worker_count("large-v3-turbo", 2) == 2
    monkeypatch.setattr(transcribe_pool, "cpu_budget", lambda: 64)
    free = int(DEFAULT_WORKER_RAM_BYTES * 2 / 0.7) + 1
    monkeypatch.setattr(transcribe_pool, "available_ram_bytes", lambda: free)
    assert transcribe_worker_count("large-v3-turbo", 10) == 2
    assert transcribe_worker_count("tiny.en", 10) > 2


@pytest.mark.parametrize(
    ("cores", "free", "jobs"),
    [(7, 64 * GB, 5), (64, 3 * GB, 5), (64, None, 5), (64, 64 * GB, 1)],
)
def test_worker_count_falls_back_to_serial(monkeypatch, cores, free, jobs):
    monkeypatch.setattr(transcribe_pool, "cpu_budget", lambda: cores)
    monkeypatch.setattr(transcribe_pool, "available_ram_bytes", lambda: free)
    assert transcribe_worker_count("large-v3-turbo", jobs) == 1


def test_one_worker_runs_serially_on_the_engine_itself(engine, monkeypatch):
    monkeypatch.setattr(transcribe_pool, "cpu_budget", lambda: 4)
    pools: list[Any] = []
    monkeypatch.setattr(
        transcribe_pool, "ThreadPoolExecutor", lambda *a, **k: pools.append(1) or None
    )
    ran: list[tuple[TranscriptionEngine, int | None]] = []
    _fake(monkeypatch, lambda self, job: ran.append((self, self.cpu_threads)))
    out = _run(engine, _jobs(3))
    assert [t.track_id for t in out] == ["t0", "t1", "t2"]
    assert not pools
    assert ran == [(engine, None)] * 3
    pools.clear()
    _run(engine, _jobs(1))
    assert not pools


def test_cancel_stops_queued_jobs(engine, monkeypatch):
    monkeypatch.setattr(transcribe_pool, "cpu_budget", lambda: 8)
    cancelled = threading.Event()
    started: list[str] = []

    def body(self: TranscriptionEngine, job: TranscribeJob) -> None:
        started.append(job.track_id)
        if job.track_id == "t0":
            cancelled.set()
        else:
            assert cancelled.wait(WAIT)

    _fake(monkeypatch, body)
    with render_cancel_scope(cancelled.is_set):
        with pytest.raises(CancelledProgress, match=TRANSCRIBE_CANCELLED):
            _run(engine, _jobs(6))
    assert set(started) <= {"t0", "t1"}


def test_cancel_before_start_runs_nothing(engine, monkeypatch):
    started: list[str] = []
    _fake(monkeypatch, lambda self, job: started.append(job.track_id))
    with render_cancel_scope(lambda: True):
        with pytest.raises(CancelledProgress, match=TRANSCRIBE_CANCELLED):
            _run(engine, _jobs(4))
    assert started == []


def test_earliest_failure_in_job_order_propagates(engine, monkeypatch):
    first_started = threading.Event()
    later_failed = threading.Event()

    def body(self: TranscriptionEngine, job: TranscribeJob) -> None:
        if job.track_id == "t0":
            first_started.set()
            assert later_failed.wait(WAIT)
            raise ValueError("t0 failed")
        assert first_started.wait(WAIT)
        if job.track_id == "t1":
            later_failed.set()
            raise RuntimeError("t1 failed")

    _fake(monkeypatch, body)
    with pytest.raises(ValueError, match="t0 failed"):
        _run(engine, _jobs(2))
    assert not [t for t in threading.enumerate() if t.name.startswith("transcribe")]


def test_context_variables_reach_workers(engine, monkeypatch):
    barrier = threading.Barrier(2, timeout=WAIT)
    checks: list[Any] = []

    def body(self: TranscriptionEngine, job: TranscribeJob) -> None:
        checks.append(current_cancel_check())
        barrier.wait()

    _fake(monkeypatch, body)

    def check() -> bool:
        return False

    with render_cancel_scope(check):
        _run(engine, _jobs(2))
    assert checks == [check, check]


@pytest.mark.parametrize(
    ("configured", "expected"), [(16, 16), (6, 6), (2, 2), (None, WORKER_CPU_THREADS)]
)
def test_forked_worker_keeps_a_set_thread_count_and_pins_an_unset_one(configured, expected):
    base = TranscriptionEngine(device="cpu", defaults=load_defaults(), cpu_threads=configured)
    clone = base.fork_worker(WORKER_CPU_THREADS)
    assert clone.cpu_threads == expected
    assert base.cpu_threads == configured


@pytest.mark.parametrize("configured", [None, 6])
def test_worker_threads_do_not_depend_on_the_worker_count(engine, monkeypatch, configured):
    engine.cpu_threads = configured
    seen: dict[int, set[int | None]] = {}
    for budget, workers in ((8, 2), (12, 3)):
        monkeypatch.setattr(transcribe_pool, "cpu_budget", lambda budget=budget: budget)
        threads: set[int | None] = set()
        barrier = threading.Barrier(workers, timeout=WAIT)

        def body(self: TranscriptionEngine, job: TranscribeJob, threads=threads, barrier=barrier):
            threads.add(self.cpu_threads)
            barrier.wait()

        _fake(monkeypatch, body)
        _run(engine, _jobs(workers))
        seen[workers] = threads
    assert seen[2] == seen[3] == {WORKER_CPU_THREADS if configured is None else configured}


def test_forked_workers_share_one_aligner_and_one_set_of_levels(engine, monkeypatch):
    loads: list[object] = []
    builds: list[object] = []
    aligner = object()
    levels = object()
    monkeypatch.setattr(
        "podcast_mcp.engines.word_align.WordAligner.load",
        classmethod(lambda cls, *a, **k: loads.append(1) or aligner),
    )
    monkeypatch.setattr(
        "podcast_mcp.engines.transcribe.SpeechLevels.for_project",
        classmethod(lambda cls, *a, **k: builds.append(1) or levels),
    )
    workers = [engine.fork_worker(WORKER_CPU_THREADS) for _ in range(3)]
    got: list[tuple[object, object]] = []
    barrier = threading.Barrier(len(workers), timeout=WAIT)

    def use(worker: TranscriptionEngine) -> None:
        barrier.wait()
        got.append((worker.load_word_aligner(), worker.speech_levels(MagicMock())))

    threads = [threading.Thread(target=use, args=(w,)) for w in workers]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(WAIT)
    assert got == [(aligner, levels)] * 3
    assert len(loads) == len(builds) == 1
    assert engine.load_word_aligner() is aligner
    assert engine.speech_levels(MagicMock()) is levels
    assert len(loads) == len(builds) == 1


def test_forked_workers_share_a_failed_aligner_load(engine, monkeypatch):
    loads: list[object] = []

    def fail(cls, *a, **k):
        loads.append(1)
        raise RuntimeError("no model")

    monkeypatch.setattr("podcast_mcp.engines.word_align.WordAligner.load", classmethod(fail))
    for worker in (engine.fork_worker(WORKER_CPU_THREADS) for _ in range(2)):
        with pytest.raises(RuntimeError, match="no model"):
            worker.load_word_aligner()
    assert len(loads) == 1


def test_interrupt_cancels_queued_jobs(engine, monkeypatch):
    monkeypatch.setattr(transcribe_pool, "cpu_budget", lambda: 8)
    started: list[str] = []
    release = threading.Event()

    def body(self: TranscriptionEngine, job: TranscribeJob) -> None:
        started.append(job.track_id)
        assert release.wait(WAIT)

    class Interrupting(transcribe_pool.ThreadPoolExecutor):
        def shutdown(self, wait=True, *, cancel_futures=False):
            if not cancel_futures:
                raise KeyboardInterrupt
            release.set()
            super().shutdown(wait=wait, cancel_futures=cancel_futures)

    monkeypatch.setattr(transcribe_pool, "ThreadPoolExecutor", Interrupting)
    _fake(monkeypatch, body)
    with pytest.raises(KeyboardInterrupt):
        _run(engine, _jobs(8))
    assert len(started) <= 2


def test_concurrent_tracks_keep_their_own_progress_row_and_heartbeat(engine, monkeypatch):
    from podcast_mcp.util.progress import bind_progress, progress_task
    from podcast_mcp.util.progress.reporters import ElapsedProgressMixin

    barrier = threading.Barrier(2, timeout=WAIT)

    def segments():
        barrier.wait()  # both decodes are open together
        yield SimpleNamespace(text="a", start=0.0, end=5.0, words=None)

    model = MagicMock()
    model.transcribe.side_effect = lambda *a, **k: (segments(), SimpleNamespace(duration=10.0))
    monkeypatch.setattr(TranscriptionEngine, "_get_model", lambda self: model)
    open_rows: list[set[str]] = []

    class Tracking(ElapsedProgressMixin):
        def start(self, task_id, label, total=None):
            self._register_task(task_id, label, total)
            with self._lock:
                open_rows.append({t for t in self._tasks if t.startswith("transcribe_audio")})

        def end(self, task_id, *, message=None):
            self._finish_task(task_id)

    rec = Tracking(heartbeat_sec=3600)

    def transcribe_job(self, project, job, **_):
        return self.transcribe_file(
            job.audio, progress_label=job.label, progress_task_id=job.progress_task_id
        )

    monkeypatch.setattr(TranscriptionEngine, "transcribe_job", transcribe_job)
    try:
        with bind_progress(rec), progress_task("transcribe", "Transcribing"):
            _run(engine, _jobs(2))
    finally:
        rec.close()
    # The second row opening must not have replaced the first: both are tracked at once.
    assert {"transcribe_audio:t0", "transcribe_audio:t1"} in open_rows
