"""Shared WebSocket protocol limits for guest-facing services."""

from __future__ import annotations

# Keep frames small enough for relayed guest editing and review traffic.
GUEST_FRAME_MAX_BYTES = 4096
