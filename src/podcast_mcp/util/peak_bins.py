"""Max-pool a loudness envelope into a fixed number of 0..1 columns."""

from __future__ import annotations

import numpy as np


def bin_peaks(envelope: np.ndarray, count: int) -> list[float]:
    """Max-pool ``envelope`` into ``count`` columns, scale so the loudest is 1, round to 2 dp.

    ``[]`` for an empty or silent envelope.
    """
    n = int(envelope.size)
    if n == 0:
        return []
    starts = (np.arange(count) * n) // count
    stops = np.maximum(((np.arange(count) + 1) * n) // count, starts + 1)
    cols = np.array([envelope[a:b].max() for a, b in zip(starts, stops, strict=True)])
    top = float(cols.max())
    if not np.isfinite(top) or top <= 0.0:
        return []
    return [round(float(v), 2) for v in np.clip(cols / top, 0.0, 1.0)]
