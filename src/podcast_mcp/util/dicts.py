"""Small dict helpers shared across layers."""

from __future__ import annotations

import copy
from typing import Any


def deep_merge(
    base: dict[str, Any], override: dict[str, Any], *, skip_private: bool = True
) -> dict[str, Any]:
    """Deep-copy `base` with `override` merged in (nested dicts merge).

    With ``skip_private`` (default), `_`-prefixed override keys are ignored at every
    level (pipeline config semantics). Pass ``False`` to keep them (transcript context).
    """
    out = copy.deepcopy(base)
    for key, val in override.items():
        if skip_private and key.startswith("_"):
            continue
        if isinstance(val, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], val, skip_private=skip_private)
        else:
            out[key] = copy.deepcopy(val)
    return out
