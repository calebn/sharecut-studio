"""What one guest receives over the wire carries nothing derived from another link's token."""

from __future__ import annotations

import json
import queue
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import anyio
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.collaboration.share_registry import get_share_registry
from podcast_mcp.services.record.service import reset_record_runtime_for_tests
from test_share_tokens_at_rest import (
    GUEST_TOKEN,
    HEX,
    MIN_TEXT,
    PRODUCER_TOKEN,
    REVIEW_TOKEN,
    build_needles,
    hits_in_bytes,
)

VIEWER_TOKEN = "quartz-fjord-wombat"
FRAME_TIMEOUT_SEC = 15.0


def _tap_frames(sock: Any, frames: queue.Queue[dict | None]) -> None:
    try:
        while True:
            frames.put(sock.receive_json())
    except (WebSocketDisconnect, RuntimeError, anyio.ClosedResourceError):
        frames.put(None)


class Tap:
    """Every frame one guest receives, in order, read on a thread so a missing frame fails loudly."""

    def __init__(self, sock: Any) -> None:
        self.sock = sock
        self.seen: list[dict] = []
        self._arrived: queue.Queue[dict | None] = queue.Queue()
        threading.Thread(target=_tap_frames, args=(sock, self._arrived), daemon=True).start()

    def until(self, what: str, predicate: Callable[[dict], bool]) -> dict:
        for frame in self.seen:
            if predicate(frame):
                return frame
        while True:
            try:
                frame = self._arrived.get(timeout=FRAME_TIMEOUT_SEC)
            except queue.Empty:
                raise AssertionError(f"no frame arrived for: {what}") from None
            assert frame is not None, f"the socket closed before: {what}"
            self.seen.append(frame)
            if predicate(frame):
                return frame

    def text(self) -> str:
        return json.dumps(self.seen, sort_keys=True)


def _names(frame: dict, prefix: str) -> set[str]:
    return {
        part.strip('",')
        for part in json.dumps(frame).replace(":", " ").split()
        if part.strip('",').startswith(prefix)
    }


def _playhead_of(client_id: str, seconds: float) -> Callable[[dict], bool]:
    def arrived(frame: dict) -> bool:
        if frame.get("type") == "Presence":
            return any(
                row.get("client_id") == client_id and row.get("playhead_sec") == seconds
                for row in frame.get("clients") or []
            )
        return (
            frame.get("type") == "PresenceDelta"
            and frame.get("author_client_id") == client_id
            and (frame.get("changes") or {}).get("playhead_sec") == seconds
        )

    return arrived


def _carries(prefix: str) -> Callable[[dict], bool]:
    return lambda frame: bool(_names(frame, prefix))


@pytest.fixture
def fixed_tokens(monkeypatch: pytest.MonkeyPatch) -> Callable[..., None]:
    def install(*tokens: str) -> None:
        queue_ = list(tokens)

        def fixed_slug(_words: int) -> str:
            assert queue_, "the test minted more links than it fixed tokens for"
            return queue_.pop(0)

        monkeypatch.setattr(
            "podcast_mcp.services.collaboration.share_registry.generate_slug", fixed_slug
        )

    return install


@pytest.fixture
def workspace(minimal_project: Path, sample_wav: Path, tmp_workspace: Path) -> ProjectWorkspace:
    reset_record_runtime_for_tests()
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(project, minimal_project)
    return ProjectWorkspace.open(minimal_project)


@contextmanager
def _both(client: TestClient, urls: tuple[str, str]) -> Iterator[tuple[Tap, Tap]]:
    with client.websocket_connect(urls[0]) as first, client.websocket_connect(urls[1]) as second:
        yield Tap(first), Tap(second)


def _assert_nothing_from_the_other_link(
    tap: Tap, own: str, others: tuple[str, ...], secret: bytes
) -> None:
    needles = build_needles(others, secret)
    found = hits_in_bytes(tap.text().encode(), needles)
    assert found == set(), f"a guest on {own} received text derived from another link: {found}"


def test_the_fixed_wire_tokens_have_no_window_a_frame_could_hold_by_chance() -> None:
    for token in (REVIEW_TOKEN, VIEWER_TOKEN, GUEST_TOKEN, PRODUCER_TOKEN):
        for i in range(len(token) - MIN_TEXT + 1):
            assert set(token[i : i + MIN_TEXT]) - HEX, (token, i)


def test_review_guests_receive_nothing_derived_from_each_others_links(
    workspace: ProjectWorkspace, fixed_tokens: Callable[..., None]
) -> None:
    fixed_tokens(REVIEW_TOKEN, VIEWER_TOKEN)
    with write_grant(WriteGrantKind.DISPATCHER):
        ReviewService(workspace).publish(label="Mix")
    editor = ShareService(workspace).create_for_host(role="editor")
    viewer = ShareService(workspace).create_for_host(role="viewer")
    assert (editor["token"], viewer["token"]) == (REVIEW_TOKEN, VIEWER_TOKEN)
    secret = get_share_registry().recording_key_secret()
    client = TestClient(create_app(served_project=workspace.path))

    urls = (
        f"/api/review/{editor['token']}/daw/ws?client_id=tab-a&name=Alice",
        f"/api/review/{viewer['token']}/daw/ws?client_id=tab-b&name=Bob",
    )
    with _both(client, urls) as (alice, bob):
        sees_bob = alice.until("alice sees bob in the roster", _carries(f"guest-{viewer['id']}-"))
        sees_alice = bob.until("bob sees alice in the roster", _carries(f"guest-{editor['id']}-"))
        assert f"guest-{viewer['id']}-tab-b" in _names(sees_bob, "guest-")
        assert f"guest-{editor['id']}-tab-a" in _names(sees_alice, "guest-")
        alice.sock.send_json({"type": "Presence", "client_seq": 2, "playhead_sec": 11.5})
        bob.sock.send_json({"type": "Presence", "client_seq": 2, "playhead_sec": 22.5})
        bob_id, alice_id = f"guest-{viewer['id']}-tab-b", f"guest-{editor['id']}-tab-a"
        alice.until("bob's playhead reaches alice", _playhead_of(bob_id, 22.5))
        bob.until("alice's playhead reaches bob", _playhead_of(alice_id, 11.5))

    _assert_nothing_from_the_other_link(alice, "the editor link", (VIEWER_TOKEN,), secret)
    _assert_nothing_from_the_other_link(bob, "the viewer link", (REVIEW_TOKEN,), secret)


def test_record_guests_receive_nothing_derived_from_each_others_links(
    workspace: ProjectWorkspace, fixed_tokens: Callable[..., None]
) -> None:
    fixed_tokens(GUEST_TOKEN, PRODUCER_TOKEN)
    room = ShareService(workspace).create_record_room()
    assert (room["guest"]["token"], room["producer"]["token"]) == (GUEST_TOKEN, PRODUCER_TOKEN)
    secret = get_share_registry().recording_key_secret()
    client = TestClient(create_app(served_project=workspace.path))

    urls = (f"/api/rec/{GUEST_TOKEN}/ws", f"/api/rec/{PRODUCER_TOKEN}/ws")
    with _both(client, urls) as (guest, producer):
        for tap, name in ((guest, "Ava"), (producer, "Pat")):
            tap.sock.send_json(
                {
                    "type": "Record",
                    "command_type": "Join",
                    "payload": {"display_name": name},
                    "client_seq": 1,
                }
            )
        own = {
            "guest": guest.until("the guest is admitted", lambda f: f.get("type") == "Echo"),
            "producer": producer.until(
                "the producer is admitted", lambda f: f.get("type") == "Echo"
            ),
        }

        def roster_holds(role: str, name: str) -> Callable[[dict], bool]:
            return lambda frame: any(
                p.get("role") == role and p.get("display_name") == name
                for p in (frame.get("snapshot") or {}).get("participants") or []
            )

        guest.until("the guest sees the producer", roster_holds("producer", "Pat"))
        producer.until("the producer sees the guest", roster_holds("guest", "Ava"))
        assert own["guest"]["participant_id"].startswith("p_")
        assert own["producer"]["participant_id"].startswith("p_")
        assert own["producer"]["participant_id"] in guest.text()
        assert own["guest"]["participant_id"] in producer.text()

    _assert_nothing_from_the_other_link(guest, "the guest link", (PRODUCER_TOKEN,), secret)
    _assert_nothing_from_the_other_link(producer, "the producer link", (GUEST_TOKEN,), secret)
