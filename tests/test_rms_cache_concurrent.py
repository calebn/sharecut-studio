"""Chain tracks' RMS evidence is evaluated concurrently and equals the serial result (#1958)."""

from __future__ import annotations

import logging
import threading
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import audio_audit, track_evidence
from podcast_mcp.engines.audio import Audio
from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.episode import ProcessingChain, ProcessingEffect
from podcast_mcp.util import batch_scope as scope_module
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.process import CalledProcessError
from test_audio_eval import _ffmpeg_or_skip, _project

TRACKS = ["caleb", "audra", "lana"]


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
        self._barrier = threading.Barrier(meet, timeout=20) if meet else None
        self._real = track_evidence._evaluate
        monkeypatch.setattr(track_evidence, "_evaluate", self)

    def __call__(self, tree: Audio, curve: str):  # type: ignore[no-untyped-def]
        with self._lock:
            self.trees.append(tree)
            self.threads.append(threading.get_ident())
            self.scopes.append(scope_module.snapshot()[0])
            self.stores.append(track_evidence._store())
            self._running += 1
            self.peak = max(self.peak, self._running)
        try:
            if self._barrier is not None:
                self._barrier.wait()
            return self._real(tree, curve)
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
    probe = _Probe(monkeypatch)

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
    assert len(probe.trees) == len(TRACKS)


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
    serial = _Probe(monkeypatch)
    _serial(project)
    serial_count = len(serial.trees)

    concurrent = _Probe(monkeypatch)
    with batch_scope():
        _build(project)
        _build(project)

    assert len(concurrent.trees) == serial_count == len(TRACKS)
    assert len(set(concurrent.trees)) == len(concurrent.trees)


def test_one_failing_track_falls_back_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:  # type: ignore[no-untyped-def]
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    expected = _serial(project)
    real = track_evidence._evaluate
    audra_tree = track_evidence._plan(project, "audra", load_defaults())[1]  # type: ignore[index]

    def failing(tree: Audio, curve: str):  # type: ignore[no-untyped-def]
        if tree == audra_tree:
            raise CalledProcessError(1, ["ffmpeg"])
        return real(tree, curve)

    monkeypatch.setattr(track_evidence, "_evaluate", failing)

    with batch_scope(), caplog.at_level(logging.WARNING):
        caches = _build(project)

    # The fallen-back track is read from its raw clips after the others, as it always was.
    assert list(caches.caches) == ["caleb", "lana", "audra"]
    assert caches.caches["audra"].samples.size > 0
    assert "reconcile evidence for track audra keeps its effects chain" in caplog.text
    for tid in ("caleb", "lana"):
        assert np.array_equal(caches.caches[tid].samples, expected[tid].samples)


def test_the_pool_is_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _ffmpeg_or_skip()
    project = _three_chained(tmp_path)
    monkeypatch.setattr(track_evidence, "MAX_EVALUATORS", 2, raising=False)
    probe = _Probe(monkeypatch)

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
