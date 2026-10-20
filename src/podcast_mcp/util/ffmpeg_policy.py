from __future__ import annotations

from typing import Any

from podcast_mcp.util.contracts import load_contract


def ffmpeg_policy() -> dict[str, Any]:
    return load_contract("ffmpeg-build.json")
