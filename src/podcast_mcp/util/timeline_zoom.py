"""Load ``contracts/timeline-zoom.json`` and derive peak / zoom rates.

Canonical knobs live in the JSON (not hardcoded 400 bins/sec). Callers use
``overview_samples_per_pixel()`` / ``finest_bins_per_sec()`` so a max-zoom
change updates generation and the GUI together. The ``waveform`` getters
feed the ``.wfpk`` peak pyramid (``engines/waveform_pyramid.py``).
"""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

_CONTRACT_NAME = "timeline-zoom.json"


def _contract_path() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "contracts" / _CONTRACT_NAME
        if candidate.is_file():
            return candidate
    bundled = here.parent / _CONTRACT_NAME
    if bundled.is_file():
        return bundled
    raise FileNotFoundError(f"timeline zoom contract not found ({_CONTRACT_NAME})")


@lru_cache(maxsize=1)
def load_timeline_zoom() -> dict[str, Any]:
    data = json.loads(_contract_path().read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("timeline-zoom.json must be an object")
    return data


def _peaks() -> dict[str, Any]:
    peaks = load_timeline_zoom().get("peaks")
    if not isinstance(peaks, dict):
        raise ValueError("timeline-zoom.json missing peaks object")
    return peaks


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


def overview_decode_hz() -> int:
    return int(_peaks()["overview_decode_hz"])


def overview_bins_per_sec() -> float:
    return float(_peaks()["overview_bins_per_sec"])


def dpr_headroom() -> float:
    return float(_peaks()["dpr_headroom"])


def paint_dpr_cap() -> float:
    """Same key the generated TS ``PAINT_DPR_CAP`` reads (``waveform.paint_dpr_cap``)."""
    return float(_waveform()["paint_dpr_cap"])


def tile_sec() -> float:
    return float(_peaks()["tile_sec"])


def edit_focus_sec() -> float:
    return float(_peaks()["edit_focus_sec"])


def edit_focus_multiplier() -> float:
    return float(_peaks()["edit_focus_multiplier"])


def finest_bins_per_sec() -> float:
    """Client detail ceiling: max zoom * DPR headroom (never a magic 400)."""
    return max_zoom_px_per_sec() * dpr_headroom()


def overview_samples_per_pixel() -> int:
    hz = overview_decode_hz()
    bins = overview_bins_per_sec()
    if bins <= 0:
        raise ValueError("overview_bins_per_sec must be > 0")
    spp = round(hz / bins)
    return max(1, spp)


def paint_dpr(device_pixel_ratio: float) -> float:
    """Paint DPR on a 1/8 grid in ``[1, paint_dpr_cap()]`` (mirrors the GUI's ``paintDpr``)."""
    ok = math.isfinite(device_pixel_ratio) and device_pixel_ratio > 0
    dpr = device_pixel_ratio if ok else 1.0
    # floor(x + 0.5) matches JS Math.round for x > 0; Python's round() is banker's.
    return min(max(math.floor(dpr * 8 + 0.5) / 8, 1.0), paint_dpr_cap())


def detail_bins_per_sec(zoom_px_per_sec: float, device_pixel_ratio: float) -> float:
    raw = zoom_px_per_sec * paint_dpr(device_pixel_ratio)
    return min(raw, finest_bins_per_sec())


def edit_focus_bins_per_sec(zoom_px_per_sec: float, device_pixel_ratio: float) -> float:
    detail = detail_bins_per_sec(zoom_px_per_sec, device_pixel_ratio)
    return min(detail * edit_focus_multiplier(), float(overview_decode_hz()))


# --- Waveform pyramid (.wfpk) knobs Python reads. ------------------------------
# max_tiles_per_request() is read by the tile route that lands in a later part
# of #429 (services/waveform.py); the renderer-only keys stay TS-only.


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
