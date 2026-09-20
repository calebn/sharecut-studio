from __future__ import annotations

import pytest

from podcast_mcp.models import load_project

pytestmark = pytest.mark.e2e


def test_e2e_project_loads_v2(e2e_workspace) -> None:
    proj = load_project(e2e_workspace)
    assert proj.version == "2.0"
    assert len(proj.tracks) == 2
    assert len(proj.clips) == 2


def test_e2e_raw_audio_exists(e2e_workspace) -> None:
    proj = load_project(e2e_workspace)
    ws = proj.workspace_path()
    for track in proj.tracks:
        assert track.media
        wav = ws / track.media.path
        assert wav.is_file(), track.id
        assert wav.stat().st_size > 1000
