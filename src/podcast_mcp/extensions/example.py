"""Minimal example extension - proves the third-party path (not online-only)."""

from __future__ import annotations

from podcast_mcp.extensions.api_version import HOST_API_VERSION
from podcast_mcp.extensions.features import FEATURE_EXTENSION_STATUS_0
from podcast_mcp.extensions.registry import FeatureRegistry


class ExampleExtension:
    """Contributes only an experimental status slot (no routes)."""

    api_version = HOST_API_VERSION
    name = "example"

    def compatible(self, host_api_version: int) -> bool:
        return host_api_version >= 1 and self.api_version <= host_api_version

    def contribute(self, registry: FeatureRegistry) -> None:
        registry.add(
            FEATURE_EXTENSION_STATUS_0,
            source=self.name,
            payload={"label": "Example extension loaded"},
        )


def create() -> ExampleExtension:
    return ExampleExtension()
