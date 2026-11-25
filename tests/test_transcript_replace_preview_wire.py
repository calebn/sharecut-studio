"""Pin the exact wire output of ``preview_transcript_replacement`` (#1811).

Behavior-preserving refactor guard: every expected value below is a literal captured from
develop before any code change. Key sets and ORDER matter, so comparisons go through the
serialized text, not just dict equality.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from typer.testing import CliRunner

from guest_helpers import call_tool
from podcast_mcp.cli.main import app
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools.transcript import find_replace_transcript_tool
from podcast_mcp.models import Transcript
from podcast_mcp.services.collaboration import guest_transcript_ops
from podcast_mcp.services.collaboration.guest_routes import GUEST_OWNER_ROUTES
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import (
    TranscriptReplacementMatch,
    TranscriptReplacementPreview,
    TranscriptService,
)
from podcast_mcp.util.coded_error import CodedValueError
from test_transcript_replace import _word, _workspace

pytestmark = pytest.mark.unscoped_ok

TOP_KEYS = ["matches", "count", "skipped_words", "preview_token"]
ROW_KEYS = [
    "track_id",
    "source_id",
    "start_word_index",
    "end_word_index",
    "before",
    "after",
    "start",
    "end",
    "retimes_words",
]
ROW_TYPES = {
    "track_id": str,
    "source_id": (str, type(None)),
    "start_word_index": int,
    "end_word_index": int,
    "before": str,
    "after": str,
    "start": float,
    "end": float,
    "retimes_words": bool,
}

_HOST = '"track_id":"host","source_id":null,'


def _row(source, first, last, before, after, start, end, retimes):
    src = "null" if source is None else f'"{source}"'
    return (
        f'{{"track_id":"host","source_id":{src},"start_word_index":{first},'
        f'"end_word_index":{last},"before":"{before}","after":"{after}",'
        f'"start":{start},"end":{end},"retimes_words":{retimes}}}'
    )


def _body(rows, count, skipped, token):
    return (
        f'{{"matches":[{",".join(rows)}],"count":{count},"skipped_words":{skipped},'
        f'"preview_token":"{token}"}}'
    )


_Q = "\u2018"
_QE = "\u2019"
# Compact wire text (FastAPI JSON body: no spaces, non-ASCII kept raw).
MAIN_TOKEN = "e8408c6f566c6a5bf75325f2b14512ac3346b026fc9b6a3104149830958473ed"
MAIN = _body(
    [
        _row(None, 0, 0, "Ada,", "Mira,", "0.0", "0.5", "false"),
        _row(None, 1, 1, "ADA", "Mira", "1.0", "1.5", "false"),
        _row("take2", 0, 0, f"{_Q}Ada{_QE}", f"{_Q}Mira{_QE}", "10.0", "10.5", "false"),
    ],
    3,
    0,
    MAIN_TOKEN,
)
MAIN_LOWER = MAIN.replace(
    MAIN_TOKEN,
    "1c963726a3de0192142ecea68405fe9008b6f353240b9e5c6fdb3fd1bc2c646b",
)
CASE = _body(
    [
        _row(None, 0, 0, "Ada,", "Mira,", "0.0", "0.5", "false"),
        _row("take2", 0, 0, f"{_Q}Ada{_QE}", f"{_Q}Mira{_QE}", "10.0", "10.5", "false"),
    ],
    2,
    0,
    "b500439c329678573569f0cd02728871b97f567353cddad3476e1f6235856f03",
)
RETIME = _body(
    [
        _row(None, 0, 0, "Ada,", "Mira Chen,", "0.0", "0.5", "true"),
        _row(None, 1, 1, "ADA", "Mira Chen", "1.0", "1.5", "true"),
        _row("take2", 0, 0, f"{_Q}Ada{_QE}", f"{_Q}Mira Chen{_QE}", "10.0", "10.5", "true"),
    ],
    3,
    0,
    "7742d246c4bbee0fb87a61c65f6b2664bc733c15ceb1b46291d891b1ec4be47e",
)
ZERO = _body([], 0, 0, "a0eedcd53fde23556bcdc68a3b7a7026727adb45ad64d2965ed00b2a84ba4846")
PHRASE_SKIP = _body(
    [_row(None, 4, 5, "Ada Lovelace", "Mira Chen", "4.0", "5.5", "false")],
    1,
    3,
    "453b5cebdbf0cd0afe53674ae6b6c6aaa6047c800e6a081488736e12499dd7e4",
)
ZERO_SKIP = _body([], 0, 3, "a0eedcd53fde23556bcdc68a3b7a7026727adb45ad64d2965ed00b2a84ba4846")


def _compact(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def _pretty(text: str) -> str:
    return json.dumps(json.loads(text), indent=2)


def _suppress_scenario(ws) -> None:
    ws.project.transcripts[0].words = [
        _word("Ada", 0, suppressed=True),
        _word("Ada", 1, ignored=True),
        _word("Ada", 2),
        _word("Lovelace", 3, suppressed=True),
        _word("Ada", 4),
        _word("Lovelace", 5),
    ]
    ws.save()


CASES = [
    pytest.param(None, "Ada", "Mira", False, MAIN, id="single-word-multi-transcript"),
    pytest.param(None, "ada", "Mira", False, MAIN_LOWER, id="casefold-search"),
    pytest.param(None, "Ada", "Mira", True, CASE, id="match-case"),
    pytest.param(None, "Ada", "Mira Chen", False, RETIME, id="one-to-two-retimes"),
    pytest.param(None, "Nobody", "Mira", False, ZERO, id="zero-matches"),
    pytest.param(
        _suppress_scenario, "Ada Lovelace", "Mira Chen", False, PHRASE_SKIP, id="phrase-skips"
    ),
    pytest.param(_suppress_scenario, "Nobody", "Mira", False, ZERO_SKIP, id="zero-with-skips"),
]


@pytest.mark.parametrize("setup,search,replacement,match_case,expected", CASES)
def test_service_returns_exact_ordered_payload(
    minimal_project, setup, search, replacement, match_case, expected
):
    ws = _workspace(minimal_project)
    if setup:
        setup(ws)
    model = TranscriptService(ws).preview_transcript_replacement(
        search, replacement, match_case=match_case
    )
    assert type(model) is TranscriptReplacementPreview
    out = model.model_dump()
    assert type(out) is dict
    assert list(out) == TOP_KEYS
    assert _compact(out) == expected
    assert type(out["count"]) is int
    assert type(out["skipped_words"]) is int
    assert type(out["preview_token"]) is str
    assert isinstance(out["matches"], list)
    for row in out["matches"]:
        assert list(row) == ROW_KEYS
        for key, kind in ROW_TYPES.items():
            assert isinstance(row[key], kind)


def test_preview_is_read_only_and_deterministic(minimal_project):
    ws = _workspace(minimal_project)
    before = ws.project.model_dump(mode="json")
    svc = TranscriptService(ws)
    first = svc.preview_transcript_replacement("Ada", "Mira")
    assert svc.preview_transcript_replacement("Ada", "Mira") == first
    assert ws.project.model_dump(mode="json") == before


def test_token_depends_on_search_replacement_and_case(minimal_project):
    svc = TranscriptService(_workspace(minimal_project))
    tokens = {
        svc.preview_transcript_replacement("Ada", "Mira").preview_token,
        svc.preview_transcript_replacement("Ada", "Mira", match_case=True).preview_token,
        svc.preview_transcript_replacement("Ada", "Mira Chen").preview_token,
    }
    assert len(tokens) == 3
    assert all(len(t) == 64 and set(t) <= set("0123456789abcdef") for t in tokens)


def test_models_are_frozen_forbid_extra_and_keep_wire_field_order(minimal_project):
    model = TranscriptService(_workspace(minimal_project)).preview_transcript_replacement(
        "Ada", "Mira"
    )
    with pytest.raises(ValidationError):
        model.count = 0
    with pytest.raises(ValidationError):
        model.matches[0].after = "x"
    with pytest.raises(ValidationError):
        TranscriptReplacementPreview(**model.model_dump(), extra=1)
    with pytest.raises(ValidationError):
        TranscriptReplacementMatch(**model.matches[0].model_dump(), extra=1)
    assert list(TranscriptReplacementPreview.model_fields) == TOP_KEYS
    assert list(TranscriptReplacementMatch.model_fields) == ROW_KEYS


ERROR_CASES = [
    pytest.param("", "Mira", "empty_text", "Enter a word or phrase to find.", id="empty-search"),
    pytest.param("...", "Mira", "empty_text", "Enter a word or phrase to find.", id="punct-search"),
    pytest.param(
        "Ada",
        "",
        "replacement_token_invalid",
        "Each replacement token must contain a letter or number.",
        id="empty-replacement",
    ),
    pytest.param(
        "Ada",
        "...",
        "replacement_token_invalid",
        "Each replacement token must contain a letter or number.",
        id="punct-replacement",
    ),
]
AMBIGUOUS = "Transcript source identities are ambiguous; regenerate the transcript."


def _ambiguous(ws) -> None:
    ws.project.transcripts = [
        Transcript(track_id="host", words=[_word("Ada", 0)]),
        Transcript(track_id="host", words=[_word("Ada", 1)]),
    ]
    ws.save()


@pytest.mark.parametrize("search,replacement,code,message", ERROR_CASES)
def test_service_errors_are_coded_value_errors(minimal_project, search, replacement, code, message):
    svc = TranscriptService(_workspace(minimal_project))
    with pytest.raises(CodedValueError) as raised:
        svc.preview_transcript_replacement(search, replacement)
    assert (raised.value.code, str(raised.value)) == (code, message)
    assert isinstance(raised.value, ValueError)


def test_service_ambiguous_sources_error(minimal_project):
    ws = _workspace(minimal_project)
    _ambiguous(ws)
    with pytest.raises(CodedValueError) as raised:
        TranscriptService(ws).preview_transcript_replacement("Ada", "Mira")
    assert (raised.value.code, str(raised.value)) == ("transcript_source_ambiguous", AMBIGUOUS)


# --- GUI host route -------------------------------------------------------------------------

ROUTE = "/api/transcript/replacement-preview"


def _post(ws, **body):
    client = TestClient(create_app(served_project=ws.path))
    return client.post(ROUTE, json={"path": str(ws.path), **body})


@pytest.mark.parametrize("setup,search,replacement,match_case,expected", CASES)
def test_gui_route_body_is_byte_equal(
    minimal_project, setup, search, replacement, match_case, expected
):
    ws = _workspace(minimal_project)
    if setup:
        setup(ws)
    res = _post(ws, search=search, replacement=replacement, match_case=match_case)
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/json"
    assert res.content == expected.encode()


def test_gui_route_match_case_defaults_false(minimal_project):
    res = _post(_workspace(minimal_project), search="Ada", replacement="Mira")
    assert res.content == MAIN.encode()


@pytest.mark.parametrize(
    "search,replacement,code,message",
    [c.values[:4] for c in ERROR_CASES if c.id in {"punct-replacement"}],
)
def test_gui_route_coded_errors(minimal_project, search, replacement, code, message):
    res = _post(_workspace(minimal_project), search=search, replacement=replacement)
    assert res.status_code == 400
    assert res.headers["x-sharecut-error-code"] == code
    assert res.content == _compact({"detail": message}).encode()


def test_gui_route_empty_replacement_is_422_invalid_request(minimal_project):
    res = _post(_workspace(minimal_project), search="Ada", replacement="")
    assert res.status_code == 422
    assert res.headers["x-sharecut-error-code"] == "invalid_request"


def test_gui_route_empty_search_is_422_invalid_request(minimal_project):
    res = _post(_workspace(minimal_project), search="", replacement="Mira")
    assert res.status_code == 422
    assert res.headers["x-sharecut-error-code"] == "invalid_request"
    assert res.content == (
        b'{"message":"Invalid value for \'search\'.","detail":[{"loc":["body","search"],'
        b'"msg":"Invalid value for \'search\'.","type":"invalid_request"}]}'
    )


def test_gui_route_ambiguous_sources_is_400(minimal_project):
    ws = _workspace(minimal_project)
    _ambiguous(ws)
    res = _post(ws, search="Ada", replacement="Mira")
    assert res.status_code == 400
    assert res.headers["x-sharecut-error-code"] == "transcript_source_ambiguous"
    assert res.content == _compact({"detail": AMBIGUOUS}).encode()


# --- CLI ------------------------------------------------------------------------------------


def _cli(ws, search, replacement, *extra):
    return CliRunner().invoke(
        app,
        [
            "transcript",
            "find-replace",
            "--project",
            str(ws.path),
            "--search",
            search,
            "--replace",
            replacement,
            "--dry-run",
            *extra,
        ],
    )


@pytest.mark.parametrize("setup,search,replacement,match_case,expected", CASES)
def test_cli_dry_run_text_is_indent2_json(
    minimal_project, setup, search, replacement, match_case, expected
):
    ws = _workspace(minimal_project)
    if setup:
        setup(ws)
    res = _cli(ws, search, replacement, *(["--match-case"] if match_case else []))
    assert res.exit_code == 0, res.output
    assert res.output == _pretty(expected) + "\n"


def test_cli_dry_run_main_text_starts_with_pinned_shape(minimal_project):
    res = _cli(_workspace(minimal_project), "Ada", "Mira")
    assert res.output.startswith(
        '{\n  "matches": [\n    {\n      "track_id": "host",\n      "source_id": null,\n'
        '      "start_word_index": 0,\n'
    )
    assert '"before": "\\u2018Ada\\u2019"' in res.output
    token = MAIN_TOKEN
    assert res.output.endswith(
        f'  ],\n  "count": 3,\n  "skipped_words": 0,\n  "preview_token": "{token}"\n}}\n'
    )


@pytest.mark.parametrize(
    "search,replacement,code,message",
    [c.values[:4] for c in ERROR_CASES],
)
def test_cli_errors_exit_1_with_code(minimal_project, search, replacement, code, message):
    res = _cli(_workspace(minimal_project), search, replacement)
    assert res.exit_code == 1
    assert res.output == (
        f"Error: {message} (code {code}) (set PODCAST_DEBUG=1 for the traceback)\n"
    )


def test_cli_ambiguous_sources_error(minimal_project):
    ws = _workspace(minimal_project)
    _ambiguous(ws)
    res = _cli(ws, "Ada", "Mira")
    assert res.exit_code == 1
    assert res.output == (
        f"Error: {AMBIGUOUS} (code transcript_source_ambiguous) "
        "(set PODCAST_DEBUG=1 for the traceback)\n"
    )


# --- MCP tool -------------------------------------------------------------------------------


@pytest.mark.parametrize("setup,search,replacement,match_case,expected", CASES)
def test_mcp_tool_dry_run_text_is_indent2_json(
    minimal_project, setup, search, replacement, match_case, expected
):
    ws = _workspace(minimal_project)
    if setup:
        setup(ws)
    out = find_replace_transcript_tool(
        str(ws.path), search, replacement, match_case=match_case, dry_run=True
    )
    assert isinstance(out, str)
    assert out == _pretty(expected)


@pytest.mark.parametrize("search,replacement,code,message", [c.values[:4] for c in ERROR_CASES])
def test_mcp_tool_errors_raise_coded_value_error(
    minimal_project, search, replacement, code, message
):
    ws = _workspace(minimal_project)
    with pytest.raises(CodedValueError) as raised:
        find_replace_transcript_tool(str(ws.path), search, replacement, dry_run=True)
    assert (raised.value.code, str(raised.value)) == (code, message)


def test_mcp_tool_ambiguous_sources_error(minimal_project):
    ws = _workspace(minimal_project)
    _ambiguous(ws)
    with pytest.raises(CodedValueError) as raised:
        find_replace_transcript_tool(str(ws.path), "Ada", "Mira", dry_run=True)
    assert raised.value.code == "transcript_source_ambiguous"


# --- Guest ops, guest GUI route, guest MCP tool ---------------------------------------------


@pytest.mark.parametrize("setup,search,replacement,match_case,expected", CASES)
def test_guest_ops_returns_the_service_payload_unfiltered(
    minimal_project, setup, search, replacement, match_case, expected
):
    ws = _workspace(minimal_project)
    if setup:
        setup(ws)
    out = guest_transcript_ops.guest_replacement_preview(
        ws, search=search, replacement=replacement, match_case=match_case
    )
    assert list(out) == TOP_KEYS
    assert _compact(out) == expected


@pytest.mark.parametrize("search,replacement,code,message", [c.values[:4] for c in ERROR_CASES])
def test_guest_ops_errors_propagate_coded(minimal_project, search, replacement, code, message):
    ws = _workspace(minimal_project)
    with pytest.raises(CodedValueError) as raised:
        guest_transcript_ops.guest_replacement_preview(
            ws, search=search, replacement=replacement, match_case=False
        )
    assert (raised.value.code, str(raised.value)) == (code, message)


@pytest.fixture
def share(minimal_project, sample_wav):
    ws = _workspace(minimal_project)
    ws.project.artifacts_dir().mkdir(parents=True, exist_ok=True)
    (ws.project.artifacts_dir() / "premix.wav").write_bytes(sample_wav.read_bytes())
    version = ReviewService(ws).publish(label="Transcript")["id"]
    token = ShareService(ws).create(
        review_version_id=version, capabilities=capabilities_for_role("editor", with_mcp=True)
    )["token"]
    client = TestClient(create_app())
    return SimpleNamespace(ws=ws, token=token, client=client)


def _guest_post(share, body):
    row = GUEST_OWNER_ROUTES["transcript_replacement_preview"]
    return share.client.post(row.path.format(token=share.token), json=body)


def test_guest_route_path_is_pinned():
    row = GUEST_OWNER_ROUTES["transcript_replacement_preview"]
    assert (row.method, row.path) == (
        "POST",
        "/api/review/{token}/daw/transcript/replacement-preview",
    )


@pytest.mark.parametrize(
    "search,replacement,match_case,expected",
    [
        ("Ada", "Mira", False, MAIN),
        ("Ada", "Mira", True, CASE),
        ("Ada", "Mira Chen", False, RETIME),
        ("Nobody", "Mira", False, ZERO),
    ],
)
def test_guest_route_body_is_byte_equal(share, search, replacement, match_case, expected):
    res = _guest_post(
        share, {"search": search, "replacement": replacement, "match_case": match_case}
    )
    assert res.status_code == 200
    assert res.content == expected.encode()


def test_guest_route_and_host_route_bodies_match(share):
    body = {"search": "Ada", "replacement": "Mira"}
    host = _post(share.ws, **body)
    assert _guest_post(share, body).content == host.content == MAIN.encode()


def test_guest_route_coded_error(share):
    res = _guest_post(share, {"search": "Ada", "replacement": "..."})
    assert res.status_code == 400
    assert res.headers["x-sharecut-error-code"] == "replacement_token_invalid"
    assert (
        res.content
        == _compact({"detail": "Each replacement word needs a letter or number."}).encode()
    )


def _tool(share, arguments):
    return call_tool(
        SimpleNamespace(tokens={"editor": share.token}),
        "guest_transcript_replacement_preview",
        arguments,
    )


@pytest.mark.parametrize(
    "arguments,expected",
    [
        ({"search": "Ada", "replacement": "Mira"}, MAIN),
        ({"search": "Ada", "replacement": "Mira", "match_case": True}, CASE),
        ({"search": "Nobody", "replacement": "Mira"}, ZERO),
    ],
)
def test_guest_mcp_tool_result_is_pinned(share, arguments, expected):
    res = _tool(share, arguments)
    assert list(res) == ["jsonrpc", "id", "result"]
    result = res["result"]
    assert list(result) == ["content", "structuredContent", "isError"]
    assert result["isError"] is False
    assert _compact(result["structuredContent"]) == expected
    assert result["content"] == [{"type": "text", "text": _pretty(expected)}]


def test_guest_mcp_tool_coded_error(share):
    res = _tool(share, {"search": "Ada", "replacement": "..."})
    result = res["result"]
    assert result["isError"] is True
    assert result["structuredContent"] == {
        "ok": False,
        "error": "Each replacement word needs a letter or number.",
        "error_code": "replacement_token_invalid",
    }
    assert list(result["structuredContent"]) == ["ok", "error", "error_code"]
    assert result["content"] == [
        {"type": "text", "text": "Each replacement word needs a letter or number."}
    ]
