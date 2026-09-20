"""Share general-access helpers (link vs restricted)."""

from __future__ import annotations

from typing import Any

GENERAL_ACCESS_LINK = "link"
GENERAL_ACCESS_RESTRICTED = "restricted"
_KNOWN = frozenset({GENERAL_ACCESS_LINK, GENERAL_ACCESS_RESTRICTED})


def normalize_general_access(value: str | None) -> str:
    key = str(value or GENERAL_ACCESS_LINK).strip().lower()
    if key not in _KNOWN:
        raise ValueError(f"unknown general_access {value!r}; expected link or restricted")
    return key


def access_required(share_row: dict[str, Any] | None) -> bool:
    """True when guests must present an authenticated principal."""
    if not share_row:
        return False
    if normalize_general_access(share_row.get("general_access")) == GENERAL_ACCESS_RESTRICTED:
        return True
    return bool(share_row.get("require_sign_in"))
