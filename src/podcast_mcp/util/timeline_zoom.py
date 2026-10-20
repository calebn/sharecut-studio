"""Load ``contracts/timeline-zoom.json``: timeline zoom bounds and waveform knobs.

The same JSON generates ``gui/web/src/utils/timelineZoom.generated.ts``, so
Python and the GUI read one set of numbers. Python has getters only for the
keys it reads: zoom bounds, the presence viewport minimum, snap tick
precision, and the ``waveform`` knobs of the ``.wfpk`` peak
pyramid (``engines/waveform_pyramid.py``, ``docs/waveform.md``).
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from podcast_mcp.util.contracts import load_contract


@lru_cache(maxsize=1)
def load_timeline_zoom() -> dict[str, Any]:
    return load_contract("timeline-zoom.json")


def _waveform() -> dict[str, Any]:
    waveform = load_timeline_zoom().get("waveform")
    if not isinstance(waveform, dict):
        raise ValueError("timeline-zoom.json missing waveform object")
    return waveform


def min_zoom_px_per_sec() -> float:
    return float(load_timeline_zoom()["min_zoom_px_per_sec"])


def max_zoom_px_per_sec() -> float:
    return float(load_timeline_zoom()["max_zoom_px_per_sec"])


def zoom_step() -> float:
    return float(load_timeline_zoom()["zoom_step"])


def min_viewport_span_sec() -> float:
    """Shortest presence viewport span (s) a client may publish."""
    return float(load_timeline_zoom()["min_viewport_span_sec"])


def snap_tick_decimals() -> int:
    """Decimals waveform snap ticks round to (6 = 1 µs), client and server."""
    return int(load_timeline_zoom()["snap_tick_decimals"])


# --- Waveform pyramid (.wfpk) knobs: only the keys Python reads. -------------


def waveform_format_version() -> int:
    return int(_waveform()["format_version"])


def base_samples_per_bin() -> int:
    return int(_waveform()["base_samples_per_bin"])


def level_factor() -> int:
    return int(_waveform()["level_factor"])


def bins_per_data_tile() -> int:
    return int(_waveform()["bins_per_data_tile"])


def max_tiles_per_request() -> int:
    return int(_waveform()["max_tiles_per_request"])


def pcm_block_frames() -> int:
    return int(_waveform()["pcm_block_frames"])
