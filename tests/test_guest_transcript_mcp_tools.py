"""The guest MCP transcript tools: an Editor uses the twins of the ``/daw/transcript`` routes."""

from __future__ import annotations

import json
import logging
import threading
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from guest_helpers import (
    mcp_ok,
    mcp_refusal,
    raising,
    seed_transcript_project,
    share_id,
    sidecar,
)
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.edits.transcript_timing import TranscriptTimingChangedError
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    load_project,
)
from podcast_mcp.services.collaboration import guest_transcript_ops
from podcast_mcp.services.collaboration.guest_routes import GUEST_OWNER_ROUTES
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import (
    ExportBusyError,
    TranscriptEmptyError,
    TranscriptService,
)
from podcast_mcp.services.document.transcript import TranscriptExport
from podcast_mcp.services.media import (
    TranscriptChangedSinceReviewError,
    TranscriptPrecorrectService,
    TranscriptRefineService,
    VocabularyConflictError,
)
from podcast_mcp.services.remote_mcp.allowlist import EDITOR_PROJECT_TOOLS, TRANSCRIPT_TOOLS
from podcast_mcp.services.remote_mcp.limits import classify_mcp_rpc
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.services.remote_mcp.tools import (
    TOOL_HANDLERS,
    _arguments_model,
    _request_models,
    list_tool_defs,
    tool_input_schema,
)
from podcast_mcp.util.coded_error import (
    GENERIC_GUEST_MESSAGE,
    CodedValueError,
    guest_message_for_code,
)

CODE = "x-sharecut-error-code"
PLANTED = "planted-host-text"
TARGET = {"track_id": "host", "source_id": None, "word_index": 1}
TIMING = {"target": TARGET, "expected_word": {"text": "there", "start": 0.5, "end": 0.9}}
ARGS = {
    "guest_transcript_vocabulary_get": {},
    "guest_transcript_vocabulary_put": {"terms": ["Sharecut"], "guest_names": ["Ana"]},
    "guest_transcript_refine_status": {},
    "guest_transcript_refine_done": {},
    "guest_transcript_refine_waive": {"reason": "Cut anyway"},
    "guest_transcript_replacement_preview": {"search": "there", "replacement": "here"},
    "guest_transcript_word_timing_context": TIMING,
    "guest_transcript_export": {"formats": ["md", "srt"]},
    "guest_transcript_exports": {},
}
WRITES = {
    "guest_transcript_vocabulary_put",
    "guest_transcript_refine_done",
    "guest_transcript_refine_waive",
    "guest_transcript_export",
}
ROW_OF = {tool: tool.removeprefix("guest_") for tool in ARGS}
HTTP_OF = {tool: GUEST_OWNER_ROUTES[ROW_OF[tool]] for tool in ARGS}


@pytest.fixture
def world(minimal_project, sample_wav, tmp_workspace):
    ws = seed_transcript_project(minimal_project, sample_wav, with_take=False)
    version = ReviewService(ws).publish(label="Transcript")["id"]
    share = ShareService(ws)
    tokens = {
        role: share.create(
            review_version_id=version, capabilities=capabilities_for_role(role, with_mcp=True)
        )["token"]
        for role in ("viewer", "commenter", "editor")
    }
    tokens["other"] = share.create(
        review_version_id=version, capabilities=capabilities_for_role("editor", with_mcp=True)
    )["token"]
    tokens["expired"] = share.create(
        review_version_id=version,
        capabilities=capabilities_for_role("editor", with_mcp=True),
        expires_at="2020-01-01T00:00:00Z",
    )["token"]
    app = create_app()
    return SimpleNamespace(client=TestClient(app), app=app, ws=ws, tokens=tokens, share=share)


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


def _http(world, tool: str, body: dict | None = None, link: str = "editor"):
    row = HTTP_OF[tool]
    url = row.path.format(token=world.tokens[link])
    if row.method == "GET":
        return world.client.get(url)
    return world.client.request(row.method, url, json=ARGS[tool] if body is None else body)


def _revision(world) -> str:
    return TranscriptPrecorrectService.vocabulary_status(world.ws.path)["revision"]


def _put(world) -> dict:
    return {**ARGS["guest_transcript_vocabulary_put"], "base_revision": _revision(world)}


def _exported(world) -> list[str]:
    folder = world.ws.project.export_dir()
    return sorted(p.name for p in folder.iterdir()) if folder.exists() else []


def _body(tool: str, world) -> dict:
    return _put(world) if tool == "guest_transcript_vocabulary_put" else ARGS[tool]


def test_the_tool_set_is_the_nine_transcript_rows() -> None:
    rows = {name for name in GUEST_OWNER_ROUTES if name.startswith("transcript_")}

    assert set(ARGS) == TRANSCRIPT_TOOLS
    assert {ROW_OF[tool].removeprefix("transcript_") for tool in ARGS} == {
        row.removeprefix("transcript_") for row in rows
    }
    assert TRANSCRIPT_TOOLS <= EDITOR_PROJECT_TOOLS
    assert set(TOOL_HANDLERS) >= TRANSCRIPT_TOOLS


@pytest.mark.parametrize(
    ("role", "offered"),
    [("viewer", set()), ("commenter", set()), ("editor", TRANSCRIPT_TOOLS)],
)
def test_only_an_editor_is_offered_the_transcript_tools(world, role, offered) -> None:
    listed = handle_mcp_jsonrpc(
        world.tokens[role], {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    )
    names = {tool["name"] for tool in listed["result"]["tools"]}

    assert names & TRANSCRIPT_TOOLS == offered


@pytest.mark.parametrize("role", ["viewer", "commenter"])
@pytest.mark.parametrize("tool", sorted(ARGS))
def test_a_lesser_role_is_refused_with_the_fixed_copy_and_nothing_changes(
    world, tool, role
) -> None:
    before = _revision(world)

    res = _call(world, tool, _body(tool, world), link=role)

    assert res["error"]["code"] == -32003
    assert res["error"]["message"] == guest_message_for_code("share_capability_required")
    # The HTTP twin refuses a lesser role with the same fixed copy.
    http = _http(world, tool, _body(tool, world), link=role)
    assert http.status_code == 403
    assert http.json()["detail"] == res["error"]["message"]
    assert _revision(world) == before
    assert _exported(world) == []
    assert not REFINE_GATE.path(load_project(world.ws.path)).exists()


@pytest.mark.parametrize("link", ["revoked", "expired"])
@pytest.mark.parametrize("tool", sorted(ARGS))
def test_a_revoked_or_expired_link_is_refused(world, tool, link) -> None:
    if link == "revoked":
        world.share.revoke(world.tokens["editor"])
    else:
        world.tokens["editor"] = world.tokens["expired"]

    res = _call(world, tool, _body(tool, world))

    assert res["error"] == {"code": -32004, "message": "share not found"}
    assert _exported(world) == []


@pytest.mark.parametrize("tool", sorted(ARGS))
def test_the_editor_is_answered_and_nothing_names_a_host_path(world, tool) -> None:
    result = mcp_ok(_call(world, tool, _body(tool, world)))

    text = json.dumps(result)
    for hidden in (str(world.ws.path.parent), str(world.ws.path), "raw/host.wav"):
        assert hidden not in text


@pytest.mark.parametrize("tool", sorted(ARGS))
def test_an_unknown_argument_is_invalid_params_and_changes_nothing(world, tool) -> None:
    res = _call(world, tool, {**_body(tool, world), "path": "/x"})

    assert res["error"]["code"] == -32602
    assert _exported(world) == []
    assert not REFINE_GATE.path(load_project(world.ws.path)).exists()


@pytest.mark.parametrize(
    ("tool", "bad"),
    [
        ("guest_transcript_vocabulary_put", {"terms": ["a"] * 999, "guest_names": []}),
        ("guest_transcript_vocabulary_put", {"terms": []}),
        ("guest_transcript_refine_waive", {"reason": "  "}),
        ("guest_transcript_refine_waive", {}),
        ("guest_transcript_replacement_preview", {"search": "", "replacement": "x"}),
        (
            "guest_transcript_replacement_preview",
            {"search": " ".join(["w"] * 21), "replacement": "x"},
        ),
        ("guest_transcript_word_timing_context", {"target": TARGET}),
        ("guest_transcript_export", {"formats": ["wav"]}),
        ("guest_transcript_export", {"formats": ["md", "md"]}),
        ("guest_transcript_export", {"formats": []}),
    ],
)
def test_arguments_are_bounded_like_the_http_bodies(world, tool, bad) -> None:
    res = _call(world, tool, bad)

    assert res["error"]["code"] == -32602
    assert _exported(world) == []


def test_the_input_schemas_are_the_http_request_models() -> None:
    models = _request_models()
    with_body = {tool for tool in ARGS if tool in models}

    assert len(with_body) == 6
    for tool in with_body:
        assert tool_input_schema(tool) == models[tool].model_json_schema()
        assert models[tool].model_config["extra"] == "forbid"
    for tool in set(ARGS) - with_body:
        assert tool_input_schema(tool) == {"type": "object", "properties": {}}
        assert _arguments_model(TOOL_HANDLERS[tool]).model_fields == {}
    listed = {t["name"] for t in list_tool_defs(capabilities_for_role("editor", with_mcp=True))}
    assert listed >= TRANSCRIPT_TOOLS


@pytest.mark.parametrize("tool", sorted(set(ARGS) - WRITES))
def test_the_reads_answer_what_the_http_twin_answers(world, tool) -> None:
    assert mcp_ok(_call(world, tool, ARGS[tool])) == _http(world, tool).json()


def test_a_dry_run_export_answers_what_the_http_twin_answers(world) -> None:
    body = {"formats": ["md", "srt"], "dry_run": True, "with_text": True}

    got = mcp_ok(_call(world, "guest_transcript_export", body))

    assert got == _http(world, "guest_transcript_export", body).json()
    assert _exported(world) == []


def test_the_export_writes_the_project_files_and_the_listing_names_them(world, caplog) -> None:
    with caplog.at_level(logging.INFO, logger=guest_transcript_ops.__name__):
        got = mcp_ok(_call(world, "guest_transcript_export", {"formats": ["md", "srt"]}))

    assert [f["format"] for f in got["files"]] == ["md", "srt"]
    for row in got["files"]:
        assert set(row) == set(guest_transcript_ops.GUEST_EXPORT_FILE_KEYS)
        assert row["written"] and row["current"]
    assert _exported(world) == sorted(f["name"] for f in got["files"])
    listing = mcp_ok(_call(world, "guest_transcript_exports"))
    assert sorted(row["name"] for row in listing) == _exported(world)
    assert all(set(row) == set(guest_transcript_ops.GUEST_EXPORTED_KEYS) for row in listing)
    assert f"by=share:{share_id(world)}" in caplog.text
    assert world.tokens["editor"] not in caplog.text


def test_the_vocabulary_saves_and_a_stale_save_is_the_owners_409_code(world, caplog) -> None:
    body = _put(world)
    with caplog.at_level(logging.INFO, logger=guest_transcript_ops.__name__):
        saved = mcp_ok(_call(world, "guest_transcript_vocabulary_put", body))

    assert (saved["terms"], saved["guest_names"]) == (["Sharecut"], ["Ana"])
    assert set(saved) == set(guest_transcript_ops.GUEST_VOCABULARY_KEYS)
    assert mcp_ok(_call(world, "guest_transcript_vocabulary_get")) == saved
    assert f"by=share:{share_id(world)}" in caplog.text
    stale = _http(world, "guest_transcript_vocabulary_put", body)
    code, text = mcp_refusal(_call(world, "guest_transcript_vocabulary_put", body))
    assert (code, text) == (stale.headers[CODE], stale.json()["detail"])
    assert code == "vocabulary_conflict"
    assert text == guest_message_for_code(code)


def test_a_done_mark_records_the_share_as_the_actor(world) -> None:
    done = mcp_ok(_call(world, "guest_transcript_refine_done", {"notes": "Looks right"}))

    assert (done["status"], done["source"], done["notes"]) == ("done", "guest", "")
    stored = sidecar(world)
    assert stored["source"] == f"share:{share_id(world)}"
    assert stored["notes"] == f"{guest_transcript_ops.GUEST_NOTE_PREFIX}Looks right"


@pytest.mark.parametrize("link", ["editor", "other"])
def test_each_share_is_its_own_actor(world, link) -> None:
    mcp_ok(_call(world, "guest_transcript_refine_done", {}, link=link))

    assert sidecar(world)["source"] == f"share:{share_id(world, link)}"
    assert share_id(world, "editor") != share_id(world, "other")


def test_a_waiver_records_the_share_and_a_marked_reason(world) -> None:
    waived = mcp_ok(_call(world, "guest_transcript_refine_waive", {"reason": "Cut anyway"}))

    assert waived["source"] == "guest"
    stored = sidecar(world)
    assert stored["source"] == f"share:{share_id(world)}"
    assert stored["notes"] == f"{guest_transcript_ops.GUEST_NOTE_PREFIX}Cut anyway"


def test_a_done_mark_and_the_http_twin_leave_the_same_gate(world) -> None:
    via_http = _http(world, "guest_transcript_refine_done", {}, link="other").json()
    via_mcp = mcp_ok(_call(world, "guest_transcript_refine_done", {}))

    assert {k: v for k, v in via_mcp.items() if k != "checked_at"} == {
        k: v for k, v in via_http.items() if k != "checked_at"
    }


@pytest.mark.parametrize(
    ("tool", "service", "attribute", "error", "code"),
    [
        (
            "guest_transcript_vocabulary_put",
            TranscriptPrecorrectService,
            "set_vocabulary",
            VocabularyConflictError(PLANTED),
            "vocabulary_conflict",
        ),
        (
            "guest_transcript_vocabulary_put",
            TranscriptPrecorrectService,
            "set_vocabulary",
            CodedValueError(PLANTED, code="vocabulary_empty"),
            "vocabulary_empty",
        ),
        (
            "guest_transcript_refine_done",
            TranscriptRefineService,
            "mark_checked",
            TranscriptChangedSinceReviewError(PLANTED),
            "transcript_changed",
        ),
        (
            "guest_transcript_refine_waive",
            TranscriptRefineService,
            "waive",
            CodedValueError(PLANTED, code="empty_text"),
            "empty_text",
        ),
        (
            "guest_transcript_replacement_preview",
            TranscriptService,
            "preview_transcript_replacement",
            CodedValueError(PLANTED, code="replacement_token_invalid"),
            "replacement_token_invalid",
        ),
        (
            "guest_transcript_word_timing_context",
            TranscriptService,
            "word_timing_context",
            TranscriptTimingChangedError(PLANTED),
            "transcript_timing_changed",
        ),
        (
            "guest_transcript_word_timing_context",
            TranscriptService,
            "word_timing_context",
            KeyError(PLANTED),
            "word_not_found",
        ),
        (
            "guest_transcript_word_timing_context",
            TranscriptService,
            "word_timing_context",
            FileNotFoundError(PLANTED),
            "word_not_found",
        ),
        (
            "guest_transcript_export",
            TranscriptService,
            "export",
            ExportBusyError(PLANTED),
            "export_busy",
        ),
        (
            "guest_transcript_export",
            TranscriptService,
            "export",
            TranscriptEmptyError(PLANTED),
            "transcript_empty",
        ),
        (
            "guest_transcript_export",
            TranscriptService,
            "export",
            CodedValueError(PLANTED, code="export_target_not_file"),
            "export_target_not_file",
        ),
    ],
)
def test_a_domain_refusal_keeps_the_owners_code_with_fixed_copy(
    world, monkeypatch, tool, service, attribute, error, code
) -> None:
    monkeypatch.setattr(service, attribute, raising(error))
    http = _http(world, tool, _body(tool, world))

    got_code, text = mcp_refusal(_call(world, tool, _body(tool, world)))

    assert (got_code, text) == (http.headers[CODE], http.json()["detail"])
    assert got_code == code
    assert text == guest_message_for_code(code)
    assert PLANTED not in text


def test_a_stale_word_and_a_missing_one_are_the_owners_codes(world) -> None:
    stale = {**TIMING, "expected_word": {"text": "other", "start": 0.5, "end": 0.9}}
    gone = {**TIMING, "target": {**TARGET, "word_index": 99}}

    codes = [
        mcp_refusal(_call(world, "guest_transcript_word_timing_context", body))[0]
        for body in (stale, gone)
    ]
    http = [
        _http(world, "guest_transcript_word_timing_context", body).headers[CODE]
        for body in (stale, gone)
    ]

    assert codes == http


def test_exports_beyond_the_slots_are_busy_and_a_slot_comes_back(world, monkeypatch) -> None:
    monkeypatch.setattr(guest_transcript_ops, "EXPORT_SLOTS", threading.BoundedSemaphore(1))
    started, gate = threading.Event(), threading.Event()
    answer = TranscriptExport("en", 1, 1.0, [], None, [], None)

    def held(self, formats, **_kwargs):
        started.set()
        assert gate.wait(5)
        return answer

    monkeypatch.setattr(TranscriptService, "export", held)
    first: list = []
    worker = threading.Thread(
        target=lambda: first.append(_call(world, "guest_transcript_export", {}))
    )
    worker.start()
    try:
        assert started.wait(5)
        code, text = mcp_refusal(_call(world, "guest_transcript_export", {}))
        busy_http = _http(world, "guest_transcript_export", {})
    finally:
        gate.set()
        worker.join(5)

    assert (code, text) == ("export_busy", guest_message_for_code("export_busy"))
    assert (busy_http.status_code, busy_http.headers[CODE]) == (503, "export_busy")
    mcp_ok(first[0])
    mcp_ok(_call(world, "guest_transcript_export", {}))


@pytest.mark.parametrize("tool", sorted(ARGS))
def test_a_bare_error_is_the_fixed_internal_error(world, monkeypatch, caplog, tool) -> None:
    body = _body(tool, world)

    def refuse(*_a, **_k):
        raise RuntimeError(f"cannot read {world.ws.path}")

    for service in (TranscriptService, TranscriptRefineService):
        for name in dir(service):
            if not name.startswith("_") and callable(getattr(service, name)):
                monkeypatch.setattr(service, name, refuse)
    monkeypatch.setattr(TranscriptPrecorrectService, "vocabulary_status", staticmethod(refuse))
    monkeypatch.setattr(TranscriptPrecorrectService, "set_vocabulary", refuse)

    with caplog.at_level(logging.ERROR):
        res = _call(world, tool, body)

    result = res["result"]
    assert result["isError"] is True
    assert result["content"][0]["text"] == f"Error executing tool {tool}"
    assert str(world.ws.path) not in json.dumps(res)


def test_each_tool_has_the_rate_kind_of_its_registry_row() -> None:
    for tool in ARGS:
        row = HTTP_OF[tool]
        assert classify_mcp_rpc("tools/call", tool) == row.rate_kind, tool
        assert not row.needs_guest_render


def test_a_codeless_refusal_stays_generic() -> None:
    assert guest_message_for_code("job_not_found") == GENERIC_GUEST_MESSAGE


@pytest.mark.parametrize("tool", sorted(ARGS))
def test_every_handler_has_resolvable_argument_hints(tool) -> None:
    model = _arguments_model(TOOL_HANDLERS[tool])

    assert model is None or set(model.model_fields) <= {"req"}


def test_the_check_shows_the_fields_of_the_http_view_and_no_sidecar_path(world) -> None:
    from podcast_mcp.gui.schemas import TranscriptRefineStatusView

    assert set(guest_transcript_ops.GUEST_REFINE_KEYS) == set(
        TranscriptRefineStatusView.model_fields
    )
    for tool in ("guest_transcript_refine_status", "guest_transcript_refine_done"):
        got = mcp_ok(_call(world, tool, {}))
        assert set(got) == set(guest_transcript_ops.GUEST_REFINE_KEYS)
        assert "transcript_refine_status.json" not in json.dumps(got)


@pytest.mark.parametrize("host_action", ["done", "waive"])
def test_a_waiver_leaves_a_gate_that_is_already_clear_alone(world, host_action) -> None:
    service = TranscriptRefineService(world.ws)
    if host_action == "done":
        service.mark_checked(notes="host", source="user", expected_fingerprint=None)
    else:
        service.waive(reason="host", source="user")
    before = sidecar(world)

    got = mcp_ok(_call(world, "guest_transcript_refine_waive", {"reason": "Cut anyway"}))

    assert sidecar(world) == before
    assert before["source"] == "user"
    assert (got["source"], got["notes"]) == ("user", "")


def test_a_repeated_done_mark_writes_nothing(world) -> None:
    mcp_ok(_call(world, "guest_transcript_refine_done", {"notes": "first"}))
    before = sidecar(world)

    again = mcp_ok(_call(world, "guest_transcript_refine_done", {"notes": "second"}))

    assert sidecar(world) == before
    assert again["status"] == "done"
