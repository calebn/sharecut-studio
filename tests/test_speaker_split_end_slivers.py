"""An enrollment span at the end of the audio is skipped, not embedded as a sliver (#2040 item 2).

Padding would invent audio the user never confirmed. A span that keeps at least one usable
window still enrolls. A speaker whose spans all lie past the end is refused, because clustering
them like an unenrolled speaker could put their name on a different voice.
"""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.engines.models.speaker_ecapa import MIN_SAMPLES
from podcast_mcp.engines.speaker_split import attribute_speakers
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


@pytest.mark.parametrize(
    "tail_span",
    [
        pytest.param((-0.01, 1.0), id="sliver_of_160_samples"),
        pytest.param((0.4, 0.7), id="empty_slice_past_the_end"),
    ],
)
def test_enrollment_span_past_the_end_is_not_embedded_as_a_sliver(
    tail_span: tuple[float, float],
) -> None:
    audio, _ = _mix(2, 20.0, seed=3)
    duration = audio.size / RATE
    backend = _StrictBackend()

    with pytest.raises(CodedValueError):
        attribute_speakers(
            audio,
            speaker_count=2,
            backend=backend,
            enrollment={0: [(0.5, 4.0)], 1: [(duration + tail_span[0], duration + tail_span[1])]},
        )

    assert min(backend.lengths) >= MIN_SAMPLES


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


def test_speaker_keeping_one_usable_window_still_enrolls() -> None:
    audio, _ = _mix(2, 20.0, seed=3)
    duration = audio.size / RATE

    attribution = attribute_speakers(
        audio,
        speaker_count=2,
        backend=_StrictBackend(),
        enrollment={0: [(0.5, 4.0)], 1: [(5.0, 8.0), (duration + 0.4, duration + 0.7)]},
    )

    assert attribution.turns
    assert attribution.method == "enroll"
