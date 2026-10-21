"""Shared unattended/batch detection for pipeline accept gates."""

from __future__ import annotations

from podcast_mcp import settings
from podcast_mcp.config.defaults import EffectiveConfig


def is_unattended(*, flag: bool | None = None, defaults: EffectiveConfig) -> bool:
    if flag is True:
        return True
    if defaults.get("_pipeline_unattended"):
        return True
    return settings.flag("PODCAST_BATCH", on=frozenset({"1", "true", "yes"}))
