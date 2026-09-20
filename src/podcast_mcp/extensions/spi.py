"""ExtensionBackend protocol - public SPI for Sharecut Studio Extensions."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from podcast_mcp.extensions.registry import FeatureRegistry


@runtime_checkable
class ExtensionBackend(Protocol):
    """Contribute optional routes, MCP tools, CLI, and UI feature ids."""

    api_version: int
    name: str

    def compatible(self, host_api_version: int) -> bool:
        """Return True when this extension can run on the host API version."""
        ...

    def contribute(self, registry: FeatureRegistry) -> None:
        """Register contributions; must not raise (loader isolates failures)."""
        ...
