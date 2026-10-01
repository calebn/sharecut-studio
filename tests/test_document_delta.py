from __future__ import annotations

import json
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.gui.assembler import projection_dependencies
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    Transcript,
    TranscriptWord,
    save_project,
)
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.projection_delta import diff_projection
from podcast_mcp.services.document_sync.service import host_document_event
from podcast_mcp.services.document_sync.snapshot_cache import (
    SnapshotCache,
    SnapshotKey,
    state_token,
)
from podcast_mcp.services.share import sanitize_guest_document_event


def command(kind: str, payload: dict, seq: int = 1, client: str = "delta-test") -> DocumentCommand:
    return DocumentCommand(
        type=kind, payload=payload, client_id=client, role="host", client_seq=seq
    )


def comment(seq: int = 1, client: str = "delta-test") -> DocumentCommand:
    return command(
        "AddComment", {"body": f"comment {seq}", "author": "test", "timeline_start": 0}, seq, client
    )


def rewrite_in_place(path: Path, old: str, new: str) -> None:
    stat = path.stat()
    original = path.read_bytes()
    changed = original.replace(old.encode(), new.encode())
    assert changed != original and len(changed) == len(original)
    with path.open("r+b") as handle:
        handle.write(changed)
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert path.stat().st_ino == stat.st_ino
    assert path.stat().st_size == stat.st_size
    assert path.stat().st_mtime_ns == stat.st_mtime_ns


def test_delta_is_sequenced_and_retry_is_fresh_replacement(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    before = svc.document_snapshot()
    first = svc.submit(comment())
    delta = first["snapshot"]["delta"]
    assert delta["base_seq"] == 0
    assert delta["base_token"] == before["state_token"]
    assert first["snapshot"]["server_seq"] == 1
    assert delta["audience"] == "host"
    assert "project" not in first["snapshot"]
    assert "comments" not in first["snapshot"]
    svc.submit(comment(2))
    retry = svc.submit(comment())
    assert retry["idempotent"] and retry["command"]["server_seq"] == 1
    assert retry["server_seq"] == 1 and retry["snapshot"]["server_seq"] == 2
    assert len(retry["snapshot"]["project"]["comments"]) == 2
    assert "delta" not in retry["snapshot"]


def test_shell_and_detail_share_certified_state_basis(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    assert (
        svc.document_snapshot()["state_token"]
        == svc.document_snapshot(projection="detail")["state_token"]
    )


def test_ctime_detects_and_adopts_same_inode_restored_mtime_write(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    before = svc.document_snapshot()
    rewrite_in_place(minimal_project, "test_episode", "next_episode")
    after = svc.document_snapshot()
    assert after["project"]["meta"]["name"] == "next_episode"
    assert after["server_seq"] == before["server_seq"]
    assert after["file"] == before["file"]
    assert after["state_token"] != before["state_token"]
    result = svc.submit(comment())
    assert result["snapshot"]["delta"]["base_token"] == after["state_token"]


def test_artifact_and_history_certification_include_ctime(minimal_project):
    from podcast_mcp.engines.play_audit import premix_hash_path
    from podcast_mcp.project_store import history_index_path

    svc = DocumentSyncService.open(minimal_project)
    svc.submit(comment())
    for artifact in (premix_hash_path(svc.project), history_index_path(svc.project)):
        artifact.parent.mkdir(parents=True, exist_ok=True)
        if not artifact.exists():
            artifact.write_text("aaaa")
        before = projection_dependencies(svc.ws)
        stat = artifact.stat()
        with artifact.open("r+b") as handle:
            data = handle.read()
            handle.seek(0)
            handle.write(data)
        os.utime(artifact, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        assert projection_dependencies(svc.ws) != before


def test_cache_is_immutable_bounded_and_projection_specific(tmp_path):
    key = SnapshotKey("episode", (1, 2, 3, 4, 5), 0, "shell", ())
    cache = SnapshotCache(entries=2, bytes_limit=300)
    assert cache.put(key, {"value": [1]})
    copy = cache.get(key)
    copy["value"].append(2)
    assert cache.get(key) == {"value": [1]}
    assert cache.get(replace(key, projection="detail")) is None
    assert cache.get(replace(key, head=1)) is None
    assert cache.get(replace(key, revision=(1, 2, 3, 4, 6))) is None
    assert not cache.put(replace(key, path="oversize"), {"text": "x" * 301})
    for n in range(3):
        cache.put(replace(key, path=str(n)), {"text": "x" * 100})
    assert cache.get(key) is None
    assert cache.get(replace(key, path="0")) is None
    assert cache.get(replace(key, path="2")) is not None
    assert state_token(key) == state_token(replace(key, projection="detail"))
    assert len(state_token(key)) == 64


def test_warm_submit_reuses_only_committed_certified_projection(minimal_project):
    from podcast_mcp.services.document_sync.snapshot_cache import snapshot_cache

    svc = DocumentSyncService.open(minimal_project)
    actual_get = snapshot_cache.get
    hits = []

    def lookup(key):
        value = actual_get(key)
        hits.append(value is not None)
        return value

    with patch.object(snapshot_cache, "get", side_effect=lookup) as get:
        svc.submit(comment())
        first = get.call_args.args[0]
        svc.submit(comment(2))
        second = get.call_args.args[0]
        assert second.head == first.head + 1
        assert hits == [False, True]
        assert second.revision != first.revision
        svc.submit(command("AddChapter", {"time": 0, "title": "Chapter"}, 3))
        assert get.call_args.args[0].projection != second.projection


def test_crash_saved_command_repairs_before_snapshot_and_next_delta(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    with patch.object(
        svc.store, "append_and_apply", side_effect=sqlite3.OperationalError("failed journal")
    ):
        with pytest.raises(sqlite3.OperationalError):
            svc.submit(comment())
    reopened = DocumentSyncService.open(minimal_project)
    repaired = reopened.document_snapshot()
    assert repaired["server_seq"] == 1
    assert len(repaired["project"]["comments"]) == 1
    reply = reopened.submit(comment(2))
    assert reply["snapshot"]["delta"]["base_seq"] == 1
    assert reply["snapshot"]["delta"]["base_token"] == repaired["state_token"]
    assert len(reopened.document_snapshot()["project"]["comments"]) == 2


def test_concurrent_writers_chain_actual_predecessor(minimal_project):
    services = [DocumentSyncService.open(minimal_project) for _ in range(2)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(
            pool.map(
                lambda pair: pair[1].submit(comment(client=f"client{pair[0]}")), enumerate(services)
            )
        )
    replies.sort(key=lambda result: result["server_seq"])
    assert [reply["snapshot"]["delta"]["base_seq"] for reply in replies] == [0, 1]
    assert replies[1]["snapshot"]["delta"]["base_token"] == replies[0]["snapshot"]["state_token"]
    assert len(services[0].document_snapshot()["project"]["comments"]) == 2


def test_guest_delta_is_diffed_after_sanitization_and_host_variant_is_private(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    with patch("podcast_mcp.services.document_sync.service.get_hub") as hub:
        result = svc.submit(comment(), audience="guest")
        event = hub.return_value.publish.call_args.args[1]
    guest = sanitize_guest_document_event(event)
    assert guest["snapshot"]["delta"]["audience"] == "guest"
    assert guest["snapshot"] == result["snapshot"]
    sections = {operation["section"] for operation in guest["snapshot"]["delta"]["operations"]}
    assert not sections.intersection({"history", "history_groups", "history_entries"})
    assert "_guest_snapshot" not in guest
    assert "_guest_snapshot" not in host_document_event(event)
    assert str(minimal_project.parent) not in json.dumps(guest)
    assert sanitize_guest_document_event(host_document_event(event))["snapshot"]["resync"] is True


def test_undo_and_external_mutations_remain_replacements(minimal_project):
    svc = DocumentSyncService.open(minimal_project)
    svc.submit(comment())
    undo = svc.submit(command("UndoHistory", {}, 2))
    assert "project" in undo["snapshot"] and "delta" not in undo["snapshot"]
    external = svc.publish_document_changed()
    assert "project" in external["snapshot"] and "delta" not in external["snapshot"]


def test_snapshot_rejects_dependencies_changed_during_assembly(minimal_project):
    from podcast_mcp.gui.assembler import dump_project_projection

    svc = DocumentSyncService.open(minimal_project)

    def changed(*args, **kwargs):
        result = dump_project_projection(*args, **kwargs)
        rewrite_in_place(minimal_project, "test_episode", "next_episode")
        return result

    with patch("podcast_mcp.gui.assembler.dump_project_projection", side_effect=changed):
        snapshot = svc.document_snapshot()
    assert snapshot == {"server_seq": 0, "resync": True}


def test_real_large_clip_move_and_word_edit_have_bounded_payload(tmp_path):
    for size in (100, 10_000):
        project = EpisodeProject.create("clips", str(tmp_path / str(size)))
        project.ensure_dirs()
        project.tracks = [
            Track(
                id="host",
                label="Host",
                role="dialogue",
                media=MediaAsset(path="raw/host.wav", duration_sec=size),
            )
        ]
        project.clips = [
            Clip(
                id=f"c{i}",
                track_id="host",
                source_start=i * 0.2,
                source_end=i * 0.2 + 0.1,
                timeline_start=i * 0.2,
            )
            for i in range(size)
        ]
        svc = DocumentSyncService.open(save_project(project))
        result = svc.submit(
            command(
                "MoveClips",
                {"clips": [{"clip_id": "c1", "track_id": "host", "timeline_start": size * 0.2}]},
            )
        )
        assert len(json.dumps(result["snapshot"]["delta"]).encode()) < 8 * 1024
    project = EpisodeProject.create("words", str(tmp_path / "words"))
    project.ensure_dirs()
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role="dialogue",
            media=MediaAsset(path="raw/host.wav", duration_sec=1100),
        )
    ]
    project.clips = [
        Clip(id="c", track_id="host", source_start=0, source_end=1100, timeline_start=0)
    ]
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text=f"w{i}", start=i * 0.2, end=i * 0.2 + 0.15) for i in range(5000)
            ],
        )
    ]
    rebuild_combined(project)
    svc = DocumentSyncService.open(save_project(project))
    result = svc.submit(
        command(
            "CorrectTranscriptWord",
            {"track_id": "host", "word_index": 2500, "text": "changed", "expected_text": "w2500"},
        )
    )
    assert len(json.dumps(result["snapshot"]["delta"]).encode()) < 4 * 1024


def test_repeated_identity_matching_has_bounded_work():
    before = {"chapters": [{"time": 1, "title": "A"}, {"time": 1, "title": "B"}] * 2000}
    after = {"chapters": [{"time": 1, "title": "B"}, {"time": 1, "title": "A"}] * 2000}
    with patch(
        "podcast_mcp.services.document_sync.projection_delta.SequenceMatcher",
        side_effect=AssertionError("quadratic matcher"),
    ):
        result = diff_projection(before, after)
    assert len(result) == 1 and result[0]["before_count"] == 4000


def test_atomic_state_route_preserves_loopback_launch_and_state_identity(minimal_project):
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app(served_project=None), client=("127.0.0.1", 50000))
    response = client.get("/api/document/state", params={"path": str(minimal_project)})
    assert response.status_code == 200
    before = response.json()
    assert before["server_seq"] == 0
    assert client.app.state.served_project == minimal_project.resolve()
    svc = DocumentSyncService.open(minimal_project)
    reply = svc.submit(comment())
    response = client.get(
        "/api/document/state", params={"path": str(minimal_project), "phase": "full"}
    )
    assert response.status_code == 200
    after = response.json()
    assert after["server_seq"] == reply["snapshot"]["server_seq"]
    assert after["state_token"] == reply["snapshot"]["state_token"]
    assert after["project"]["comments"][0]["body"] == "comment 1"
    assert (
        client.get(
            "/api/document/state", params={"path": str(minimal_project), "phase": "unknown"}
        ).status_code
        == 422
    )


def test_certificate_is_checked_after_waiting_for_project_ownership(minimal_project):
    from contextlib import contextmanager
    from threading import Event

    from podcast_mcp.util.project_state import project_commit_lock

    svc = DocumentSyncService.open(minimal_project)
    svc.document_snapshot()
    waiting = Event()

    @contextmanager
    def observed_lock(project):
        waiting.set()
        with project_commit_lock(project):
            yield

    with ThreadPoolExecutor(max_workers=1) as pool:
        with project_commit_lock(svc.project):
            with patch("podcast_mcp.services.app.workspace.project_commit_lock", observed_lock):
                future = pool.submit(svc.document_snapshot)
                assert waiting.wait(timeout=2)
                rewrite_in_place(minimal_project, "test_episode", "next_episode")
        snapshot = future.result(timeout=5)
    assert snapshot["project"]["meta"]["name"] == "next_episode"


def test_uncertified_raw_write_during_projection_is_reloaded_on_recovery(minimal_project):
    from podcast_mcp.gui.assembler import dump_project_projection

    svc = DocumentSyncService.open(minimal_project)
    svc.document_snapshot()

    def concurrent_raw_write(*args, **kwargs):
        projection = dump_project_projection(*args, **kwargs)
        rewrite_in_place(minimal_project, "test_episode", "next_episode")
        return projection

    with patch("podcast_mcp.gui.assembler.dump_project_projection", concurrent_raw_write):
        assert svc.document_snapshot()["resync"] is True
    recovered = svc.document_snapshot()
    assert recovered["project"]["meta"]["name"] == "next_episode"


def test_open_does_not_certify_a_write_that_raced_the_initial_load(minimal_project):
    from podcast_mcp.services.app.workspace import ProjectWorkspace

    original = ProjectWorkspace.open

    def raced(path):
        ws = original(path)
        rewrite_in_place(minimal_project, "test_episode", "next_episode")
        return ws

    with patch.object(ProjectWorkspace, "open", side_effect=raced):
        service = DocumentSyncService.open(minimal_project)
    assert service.document_snapshot()["project"]["meta"]["name"] == "next_episode"


@pytest.mark.parametrize("name", ["small-move", "small-word", "small-regroup"])
def test_producer_matches_captured_real_command_vectors(name):
    fixture = Path(__file__).parent / "fixtures" / "document_delta" / f"{name}.json"
    vector = json.loads(fixture.read_text())
    assert diff_projection(vector["before"], vector["after"]) == vector["delta"]["operations"]
