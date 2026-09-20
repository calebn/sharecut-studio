"""Sanitize episode track ids used as artifact filenames."""

from __future__ import annotations

import re

_UNSAFE = re.compile(r"[^A-Za-z0-9_-]+")
SAFE_TRACK_ID = re.compile(r"^[A-Za-z0-9_-]+$")


def slug_track_id(raw: str) -> str:
    """Map *raw* to ``[A-Za-z0-9_-]+`` (lowercase), or ``track`` if empty."""
    cleaned = _UNSAFE.sub("_", raw.strip()).strip("_").lower()
    return cleaned or "track"
