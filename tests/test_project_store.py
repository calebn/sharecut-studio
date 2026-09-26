from __future__ import annotations

import json

import pytest

from podcast_mcp.models import EpisodeProject, save_project
from podcast_mcp.models.history import HistoryEntry, ProjectHistory
from podcast_mcp.project_store import (
    HISTORY_ENTRY_LIMIT,
    ProjectStore,
    history_index_path,
    history_index_to_restore,
    history_snapshot_ids,
    history_snapshots_dir,
    read_history_index,
    rollback_history,
    rollback_own_history,
)


def test_commit_skips_unchanged_history_index_and_repairs_corruption(minimal_project) -> None:
    store = ProjectStore(minimal_project)
    project = store.load()
    store.commit(project)
    index = history_index_path(project)
    before = index.stat().st_mtime_ns
    store.commit(project)
    assert index.stat().st_mtime_ns == before
    index.write_text("{broken", encoding="utf-8")
    store.commit(project)
    assert read_history_index(index) == project.history


def test_commit_skips_unchanged_transcript_cache_and_repairs_missing_mirror(
    minimal_project, monkeypatch
) -> None:
    from podcast_mcp.models import Transcript, TranscriptWord

    store = ProjectStore(minimal_project)
    project = store.load()
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="hello", start=0, end=1)])
    ]
    store.commit(project)
    cache = project.transcripts_dir() / "host.json"
    before = cache.stat().st_mtime_ns
    store.commit(project)
    assert cache.stat().st_mtime_ns == before
    cache.unlink()
    store.commit(project)
    assert cache.is_file()

    original = ProjectStore._write_cache_if_changed

    def fail_once(path, content):
        if path == cache:
            raise OSError("mirror failed")
        return original(path, content)

    project.transcripts[0].words[0].text = "updated"
    monkeypatch.setattr(ProjectStore, "_write_cache_if_changed", staticmethod(fail_once))
    with pytest.raises(OSError, match="mirror failed"):
        store.commit(project)
    monkeypatch.setattr(ProjectStore, "_write_cache_if_changed", staticmethod(original))
    store.commit(project)
    assert json.loads(cache.read_text())["words"][0]["text"] == "updated"


def test_commit_prunes_history_after_canonical_replace(minimal_project, monkeypatch) -> None:
    store = ProjectStore(minimal_project)
    project = store.load()
    index = history_index_path(project)
    snapshots = history_snapshots_dir(index)
    snapshots.mkdir(parents=True, exist_ok=True)
    entries = []
    for i in range(HISTORY_ENTRY_LIMIT // 2 + 2):
        for prefix in ("before", "after"):
            entry_id = f"{prefix}-{i}"
            path = snapshots / f"{entry_id}.json"
            path.write_text("{}")
            entries.append(
                HistoryEntry(id=entry_id, label=f"{prefix} edit {i}", snapshot_file=str(path))
            )
    project.history = ProjectHistory(cursor=len(entries) - 1, entries=entries)
    pending = snapshots / "pending-before.json"
    pending.write_text("{}")
    original_save = __import__("podcast_mcp.project_store", fromlist=["save_project"]).save_project

    def fail_save(*args, **kwargs):
        raise OSError("canonical replace failed")

    monkeypatch.setattr("podcast_mcp.project_store.save_project", fail_save)
    with pytest.raises(OSError, match="canonical replace failed"):
        store.commit(project)
    assert len(list(snapshots.glob("*.json"))) == len(entries) + 1
    monkeypatch.setattr("podcast_mcp.project_store.save_project", original_save)
    project.history = ProjectHistory(cursor=len(entries) - 1, entries=entries)
    store.commit(project)
    kept = project.history.entries
    assert len(kept) <= HISTORY_ENTRY_LIMIT
    assert kept[0].label.startswith("before ")
    assert kept[-1].label.startswith("after ")
    assert project.history.cursor == len(kept) - 1
    assert {p.stem for p in snapshots.glob("*.json")} == {
        *(entry.id for entry in kept),
        "pending-before",
    }


def test_history_prune_preserves_redo_tail(minimal_project) -> None:
    store = ProjectStore(minimal_project)
    project = store.load()
    entries = [
        HistoryEntry(id=str(i), label=f"step {i}", snapshot_file=f"history/snapshots/{i}.json")
        for i in range(HISTORY_ENTRY_LIMIT + 20)
    ]
    project.history = ProjectHistory(cursor=5, entries=entries)
    store.commit(project)
    assert project.history.cursor == 0
    assert project.history.entries[0].id == "5"
    assert project.history.entries[-1].id == entries[-1].id
    assert len(project.history.entries) > HISTORY_ENTRY_LIMIT


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


def test_read_history_index_missing_valid_and_corrupt(tmp_path) -> None:
    index_path = tmp_path / "history" / "index.json"
    assert read_history_index(index_path) is None
    index_path.parent.mkdir(parents=True)
    index_path.write_text(json.dumps(ProjectHistory().model_dump(mode="json")))
    assert read_history_index(index_path) == ProjectHistory()
    index_path.write_text("{not json")
    with pytest.raises(ValueError):
        read_history_index(index_path)
    index_path.write_text(json.dumps({"entries": "nope"}))
    with pytest.raises(ValueError):
        read_history_index(index_path)


def test_adopt_history_index_raises_on_a_corrupt_index(tmp_path) -> None:
    project = EpisodeProject.create("p", str(tmp_path))
    path = tmp_path / "episode.project.json"
    save_project(project, path)
    index_path = history_index_path(project)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text("{not json")
    with pytest.raises(ValueError):
        ProjectStore(path).adopt_history_index(project)
