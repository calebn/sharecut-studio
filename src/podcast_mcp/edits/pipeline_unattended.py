"""Shared unattended/batch detection for pipeline accept gates."""

from __future__ import annotations

import os

from podcast_mcp.config import EffectiveConfig


def is_unattended(*, flag: bool | None = None, defaults: EffectiveConfig) -> bool:
    if flag is True:
        return True
    if defaults.get("_pipeline_unattended"):
        return True
    env = os.environ.get("PODCAST_BATCH", "").strip().lower()
    return env in ("1", "true", "yes")
