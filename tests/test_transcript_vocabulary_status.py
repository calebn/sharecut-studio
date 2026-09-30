from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import Transcript, TranscriptWord, load_project, save_project
from podcast_mcp.project_store import ProjectStore
from podcast_mcp.services import ProjectWorkspace, TranscriptPrecorrectService
from podcast_mcp.transcript_context import TranscriptContext


def _client() -> TestClient:
    return TestClient(create_app(), raise_server_exceptions=False)


def _get(client: TestClient, path: Path):
    return client.get("/api/transcript/vocabulary", params={"path": str(path)})


def _expected(path: Path):
    return TranscriptPrecorrectService(ProjectWorkspace.open(path)).get_vocabulary()


@pytest.mark.parametrize("enabled", [True, False])
def test_status_complete_endpoint_parity_and_returned_lists_are_independent(
    minimal_project, enabled
) -> None:
    project = load_project(minimal_project)
    project.transcripts = [
        Transcript(track_id="host", vocabulary_revision="current", user_edited=True),
        Transcript(track_id="other", vocabulary_revision=None, user_edited=True),
        Transcript(track_id="host", vocabulary_revision="current", user_edited=True),
    ]
    save_project(project, minimal_project)
    TranscriptContext(
        terms=["Alpha"],
        guest_names=["Guest"],
        show_title="Example show",
        vocabulary_revision="current",
        transcribe={"initial_prompt": enabled, "initial_prompt_max_chars": 123},
    ).save(minimal_project.parent)
    expected = _expected(minimal_project)
    client = _client()
    assert _get(client, minimal_project).json() == expected
    result = TranscriptPrecorrectService.vocabulary_status(minimal_project)
    result["terms"].append("poison")
    result["guest_names"].clear()
    result["edited_tracks"].clear()
    assert TranscriptPrecorrectService.vocabulary_status(minimal_project) == expected
    assert _get(client, minimal_project).json() == expected
    assert expected["edited_tracks"] == ["host", "other"]
    assert expected["needs_retranscription"] is True


def test_hit_skips_full_load_and_canonicalizes_workspace_and_file(minimal_project, monkeypatch):
    expected = _expected(minimal_project)
    assert TranscriptPrecorrectService.vocabulary_status(minimal_project) == expected

    def unexpected_load(_self):
        raise AssertionError("Full project reloaded on a metadata hit")

    monkeypatch.setattr(ProjectStore, "load", unexpected_load)
    assert TranscriptPrecorrectService.vocabulary_status(minimal_project.parent) == expected
    assert _get(_client(), minimal_project).json() == expected


def test_changed_project_refreshes_revisions_and_edited_tracks(minimal_project):
    client = _client()
    assert _get(client, minimal_project).json()["edited_tracks"] == []
    ctx = TranscriptContext(vocabulary_revision="current")
    ctx.save(minimal_project.parent)
    project = load_project(minimal_project)
    project.transcripts = [
        Transcript(track_id="host", vocabulary_revision="current", user_edited=True)
    ]
    save_project(project, minimal_project)
    assert _get(client, minimal_project).json() == _expected(minimal_project)
    assert _get(client, minimal_project).json()["needs_retranscription"] is False
    project.transcripts[0].vocabulary_revision = "older"
    project.transcripts[0].user_edited = False
    save_project(project, minimal_project)
    response = _get(client, minimal_project).json()
    assert response["needs_retranscription"] is True
    assert response["edited_tracks"] == []


def test_same_size_same_mtime_in_place_change_invalidates_by_ctime(minimal_project):
    project = load_project(minimal_project)
    project.transcripts = [Transcript(track_id="host", vocabulary_revision="alpha")]
    save_project(project, minimal_project)
    TranscriptContext(vocabulary_revision="alpha").save(minimal_project.parent)
    client = _client()
    assert _get(client, minimal_project).json()["needs_retranscription"] is False
    before = minimal_project.stat()
    text = minimal_project.read_text().replace(
        '"vocabulary_revision": "alpha"', '"vocabulary_revision": "bravo"'
    )
    minimal_project.write_text(text)
    os.utime(minimal_project, ns=(before.st_atime_ns, before.st_mtime_ns))
    after = minimal_project.stat()
    assert (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns)
    assert after.st_ctime_ns != before.st_ctime_ns
    assert _get(client, minimal_project).json()["needs_retranscription"] is True


def test_context_is_read_fresh_including_invalidity_and_show_layer(minimal_project):
    client = _client()
    _get(client, minimal_project)
    show = minimal_project.parent / "show_glossary.yaml"
    show.write_text('show_title: "New title"\nterms: [Beta]\n')
    response = _get(client, minimal_project)
    assert response.json()["show_title"] == "New title"
    assert response.json()["terms"] == ["Beta"]
    TranscriptContext(
        show_title="Episode",
        vocabulary_revision="new",
        terms=["Gamma"],
        transcribe={"initial_prompt": False, "initial_prompt_max_chars": 42},
    ).save(minimal_project.parent)
    assert _get(client, minimal_project).json() == _expected(minimal_project)
    assert _get(client, minimal_project).json()["prompt_limit"] is None
    (minimal_project.parent / "transcript_context.yaml").write_text("terms: [broken")
    assert _get(client, minimal_project).status_code == 500


@pytest.mark.parametrize("corrupt", ["json", "version", "meta", "word", "revision"])
def test_changed_invalid_project_preserves_endpoint_failure(minimal_project, corrupt):
    project = load_project(minimal_project)
    project.transcripts = [
        Transcript(track_id="host", words=[TranscriptWord(text="Hi", start=0, end=1)])
    ]
    save_project(project, minimal_project)
    client = _client()
    assert _get(client, minimal_project).status_code == 200
    data = json.loads(minimal_project.read_text())
    if corrupt == "version":
        data["version"] = "1.0"
    if corrupt == "meta":
        data["meta"] = None
    if corrupt == "word":
        data["transcripts"]["per_track"][0]["words"][0]["start"] = "bad"
    if corrupt == "revision":
        data["transcripts"]["per_track"][0]["vocabulary_revision"] = []
    minimal_project.write_text("{broken" if corrupt == "json" else json.dumps(data))
    with pytest.raises(ValueError):
        _expected(minimal_project)
    assert _get(client, minimal_project).status_code == 500


def test_history_index_appearance_change_and_removal_invalidate(minimal_project):
    client = _client()
    expected = _get(client, minimal_project).json()
    index = minimal_project.parent / "history" / "index.json"
    index.parent.mkdir(exist_ok=True)
    index.write_text("{broken")
    assert _get(client, minimal_project).status_code == 500
    index.write_text('{"entries":[],"cursor":-1}')
    assert _get(client, minimal_project).json() == expected
    index.write_text("{broken")
    assert _get(client, minimal_project).status_code == 500
    index.unlink()
    assert _get(client, minimal_project).json() == expected


def test_concurrent_file_change_during_load_is_not_cached(minimal_project, monkeypatch):
    original = ProjectStore.load
    calls = 0

    def racing_load(store):
        nonlocal calls
        calls += 1
        loaded = original(store)
        if calls == 1:
            newer = load_project(minimal_project)
            newer.transcripts = [Transcript(track_id="new", user_edited=True)]
            save_project(newer, minimal_project)
        return loaded

    monkeypatch.setattr(ProjectStore, "load", racing_load)
    assert TranscriptPrecorrectService.vocabulary_status(minimal_project)["edited_tracks"] == []
    assert TranscriptPrecorrectService.vocabulary_status(minimal_project)["edited_tracks"] == [
        "new"
    ]
    assert calls == 2
    assert TranscriptPrecorrectService.vocabulary_status(minimal_project)["edited_tracks"] == [
        "new"
    ]
    assert calls == 2


def test_metadata_cache_is_bounded_without_retaining_live_projects(
    minimal_project, tmp_path, monkeypatch
):
    original = ProjectStore.load
    calls = []

    def counted_load(store):
        calls.append(store.project_path)
        return original(store)

    monkeypatch.setattr(ProjectStore, "load", counted_load)
    first = ProjectStore(minimal_project)
    state = first.transcript_vocabulary_state()
    assert state.workspace == minimal_project.parent.resolve()
    project = load_project(minimal_project)
    for index in range(17):
        path = tmp_path / f"other-{index}" / "episode.project.json"
        save_project(project, path)
        ProjectStore(path).transcript_vocabulary_state()
    last = ProjectStore(path)
    last.transcript_vocabulary_state()
    assert len(calls) == 18
    first.transcript_vocabulary_state()
    assert len(calls) == 19


def test_cache_preserves_history_adoption(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.mutate("before test", "after test", lambda p: setattr(p.meta, "name", "Changed"))
    project = load_project(minimal_project)
    project.history.entries = []
    project.history.cursor = -1
    save_project(project, minimal_project)
    assert ProjectStore(minimal_project).load().history.entries
    expected = _expected(minimal_project)
    assert TranscriptPrecorrectService.vocabulary_status(minimal_project) == expected
    assert TranscriptPrecorrectService.vocabulary_status(minimal_project) == expected


def test_file_disappearing_after_load_returns_snapshot_without_cache(minimal_project, monkeypatch):
    original = ProjectStore.load

    def removed_after_load(store):
        loaded = original(store)
        minimal_project.unlink()
        return loaded

    monkeypatch.setattr(ProjectStore, "load", removed_after_load)
    result = TranscriptPrecorrectService.vocabulary_status(minimal_project)
    assert result["edited_tracks"] == []
    with pytest.raises(FileNotFoundError):
        TranscriptPrecorrectService.vocabulary_status(minimal_project)


def test_cache_miss_preserves_app_busy_error_mapping(minimal_project, monkeypatch):
    from filelock import Timeout

    def busy(_store):
        raise Timeout("/private/lock")

    monkeypatch.setattr(ProjectStore, "load", busy)
    response = _get(_client(), minimal_project)
    assert response.status_code == 503
    assert response.headers["x-sharecut-error-code"] == "project_busy"
    assert "/private/lock" not in response.text


def test_cached_status_keeps_missing_and_pinned_path_gates(minimal_project, tmp_path):
    from podcast_mcp.models import EpisodeProject

    other = tmp_path / "other" / "episode.project.json"
    save_project(EpisodeProject.create("other", str(other.parent)), other)
    TranscriptPrecorrectService.vocabulary_status(other)
    app = create_app()
    app.state.served_project = minimal_project
    client = TestClient(app)
    assert _get(client, other).status_code == 403
    assert _get(client, tmp_path / "missing.json").status_code == 404


def test_workspace_with_symlinked_project_keeps_canonical_context(minimal_project, tmp_path):
    alias = tmp_path / "alias"
    alias.mkdir()
    (alias / "episode.project.json").symlink_to(minimal_project)
    TranscriptContext(show_title="Canonical").save(minimal_project.parent)
    TranscriptContext(show_title="Alias").save(alias)
    expected = _expected(alias)
    assert expected["show_title"] == "Canonical"
    assert TranscriptPrecorrectService.vocabulary_status(alias) == expected
    assert TranscriptPrecorrectService.vocabulary_status(minimal_project) == expected


def test_unreadable_unused_history_signature_uses_uncached_full_loader(
    minimal_project, monkeypatch
):
    import podcast_mcp.project_store as store_module

    ws = ProjectWorkspace.open(minimal_project)
    ws.mutate("before test", "after test", lambda p: setattr(p.meta, "name", "Changed"))
    assert load_project(minimal_project).history.entries
    expected = _expected(minimal_project)
    index = minimal_project.parent / "history" / "index.json"
    original_signature = store_module._file_signature
    original_read = Path.read_text
    original_load = ProjectStore.load
    loads = 0

    def signature(path):
        if path == index:
            raise PermissionError("History directory inaccessible")
        return original_signature(path)

    def read(path, *args, **kwargs):
        if path == index:
            raise AssertionError("Authoritative loader should not read unused history")
        return original_read(path, *args, **kwargs)

    def load(store):
        nonlocal loads
        loads += 1
        return original_load(store)

    monkeypatch.setattr(store_module, "_file_signature", signature)
    monkeypatch.setattr(Path, "read_text", read)
    monkeypatch.setattr(ProjectStore, "load", load)
    client = _client()
    for _ in range(2):
        response = _get(client, minimal_project)
        assert response.status_code == 200
        assert response.json() == expected
    assert loads == 2


def test_unreadable_required_history_still_raises_from_full_loader(minimal_project, monkeypatch):
    import podcast_mcp.project_store as store_module

    assert load_project(minimal_project).history.is_empty()
    index = minimal_project.parent / "history" / "index.json"
    original_signature = store_module._file_signature
    original_read = Path.read_text

    def signature(path):
        if path == index:
            raise PermissionError("History directory inaccessible")
        return original_signature(path)

    def read(path, *args, **kwargs):
        if path == index:
            raise PermissionError("History directory inaccessible")
        return original_read(path, *args, **kwargs)

    monkeypatch.setattr(store_module, "_file_signature", signature)
    monkeypatch.setattr(Path, "read_text", read)
    with pytest.raises(ValueError, match="unreadable JSON sidecar"):
        _expected(minimal_project)
    with pytest.raises(ValueError, match="unreadable JSON sidecar"):
        TranscriptPrecorrectService.vocabulary_status(minimal_project)
    assert _get(_client(), minimal_project).status_code == 500
