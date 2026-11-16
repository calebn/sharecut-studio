"""The uvicorn log filter masks a link token, and a token route's query, before a handler runs."""

from __future__ import annotations

import io
import logging
from collections import OrderedDict, defaultdict
from collections.abc import Iterator, Mapping
from enum import Enum
from types import MappingProxyType

import pytest

from podcast_mcp.gui import bind
from podcast_mcp.gui.log_redaction import UVICORN_LOGGERS, ShareTokenFilter, install

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


def test_an_upper_case_route_that_answers_404_still_loses_the_token() -> None:
    line = _format(
        '%s - "%s %s HTTP/%s" %d',
        "127.0.0.1:5000",
        "GET",
        f"/R/{TOKEN}/daw?name=Ava",
        "1.1",
        404,
    )

    assert line == '127.0.0.1:5000 - "GET /R/<share-token>/daw HTTP/1.1" 404'


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        (f"/REC/{TOKEN}", "/REC/<share-token>"),
        (f"/Api/Review/{TOKEN}/comments?x=1", "/Api/Review/<share-token>/comments"),
        (f"/API/SHARES/{TOKEN}/REVOKE", "/API/SHARES/<share-token>/REVOKE"),
        (f"/api/Shares/Record/{TOKEN}/replace", "/api/Shares/Record/<share-token>/replace"),
        (f"/MCP/{TOKEN}/mcp", "/MCP/<share-token>/mcp"),
        (
            f"/auth/login/github?next=%2FREC%2F{TOKEN}",
            "/auth/login/github?next=%2FREC%2F<share-token>",
        ),
        (
            f"/x?next=%252FAPI%252FREVIEW%252F{TOKEN}",
            "/x?next=%252FAPI%252FREVIEW%252F<share-token>",
        ),
    ],
)
def test_mixed_case_and_encoded_routes_lose_the_token_in_a_websocket_line(
    path: str, expected: str
) -> None:
    line = _format('%s - "WebSocket %s" [accepted]', "127.0.0.1:5000", path)

    assert line == f'127.0.0.1:5000 - "WebSocket {expected}" [accepted]'


def test_a_token_encoded_in_the_query_of_another_route_is_masked() -> None:
    line = _format('"GET %s"', f"/auth/login/github?next=%2Fr%2F{TOKEN}")

    assert "quokka" not in line
    assert "/auth/login/github?next=" in line


def test_a_line_without_a_token_is_unchanged() -> None:
    assert _format("GET %s", "/api/health?marker=keep") == "GET /api/health?marker=keep"


def test_install_adds_one_filter_per_uvicorn_logger() -> None:
    install()
    install()

    for name in UVICORN_LOGGERS:
        found = [f for f in logging.getLogger(name).filters if isinstance(f, ShareTokenFilter)]
        assert len(found) == 1


@pytest.mark.usefixtures("bare_uvicorn_loggers")
def test_building_the_gui_server_installs_the_filter() -> None:
    async def app(scope: object, receive: object, send: object) -> None:
        return None

    sock = bind.exclusive_listen_socket("127.0.0.1", 0)
    try:
        bind.build_gui_server(app, sock, log_level="info", access_log=True)
    finally:
        sock.close()

    for name in UVICORN_LOGGERS:
        found = [f for f in logging.getLogger(name).filters if isinstance(f, ShareTokenFilter)]
        assert len(found) == 1


def test_an_asgi_scope_argument_loses_the_token_and_the_query() -> None:
    scope = {
        "type": "websocket",
        "path": f"/r/{TOKEN}/ws",
        "raw_path": f"/r/{TOKEN}/ws".encode(),
        "query_string": b"name=Ann&client=guest-1",
    }
    line = _format("%s [%d] Started scope=%s", "ws", 1, scope)

    assert TOKEN not in line
    assert "Ann" not in line
    assert "'type': 'websocket'" in line


def test_a_non_string_argument_without_a_token_is_passed_on_unchanged() -> None:
    scope = {"path": "/api/health"}
    record = logging.LogRecord("uvicorn.asgi", 5, __file__, 1, "%s %s", ("x", scope), None)
    ShareTokenFilter().filter(record)

    assert record.args == ("x", scope)


def test_a_lone_mapping_argument_loses_the_token() -> None:
    record = logging.LogRecord(
        "uvicorn.error", logging.INFO, __file__, 1, "%(p)s", ({"p": f"/r/{TOKEN}/ws"},), None
    )
    ShareTokenFilter().filter(record)

    assert TOKEN not in record.getMessage()


@pytest.mark.parametrize(
    "arg",
    [
        f"/r/{TOKEN}/ws".encode(),
        [f"/r/{TOKEN}/ws"],
        (f"/r/{TOKEN}/ws",),
        ValueError(f"/r/{TOKEN}/ws"),
    ],
)
def test_a_non_text_argument_holding_a_token_loses_it(arg: object) -> None:
    assert TOKEN not in _format("seen %s", arg)


def test_a_bytes_message_loses_the_token() -> None:
    record = logging.LogRecord(
        "uvicorn.error", logging.INFO, __file__, 1, f"/r/{TOKEN}/ws".encode(), (), None
    )
    ShareTokenFilter().filter(record)

    assert TOKEN not in str(record.msg)


@pytest.mark.parametrize(
    ("path", "raw_path", "leaked"),
    [
        ("/r/velvet-quokka-umbra/ws", b"/r/velvet%2Dquokka%2Dumbra/ws", "%2Dquokka"),
        (f"/r/{TOKEN}%2Fws", b"/r/x", "umbra%2Fws"),
    ],
)
def test_a_percent_encoded_token_in_a_scope_is_scrubbed(
    path: str, raw_path: bytes, leaked: str
) -> None:
    scope = {"path": path, "raw_path": raw_path, "query_string": b"name=Ann"}
    line = _format("%s", scope)

    assert "quokka" not in line
    assert "umbra" not in line
    assert leaked not in line
    assert "Ann" not in line


def test_a_read_only_mapping_argument_loses_the_token_and_the_query() -> None:
    scope = MappingProxyType({"path": f"/r/{TOKEN}/ws", "query_string": b"name=Ann"})

    line = _format("%s", scope)

    assert TOKEN not in line
    assert "Ann" not in line


def test_an_argument_whose_text_raises_is_left_alone() -> None:
    class Broken:
        def __str__(self) -> str:
            raise RuntimeError("no text")

    arg = Broken()
    record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, "%s", (arg,), None)

    assert ShareTokenFilter().filter(record)
    assert record.args == (arg,)


class _Shown(Mapping[str, int]):
    def __getitem__(self, key: str) -> int:
        return 1

    def __iter__(self) -> Iterator[str]:
        return iter(["a"])

    def __len__(self) -> int:
        return 1

    def __str__(self) -> str:
        return "shown"


@pytest.mark.parametrize(
    "arg",
    [OrderedDict(a=1), defaultdict(lambda: "dflt", a="x"), _Shown()],
    ids=["ordered", "default", "custom-str"],
)
def test_a_mapping_argument_without_a_token_stays_the_same_object(
    arg: Mapping[str, object],
) -> None:
    record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, "%s", (arg,), None)
    before = record.getMessage()

    ShareTokenFilter().filter(record)

    assert record.args is arg
    assert record.getMessage() == before


def test_a_default_mapping_keeps_serving_a_missing_key() -> None:
    arg = defaultdict(lambda: "dflt", a="x")
    record = logging.LogRecord(
        "uvicorn.error", logging.INFO, __file__, 1, "%(missing)s", (arg,), None
    )

    ShareTokenFilter().filter(record)

    assert record.getMessage() == "dflt"


def test_a_tuple_without_a_token_stays_the_same_object() -> None:
    args = ("GET", 200)
    record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, "%s %d", args, None)

    ShareTokenFilter().filter(record)

    assert record.args is args


class _NoEquality:
    def __eq__(self, other: object) -> bool:
        raise RuntimeError("compared")

    def __ne__(self, other: object) -> bool:
        raise RuntimeError("compared")

    __hash__ = None  # type: ignore[assignment]

    def __repr__(self) -> str:
        return "opaque"


@pytest.mark.parametrize(
    "arg",
    [OrderedDict(a=float("nan")), OrderedDict(a=_NoEquality())],
    ids=["nan", "raising-eq"],
)
def test_a_mapping_is_never_compared_to_decide_whether_it_changed(
    arg: Mapping[str, object],
) -> None:
    record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, "%s", (arg,), None)
    before = record.getMessage()

    ShareTokenFilter().filter(record)

    assert record.args is arg
    assert record.getMessage() == before


def test_a_tuple_is_never_compared_to_decide_whether_it_changed() -> None:
    args = (_NoEquality(), "x")
    record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, "%s %s", args, None)

    ShareTokenFilter().filter(record)

    assert record.args is args


class _RaisingEqStr(str):
    __slots__ = ()

    def __eq__(self, other: object) -> bool:
        raise RuntimeError("compared")

    def __ne__(self, other: object) -> bool:
        raise RuntimeError("compared")

    __hash__ = str.__hash__


class _UnreadableMapping(Mapping[str, object]):
    def __getitem__(self, key: str) -> object:
        raise RuntimeError("unreadable")

    def __iter__(self) -> Iterator[str]:
        raise RuntimeError("unreadable")

    def __len__(self) -> int:
        return 1

    def __str__(self) -> str:
        return f"unreadable /r/{TOKEN}/ws"


def _logged(msg: object, *args: object) -> str:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    logger = logging.getLogger("tests.filter_never_raises")
    logger.propagate = False
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    logger.addFilter(ShareTokenFilter())
    try:
        logger.info(msg, *args)
    finally:
        logger.handlers.clear()
        logger.filters.clear()
    return stream.getvalue()


def test_a_str_whose_comparison_raises_is_logged_as_it_was() -> None:
    assert _logged(_RaisingEqStr("plain %s"), _RaisingEqStr("x")) == "plain x\n"


def test_an_unreadable_token_free_mapping_is_logged_as_it_was() -> None:
    class Quiet(_UnreadableMapping):
        def __str__(self) -> str:
            return "quiet"

    assert _logged("%s", Quiet()) == "quiet\n"


def test_a_tuple_holding_an_unreadable_mapping_does_not_raise() -> None:
    assert _logged("%s %s", f"/r/{TOKEN}/ws", _UnreadableMapping()) != ""


class _Kind(str, Enum):  # noqa: UP042
    A = "hello"


class _TaggedStr(str):
    __slots__ = ()

    def __repr__(self) -> str:
        return "TAG"


@pytest.mark.parametrize(
    ("fmt", "arg", "expected"),
    [
        ("%s", _Kind.A, "hello"),
        ("%r", _Kind.A, "'hello'"),
        ("%r", _TaggedStr("x"), "'x'"),
        ("%s", _TaggedStr("x"), "x"),
    ],
    ids=["enum-s", "enum-r", "repr-r", "repr-s"],
)
def test_a_str_subclass_argument_prints_as_its_plain_text(
    fmt: str, arg: str, expected: str
) -> None:
    assert _format(fmt, arg) == expected


class _Mode(str, Enum):  # noqa: UP042
    A = "alpha"


class _StrOverride(str):
    __slots__ = ()

    def __str__(self) -> str:
        return "STR-OVERRIDE"


@pytest.mark.parametrize(
    ("fmt", "arg", "expected"),
    [
        ("%(a)s", {"a": _Mode.A}, "_Mode.A"),
        ("%(a)r", {"a": _Mode.A}, "<_Mode.A: 'alpha'>"),
        ("%(a)s", {"a": _StrOverride("v")}, "STR-OVERRIDE"),
        (
            "%(a)s %(zz)s",
            defaultdict(lambda: "DEF", a=_StrOverride("x")),
            "STR-OVERRIDE DEF",
        ),
    ],
    ids=["enum-s", "enum-r", "str-override", "defaultdict"],
)
def test_a_mapping_with_a_str_subclass_value_and_no_token_prints_as_it_did(
    fmt: str, arg: Mapping[str, object], expected: str
) -> None:
    assert _logged(fmt, arg) == expected + "\n"


@pytest.mark.parametrize(
    "query",
    [
        "next=/rec/%76elvet-quokka-umbra",
        "next=%2Frec%2F%76elvet-quokka-umbra",
        "next=%252Frec%252F%2576elvet-quokka-umbra",
    ],
)
def test_a_token_percent_encoded_inside_a_raw_query_is_redacted(query: str) -> None:
    line = _format(
        '%s - "%s %s HTTP/%s" %d', "1.2.3.4:5", "GET", f"/api/health?{query}", "1.1", 200
    )

    assert "quokka" not in line
    assert "umbra" not in line
    assert "/api/health" in line


def test_a_query_without_a_token_is_kept_even_when_it_is_percent_encoded() -> None:
    assert _format("%s", "/api/health?next=%2Fhome") == "/api/health?next=%2Fhome"


@pytest.mark.parametrize(
    "query",
    [
        "next=%2Fr%2Fvelvet-quokka-umbra%252Dvenomous-cheetah",
        "next=%252Fr%252Fvelvet-quokka-umbra%2Dvenomous-cheetah",
        "next=%2Fr%2Frational-%76enomous-cheetah",
        "next=/rec/velvet-quokka%2Dumbra",
    ],
)
def test_a_token_with_an_encoded_character_after_plain_ones_leaves_no_tail(query: str) -> None:
    line = _format(
        '%s - "%s %s HTTP/%s" %d', "1.2.3.4:5", "GET", f"/auth/login/github?{query}", "1.1", 200
    )

    for word in ("velvet", "quokka", "umbra", "venomous", "cheetah", "rational"):
        assert word not in line
