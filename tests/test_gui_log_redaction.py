"""The uvicorn log filter masks a link token, and a token route's query, before a handler runs."""

from __future__ import annotations

import logging

from podcast_mcp.gui.log_redaction import ShareTokenFilter, install

TOKEN = "velvet-quokka-umbra"


def _format(msg: str, *args: object) -> str:
    record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, msg, args, None)
    ShareTokenFilter().filter(record)
    return record.getMessage()


def test_a_websocket_accept_line_loses_the_token_and_the_guest_name() -> None:
    line = _format(
        '%s - "WebSocket %s" [accepted]',
        "127.0.0.1:5000",
        f"/api/rec/{TOKEN}/ws?name=Ava&client_id=viewer-1",
    )

    assert line == '127.0.0.1:5000 - "WebSocket /api/rec/<share-token>/ws" [accepted]'


def test_an_access_line_for_a_host_route_loses_the_token() -> None:
    line = _format(
        '%s - "%s %s HTTP/%s" %d',
        "127.0.0.1:5000",
        "POST",
        f"/api/shares/{TOKEN}/revoke",
        "1.1",
        200,
    )

    assert TOKEN not in line
    assert "/api/shares/<share-token>/revoke" in line
    assert line.endswith("200")


def test_a_token_encoded_in_the_query_of_another_route_is_masked() -> None:
    line = _format('"GET %s"', f"/auth/login/github?next=%2Fr%2F{TOKEN}")

    assert "quokka" not in line
    assert "/auth/login/github?next=" in line


def test_a_line_without_a_token_is_unchanged() -> None:
    assert _format("GET %s", "/api/health?marker=keep") == "GET /api/health?marker=keep"


def test_install_adds_one_filter_per_uvicorn_logger() -> None:
    install()
    install()

    for name in ("uvicorn.access", "uvicorn.error"):
        found = [f for f in logging.getLogger(name).filters if isinstance(f, ShareTokenFilter)]
        assert len(found) == 1
