"""Load standalone relay offline HTML from static CSS/HTML files."""

from __future__ import annotations

import html
from functools import lru_cache
from pathlib import Path

_STATIC = Path(__file__).resolve().parent / "static"


@lru_cache(maxsize=1)
def _static_text(name: str) -> str:
    return (_STATIC / name).read_text(encoding="utf-8")


def offline_page(*, title: str, heading: str, body_html: str) -> str:
    """Fill the offline template. *body_html* is trusted markup (``<p>`` / ``<code>``)."""
    css = _static_text("brand-tokens.css") + "\n" + _static_text("offline.css")
    return (
        _static_text("offline.html")
        .replace("__TITLE__", html.escape(title), 1)
        .replace("__CSS__", css, 1)
        .replace("__HEADING__", html.escape(heading), 1)
        .replace("__BODY__", body_html, 1)
    )
