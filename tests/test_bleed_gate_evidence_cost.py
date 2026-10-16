"""The bleed gate reads each kind of evidence only where it can change the plan (#1668)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines import bleed_gate
from test_bleed_attenuation import LAB_COUPLING_DB
from test_bleed_gate_generality import _episode
from test_bleed_gate_regression import _read_pcm, _write_pcm

NEAR_THE_COPY = ("laugh", 5.0, 5.8, LAB_COUPLING_DB + 4.0, 0.0)
WINDOW = 20


def _copy_of_own_sound() -> tuple[bleed_gate._PeerCopy, np.ndarray]:
    samples = np.random.default_rng(1).standard_normal(bleed_gate.EVIDENCE_RATE * 4)
    samples = samples.astype(np.float32)
    levels = np.zeros(samples.size // 80)
    return bleed_gate._PeerCopy(levels, samples, lag=0, likeness=0.5), samples


def test_timbre_is_read_only_in_windows_that_hold_an_undecided_frame(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Own speech clearly over the copy is kept whatever its timbre, so a window with no
    undecided frame is not read, and the windows that are give the answer they always did."""
    copy, samples = _copy_of_own_sound()
    read: list[int] = []
    similarity = bleed_gate._PeerCopy.similarity

    def counting(self: bleed_gate._PeerCopy, own: np.ndarray, frames: np.ndarray) -> np.ndarray:
        read.append(frames.size)
        return similarity(self, own, frames)

    monkeypatch.setattr(bleed_gate._PeerCopy, "similarity", counting)
    judged = np.zeros(300, dtype=bool)
    judged[: 5 * WINDOW] = True
    undecided = np.zeros(300, dtype=bool)
    undecided[2 * WINDOW + 5] = True

    every = copy.timbre_windows(samples, judged, np.ones(300, dtype=bool))
    assert read == [5 * WINDOW]
    assert every[: 5 * WINDOW].all()

    read.clear()
    decided = copy.timbre_windows(samples, judged, undecided)
    assert read == [WINDOW]
    assert np.flatnonzero(decided).tolist() == list(range(2 * WINDOW, 3 * WINDOW))
    assert np.array_equal(decided[2 * WINDOW : 3 * WINDOW], every[2 * WINDOW : 3 * WINDOW])


def test_dual_mono_wav_is_one_signal_without_reading_each_channel_level(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = _episode(tmp_path, own=(NEAR_THE_COPY,))
    host = tmp_path / "raw" / "host.wav"
    mono = _read_pcm(host).astype(np.float64) / 32767
    _write_pcm(host, np.column_stack([mono, mono]))

    def refuse(channels: np.ndarray) -> bool:
        raise AssertionError("identical channels need no level comparison")

    monkeypatch.setattr(bleed_gate, "_channels_are_one_signal", refuse)
    assert len(bleed_gate._lane_signals(project, "host")) == 1
