"""The web client and the server must agree on how long a room-tone take is."""

from __future__ import annotations

import re
from pathlib import Path

from podcast_mcp.services.record.state import ROOM_TONE_COUNTDOWN_MS, ROOM_TONE_DURATION_SEC
from podcast_mcp.services.record.upload import (
    KEEPER_SAMPLE_RATE,
    ROOM_TONE_MAX_DURATION_SEC,
    ROOM_TONE_MAX_PCM_BYTES,
)

ROOT = Path(__file__).resolve().parents[1]
TYPES_TS = ROOT / "gui" / "web" / "src" / "record" / "types.ts"
PCM_TS = ROOT / "gui" / "web" / "src" / "record" / "keeper" / "pcm.ts"


def _ts_number(path: Path, name: str) -> int:
    match = re.search(rf"export const {name}\s*=\s*([0-9_]+)\s*;", path.read_text(encoding="utf-8"))
    assert match, f"{name} is not a plain number export in {path.name}"
    return int(match.group(1).replace("_", ""))


def test_web_and_server_room_tone_durations_match() -> None:
    web = _ts_number(TYPES_TS, "ROOM_TONE_DURATION_SEC")
    assert web == ROOM_TONE_DURATION_SEC
    assert web * 1000 == ROOM_TONE_COUNTDOWN_MS


def test_server_cap_leaves_room_over_the_web_take_and_the_sample_rate_matches() -> None:
    assert _ts_number(PCM_TS, "KEEPER_SAMPLE_RATE") == KEEPER_SAMPLE_RATE
    web = _ts_number(TYPES_TS, "ROOM_TONE_DURATION_SEC")
    assert web < ROOM_TONE_MAX_DURATION_SEC
    assert ROOM_TONE_MAX_PCM_BYTES == KEEPER_SAMPLE_RATE * 2 * ROOM_TONE_MAX_DURATION_SEC
