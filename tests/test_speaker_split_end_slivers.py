"""An enrollment span at the end of the audio must not feed the speaker embed a sliver (#2040 item 2).

``_embed`` slices ``samples[start : start + width]`` around each window centre. For an
enrollment span shorter than a window the centre is the span's midpoint, so a span that
reaches past the end of the recording leaves a few samples (or none) in the slice. The real
network refuses audio that short. A window with too little audio to name a speaker is
skipped, not padded: padding would invent audio the user never confirmed, and a span with
no usable window already means "not enrolled" (``_enrollment_centroids`` skips it), so
that speaker is clustered like any other.
"""

from __future__ import annotations

import numpy as np
import pytest
from test_speaker_split import RATE, SpectralBackend, _mix

from podcast_mcp.engines.speaker_split import attribute_speakers

# The embed refuses fewer samples than this (#2034 pins the bound at 800).
_NETWORK_MIN_SAMPLES = 800


class _StrictBackend(SpectralBackend):
    """Embeds like the real network: refuses audio it cannot pad."""

    def __init__(self) -> None:
        self.lengths: list[int] = []

    def embed(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        self.lengths.append(int(samples.size))
        if samples.size < _NETWORK_MIN_SAMPLES:
            raise RuntimeError("Pad reflect: input too short")
        return super().embed(samples, sample_rate)


@pytest.mark.parametrize(
    ("tail_span", "case"),
    [
        ((-0.01, 1.0), "sliver_of_160_samples"),
        ((0.4, 0.7), "empty_slice_past_the_end"),
    ],
)
def test_enrollment_span_past_the_end_is_skipped_not_embedded_as_a_sliver(
    tail_span: tuple[float, float], case: str
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

    assert attribution.turns, case
    assert min(backend.lengths) >= _NETWORK_MIN_SAMPLES
