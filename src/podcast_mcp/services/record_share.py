"""Guest-safe record-share bootstrap (no review mix, no host paths)."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.share_capabilities import CAP_JOIN, has_capability
from podcast_mcp.edits.share_registry import SHARE_KIND_RECORD
from podcast_mcp.services.share import drop_absolute_path_strings, lookup_share, share_episode_name

RECORDED_CAP = 4
PRODUCER_CAP = 2


def lookup_record_share(token: str) -> dict[str, Any]:
    return lookup_share(token, kind=SHARE_KIND_RECORD)


def record_bootstrap(row: dict[str, Any]) -> dict[str, Any]:
    """Guest-safe JSON for the record shell. No host paths; no review data."""
    payload = {
        "mode": "record",
        "kind": SHARE_KIND_RECORD,
        "token": row.get("token"),
        "role": row.get("role"),
        "session_id": row.get("session_id"),
        "capabilities": list(row.get("capabilities") or []),
        "episode": {"name": share_episode_name(row)},
        "room": {"recorded_cap": RECORDED_CAP, "producer_cap": PRODUCER_CAP},
        "build": {
            "capture": True,
            "monitor": True,
            "upload": has_capability(row.get("capabilities"), CAP_JOIN),
        },
        "expires_at": row.get("expires_at"),
    }
    return drop_absolute_path_strings(payload)
