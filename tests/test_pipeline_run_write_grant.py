"""A pipeline run saves its steps under a write grant (#3827).

``align_tracks`` flags word starts its own track clips and leaves an "Align tracks" comment on
each; those comments reach ``episode.sharecut`` through the run's step saves. A run started with
no grant of its own saves under ``legacy_pipeline_run``; one started inside a grant keeps it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.project import store
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from test_clipped_onsets import _align, _gated_ws, _onset_comments


@pytest.fixture
def gated(tmp_path: Path) -> ProjectWorkspace:
    with write_grant(WriteGrantKind.DISPATCHER):
        ws, _clipped = _gated_ws(tmp_path)
    store.reset_write_counts_for_tests()
    return ws


def test_an_align_run_with_no_grant_saves_its_clipped_start_comments(
    gated: ProjectWorkspace,
) -> None:
    assert store.active_write_grant() is None

    _align(gated)

    assert len(_onset_comments(gated)) == 1
    saved = ProjectWorkspace.open(gated.path)
    assert _onset_comments(saved) == _onset_comments(gated)
    counts = store.write_counts()
    assert counts.get(WriteGrantKind.LEGACY_PIPELINE_RUN.value, 0) > 0
    assert "unscoped" not in counts


def test_an_align_run_inside_a_grant_keeps_that_grant(gated: ProjectWorkspace) -> None:
    with write_grant(WriteGrantKind.LEGACY_MCP):
        _align(gated)

    assert len(_onset_comments(ProjectWorkspace.open(gated.path))) == 1
    counts = store.write_counts()
    assert counts.get(WriteGrantKind.LEGACY_MCP.value, 0) > 0
    assert WriteGrantKind.LEGACY_PIPELINE_RUN.value not in counts
