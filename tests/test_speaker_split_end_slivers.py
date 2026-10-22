"""An enrollment span at the end of the audio is skipped, not embedded as a sliver (#2040 item 2).

Padding would invent audio the user never confirmed. A span that keeps at least one usable
window still enrolls. A speaker whose spans all lie past the end is refused, because clustering
them like an unenrolled speaker could put their name on a different voice.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from podcast_mcp.engines import speaker_split
from podcast_mcp.engines.models.speaker_ecapa import MIN_SAMPLES
from podcast_mcp.engines.speaker_split import (
    HOP_SEC,
    _enrollment_centers,
    _enrollment_centroids,
    _window_samples,
    attribute_speakers,
)
from podcast_mcp.util.coded_error import CodedValueError
from test_speaker_split import RATE, SpectralBackend, _mix


class _StrictBackend(SpectralBackend):
    """Embeds like the real network: refuses audio it cannot pad."""

    def __init__(self) -> None:
        self.lengths: list[int] = []

    def embed(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        self.lengths.append(int(samples.size))
        if samples.size < MIN_SAMPLES:
            raise RuntimeError("Pad reflect: input too short")
        return super().embed(samples, sample_rate)


@pytest.mark.parametrize("tail_span", [(-0.01, 1.0), (0.4, 0.7)])
def test_speaker_with_only_spans_past_the_end_is_refused_in_plain_words(
    tail_span: tuple[float, float],
) -> None:
    audio, _ = _mix(2, 20.0, seed=3)
    duration = audio.size / RATE

    with pytest.raises(CodedValueError) as raised:
        attribute_speakers(
            audio,
            speaker_count=2,
            backend=_StrictBackend(),
            enrollment={0: [(0.5, 4.0)], 1: [(duration + tail_span[0], duration + tail_span[1])]},
        )

    assert raised.value.code == "enrollment_past_end"
    assert str(raised.value) == (
        "The voice sample for speaker 2 is past the end of this recording. "
        "Choose a sample inside the audio."
    )


def test_all_past_the_end_speaker_fails_before_any_embedding() -> None:
    audio, _ = _mix(2, 20.0, seed=3)
    duration = audio.size / RATE
    backend = _StrictBackend()

    with pytest.raises(CodedValueError):
        attribute_speakers(
            audio,
            speaker_count=2,
            backend=backend,
            enrollment={1: [(duration + 0.4, duration + 0.7)]},
        )

    assert backend.lengths == []


@pytest.mark.parametrize("tail_span", [(-0.01, 1.0), (0.4, 0.7)])
def test_speaker_keeping_one_usable_window_still_enrolls(tail_span: tuple[float, float]) -> None:
    audio, _ = _mix(2, 20.0, seed=3)
    duration = audio.size / RATE
    backend = _StrictBackend()

    attribution = attribute_speakers(
        audio,
        speaker_count=2,
        backend=backend,
        enrollment={
            0: [(0.5, 4.0)],
            1: [(5.0, 8.0), (duration + tail_span[0], duration + tail_span[1])],
        },
    )

    assert attribution.turns
    assert attribution.method == "enroll"
    assert min(backend.lengths) >= MIN_SAMPLES


def _attribute(audio: np.ndarray, enrollment: dict[int, list[tuple[float, float]]]):
    return attribute_speakers(
        audio, speaker_count=2, backend=SpectralBackend(), enrollment=enrollment
    )


def test_span_far_longer_than_the_recording_builds_only_centers_the_audio_can_use(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    audio, _ = _mix(2, 20.0, seed=3)
    duration = audio.size / RATE
    lengths: list[int] = []
    real_arange = np.arange

    def spy(*args: float, **kwargs: object) -> np.ndarray:
        result = real_arange(*args, **kwargs)
        if args[-1] == HOP_SEC:
            lengths.append(len(result))
        return result

    monkeypatch.setattr(np, "arange", spy)

    _attribute(audio, {0: [(0.5, 4.0)], 1: [(10.0, 2e6)]})

    assert lengths
    assert max(lengths) <= (duration + 1.0) / HOP_SEC + 2


def test_span_longer_than_the_recording_attributes_like_one_ending_past_it() -> None:
    audio, _ = _mix(2, 20.0, seed=3)
    duration = audio.size / RATE

    long = _attribute(audio, {0: [(0.5, 4.0)], 1: [(0, 1e6)]})
    reference = _attribute(audio, {0: [(0.5, 4.0)], 1: [(0, duration + 1)]})

    assert long == reference


@pytest.mark.parametrize("span", [(25.0, 1e9), (1e9, 2e9)])
def test_span_starting_past_the_end_is_still_refused(span: tuple[float, float]) -> None:
    audio, _ = _mix(2, 20.0, seed=3)
    assert audio.size / RATE < span[0]

    with pytest.raises(CodedValueError) as raised:
        _attribute(audio, {0: [(0.5, 4.0)], 1: [span]})

    assert raised.value.code == "enrollment_past_end"


@pytest.mark.parametrize("offset", [-0.25, 0.0, 1e-9, 0.3])
def test_end_near_the_last_usable_window_matches_a_longer_span(offset: float) -> None:
    audio, _ = _mix(2, 20.0, seed=3)
    duration = audio.size / RATE
    window = 1.0

    edge = _attribute(audio, {0: [(0.5, 4.0)], 1: [(10.0, duration + window + offset)]})
    reference = _attribute(audio, {0: [(0.5, 4.0)], 1: [(10.0, duration + window + 5.0)]})

    assert edge.turns == reference.turns


@pytest.mark.parametrize("start", [3e18, 1e19])
def test_span_starting_astronomically_past_the_end_is_refused_in_plain_words(
    start: float,
) -> None:
    audio, _ = _mix(2, 20.0, seed=3)

    with pytest.raises(CodedValueError) as raised:
        _attribute(audio, {0: [(0.5, 4.0)], 1: [(start, float(np.nextafter(start, np.inf)))]})

    assert raised.value.code == "enrollment_past_end"


@pytest.mark.parametrize("span", [(0.5, 4.0), (10.0, 25.0), (0.0, 30.0)])
def test_embedded_centers_are_exactly_the_unclamped_usable_grid(
    monkeypatch: pytest.MonkeyPatch, span: tuple[float, float]
) -> None:
    audio, _ = _mix(2, 20.0, seed=3)
    window = 1.0
    start, end = span
    embedded: list[list[float]] = []
    real_embed = speaker_split._embed

    def spy(samples: np.ndarray, centers: np.ndarray, *args: Any, **kwargs: Any) -> np.ndarray:
        embedded.append(centers.tolist())
        return real_embed(samples, centers, *args, **kwargs)

    monkeypatch.setattr(speaker_split, "_embed", spy)
    expected = [
        c
        for c in np.arange(start + window / 2, end - window / 2 + 1e-9, HOP_SEC).tolist()
        if _window_samples(audio, c, window) >= MIN_SAMPLES
    ]

    by_speaker = _enrollment_centers(audio, {0: [span]}, window)
    _enrollment_centroids(audio, by_speaker, window, SpectralBackend())

    assert embedded == [expected]
