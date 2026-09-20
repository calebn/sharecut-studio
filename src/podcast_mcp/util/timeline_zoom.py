"""Load ``contracts/timeline-zoom.json`` and derive peak / zoom rates.

Canonical knobs live in the JSON (not hardcoded 400 bins/sec). Callers use
``overview_samples_per_pixel()`` / ``finest_bins_per_sec()`` so a max-zoom
change updates generation and the GUI together.
"""

from __future__ import annotations

import json
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
    return float(_peaks()["paint_dpr_cap"])


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


def detail_bins_per_sec(zoom_px_per_sec: float, device_pixel_ratio: float) -> float:
    paint_dpr = min(max(device_pixel_ratio, 1.0), paint_dpr_cap())
    raw = zoom_px_per_sec * paint_dpr
    return min(raw, finest_bins_per_sec())


def edit_focus_bins_per_sec(zoom_px_per_sec: float, device_pixel_ratio: float) -> float:
    detail = detail_bins_per_sec(zoom_px_per_sec, device_pixel_ratio)
    return min(detail * edit_focus_multiplier(), float(overview_decode_hz()))
