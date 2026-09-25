from __future__ import annotations

import html
import logging
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from podcast_mcp.extensions.loader import apply_gui_extensions, load_extensions
from podcast_mcp.gui.bootstrap_jobs import shared_bootstrap_job_manager
from podcast_mcp.gui.host_mcp import host_mcp_lifespan, mount_host_mcp
from podcast_mcp.gui.jobs import (
    gui_agent_job_progress_sink,
    gui_sse_progress_sink,
    shared_job_manager,
)
from podcast_mcp.gui.middleware_host_binding import HostOriginBindingMiddleware
from podcast_mcp.gui.middleware_security_headers import SecurityHeadersMiddleware
from podcast_mcp.gui.routes import (
    bootstrap,
    comments,
    diagnostics,
    document,
    export_routes,
    media,
    pipeline,
    project,
    record_host,
    session,
    transcript,
    waveform,
)
from podcast_mcp.gui.routes.deps import require_host
from podcast_mcp.gui.routes.session import apply_ws_client_message
from podcast_mcp.gui.static_assets import ImmutableAssetsStaticFiles, resolve_gui_static_root
from podcast_mcp.gui.validation_errors import format_validation_errors
from podcast_mcp.util.body_limits import MaxBodySizeMiddleware, gui_max_body_bytes
from podcast_mcp.util.progress import register_guest_progress_sink, register_progress_sink

__all__ = ["apply_ws_client_message", "create_app"]

log = logging.getLogger(__name__)


def _cors_origins() -> list[str]:
    import os

    defaults = [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8765",
        "http://localhost:8765",
    ]
    extra = os.environ.get("PODCAST_REVIEW_CORS_ORIGINS", "").strip()
    if not extra:
        return defaults
    return defaults + [o.strip() for o in extra.split(",") if o.strip()]


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
    del request
    if not isinstance(exc, RequestValidationError):
        raise exc
    return JSONResponse(status_code=422, content=format_validation_errors(exc.errors()))


def _accepts_html(request: Request) -> bool:
    """Whether the caller explicitly accepts an HTML recovery document."""
    return "text/html" in request.headers.get("accept", "").lower()


def _recovery_query(request: Request, served: Path, *, include_project: bool) -> str:
    """Build recovery links from allowlisted values only."""
    query: dict[str, str] = {}
    if include_project:
        query["project"] = str(served)
    session_token = request.query_params.get("session_token")
    if session_token:
        query["session_token"] = session_token
    return urlencode(query)


def _project_mismatch_page(request: Request, served: Path) -> HTMLResponse:
    """Friendly recovery page for browser navigation to a non-served project.

    The project API still returns JSON 403 for API clients; this page is only
    served from the HTML index route so browser users get a way forward.
    """
    from podcast_mcp.models import load_project

    try:
        name = (load_project(served).meta.name or "").strip() or served.name
    except Exception:
        name = served.name
    safe_name = html.escape(name, quote=True)
    open_href = "/?" + _recovery_query(request, served, include_project=True)
    home_query = _recovery_query(request, served, include_project=False)
    home_href = "/?" + home_query if home_query else "/"
    body = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Project not served &mdash; Sharecut Studio</title>
    <link rel="stylesheet" href="/recovery.css" />
  </head>
  <body class="recovery-page">
    <main class="recovery-card">
      <h1>This project isn&rsquo;t served by this server</h1>
      <p>This server instance is now serving <strong>{safe_name}</strong>.</p>
      <div class="recovery-actions">
        <a class="primary" href="{open_href}">Open {safe_name}</a>
        <a class="secondary" href="{home_href}">Choose a different project&hellip;</a>
      </div>
    </main>
  </body>
</html>"""
    return HTMLResponse(
        body,
        status_code=403,
        headers={"Cache-Control": "no-cache"},
    )


def create_app(
    *,
    static_dir: Path | None = None,
    served_project: Path | None = None,
    bind_host: str = "127.0.0.1",
) -> FastAPI:
    import os

    from podcast_mcp.gui.routes.deps import is_bind_loopback

    jobs = shared_job_manager(reset=True)
    register_progress_sink(gui_sse_progress_sink)
    register_progress_sink(gui_agent_job_progress_sink)
    from podcast_mcp.services.guest_progress import guest_ws_progress_sink, reset_guest_progress_hub

    reset_guest_progress_hub()
    register_guest_progress_sink(guest_ws_progress_sink)
    bootstrap_jobs = shared_bootstrap_job_manager(reset=True)
    # OpenAPI/Swagger stay available for local DX; set PODCAST_GUI_OPENAPI=0 to disable
    # (recommended for any non-loopback bind). Public relay never serves Swagger.
    enable_openapi = os.environ.get("PODCAST_GUI_OPENAPI", "1").strip().lower() not in {
        "0",
        "false",
        "no",
    }
    app = FastAPI(
        title="Podcast MCP Viewer",
        version="0.1.0",
        docs_url="/docs" if enable_openapi else None,
        redoc_url="/redoc" if enable_openapi else None,
        openapi_url="/openapi.json" if enable_openapi else None,
        lifespan=host_mcp_lifespan,
    )
    app.state.jobs = jobs
    app.state.bootstrap_jobs = bootstrap_jobs
    app.state.diagnostics_bundles = {}
    app.state.served_project = served_project.resolve() if served_project is not None else None
    jobs.set_served_project(app.state.served_project)
    app.add_exception_handler(RequestValidationError, _validation_error_handler)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(GZipMiddleware, minimum_size=500)
    app.add_middleware(MaxBodySizeMiddleware, limit=gui_max_body_bytes())
    app.add_middleware(HostOriginBindingMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)

    # Core FOSS routes only - share/auth/remote MCP come from extensions.
    app.include_router(project.router)
    app.include_router(waveform.router)
    app.include_router(session.router)
    app.include_router(transcript.router)
    app.include_router(record_host.router)
    app.include_router(document.router)
    app.include_router(pipeline.router)
    app.include_router(bootstrap.router)
    app.include_router(diagnostics.router)
    app.include_router(export_routes.router)
    app.include_router(comments.router)
    app.include_router(media.router)

    registry = load_extensions()
    apply_gui_extensions(app, registry)

    @app.get("/api/features")
    def api_features() -> dict[str, Any]:
        """Sharecut Studio Extensions manifest (absent features = empty list)."""
        return registry.to_manifest()

    static_root = static_dir or resolve_gui_static_root()
    if static_root.is_dir():
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
            requested = request.query_params.get("project")
            if requested and _project_mismatch(requested, Path(served)):
                if not _accepts_html(request):
                    raise HTTPException(
                        status_code=403,
                        detail="project path not allowed for this server instance",
                    )
                require_host(request, token=request.query_params.get("session_token"))
                return _project_mismatch_page(request, Path(served))
            try:
                from podcast_mcp.models import load_project
                from podcast_mcp.services.share_page import (
                    build_share_head_tags,
                    inject_share_document_head,
                )

                project_obj = load_project(Path(served))
                name = (project_obj.meta.name or "").strip() or "Sharecut Studio"
                head = build_share_head_tags(
                    title=name,
                    description=f"Sharecut Studio - {name}",
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
                from fastapi import HTTPException

                raise HTTPException(status_code=404, detail="favicon not found")
            return FileResponse(favicon_path, media_type="image/svg+xml")

        recovery_css_path = static_root / "recovery.css"
        brand_tokens_path = static_root / "brand-tokens.css"

        @app.get("/recovery.css")
        def recovery_css() -> Any:
            """Styles for the non-served-project recovery page."""
            if not recovery_css_path.is_file():
                from fastapi import HTTPException

                raise HTTPException(status_code=404, detail="recovery.css not found")
            return FileResponse(recovery_css_path, media_type="text/css")

        @app.get("/brand-tokens.css")
        def brand_tokens_css() -> Any:
            """Shared brand tokens used by standalone recovery pages."""
            if not brand_tokens_path.is_file():
                raise HTTPException(status_code=404, detail="brand-tokens.css not found")
            return FileResponse(brand_tokens_path, media_type="text/css")

        @app.get("/favicon.ico")
        def favicon_ico() -> Any:
            """Browsers often request .ico; serve the SVG when present."""
            if not favicon_path.is_file():
                from fastapi import HTTPException

                raise HTTPException(status_code=404, detail="favicon not found")
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
                from podcast_mcp.services.share import lookup_share

                try:
                    lookup_share(token, kind=kind)
                except KeyError as exc:
                    raise HTTPException(status_code=404, detail="not found") from exc
                index_path = static_root / "index.html"
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

    # Exact ``/mcp`` last: guest ``/mcp/{token}`` stays on the share router.
    mount_host_mcp(app, enabled=is_bind_loopback(bind_host))
    return app
