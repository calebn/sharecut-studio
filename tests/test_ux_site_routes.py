"""Keep the UX site's navigation, route table, and Markdown pages in sync."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_ux_navigation_routes_resolve_to_existing_pages() -> None:
    html = (ROOT / "ux/index.html").read_text(encoding="utf-8")
    script = (ROOT / "ux/assets/site.js").read_text(encoding="utf-8")
    routes = dict(re.findall(r'^\s*(\w+): \{ file: "([\w-]+\.md)"', script, re.MULTILINE))
    links = re.findall(r'href="#/(\w+)" data-nav="(\w+)"', html)

    assert links
    for route, nav in links:
        assert route == nav
        assert route in routes
        assert (ROOT / "ux/pages" / routes[route]).is_file()
