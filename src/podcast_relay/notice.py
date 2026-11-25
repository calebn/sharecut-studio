"""First-visit notice for guests of an install the relay cannot vouch for.

A guest who opens a page link (``/r/`` or ``/rec/``) of a legacy-tier host sees one short page
first. Continue sets a session cookie of the relay's own and sends the guest on to the link. The
cookie is not a secret: forging it only skips a courtesy notice for the person who forged it. It
lives in the guest's browser, never on the host, and it is set before any host page has been
served, so host script cannot have set it for anyone else. Only the notice page's own form may set
it: a POST from another site is refused, so a page elsewhere cannot pre-continue a visitor.
"""

from __future__ import annotations

import html
from urllib.parse import quote, urlsplit

from fastapi import Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from podcast_relay.offline import offline_page

NOTICE_COOKIE = "sc_notice"
CONTINUE_PATH = "/notice/continue"
_PAGE_PREFIXES = ("r/", "rec/")


def is_page_navigation(request: Request, path_suffix: str) -> bool:
    """True for a browser opening a link page, not for the page's own API, socket or audio calls."""
    if request.method != "GET" or not path_suffix.startswith(_PAGE_PREFIXES):
        return False
    mode = request.headers.get("sec-fetch-mode")
    if mode is not None:
        return mode == "navigate" and request.headers.get("sec-fetch-dest") == "document"
    return "text/html" in request.headers.get("accept", "")


def has_seen_notice(request: Request) -> bool:
    return request.cookies.get(NOTICE_COOKIE) == "1"


def _return_to(request: Request) -> str:
    query = f"?{request.url.query}" if request.url.query else ""
    return f"{request.url.path}{query}"


def notice_response(request: Request) -> Response:
    action = f"{CONTINUE_PATH}?next={quote(_return_to(request), safe='')}"
    body = (
        "<p>Someone shared this from their own computer. ShareCut hasn't reviewed it, "
        "so only continue if you know and trust the person who sent it.</p>\n"
        "<p>Your browser needs to allow cookies for this page to continue.</p>\n"
        f'<form method="post" action="{html.escape(action)}">'
        '<button type="submit">Continue</button></form>'
    )
    page = offline_page(
        title="Shared through ShareCut",
        heading="This link is shared through ShareCut",
        body_html=body,
    )
    return HTMLResponse(page, headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"})


def is_same_origin_post(request: Request) -> bool:
    """True when the browser says this POST came from a page of this origin.

    ``Sec-Fetch-Site`` is the browser's own word; ``Origin`` covers one that sends only that. A
    request with neither, such as a script, is refused.
    """
    site = request.headers.get("sec-fetch-site")
    if site is not None:
        return site == "same-origin"
    origin = request.headers.get("origin")
    return origin is not None and urlsplit(origin).netloc == request.url.netloc


def safe_return_path(target: str) -> str | None:
    """*target* when it stays on a link page of this origin, else None."""
    path = target.split("?", 1)[0]
    if not target.startswith(("/r/", "/rec/")) or "//" in path or "\\" in target:
        return None
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in target):
        return None
    return target


def continue_response(request: Request) -> Response:
    if not is_same_origin_post(request):
        return HTMLResponse("Forbidden", status_code=403)
    target = safe_return_path(request.query_params.get("next", ""))
    if target is None:
        return HTMLResponse("Not found", status_code=404)
    response = RedirectResponse(target, status_code=303)
    response.set_cookie(
        NOTICE_COOKIE,
        "1",
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )
    return response
