from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from filelock import Timeout
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response

from podcast_mcp import __version__, settings
from podcast_mcp.config.runtime import normalize_exact_origin
from podcast_mcp.extensions.loader import apply_gui_extensions, load_extensions
from podcast_mcp.gui.audio import PENDING_PREVIEW_HEADER_NAMES
from podcast_mcp.gui.host_mcp import host_mcp_lifespan, mount_host_mcp
from podcast_mcp.gui.job_events import gui_agent_job_progress_sink, gui_sse_progress_sink
from podcast_mcp.gui.middleware_host_binding import HostOriginBindingMiddleware
from podcast_mcp.gui.middleware_security_headers import SecurityHeadersMiddleware
from podcast_mcp.gui.routes import (
    bootstrap,
    boundary,
    comments,
    diagnostics,
    document,
    export_routes,
    feed_routes,
    handoff,
    host,
    media,
    pipeline,
    project,
    record_host,
    session,
    speaker,
    transcript,
    waveform,
)
from podcast_mcp.gui.routes.deps import (
    ERROR_CODE_HEADER,
    NO_STORE,
    coded_http_error,
    guard_exception_handler,
    host_setup_exception_handler,
    http_exception_response,
    model_missing_exception_handler,
    project_busy_exception_handler,
    project_unreadable_exception_handler,
    require_host,
)
from podcast_mcp.gui.routes.session import apply_ws_client_message, apply_ws_viewer_state
from podcast_mcp.gui.static_assets import (
    ImmutableAssetsStaticFiles,
    missing_bundle_response,
    resolve_gui_static_root,
    static_bundle_ready,
)
from podcast_mcp.gui.validation_errors import format_validation_errors
from podcast_mcp.models.episode import ProjectUnreadableError
from podcast_mcp.project.io import adopt_retired_entry_file
from podcast_mcp.services.document import cross_process_bridge
from podcast_mcp.services.jobs import shared_job_manager
from podcast_mcp.services.media import TranscriptContextBusyError
from podcast_mcp.util.body_limits import MaxBodySizeMiddleware, gui_max_body_bytes
from podcast_mcp.util.coded_error import GuardRefusal, HostSetupError
from podcast_mcp.util.model_missing import ModelMissing
from podcast_mcp.util.progress import register_guest_progress_sink, register_progress_sink

__all__ = ["apply_ws_client_message", "apply_ws_viewer_state", "create_app"]

log = logging.getLogger(__name__)

_DEAD_SHARE_HEAD = '<title>ShareCut Studio</title>\n    <meta name="robots" content="noindex" />'


CORS_ORIGINS_ENV = "PODCAST_REVIEW_CORS_ORIGINS"


def _cors_origins() -> list[str]:
    """Loopback defaults plus exact origins from ``PODCAST_REVIEW_CORS_ORIGINS``.

    Credentials are allowed, so every entry must be an exact origin: a wildcard
    or malformed entry raises ``RuntimeConfigError`` and the GUI does not start.
    """

    defaults = [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8765",
        "http://localhost:8765",
    ]
    extra = settings.value(CORS_ORIGINS_ENV)
    return defaults + [
        normalize_exact_origin(CORS_ORIGINS_ENV, o.strip()) for o in extra.split(",") if o.strip()
    ]


def _project_mismatch(requested: str, served: Path) -> bool:
    """Whether a ``?project=`` value names a project this instance doesn't serve."""
    try:
        requested_path = Path(requested).expanduser().resolve()
    except (OSError, ValueError):
        return True
    try:
        served_path = served.resolve()
    except (OSError, ValueError):
        return True
    return requested_path != served_path


async def _validation_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Return a safe validation response while retaining FastAPI's list contract."""
    if not isinstance(exc, RequestValidationError):
        raise exc
    headers = {ERROR_CODE_HEADER: "invalid_request"}
    if request.url.path.startswith("/api/review/"):
        headers.update(NO_STORE)
    return JSONResponse(
        status_code=422,
        content=format_validation_errors(exc.errors()),
        headers=headers,
    )


async def _http_exception_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, StarletteHTTPException)
    return await http_exception_response(request, exc)


def _accepts_html(request: Request) -> bool:
    """Whether the caller explicitly accepts an HTML recovery document."""
    return "text/html" in request.headers.get("accept", "").lower()


#: ``/?home=1`` shows the host home without the pinned-project redirect
#: (the not-served cover's "All projects", Studio New project).
#: Must match gui/web/src/utils/projectUrl.ts (test_home_query_param_matches_the_gui).
HOME_QUERY_PARAM = "home"


def _recovery_query(request: Request, served: Path, *, include_project: bool) -> str:
    """Build recovery links from allowlisted values only."""
    query: dict[str, str] = {}
    if include_project:
        query["project"] = str(served)
    else:
        query[HOME_QUERY_PARAM] = "1"
    session_token = request.query_params.get("session_token")
    if session_token:
        query["session_token"] = session_token
    return urlencode(query)


def _pinned_root_redirect(request: Request, served: Path) -> RedirectResponse | None:
    """Send a bare ``/`` to the pinned project instead of the host home (#533).

    Home used to unpin on mount, so a bookmark, tab restore or preview tool
    opening the root silently closed a CLI-pinned project. Only host-authorized
    callers are redirected (the Location names the served path); an explicit
    ``project``, a ``review`` share or ``home`` keeps the page as asked.

    The ``served.is_file()`` check is not locked against a concurrent unpin or
    file removal. That race is benign: the redirected ``?project=`` request goes
    through the usual mismatch / recovery handling.
    """
    params = request.query_params
    if any(key in params for key in ("project", "review", HOME_QUERY_PARAM)):
        return None
    if not served.is_file():
        return None
    try:
        require_host(request, token=params.get("session_token"))
    except GuardRefusal:
        return None
    try:
        query = request.url.include_query_params(project=str(served)).query
    except UnicodeEncodeError:
        return None
    # A query-only Location resolves against the URL the browser asked for, so a
    # mount prefix or a path-rewriting proxy cannot send it to the wrong path.
    return RedirectResponse(
        f"?{query}",
        status_code=307,
        headers={"Cache-Control": "no-store"},
    )


#: The element the SPA reads to draw the "isn't open on this computer" cover
#: (gui/web/src/utils/notServed.ts, test_not_served_element_id_matches_the_gui).
NOT_SERVED_ELEMENT_ID = "sharecut-not-served"


def _project_mismatch_page(request: Request, served: Path, index_path: Path) -> HTMLResponse:
    """The app shell with HTTP 403 for browser navigation to a non-served project.

    The SPA draws the Status cover from the JSON this embeds (the served episode's
    name and the two ways forward); the project API still returns JSON 403 for API
    clients. This page is only served from the HTML index route.
    """
    from podcast_mcp.models import load_project
    from podcast_mcp.services.collaboration import inject_share_document_head

    try:
        name = (load_project(served).meta.name or "").strip() or served.name
    except Exception:
        name = served.name
    payload = json.dumps(
        {
            "name": name,
            "open_href": "/?" + _recovery_query(request, served, include_project=True),
            "home_href": "/?" + _recovery_query(request, served, include_project=False),
        }
    ).replace("<", "\\u003c")
    head = (
        "<title>This episode isn&rsquo;t open on this computer &mdash; ShareCut Studio</title>\n"
        f'    <script type="application/json" id="{NOT_SERVED_ELEMENT_ID}">{payload}</script>'
    )
    return HTMLResponse(
        inject_share_document_head(index_path.read_text(encoding="utf-8"), head),
        status_code=403,
        headers={"Cache-Control": "no-cache"},
    )


@asynccontextmanager
async def _gui_lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Run the host MCP session manager for the app's life, announce the served project to
    local CLIs once the server accepts connections (#1733), then withdraw that and stop the
    cross-process watchers on shutdown (#695)."""
    try:
        async with host_mcp_lifespan(app):
            port = getattr(app.state, "listen_port", None)
            if port is not None:
                host = getattr(app.state, "listen_host", None)
                await asyncio.to_thread(handoff.listening, app, port=port, host=host)
            yield
    finally:
        await asyncio.to_thread(handoff.stopped, app)
        cross_process_bridge().stop_all()


def create_app(
    *,
    static_dir: Path | None = None,
    served_project: Path | None = None,
    bind_host: str = "127.0.0.1",
) -> FastAPI:

    from podcast_mcp.services.session_sync import is_bind_loopback

    jobs = shared_job_manager(reset=True)
    register_progress_sink(gui_sse_progress_sink)
    register_progress_sink(gui_agent_job_progress_sink)
    from podcast_mcp.services.collaboration import guest_ws_progress_sink, reset_guest_progress_hub

    reset_guest_progress_hub()
    register_guest_progress_sink(guest_ws_progress_sink)
    # OpenAPI/Swagger stay available for local DX; set PODCAST_GUI_OPENAPI=0 to disable
    # (recommended for any non-loopback bind). Public relay never serves Swagger.
    enable_openapi = settings.text("PODCAST_GUI_OPENAPI", "1").lower() not in {
        "0",
        "false",
        "no",
    }
    app = FastAPI(
        title="Podcast MCP Viewer",
        version=__version__,
        docs_url="/docs" if enable_openapi else None,
        redoc_url="/redoc" if enable_openapi else None,
        openapi_url="/openapi.json" if enable_openapi else None,
        lifespan=_gui_lifespan,
    )
    app.state.jobs = jobs
    app.state.diagnostics_bundles = {}
    app.state.studio_host = handoff.StudioHostState(bind_host)
    handoff.set_served_project(
        app, adopt_retired_entry_file(served_project) if served_project is not None else None
    )
    app.add_exception_handler(RequestValidationError, _validation_error_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    # The one busy mapping (#488, #1810): routes let a lock timeout propagate to it.
    app.add_exception_handler(Timeout, project_busy_exception_handler)
    app.add_exception_handler(TranscriptContextBusyError, project_busy_exception_handler)
    app.add_exception_handler(ProjectUnreadableError, project_unreadable_exception_handler)
    app.add_exception_handler(GuardRefusal, guard_exception_handler)
    app.add_exception_handler(HostSetupError, host_setup_exception_handler)
    app.add_exception_handler(ModelMissing, model_missing_exception_handler)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=[ERROR_CODE_HEADER, "Retry-After", *PENDING_PREVIEW_HEADER_NAMES],
    )
    app.add_middleware(GZipMiddleware, minimum_size=500)
    app.add_middleware(MaxBodySizeMiddleware, limit=gui_max_body_bytes())
    app.add_middleware(HostOriginBindingMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)

    # Core FOSS routes only - share/auth/remote MCP come from extensions.
    app.include_router(project.router)
    app.include_router(boundary.router)
    app.include_router(waveform.router)
    app.include_router(session.router)
    app.include_router(host.router)
    app.include_router(handoff.router)
    app.include_router(transcript.router)
    app.include_router(record_host.router)
    app.include_router(document.router)
    app.include_router(pipeline.router)
    app.include_router(bootstrap.router)
    app.include_router(diagnostics.router)
    app.include_router(export_routes.router)
    app.include_router(feed_routes.router)
    app.include_router(speaker.router)
    app.include_router(comments.router)
    app.include_router(media.router)

    registry = load_extensions()
    apply_gui_extensions(app, registry)

    @app.get("/api/features")
    def api_features() -> dict[str, Any]:
        """ShareCut Studio Extensions manifest (absent features = empty list)."""
        return registry.to_manifest()

    static_root = static_dir or resolve_gui_static_root()
    if static_bundle_ready(static_root):
        assets_dir = static_root / "assets"
        if assets_dir.is_dir():
            app.mount(
                "/assets",
                ImmutableAssetsStaticFiles(directory=assets_dir),
                name="assets",
            )

        @app.get("/")
        def index(request: Request) -> Any:
            index_path = static_root / "index.html"
            served = getattr(request.app.state, "served_project", None)
            if served is None:
                return FileResponse(
                    index_path,
                    headers={"Cache-Control": "no-cache"},
                )
            redirect = _pinned_root_redirect(request, Path(served))
            if redirect is not None:
                return redirect
            requested = request.query_params.get("project")
            if requested and _project_mismatch(requested, Path(served)):
                if not _accepts_html(request):
                    raise coded_http_error(
                        403,
                        "project path not allowed for this server instance",
                        code="project_path_not_allowed",
                    )
                require_host(request, token=request.query_params.get("session_token"))
                return _project_mismatch_page(request, Path(served), index_path)
            try:
                from podcast_mcp.models import load_project
                from podcast_mcp.services.collaboration import (
                    build_share_head_tags,
                    inject_share_document_head,
                )

                project_obj = load_project(Path(served))
                name = (project_obj.meta.name or "").strip() or "ShareCut Studio"
                head = build_share_head_tags(
                    title=name,
                    description=f"ShareCut Studio - {name}",
                    page_url=str(request.base_url).rstrip("/") + "/",
                )
                body = inject_share_document_head(
                    index_path.read_text(encoding="utf-8"),
                    head,
                )
                return HTMLResponse(
                    body,
                    headers={"Cache-Control": "no-cache"},
                )
            except Exception:
                return FileResponse(
                    index_path,
                    headers={"Cache-Control": "no-cache"},
                )

        favicon_path = static_root / "favicon.svg"

        @app.get("/favicon.svg")
        def favicon_svg() -> Any:
            if not favicon_path.is_file():
                raise coded_http_error(404, "favicon not found", code="static_asset_not_found")
            return FileResponse(favicon_path, media_type="image/svg+xml")

        @app.get("/favicon.ico")
        def favicon_ico() -> Any:
            """Browsers often request .ico; serve the SVG when present."""
            if not favicon_path.is_file():
                raise coded_http_error(404, "favicon not found", code="static_asset_not_found")
            return FileResponse(favicon_path, media_type="image/svg+xml")

        if registry.has("share.ui.routes"):

            @app.get("/r/{token}")
            def review_spa(token: str, request: Request) -> Any:
                """Guest SPA - only mounted when share.ui.routes extension is present."""
                return _serve_share_spa(token, request, kind="review")

            @app.get("/rec/{token}")
            def record_spa(token: str, request: Request) -> Any:
                """Record lobby SPA - only mounted when share.ui.routes is present."""
                return _serve_share_spa(token, request, kind="record")

            def _serve_share_spa(token: str, request: Request, *, kind: str) -> Any:
                from podcast_mcp.gui.routes.guest_errors import guest_boundary, guest_http_error
                from podcast_mcp.services.collaboration import (
                    inject_share_document_head,
                    lookup_share,
                )
                from podcast_mcp.util.coded_error import CodedKeyError

                index_path = static_root / "index.html"
                try:
                    lookup_share(token, kind=kind)
                except CodedKeyError as exc:
                    if exc.code != "share_not_found":
                        raise guest_http_error(exc, logger=log, operation="share page") from exc
                    with guest_boundary(log, "share page"):
                        shell = inject_share_document_head(
                            index_path.read_text(encoding="utf-8"), _DEAD_SHARE_HEAD
                        )
                    return HTMLResponse(
                        shell,
                        headers={"Cache-Control": "no-cache", "X-Robots-Tag": "noindex"},
                    )
                except Exception as exc:
                    raise guest_http_error(exc, logger=log, operation="share page") from exc
                with guest_boundary(log, "share page"):
                    index_html = index_path.read_text(encoding="utf-8")
                for hook in registry.spa_hooks:
                    try:
                        body = hook(
                            token=token,
                            request=request,
                            index_html=index_html,
                            kind=kind,
                        )
                        return HTMLResponse(
                            body,
                            headers={"Cache-Control": "no-cache"},
                        )
                    except Exception as exc:
                        log.debug("spa_hook failed: %s", exc)
                        continue
                return FileResponse(
                    index_path,
                    headers={"Cache-Control": "no-cache"},
                )

    else:

        @app.get("/")
        def missing_web_build() -> Any:
            return missing_bundle_response(static_root)

    # Exact ``/mcp`` last: guest ``/mcp/{token}`` stays on the share router.
    mount_host_mcp(app, enabled=is_bind_loopback(bind_host))
    return app
