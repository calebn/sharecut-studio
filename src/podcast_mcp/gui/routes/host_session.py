"""Trade the engine's single-use code for the owner's browser session (hosts without trusted loopback)."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse
from starlette.responses import Response

from podcast_mcp.gui.routes.deps import NO_STORE, coded_http_error
from podcast_mcp.util.host_session_wire import EXCHANGE_PARAM, EXCHANGE_PATH, SESSION_COOKIE

router = APIRouter()

REFUSED = "This link was already used or has expired. Reopen the app."

# The cookie is SameSite=Strict, and a browser withholds it from a redirect chain that began on
# another site (the app's splash page). A page of this origin that then navigates to ``/`` starts
# a same-site chain, so ``/`` loads with the cookie. The page CSP forbids inline script, so the
# hop is a meta refresh.
HANDOVER_PAGE = (
    "<!doctype html>\n"
    '<html lang="en"><head><meta charset="utf-8">'
    '<meta http-equiv="refresh" content="0; url=/">'
    "<title>ShareCut</title></head>"
    '<body><p>Opening ShareCut. <a href="/">Continue</a></p></body></html>\n'
)


@router.get(EXCHANGE_PATH, include_in_schema=False)
def exchange_session(request: Request, code: str = Query("", alias=EXCHANGE_PARAM)) -> Response:
    """A valid code sets the session cookie and hands the browser to a clean ``/`` from this origin.

    Any other code gets 403 and no cookie. The code and the session id are never echoed.
    """
    session_id = request.app.state.host_sessions.redeem(code)
    if session_id is None:
        raise coded_http_error(403, REFUSED, code="session_exchange_refused", headers=NO_STORE)
    response = HTMLResponse(HANDOVER_PAGE, headers=NO_STORE)
    # No Secure flag and no Max-Age: the origin is http loopback and the session ends with the app.
    response.set_cookie(SESSION_COOKIE, session_id, httponly=True, samesite="strict", path="/")
    return response
