"""Stand-in voice floors for tests that fake word levels instead of decoding audio (#1324)."""

from __future__ import annotations

from unittest.mock import patch


def floors_at(floor_db: float):
    """Give every dialogue track this audibility floor, with no audio to measure it from."""
    return patch(
        "podcast_mcp.engines.audio_audit._voice_floors",
        new=lambda project, track_ids, caches: dict.fromkeys(track_ids, floor_db),
    )
