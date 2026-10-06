"""Static /assets with long-cache headers for Vite hashed filenames."""

from __future__ import annotations

import html
import os
from pathlib import Path

from starlette.responses import HTMLResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

_PACKAGED_GUI_DIST = Path(__file__).resolve().parent / "web_dist"
_REPO_GUI_DIST = Path(__file__).resolve().parents[3] / "gui" / "web" / "dist"


def packaged_gui_dist() -> Path:
    """Sharecut Studio web build inside an installed wheel.

    ``hatch_build.py`` copies ``gui/web/dist`` here (``wheel-web-dist`` in
    ``pyproject.toml``) when the wheel is built after ``npm run build``.
    """
    return _PACKAGED_GUI_DIST


def repo_gui_dist() -> Path:
    """Sharecut Studio web build as laid out in this repository."""
    return _REPO_GUI_DIST


def resolve_gui_static_root() -> Path:
    """Directory FastAPI serves for ``/`` and ``/assets``.

    Order: ``PODCAST_GUI_DIST`` (frozen desktop sidecars point it at the bundled
    ``web-dist``), then the build packaged in the wheel, then the checkout's
    ``gui/web/dist``. An explicit ``create_app(static_dir=…)`` still wins.
    """
    raw = os.environ.get("PODCAST_GUI_DIST", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    if static_bundle_ready(packaged_gui_dist()):
        return packaged_gui_dist()
    return repo_gui_dist()


def static_bundle_ready(root: Path) -> bool:
    """True when ``root`` holds a built Sharecut Studio (``index.html`` present)."""
    return (root / "index.html").is_file()


def missing_bundle_message(root: Path) -> str:
    """One line saying how to get the web build when ``root`` has none.

    Release wheels ship the build; a wheel built without ``npm run build`` does
    not, and lands here until ``PODCAST_GUI_DIST`` points at a checkout's build.
    """
    return (
        f"Sharecut Studio web build not found at {root}. "
        "This install does not include it: from a source checkout run "
        "`cd gui/web && npm ci && npm run build`, then start `podcast gui` with "
        "PODCAST_GUI_DIST=<checkout>/gui/web/dist."
    )


def missing_bundle_response(root: Path) -> HTMLResponse:
    """Short page for ``GET /`` explaining the same thing; the API stays up."""
    message = html.escape(missing_bundle_message(root)).replace("`", "")
    body = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        "<title>Sharecut Studio web build missing</title></head><body>"
        "<h1>Sharecut Studio web build missing</h1>"
        f"<p>{message}</p>"
        "<p>The API and host MCP endpoint are running; only the browser UI is unavailable.</p>"
        "</body></html>"
    )
    return HTMLResponse(body, status_code=503, headers={"Cache-Control": "no-store"})


class ImmutableAssetsStaticFiles(StaticFiles):
    """Serve hashed build assets with immutable Cache-Control."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response
