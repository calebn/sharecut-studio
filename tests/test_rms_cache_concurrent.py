"""Chain tracks' RMS evidence is evaluated concurrently and equals the serial result (#1958)."""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import audio_audit, track_evidence
from podcast_mcp.engines.audio import Audio
from podcast_mcp.engines.track_evidence import Declined, _Entry
from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.episode import ProcessingChain, ProcessingEffect
from podcast_mcp.util import batch_scope as scope_module
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.process import CalledProcessError
from podcast_mcp.util.project_state import project_state_lock
from test_audio_eval import _ffmpeg_or_skip, _project

TRACKS = ["caleb", "audra", "lana"]
REAL_EVALUATE = track_evidence._evaluate


@pytest.fixture(autouse=True)
def _enough_cores(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(os, "cpu_count", lambda: 8)


def _three_chained(tmp_path: Path) -> EpisodeProject:
    project = _project(tmp_path, "mixed joins and pads")
    project.mix.processing_chains = [
        ProcessingChain(track_id=tid, effects=[ProcessingEffect(effect="highpass", params={})])
        for tid in TRACKS
    ]
    return project


def _build(project: EpisodeProject) -> audio_audit.TrackRmsCacheSet:
    return audio_audit.build_track_rms_caches(project, unprocessed=True, defaults=load_defaults())


class _Probe:
    """Wraps ``_evaluate`` to record each real evaluation, the thread it ran on and how many ran at once."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, *, meet: int = 0) -> None:
        self.trees: list[Audio] = []
        self.threads: list[int] = []
        self.scopes: list[object] = []
        self.stores: list[object] = []
        self.peak = 0
        self._running = 0
        self._lock = threading.Lock()
        self._meet = meet
        self._barrier = threading.Barrier(meet, timeout=20) if meet else None
        self._real = REAL_EVALUATE
        monkeypatch.setattr(track_evidence, "_evaluate", self)

    def __call__(self, tree: Audio, curve: str, base: Any = None) -> _Entry | Declined:
        with self._lock:
            self.trees.append(tree)
            self.threads.append(threading.get_ident())
            self.scopes.append(scope_module.snapshot()[0])
            self.stores.append(track_evidence._store())
            self._running += 1
            meets = len(self.trees) <= self._meet
            self.peak = max(self.peak, self._running)
        try:
            if self._barrier is not None and meets:
                self._barrier.wait()
            return self._real(tree, curve, base)
        finally:
            with self._lock:
                self._running -= 1


def _serial(project: EpisodeProject) -> dict[str, audio_audit.TrackRmsCache]:
    """What one-track-at-a-time ``rms`` gives, the path the builder used before it was concurrent."""
    defaults = load_defaults()
    with batch_scope():
        return {tid: track_evidence.rms(project, tid, defaults) for tid in TRACKS}


def test_three_chain_tracks_are_evaluated_at_the_same_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    probe = _Probe(monkeypatch, meet=3)

    with batch_scope():
        caches = _build(project)

    assert probe.peak == 3
    assert len(set(probe.threads)) == 3
    assert list(caches.caches) == TRACKS


def test_concurrent_caches_equal_the_serial_ones_at_both_rates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    expected = _serial(project)
    heard = {}

    with batch_scope():
        caches = _build(project)
        for tid in TRACKS:
            heard[tid] = track_evidence.heard(project, tid, load_defaults())

    assert list(caches.caches) == list(expected) == TRACKS
    for tid in TRACKS:
        got = caches.caches[tid]
        assert got.sample_rate == expected[tid].sample_rate == track_evidence.JUMP_SAMPLE_RATE
        assert np.array_equal(got.samples, expected[tid].samples)
        assert np.array_equal(heard[tid].jump.samples, expected[tid].samples)
        assert heard[tid].waveform.samples.size > heard[tid].jump.samples.size
        assert got.recording_profile == expected[tid].recording_profile


def test_workers_use_the_batch_scope_and_its_one_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    probe = _Probe(monkeypatch)

    with batch_scope():
        outer = scope_module.snapshot()[0]
        store = track_evidence._store()
        _build(project)
        again = _build(project)

    assert outer is not None
    assert all(scope is outer for scope in probe.scopes)
    assert all(seen is store for seen in probe.stores)
    assert len(probe.trees) == len(TRACKS)
    assert list(again.caches) == TRACKS


def test_evaluation_count_equals_the_serial_count_for_distinct_and_repeated_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    with monkeypatch.context() as serial_patch:
        serial = _Probe(serial_patch)
        _serial(project)
    serial_count = len(serial.trees)

    concurrent = _Probe(monkeypatch)
    with batch_scope():
        _build(project)
        _build(project)

    assert len(concurrent.trees) == serial_count == len(TRACKS)
    assert len(set(concurrent.trees)) == len(concurrent.trees)


def test_one_failing_track_falls_back_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    expected = _serial(project)
    planned = track_evidence._plan(project, "audra", load_defaults())
    assert not isinstance(planned, Declined)
    audra_tree = planned[1]

    def failing(tree: Audio, curve: str, base: Any = None) -> _Entry | Declined:
        if tree == audra_tree:
            raise CalledProcessError(1, ["ffmpeg"])
        return REAL_EVALUATE(tree, curve, base)

    monkeypatch.setattr(track_evidence, "_evaluate", failing)

    with batch_scope(), caplog.at_level(logging.WARNING):
        caches = _build(project)

    assert list(caches.caches) == ["caleb", "lana", "audra"]
    assert caches.caches["audra"].samples.size > 0
    assert "reconcile evidence for track audra keeps its effects chain" in caplog.text
    for tid in ("caleb", "lana"):
        assert np.array_equal(caches.caches[tid].samples, expected[tid].samples)


def test_the_pool_is_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    monkeypatch.setattr(track_evidence, "MAX_EVALUATORS", 2, raising=False)
    probe = _Probe(monkeypatch, meet=2)

    with batch_scope():
        caches = _build(project)

    assert list(caches.caches) == TRACKS
    assert probe.peak == 2


def test_a_single_missing_tree_is_evaluated_on_the_callers_thread(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    probe = _Probe(monkeypatch)

    with batch_scope():
        track_evidence.rms(project, "caleb", load_defaults())
        track_evidence.rms(project, "audra", load_defaults())
        probe.threads.clear()
        _build(project)

    assert probe.threads == [threading.get_ident()]


def test_the_pool_does_not_need_the_project_lock_the_caller_holds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    probe = _Probe(monkeypatch, meet=3)
    outcome: list[audio_audit.TrackRmsCacheSet] = []

    def hold_and_build() -> None:
        with project_state_lock(project), batch_scope():
            outcome.append(_build(project))

    runner = threading.Thread(target=hold_and_build, daemon=True)
    runner.start()
    runner.join(timeout=60)

    assert not runner.is_alive()
    assert probe.peak == 3
    assert list(outcome[0].caches) == TRACKS


@pytest.mark.parametrize(("private", "locks"), [(False, 3), (True, 0)])
def test_a_private_copy_takes_no_project_lock(
    private: bool, locks: int, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    taken: list[int] = []

    @contextmanager
    def counting(_: EpisodeProject) -> Iterator[None]:
        taken.append(1)
        yield

    monkeypatch.setattr(track_evidence, "project_state_lock", counting)
    probe = _Probe(monkeypatch, meet=3)

    with batch_scope():
        caches = audio_audit.build_track_rms_caches(
            project, unprocessed=True, private_copy=private, defaults=load_defaults()
        )

    assert len(taken) == locks
    assert probe.peak == 3
    assert list(caches.caches) == TRACKS


def _plan_as(monkeypatch: pytest.MonkeyPatch, override: dict[str, str | Declined]) -> None:
    """Plan each track in ``override`` as the named track's plan, or as the decline."""
    real = track_evidence._plan

    def plan(project: EpisodeProject, track_id: str, defaults):  # type: ignore[no-untyped-def]
        wanted = override.get(track_id, track_id)
        return wanted if isinstance(wanted, Declined) else real(project, wanted, defaults)

    monkeypatch.setattr(track_evidence, "_plan", plan)


def test_a_declined_track_is_rendered_beside_the_pooled_ones(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, render_calls: list[str]
) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    expected = _serial(project)
    _plan_as(monkeypatch, {"lana": Declined.MIXED_RATE})
    probe = _Probe(monkeypatch, meet=2)

    with batch_scope():
        caches = _build(project)

    assert list(caches.caches) == TRACKS
    assert render_calls == ["lana"]
    assert probe.peak == len(probe.trees) == 2
    for tid in ("caleb", "audra"):
        assert np.array_equal(caches.caches[tid].samples, expected[tid].samples)
    assert caches.caches["lana"].samples.size > 0


def test_an_unreadable_track_falls_back_beside_the_pooled_ones(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    expected = _serial(project)
    _plan_as(monkeypatch, {"audra": Declined.UNREADABLE})

    with batch_scope():
        caches = _build(project)

    assert list(caches.caches) == TRACKS
    for tid in ("caleb", "lana"):
        assert np.array_equal(caches.caches[tid].samples, expected[tid].samples)


def test_tracks_with_one_key_evaluate_it_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    _plan_as(monkeypatch, {"audra": "caleb"})
    probe = _Probe(monkeypatch, meet=2)

    with batch_scope():
        caches = _build(project)

    assert len(probe.trees) == 2
    assert np.array_equal(caches.caches["audra"].samples, caches.caches["caleb"].samples)


def test_an_unexpected_worker_error_surfaces_after_the_others_finish(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    planned = track_evidence._plan(project, "audra", load_defaults())
    assert not isinstance(planned, Declined)
    started: list[Audio] = []
    workers: list[threading.Thread] = []

    def evaluate(tree: Audio, curve: str, base: Any = None) -> _Entry | Declined:
        started.append(tree)
        workers.append(threading.current_thread())
        if tree == planned[1]:
            raise RuntimeError("boom")
        return REAL_EVALUATE(tree, curve, base)

    monkeypatch.setattr(track_evidence, "_evaluate", evaluate)

    with batch_scope(), pytest.raises(RuntimeError, match="boom"):
        _build(project)

    assert len(started) == len(TRACKS)
    for worker in workers:
        worker.join(timeout=10)
    assert not any(worker.is_alive() for worker in workers)
