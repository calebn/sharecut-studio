"""An enrollment span at the end of the audio is skipped, not embedded as a sliver (#2040 item 2).

Padding would invent audio the user never confirmed; a span with no usable window already
means "not enrolled", so that speaker is clustered like any other.
"""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.engines.models.speaker_ecapa import MIN_SAMPLES
from podcast_mcp.engines.speaker_split import attribute_speakers
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
def test_enrollment_span_past_the_end_is_skipped_not_embedded_as_a_sliver(
    tail_span: tuple[float, float],
) -> None:
    audio, _ = _mix(2, 20.0, seed=3)
    duration = audio.size / RATE
    backend = _StrictBackend()

    attribution = attribute_speakers(
        audio,
        speaker_count=2,
        backend=backend,
        enrollment={0: [(0.5, 4.0)], 1: [(duration + tail_span[0], duration + tail_span[1])]},
    )

    assert attribution.turns
    assert min(backend.lengths) >= MIN_SAMPLES
