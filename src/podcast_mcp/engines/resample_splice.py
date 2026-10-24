"""Resample a 48 kHz stream by reusing the unchanged start of an earlier run's output (#1958).

After a cut, a track's tree differs from the previous one only from the cut on. A run keeps
a digest of each block of its input and its converted output. The next run digests its own
input as it arrives, feeds ffmpeg nothing until the first block that differs from the base,
then feeds from a restart point a little before it and appends the result to the base's
output. :func:`~podcast_mcp.engines.ungated_audio.resampler_locality` says how far before
the restart point the outputs are unaffected, so the result equals a full pass bit for bit.
When the resampler is not local on this build, there is no base, or the shared start is too
short to pay, the whole stream goes through ``resample_streams`` as before.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

import numpy as np

from podcast_mcp.engines.ungated_audio import resample_streams, resampler_locality

SOURCE_RATE = 48000
# A multiple of 6, the input samples per output at 8 kHz, so block edges are grid points at 8 and 16 kHz.
BLOCK_SAMPLES = 49152
GRID = 6
_FLOAT32 = np.dtype("<f4")


@dataclass(frozen=True)
class Resampled:
    """A finished run: its converted samples per rate and the digest of each block of its input."""

    samples: dict[int, np.ndarray]
    digests: tuple[bytes, ...]


def _digest(block: np.ndarray) -> bytes:
    return hashlib.blake2b(block.tobytes(), digest_size=16).digest()


def _round_up(value: int) -> int:
    return -(-value // GRID) * GRID


class SplicedResample:
    """A ``resample`` callable for ``evaluate_resampled`` that reuses ``base`` where the input is unchanged.

    After the call, ``digests`` holds this run's block digests and ``fed`` the number of
    input samples sent to ffmpeg. ``digests`` stays ``None`` when ``from_rate`` is not 48 kHz.
    """

    def __init__(self, base: Resampled | None = None) -> None:
        self._base = base
        self.digests: tuple[bytes, ...] | None = None
        self.fed = 0
        self._kept = 0
        self._dropped = 0
        self._sums: list[bytes] = []
        self._prefix = np.empty(0, dtype=_FLOAT32)
        self._shared = 0
        self._tail = 0
        self._matching = False
        self._warm_up = 0
        self._guard = 0

    def __call__(
        self, chunks: Iterator[np.ndarray], from_rate: int, to_rates: Iterable[int]
    ) -> dict[int, np.ndarray]:
        rates = tuple(dict.fromkeys(to_rates))
        if from_rate != SOURCE_RATE or SOURCE_RATE in rates:
            return resample_streams(chunks, from_rate, rates)
        self._begin(rates)
        converted = resample_streams(self._feed(chunks), from_rate, rates)
        self.digests = tuple(self._sums)
        if not self._kept:
            return converted
        assert self._base is not None
        return {
            rate: np.concatenate(
                (
                    self._base.samples[rate][: self._kept // (SOURCE_RATE // rate)],
                    converted[rate][self._dropped // (SOURCE_RATE // rate) :],
                )
            )
            for rate in rates
        }

    def _begin(self, rates: tuple[int, ...]) -> None:
        base = self._base
        if base is None or not all(rate in base.samples for rate in rates):
            return
        found = [resampler_locality(SOURCE_RATE, rate) for rate in rates]
        widths = [width for width in found if width is not None]
        if len(widths) != len(found):
            return
        self._warm_up = _round_up(max(warm_up for warm_up, _ in widths))
        self._guard = max(guard for _, guard in widths)
        self._tail = self._warm_up + self._guard + GRID
        self._matching = True

    def _feed(self, chunks: Iterator[np.ndarray]) -> Iterator[np.ndarray]:
        pending = np.empty(0, dtype=_FLOAT32)
        for chunk in chunks:
            pending = np.concatenate((pending, np.ascontiguousarray(chunk, dtype=_FLOAT32)))
            whole = len(pending) // BLOCK_SAMPLES * BLOCK_SAMPLES
            for begin in range(0, whole, BLOCK_SAMPLES):
                yield from self._take(pending[begin : begin + BLOCK_SAMPLES])
            pending = pending[whole:]
        if pending.size:
            yield from self._take(pending)
        if self._matching:
            yield from self._restart()

    def _take(self, block: np.ndarray) -> Iterator[np.ndarray]:
        digest = _digest(block)
        index = len(self._sums)
        self._sums.append(digest)
        if self._matching:
            assert self._base is not None
            if index < len(self._base.digests) and self._base.digests[index] == digest:
                self._prefix = np.concatenate((self._prefix, block))[-self._tail :]
                self._shared += len(block)
                return
            yield from self._restart()
        self.fed += len(block)
        yield block

    def _restart(self) -> Iterator[np.ndarray]:
        """Stop matching: the first ``self._shared`` samples equal the base's, so feed from just before the last outputs they fix."""
        self._matching = False
        fixed = (self._shared - self._guard) // GRID * GRID
        start = fixed - self._warm_up
        if start <= 0:
            start, fixed = 0, 0
        self._kept, self._dropped = fixed, fixed - start
        resume = self._prefix[len(self._prefix) - (self._shared - start) :]
        self.fed += len(resume)
        if resume.size:
            yield resume
