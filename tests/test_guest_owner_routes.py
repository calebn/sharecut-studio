"""The guest owner routes: one registry, one dependency, default-deny."""

from __future__ import annotations

import inspect
from pathlib import Path
from types import SimpleNamespace
from typing import get_type_hints

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from podcast_mcp.gui import schemas
from podcast_mcp.gui.routes import pipeline, review_editor, review_share
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.guest_routes import (
    GUEST_OWNER_ROUTES,
    GuestRoute,
    guest_owner_route,
)
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.jobs import (
    GUEST_PIPELINE_KINDS,
    GUEST_RENDER_KINDS,
    Job,
    guest_job_view,
    job_in_project,
)
from podcast_mcp.services.jobs.job import GUEST_JOB_VIEW
from podcast_mcp.util.coded_error import CodedPermissionError
from podcast_mcp.util.proxy_paths import is_allowed_local_gui_path

ALL_GUEST_KINDS = GUEST_PIPELINE_KINDS | GUEST_RENDER_KINDS
CODE = "x-sharecut-error-code"
RELAYED = {"x-sharecut-relayed": "1"}


@pytest.fixture
def world(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.render_preview",
        lambda self, **_kwargs: {"ok": True},
    )
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    version = ReviewService(ws).publish(label="Scaffold")["id"]
    tokens = {
        role: ShareService(ws).create(
            review_version_id=version, capabilities=capabilities_for_role(role)
        )["token"]
        for role in ("viewer", "commenter", "editor")
    }
    monkeypatch.setattr(
        "podcast_mcp.services.pipeline.PipelineService.run",
        lambda self, **_kwargs: SimpleNamespace(last_step=None, job_result=dict),
    )
    for check in ("ensure_whisper_cached_for_run", "ensure_word_aligner_for_run"):
        monkeypatch.setattr(f"podcast_mcp.gui.routes.pipeline_jobs.{check}", lambda *_a, **_k: None)
    app = create_app()
    return SimpleNamespace(client=TestClient(app), app=app, ws=ws, tokens=tokens)


def _url(row: GuestRoute, token: str, job_id: str) -> str:
    return row.path.format(token=token, job_id=job_id)


def _call(world, row: GuestRoute, token: str, job_id: str = "j1"):
    body = {} if row.name == "pipeline_run" else None
    return world.client.request(row.method, _url(row, token, job_id), json=body)


def _editor_job_id(world, name: str) -> str:
    if name.startswith("pipeline_job"):
        job = Job(id="pipeline-1", kind="pipeline", status="ok", project_path=str(world.ws.path))
        world.app.state.jobs._catalog._job = job
        return job.id
    if name == "pipeline_run":
        return "j1"
    start = GUEST_OWNER_ROUTES["render_preview"]
    return _call(world, start, world.tokens["editor"]).json()["job"]["id"]


def test_the_registry_rows_are_editor_twins_under_the_daw_prefix() -> None:
    assert set(GUEST_OWNER_ROUTES) == {
        "render_preview",
        "render_preview_status",
        "pipeline_run",
        "pipeline_status",
        "pipeline_job_status",
        "pipeline_job_events",
        "pipeline_job_cancel",
    }
    for name, row in GUEST_OWNER_ROUTES.items():
        assert row.name == name
        assert row.path.startswith("/api/review/{token}/daw/")
    assert GUEST_OWNER_ROUTES["render_preview"].needs_guest_render
    assert [n for n, r in GUEST_OWNER_ROUTES.items() if r.needs_guest_render] == [
        "render_preview",
        "pipeline_run",
    ]
    assert GUEST_OWNER_ROUTES["pipeline_run"].rate_kind == "mutate"
    assert GUEST_OWNER_ROUTES["render_preview"].rate_kind == "mutate"
    assert GUEST_OWNER_ROUTES["render_preview_status"].rate_kind == "read"


def test_a_route_with_no_row_is_denied() -> None:
    with pytest.raises(CodedPermissionError) as raised:
        guest_owner_route("export_start")
    assert raised.value.code == "share_capability_required"
    with pytest.raises(CodedPermissionError):
        review_editor.guest_route("export_start")


@pytest.mark.parametrize("name", sorted(GUEST_OWNER_ROUTES))
@pytest.mark.parametrize("role", ["viewer", "commenter"])
def test_each_row_refuses_commenter_and_viewer(world, name, role) -> None:
    res = _call(world, GUEST_OWNER_ROUTES[name], world.tokens[role])

    assert res.status_code == 403
    assert res.headers[CODE] == "share_capability_required"


@pytest.mark.parametrize("name", sorted(GUEST_OWNER_ROUTES))
def test_each_row_serves_the_editor_without_a_host_path(world, name) -> None:
    row = GUEST_OWNER_ROUTES[name]
    job_id = _editor_job_id(world, name)

    res = _call(world, row, world.tokens["editor"], job_id)

    assert res.status_code in {200, 202}
    assert str(world.ws.path.parent) not in res.text
    assert "project_path" not in res.text


@pytest.mark.parametrize("name", sorted(GUEST_OWNER_ROUTES))
def test_each_row_answers_404_for_a_revoked_token(world, name) -> None:
    row = GUEST_OWNER_ROUTES[name]
    ShareService(world.ws).revoke(world.tokens["editor"])

    assert _call(world, row, world.tokens["editor"]).status_code == 404


@pytest.mark.parametrize("name", sorted(GUEST_OWNER_ROUTES))
def test_each_row_takes_the_rate_limit_it_names(world, monkeypatch, name) -> None:
    seen: list[tuple[str, str]] = []
    monkeypatch.setattr(
        review_editor, "rate_limit_share", lambda token, kind: seen.append((token, kind))
    )
    row = GUEST_OWNER_ROUTES[name]

    _call(world, row, world.tokens["editor"])

    assert seen == [(world.tokens["editor"], row.rate_kind)]


def test_review_editor_routes_and_the_registry_match(world) -> None:
    mounted = {}
    for route in review_editor.router.routes:
        dependencies = [
            getattr(dep.call, "guest_route_name", None) for dep in route.dependant.dependencies
        ]
        (name,) = [n for n in dependencies if n]
        (method,) = route.methods
        mounted[name] = (method, route.path)

    assert mounted == {n: (r.method, r.path) for n, r in GUEST_OWNER_ROUTES.items()}


def test_a_bare_route_on_a_guest_router_is_refused() -> None:
    from fastapi import APIRouter, Depends

    bare = APIRouter()
    bare.get("/api/review/{token}/daw/x")(lambda token: None)
    with pytest.raises(RuntimeError, match="no registered guest_route"):
        review_editor.check_guest_router(bare, GUEST_OWNER_ROUTES)

    unregistered = APIRouter()
    unregistered.get("/api/review/{token}/daw/x", dependencies=[Depends(_named("other"))])(
        lambda token: None
    )
    with pytest.raises(RuntimeError, match="no registered guest_route"):
        review_editor.check_guest_router(unregistered, GUEST_OWNER_ROUTES)

    with pytest.raises(RuntimeError, match="without a handler"):
        review_editor.check_guest_router(APIRouter(), GUEST_OWNER_ROUTES)


def _named(name: str):
    def dependency(token: str) -> None:
        return None

    dependency.guest_route_name = name  # type: ignore[attr-defined]
    return dependency


# Body models on /api/review/ routes that are not GuestRequest, with why that is safe.
BODY_MODEL_EXCEPTIONS = {
    # Typed command union; pydantic drops unknown fields and no field names a path.
    "/api/review/{token}/daw/document/command",
    # Read-only geometry probes; extras are dropped and the project is the share's.
    "/api/review/{token}/daw/boundary/context",
    "/api/review/{token}/daw/range-audio",
}


def test_every_guest_request_body_refuses_extras_or_is_a_named_exception(world) -> None:
    from podcast_mcp.gui.schemas import GuestRequest

    seen = set()
    for route in _leaf_routes(world.app.routes):
        if "/api/review/" not in getattr(route, "path", ""):
            continue
        hints = get_type_hints(route.endpoint)
        for param in route.dependant.body_params:
            model = hints[param.name]
            seen.add(route.path)
            if route.path in BODY_MODEL_EXCEPTIONS:
                continue
            assert isinstance(model, type) and issubclass(model, GuestRequest), route.path
    assert seen >= BODY_MODEL_EXCEPTIONS


def test_job_in_project_fails_closed(tmp_path) -> None:
    project = tmp_path / "one" / "episode.sharecut"
    project.parent.mkdir()
    project.write_text("{}")
    link = tmp_path / "link.sharecut"
    link.symlink_to(project)

    def belongs(path: str, to: Path = project) -> bool:
        return job_in_project(Job(id="j", project_path=path), to)

    assert belongs(str(project))
    assert belongs(str(link))
    assert not belongs("")
    assert not belongs("", Path.cwd())
    assert not belongs(".", Path.cwd() / "nope")
    assert not belongs("episode.sharecut", Path("episode.sharecut").resolve().parent / "x")
    assert not belongs("bad\x00path")
    assert not belongs(str(tmp_path / "two" / "episode.sharecut"))


def test_the_gates_run_in_order_token_rate_opt_in_editor(world, monkeypatch) -> None:
    order: list[str] = []

    def step(name: str, result=None):
        def run(*_args, **_kwargs):
            order.append(name)
            return result

        return run

    monkeypatch.setattr(review_editor, "check_share_token", step("token"))
    monkeypatch.setattr(review_editor, "rate_limit_share", step("rate"))
    monkeypatch.setattr(review_editor, "require_guest_render", step("opt-in"))
    monkeypatch.setattr(review_editor, "require_share_edit", step("editor", (None, world.ws)))

    world.client.post(f"/api/review/{world.tokens['commenter']}/daw/render-preview")

    assert order == ["token", "rate", "opt-in", "editor"]


def test_the_get_gates_run_in_order_token_rate_editor(world, monkeypatch) -> None:
    order: list[str] = []

    def step(name: str, result=None):
        def run(*_args, **_kwargs):
            order.append(name)
            return result

        return run

    monkeypatch.setattr(review_editor, "check_share_token", step("token"))
    monkeypatch.setattr(review_editor, "rate_limit_share", step("rate"))
    monkeypatch.setattr(review_editor, "require_share_edit", step("editor", (None, world.ws)))

    world.client.get(f"/api/review/{world.tokens['viewer']}/daw/pipeline/status")

    assert order == ["token", "rate", "editor"]


def test_a_row_that_disagrees_with_its_route_is_refused() -> None:
    from fastapi import APIRouter, Depends

    row = GUEST_OWNER_ROUTES["pipeline_status"]
    for method, path in (("post", row.path), ("get", row.path + "/x")):
        drifted = APIRouter()
        getattr(drifted, method)(path, dependencies=[Depends(_named(row.name))])(lambda token: None)
        with pytest.raises(RuntimeError, match="does not match"):
            review_editor.check_guest_router(drifted, {row.name: row})


def test_no_route_outside_review_editor_claims_a_guest_route_dependency() -> None:
    for route in review_share.router.routes:
        names = [
            getattr(dep.call, "guest_route_name", None) for dep in route.dependant.dependencies
        ]
        assert not any(names), route.path


def _leaf_routes(routes):
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            yield from _leaf_routes(included.routes)
        else:
            yield route


def test_the_app_serves_exactly_the_registered_twins(world) -> None:
    served = {}
    for route in _leaf_routes(world.app.routes):
        for dep in getattr(getattr(route, "dependant", None), "dependencies", ()):
            name = getattr(dep.call, "guest_route_name", None)
            if name:
                served[name] = route.path

    assert served == {n: r.path for n, r in GUEST_OWNER_ROUTES.items()}
    assert all(
        "render-preview" not in route.path for route in _leaf_routes(review_share.router.routes)
    )


def test_owner_routes_keep_their_host_gate() -> None:
    # /api/pipeline/steps only lists static step names; every other owner route is gated.
    for route in pipeline.router.routes:
        if route.path != "/api/pipeline/steps":
            assert "require_host(" in inspect.getsource(route.endpoint), route.path


def test_relayed_owner_calls_are_still_refused(world) -> None:
    body = {"path": str(world.ws.path)}
    calls = (
        world.client.post("/api/pipeline/render-preview", json=body, headers=RELAYED),
        world.client.post("/api/pipeline/cancel", json={"job_id": "x"}, headers=RELAYED),
        world.client.get("/api/pipeline/events", headers=RELAYED),
    )
    for res in calls:
        assert res.status_code == 403
        assert res.headers[CODE] == "authz_denied"


def test_the_tunnel_allowlist_admits_the_twins_and_still_rejects_owner_routes() -> None:
    assert not is_allowed_local_gui_path("/api/pipeline/run", "tok")
    assert not is_allowed_local_gui_path("/api/pipeline/render-preview", "tok")
    assert not is_allowed_local_gui_path("/api/pipeline/cancel", "tok")
    assert not is_allowed_local_gui_path("/api/pipeline/events", "tok")
    assert not is_allowed_local_gui_path("/api/pipeline/status", "tok")
    for row in GUEST_OWNER_ROUTES.values():
        assert is_allowed_local_gui_path(row.path.format(token="tok", job_id="j"), "tok")


def test_guest_request_models_refuse_unknown_fields() -> None:
    for model, body in (
        (schemas.GuestRequest, {"path": "/x"}),
        (
            schemas.FeedGuestEditRequest,
            {"edit": {"op": "set", "key": "a", "value": "b"}, "path": "/x"},
        ),
        (schemas.ShareActionDoneRequest, {"done": True, "path": "/x"}),
        (review_share.ShareReplyRequest, {"body": "b", "author": "a", "path": "/x"}),
        (
            review_share.ShareCommentRequest,
            {"body": "b", "author": "a", "timeline_start": 0, "config": {}},
        ),
    ):
        with pytest.raises(ValidationError):
            model(**body)
    assert schemas.ShareActionDoneRequest(done=False).done is False


def test_a_guest_comment_with_an_extra_field_is_422(world) -> None:
    res = world.client.post(
        f"/api/review/{world.tokens['editor']}/comments",
        json={"body": "b", "author": "a", "timeline_start": 0, "path": "/etc/passwd"},
    )
    assert res.status_code == 422


def _job(kind: str, project: Path, status: str = "running", error: str | None = None) -> Job:
    job = Job(id="job-1", kind=kind, project_path=str(project), label=kind)
    job.status = status
    job.error = error
    return job


def test_the_job_view_table_names_what_guests_may_see(tmp_path) -> None:
    assert set(GUEST_JOB_VIEW) == {"pipeline", "render_preview"}
    project = tmp_path / "a" / "episode.sharecut"
    failed = _job("render_preview", project, "error", "boom /host/secret.wav")

    view = guest_job_view(failed, project, GUEST_RENDER_KINDS)

    assert view is not None
    assert view["error"] == "Render preview failed"
    assert "/host" not in str(view)
    for kind in ("bounce", "export", "analyze", "split_speakers", "agent", "bootstrap"):
        assert guest_job_view(_job(kind, project), project, ALL_GUEST_KINDS) is None
    assert guest_job_view(None, project, ALL_GUEST_KINDS) is None


def test_a_job_belongs_only_to_its_own_project(tmp_path) -> None:
    one = tmp_path / "one" / "episode.sharecut"
    two = tmp_path / "two" / "episode.sharecut"
    job = _job("render_preview", one)

    assert job_in_project(job, one)
    assert not job_in_project(job, two)
    assert guest_job_view(job, two, GUEST_RENDER_KINDS) is None
