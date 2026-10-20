"""Error codes that name a project-data inconsistency never read as a missing request target (#1855)."""

from __future__ import annotations

import pytest

from podcast_mcp.services.document_sync.errors import names_missing_target
from podcast_mcp.util.coded_error import CodedValueError


@pytest.mark.parametrize(
    "code",
    ["pause_edit_missing", "clip_source_missing", "clip_move_invalid"],
)
def test_data_inconsistency_codes_are_not_a_missing_target(code: str) -> None:
    assert not names_missing_target(CodedValueError("x", code=code))


def test_a_missing_edit_the_command_names_still_is() -> None:
    assert names_missing_target(CodedValueError("x", code="edit_not_found"))


def test_share_identity_busy_503_keeps_its_error_code(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("fastapi")
    from filelock import Timeout
    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route
    from starlette.testclient import TestClient

    from podcast_mcp.gui import middleware_share_identity as mod

    def busy(*_args: object, **_kwargs: object) -> None:
        raise Timeout("registry.lock")

    monkeypatch.setattr(mod, "lookup_share", busy)
    app = Starlette(routes=[Route("/api/review/{token}/x", lambda _r: PlainTextResponse("ok"))])
    app.add_middleware(mod.ShareIdentityMiddleware)
    res = TestClient(app).get("/api/review/tok/x")
    assert res.status_code == 503
    assert res.headers["X-Sharecut-Error-Code"] == "project_busy"
