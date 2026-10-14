"""No share guest reads any piece of a host folder name, whatever the name holds (#1327).

A host's folders can hold apostrophes, quotes, ``?``, spaces and non-ASCII. A guest or relayed
caller reaches coded errors that name a host path; every one reads a fixed, path-free message.
The sweep builds a real share under such a folder, breaks it two ways (the frozen review mix
is gone, the project file is gone) and reads every guest surface for any word of the folder name.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from podcast_mcp.edits.review_versions import get_version, version_audio_path
from podcast_mcp.gui.routes import record_share, remote_mcp, review_share
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import EpisodeProject, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.guest_progress import guest_ws_progress_sink
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.remote_mcp.progress import GuestMcpProgressContext
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.services.remote_mcp.tools import TOOL_HANDLERS
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
    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")


@pytest.fixture
def world(tmp_path: Path, sample_wav: Path) -> World:
    return _build_world(tmp_path, sample_wav, FOLDER_NAMES[0])


def _break(world: World, how: str, monkeypatch: pytest.MonkeyPatch) -> None:
    if how == PROJECT_GONE:
        (world.workspace / "episode.project.json").unlink()
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


PLANTED_SECRET = "planted-credential-0xC0FFEE-do-not-leak"
FAULTS = ("mix_missing", "project_gone", "coded_path", "crash", "os_error")
GUEST_ROUTERS = (review_share.router, record_share.router, remote_mcp.router)
NO_WORKSPACE = {
    ("GET", "/api/review/{token}/daw/waveform/tiles/{key}"),
    ("GET", "/api/review/{token}/features"),
    ("GET", "/api/rec/{token}/features"),
    ("GET", "/mcp/{token}"),
    ("GET", "/mcp/{token}/mcp"),
    ("GET", "/r/{token}/mcp"),
    ("OPTIONS", "/mcp/{token}/mcp"),
    ("OPTIONS", "/r/{token}/mcp"),
}
"""Routes that never call ``ProjectWorkspace.open``: the planted fault cannot reach them.

The tile route reads the project file directly, so the ``project_gone`` fault covers it.
"""
RANGE = {"intervals": [{"start": 0, "end": 1}], "track_ids": ["t"], "clips": [], "media_seals": {}}
RECORD_HEADERS = {"X-Record-Participant": "p_123456789abc", "X-Record-Lease": "lease"}
UPLOAD = "/api/rec/{token}/upload"
PROBES: dict[tuple[str, str], dict[str, object]] = {
    ("GET", "/api/review/{token}/project"): {},
    ("GET", "/api/review/{token}/features"): {},
    ("GET", "/api/review/{token}/audio"): {},
    ("GET", "/api/review/{token}/daw/project"): {},
    ("GET", "/api/review/{token}/daw/meta"): {},
    ("GET", "/api/review/{token}/daw/waveform/status"): {},
    ("GET", "/api/review/{token}/daw/waveform/tiles/{key}"): {
        "params": {"ref": "track:t", "level": 0, "start": 0}
    },
    ("GET", "/api/review/{token}/daw/pending-edits/{edit_id}/cut-suggestion"): {},
    ("GET", "/api/review/{token}/daw/waveform-snap"): {
        "params": {"track_id": "t", "start": 0, "end": 1}
    },
    ("GET", "/api/review/{token}/daw/audio"): {"params": {"kind": "review"}},
    ("GET", "/api/review/{token}/daw/pending-preview"): {"params": {"edit_id": "e"}},
    ("GET", "/api/review/{token}/daw/pending-preview-image"): {
        "params": {"edit_id": "e", "kind": "wave"}
    },
    ("GET", "/api/review/{token}/daw/audition-context"): {"params": {"start": 0, "end": 1}},
    ("GET", "/api/review/{token}/daw/audition-context-image"): {
        "params": {"start": 0, "end": 1, "track_id": "t", "kind": "wave"}
    },
    ("GET", "/api/review/{token}/daw/proxy/manifest"): {},
    ("GET", "/api/review/{token}/daw/proxy/{track_id}/{proxy_hash}/{chunk_idx}"): {},
    ("POST", "/api/review/{token}/daw/render-preview"): {"json": {}},
    ("GET", "/api/review/{token}/daw/render-preview/{job_id}"): {},
    ("GET", "/api/review/{token}/daw/document/state"): {},
    ("POST", "/api/review/{token}/daw/boundary/context"): {
        "json": {
            "target": {"kind": "trim", "clip_id": "c", "edge": "in"},
            "expected_geometry": [],
        }
    },
    ("POST", "/api/review/{token}/daw/document/command"): {
        "json": {
            "type": "SetTrackMute",
            "payload": {"track_id": "t", "muted": True},
            "client_id": "guest",
            "client_seq": 1,
        }
    },
    ("POST", "/api/review/{token}/daw/media/upload"): {
        "params": {"filename": "x.wav"},
        "content": b"RIFF",
    },
    ("POST", "/api/review/{token}/comments"): {
        "json": {"body": "b", "author": "A", "timeline_start": 0}
    },
    ("POST", "/api/review/{token}/comments/{comment_id}/replies"): {
        "json": {"body": "b", "author": "A"}
    },
    ("POST", "/api/review/{token}/comments/{comment_id}/actions/{action_id}/done"): {"json": {}},
    ("POST", "/api/review/{token}/daw/range-audio"): {"json": {"target": RANGE}},
    ("GET", "/api/rec/{token}/bootstrap"): {},
    ("GET", "/api/rec/{token}/features"): {},
    ("GET", UPLOAD): {"headers": RECORD_HEADERS},
    ("POST", UPLOAD): {
        "headers": RECORD_HEADERS,
        "params": {"take_index": 0, "segment_index": 0, "part_seq": 0},
        "content": b"audio",
    },
    ("DELETE", UPLOAD): {"headers": RECORD_HEADERS, "params": {"kind": "room_tone"}},
    ("GET", "/mcp/{token}"): {},
    ("GET", "/mcp/{token}/mcp"): {},
    ("POST", "/mcp/{token}/mcp"): {"json": _rpc("initialize")},
    ("OPTIONS", "/mcp/{token}/mcp"): {},
    ("GET", "/r/{token}/mcp"): {},
    ("POST", "/r/{token}/mcp"): {"json": _rpc("tools/list")},
    ("OPTIONS", "/r/{token}/mcp"): {},
}
SOCKETS = {"/api/review/{token}/daw/ws", "/api/rec/{token}/ws"}


def _guest_routes() -> set[tuple[str, str]]:
    return {
        (method, route.path)
        for router in GUEST_ROUTERS
        for route in router.routes
        for method in sorted(getattr(route, "methods", None) or {"WS"})
        if method != "HEAD"
    }


def _plant(world: World, fault: str, monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Break the project the way ``fault`` says; the list counts how often the break was hit."""
    hits: list[int] = []
    if fault in (MIX_MISSING, PROJECT_GONE):
        _break(world, fault, monkeypatch)
        return hits
    host_path = world.workspace / "episode.project.json"
    errors = {
        "coded_path": lambda: CodedFileNotFoundError(f"missing {host_path}", code="file_gone"),
        "crash": lambda: RuntimeError(f"{host_path} {PLANTED_SECRET}"),
        "os_error": lambda: PermissionError(13, f"denied {PLANTED_SECRET}", str(host_path)),
    }

    def planted(_path: object) -> None:
        hits.append(1)
        raise errors[fault]()

    monkeypatch.setattr(ProjectWorkspace, "open", staticmethod(planted))
    return hits


def _expand(template: str, world: World) -> str:
    token = world.record_token if template.startswith("/api/rec/") else world.token
    return re.sub(
        r"\{(\w+)\}",
        lambda m: token if m[1] == "token" else "0" if m[1] == "chunk_idx" else "x1",
        template,
    )


def _probe_http(client: TestClient, method: str, template: str, world: World) -> str:
    spec = dict(PROBES[(method, template)])
    headers = {**RELAYED, **spec.pop("headers", {})}
    response = client.request(method, _expand(template, world), headers=headers, **spec)
    return json.dumps([response.status_code, dict(response.headers), response.text])


def test_every_guest_route_has_a_probe() -> None:
    routes = _guest_routes()

    assert {key for key in routes if key[0] != "WS"} == set(PROBES)
    assert {path for method, path in routes if method == "WS"} == SOCKETS


@pytest.mark.parametrize("fault", FAULTS)
def test_no_guest_route_shows_a_host_path_or_secret(
    fault: str,
    tmp_path: Path,
    sample_wav: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    folders = FOLDER_NAMES if fault in (MIX_MISSING, PROJECT_GONE) else FOLDER_NAMES[:1]
    for index, folder in enumerate(folders):
        world = _build_world(tmp_path / str(index), sample_wav, folder)
        with monkeypatch.context() as patch:
            outputs = _probe_world(world, fault, patch)
        for route, text in outputs.items():
            assert world.leaks(text) == [], f"{fault} {route}: {text}"
            assert PLANTED_SECRET not in text, f"{fault} {route}: {text}"
        if fault in {"crash", "os_error"}:
            logged = [str(r.exc_info[1]) for r in caplog.records if r.exc_info]
            assert any(PLANTED_SECRET in line for line in logged)


def _probe_world(world: World, fault: str, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """Every guest route, socket and MCP tool answered while ``fault`` is planted."""
    hits = _plant(world, fault, monkeypatch)
    client = _client(world)
    outputs: dict[str, str] = {}
    for method, template in sorted(PROBES):
        before = len(hits)
        outputs[f"{method} {template}"] = _probe_http(client, method, template, world)
        if (method, template) not in NO_WORKSPACE and hits:
            assert len(hits) > before, f"{method} {template} never reached the planted fault"
    for template in sorted(SOCKETS):
        outputs[f"WS {template}"] = _refused_socket(client, _expand(template, world))
    for tool in sorted(TOOL_HANDLERS):
        call = _rpc("tools/call", name=tool, arguments={})
        outputs[f"tool {tool}"] = json.dumps(handle_mcp_jsonrpc(world.token, call))
    return outputs


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
