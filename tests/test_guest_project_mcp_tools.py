"""The guest MCP project tools: an Editor runs the pipeline, export and speaker split by MCP."""

from __future__ import annotations

import json
import logging
import threading
import wave
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from podcast_mcp.engines.models.word_aligner import WordAlignerMissingError
from podcast_mcp.engines.speaker_id import _speaker_model_missing
from podcast_mcp.engines.speaker_split import RATE, SpeakerAttribution, SpeakerTurn
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.guest_project_ops import GUEST_MOVE_LANE_SPAN_KEYS
from podcast_mcp.services.collaboration.guest_routes import GUEST_OWNER_ROUTES
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService, lookup_share
from podcast_mcp.services.collaboration.share_capabilities import (
    capabilities_for_role,
    share_review_source,
)
from podcast_mcp.services.jobs import Job
from podcast_mcp.services.pipeline import config_store
from podcast_mcp.services.remote_mcp.allowlist import (
    DOCUMENT_COMMAND_TOOLS,
    EDIT_TOOLS,
    EDITOR_PROJECT_TOOLS,
    EXPORT_TOOLS,
    PIPELINE_TOOLS,
    SPEAKER_TOOLS,
)
from podcast_mcp.services.remote_mcp.limits import classify_mcp_rpc
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.services.remote_mcp.tools import TOOL_HANDLERS, _arguments_model, list_tool_defs
from podcast_mcp.util.coded_error import GENERIC_GUEST_MESSAGE, guest_message_for_code
from script_loader import load_script

CODE = "x-sharecut-error-code"
PROJECTION = {"id", "status", "current", "total", "message", "error"}
PLANTED = "/opt/host/models/ecapa.onnx"
MOVE = {"from_lane": "room", "to_lane": "room_ben", "timeline_start": 0.5, "timeline_end": 1.5}
SPLIT = {"track_id": "room", "speaker_count": 2, "names": ["Ana", "Ben"]}
STARTS = {
    "guest_pipeline_run": {},
    "guest_export_start": {"formats": ["mp3"]},
    "guest_speaker_split": SPLIT,
}
SCRIPTED = SpeakerAttribution(
    speaker_count=2,
    duration=10.0,
    turns=(
        SpeakerTurn(0.0, 4.0, (0,), 0.9),
        SpeakerTurn(4.0, 6.0, (0, 1), 0.2),
        SpeakerTurn(6.0, 10.0, (1,), 0.9),
    ),
    backend="stub",
    method="cluster",
)
FAMILY_KINDS = {"pipeline": "pipeline", "export": "export", "speaker": "split_speakers"}


@pytest.fixture
def world(minimal_project, tmp_workspace, monkeypatch):
    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    monkeypatch.setattr(
        "podcast_mcp.services.media.speaker.resolve_speaker_backend",
        lambda name=None: SimpleNamespace(name=lambda: "stub"),
    )
    gate, started = threading.Event(), threading.Event()
    gate.set()

    def held(*_args, **_kwargs):
        started.set()
        assert gate.wait(5)
        return SimpleNamespace(last_step=None, job_result=dict)

    monkeypatch.setattr("podcast_mcp.services.pipeline.PipelineService.run", held)
    monkeypatch.setattr("podcast_mcp.services.pipeline.PipelineService.export_audio", held)

    def attribute(*_args, **_kwargs):
        held()
        return SCRIPTED

    monkeypatch.setattr("podcast_mcp.services.media.speaker.attribute_speakers", attribute)
    for name in ("ensure_whisper_cached_for_run", "ensure_word_aligner_for_run"):
        monkeypatch.setattr(
            f"podcast_mcp.services.collaboration.guest_project_ops.{name}", lambda *_a, **_k: None
        )
    ws = ProjectWorkspace.open(minimal_project)
    wav = ws.project.raw_dir() / "room.wav"
    noise = 0.1 * np.random.default_rng(0).standard_normal(10 * RATE)
    with wave.open(str(wav), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(np.round(noise * 32767).astype("<i2").tobytes())
    ws.project.artifacts_dir().mkdir(parents=True, exist_ok=True)
    (ws.project.artifacts_dir() / "premix.wav").write_bytes(wav.read_bytes())
    ws.project.tracks = [
        Track(
            id="room",
            label="Room",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/room.wav", duration_sec=10.0),
        )
    ]
    ws.project.clips = [
        Clip(id="clip_room", track_id="room", source_start=0.0, source_end=10.0, timeline_start=0.0)
    ]
    ws.save()
    version = ReviewService(ws).publish(label="Project tools")["id"]
    share = ShareService(ws)
    tokens = {
        role: share.create(
            review_version_id=version, capabilities=capabilities_for_role(role, with_mcp=True)
        )["token"]
        for role in ("viewer", "commenter", "editor")
    }
    tokens["expired"] = share.create(
        review_version_id=version,
        capabilities=capabilities_for_role("editor", with_mcp=True),
        expires_at="2020-01-01T00:00:00Z",
    )["token"]
    app = create_app()
    world = SimpleNamespace(
        client=TestClient(app),
        app=app,
        ws=ws,
        tokens=tokens,
        share=share,
        gate=gate,
        started=started,
    )
    world.slot = lambda job: setattr(app.state.jobs._catalog, "_job", job)
    yield world
    gate.set()


def _call(world, name: str, arguments: dict | None = None, link: str = "editor") -> dict:
    return handle_mcp_jsonrpc(
        world.tokens[link],
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        },
    )


def _ok(res: dict) -> dict:
    assert "error" not in res, res
    assert res["result"]["isError"] is False, res
    return res["result"]["structuredContent"]


def _refusal(res: dict) -> tuple[str, str]:
    """The ``error_code`` and text of a tool-level refusal."""
    assert "error" not in res, res
    result = res["result"]
    assert result["isError"] is True, res
    return result["structuredContent"]["error_code"], result["content"][0]["text"]


def _settle(world, job_id: str) -> None:
    world.app.state.jobs.wait(world.app.state.jobs.get_job(job_id), timeout=5)


def _job(world, kind: str) -> Job:
    job = Job(id=f"{kind}-1", kind=kind, status="running", project_path=str(world.ws.path))
    world.slot(job)
    return job


def _started(world, tool: str) -> str:
    return _ok(_call(world, tool, STARTS[tool]))["job"]["id"]


READS = {
    f"guest_{family}_{op}": args
    for family in FAMILY_KINDS
    for op, args in (("status", {}), ("job", {"job_id": "x"}), ("job_cancel", {"job_id": "x"}))
}
CALLS = {**STARTS, **READS, "guest_speaker_move_lane_span": MOVE}


def test_the_tool_sets_are_the_project_tools_and_nothing_else() -> None:
    assert EDITOR_PROJECT_TOOLS == PIPELINE_TOOLS | EXPORT_TOOLS | SPEAKER_TOOLS
    assert set(CALLS) == EDITOR_PROJECT_TOOLS
    assert set(TOOL_HANDLERS) >= EDITOR_PROJECT_TOOLS


@pytest.mark.parametrize(
    ("role", "offered"),
    [("viewer", set()), ("commenter", set()), ("editor", EDITOR_PROJECT_TOOLS)],
)
def test_only_an_editor_is_offered_the_project_tools(world, role, offered) -> None:
    listed = handle_mcp_jsonrpc(
        world.tokens[role], {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    )
    names = {tool["name"] for tool in listed["result"]["tools"]}

    assert names & EDITOR_PROJECT_TOOLS == offered


@pytest.mark.parametrize("role", ["viewer", "commenter"])
@pytest.mark.parametrize("tool", sorted(CALLS))
def test_a_lesser_role_is_refused_with_the_fixed_copy(world, tool, role) -> None:
    res = _call(world, tool, CALLS[tool], link=role)

    assert res["error"]["code"] == -32003
    assert res["error"]["message"] == guest_message_for_code("share_capability_required")
    assert not world.app.state.jobs.status()["running"]


@pytest.mark.parametrize("link", ["revoked", "expired"])
def test_a_revoked_or_expired_link_is_refused(world, link) -> None:
    if link == "revoked":
        world.share.revoke(world.tokens["editor"])
    else:
        world.tokens["editor"] = world.tokens["expired"]

    res = _call(world, "guest_pipeline_run")

    assert res["error"] == {"code": -32004, "message": "share not found"}
    assert not world.app.state.jobs.status()["running"]


@pytest.mark.parametrize("tool", sorted(STARTS))
def test_a_start_needs_the_host_opt_in(world, monkeypatch, tool) -> None:
    monkeypatch.delenv("PODCAST_GUEST_RENDER")

    res = _call(world, tool, STARTS[tool])

    assert res["error"]["code"] == -32003
    assert not world.app.state.jobs.status()["running"]


@pytest.mark.parametrize("tool", sorted(set(CALLS) - set(STARTS)))
def test_everything_but_a_start_works_with_the_opt_in_off(world, monkeypatch, tool) -> None:
    monkeypatch.delenv("PODCAST_GUEST_RENDER")

    res = _call(world, tool, CALLS[tool])

    assert "error" not in res, res
    if tool.endswith("_status"):
        assert "running" in _ok(res)
    elif tool.endswith("job") or tool.endswith("job_cancel"):
        assert _refusal(res)[0] == "job_not_found"
    else:
        assert _refusal(res)[0] != "share_capability_required"


@pytest.mark.parametrize("tool", sorted(STARTS))
def test_the_editor_starts_a_job_and_gets_only_the_projection(world, tool) -> None:
    result = _ok(_call(world, tool, STARTS[tool]))

    assert set(result) == {"job"}
    assert set(result["job"]) == PROJECTION
    text = json.dumps(result)
    assert str(world.ws.path.parent) not in text
    for hidden in ("project_path", "config", "formats", "export/", "lanes", "turns"):
        assert hidden not in text
    _settle(world, result["job"]["id"])


@pytest.mark.parametrize("family", sorted(FAMILY_KINDS))
def test_a_started_job_is_followed_and_stopped_with_its_own_tools(world, family) -> None:
    start = {
        "pipeline": "guest_pipeline_run",
        "export": "guest_export_start",
        "speaker": "guest_speaker_split",
    }[family]
    world.gate.clear()
    job_id = _started(world, start)
    assert world.started.wait(5)

    status = _ok(_call(world, f"guest_{family}_status"))
    job = _ok(_call(world, f"guest_{family}_job", {"job_id": job_id}))
    cancelled = _ok(_call(world, f"guest_{family}_job_cancel", {"job_id": job_id}))

    assert job["job"]["id"] == job_id
    assert set(job["job"]) == PROJECTION
    assert set(cancelled["job"]) == PROJECTION
    assert status["running"] is not None
    assert PLANTED not in json.dumps([status, job, cancelled])
    world.gate.set()
    _settle(world, job_id)


@pytest.mark.parametrize("family", sorted(FAMILY_KINDS))
def test_a_job_of_another_kind_or_project_is_not_found(world, family) -> None:
    kinds = ("export", "render_preview", "pipeline", "split_speakers")
    others = [kind for kind in kinds if kind != FAMILY_KINDS[family]]
    for kind in others:
        job = _job(world, kind)
        for op in ("job", "job_cancel"):
            code, text = _refusal(_call(world, f"guest_{family}_{op}", {"job_id": job.id}))
            assert (code, text) == ("job_not_found", GENERIC_GUEST_MESSAGE)
    elsewhere = Job(
        id="elsewhere-1",
        kind=FAMILY_KINDS[family],
        status="running",
        project_path="/not/this/project",
    )
    world.slot(elsewhere)
    code, text = _refusal(_call(world, f"guest_{family}_job", {"job_id": elsewhere.id}))
    assert code == "job_not_found"
    assert "/not/this" not in text


@pytest.mark.parametrize(
    ("tool", "bad"),
    [
        ("guest_pipeline_run", {"path": "/x"}),
        ("guest_pipeline_run", {"config": {}}),
        ("guest_pipeline_run", {"skip_steps": ["a"] * 99}),
        ("guest_export_start", {"formats": ["wav"]}),
        ("guest_export_start", {"formats": ["mp3", "mp3"]}),
        ("guest_export_start", {"formats": ["mp3"], "output_dir": "/x"}),
        ("guest_speaker_split", {**SPLIT, "speaker_count": 1}),
        ("guest_speaker_split", {**SPLIT, "path": "/x"}),
        ("guest_speaker_split", {**SPLIT, "enrollment": {"Ana": [[5.0, 1.0]]}}),
        ("guest_speaker_move_lane_span", {**MOVE, "timeline_end": 0.1}),
        ("guest_speaker_move_lane_span", {**MOVE, "dest": "/x"}),
        ("guest_pipeline_job", {}),
        ("guest_speaker_job_cancel", {"job_id": ""}),
        ("guest_export_job", {"job_id": "a", "extra": 1}),
        ("guest_export_status", {"extra": 1}),
    ],
)
def test_arguments_are_bounded_like_the_http_bodies(world, tool, bad) -> None:
    res = _call(world, tool, bad)

    assert res["error"]["code"] == -32602
    assert res["error"]["data"] == {"error_code": "invalid_arguments"}
    assert "/x" not in res["error"]["message"]
    assert not world.app.state.jobs.status()["running"]


def test_the_input_schemas_are_the_http_request_models() -> None:
    defs = {tool["name"]: tool["inputSchema"] for tool in list_tool_defs(["view", "edit", "mcp"])}
    editor = {
        tool["name"]: tool["inputSchema"]
        for tool in list_tool_defs(capabilities_for_role("editor", with_mcp=True))
    }

    assert set(editor) >= EDITOR_PROJECT_TOOLS
    assert editor["guest_speaker_split"]["required"] == ["track_id", "speaker_count"]
    assert editor["guest_speaker_split"]["additionalProperties"] is False
    assert editor["guest_pipeline_job"]["required"] == ["job_id"]
    assert editor["guest_export_start"]["additionalProperties"] is False
    assert EDITOR_PROJECT_TOOLS.isdisjoint(defs)


def test_a_second_start_while_a_job_runs_is_job_running(world) -> None:
    world.gate.clear()
    _started(world, "guest_pipeline_run")
    assert world.started.wait(5)

    for tool in STARTS:
        code, text = _refusal(_call(world, tool, STARTS[tool]))
        assert (code, text) == ("job_running", GENERIC_GUEST_MESSAGE)
    world.gate.set()


def test_a_host_job_holding_the_slot_is_job_running(world) -> None:
    job = _job(world, "render_preview")

    code, text = _refusal(_call(world, "guest_speaker_split", SPLIT))

    assert (code, text) == ("job_running", GENERIC_GUEST_MESSAGE)
    assert job.id not in text


def test_a_missing_speaker_model_is_the_fixed_copy_with_no_download(world, monkeypatch) -> None:
    missing = _speaker_model_missing()

    def refuse(*_a, **_k):
        raise missing

    monkeypatch.setattr("podcast_mcp.services.media.speaker.resolve_speaker_backend", refuse)

    res = _call(world, "guest_speaker_split", SPLIT)

    code, text = _refusal(res)
    assert (code, text) == ("model_needed", guest_message_for_code("model_needed"))
    assert missing.model not in json.dumps(res)
    assert PLANTED not in json.dumps(res)
    assert set(res["result"]["structuredContent"]) == {"ok", "error", "error_code"}


def test_a_sample_past_the_end_is_the_fixed_copy(world) -> None:
    body = {**SPLIT, "enrollment": {"Ana": [[12.0, 14.0]]}}

    code, text = _refusal(_call(world, "guest_speaker_split", body))

    assert (code, text) == ("enrollment_past_end", guest_message_for_code("enrollment_past_end"))
    assert not world.app.state.jobs.status()["running"]


def test_an_attended_project_is_refused_with_the_fixed_copy(world) -> None:
    config_store().put(world.ws.path, unattended=False)

    code, text = _refusal(_call(world, "guest_pipeline_run"))

    assert (code, text) == ("pipeline_attended", guest_message_for_code("pipeline_attended"))


@pytest.mark.parametrize("field", ["from_step", "only_step"])
def test_the_export_step_is_not_shared_over_mcp_either(world, field) -> None:
    code, text = _refusal(_call(world, "guest_pipeline_run", {field: "export_deliverables"}))

    assert (code, text) == (
        "pipeline_step_not_shared",
        guest_message_for_code("pipeline_step_not_shared"),
    )


@pytest.mark.parametrize(
    ("field", "bad", "code"),
    [
        ("from_step", "nope-step", "pipeline_from_step_unknown"),
        ("only_step", "nope-step", "pipeline_only_step_unknown"),
        ("skip_steps", ["nope-step"], "pipeline_skip_steps_unknown"),
    ],
)
def test_a_bad_step_name_is_the_owner_code_with_fixed_copy(world, field, bad, code) -> None:

    got = _refusal(_call(world, "guest_pipeline_run", {field: bad}))

    assert got == (code, guest_message_for_code(code))
    assert "nope-step" not in got[1]


def test_the_move_answers_the_same_allowlist_as_the_http_twin(world) -> None:
    job_id = _started(world, "guest_speaker_split")
    _settle(world, job_id)

    moved = _ok(_call(world, "guest_speaker_move_lane_span", MOVE))

    assert set(moved) == set(GUEST_MOVE_LANE_SPAN_KEYS)
    assert PLANTED not in json.dumps(moved)


def test_the_move_domain_refusal_keeps_the_http_code(world) -> None:
    http = world.client.post(
        f"/api/review/{world.tokens['editor']}/daw/speaker/move-lane-span", json=MOVE
    )

    code, text = _refusal(_call(world, "guest_speaker_move_lane_span", MOVE))

    assert code == http.headers[CODE]
    assert text == http.json()["detail"]


def test_a_start_answers_what_its_http_twin_answers(world) -> None:
    prefix = f"/api/review/{world.tokens['editor']}/daw"
    twins = {"guest_pipeline_run": "/pipeline/run", "guest_export_start": "/export"}

    for tool, path in twins.items():
        # Held while each start answers, so both views are taken of a running job.
        world.gate.clear()
        want = world.client.post(prefix + path, json=STARTS[tool])
        world.gate.set()
        _settle(world, want.json()["job"]["id"])
        world.gate.clear()
        got = _ok(_call(world, tool, STARTS[tool]))["job"]
        world.gate.set()
        _settle(world, got["id"])
        assert set(got) == set(want.json()["job"])
        assert got["message"] == want.json()["job"]["message"]
        assert got["status"] == want.json()["job"]["status"]


def test_a_domain_refusal_keeps_the_http_code_and_copy(world) -> None:
    prefix = f"/api/review/{world.tokens['editor']}/daw/speaker/split"
    _settle(world, world.client.post(prefix, json=SPLIT).json()["job"]["id"])
    again = world.client.post(prefix, json=SPLIT)

    code, text = _refusal(_call(world, "guest_speaker_split", SPLIT))

    assert (code, text) == (again.headers[CODE], again.json()["detail"])
    assert code == "speaker_split_already_split"


def test_the_job_tools_answer_what_the_http_twins_answer(world) -> None:
    prefix = f"/api/review/{world.tokens['editor']}/daw/speaker"
    job_id = _started(world, "guest_speaker_split")
    _settle(world, job_id)

    assert (
        _ok(_call(world, "guest_speaker_job", {"job_id": job_id}))
        == world.client.get(f"{prefix}/jobs/{job_id}").json()
    )
    assert _ok(_call(world, "guest_speaker_status")) == world.client.get(f"{prefix}/status").json()


@pytest.mark.parametrize("tool", sorted(STARTS))
def test_a_bare_error_is_the_fixed_internal_error(world, monkeypatch, caplog, tool) -> None:
    def refuse(*_a, **_k):
        raise RuntimeError(f"cannot start at {world.ws.path}")

    for name in ("start", "start_export", "start_split_speakers"):
        monkeypatch.setattr(f"podcast_mcp.services.jobs.manager.JobManager.{name}", refuse)

    with caplog.at_level(logging.ERROR):
        res = _call(world, tool, STARTS[tool])

    result = res["result"]
    assert result["isError"] is True
    assert result["content"][0]["text"] == f"Error executing tool {tool}"
    assert str(world.ws.path) not in json.dumps(res)
    assert any(record.exc_info for record in caplog.records)


def test_the_split_is_logged_as_the_share(world, caplog) -> None:
    row = lookup_share(world.tokens["editor"])
    with caplog.at_level(logging.INFO):
        job_id = _started(world, "guest_speaker_split")
    _settle(world, job_id)

    assert str(share_review_source(row)) in caplog.text
    assert world.tokens["editor"] not in caplog.text


def test_every_registry_row_joins_its_tool_on_rate_kind_and_flag() -> None:
    agent = load_script("export_docs_site_contract")._ROUTE_AGENT
    owned = EDIT_TOOLS | DOCUMENT_COMMAND_TOOLS | EDITOR_PROJECT_TOOLS
    claimed: set[str] = set()
    flagged: set[str] = set()
    for row in GUEST_OWNER_ROUTES.values():
        note = agent[(row.method, row.path)]
        if note.startswith("http-only:"):
            assert "/events" in row.path or row.name.startswith("transcript_"), row.name
            continue
        assert note in owned and note in TOOL_HANDLERS, row.name
        assert classify_mcp_rpc("tools/call", note) == row.rate_kind, row.name
        claimed.add(note)
        if row.needs_guest_render:
            flagged.add(note)

    assert claimed >= EDITOR_PROJECT_TOOLS
    assert flagged == set(STARTS) | {"guest_render_preview"}


def test_the_new_copy_is_fixed_and_the_job_codes_stay_generic() -> None:
    for code in ("pipeline_retime_with_force", "pipeline_job_unavailable"):
        assert guest_message_for_code(code) != GENERIC_GUEST_MESSAGE
    for code in ("job_not_found", "job_running"):
        assert guest_message_for_code(code) == GENERIC_GUEST_MESSAGE


def test_force_with_retime_words_is_the_owner_code_with_fixed_copy(world) -> None:
    got = _refusal(
        _call(world, "guest_pipeline_run", {"force_transcribe": True, "retime_words": True})
    )

    assert got == (
        "pipeline_retime_with_force",
        guest_message_for_code("pipeline_retime_with_force"),
    )
    assert not world.app.state.jobs.status()["running"]


@pytest.mark.parametrize("missing", ["whisper", "aligner"])
def test_a_missing_model_on_a_run_is_the_fixed_copy_and_nothing_starts(
    world, monkeypatch, missing
) -> None:
    ops = "podcast_mcp.services.collaboration.guest_project_ops"
    if missing == "whisper":

        def refuse(**_kwargs):
            raise _speaker_model_missing()

        monkeypatch.setattr(f"{ops}.ensure_whisper_cached_for_run", refuse)
    else:

        def refuse(*_args, **_kwargs):
            raise WordAlignerMissingError("aligner-model", PLANTED)

        monkeypatch.setattr(f"{ops}.ensure_word_aligner_for_run", refuse)

    res = _call(world, "guest_pipeline_run")

    assert _refusal(res) == ("model_needed", guest_message_for_code("model_needed"))
    assert set(res["result"]["structuredContent"]) == {"ok", "error", "error_code"}
    assert "aligner-model" not in json.dumps(res) and PLANTED not in json.dumps(res)
    assert not world.app.state.jobs.status()["running"]


@pytest.mark.parametrize("tool", sorted(EDITOR_PROJECT_TOOLS))
def test_every_new_handler_has_resolvable_argument_hints(tool) -> None:
    model = _arguments_model(TOOL_HANDLERS[tool])

    assert model is None or set(model.model_fields) <= {"req"}
