"""No share guest reads any piece of a host folder name, whatever the name holds (#1327).

A host's folders can hold apostrophes, quotes, ``?``, spaces and non-ASCII. A guest or relayed
caller reaches coded errors that name a host path; every one reads a fixed, path-free message.
The sweep builds a real share under such a folder, breaks it two ways (the frozen review mix
is gone, the project file is gone) and reads every guest surface for any word of the folder name.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from podcast_mcp.edits.review_versions import get_version, version_audio_path
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import EpisodeProject, load_project, save_project
from podcast_mcp.models.episode import project_not_found
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.guest_progress import guest_ws_progress_sink
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.remote_mcp.progress import GuestMcpProgressContext
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.util.coded_error import CodedFileNotFoundError
from podcast_mcp.util.progress import progress_task, register_guest_progress_sink

RELAYED = {"x-sharecut-relayed": "1"}
FOLDER_NAMES = [
    "Talkin' Shop",
    "Rock 'n' Roll Hourz",
    '"Bestz" Cut',
    "Whatz? Showz",
    "Café Ünïcodz ☕ Radio",
    "Spaced   Outz Pod",
]
MIX_MISSING = "review_audio_gone"
PROJECT_GONE = "project_file_gone"
PROJECT_VANISHED = "project_file_vanishes_while_opening"
REVIEW_AUDIO_GONE_MESSAGE = (
    "This review's audio isn't available right now; ask the host to republish."
)


def _words(folder: str) -> list[str]:
    return [word for word in re.split(r"[^\w]+", folder) if len(word) >= 3]


@dataclass(frozen=True)
class World:
    folder: str
    workspace: Path
    token: str
    record_token: str
    mix: Path
    dist: Path

    def leaks(self, text: str) -> list[str]:
        fragments = [*_words(self.folder), self.folder, "episode.project"]
        return [
            fragment
            for fragment in fragments
            if re.search(rf"(?<!\w){re.escape(fragment)}(?!\w)", text)
        ]


def _build_world(tmp_path: Path, sample_wav: Path, folder: str) -> World:
    workspace = tmp_path / folder / "ep1"
    (workspace / "raw").mkdir(parents=True)
    (workspace / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    project = EpisodeProject.create("test_episode", str(workspace))
    project.ensure_dirs()
    path = save_project(project)
    (Path(load_project(path).workspace_dir) / "artifacts" / "premix.wav").write_bytes(
        sample_wav.read_bytes()
    )
    ws = ProjectWorkspace.open(path)
    version = ReviewService(ws).publish(label="guest")
    token = ShareService(ws).create(
        review_version_id=version["id"], capabilities=["view", "play", "comment", "mcp"]
    )["token"]
    record_token = ShareService(ws).create_record_room()["guest"]["token"]
    mix = version_audio_path(load_project(path), version["id"])
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>studio</html>", encoding="utf-8")
    return World(folder, workspace, token, record_token, mix, dist)


@pytest.fixture(autouse=True)
def _remote_mcp_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")


@pytest.fixture
def world(tmp_path: Path, sample_wav: Path) -> World:
    return _build_world(tmp_path, sample_wav, FOLDER_NAMES[0])


def _break(world: World, how: str, monkeypatch: pytest.MonkeyPatch) -> None:
    if how == PROJECT_GONE:
        (world.workspace / "episode.project.json").unlink()
        return
    if how == PROJECT_VANISHED:
        gone = world.workspace / "episode.project.json"

        def vanished(_path: object) -> None:
            raise project_not_found(gone)

        monkeypatch.setattr(ProjectWorkspace, "open", staticmethod(vanished))
        return
    project = load_project(world.workspace / "episode.project.json")
    version_id = project.review.versions[0].id
    mp3 = get_version(project, version_id).mp3_relpath
    world.mix.unlink()
    if mp3:
        (project.workspace_path() / mp3).unlink(missing_ok=True)


def _client(world: World) -> TestClient:
    return TestClient(create_app(static_dir=world.dist), raise_server_exceptions=False)


def _http(
    client: TestClient,
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    **kwargs: object,
) -> str:
    response = client.request(method, url, headers={**RELAYED, **(headers or {})}, **kwargs)
    return json.dumps([response.status_code, dict(response.headers), response.text])


def _refused_socket(client: TestClient, url: str) -> str:
    """Every frame, then the close reason, of a socket the server refuses at admission."""
    seen: list[object] = []
    try:
        with client.websocket_connect(url, headers=RELAYED) as sock:
            for _ in range(8):
                seen.append(sock.receive_json())
    except WebSocketDisconnect as closed:
        seen.append([closed.code, closed.reason])
    return json.dumps(seen)


def _rpc(method: str, **params: object) -> dict:
    return {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}


def _review_http(world: World) -> list[str]:
    client, t = _client(world), world.token
    return [
        _http(client, "GET", f"/api/review/{t}/project"),
        _http(client, "GET", f"/api/review/{t}/features"),
        _http(client, "GET", f"/api/review/{t}/audio"),
        _http(client, "GET", f"/api/review/{t}/daw/audio?kind=review"),
        _http(client, "GET", f"/api/review/{t}/daw/project"),
    ]


def _record_http(world: World) -> list[str]:
    client, t = _client(world), world.record_token
    return [
        _http(client, "GET", f"/api/rec/{t}/bootstrap"),
        _http(client, "GET", f"/api/rec/{t}/features"),
        _http(
            client,
            "GET",
            f"/api/rec/{t}/upload",
            headers={"X-Record-Participant": "p", "X-Record-Lease": "l"},
        ),
    ]


def _mcp_http(world: World) -> list[str]:
    client, t = _client(world), world.token
    call = _rpc("tools/call", name="guest_get_project", arguments={})
    return [
        _http(client, "GET", f"/mcp/{t}"),
        _http(client, "POST", f"/mcp/{t}/mcp", json=_rpc("initialize")),
        _http(client, "POST", f"/mcp/{t}/mcp", json=call),
        _http(client, "POST", f"/r/{t}/mcp", json=_rpc("tools/list")),
        _http(client, "POST", f"/r/{t}/mcp", json=call),
    ]


def _pages(world: World) -> list[str]:
    client = _client(world)
    return [
        _http(client, "GET", f"/r/{world.token}"),
        _http(client, "GET", f"/rec/{world.record_token}"),
    ]


def _sockets(world: World) -> list[str]:
    client = _client(world)
    return [
        _refused_socket(client, f"/api/review/{world.token}/daw/ws"),
        _refused_socket(client, f"/api/rec/{world.record_token}/ws"),
    ]


def _direct_mcp(world: World) -> list[str]:
    call = _rpc("tools/call", name="guest_get_project", arguments={})
    return [
        json.dumps(handle_mcp_jsonrpc(world.token, body)) for body in (_rpc("initialize"), call)
    ]


SURFACES: dict[str, Callable[[World], list[str]]] = {
    "review_http": _review_http,
    "record_http": _record_http,
    "mcp_http": _mcp_http,
    "pages": _pages,
    "sockets": _sockets,
    "direct_mcp": _direct_mcp,
}


@pytest.mark.parametrize("folder", FOLDER_NAMES, ids=lambda name: re.sub(r"\W+", "_", name))
def test_no_guest_surface_shows_a_fragment_of_the_host_folder_name(
    folder: str, tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    world = _build_world(tmp_path, sample_wav, folder)

    for how in (MIX_MISSING, PROJECT_VANISHED, PROJECT_GONE):
        _break(world, how, monkeypatch)
        for name, surface in sorted(SURFACES.items()):
            if name == "sockets" and how == MIX_MISSING:
                continue
            for text in surface(world):
                assert world.leaks(text) == [], f"{how} {name}: {text}"


def test_guest_review_audio_with_the_mix_gone_reads_the_fixed_message(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    _break(world, MIX_MISSING, monkeypatch)
    client = _client(world)

    for url in (
        f"/api/review/{world.token}/audio",
        f"/api/review/{world.token}/daw/audio?kind=review",
    ):
        response = client.get(url, headers=RELAYED)

        assert response.status_code == 404
        assert response.headers["x-sharecut-error-code"] == "review_media_not_found"
        assert response.json() == {"detail": REVIEW_AUDIO_GONE_MESSAGE}


def test_host_still_reads_the_path_when_the_mix_is_gone(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    _break(world, MIX_MISSING, monkeypatch)
    project = load_project(world.workspace / "episode.project.json")

    with pytest.raises(CodedFileNotFoundError) as refusal:
        version_audio_path(project, project.review.versions[0].id)

    assert str(world.mix) in str(refusal.value)
    assert refusal.value.code == "review_media_not_found"


def test_guest_progress_stream_never_carries_a_fragment_of_the_host_folder_name(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.remote_mcp import tools as remote_tools

    raw = world.workspace / "raw" / "host.wav"
    captured: list[GuestMcpProgressContext] = []

    class Capturing(GuestMcpProgressContext):
        def __init__(self, progressToken: str, sink: object = None) -> None:
            super().__init__(progressToken, sink=sink)
            captured.append(self)

    def handler() -> None:
        with progress_task("guest_get_project", f"Reading {raw}", total=2) as task:
            task.advance(1, message=f"opened {raw} for you")
            raise CodedFileNotFoundError(f"missing {raw}", code="file_not_found")

    monkeypatch.setattr(
        "podcast_mcp.services.remote_mcp.protocol.GuestMcpProgressContext", Capturing
    )
    monkeypatch.setattr(
        remote_tools, "TOOL_HANDLERS", {**remote_tools.TOOL_HANDLERS, "guest_get_project": handler}
    )
    register_guest_progress_sink(guest_ws_progress_sink)
    call = _rpc("tools/call", name="guest_get_project", arguments={}, _meta={"progressToken": "p"})
    frames: list[dict] = []

    with _client(world).websocket_connect(f"/api/review/{world.token}/daw/ws") as sock:
        out = handle_mcp_jsonrpc(world.token, call)
        while not frames or frames[-1].get("status") != "error":
            frame = sock.receive_json()
            if frame.get("plane") == "progress":
                frames.append(frame)

    for text in (json.dumps(out), json.dumps(captured[0].notifications), json.dumps(frames)):
        assert world.leaks(text) == [], text
