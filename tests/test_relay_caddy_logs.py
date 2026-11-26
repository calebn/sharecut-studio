"""The access-log redaction rules in both relay Caddyfiles hide every share token.

Prod keeps the rules in the `(token_logs)` snippet and local has them inline;
both must carry the same three `regexp` field lines. The first tests apply the
real patterns with Go replacement semantics (see `tests/relay_caddy_logs.py`).
The last one runs a real Caddy and reads its log; it skips without a binary.
"""

import http.client
import os
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path

import pytest
from tests.relay_caddy_logs import CADDYFILES, FIELDS, apply, expand, log_block, read, rules

TOK = "SECRETTOKEN123"
NOTICE = "/api/relay/notice/continue"
PATH_PREFIXES = [
    "/r/",
    "/rec/",
    "/mcp/",
    "/api/review/",
    "/api/rec/",
    "/api/mcp/",
    "/api/reports/",
    "/api/reports/bundles/",
]
BARE = ["/r", "/rec", "/mcp", "/api/review", "/api/rec", "/api/mcp", "/api/reports"]
HEADER_FIELDS = ["request>headers>Referer", "resp_headers>Location"]
QUERIES = ["?next=%2Fr%2F" + TOK, "?next=/r/" + TOK + "/p", "?a=1&next=/r/" + TOK]

caddyfile = pytest.mark.parametrize("rel", CADDYFILES)


def _line_set(rel: str) -> list[str]:
    return [line.strip() for line in log_block(read(rel)).splitlines() if " regexp " in line]


def test_both_caddyfiles_carry_identical_regexp_lines() -> None:
    prod, local = (_line_set(rel) for rel in CADDYFILES)
    assert len(prod) == 3
    assert prod == local


@caddyfile
def test_three_fields_present(rel: str) -> None:
    assert set(rules(read(rel))) == set(FIELDS)


@caddyfile
def test_no_old_replacement_bug(rel: str) -> None:
    # Go reads `$1REDACTED` as the group named "1REDACTED", which is empty.
    for _, repl in rules(read(rel)).values():
        assert not re.search(r"\$\d+[A-Za-z0-9_]", repl), repl


def test_expand_emulator() -> None:
    m = re.match(r"(a)(b)?", "a")
    assert m is not None
    assert expand("$1$2-X", m) == "a-X"
    assert expand("$1X", m) == ""
    assert expand("${1}X$$", m) == "aX$"


@caddyfile
@pytest.mark.parametrize("prefix", PATH_PREFIXES)
@pytest.mark.parametrize("tail", ["", "/", "/page?x=1", "/a"])
def test_uri_paths(rel: str, prefix: str, tail: str) -> None:
    out = apply(rules(read(rel)), "request>uri", f"{prefix}{TOK}{tail}")
    assert TOK not in out
    assert out.startswith(prefix + "-REDACTED")
    assert out.endswith(tail.split("?")[0])


@caddyfile
@pytest.mark.parametrize("prefix", PATH_PREFIXES)
@pytest.mark.parametrize("q", [f"?t={TOK}", f"?next=/r/{TOK}&a=1"])
def test_uri_query_after_token_dropped(rel: str, prefix: str, q: str) -> None:
    rule_set = rules(read(rel))
    assert apply(rule_set, "request>uri", f"{prefix}{TOK}{q}") == f"{prefix}-REDACTED"
    assert (
        apply(rule_set, "request>uri", f"{prefix}{TOK}/rest/of{q}") == f"{prefix}-REDACTED/rest/of"
    )


@caddyfile
@pytest.mark.parametrize("prefix", PATH_PREFIXES)
def test_uri_query_without_token_segment(rel: str, prefix: str) -> None:
    assert TOK not in apply(rules(read(rel)), "request>uri", f"{prefix}?t={TOK}")


@caddyfile
@pytest.mark.parametrize("bare", BARE)
def test_uri_bare_prefix_query(rel: str, bare: str) -> None:
    assert apply(rules(read(rel)), "request>uri", f"{bare}?t={TOK}") == f"{bare}?-REDACTED"


@caddyfile
@pytest.mark.parametrize("host", ["https://sharecut.studio", "http://h.example:8080"])
def test_uri_absolute_form(rel: str, host: str) -> None:
    rule_set = rules(read(rel))
    assert apply(rule_set, "request>uri", f"{host}/r/{TOK}?t={TOK}") == f"{host}/r/-REDACTED"
    assert apply(rule_set, "request>uri", f"{host}/rec/{TOK}/p") == f"{host}/rec/-REDACTED/p"
    assert (
        apply(rule_set, "request>uri", f"{host}{NOTICE}?next=/r/{TOK}")
        == f"{host}{NOTICE}?-REDACTED"
    )
    assert apply(rule_set, "request>uri", f"{host}/healthz") == f"{host}/healthz"


@caddyfile
@pytest.mark.parametrize("q", QUERIES)
@pytest.mark.parametrize("slash", ["", "/"])
def test_uri_notice_query(rel: str, q: str, slash: str) -> None:
    out = apply(rules(read(rel)), "request>uri", NOTICE + slash + q)
    assert TOK not in out
    assert out == NOTICE + slash + "?-REDACTED"


@caddyfile
@pytest.mark.parametrize(
    "uri",
    [
        "/healthz",
        "/llms.txt",
        "/tunnel",
        "/api/relay/enroll",
        "/api/relay/enroll/renew",
        NOTICE,
        NOTICE + "/",
        "/download/x",
        "/api?x=1",
        "/robots.txt?x=1",
    ],
)
def test_uri_harmless(rel: str, uri: str) -> None:
    assert apply(rules(read(rel)), "request>uri", uri) == uri


@caddyfile
@pytest.mark.parametrize("field", HEADER_FIELDS)
@pytest.mark.parametrize("host", ["", "https://sharecut.studio", "http://h.example:8080"])
@pytest.mark.parametrize("prefix", PATH_PREFIXES)
@pytest.mark.parametrize(
    ("tail", "keep"),
    [("", ""), ("/", "/"), ("/page?x=1", "/page"), (f"?t={TOK}", ""), (f"#{TOK}", "")],
)
def test_header_token_paths(
    rel: str, field: str, host: str, prefix: str, tail: str, keep: str
) -> None:
    out = apply(rules(read(rel)), field, f"{host}{prefix}{TOK}{tail}")
    assert TOK not in out
    assert out == f"{host}{prefix}-REDACTED{keep}"


@caddyfile
@pytest.mark.parametrize("field", HEADER_FIELDS)
@pytest.mark.parametrize("host", ["", "https://sharecut.studio"])
@pytest.mark.parametrize("slash", ["", "/"])
@pytest.mark.parametrize("q", QUERIES)
def test_header_notice_form(rel: str, field: str, host: str, slash: str, q: str) -> None:
    out = apply(rules(read(rel)), field, f"{host}{NOTICE}{slash}{q}")
    assert TOK not in out
    assert out == f"{host}{NOTICE}{slash}?-REDACTED"


@caddyfile
@pytest.mark.parametrize("field", HEADER_FIELDS)
def test_header_harmless(rel: str, field: str) -> None:
    rule_set = rules(read(rel))
    for value in [
        "https://sharecut.studio/",
        "/download/x",
        "https://x.example/healthz",
        NOTICE,
        "https://sharecut.studio" + NOTICE,
    ]:
        assert apply(rule_set, field, value) == value


CADDY = shutil.which("caddy")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.mark.skipif(CADDY is None, reason="no caddy binary on PATH")
@caddyfile
def test_real_caddy_redacts_log(rel: str, tmp_path: Path) -> None:
    """Serve the file's own log block from a throwaway site and read what Caddy logs."""
    assert CADDY is not None
    port = _free_port()
    config = tmp_path / "Caddyfile"
    config.write_text(
        "{\n\tadmin off\n\tauto_https off\n}\n"
        f":{port} {{\n"
        + log_block(read(rel))
        + f'\theader Location "/r/{TOK}/x?t={TOK}"\n\trespond "ok"\n}}\n',
        encoding="utf-8",
    )
    out_path = tmp_path / "err.log"
    with out_path.open("w", encoding="utf-8") as err:
        proc = subprocess.Popen(
            [CADDY, "run", "--config", str(config), "--adapter", "caddyfile"],
            stdout=err,
            stderr=err,
            env={
                **os.environ,
                "XDG_CONFIG_HOME": str(tmp_path / "xdg-config"),
                "XDG_DATA_HOME": str(tmp_path / "xdg-data"),
            },
        )
        try:
            for _ in range(100):
                try:
                    socket.create_connection(("127.0.0.1", port), 0.2).close()
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                pytest.fail("caddy did not start")
            for target, headers in [
                (f"/r/{TOK}?t={TOK}", {}),
                ("/healthz", {"Referer": f"https://sharecut.studio{NOTICE}?next=/r/{TOK}"}),
                (f"/api/review/{TOK}/a?t={TOK}", {}),
            ]:
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                conn.request("GET", target, headers=headers)
                conn.getresponse().read()
                conn.close()
            time.sleep(0.5)
        finally:
            proc.terminate()
            proc.wait(10)
    log = out_path.read_text(encoding="utf-8")
    assert "-REDACTED" in log
    assert TOK not in log
