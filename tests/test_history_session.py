from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Event

from podcast_mcp.history.session import run_mutation
from podcast_mcp.models import EditDecision, EditDecisionType, load_project
from podcast_mcp.project_io import open_project
from podcast_mcp.util.project_state import project_state_lock, snapshot_project


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


def test_render_snapshot_waits_for_mutation_to_commit(minimal_project):
    path, project = open_project(minimal_project)
    halfway = Event()
    finish = Event()
    taking_snapshot = Event()

    def edit(live):
        live.name = "intermediate"
        halfway.set()
        assert finish.wait(2)
        live.name = "committed"

    def copy_when_started():
        taking_snapshot.set()
        return snapshot_project(project)

    with ThreadPoolExecutor(max_workers=2) as pool:
        mutation = pool.submit(run_mutation, path, project, "before", "after", edit)
        assert halfway.wait(2)
        snapshot = pool.submit(copy_when_started)
        assert taking_snapshot.wait(2)
        assert not snapshot.done()
        finish.set()
        mutation.result(timeout=2)
        copied = snapshot.result(timeout=2)

    assert copied.name == "committed"


def test_render_and_document_snapshots_share_workspace_lock(minimal_project):
    from podcast_mcp.services.document_sync.service import document_submit_lock

    _, first = open_project(minimal_project)
    _, second = open_project(minimal_project)
    assert first is not second
    assert project_state_lock(first) is project_state_lock(second)
    assert project_state_lock(first) is document_submit_lock(first)
