"""Room tone under a bleed mute, so the muted track still sounds like a room (#1734).

A bleed-gate mute (``transcript_gate`` with ``bleed_handling`` resolving to ``mute``) sets a
track's gain to zero over the foreign copies it removes. On a track whose own room is not
digital silence the mute is a gate to the ear: the room drops out whenever the other
speaker talks. The gate plan therefore carries a :class:`BleedFill`, and every place that
applies the plan's gain adds ``noise x (1 - gain)`` over the muted spans, so the fill rides
the same ramps the mute does and the two sum to the track's room at every sample.

The fill is the track's own room, from the same sources as the recorder-gate fill
(``engines/gate_fill.py``): its registered room-tone bed, else comfort noise matched to its
noise under speech. It never reads another track (bleed is never the main audio, #945), and
a track whose noise is not a floor stays silent: ``measure_bleed_fill`` returns the reason.

Only the power spectrum is kept. The noise is synthesised at the rate of the audio it is
added to (``BleedFill.noise``), as a seamless loop read at ``frame % len(loop)`` on the
clock the gain is applied on, so preview, stems, proxies and export of one plan agree
sample for sample, in whatever chunks they are read.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from functools import cached_property, lru_cache

import numpy as np

from podcast_mcp.engines.gate_fill import measure_track_fill, synthesise_noise
from podcast_mcp.models import EpisodeProject, GateFillSource, Track

log = logging.getLogger(__name__)

# Bump when the fill's measurement or synthesis changes: stems hashed before it re-render.
BLEED_FILL_REV = 1

PCM16_SCALE = 32768.0


@dataclass(frozen=True)
class BleedFill:
    """The noise a bleed mute adds under its muted spans: a spectrum and where it came from."""

    source: str
    level_db: float
    noise_db: float | None
    basis: str | None
    sample_rate: int
    nfft: int
    psd: tuple[float, ...] = field(repr=False)

    @cached_property
    def digest(self) -> str:
        raw = hashlib.sha256(np.asarray(self.psd, dtype="<f8").tobytes()).hexdigest()
        return f"{self.sample_rate}:{self.nfft}:{raw[:16]}"

    def __hash__(self) -> int:
        return hash((self.source, self.sample_rate, self.nfft, self.digest))

    def describe(self) -> dict[str, object]:
        return {
            "source": self.source,
            "level_db": round(self.level_db, 2),
            "noise_db": None if self.noise_db is None else round(self.noise_db, 2),
            "basis": self.basis,
        }

    def noise(self, first_frame: int, count: int, rate: int) -> np.ndarray:
        """``count`` samples of the fill, full scale (+-1), from ``first_frame`` on the clock
        of the audio at ``rate``."""
        loop = _loop(self, rate)
        index = (np.arange(count, dtype=np.int64) + first_frame) % loop.shape[0]
        return loop[index]


@lru_cache(maxsize=4)
def _loop(fill: BleedFill, rate: int) -> np.ndarray:
    return synthesise_noise(
        np.asarray(fill.psd, dtype=np.float64), fill.nfft, rate, source_rate=fill.sample_rate
    )


def measure_bleed_fill(
    project: EpisodeProject,
    track: Track,
    quiet_runs: Sequence[tuple[float, float]] | None = None,
) -> BleedFill | str:
    """``track``'s own room as a fill, or why it has none (the muted spans stay silent).

    ``quiet_runs`` are media-clock stretches the gate plan found to hold neither a foreign
    copy nor the lane's own voice: the room is read from those before any other source, so
    a copy that fills the lane's pauses is not read as its room.
    """
    if track.media is None:
        return "no media"
    made = measure_track_fill(project, track, quiet_runs)
    if isinstance(made, str):
        return made
    if made.psd is None or made.sample_rate <= 0:
        return "no spectrum to synthesise from"
    source = GateFillSource.ROOM_TONE_BED if made.noise_db is None else GateFillSource.COMFORT_NOISE
    return BleedFill(
        source=source.value,
        level_db=float(made.level_db),
        noise_db=None if made.noise_db is None else float(made.noise_db),
        basis=made.basis,
        sample_rate=made.sample_rate,
        nfft=made.nfft,
        psd=tuple(float(x) for x in made.psd),
    )
