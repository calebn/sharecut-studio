"""Shim - relay implementation lives in the ``podcast_relay`` package."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from podcast_relay.app import create_relay_app

__all__ = ["create_relay_app"]


def __getattr__(name: str) -> object:
    if name == "create_relay_app":
        from podcast_relay.app import create_relay_app

        return create_relay_app
    # Submodule compatibility: podcast_mcp.relay.protocol → podcast_relay.protocol
    if name in {"app", "limits", "protocol", "version"}:
        import importlib

        return importlib.import_module(f"podcast_relay.{name}")
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
