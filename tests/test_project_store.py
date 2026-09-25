from __future__ import annotations

import json

from podcast_mcp.models import EpisodeProject, save_project
from podcast_mcp.project_store import ProjectStore, history_snapshot_ids, rollback_history


def test_load_repairs_missing_workspace_dir(tmp_path) -> None:
    ws = tmp_path / "fixture_ws"
    ws.mkdir()
    missing = tmp_path / "does_not_exist_yet"
    project = EpisodeProject.create("portable", str(missing))
    path = save_project(project, ws / "episode.project.json")
    store = ProjectStore(path)
    loaded = store.load()
    assert loaded.workspace_path() == ws.resolve()


def test_load_project_remaps_stale_absolute_workspace_dir(tmp_path) -> None:
    """Committed machine paths must not stick after load."""
    from podcast_mcp.models import load_project

    ws = tmp_path / "episode_ws"
    ws.mkdir()
    project = EpisodeProject.create("stale", "/Users/someone/elsewhere")
    path = save_project(project, ws / "episode.project.json")
    # Corrupt the on-disk path the way an old fixture might look.
    text = path.read_text(encoding="utf-8").replace(
        str(ws.resolve()),
        "/Users/someone/elsewhere",
    )
    path.write_text(text, encoding="utf-8")
    loaded = load_project(path)
    assert loaded.workspace_path() == ws.resolve()
    assert "/Users/someone" not in loaded.meta.workspace_dir


def test_rollback_history_restores_the_index_and_drops_only_new_snapshots(tmp_path):
    index_path = tmp_path / "history" / "index.json"
    snaps = index_path.parent / "snapshots"
    snaps.mkdir(parents=True)
    for entry_id in ("old", "new"):
        (snaps / f"{entry_id}.json").write_text("{}", encoding="utf-8")
    index_path.write_text('{"cursor": 1}', encoding="utf-8")
    assert history_snapshot_ids(index_path) == {"old", "new"}
    rollback_history(index_path, {"cursor": 0}, {"new"})
    assert json.loads(index_path.read_text(encoding="utf-8")) == {"cursor": 0}
    assert history_snapshot_ids(index_path) == {"old"}
    rollback_history(index_path, None, set())
    assert not index_path.exists()


def test_history_snapshot_ids_is_empty_without_a_snapshot_dir(tmp_path):
    assert history_snapshot_ids(tmp_path / "history" / "index.json") == set()
