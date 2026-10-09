"""Read the shared source-build and runtime release policy."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def ffmpeg_policy() -> dict[str, Any]:
    packaged = Path(__file__).with_name("ffmpeg-build.json")
    path = (
        packaged
        if packaged.is_file()
        else Path(__file__).parents[3] / "contracts/ffmpeg-build.json"
    )
    return json.loads(path.read_text(encoding="utf-8"))
