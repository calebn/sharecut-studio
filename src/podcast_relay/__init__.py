"""podcast-relay - FOSS TLS-edge reverse tunnel (no accounts, no episode storage)."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from podcast_relay.app import create_relay_app

__all__ = ["PROTOCOL_VERSION", "create_relay_app"]

PROTOCOL_VERSION = 1


def __getattr__(name: str) -> object:
    if name == "create_relay_app":
        from podcast_relay.app import create_relay_app

        return create_relay_app
    if name == "PROTOCOL_VERSION":
        return PROTOCOL_VERSION
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
