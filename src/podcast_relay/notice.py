"""First-visit notice for guests of an install the relay cannot vouch for.

A guest who opens a page link (``/r/`` or ``/rec/``) of a legacy-tier host sees one short page
first. The same goes for a browser sent straight to ``/api/review/``, ``/api/rec/`` or ``/mcp/``,
but only when the host answers with HTML: those paths also carry downloads and JSON, which the
relay streams through untouched. Continue sets a session cookie of the relay's own and sends the
guest on to the link. The cookie is not a secret: forging it only skips a courtesy notice for the
person who forged it. It lives in the guest's browser, never on the host, and it is set before any
host page has been served, so host script cannot have set it for anyone else. Only the notice
page's own form may set it: a POST from another site is refused, so a page elsewhere cannot
pre-continue a visitor.
"""

from __future__ import annotations

import html
from urllib.parse import parse_qs, unquote, urlsplit

from fastapi import Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from starlette.requests import ClientDisconnect

from podcast_relay.limits import check_notice_continue
from podcast_relay.offline import offline_page

NOTICE_COOKIE = "sc_notice"
CONTINUE_PATH = "/api/relay/notice/continue"
# Trailing slashes keep "mcpx/" and "api/recfoo/" out. One set of tuples drives the gate and the
# return allowlist so they cannot drift.
_GATED_BEFORE_FORWARD = ("r/", "rec/")
# These paths serve downloads and JSON as well, so the host's response decides.
_GATED_BY_RESPONSE = ("api/review/", "api/rec/", "mcp/")
_PAGE_PREFIXES = _GATED_BEFORE_FORWARD + _GATED_BY_RESPONSE
_RETURN_PREFIXES = tuple(f"/{prefix}" for prefix in _PAGE_PREFIXES)
_FORM_TYPE = "application/x-www-form-urlencoded"
# The form holds one short path; this keeps a POST from making the relay buffer a large body.
_MAX_FORM_BYTES = 4096


def is_page_navigation(request: Request, path_suffix: str) -> bool:
    """True for a browser opening a link, not for the page's own fetch, socket or media calls."""
    if request.method != "GET" or not path_suffix.startswith(_PAGE_PREFIXES):
        return False
    mode = request.headers.get("sec-fetch-mode")
    if mode is not None:
        return mode == "navigate" and request.headers.get("sec-fetch-dest") == "document"
    return "text/html" in request.headers.get("accept", "")


def is_gated_before_forward(path_suffix: str) -> bool:
    """True for a link page, where the notice replaces the host's answer before it is asked."""
    return path_suffix.startswith(_GATED_BEFORE_FORWARD)


def has_seen_notice(request: Request) -> bool:
    return request.cookies.get(NOTICE_COOKIE) == "1"


def _return_to(request: Request) -> str:
    # The raw path keeps %25 and %2F in a file name; the decoded one would not round trip.
    raw = request.scope.get("raw_path")
    path = raw.decode("latin-1").split("?", 1)[0] if raw else request.url.path
    query = f"?{request.url.query}" if request.url.query else ""
    return f"{path}{query}"


def notice_response(request: Request) -> Response:
    # The return path rides in the body: the guest page's path can hold the share token.
    next_field = html.escape(_return_to(request), quote=True)
    body = (
        "<p>Someone shared this from their own computer. ShareCut hasn't reviewed it, "
        "so only continue if you know and trust the person who sent it.</p>\n"
        "<p>Your browser needs to allow cookies for this page to continue.</p>\n"
        f'<form method="post" action="{CONTINUE_PATH}">'
        f'<input type="hidden" name="next" value="{next_field}">'
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
    if not target.startswith(_RETURN_PREFIXES) or "//" in path or "\\" in target:
        return None
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in target):
        return None
    decoded = unquote(path).replace("\\", "/")
    if any(segment in (".", "..") for segment in decoded.split("/")):
        return None
    return target


def _refusal(text: str, status: int) -> Response:
    return HTMLResponse(text, status_code=status, headers={"Cache-Control": "no-store"})


def _too_many_response(retry_after: str) -> Response:
    page = offline_page(
        title="Too many tries",
        heading="Too many tries",
        body_html=(
            "<p>Too many attempts from your network. "
            "Wait a few seconds, then go back to the link and try again.</p>"
        ),
    )
    return HTMLResponse(
        page,
        status_code=429,
        headers={
            "Retry-After": retry_after,
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex",
        },
    )


async def _read_form_next(request: Request) -> tuple[str | None, Response | None]:
    """The form's first ``next`` value (None when absent), or a refusal.

    Parsed by hand: Starlette's form parser needs a package the relay image does not install.
    """
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != _FORM_TYPE:
        return None, _refusal("Unsupported media type", 415)
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > _MAX_FORM_BYTES:
        return None, _refusal("Payload too large", 413)
    raw = bytearray()
    try:
        async for chunk in request.stream():
            raw += chunk
            if len(raw) > _MAX_FORM_BYTES:
                return None, _refusal("Payload too large", 413)
    except ClientDisconnect:
        return None, _refusal("Bad request", 400)
    values = parse_qs(raw.decode("utf-8", "replace"), keep_blank_values=True).get("next")
    return (values[0] if values else None), None


async def continue_response(request: Request) -> Response:
    # Order matters: a cross-site POST carries the victim's IP, so it must be refused before it
    # can spend that IP's limiter tokens.
    if not is_same_origin_post(request):
        return _refusal("Forbidden", 403)
    client_ip = request.client.host if request.client else None
    decision = check_notice_continue(client_ip)
    if not decision.allowed:
        return _too_many_response(decision.retry_after_header)
    posted, refusal = await _read_form_next(request)
    if refusal is not None:
        return refusal
    # Pages served before this change still post ``?next=``; drop the fallback once they expire.
    target = safe_return_path(
        posted if posted is not None else request.query_params.get("next", "")
    )
    if target is None:
        return _refusal("Not found", 404)
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
