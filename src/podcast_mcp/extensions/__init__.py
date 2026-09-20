"""Sharecut Studio Extensions API - public SPI for optional features (share, community plugins)."""

from __future__ import annotations

from podcast_mcp.extensions.api_version import HOST_API_VERSION
from podcast_mcp.extensions.features import STABLE_FEATURE_IDS, FeatureId
from podcast_mcp.extensions.loader import load_extensions
from podcast_mcp.extensions.registry import Contribution, FeatureRegistry
from podcast_mcp.extensions.spi import ExtensionBackend

__all__ = [
    "HOST_API_VERSION",
    "STABLE_FEATURE_IDS",
    "Contribution",
    "ExtensionBackend",
    "FeatureId",
    "FeatureRegistry",
    "load_extensions",
]
