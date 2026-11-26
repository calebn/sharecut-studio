"""Viewer and Commenter links see the timeline of the version they hear (#3605).

``ReviewService.publish`` freezes a guest-sanitized view of the timeline next to
``mix.wav``; Viewer/Commenter guests are served that view (and the review WAV), while
Editors and the host stay live.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import stat
from pathlib import Path
from typing import Any

import pytest

from aligned_share_world import MOODY, UNCLE, AlignedShareWorld, build_aligned_share_world
from guest_helpers import mcp_ok, mcp_refusal
from podcast_mcp.gui import assembler
from podcast_mcp.models import load_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.review_versions import (
    review_artifacts_dir,
    version_timeline_snapshot,
)
from podcast_mcp.services.collaboration.share import ShareService, share_project_view
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role

FROZEN = "frozen_review_view"


@pytest.fixture
def world(tmp_path, tmp_workspace) -> AlignedShareWorld:
    return build_aligned_share_world(
        tmp_path,
        {
            "viewer": capabilities_for_role("viewer"),
            "commenter": capabilities_for_role("commenter"),
            "editor": capabilities_for_role("editor"),
            "viewer_mcp": capabilities_for_role("viewer", with_mcp=True),
            "commenter_mcp": capabilities_for_role("commenter", with_mcp=True),
            "editor_mcp": capabilities_for_role("editor", with_mcp=True),
        },
    )


def _api(world: AlignedShareWorld, link: str, suffix: str) -> str:
    return f"/api/review/{world.tokens[link]}/{suffix}"


def _project(world: AlignedShareWorld, link: str, phase: str = "full") -> dict[str, Any]:
    res = world.client.get(_api(world, link, f"daw/project?phase={phase}"))
    assert res.status_code == 200, res.text
    return res.json()


def _clip_count(view: dict[str, Any]) -> int:
    return sum(len(rows) for rows in view["clips"]["tracks"].values())


def _cut(world: AlignedShareWorld, word: int = UNCLE) -> None:
    res = world.host("EditSelectedRange", {"action": "cut", "targets": [world.target(word)]})
    assert res.status_code == 200, res.text


def _version_id(world: AlignedShareWorld) -> str:
    return load_project(world.path).review.versions[0].id


def _sidecar(world: AlignedShareWorld, version_id: str | None = None) -> Path:
    project = load_project(world.path)
    return review_artifacts_dir(project) / (version_id or _version_id(world)) / "timeline.json"


def _publish(world: AlignedShareWorld, label: str) -> dict[str, Any]:
    with write_grant(WriteGrantKind.DISPATCHER):
        ws = ProjectWorkspace.open(world.path)
        premix = ws.project.artifacts_dir() / "premix.wav"
        premix.write_bytes(premix.read_bytes() + b"\0\0" * 8)
        return ReviewService(ws).publish(label=label)


def _error_code(res) -> str | None:
    return res.headers.get("x-sharecut-error-code")


def _is_frozen_refusal(res) -> bool:
    return res.status_code == 403 and _error_code(res) == FROZEN


def _not_frozen_refusal(res) -> bool:
    return _error_code(res) != FROZEN


# 1. Viewer and Commenter get the published timeline; the Editor stays live.


@pytest.mark.parametrize("link", ["viewer", "commenter"])
def test_guest_keeps_the_published_timeline_while_the_host_edits(world, link):
    published = _clip_count(_project(world, link))
    _cut(world)
    assert _clip_count(_project(world, "editor")) > published
    assert _clip_count(_project(world, link)) == published
    assert _clip_count(_project(world, link, "clips")) == published
    state = world.client.get(_api(world, link, "daw/document/state?phase=full"))
    assert state.status_code == 200, state.text
    assert _clip_count(state.json()["project"]) == published


# 2. Phase slices are frozen; comments stay live.


def test_commenter_slices_are_frozen_and_comments_are_live(world):
    frozen_tracks = _project(world, "commenter", "tracks")
    frozen_clips = _project(world, "commenter", "clips")
    _cut(world)
    assert _project(world, "commenter", "tracks") == frozen_tracks
    assert _project(world, "commenter", "clips") == frozen_clips
    assert set(frozen_clips) >= {"clips", "tracks", "render_status"}
    posted = world.client.post(
        _api(world, "commenter", "comments"),
        json={"body": "new note", "author": "guest", "timeline_start": 1.0},
    )
    assert posted.status_code == 200, posted.text
    live = world.client.get(_api(world, "viewer", "daw/project?phase=comments")).json()
    assert [c["body"] for c in live["comments"]] == ["new note"]
    again = world.client.get(_api(world, "commenter", "daw/project?phase=full")).json()
    assert [c["body"] for c in again["comments"]] == ["new note"]


# 3. Follow-latest links move to the new snapshot; a pinned link keeps its own.


def test_follow_latest_serves_the_next_snapshot_and_pinned_keeps_the_first(world):
    published = _clip_count(_project(world, "viewer"))
    first = _version_id(world)
    with write_grant(WriteGrantKind.DISPATCHER):
        ws = ProjectWorkspace.open(world.path)
        follow = ShareService(ws).create(
            review_version_id=first,
            capabilities=capabilities_for_role("viewer"),
            follow_latest=True,
        )["token"]
    _cut(world)
    second = _publish(world, "after cut")
    assert _clip_count(_project(world, "editor")) > published
    followed = world.client.get(f"/api/review/{follow}/daw/project?phase=clips").json()
    assert _clip_count(followed) > published
    assert _clip_count(_project(world, "viewer", "clips")) == published
    assert version_timeline_snapshot(load_project(world.path), second["id"]) is not None


# 4. A version without a snapshot, or with a damaged one, falls back to live.


def test_missing_sidecar_serves_the_live_view(world):
    published = _clip_count(_project(world, "viewer"))
    _sidecar(world).unlink()
    _cut(world)
    assert _clip_count(_project(world, "viewer")) > published
    assert _project(world, "viewer", "full")["meta"]["name"]


def test_corrupt_sidecar_serves_live_and_warns(world, caplog):
    published = _clip_count(_project(world, "viewer"))
    path = _sidecar(world)
    path.write_text("{ not json")
    _cut(world)
    with caplog.at_level(logging.WARNING):
        assert _clip_count(_project(world, "viewer")) > published
    assert any("timeline" in r.getMessage().lower() for r in caplog.records)
    path.write_text(json.dumps({"format": 1, "view": "nope"}))
    assert _clip_count(_project(world, "viewer")) > published


# 5. The snapshot is private and sanitized.


def test_sidecar_is_private_and_free_of_host_paths(world, tmp_path):
    path = _sidecar(world)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    raw = path.read_text()
    assert str(tmp_path) not in raw
    assert "workspace_dir" not in raw
    assert "session_suggestions" not in raw
    stored = json.loads(raw)
    assert "comments" not in stored["view"]
    groups = (stored["view"].get("history") or {}).get("groups") or []
    assert groups == []


@pytest.mark.parametrize("link", ["viewer", "commenter"])
def test_served_snapshot_is_sanitized_again(world, link, tmp_path):
    body = json.dumps(_project(world, link, "full"))
    assert str(tmp_path) not in body
    assert "session_suggestions" not in body
    view = _project(world, link, "full")
    assert view["project_path"] == ""
    assert "workspace_dir" not in view["meta"]
    assert view["history"]["groups"] == []


def test_words_follow_the_role_not_the_snapshot(world):
    viewer = _project(world, "viewer", "full")["transcript"]["utterances"]
    assert viewer and all("words" not in u for u in viewer)
    state = world.client.get(_api(world, "commenter", "daw/document/state?phase=full")).json()
    commenter = state["project"]["transcript"]["utterances"]
    assert any(u.get("words") for u in commenter)


def test_duration_is_the_published_one(world, monkeypatch):
    from podcast_mcp.services.collaboration import share

    first = share_project_view(world.tokens["viewer"])["timeline_duration_sec"]
    monkeypatch.setattr(share, "timeline_duration_sec", lambda _project: first + 90.0)
    assert share_project_view(world.tokens["viewer"])["timeline_duration_sec"] == first
    assert share_project_view(world.tokens["commenter"])["timeline_duration_sec"] == first
    assert share_project_view(world.tokens["editor"])["timeline_duration_sec"] == first + 90.0


# 6. Audio: the review WAV for frozen premix; stem and processed are refused.


def test_frozen_premix_is_the_review_wav(world):
    version = load_project(world.path).review.versions[0]
    premix = load_project(world.path).artifacts_dir() / "premix.wav"
    premix.write_bytes(premix.read_bytes() + b"\1\1" * 64)
    viewer = world.client.get(_api(world, "viewer", "daw/audio?kind=premix"))
    assert viewer.status_code == 200
    assert hashlib.sha256(viewer.content).hexdigest() == version.sha256
    editor = world.client.get(_api(world, "editor", "daw/audio?kind=premix"))
    assert editor.status_code == 200
    assert hashlib.sha256(editor.content).hexdigest() != version.sha256
    track = load_project(world.path).tracks[0].id
    for kind in ("stem", "processed"):
        res = world.client.get(_api(world, "commenter", f"daw/audio?kind={kind}&track_id={track}"))
        assert _is_frozen_refusal(res), (kind, res.status_code, res.text)


# 7. WebSocket: no live patch, project or delta reaches a frozen guest.


def _frames_until(socket, done, *, limit: int = 60) -> list[dict[str, Any]]:
    seen: list[dict[str, Any]] = []
    for _ in range(limit):
        frame = socket.receive_json()
        seen.append(frame)
        if done(frame):
            return seen
    raise AssertionError("expected frame never arrived")


def _is_document(frame: dict[str, Any]) -> bool:
    return frame.get("plane") == "document"


def _carries_comment(frame: dict[str, Any], body: str) -> bool:
    snapshot = frame.get("snapshot") or {}
    return _is_document(frame) and any(c.get("body") == body for c in snapshot.get("comments", []))


def test_frozen_guest_socket_gets_comments_but_no_live_timeline(world):
    published = _clip_count(_project(world, "viewer"))
    with world.client.websocket_connect(_api(world, "viewer", "daw/ws")) as socket:
        hello = _frames_until(socket, lambda f: _is_document(f) and "snapshot" in f)
        _cut(world)
        posted = world.client.post(
            _api(world, "commenter", "comments"),
            json={"body": "ws note", "author": "guest", "timeline_start": 1.0},
        )
        assert posted.status_code == 200, posted.text
        frames = _frames_until(socket, lambda f: _carries_comment(f, "ws note"))
    for frame in [*hello[-1:], *frames]:
        if not _is_document(frame):
            continue
        for snapshot in (frame.get("snapshot") or {}, frame.get("_guest_snapshot") or {}):
            assert "patch" not in snapshot and "delta" not in snapshot, snapshot.keys()
            if "project" in snapshot:
                assert _clip_count(snapshot["project"]) == published


def test_frozen_hello_snapshot_is_the_published_timeline(world):
    published = _clip_count(_project(world, "commenter"))
    _cut(world)
    with world.client.websocket_connect(_api(world, "commenter", "daw/ws")) as socket:
        frames = _frames_until(socket, lambda f: _is_document(f) and "snapshot" in f)
    project = frames[-1]["snapshot"]["project"]
    assert _clip_count(project) == published


def test_editor_socket_still_gets_live_frames(world):
    with world.client.websocket_connect(_api(world, "editor", "daw/ws")) as socket:
        _frames_until(socket, lambda f: _is_document(f) and "snapshot" in f)
        _cut(world)
        frames = _frames_until(
            socket,
            lambda f: (
                _is_document(f)
                and any(k in (f.get("snapshot") or {}) for k in ("patch", "delta", "project"))
            ),
        )
    assert frames


# 8. Commands, range audio, previews, snap and proxies are refused for frozen guests.


def _command(world, link: str, type_: str, payload: dict[str, Any]):
    return world.guest(link, type_, payload)


def test_every_document_command_is_refused_for_a_frozen_commenter(world):
    suggested = _command(
        world,
        "commenter",
        "EditSelectedRange",
        {"action": "cut", "targets": [world.target(UNCLE)]},
    )
    assert _is_frozen_refusal(suggested), suggested.text
    assert load_project(world.path).edit_decisions == []
    other = _command(world, "commenter", "SetTrackFader", {"track_id": "x", "fader_db": -3.0})
    assert other.status_code in (400, 403) and _not_frozen_refusal(other)


def test_editor_commands_are_not_frozen_out(world):
    res = _command(
        world, "editor", "EditSelectedRange", {"action": "cut", "targets": [world.target(UNCLE)]}
    )
    assert res.status_code == 200, res.text


def test_frozen_read_paths_refuse_but_editor_paths_do_not_say_frozen(world):
    track = load_project(world.path).tracks[0].id
    target = world.target(UNCLE)
    gets = [
        "daw/waveform-snap?track_id={t}&start=0&end=1&timeline=true",
        "daw/pending-preview?edit_id=e1",
        "daw/pending-preview-image?edit_id=e1",
        "daw/audition-context?start=0&end=1",
        "daw/audition-context-image?start=0&end=1&track_id={t}",
        "daw/proxy/manifest",
        "daw/proxy/{t}/abc/0",
    ]
    for link in ("viewer", "commenter"):
        for path in gets:
            res = world.client.get(_api(world, link, path.format(t=track)))
            if link == "viewer" and "waveform-snap" in path:
                # A Viewer never holds EditSelectedRange, so the older refusal stays.
                assert res.status_code == 403
                continue
            assert _is_frozen_refusal(res), (link, path, res.status_code, res.text)
        ranged = world.client.post(_api(world, link, "daw/range-audio"), json={"target": target})
        assert _is_frozen_refusal(ranged), (link, ranged.status_code, ranged.text)
    for path in gets:
        res = world.client.get(_api(world, "editor", path.format(t=track)))
        assert _not_frozen_refusal(res), (path, res.status_code, res.text)
    ranged = world.client.post(_api(world, "editor", "daw/range-audio"), json={"target": target})
    assert _not_frozen_refusal(ranged)


# 8b. The guest MCP surface follows the same rules.


def _tool(world, link: str, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
    from guest_helpers import call_tool

    return call_tool(world, name, arguments, link)


def test_mcp_reads_are_frozen_and_actions_refused(world):
    published = _clip_count(_project(world, "viewer_mcp"))
    _cut(world)
    project = mcp_ok(_tool(world, "commenter_mcp", "guest_get_project"))
    assert _clip_count(project) == published
    live = mcp_ok(_tool(world, "editor_mcp", "guest_get_project"))
    assert _clip_count(live) > published

    code, _ = mcp_refusal(_tool(world, "commenter_mcp", "guest_pending_preview", {"edit_id": "e1"}))
    assert code == FROZEN
    code, _ = mcp_refusal(
        _tool(world, "viewer_mcp", "guest_audition_context", {"start": 0.0, "end": 1.0})
    )
    assert code == FROZEN
    command = world.mcp(
        "commenter_mcp",
        "EditSelectedRange",
        {"action": "cut", "targets": [world.target(MOODY)]},
    )
    code, _ = mcp_refusal(command)
    assert code == FROZEN
    editor = world.mcp(
        "editor_mcp", "EditSelectedRange", {"action": "cut", "targets": [world.target(MOODY)]}
    )
    assert "error" not in editor
    assert editor["result"]["structuredContent"].get("error_code") != FROZEN, editor


# 9. Publication: a failed snapshot leaves nothing; the snapshot builder is read-only.


def test_snapshot_failure_leaves_no_version_and_no_stage(world, monkeypatch):
    before = load_project(world.path)
    root = review_artifacts_dir(before)
    dirs_before = sorted(p.name for p in root.iterdir())

    def boom(*_a, **_k):
        raise RuntimeError("snapshot exploded")

    monkeypatch.setattr(assembler, "dump_project_projection", boom)
    with write_grant(WriteGrantKind.DISPATCHER):
        ws = ProjectWorkspace.open(world.path)
        with pytest.raises(RuntimeError, match="snapshot exploded"):
            ReviewService(ws).publish(label="never")
    after = load_project(world.path)
    assert [v.id for v in after.review.versions] == [v.id for v in before.review.versions]
    assert sorted(p.name for p in root.iterdir()) == dirs_before


def test_publish_snapshot_does_not_swap_or_write_the_live_project(world, monkeypatch):
    real = assembler.dump_project_projection
    seen: list[tuple[int, int, bytes, bytes]] = []

    def spy(source, **kwargs):
        project = source.project
        before = (id(project), source.path.read_bytes())
        out = real(source, **kwargs)
        seen.append((before[0], id(source.project), before[1], source.path.read_bytes()))
        return out

    monkeypatch.setattr(assembler, "dump_project_projection", spy)
    _publish(world, "spied")
    assert seen, "publish never built a snapshot"
    for id_before, id_after, bytes_before, bytes_after in seen:
        assert id_before == id_after
        assert bytes_before == bytes_after


def test_publish_leaves_the_in_memory_project_as_it_was(world):
    with write_grant(WriteGrantKind.DISPATCHER):
        ws = ProjectWorkspace.open(world.path)
        ws.project.combined_transcript = None
        project = ws.project
        ReviewService(ws).publish(label="cache check")
        assert ws.project is project
        assert project.combined_transcript is None


def test_stage_snapshot_writes_a_private_file(world):
    version_id = _publish(world, "second")["id"]
    path = _sidecar(world, version_id)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(path.parent).st_mode) == 0o700


# 10. The frozen render status is fresh even when the live premix is stale.


def test_frozen_render_status_is_not_stale_when_live_is(world):
    track = load_project(world.path).tracks[0].id
    moved = world.host("SetTrackFader", {"track_id": track, "fader_db": -6.0})
    assert moved.status_code == 200, moved.text
    live = _project(world, "editor", "clips")["render_status"]["premix"]
    assert live["is_stale"] is True
    frozen = _project(world, "viewer", "clips")["render_status"]["premix"]
    assert frozen["is_stale"] is False
    full = _project(world, "commenter", "full")["render_status"]["premix"]
    assert full["is_stale"] is False


# The reader never raises to guests.


def test_reader_returns_none_for_unknown_or_damaged_snapshots(world):
    project = load_project(world.path)
    assert version_timeline_snapshot(project, _version_id(world)) is not None
    _sidecar(world).write_text("[]")
    assert version_timeline_snapshot(project, _version_id(world)) is None
    assert version_timeline_snapshot(project, "nope") is None


def test_simple_project_publishes_and_serves_a_snapshot(minimal_project, sample_wav, tmp_workspace):
    from test_share_follow_latest import _publish_second, _seed_premix

    with write_grant(WriteGrantKind.DISPATCHER):
        ws = _seed_premix(minimal_project, sample_wav)
        first = ReviewService(ws).publish(label="Rough cut")
        second = _publish_second(ws, "Intro fix")
    project = load_project(minimal_project)
    for ver in (first, second):
        snap = version_timeline_snapshot(project, ver["id"])
        assert snap is not None and snap["view"]["tracks"] == []
