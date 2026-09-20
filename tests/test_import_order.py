from __future__ import annotations

import subprocess
import sys

import pytest

# Modules that have previously broken when imported as the very first thing in a
# fresh process (before anything else has "warmed" the module graph in a safe
# order). Regular pytest runs never catch this: by the time these tests import
# anything, other test files have usually already imported the package in some
# safe order, hiding the cycle. Each check below runs in a genuinely fresh
# subprocess so it reproduces the real failure mode.
#
# Root cause (fixed): engines/timeline_render.py used to import clip_timeline_end
# from edits/clips_ops.py, which (via the edits package __init__) transitively
# imports edits/cut_quality.py and edits/audio_cache.py, both of which import
# back from engines/audio_audit.py -- a real cycle if audio_audit.py (or anything
# that imports engines/timemap.py, which imports engines/timeline_render.py) is
# the first module touched. Fixed by moving the trivial clip_timeline_end
# calculation onto Clip.timeline_end (models/episode.py), which has no
# dependency on edits/ at all -- see models/episode.py::Clip.timeline_end.
COLD_IMPORT_TARGETS = [
    "podcast_mcp.engines.audio_audit",
    "podcast_mcp.engines.timeline_render",
    "podcast_mcp.engines.timemap",
    "podcast_mcp.edits.cut_quality",
    "podcast_mcp.edits.audio_cache",
    "podcast_mcp.edits.inaudible_cuts",
    "podcast_mcp.edits.breath_detect",
    "podcast_mcp.edits.fillers",
    "podcast_mcp.edits.tighten",
    "podcast_mcp.edits",
    "podcast_mcp.mcp.server",
    "podcast_mcp.cli.main",
]


@pytest.mark.parametrize("module", COLD_IMPORT_TARGETS)
def test_module_imports_cleanly_as_first_import_in_fresh_process(module: str):
    result = subprocess.run(
        [sys.executable, "-c", f"import {module}"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, (
        f"cold import of {module!r} failed (likely a circular import "
        f"reintroduced):\n{result.stderr}"
    )
