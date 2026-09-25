"""Load ``contracts/timeline-zoom.json``: timeline zoom bounds and waveform knobs.

The same JSON generates ``gui/web/src/utils/timelineZoom.generated.ts``, so
Python and the GUI read one set of numbers. Python has getters only for the
keys it reads: zoom bounds, and the ``waveform`` knobs of the ``.wfpk`` peak
pyramid (``engines/waveform_pyramid.py``, ``docs/waveform.md``).
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


def paint_dpr_cap() -> float:
    return float(_waveform()["paint_dpr_cap"])
