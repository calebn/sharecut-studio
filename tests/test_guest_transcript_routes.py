"""The guest transcript twins: an Editor uses the transcript tools on the share's project."""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import get_args

import pytest
from fastapi.testclient import TestClient
from filelock import Timeout

from guest_helpers import raising, seed_transcript_project, share_id, sidecar
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE, TranscriptRefineRequiredError
from podcast_mcp.edits.transcript_timing import TranscriptTimingChangedError
from podcast_mcp.export.transcript import TRANSCRIPT_FORMATS
from podcast_mcp.gui.schemas import GuestTranscriptExportRequest
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    load_project,
    save_project,
)
from podcast_mcp.services.collaboration import guest_transcript_ops
from podcast_mcp.services.collaboration.guest_routes import GUEST_OWNER_ROUTES
from podcast_mcp.services.collaboration.guest_transcript_ops import (
    GUEST_EXPORT_FILE_KEYS,
    GUEST_EXPORTED_KEYS,
    GUEST_NOTE_PREFIX,
    GUEST_VOCABULARY_KEYS,
)
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.collaboration.share_capabilities import (
    SHARE_ACTOR_PREFIX,
    capabilities_for_role,
)
from podcast_mcp.services.document import ExportBusyError, TranscriptEmptyError, TranscriptService
from podcast_mcp.services.document.transcript import TranscriptExport
from podcast_mcp.services.media import (
    TranscriptChangedSinceReviewError,
    TranscriptPrecorrectService,
    TranscriptRefineService,
    VocabularyConflictError,
)
from podcast_mcp.util.coded_error import CodedValueError, guest_message_for_code
from podcast_mcp.util.project_state import RenderBusyError
from podcast_mcp.util.proxy_paths import is_allowed_local_gui_path

CODE = "x-sharecut-error-code"
RELAYED = {"x-sharecut-relayed": "1"}
PLANTED = "planted-host-text"
SHOW_TITLE = "Private Show Title"
PREFIX = "/api/review/{token}/daw/transcript"
TWINS = {n: r for n, r in GUEST_OWNER_ROUTES.items() if n.startswith("transcript_")}
TARGET = {"track_id": "host", "source_id": None, "word_index": 1}
TIMING = {"target": TARGET, "expected_word": {"text": "there", "start": 0.5, "end": 0.9}}
TAKE = {**TIMING, "target": {**TARGET, "source_id": "take", "word_index": 0}}
TAKE = {**TAKE, "expected_word": {"text": "again", "start": 1.0, "end": 1.4}}
OWNER = {
    "transcript_vocabulary_get": ("GET", "/api/transcript/vocabulary"),
    "transcript_vocabulary_put": ("PUT", "/api/transcript/vocabulary"),
    "transcript_refine_status": ("GET", "/api/transcript/refine/status"),
    "transcript_refine_done": ("POST", "/api/transcript/refine/done"),
    "transcript_refine_waive": ("POST", "/api/transcript/refine/waive"),
    "transcript_replacement_preview": ("POST", "/api/transcript/replacement-preview"),
    "transcript_word_timing_context": ("POST", "/api/transcript/word-timing-context"),
    "transcript_export": ("POST", "/api/transcript/export"),
    "transcript_exports": ("GET", "/api/transcript/exports"),
}
VOCABULARY = {"terms": ["Sharecut"], "guest_names": ["Ana"], "base_revision": "current"}
BODIES = {
    "transcript_vocabulary_put": VOCABULARY,
    "transcript_refine_done": {},
    "transcript_refine_waive": {"reason": "Cut anyway"},
    "transcript_replacement_preview": {"search": "there", "replacement": "here"},
    "transcript_word_timing_context": TIMING,
    "transcript_export": {"formats": ["md", "srt"]},
}


@pytest.fixture
def world(minimal_project, sample_wav, tmp_workspace):
    ws = seed_transcript_project(minimal_project, sample_wav, with_take=True)
    TranscriptPrecorrectService(ws).update_context(values={"show_title": SHOW_TITLE})
    version = ReviewService(ws).publish(label="Transcript")["id"]
    tokens = {
        link: ShareService(ws).create(
            review_version_id=version, capabilities=capabilities_for_role("editor")
        )["token"]
        for link in ("editor", "other")
    }
    app = create_app()
    return SimpleNamespace(
        client=TestClient(app), app=app, ws=ws, tokens=tokens, share=ShareService(ws)
    )


def _live(world, body):
    if not body or body.get("base_revision") != "current":
        return body
    revision = TranscriptPrecorrectService.vocabulary_status(world.ws.path)["revision"]
    return {**body, "base_revision": revision}


def _guest(world, name: str, body=None, link: str = "editor"):
    row = TWINS[name]
    url = row.path.format(token=world.tokens[link])
    if row.method == "GET":
        return world.client.get(url)
    body = BODIES.get(name) if body is None else body
    return world.client.request(row.method, url, json=_live(world, body))


def _owner(world, name: str, body=None):
    method, url = OWNER[name]
    path = str(world.ws.path)
    if method == "GET":
        return world.client.get(url, params={"path": path})
    return world.client.request(method, url, json={**(_live(world, body) or {}), "path": path})


def _export_dir(world) -> Path:
    return world.ws.project.export_dir()


def _exported_names(world) -> list[str]:
    return sorted(p.name for p in _export_dir(world).iterdir())


def _sidecar_missing(world) -> bool:
    return not REFINE_GATE.path(load_project(world.ws.path)).exists()


def _pair(world, name: str, body=None):
    return _guest(world, name, body), _owner(
        world, name, BODIES.get(name) if body is None else body
    )


def _assert_refused(res, status: int, code: str) -> None:
    assert (res.status_code, res.headers[CODE]) == (status, code)
    assert res.json() == {"detail": guest_message_for_code(code)}


def _view(res) -> tuple[str, str | None, str]:
    return res.json()["status"], res.json()["source"], res.json()["notes"]


def _assert_logged_as_the_share(world, caplog) -> None:
    assert f"by=share:{share_id(world)}" in caplog.text
    assert world.tokens["editor"][:8] not in caplog.text


def _leaks(world, text: str) -> list[str]:
    return [
        hidden
        for hidden in (str(world.ws.path.parent), str(world.ws.path), "raw/host.wav", PLANTED)
        if hidden in text
    ]


def _assert_refused_like_owner(guest, owner, status: int, code: str) -> None:
    _assert_refused(guest, status, code)
    assert (owner.status_code, owner.headers[CODE]) == (status, code)


def _projected(name: str, owner_json):
    if name == "transcript_vocabulary_get":
        return {key: owner_json[key] for key in GUEST_VOCABULARY_KEYS}
    return owner_json


def test_every_transcript_row_is_mounted_and_none_needs_the_render_flag() -> None:
    assert set(TWINS) == set(OWNER)
    assert not any(row.needs_guest_render for row in TWINS.values())
    for name, row in TWINS.items():
        assert row.path.replace("/api/review/{token}/daw", "/api") == OWNER[name][1]
        assert row.method == OWNER[name][0]


@pytest.mark.parametrize("name", sorted(TWINS))
def test_no_twin_answers_with_a_host_path(world, name) -> None:
    if name == "transcript_exports":
        _guest(world, "transcript_export", {"formats": ["md"]})

    res = _guest(world, name)

    assert res.status_code == 200, res.text
    assert _leaks(world, res.text) == []


@pytest.mark.parametrize(
    ("name", "extra"),
    [
        ("transcript_vocabulary_put", {"path": "/x"}),
        ("transcript_refine_done", {"path": "/x"}),
        ("transcript_refine_done", {"source": "user"}),
        ("transcript_refine_waive", {"source": "agent"}),
        ("transcript_replacement_preview", {"path": "/x"}),
        ("transcript_word_timing_context", {"path": "/x"}),
        ("transcript_word_timing_context", {"target": {**TARGET, "path": "/x"}}),
        ("transcript_export", {"path": "/x"}),
        ("transcript_export", {"dest": "/x"}),
        ("transcript_export", {"filename": "x.md"}),
        ("transcript_export", {"output_dir": "/x"}),
        ("transcript_vocabulary_put", {"terms": ["x" * 101]}),
        ("transcript_vocabulary_put", {"guest_names": ["a"] * 101}),
        ("transcript_vocabulary_put", {"base_revision": "r" * 65}),
        ("transcript_refine_done", {"notes": "n" * 501}),
        ("transcript_refine_done", {"expected_fingerprint": "f" * 65}),
        ("transcript_refine_waive", {"reason": ""}),
        ("transcript_refine_waive", {"reason": "   "}),
        ("transcript_refine_waive", {"reason": "r" * 501}),
        ("transcript_replacement_preview", {"search": ""}),
        ("transcript_replacement_preview", {"search": "a" * 201}),
        ("transcript_replacement_preview", {"search": " ".join(["a"] * 21)}),
        ("transcript_replacement_preview", {"replacement": "b" * 501}),
        ("transcript_word_timing_context", {"target": {**TARGET, "track_id": "t" * 201}}),
        ("transcript_word_timing_context", {"target": {**TARGET, "word_index": -1}}),
        (
            "transcript_word_timing_context",
            {"expected_word": {"text": "w" * 201, "start": 0, "end": 1}},
        ),
        ("transcript_export", {"formats": []}),
        ("transcript_export", {"formats": ["pdf"]}),
        ("transcript_export", {"formats": ["../x"]}),
        ("transcript_export", {"formats": ["md", "md"]}),
        ("transcript_export", {"formats": ["md", "srt", "vtt", "txt", "md"]}),
    ],
)
def test_a_body_outside_the_twins_shape_is_422_and_changes_nothing(world, name, extra) -> None:
    res = _guest(world, name, {**BODIES.get(name, {}), **extra})

    assert res.status_code == 422
    assert _exported_names(world) == []
    assert _sidecar_missing(world)


def test_a_vocabulary_body_without_a_base_revision_is_422(world) -> None:
    assert (
        _guest(world, "transcript_vocabulary_put", {"terms": [], "guest_names": []}).status_code
        == 422
    )


def test_the_export_format_set_is_the_hosts_transcript_formats() -> None:
    (annotation,) = get_args(GuestTranscriptExportRequest.model_fields["formats"].annotation)
    assert get_args(annotation) == TRANSCRIPT_FORMATS


@pytest.mark.parametrize(
    ("name", "body"),
    [
        ("transcript_vocabulary_get", None),
        ("transcript_refine_status", None),
        ("transcript_replacement_preview", None),
        ("transcript_word_timing_context", TIMING),
        ("transcript_word_timing_context", TAKE),
        ("transcript_export", {"dry_run": True, "with_text": True}),
    ],
)
def test_the_reads_and_previews_answer_what_the_owner_answers(world, name, body) -> None:
    before = world.ws.path.read_bytes()

    guest, owner = _pair(world, name, body)

    assert guest.status_code == owner.status_code == 200
    assert guest.json() == _projected(name, owner.json())
    assert world.ws.path.read_bytes() == before
    assert _exported_names(world) == []


def test_the_vocabulary_shows_only_what_an_editor_may_change(world) -> None:
    owner = _owner(world, "transcript_vocabulary_get")
    assert owner.json()["show_title"] == SHOW_TITLE
    assert owner.json()["edited_tracks"] == ["host"]

    got = _guest(world, "transcript_vocabulary_get")
    saved = _guest(world, "transcript_vocabulary_put")

    for res in (got, saved):
        assert res.status_code == 200
        assert set(res.json()) == set(GUEST_VOCABULARY_KEYS)
        assert SHOW_TITLE not in res.text
        assert "edited_tracks" not in res.text


def test_the_vocabulary_saves_and_a_stale_save_is_the_owners_409(world, caplog) -> None:
    with caplog.at_level(
        logging.INFO, logger="podcast_mcp.services.collaboration.guest_transcript_ops"
    ):
        saved = _guest(world, "transcript_vocabulary_put")

    assert saved.status_code == 200
    assert (saved.json()["terms"], saved.json()["guest_names"]) == (["Sharecut"], ["Ana"])
    assert _guest(world, "transcript_vocabulary_get").json() == saved.json()
    _assert_logged_as_the_share(world, caplog)

    stale, owner = _pair(
        world, "transcript_vocabulary_put", {**VOCABULARY, "base_revision": "stale"}
    )

    _assert_refused_like_owner(stale, owner, 409, "vocabulary_conflict")
    assert _guest(world, "transcript_vocabulary_put").status_code == 200


def test_a_busy_context_lock_is_the_fixed_503(world, monkeypatch) -> None:
    def busy(self, **_kwargs):
        raise Timeout(str(world.ws.path))

    monkeypatch.setattr(TranscriptPrecorrectService, "set_vocabulary", busy)

    _assert_refused(_guest(world, "transcript_vocabulary_put"), 503, "project_busy")


def test_a_bare_error_in_a_service_is_the_fixed_500(world, monkeypatch) -> None:
    monkeypatch.setattr(
        TranscriptPrecorrectService, "set_vocabulary", raising(RuntimeError(PLANTED))
    )

    res = _guest(world, "transcript_vocabulary_put")

    assert (res.status_code, res.json()) == (500, {"detail": "internal error"})
    assert PLANTED not in res.text


def test_a_done_mark_records_the_share_as_the_actor_and_marks_the_note(world) -> None:
    res = _guest(world, "transcript_refine_done", {"notes": " Looks right "})

    assert res.status_code == 200
    stored = sidecar(world)
    assert stored["status"] == "done"
    assert stored["source"] == f"{SHARE_ACTOR_PREFIX}{share_id(world)}"
    assert stored["notes"] == f"{GUEST_NOTE_PREFIX}Looks right"
    assert _view(res) == ("done", "guest", "")
    assert _guest(world, "transcript_refine_status").json() == res.json()
    assert _owner(world, "transcript_refine_status").json()["source"] == stored["source"]


def test_each_share_is_its_own_actor_and_a_repeat_writes_nothing(world) -> None:
    _guest(world, "transcript_refine_done")
    first = sidecar(world)
    assert _guest(world, "transcript_refine_done").status_code == 200
    assert sidecar(world) == first

    other = _guest(world, "transcript_refine_waive", link="other")

    assert other.status_code == 200
    assert sidecar(world) == first
    assert share_id(world, "other") != share_id(world)


def test_a_waiver_records_the_share_and_a_marked_reason(world) -> None:
    res = _guest(world, "transcript_refine_waive")

    assert _view(res) == ("waived", "guest", "")
    stored = sidecar(world)
    assert stored["source"] == f"{SHARE_ACTOR_PREFIX}{share_id(world)}"
    assert stored["notes"] == f"{GUEST_NOTE_PREFIX}Cut anyway"


@pytest.mark.parametrize(
    ("host_action", "body"),
    [
        ("transcript_refine_done", {"notes": f"host {PLANTED}"}),
        ("transcript_refine_waive", {"reason": f"host {PLANTED}"}),
    ],
)
def test_a_waiver_never_overwrites_a_gate_that_is_already_clear(world, host_action, body) -> None:
    assert _owner(world, host_action, body).status_code == 200
    before = sidecar(world)

    res = _guest(world, "transcript_refine_waive")

    assert res.status_code == 200
    assert sidecar(world) == before
    assert before["source"] == "user"
    assert _view(res)[1:] == ("user", "")
    assert PLANTED not in res.text


@pytest.mark.refine_gate
@pytest.mark.parametrize("name", ["transcript_refine_done", "transcript_refine_waive"])
def test_an_editor_mark_clears_the_hosts_gate_like_the_hosts_would(world, name) -> None:
    defaults = {"analysis": {"transcript_refine": {"mode": "require"}}}
    with pytest.raises(TranscriptRefineRequiredError):
        REFINE_GATE.assert_clear(load_project(world.ws.path), defaults=defaults)

    assert _guest(world, name).status_code == 200

    REFINE_GATE.assert_clear(load_project(world.ws.path), defaults=defaults)
    assert _owner(world, "transcript_refine_status").json()["source"].startswith(SHARE_ACTOR_PREFIX)


def test_the_hosts_notes_and_source_are_shown_only_as_the_source(world) -> None:
    assert (
        _owner(world, "transcript_refine_waive", {"reason": f"private {PLANTED}"}).status_code
        == 200
    )

    res = _guest(world, "transcript_refine_status")

    assert _view(res) == ("waived", "user", "")
    assert PLANTED not in res.text


@pytest.mark.parametrize(
    ("fingerprint", "status"), [("0" * 16, 409), (None, 200), ("current", 200)]
)
def test_a_done_mark_checks_the_fingerprint_only_when_given(world, fingerprint, status) -> None:
    if fingerprint == "current":
        fingerprint = _guest(world, "transcript_refine_status").json()["fingerprint"]
    body = {} if fingerprint is None else {"expected_fingerprint": fingerprint}

    guest, owner = _pair(world, "transcript_refine_done", body)

    assert guest.status_code == status
    if status == 409:
        _assert_refused_like_owner(guest, owner, 409, "transcript_changed")
        assert _sidecar_missing(world)
    else:
        assert sidecar(world)["status"] == "done"


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        (
            {**TIMING, "expected_word": {"text": "changed", "start": 0.5, "end": 0.9}},
            409,
            "transcript_timing_changed",
        ),
        ({**TIMING, "target": {**TARGET, "word_index": 99}}, 409, "transcript_timing_changed"),
        ({**TIMING, "target": {**TARGET, "track_id": "ghost"}}, 409, "transcript_timing_changed"),
        ({**TIMING, "target": {**TARGET, "source_id": "ghost"}}, 409, "transcript_timing_changed"),
    ],
)
def test_a_stale_word_is_the_owners_409(world, body, status, code) -> None:
    guest, owner = _pair(world, "transcript_word_timing_context", body)

    _assert_refused_like_owner(guest, owner, status, code)


def test_a_missing_recording_is_the_owners_404_without_its_path(world) -> None:
    (world.ws.project.raw_dir() / "host.wav").unlink()

    guest, owner = _pair(world, "transcript_word_timing_context", TIMING)

    _assert_refused_like_owner(guest, owner, 404, "word_not_found")


def test_the_export_writes_the_project_files_and_names_no_path(world, caplog) -> None:
    owner_dry = _owner(world, "transcript_export", {"formats": ["md", "srt"], "dry_run": True})

    with caplog.at_level(
        logging.INFO, logger="podcast_mcp.services.collaboration.guest_transcript_ops"
    ):
        res = _guest(world, "transcript_export", {"formats": ["md", "srt"], "with_text": True})

    view = res.json()
    assert res.status_code == 200
    assert set(view) == set(owner_dry.json())
    assert [f["format"] for f in view["files"]] == ["md", "srt"]
    for row in view["files"]:
        assert set(row) == set(GUEST_EXPORT_FILE_KEYS)
        assert (_export_dir(world) / row["name"]).is_file()
        assert row["written"] and row["current"]
    assert _exported_names(world) == sorted(f["name"] for f in view["files"])
    assert view["text"]
    assert _leaks(world, res.text) == []
    _assert_logged_as_the_share(world, caplog)


def test_the_default_formats_are_md_and_srt(world) -> None:
    res = _guest(world, "transcript_export", {})

    assert [f["format"] for f in res.json()["files"]] == ["md", "srt"]


def test_a_dry_run_writes_nothing_and_has_no_text_unless_asked(world) -> None:
    res = _guest(world, "transcript_export", {"dry_run": True})

    assert (res.status_code, res.json()["files"], res.json()["text"]) == (200, [], None)
    assert _exported_names(world) == []


def test_an_export_replaces_a_same_named_host_file(world) -> None:
    name = _guest(world, "transcript_export", {"formats": ["md"]}).json()["files"][0]["name"]
    (_export_dir(world) / name).write_text("host's hand-edited notes")

    res = _guest(world, "transcript_export", {"formats": ["md"]})

    assert res.status_code == 200
    assert "hand-edited" not in (_export_dir(world) / name).read_text()


def test_the_listing_names_the_files_and_whether_they_are_current(world) -> None:
    assert _guest(world, "transcript_exports").json() == []
    _guest(world, "transcript_export", {"formats": ["txt", "vtt"]})

    guest, owner = _pair(world, "transcript_exports")

    expected = [{k: row[k] for k in GUEST_EXPORTED_KEYS} for row in owner.json()]
    assert guest.json() == expected
    assert {row["format"] for row in guest.json()} == {"txt", "vtt"}
    assert all(row["current"] for row in guest.json())
    assert _leaks(world, guest.text) == []


def test_an_empty_transcript_is_refused_on_a_write_and_previews_on_a_dry_run(world) -> None:
    project = load_project(world.ws.path)
    project.transcripts = []
    save_project(project, world.ws.path)

    guest, owner = _pair(world, "transcript_export", {})

    _assert_refused_like_owner(guest, owner, 409, "transcript_empty")
    assert _guest(world, "transcript_export", {"dry_run": True}).status_code == 200


def test_a_folder_in_a_files_place_is_refused_without_naming_it(world) -> None:
    name = _guest(world, "transcript_export", {"formats": ["md"]}).json()["files"][0]["name"]
    (_export_dir(world) / name).unlink()
    (_export_dir(world) / name).mkdir()

    guest, owner = _pair(world, "transcript_export", {"formats": ["md"]})

    _assert_refused_like_owner(guest, owner, 400, "export_target_not_file")
    assert name not in guest.text


def test_a_render_held_past_the_timeout_is_the_busy_503(world, monkeypatch) -> None:
    def held(*_args, **_kwargs):
        raise RenderBusyError(str(world.ws.path))

    monkeypatch.setattr("podcast_mcp.services.document.transcript.render_lock", held)

    guest, owner = _pair(world, "transcript_export", {})

    _assert_refused_like_owner(guest, owner, 503, "export_busy")
    assert _exported_names(world) == []


def test_exports_beyond_the_slots_are_the_busy_503_and_a_slot_comes_back(
    world, monkeypatch
) -> None:
    monkeypatch.setattr(guest_transcript_ops, "EXPORT_SLOTS", threading.BoundedSemaphore(1))
    started, gate = threading.Event(), threading.Event()
    answer = TranscriptExport("en", 1, 1.0, [], None, [], None)

    def held(self, formats, **_kwargs):
        started.set()
        assert gate.wait(5)
        return answer

    monkeypatch.setattr(TranscriptService, "export", held)
    first: list = []
    worker = threading.Thread(target=lambda: first.append(_guest(world, "transcript_export", {})))
    worker.start()
    try:
        assert started.wait(5)
        _assert_refused(_guest(world, "transcript_export", {}), 503, "export_busy")
    finally:
        gate.set()
        worker.join(5)

    assert first[0].status_code == 200
    assert _guest(world, "transcript_export", {}).status_code == 200


@pytest.mark.parametrize(
    ("name", "service", "attribute", "error", "status", "code"),
    [
        (
            "transcript_vocabulary_put",
            TranscriptPrecorrectService,
            "set_vocabulary",
            VocabularyConflictError(PLANTED),
            409,
            "vocabulary_conflict",
        ),
        (
            "transcript_vocabulary_put",
            TranscriptPrecorrectService,
            "set_vocabulary",
            CodedValueError(PLANTED, code="vocabulary_empty"),
            400,
            "vocabulary_empty",
        ),
        (
            "transcript_vocabulary_put",
            TranscriptPrecorrectService,
            "set_vocabulary",
            CodedValueError(PLANTED, code="vocabulary_prompt_too_long"),
            400,
            "vocabulary_prompt_too_long",
        ),
        (
            "transcript_refine_done",
            TranscriptRefineService,
            "mark_checked",
            TranscriptChangedSinceReviewError(PLANTED),
            409,
            "transcript_changed",
        ),
        (
            "transcript_refine_done",
            TranscriptRefineService,
            "mark_checked",
            CodedValueError(PLANTED, code="gate_text_too_long"),
            400,
            "gate_text_too_long",
        ),
        (
            "transcript_refine_waive",
            TranscriptRefineService,
            "waive",
            CodedValueError(PLANTED, code="empty_text"),
            400,
            "empty_text",
        ),
        (
            "transcript_replacement_preview",
            TranscriptService,
            "preview_transcript_replacement",
            CodedValueError(PLANTED, code="replacement_token_invalid"),
            400,
            "replacement_token_invalid",
        ),
        (
            "transcript_replacement_preview",
            TranscriptService,
            "preview_transcript_replacement",
            CodedValueError(PLANTED, code="transcript_source_ambiguous"),
            400,
            "transcript_source_ambiguous",
        ),
        (
            "transcript_word_timing_context",
            TranscriptService,
            "word_timing_context",
            TranscriptTimingChangedError(PLANTED),
            409,
            "transcript_timing_changed",
        ),
        (
            "transcript_word_timing_context",
            TranscriptService,
            "word_timing_context",
            KeyError(PLANTED),
            404,
            "word_not_found",
        ),
        (
            "transcript_word_timing_context",
            TranscriptService,
            "word_timing_context",
            FileNotFoundError(PLANTED),
            404,
            "word_not_found",
        ),
        (
            "transcript_export",
            TranscriptService,
            "export",
            ExportBusyError(PLANTED),
            503,
            "export_busy",
        ),
        (
            "transcript_export",
            TranscriptService,
            "export",
            TranscriptEmptyError(PLANTED),
            409,
            "transcript_empty",
        ),
        (
            "transcript_export",
            TranscriptService,
            "export",
            CodedValueError(PLANTED, code="export_target_not_file"),
            400,
            "export_target_not_file",
        ),
    ],
)
def test_a_domain_refusal_keeps_the_owners_status_and_code_with_fixed_copy(
    world, monkeypatch, name, service, attribute, error, status, code
) -> None:
    monkeypatch.setattr(service, attribute, raising(error))

    guest, owner = _pair(world, name)

    _assert_refused_like_owner(guest, owner, status, code)
    assert PLANTED not in guest.text


@pytest.mark.parametrize("name", sorted(OWNER))
def test_a_relayed_owner_call_is_refused(world, name) -> None:
    method, url = OWNER[name]
    body = {**BODIES.get(name, {}), "path": str(world.ws.path)}

    res = world.client.request(
        method, url, json=body, params=body if method == "GET" else None, headers=RELAYED
    )

    assert (res.status_code, res.headers[CODE]) == (403, "authz_denied")
    assert _exported_names(world) == []
    assert _sidecar_missing(world)


def test_the_tunnel_admits_the_twins_and_not_the_owner_routes() -> None:
    for name, (_method, url) in OWNER.items():
        assert not is_allowed_local_gui_path(url, "tok")
        assert is_allowed_local_gui_path(TWINS[name].path.format(token="tok"), "tok")
