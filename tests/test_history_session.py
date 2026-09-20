from __future__ import annotations

from podcast_mcp.history.session import run_mutation
from podcast_mcp.models import EditDecision, EditDecisionType, load_project
from podcast_mcp.project_io import open_project


def test_run_mutation_records_history(minimal_project):
    path, proj = open_project(minimal_project)
    run_mutation(
        path,
        proj,
        "before",
        "after",
        lambda p: p.edit_decisions.append(
            EditDecision(
                id="x",
                track_id="host",
                type=EditDecisionType.REMOVE,
                start=0,
                end=1,
            )
        ),
    )
    loaded = load_project(path)
    assert len(loaded.edit_decisions) == 1
