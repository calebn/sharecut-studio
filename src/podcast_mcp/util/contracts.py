"""Load ``contracts/*.json``: the one reader of the cross-language contract files.

A source checkout reads ``<repo>/contracts``; a wheel ships that directory as
``podcast_mcp/contracts`` (pyproject ``force-include``). Stdlib only, so
``scripts/build_ffmpeg.py`` can copy this module into a rebuild tree.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def contracts_dir() -> Path:
    packaged = Path(__file__).resolve().parents[1] / "contracts"
    return packaged if packaged.is_dir() else Path(__file__).resolve().parents[3] / "contracts"


def load_contract(name: str) -> dict[str, Any]:
    """Parse ``contracts/<name>`` (for example ``"timeline-zoom.json"``); a fresh dict per call."""
    data = json.loads((contracts_dir() / name).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{name} must be a JSON object")
    return data


def contract_constant(name: str, key: str) -> Any:
    """``constants[key]`` of ``contracts/<name>``; a missing block or key names the file and key."""
    constants = load_contract(name).get("constants")
    if not isinstance(constants, dict) or key not in constants:
        raise RuntimeError(f"contracts/{name} has no constants.{key}; regenerate or restore it")
    return constants[key]
