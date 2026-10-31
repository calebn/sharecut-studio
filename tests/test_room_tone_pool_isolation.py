"""Background room-tone pool recording is off in a test unless it asks for it (#2882)."""

from __future__ import annotations

import threading
from pathlib import Path

from podcast_mcp.engines import room_tone
from test_room_tone import _host_audio, _project


def test_scheduling_a_pool_starts_no_thread_by_default(tmp_path: Path) -> None:
    project = _project(tmp_path, host=_host_audio())

    assert room_tone.schedule_room_tone_pools(project) == 0
    assert room_tone.schedule_room_tone_pool(project, "host") is False
    assert not [t for t in threading.enumerate() if t.name.startswith("room-tone-pool-")]
