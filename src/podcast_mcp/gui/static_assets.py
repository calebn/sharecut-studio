"""Static /assets with long-cache headers for Vite hashed filenames."""

from __future__ import annotations

import os
from pathlib import Path

from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

_REPO_GUI_DIST = Path(__file__).resolve().parents[3] / "gui" / "web" / "dist"


def repo_gui_dist() -> Path:
    """Sharecut Studio web build as laid out in this repository."""
    return _REPO_GUI_DIST


def resolve_gui_static_root() -> Path:
    """Directory FastAPI serves for ``/`` and ``/assets``.

    Frozen desktop sidecars set ``PODCAST_GUI_DIST`` to the bundled ``web-dist``.
    An explicit ``create_app(static_dir=…)`` still wins over this helper.
    """
    raw = os.environ.get("PODCAST_GUI_DIST", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return repo_gui_dist()


class ImmutableAssetsStaticFiles(StaticFiles):
    """Serve hashed build assets with immutable Cache-Control."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response
