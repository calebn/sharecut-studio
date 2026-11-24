"""The owner CDN base: a build-time default that a source checkout does not have.

Official builds get it from ``PODCAST_OWNER_CDN_BASE`` at build time, written into the
generated ``contracts/owner-cdn.json`` by ``scripts/owner_cdn.py``. This is the only
module that names the permitted owner host (tests/test_owner_cdn.py guards that).
"""

from __future__ import annotations

import json

from podcast_mcp import settings
from podcast_mcp.util.contracts import contracts_dir

OWNER_HOSTS = ("cdn.sharecut.studio",)
GENERATED_NAME = "owner-cdn.json"
BASE_ENV = "PODCAST_OWNER_CDN_BASE"


def clean_base(value: object) -> str | None:
    """``value`` as an https origin without a trailing slash, or None when it is not usable."""
    from podcast_mcp.util.asset_sources import _sanitize_cdn_base  # that module imports this one

    return _sanitize_cdn_base(value) if isinstance(value, str) else None


def _generated_base() -> str | None:
    try:
        data = json.loads((contracts_dir() / GENERATED_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return clean_base(data.get("base")) if isinstance(data, dict) else None


def owner_base(override: str | None = None) -> str | None:
    """``override`` (a flag), else the environment, else the generated file, else None.

    A source that is set but unusable ends the search: a bad override never silently
    falls through to a lower one.
    """
    if override and override.strip():
        return clean_base(override)
    if value := settings.text(BASE_ENV):
        return clean_base(value)
    return _generated_base()


def owner_url(path: str, override: str | None = None) -> str | None:
    base = owner_base(override)
    return f"{base}/{path.lstrip('/')}" if base else None
