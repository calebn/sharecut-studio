from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, get_type_hints

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import podcast_mcp.edits.transcript_search as transcript_search
import podcast_mcp.services.collaboration as collaboration
import podcast_mcp.services.jobs as service_jobs
import podcast_mcp.services.record.service as record_service
from podcast_mcp.gui.routes import record_share, remote_mcp, review_share
from podcast_mcp.gui.routes.guest_ws_common import GUEST_MALFORMED_LIMIT
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration import guest_project_ops
from podcast_mcp.services.collaboration.guest_progress import guest_ws_progress_sink
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.review_versions import get_version, version_audio_path
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.document import TranscriptService
from podcast_mcp.services.media import (
    SpeakerService,
    TranscriptPrecorrectService,
    TranscriptRefineService,
)
from podcast_mcp.services.record.commands import COMMAND_TYPES, RecordCommand
from podcast_mcp.services.record.service import (
    RecordSessionService,
    next_record_client_seq,
    reset_record_runtime_for_tests,
)
from podcast_mcp.services.record.upload import RecordUploadService
from podcast_mcp.services.remote_mcp import tools as remote_tools
from podcast_mcp.services.remote_mcp.progress import GuestMcpProgressContext
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.util.coded_error import (
    GENERIC_GUEST_MESSAGE,
    CodedFileNotFoundError,
    guest_message_for_code,
)
from podcast_mcp.util.progress import progress_task, register_guest_progress_sink

RELAYED = {"x-sharecut-relayed": "1"}
FOLDER_NAMES = [
    "Talkin' Shop",
    "Rock 'n' Roll Hourz",
    '"Bestz" Cutz',
    "Whatz? Showz",
    "Café Ünïcodz ☕ Radio",
    "Spaced   Outz Pod",
]
FOLDER_PATH = " -- ".join(FOLDER_NAMES)
MIX_MISSING = "review_audio_gone"
PROJECT_GONE = "project_file_gone"
REVIEW_AUDIO_GONE_MESSAGE = (
    "This review's audio isn't available right now; ask the host to republish."
)
PLANTED_SECRET = "planted-credential-0xC0FFEE-do-not-leak"
INTERNAL_ERROR = {"detail": "internal error"}
SHARE_CAPS = ["view", "play", "comment", "reply", "action", "suggest", "edit", "mcp"]


def _words(folder: str) -> list[str]:
    return [word for word in re.split(r"[^\w]+", folder) if len(word) >= 3]


@dataclass(frozen=True)
class World:
    folder: str
    workspace: Path
    token: str
    record_token: str
    participant: str
    lease: str
    mix: Path
    dist: Path

    def leaks(self, text: str) -> list[str]:
        fragments = list(
            dict.fromkeys(
                [
                    *_words(self.folder),
                    self.folder,
                    "episode.project",
                    *(name for name in FOLDER_NAMES if name in self.folder),
                ]
            )
        )
        return [
            fragment
            for fragment in fragments
            if re.search(rf"(?<!\w){re.escape(fragment)}(?!\w)", text)
        ]


def _consented_guest(ws: ProjectWorkspace, room: dict[str, Any]) -> tuple[str, str]:
    """A guest who joined the record room and consented to take 0, so uploads pass the lease."""
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    caps = ["join", "monitor"]
    svc.join(
        token=room["guest"]["token"],
        role="host",
        display_name="Host",
        client_id="host",
        connection_id="h1",
    )
    echo, _snapshot = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name="Ava",
        client_id="Ava",
        connection_id="a1",
        capabilities=caps,
        client_seq=1,
    )
    pid = echo["participant_id"]

    def command(
        ctype: str, *, role: str, participant: str, payload: dict[str, Any]
    ) -> RecordCommand:
        return RecordCommand.parse(
            command_type=ctype,
            payload=payload,
            client_id=role,
            role=role,
            participant_id=participant,
            client_seq=next_record_client_seq(),
        )

    consent = {"accepted": True, "display_name": "Ava"}
    svc.submit(
        command("Consent", role="guest", participant=pid, payload=consent), capabilities=caps
    )
    svc.submit(command("Start", role="host", participant="p_host", payload={}), now_wall_ms=1000)
    svc.submit(command("Stop", role="host", participant="p_host", payload={}), now_wall_ms=2000)
    return pid, echo["lease"]


def _build_world(tmp_path: Path, sample_wav: Path, folder: str) -> World:
    reset_record_runtime_for_tests()
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
    token = ShareService(ws).create(review_version_id=version["id"], capabilities=SHARE_CAPS)[
        "token"
    ]
    room = ShareService(ws).create_record_room()
    participant, lease = _consented_guest(ws, room)
    mix = version_audio_path(load_project(path), version["id"])
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>studio</html>", encoding="utf-8")
    return World(folder, workspace, token, room["guest"]["token"], participant, lease, mix, dist)


@pytest.fixture(autouse=True)
def _remote_mcp_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")


@pytest.fixture
def world(tmp_path: Path, sample_wav: Path) -> World:
    return _build_world(tmp_path, sample_wav, FOLDER_NAMES[0])


def _break(world: World, how: str) -> None:
    if how == PROJECT_GONE:
        (world.workspace / "episode.sharecut").unlink()
        return
    project = load_project(world.workspace / "episode.sharecut")
    version_id = project.review.versions[0].id
    mp3 = get_version(project, version_id).mp3_relpath
    world.mix.unlink()
    if mp3:
        (project.workspace_path() / mp3).unlink(missing_ok=True)


def _client(world: World) -> TestClient:
    return TestClient(create_app(static_dir=world.dist), raise_server_exceptions=False)


def _rpc(method: str, **params: object) -> dict:
    return {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}


@dataclass(frozen=True)
class Site:
    """The call inside a route's or tool's own handler where a fault is planted.

    ``not_found`` is set when the call is the share-token lookup: an uncoded ``KeyError``
    there reads as that fixed 404, not as a crash.
    """

    owner: object
    name: str
    not_found: str | None = None
    is_async: bool = False


@dataclass(frozen=True)
class Probe:
    site: Site
    request: dict[str, object] = field(default_factory=dict)
    no_store: bool = False


def _review(name: str) -> Site:
    return Site(review_share, name)


SHARE_PAGE = Site(collaboration, "lookup_share")
MCP_PREFLIGHT = Site(remote_mcp, "share_allows_mcp", not_found="share not found")
RANGE = {"intervals": [{"start": 0, "end": 1}], "track_ids": ["t"], "clips": [], "media_seals": {}}
UPLOAD = "/api/rec/{token}/upload"
WORD_NOT_FOUND = guest_message_for_code("word_not_found")
PROBES: dict[tuple[str, str], Probe] = {
    ("GET", "/r/{token}"): Probe(SHARE_PAGE),
    ("GET", "/rec/{token}"): Probe(SHARE_PAGE),
    ("GET", "/api/review/{token}/project"): Probe(_review("share_project_view")),
    ("GET", "/api/review/{token}/features"): Probe(_review("share_features_manifest")),
    ("GET", "/api/review/{token}/audio"): Probe(_review("share_audio_path")),
    ("GET", "/api/review/{token}/daw/project"): Probe(_review("share_daw_project_view")),
    ("GET", "/api/review/{token}/feed"): Probe(_review("FeedService")),
    ("GET", "/api/review/{token}/daw/meta"): Probe(_review("share_daw_meta")),
    ("GET", "/api/review/{token}/daw/waveform/status"): Probe(
        _review("share_daw_waveform_status"), no_store=True
    ),
    ("GET", "/api/review/{token}/daw/waveform/tiles/{key}"): Probe(
        _review("share_daw_waveform_tiles"),
        {"params": {"ref": "track:t", "level": 0, "start": 0}},
        no_store=True,
    ),
    ("GET", "/api/review/{token}/daw/pending-edits/{edit_id}/cut-suggestion"): Probe(
        _review("share_pending_cut_suggestion")
    ),
    ("GET", "/api/review/{token}/daw/waveform-snap"): Probe(
        _review("share_daw_waveform_snap"), {"params": {"track_id": "t", "start": 0, "end": 1}}
    ),
    ("GET", "/api/review/{token}/daw/audio"): Probe(
        _review("share_daw_audio_path"), {"params": {"kind": "review"}}
    ),
    ("GET", "/api/review/{token}/daw/pending-preview"): Probe(
        _review("share_pending_preview_wav_cached"), {"params": {"edit_id": "e"}}
    ),
    ("GET", "/api/review/{token}/daw/pending-preview-image"): Probe(
        _review("share_pending_preview_image_cached"),
        {"params": {"edit_id": "e", "kind": "wave"}},
    ),
    ("GET", "/api/review/{token}/daw/audition-context"): Probe(
        _review("share_audition_context_info"),
        {"params": {"start": 0, "end": 1, "visual": False}},
    ),
    ("GET", "/api/review/{token}/daw/audition-context-image"): Probe(
        _review("share_audition_context_image_cached"),
        {"params": {"start": 0, "end": 1, "track_id": "t", "kind": "wave"}},
    ),
    ("GET", "/api/review/{token}/daw/proxy/manifest"): Probe(_review("share_proxy_manifest")),
    ("GET", "/api/review/{token}/daw/proxy/{track_id}/{proxy_hash}/{chunk_idx}"): Probe(
        _review("share_proxy_chunk_path")
    ),
    ("POST", "/api/review/{token}/daw/render-preview"): Probe(
        Site(service_jobs.JobManager, "start_render_preview"), {"json": {}}
    ),
    ("POST", "/api/review/{token}/feed/write"): Probe(Site(review_share, "FeedService")),
    ("POST", "/api/review/{token}/feed/edit"): Probe(
        Site(review_share, "FeedService"),
        {"json": {"edit": {"op": "set", "key": "channel.author", "value": "Ana"}}},
    ),
    ("GET", "/api/review/{token}/daw/render-preview/{job_id}"): Probe(
        Site(service_jobs.JobManager, "get_job")
    ),
    ("POST", "/api/review/{token}/daw/pipeline/run"): Probe(
        Site(guest_project_ops, "ensure_whisper_cached_for_run"), {"json": {}}
    ),
    ("GET", "/api/review/{token}/daw/pipeline/status"): Probe(
        Site(service_jobs.JobManager, "status")
    ),
    ("GET", "/api/review/{token}/daw/pipeline/jobs/{job_id}"): Probe(
        Site(service_jobs.JobManager, "get_job")
    ),
    ("GET", "/api/review/{token}/daw/pipeline/jobs/{job_id}/events"): Probe(
        Site(service_jobs.JobManager, "get_job")
    ),
    ("POST", "/api/review/{token}/daw/pipeline/jobs/{job_id}/cancel"): Probe(
        Site(service_jobs.JobManager, "get_job")
    ),
    ("POST", "/api/review/{token}/daw/export"): Probe(
        Site(service_jobs.JobManager, "start_export"), {"json": {}}
    ),
    ("GET", "/api/review/{token}/daw/export/status"): Probe(
        Site(service_jobs.JobManager, "status")
    ),
    ("GET", "/api/review/{token}/daw/export/jobs/{job_id}"): Probe(
        Site(service_jobs.JobManager, "get_job")
    ),
    ("GET", "/api/review/{token}/daw/export/jobs/{job_id}/events"): Probe(
        Site(service_jobs.JobManager, "get_job")
    ),
    ("POST", "/api/review/{token}/daw/export/jobs/{job_id}/cancel"): Probe(
        Site(service_jobs.JobManager, "get_job")
    ),
    ("POST", "/api/review/{token}/daw/speaker/split"): Probe(
        Site(service_jobs.JobManager, "start_split_speakers"),
        {"json": {"track_id": "t", "speaker_count": 2}},
    ),
    ("GET", "/api/review/{token}/daw/speaker/status"): Probe(
        Site(service_jobs.JobManager, "status")
    ),
    ("GET", "/api/review/{token}/daw/speaker/jobs/{job_id}"): Probe(
        Site(service_jobs.JobManager, "get_job")
    ),
    ("GET", "/api/review/{token}/daw/speaker/jobs/{job_id}/events"): Probe(
        Site(service_jobs.JobManager, "get_job")
    ),
    ("POST", "/api/review/{token}/daw/speaker/jobs/{job_id}/cancel"): Probe(
        Site(service_jobs.JobManager, "get_job")
    ),
    ("POST", "/api/review/{token}/daw/speaker/move-lane-span"): Probe(
        Site(SpeakerService, "move_lane_span"),
        {
            "json": {
                "from_lane": "a",
                "to_lane": "b",
                "timeline_start": 0,
                "timeline_end": 1,
            }
        },
    ),
    ("GET", "/api/review/{token}/daw/transcript/vocabulary"): Probe(
        Site(TranscriptPrecorrectService, "vocabulary_status")
    ),
    ("PUT", "/api/review/{token}/daw/transcript/vocabulary"): Probe(
        Site(TranscriptPrecorrectService, "set_vocabulary"),
        {"json": {"terms": [], "guest_names": [], "base_revision": None}},
    ),
    ("GET", "/api/review/{token}/daw/transcript/refine/status"): Probe(
        Site(TranscriptRefineService, "gate_status")
    ),
    ("POST", "/api/review/{token}/daw/transcript/refine/done"): Probe(
        Site(TranscriptRefineService, "mark_checked"), {"json": {}}
    ),
    ("POST", "/api/review/{token}/daw/transcript/refine/waive"): Probe(
        Site(TranscriptRefineService, "waive"), {"json": {"reason": "r"}}
    ),
    ("POST", "/api/review/{token}/daw/transcript/replacement-preview"): Probe(
        Site(TranscriptService, "preview_transcript_replacement"),
        {"json": {"search": "a", "replacement": "b"}},
    ),
    ("POST", "/api/review/{token}/daw/transcript/word-timing-context"): Probe(
        Site(TranscriptService, "word_timing_context", not_found=WORD_NOT_FOUND),
        {
            "json": {
                "target": {"track_id": "t", "source_id": None, "word_index": 0},
                "expected_word": {"text": "a", "start": 0, "end": 1},
            }
        },
    ),
    ("POST", "/api/review/{token}/daw/transcript/export"): Probe(
        Site(TranscriptService, "export"), {"json": {}}
    ),
    ("GET", "/api/review/{token}/daw/transcript/exports"): Probe(
        Site(TranscriptService, "exported")
    ),
    ("GET", "/api/review/{token}/daw/document/state"): Probe(_review("DocumentSyncService")),
    ("POST", "/api/review/{token}/daw/boundary/context"): Probe(
        _review("EditService"),
        {
            "json": {
                "target": {"kind": "trim", "clip_id": "c", "edge": "in"},
                "expected_geometry": [],
            }
        },
    ),
    ("POST", "/api/review/{token}/daw/document/command"): Probe(
        _review("DocumentSyncService"),
        {
            "json": {
                "type": "SetTrackMute",
                "payload": {"track_id": "t", "muted": True},
                "client_id": "guest",
                "client_seq": 1,
            }
        },
    ),
    ("POST", "/api/review/{token}/daw/media/upload"): Probe(
        _review("share_upload_media"), {"params": {"filename": "x.wav"}, "content": b"RIFF"}
    ),
    ("POST", "/api/review/{token}/comments"): Probe(
        _review("share_add_comment"), {"json": {"body": "b", "author": "A", "timeline_start": 0}}
    ),
    ("POST", "/api/review/{token}/comments/{comment_id}/replies"): Probe(
        _review("share_add_reply"), {"json": {"body": "b", "author": "A"}}
    ),
    ("POST", "/api/review/{token}/comments/{comment_id}/actions/{action_id}/done"): Probe(
        _review("share_set_action_done"), {"json": {}}
    ),
    ("POST", "/api/review/{token}/daw/range-audio"): Probe(
        Site(collaboration, "share_selected_range_audio"), {"json": {"target": RANGE}}
    ),
    ("GET", "/api/rec/{token}/bootstrap"): Probe(Site(record_share, "record_bootstrap")),
    ("GET", "/api/rec/{token}/features"): Probe(Site(record_share, "share_features_manifest")),
    ("GET", UPLOAD): Probe(Site(RecordUploadService, "status")),
    ("POST", UPLOAD): Probe(
        Site(record_share, "ingest_record_upload_request", is_async=True),
        {"params": {"take_index": 0, "segment_index": 0, "part_seq": 0}, "content": b"audio"},
    ),
    ("DELETE", UPLOAD): Probe(
        Site(RecordUploadService, "revoke_room_tone"), {"params": {"kind": "room_tone"}}
    ),
    ("GET", "/mcp/{token}"): Probe(MCP_PREFLIGHT),
    ("GET", "/mcp/{token}/mcp"): Probe(MCP_PREFLIGHT),
    ("POST", "/mcp/{token}/mcp"): Probe(MCP_PREFLIGHT, {"json": _rpc("initialize")}),
    ("OPTIONS", "/mcp/{token}/mcp"): Probe(MCP_PREFLIGHT),
    ("GET", "/r/{token}/mcp"): Probe(MCP_PREFLIGHT),
    ("POST", "/r/{token}/mcp"): Probe(MCP_PREFLIGHT, {"json": _rpc("tools/list")}),
    ("OPTIONS", "/r/{token}/mcp"): Probe(MCP_PREFLIGHT),
}
SOCKETS: dict[str, Site] = {
    "/api/review/{token}/daw/ws": _review("require_share_cap"),
    "/api/rec/{token}/ws": Site(record_share, "open_share_workspace"),
}
TOOLS: dict[str, tuple[Site | None, dict[str, object]]] = {
    "guest_get_review_summary": (Site(remote_tools, "share_project_view"), {}),
    "guest_get_project": (Site(remote_tools, "share_daw_project_view"), {}),
    "guest_get_session_presence": (Site(collaboration, "SessionControlService"), {}),
    "guest_list_clips": (Site(remote_tools, "share_daw_project_view"), {}),
    "guest_list_pending_edits": (Site(remote_tools, "share_daw_project_view"), {}),
    "guest_list_applied_edits": (Site(remote_tools, "share_daw_project_view"), {}),
    "guest_search_transcript": (Site(transcript_search, "search_transcript"), {"query": "x"}),
    "guest_render_status": (Site(remote_tools, "share_daw_project_view"), {}),
    "guest_list_comments": (Site(remote_tools, "share_project_view"), {}),
    "guest_audio_info": (None, {}),
    "guest_pending_preview": (Site(remote_tools, "share_pending_preview_info"), {"edit_id": "e"}),
    "guest_audition_context": (
        Site(remote_tools, "share_audition_context_info"),
        {"start": 0, "end": 1},
    ),
    "guest_add_comment": (
        Site(remote_tools, "share_add_comment"),
        {"body": "b", "author": "A", "timeline_start": 0},
    ),
    "guest_add_reply": (
        Site(remote_tools, "share_add_reply"),
        {"comment_id": "c", "body": "b", "author": "A"},
    ),
    "guest_set_action_done": (
        Site(remote_tools, "share_set_action_done"),
        {"comment_id": "c", "action_id": "a"},
    ),
    "guest_submit_document_command": (
        Site(remote_tools, "DocumentSyncService"),
        {"type": "SetTrackMute", "payload": {"track_id": "t", "muted": True}, "client_seq": 1},
    ),
    "guest_render_preview": (Site(service_jobs, "shared_job_manager"), {}),
    "guest_render_preview_job": (Site(service_jobs, "shared_job_manager"), {"job_id": "j"}),
    "guest_upload_media": (
        Site(remote_tools, "share_upload_media"),
        {"filename": "x.wav", "data_base64": "UklGRg=="},
    ),
    "guest_pipeline_run": (Site(guest_project_ops, "ensure_whisper_cached_for_run"), {}),
    "guest_export_start": (Site(service_jobs.JobManager, "start_export"), {}),
    "guest_speaker_split": (
        Site(service_jobs.JobManager, "start_split_speakers"),
        {"track_id": "t", "speaker_count": 2},
    ),
    "guest_speaker_move_lane_span": (
        Site(SpeakerService, "move_lane_span"),
        {"from_lane": "a", "to_lane": "b", "timeline_start": 0, "timeline_end": 1},
    ),
    **{
        f"guest_{family}_{op}": (Site(service_jobs.JobManager, site), arguments)
        for family in ("pipeline", "export", "speaker")
        for op, site, arguments in (
            ("status", "status", {}),
            ("job", "get_job", {"job_id": "x1"}),
            ("job_cancel", "get_job", {"job_id": "x1"}),
        )
    },
}
"""``guest_audio_info`` only formats share URLs: it calls nothing a fault could be planted in."""


def _walk(routes: list[Any]) -> Iterator[Any]:
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            yield from _walk(list(included.routes))
        else:
            yield route


def _guest_routes(world: World) -> set[tuple[str, str]]:
    """Every (method, path) the app serves under a share ``{token}``, sockets as ``WS``."""
    app = _client(world).app
    return {
        (method, route.path)
        for route in _walk(list(app.routes))
        if "{token}" in getattr(route, "path", "")
        for method in sorted(getattr(route, "methods", None) or {"WS"})
        if method != "HEAD"
    }


def test_every_guest_route_has_a_probe(world: World) -> None:
    routes = _guest_routes(world)

    assert {key for key in routes if key[0] != "WS"} == set(PROBES)
    assert {path for method, path in routes if method == "WS"} == set(SOCKETS)
    assert set(TOOLS) == set(remote_tools.TOOL_HANDLERS)


def test_auth_body_share_token_routes_are_in_the_guest_inventory() -> None:
    from podcast_mcp.gui.routes import auth

    expected = {
        ("POST", "/auth/magic-link"): "MagicLinkRequest",
        ("POST", "/auth/agent-credential"): "AgentCredentialRequest",
    }
    discovered: dict[tuple[str, str], str] = {}
    for route in _walk(list(auth.router.routes)):
        hints = get_type_hints(route.endpoint)
        for parameter in getattr(route.dependant, "body_params", ()):
            model = hints.get(parameter.name)
            fields = getattr(model, "model_fields", {})
            if "share_token" in fields:
                for method in route.methods:
                    discovered[(method, route.path)] = model.__name__

    assert discovered == expected


@dataclass(frozen=True)
class Fault:
    """An exception planted in a site, and what a guest reads when the site raises it."""

    name: str
    error: Any
    coded: bool = False
    is_key_error: bool = False

    def http(self, site: Site) -> tuple[int, dict[str, object], bool]:
        """The status, the body and whether the host log carries the crash."""
        if self.coded:
            return 404, {"detail": GENERIC_GUEST_MESSAGE}, False
        if self.is_key_error and site.not_found is not None:
            return 404, {"detail": site.not_found}, False
        return 500, INTERNAL_ERROR, True

    def socket_close(self) -> list[object]:
        if self.coded:
            return [4403, GENERIC_GUEST_MESSAGE]
        return [1011, "internal error"]

    def tool_result(self, tool: str) -> dict[str, object]:
        if self.coded:
            text = [{"type": "text", "text": GENERIC_GUEST_MESSAGE}]
            refusal = {"ok": False, "error": GENERIC_GUEST_MESSAGE, "error_code": "file_gone"}
            return {"content": text, "structuredContent": refusal, "isError": True}
        return {
            "content": [{"type": "text", "text": f"Error executing tool {tool}"}],
            "isError": True,
        }


def _faults(host_path: Path) -> dict[str, Fault]:
    return {
        "coded_path": Fault(
            "coded_path",
            lambda: CodedFileNotFoundError(
                f"missing {host_path} {PLANTED_SECRET}", code="file_gone"
            ),
            coded=True,
        ),
        "crash": Fault("crash", lambda: RuntimeError(f"{host_path} {PLANTED_SECRET}")),
        "value_error": Fault("value_error", lambda: ValueError(f"{host_path} {PLANTED_SECRET}")),
        "os_error": Fault(
            "os_error", lambda: PermissionError(13, f"denied {PLANTED_SECRET}", str(host_path))
        ),
        "key_error": Fault(
            "key_error", lambda: KeyError(f"{host_path} {PLANTED_SECRET}"), is_key_error=True
        ),
    }


PLANTED_FAULTS = ("coded_path", "crash", "os_error", "key_error", "value_error")


def _plant(site: Site, fault: Fault, monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Make ``site`` raise ``fault``; the list counts how often it was reached."""
    hits: list[int] = []

    def planted(*_args: object, **_kwargs: object) -> None:
        hits.append(1)
        raise fault.error()

    async def planted_async(*_args: object, **_kwargs: object) -> None:
        planted()

    monkeypatch.setattr(site.owner, site.name, planted_async if site.is_async else planted)
    return hits


def _expand(template: str, world: World) -> str:
    rec = template.startswith(("/api/rec/", "/rec/"))
    token = world.record_token if rec else world.token
    return re.sub(
        r"\{(\w+)\}",
        lambda m: token if m[1] == "token" else "0" if m[1] == "chunk_idx" else "x1",
        template,
    )


def _send(client: TestClient, method: str, template: str, world: World) -> Any:
    spec = dict(PROBES[(method, template)].request)
    record = {"X-Record-Participant": world.participant, "X-Record-Lease": world.lease}
    headers = {**RELAYED, **(record if template == UPLOAD else {})}
    return client.request(method, _expand(template, world), headers=headers, **spec)


def _socket(client: TestClient, url: str) -> list[object]:
    """Every frame the server sends, then its close code and reason.

    An admitted socket is fed unparseable frames until the guest malformed-frame limit closes
    it, so the probe ends whether or not admission succeeds.
    """
    seen: list[object] = []
    try:
        with client.websocket_connect(url, headers=RELAYED) as sock:
            for _ in range(GUEST_MALFORMED_LIMIT + 1):
                sock.send_text("{")
            while True:
                seen.append(sock.receive_json())
    except WebSocketDisconnect as closed:
        seen.append([closed.code, closed.reason])
    return seen


def _logged_secret(caplog: pytest.LogCaptureFixture, since: int) -> bool:
    return any(
        record.exc_info and PLANTED_SECRET in str(record.exc_info[1])
        for record in caplog.records[since:]
    )


def _assert_private(world: World, label: str, text: str) -> None:
    assert world.leaks(text) == [], f"{label}: {text}"
    assert PLANTED_SECRET not in text, f"{label}: {text}"


@pytest.mark.parametrize("fault_name", PLANTED_FAULTS)
def test_a_fault_in_any_guest_handler_reads_the_fixed_answer(
    fault_name: str,
    world: World,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    fault = _faults(world.workspace / "episode.sharecut")[fault_name]
    client = _client(world)

    for (method, template), probe in sorted(PROBES.items()):
        label = f"{fault_name} {method} {template}"
        since = len(caplog.records)
        with monkeypatch.context() as patch:
            hits = _plant(probe.site, fault, patch)
            response = _send(client, method, template, world)
        status, body, logged = fault.http(probe.site)

        assert hits, f"{label} never reached {probe.site.name}"
        _assert_private(world, label, json.dumps([dict(response.headers), response.text]))
        assert (response.status_code, response.json()) == (status, body), label
        assert _logged_secret(caplog, since) is logged, label
        if probe.no_store:
            assert response.headers.get("cache-control") == "no-store", label

    for template, site in sorted(SOCKETS.items()):
        label = f"{fault_name} WS {template}"
        since = len(caplog.records)
        with monkeypatch.context() as patch:
            hits = _plant(site, fault, patch)
            seen = _socket(client, _expand(template, world))

        assert hits, f"{label} never reached {site.name}"
        _assert_private(world, label, json.dumps(seen))
        assert seen == [fault.socket_close()], label
        assert _logged_secret(caplog, since) is not fault.coded, label

    for tool, (site, arguments) in sorted(TOOLS.items()):
        if site is None:
            continue
        label = f"{fault_name} tool {tool}"
        since = len(caplog.records)
        with monkeypatch.context() as patch:
            hits = _plant(site, fault, patch)
            out = handle_mcp_jsonrpc(
                world.token, _rpc("tools/call", name=tool, arguments=arguments)
            )

        assert hits, f"{label} never reached {site.name}"
        _assert_private(world, label, json.dumps(out))
        assert out == {"jsonrpc": "2.0", "id": 1, "result": fault.tool_result(tool)}, label
        assert _logged_secret(caplog, since) is not fault.coded, label


def test_mcp_bridge_maps_a_post_preflight_handler_crash_to_the_guest_error(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    fault = Fault("crash", lambda: RuntimeError(f"private host path {PLANTED_SECRET}"))
    token = "share-token-after-preflight"
    preflight_hits: list[int] = []

    def allowed(_token: str) -> bool:
        preflight_hits.append(1)
        return True

    since = len(caplog.records)
    with monkeypatch.context() as patch:
        patch.setattr(remote_mcp, "share_allows_mcp", allowed)
        patch.setattr(
            "podcast_mcp.gui.middleware_share_identity.lookup_share",
            lambda _token, *, kind=None: {"token": _token, "kind": kind or "review"},
        )
        patch.setattr(
            "podcast_mcp.gui.middleware_share_identity.require_share_access", lambda *_args: None
        )
        hits = _plant(Site(remote_mcp, "handle_mcp_jsonrpc"), fault, patch)
        response = TestClient(create_app(), raise_server_exceptions=False).post(
            f"/mcp/{token}/mcp", headers=RELAYED, json=_rpc("tools/list")
        )

    assert hits, (
        f"post-preflight MCP dispatch was not reached: HTTP {response.status_code} {response.text}"
    )
    assert preflight_hits == [1]
    text = json.dumps([dict(response.headers), response.text])
    assert PLANTED_SECRET not in text and token not in text
    assert response.status_code == 500
    assert response.json() == INTERNAL_ERROR
    assert _logged_secret(caplog, since)


def test_share_spa_index_read_crash_uses_the_guest_error_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    fault = Fault("crash", lambda: RuntimeError(f"private host path {PLANTED_SECRET}"))
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>studio</html>", encoding="utf-8")
    token = "share-token-after-preflight"
    real_read_text = Path.read_text
    hits: list[int] = []

    def read_text(path: Path, *args: object, **kwargs: object) -> str:
        if path == dist / "index.html":
            hits.append(1)
            raise fault.error()
        return real_read_text(path, *args, **kwargs)

    since = len(caplog.records)
    monkeypatch.setattr(Path, "read_text", read_text)
    monkeypatch.setattr(
        "podcast_mcp.services.collaboration.lookup_share",
        lambda _token, *, kind=None: {"token": _token, "kind": kind or "review"},
    )
    response = TestClient(create_app(static_dir=dist), raise_server_exceptions=False).get(
        f"/r/{token}", headers=RELAYED
    )

    assert hits, "share SPA index read was not reached"
    text = json.dumps([dict(response.headers), response.text])
    assert PLANTED_SECRET not in text and token not in text
    assert response.status_code == 500
    assert response.json() == INTERNAL_ERROR
    assert _logged_secret(caplog, since)


REVIEW_FRAME_PAYLOADS = {
    "Presence": json.dumps({"type": "Presence", "client_seq": 1, "playhead_sec": 1.0}),
    "RosterRequest": json.dumps({"type": "RosterRequest"}),
}
IN_SESSION: dict[str, tuple[Site, str | None]] = {
    **{
        f"/api/review/{{token}}/daw/ws {frame_type}": (
            _review("_handle_guest_presence_frame"),
            payload,
        )
        for frame_type, payload in REVIEW_FRAME_PAYLOADS.items()
    },
    "/api/rec/{token}/ws": (Site(record_share, "RecordSessionService"), None),
    "/api/rec/{token}/ws Join": (
        Site(RecordSessionService, "join"),
        json.dumps({"type": "Record", "command_type": "Join", "client_seq": 1, "payload": {}}),
    ),
}
"""Faults planted after a socket is admitted: its frame handler, its session, its first command."""


def test_each_live_socket_route_has_a_post_admission_probe() -> None:
    assert {key.split()[0] for key in IN_SESSION} == set(SOCKETS)
    assert set(REVIEW_FRAME_PAYLOADS) == set(review_share.GUEST_PRESENCE_FRAME_TYPES)


RECORD_WS_COMMAND_PAYLOADS: dict[str, dict[str, object]] = {
    "Signal": {},
    "Join": {"display_name": "Guest"},
    "Leave": {},
    "Consent": {"accepted": True},
    "SetMuted": {"muted": False},
    "HeadphonesAck": {"ok": True},
    "Heartbeat": {},
    "Start": {},
    "Pause": {},
    "Resume": {},
    "Stop": {},
    "RoomToneCountdown": {},
    "SetTarget": {"target": {"kind": "end"}},
    "RemoveParticipant": {"participant_id": "p1"},
    "UpdateName": {"display_name": "Guest"},
    "Comment": {"id": "live-c1", "body": "comment"},
    "SegmentReport": {"take_index": 0, "segments": 1},
}


def test_record_guest_wire_contract_tracks_the_live_command_catalog() -> None:
    assert set(RECORD_WS_COMMAND_PAYLOADS) == set(record_service.RECORD_WS_COMMAND_TYPES)
    assert record_service.RECORD_WS_COMMAND_TYPES - {"Signal"} == COMMAND_TYPES
    for command_type in sorted(COMMAND_TYPES):
        RecordCommand.parse(
            command_type=command_type,
            payload=RECORD_WS_COMMAND_PAYLOADS[command_type],
            client_id="host",
            role="host",
            participant_id="p1",
            client_seq=1,
        )


def test_set_target_payload_keeps_the_target_through_parse() -> None:
    parsed = RecordCommand.parse(
        command_type="SetTarget",
        payload={"target": {"kind": "insert", "at_sec": 12.5}},
        client_id="host",
        role="host",
        participant_id="p_host",
        client_seq=1,
    )
    assert parsed.payload == {"target": {"kind": "insert", "at_sec": 12.5}}


def test_guest_project_view_strips_staged_session_suggestions() -> None:
    from podcast_mcp.services.collaboration.share import sanitize_guest_project_view

    staged = [
        {
            "id": "ss-a",
            "anchor": {"kind": "clip", "track_id": "host", "source_id": "src-host-secret"},
            "takes": [{"source_id": "rec-a-0-p-0"}],
        }
    ]
    view = {
        "project_path": "/host/ep.json",
        "session_suggestions": staged,
        "editorial": {"session_suggestions": staged, "chapters": []},
    }
    out = sanitize_guest_project_view(view)
    assert "session_suggestions" not in out
    assert out["editorial"] == {"chapters": []}
    assert "rec-a-0-p-0" not in json.dumps(out)
    assert "src-host-secret" not in json.dumps(out)


def test_record_signal_fault_crosses_the_registered_socket_boundary(
    minimal_project: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    repository = Path(__file__).resolve().parents[1]
    assert Path(record_share.__file__).resolve().is_relative_to(repository)
    assert Path(record_service.__file__).resolve().is_relative_to(repository)
    workspace = ProjectWorkspace.open(minimal_project)
    token = "record-token-for-signal-fault"
    secret = f"private Signal service path {PLANTED_SECRET}"
    row = {
        "token": token,
        "kind": "record",
        "role": "guest",
        "session_id": "session-signal-fault",
        "capabilities": ["join", "monitor"],
    }
    hits: list[int] = []

    async def share_row(_websocket: object, _token: str, *, kind: str) -> dict[str, object]:
        assert kind == "record"
        return row

    def fail_signal(*_args: object, **_kwargs: object) -> dict[str, object]:
        hits.append(1)
        raise ValueError(secret)

    monkeypatch.setattr(record_share, "guest_ws_share_row", share_row)
    monkeypatch.setattr(
        record_share, "open_share_workspace", lambda *_args, **_kwargs: (row, workspace)
    )
    monkeypatch.setattr(record_share, "_record_still_valid", lambda _token: True)
    monkeypatch.setattr(RecordSessionService, "signal", fail_signal)
    since = len(caplog.records)
    client = TestClient(create_app(), raise_server_exceptions=False)

    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(f"/api/rec/{token}/ws") as socket:
            socket.send_json(
                {"type": "Record", "command_type": "Join", "payload": {}, "client_seq": 1}
            )
            _drain = socket.receive_json()
            _snapshot = socket.receive_json()
            socket.send_json(
                {"type": "Record", "command_type": "Signal", "payload": {}, "client_seq": 2}
            )
            while True:
                frame = socket.receive_json()
                assert token not in str(frame) and secret not in str(frame)

    assert hits == [1]
    assert closed.value.code == 1011
    assert closed.value.reason == "internal error"
    assert secret in str(
        [record.exc_info[1] for record in caplog.records[since:] if record.exc_info]
    )


def _socket_after(client: TestClient, url: str, first: str | None) -> list[object]:
    """Like ``_socket``, but sends ``first`` before the malformed frames."""
    seen: list[object] = []
    try:
        with client.websocket_connect(url, headers=RELAYED) as sock:
            if first is not None:
                sock.send_text(first)
            for _ in range(GUEST_MALFORMED_LIMIT + 1):
                sock.send_text("{")
            while True:
                seen.append(sock.receive_json())
    except WebSocketDisconnect as closed:
        seen.append([closed.code, closed.reason])
    return seen


@pytest.mark.parametrize("fault_name", PLANTED_FAULTS)
def test_a_fault_inside_an_admitted_guest_socket_reads_the_fixed_answer(
    fault_name: str,
    world: World,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    fault = _faults(world.workspace / "episode.sharecut")[fault_name]
    client = _client(world)

    for key, (site, first) in sorted(IN_SESSION.items()):
        label = f"{fault_name} WS {key}"
        since = len(caplog.records)
        with monkeypatch.context() as patch:
            hits = _plant(site, fault, patch)
            seen = _socket_after(client, _expand(key.split()[0], world), first)

        assert hits, f"{label} never reached {site.name}"
        _assert_private(world, label, json.dumps(seen))
        if key.startswith("/api/rec/") and first is not None and fault.coded:
            error = {
                "plane": "record",
                "type": "Error",
                "code": "invalid_state",
                "detail": GENERIC_GUEST_MESSAGE,
                "error_code": "file_gone",
            }
            assert error in seen, label
        else:
            assert seen[-1] == fault.socket_close(), label
        assert _logged_secret(caplog, since) is not fault.coded, label


def test_share_spa_hook_fault_falls_back_to_the_static_page_without_leaking(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.extensions.loader import load_extensions as real_load

    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>studio</html>", encoding="utf-8")
    hits: list[int] = []

    def broken_hook(**_kwargs: object) -> str:
        hits.append(1)
        raise RuntimeError(f"private host path {PLANTED_SECRET}")

    def with_broken_hook():
        registry = real_load()
        registry._spa_hooks[:] = [broken_hook]
        return registry

    monkeypatch.setattr("podcast_mcp.gui.server.load_extensions", with_broken_hook)
    monkeypatch.setattr(
        "podcast_mcp.services.collaboration.lookup_share",
        lambda token, *, kind=None: {"token": token, "kind": kind or "review"},
    )
    token = "share-token-for-hook"
    response = TestClient(create_app(static_dir=dist), raise_server_exceptions=False).get(
        f"/r/{token}", headers=RELAYED
    )

    assert hits == [1]
    text = json.dumps([dict(response.headers), response.text])
    assert PLANTED_SECRET not in text and token not in text
    assert response.status_code == 200
    assert "studio" in response.text
    assert response.headers.get("cache-control") == "no-cache"


@pytest.mark.parametrize("broken", [MIX_MISSING, PROJECT_GONE])
def test_no_guest_route_shows_a_word_of_a_broken_share_folder(
    broken: str, tmp_path: Path, sample_wav: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Unplanted, a guest render would start a real background job that outlives the test.
    monkeypatch.delenv("PODCAST_GUEST_RENDER")
    world = _build_world(tmp_path, sample_wav, FOLDER_PATH)
    _break(world, broken)
    client = _client(world)
    for method, template in sorted(PROBES):
        response = _send(client, method, template, world)
        text = json.dumps([response.status_code, dict(response.headers), response.text])
        _assert_private(world, f"{broken} {method} {template}", text)
    for template in sorted(SOCKETS):
        seen = _socket(client, _expand(template, world))
        _assert_private(world, f"{broken} WS {template}", json.dumps(seen))
    for tool, (_site, arguments) in sorted(TOOLS.items()):
        call = _rpc("tools/call", name=tool, arguments=arguments)
        out = handle_mcp_jsonrpc(world.token, call)
        _assert_private(world, f"{broken} tool {tool}", json.dumps(out))


def test_guest_review_audio_with_the_mix_gone_reads_the_fixed_message(world: World) -> None:
    _break(world, MIX_MISSING)
    client = _client(world)

    for url in (
        f"/api/review/{world.token}/audio",
        f"/api/review/{world.token}/daw/audio?kind=review",
    ):
        response = client.get(url, headers=RELAYED)

        assert response.status_code == 404
        assert response.headers["x-sharecut-error-code"] == "review_media_not_found"
        assert response.json() == {"detail": REVIEW_AUDIO_GONE_MESSAGE}

    (world.workspace / "artifacts" / "premix.wav").unlink()
    client = _client(world)
    missing_mix = client.get(f"/api/review/{world.token}/daw/audio?kind=premix", headers=RELAYED)

    project_path = world.workspace / "episode.sharecut"
    project = load_project(project_path)
    track_id = "track-private-id"
    project.tracks.append(
        Track(
            id=track_id,
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    )
    save_project(project, project_path)

    missing_stem = client.get(
        f"/api/review/{world.token}/daw/audio?kind=stem&track_id={track_id}", headers=RELAYED
    )

    assert missing_mix.status_code == 404
    assert missing_mix.headers["x-sharecut-error-code"] == "no_mix"
    assert missing_mix.json() == {"detail": "No mix is available yet. Ask the host to refresh it."}
    assert not world.leaks(missing_mix.text)
    assert missing_stem.status_code == 404
    assert missing_stem.headers["x-sharecut-error-code"] == "file_not_found"
    assert missing_stem.json() == {"detail": GENERIC_GUEST_MESSAGE}
    assert not world.leaks(missing_stem.text)
    assert track_id not in missing_stem.text


def test_host_still_reads_the_path_when_the_mix_is_gone(world: World) -> None:
    _break(world, MIX_MISSING)
    project = load_project(world.workspace / "episode.sharecut")

    with pytest.raises(CodedFileNotFoundError) as refusal:
        version_audio_path(project, project.review.versions[0].id)

    assert str(world.mix) in str(refusal.value)
    assert refusal.value.code == "review_media_not_found"


def test_guest_progress_stream_never_carries_a_fragment_of_the_host_folder_name(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
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
