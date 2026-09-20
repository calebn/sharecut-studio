from __future__ import annotations

from podcast_mcp.models import EpisodeProject, save_project
from podcast_mcp.project_store import ProjectStore


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
