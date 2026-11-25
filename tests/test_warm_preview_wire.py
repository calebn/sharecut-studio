# ruff: noqa: F811
"""Wire shape of the pending-preview warm replies, pinned at the service and the HTTP route."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.document import PlayService, SessionSuggestionService, WarmPreviewResult

sys.path.insert(0, str(Path(__file__).parent))

from test_pending_preview import _rendered_project, _session_cut
from test_record_session_preview import (
    _replace,
    _svc,
    ws,  # noqa: F401
)

pytestmark = pytest.mark.unscoped_ok

READY = {"current": "ready", "suggested": "ready", "ab": "ready"}
UNAVAILABLE = {"current": "unavailable", "suggested": "unavailable", "ab": "unavailable"}
FAILED = {"current": "failed", "suggested": "failed", "ab": "failed"}


@pytest.fixture(autouse=True)
def _silent_pads(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "podcast_mcp.edits.cut_application.filler_pad_mode", lambda **_kw: "silence"
    )


def _text(trim: float, sides: dict[str, str]) -> str:
    return json.dumps({"trim_db": trim, "sides": sides}, separators=(",", ":"))


def _trim(monkeypatch: pytest.MonkeyPatch, value: float) -> None:
    monkeypatch.setattr(PlayService, "mix_trim_db", lambda self, **_kw: value)


def _post(client: TestClient, project, **params):
    return client.post("/api/pending-preview/warm", params={"path": str(project), **params})


def _pending(minimal_project):
    return _rendered_project(minimal_project, _session_cut("cut", 2.0, 2.6))


def _real_trim(minimal_project) -> float:
    return PlayService(_pending(minimal_project)).mix_trim_db()


def test_no_edit_id_has_empty_sides_and_the_key_order(minimal_project, monkeypatch) -> None:
    ws_ = _pending(minimal_project)
    _trim(monkeypatch, -2.25)
    out = PlayService(ws_).warm_pending_preview()
    assert isinstance(out, WarmPreviewResult)
    assert out.model_dump() == {"trim_db": -2.25, "sides": {}}
    assert list(out.model_dump()) == ["trim_db", "sides"]
    assert type(out.trim_db) is float
    assert json.dumps(out.model_dump()) == '{"trim_db": -2.25, "sides": {}}'


def test_an_edit_id_reports_each_side_in_order(minimal_project, monkeypatch) -> None:
    ws_ = _pending(minimal_project)
    _trim(monkeypatch, -1.5)
    out = PlayService(ws_).warm_pending_preview("cut")
    assert list(out.model_dump()) == ["trim_db", "sides"]
    assert list(out.sides) == ["current", "suggested", "ab"]
    assert out.model_dump() == {"trim_db": -1.5, "sides": READY}
    assert json.dumps(out.model_dump()) == (
        '{"trim_db": -1.5, "sides": {"current": "ready", "suggested": "ready", "ab": "ready"}}'
    )


def test_an_unknown_edit_id_is_unavailable_on_every_side(minimal_project, monkeypatch) -> None:
    ws_ = _pending(minimal_project)
    _trim(monkeypatch, -1.5)
    out = PlayService(ws_).warm_pending_preview("missing")
    assert list(out.sides) == ["current", "suggested", "ab"]
    assert out.model_dump() == {"trim_db": -1.5, "sides": UNAVAILABLE}


def test_an_os_error_in_a_render_marks_every_side_failed(minimal_project, monkeypatch) -> None:
    ws_ = _pending(minimal_project)
    _trim(monkeypatch, -1.5)

    def broken(self, *_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(PlayService, "play_pending_preview", broken)
    out = PlayService(ws_).warm_pending_preview("cut")
    assert out.model_dump() == {"trim_db": -1.5, "sides": FAILED}
    assert list(out.sides) == ["current", "suggested", "ab"]


def test_mixed_side_outcomes_keep_their_own_status(minimal_project, monkeypatch) -> None:
    ws_ = _pending(minimal_project)
    _trim(monkeypatch, 0.0)
    real = PlayService.play_pending_preview

    def mixed(self, edit_id, *, mode, **kwargs):
        if mode == "suggested":
            raise ValueError("no suggested side")
        if mode == "ab":
            raise OSError("boom")
        return real(self, edit_id, mode=mode, **kwargs)

    monkeypatch.setattr(PlayService, "play_pending_preview", mixed)
    assert PlayService(ws_).warm_pending_preview("cut").model_dump() == {
        "trim_db": 0.0,
        "sides": {"current": "ready", "suggested": "unavailable", "ab": "failed"},
    }


@pytest.mark.parametrize("trim", [0.0, -0.1, -6.02])
def test_trim_values_pass_through_as_floats(minimal_project, monkeypatch, trim) -> None:
    ws_ = _pending(minimal_project)
    _trim(monkeypatch, trim)
    out = PlayService(ws_).warm_pending_preview()
    assert out.trim_db == trim
    assert type(out.trim_db) is float
    assert json.dumps(out.model_dump()) == f'{{"trim_db": {trim!r}, "sides": {{}}}}'


def test_the_real_trim_is_a_non_positive_float(minimal_project) -> None:
    trim = _real_trim(minimal_project)
    out = PlayService(_pending(minimal_project)).warm_pending_preview()
    assert out.trim_db == trim
    assert type(trim) is float
    assert trim <= 0.0


def test_a_project_with_no_gains_trims_nothing(minimal_project, monkeypatch) -> None:
    ws_ = _pending(minimal_project)
    monkeypatch.setattr("podcast_mcp.services.document.play_headroom.mix_gains", lambda _p: {})
    out = PlayService(ws_).warm_pending_preview("missing")
    assert out.model_dump() == {"trim_db": 0.0, "sides": UNAVAILABLE}
    assert json.dumps(out.model_dump())[:15] == '{"trim_db": 0.0'


@pytest.mark.parametrize("pad", [0.0, 0.5, 3.0, 10.0])
def test_pad_sec_variants_keep_the_same_shape(minimal_project, monkeypatch, pad) -> None:
    ws_ = _pending(minimal_project)
    _trim(monkeypatch, -1.0)
    out = PlayService(ws_).warm_pending_preview("cut", pad_sec=pad)
    assert out.model_dump() == {"trim_db": -1.0, "sides": READY}


def test_the_route_returns_the_exact_text_without_an_edit(minimal_project, monkeypatch) -> None:
    _pending(minimal_project)
    _trim(monkeypatch, -2.25)
    res = _post(TestClient(create_app()), minimal_project)
    assert res.status_code == 200
    assert res.text == '{"trim_db":-2.25,"sides":{}}'


def test_the_route_returns_the_exact_text_for_ready_sides(minimal_project, monkeypatch) -> None:
    _pending(minimal_project)
    _trim(monkeypatch, -1.5)
    res = _post(TestClient(create_app()), minimal_project, edit_id="cut")
    assert res.status_code == 200
    assert res.text == _text(-1.5, READY)
    assert res.text == (
        '{"trim_db":-1.5,"sides":{"current":"ready","suggested":"ready","ab":"ready"}}'
    )


@pytest.mark.parametrize("pad", ["0", "0.5", "3", "10"])
def test_the_route_pad_variants_keep_the_exact_text(minimal_project, monkeypatch, pad) -> None:
    _pending(minimal_project)
    _trim(monkeypatch, 0.0)
    res = _post(TestClient(create_app()), minimal_project, edit_id="cut", pad_sec=pad)
    assert res.status_code == 200
    assert res.text == _text(0.0, READY)
    assert res.text.startswith('{"trim_db":0.0,')


def test_the_route_reports_an_unknown_edit_as_unavailable(minimal_project, monkeypatch) -> None:
    _pending(minimal_project)
    _trim(monkeypatch, -1.5)
    res = _post(TestClient(create_app()), minimal_project, edit_id="missing")
    assert res.status_code == 200
    assert res.text == _text(-1.5, UNAVAILABLE)


def test_the_route_reports_a_render_failure(minimal_project, monkeypatch) -> None:
    _pending(minimal_project)
    _trim(monkeypatch, -1.5)

    def broken(self, *_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(PlayService, "play_pending_preview", broken)
    res = _post(TestClient(create_app()), minimal_project, edit_id="cut")
    assert res.status_code == 200
    assert res.text == _text(-1.5, FAILED)


def test_the_background_route_ignores_the_edit_and_returns_empty_sides(
    minimal_project, monkeypatch
) -> None:
    _pending(minimal_project)
    _trim(monkeypatch, -4.0)
    started: list[object] = []
    monkeypatch.setattr(
        "podcast_mcp.services.document.warm_in_background", lambda path: started.append(path)
    )
    res = _post(TestClient(create_app()), minimal_project, edit_id="cut", background="true")
    assert res.status_code == 200
    assert res.text == '{"trim_db":-4.0,"sides":{}}'
    assert len(started) == 1


def test_a_value_error_keeps_its_bad_request_reply(minimal_project, monkeypatch) -> None:
    _pending(minimal_project)

    def refuse(self, *_args, **_kwargs):
        raise ValueError("cannot warm")

    monkeypatch.setattr(PlayService, "warm_pending_preview", refuse)
    client = TestClient(create_app())
    foreground = _post(client, minimal_project, edit_id="cut")
    background = _post(client, minimal_project, background="true")
    assert foreground.status_code == background.status_code == 400
    assert foreground.text == background.text == '{"detail":"cannot warm"}'
    assert foreground.headers == background.headers


def test_an_out_of_range_pad_keeps_its_422(minimal_project) -> None:
    res = _post(TestClient(create_app()), minimal_project, edit_id="cut", pad_sec="11")
    assert res.status_code == 422


def _session(ws) -> str:
    return _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})


def test_session_warm_reports_ready_sides_in_order(ws, monkeypatch) -> None:
    sid = _session(ws)
    _trim(monkeypatch, -3.5)
    out = _svc(ws).warm(sid)
    assert list(out.model_dump()) == ["trim_db", "sides"]
    assert list(out.sides) == ["current", "suggested"]
    assert out.model_dump() == {
        "trim_db": -3.5,
        "sides": {"current": "ready", "suggested": "ready"},
    }
    assert json.dumps(out.model_dump()) == (
        '{"trim_db": -3.5, "sides": {"current": "ready", "suggested": "ready"}}'
    )


def test_session_warm_trim_zero_and_negative(ws, monkeypatch) -> None:
    sid = _session(ws)
    for value in (0.0, -7.25):
        _trim(monkeypatch, value)
        out = _svc(ws).warm(sid)
        assert out.trim_db == value
        assert type(out.trim_db) is float


def test_session_warm_marks_unavailable_and_failed_sides(ws, monkeypatch) -> None:
    sid = _session(ws)
    _trim(monkeypatch, 0.0)

    def refuse(self, *_args, **_kwargs):
        raise ValueError("refused")

    monkeypatch.setattr(SessionSuggestionService, "preview", refuse)
    assert _svc(ws).warm(sid).model_dump() == {
        "trim_db": 0.0,
        "sides": {"current": "unavailable", "suggested": "unavailable"},
    }

    def broken(self, *_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(SessionSuggestionService, "preview", broken)
    out = _svc(ws).warm(sid)
    assert out.model_dump() == {
        "trim_db": 0.0,
        "sides": {"current": "failed", "suggested": "failed"},
    }
    assert list(out.sides) == ["current", "suggested"]


def test_session_warm_mixes_side_outcomes(ws, monkeypatch) -> None:
    sid = _session(ws)
    _trim(monkeypatch, -1.0)
    real = SessionSuggestionService.preview

    def mixed(self, suggestion_id, *, mode, **kwargs):
        if mode == "suggested":
            raise OSError("boom")
        return real(self, suggestion_id, mode=mode, **kwargs)

    monkeypatch.setattr(SessionSuggestionService, "preview", mixed)
    assert _svc(ws).warm(sid).model_dump() == {
        "trim_db": -1.0,
        "sides": {"current": "ready", "suggested": "failed"},
    }


def _session_post(client, project, **params):
    return client.post(
        "/api/session-suggestion/warm",
        params={"path": str(project), **params},
    )


def test_the_session_route_returns_the_exact_text(ws, minimal_project, monkeypatch) -> None:
    sid = _session(ws)
    _trim(monkeypatch, -3.5)
    res = _session_post(TestClient(create_app()), minimal_project, suggestion_id=sid)
    assert res.status_code == 200
    assert res.text == '{"trim_db":-3.5,"sides":{"current":"ready","suggested":"ready"}}'


def test_the_session_route_reports_failed_and_unavailable_sides(
    ws, minimal_project, monkeypatch
) -> None:
    sid = _session(ws)
    _trim(monkeypatch, 0.0)
    client = TestClient(create_app())

    def refuse(self, *_args, **_kwargs):
        raise ValueError("refused")

    monkeypatch.setattr(SessionSuggestionService, "preview", refuse)
    res = _session_post(client, minimal_project, suggestion_id=sid)
    assert res.status_code == 200
    assert res.text == '{"trim_db":0.0,"sides":{"current":"unavailable","suggested":"unavailable"}}'

    def broken(self, *_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(SessionSuggestionService, "preview", broken)
    res = _session_post(client, minimal_project, suggestion_id=sid)
    assert res.status_code == 200
    assert res.text == '{"trim_db":0.0,"sides":{"current":"failed","suggested":"failed"}}'


def test_the_session_route_keeps_its_error_replies(ws, minimal_project, monkeypatch) -> None:
    sid = _session(ws)
    client = TestClient(create_app())
    missing = _session_post(client, minimal_project, suggestion_id="ss-nope")
    assert missing.status_code == 404
    assert missing.headers["X-Sharecut-Error-Code"] == "session_suggestion_not_found"

    def refuse(self, *_args, **_kwargs):
        raise ValueError("cannot warm")

    monkeypatch.setattr(PlayService, "warm_pending_preview", refuse)
    bad = _session_post(client, minimal_project, suggestion_id=sid)
    assert bad.status_code == 400
    assert bad.text == '{"detail":"cannot warm"}'
