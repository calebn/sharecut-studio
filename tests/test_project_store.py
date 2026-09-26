from __future__ import annotations

import json

from podcast_mcp.models import EpisodeProject, save_project
from podcast_mcp.project_store import (
    ProjectStore,
    history_index_to_restore,
    history_snapshot_ids,
    history_snapshots_dir,
    rollback_history,
    rollback_own_history,
)


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
    snaps = history_snapshots_dir(index_path)
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


def _index(*ids: str) -> dict:
    return {"entries": [{"id": i} for i in ids], "cursor": len(ids) - 1}


def _write_index(index_path, payload) -> None:
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(payload))


def _snapshot(index_path, entry_id: str) -> None:
    snaps = history_snapshots_dir(index_path)
    snaps.mkdir(parents=True, exist_ok=True)
    (snaps / f"{entry_id}.json").write_text("{}")


def test_rollback_own_history_restores_an_index_only_this_call_wrote(tmp_path) -> None:
    index_path = tmp_path / "history" / "index.json"
    before, mine = _index("a"), _index("a", "b")
    _write_index(index_path, mine)
    _snapshot(index_path, "b")
    assert rollback_own_history(index_path, before, [mine], ["b"]) is True
    assert json.loads(index_path.read_text()) == before
    assert history_snapshot_ids(index_path) == set()


def test_rollback_own_history_leaves_another_writers_index_alone(tmp_path) -> None:
    index_path = tmp_path / "history" / "index.json"
    other = _index("a", "b", "c")
    _write_index(index_path, other)
    _snapshot(index_path, "b")
    assert rollback_own_history(index_path, _index("a"), [_index("a", "b")], ["b"]) is False
    assert json.loads(index_path.read_text()) == other
    assert history_snapshot_ids(index_path) == {"b"}


def test_rollback_own_history_drops_orphan_snapshots_when_index_unchanged(tmp_path) -> None:
    index_path = tmp_path / "history" / "index.json"
    before = _index("a")
    _write_index(index_path, before)
    _snapshot(index_path, "b")
    assert rollback_own_history(index_path, before, [], ["b"]) is True
    assert history_snapshot_ids(index_path) == set()
    assert rollback_own_history(index_path, before, [], []) is True
    assert json.loads(index_path.read_text()) == before


def test_history_index_to_restore_missing_and_unreadable(tmp_path, caplog) -> None:
    from podcast_mcp.models.history import ProjectHistory

    index_path = tmp_path / "history" / "index.json"
    fallback = ProjectHistory()
    assert history_index_to_restore(index_path, fallback) is None
    index_path.parent.mkdir(parents=True)
    index_path.write_text("{not json")
    with caplog.at_level("WARNING"):
        assert history_index_to_restore(index_path, fallback) == fallback.model_dump(mode="json")
    assert "Unreadable" in caplog.text
