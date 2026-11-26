"""The access-log redaction rules in both relay Caddyfiles hide every share token.

Prod keeps the rules in the `(token_logs)` snippet and local has them inline;
both must carry the same three `regexp` field lines. The emulator tests apply
the real patterns with Go replacement semantics (see `tests/relay_caddy_logs.py`).
The real-Caddy test runs each file's own log block and reads what Caddy writes;
it skips without a `caddy` binary on PATH.
"""

import http.client
import json
import os
import re
import shutil
import socket
import subprocess
from pathlib import Path

import pytest
from tests.polling import wait_for
from tests.relay_caddy_logs import (
    CADDYFILES,
    FIELDS,
    ROOT,
    apply,
    expand,
    log_block,
    read,
    rules,
)

TOK = "SECRETTOKEN123"
NOTICE = "/api/relay/notice/continue"
CADDY = shutil.which("caddy")

caddyfile = pytest.mark.parametrize("rel", CADDYFILES)

# (raw value, logged value). The same tables run against both files.
URI_CASES = [
    (f"/r/{TOK}", "/r/-REDACTED"),
    (f"/rec/{TOK}/page?x=1", "/rec/-REDACTED/page"),
    (f"/mcp/{TOK}/", "/mcp/-REDACTED/"),
    (f"/api/review/{TOK}/daw/ws?t={TOK}", "/api/review/-REDACTED/daw/ws"),
    (f"/api/rec/{TOK}", "/api/rec/-REDACTED"),
    (f"/api/mcp/{TOK}/a", "/api/mcp/-REDACTED/a"),
    (f"/api/reports/{TOK}", "/api/reports/-REDACTED"),
    (f"/api/reports/bundles/{TOK}/x", "/api/reports/bundles/-REDACTED/x"),
    (f"/r?t={TOK}", "/r?-REDACTED"),
    (f"/api/reports?next=/r/{TOK}", "/api/reports?-REDACTED"),
    (f"{NOTICE}?next=%2Fr%2F{TOK}", f"{NOTICE}?-REDACTED"),
    (f"{NOTICE}/?a=1&next=/r/{TOK}", f"{NOTICE}/?-REDACTED"),
    (f"https://h.example:8080/r/{TOK}?t={TOK}", "https://h.example:8080/r/-REDACTED"),
    # Auth routes carry login and share tokens in the query; the path stays.
    (f"/auth/login/google?next=%2Fr%2F{TOK}", "/auth/login/google?-REDACTED"),
    (
        f"/auth/magic-link/consume?token={TOK}&next=%2Fr%2F{TOK}",
        "/auth/magic-link/consume?-REDACTED",
    ),
    (f"/auth?token={TOK}", "/auth?-REDACTED"),
    # A share path inside any other query is dropped with the query.
    (f"/healthz?next=/r/{TOK}", "/healthz?-REDACTED"),
    (f"/llms.txt?next=%2Frec%2F{TOK}", "/llms.txt?-REDACTED"),
    # A percent escape in the path can hide a prefix from a literal match, so the
    # whole path and query go (Caddy still routes these to the relay).
    (f"/r%2F{TOK}", "/-REDACTED"),
    (f"/%72/{TOK}", "/-REDACTED"),
    (f"/%72ec/{TOK}", "/-REDACTED"),
    (f"/r%2F{TOK}%2Fpage?x=1", "/-REDACTED"),
    (f"/api%2Freview%2F{TOK}", "/-REDACTED"),
    (f"/r/%54{TOK}", "/r/-REDACTED"),
    (f"https://h.example/r%2F{TOK}", "https://h.example/-REDACTED"),
]
HEADER_CASES = [
    (f"/r/{TOK}", "/r/-REDACTED"),
    (f"https://sharecut.studio/r/{TOK}/page?x=1", "https://sharecut.studio/r/-REDACTED/page"),
    (f"/rec/{TOK}#{TOK}", "/rec/-REDACTED"),
    (f"/api/mcp/{TOK}?t={TOK}", "/api/mcp/-REDACTED"),
    (f"http://h.example:8080{NOTICE}/?next=/r/{TOK}", f"http://h.example:8080{NOTICE}/?-REDACTED"),
    (
        f"https://sharecut.studio/auth/login/google?next=%2Fr%2F{TOK}",
        "https://sharecut.studio/auth/login/google?-REDACTED",
    ),
    (f"https://sharecut.studio/?next=/r/{TOK}", "https://sharecut.studio/?-REDACTED"),
    (f"https://sharecut.studio/r%2F{TOK}", "https://sharecut.studio/-REDACTED"),
    (f"/%72/{TOK}", "/-REDACTED"),
]
UNCHANGED = [
    "/healthz",
    "/llms.txt",
    "/tunnel",
    "/api/relay/enroll",
    "/api/relay/enroll/renew",
    NOTICE,
    "/download/x",
    "/api?x=1",
    "/robots.txt?x=1",
    "/auth/login/google",
    "https://sharecut.studio/",
]


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
@pytest.mark.parametrize(("raw", "logged"), URI_CASES)
def test_uri_redaction(rel: str, raw: str, logged: str) -> None:
    assert apply(rules(read(rel)), "request>uri", raw) == logged
    assert TOK not in logged


@caddyfile
@pytest.mark.parametrize("field", ["request>headers>Referer", "resp_headers>Location"])
@pytest.mark.parametrize(("raw", "logged"), HEADER_CASES)
def test_header_redaction(rel: str, field: str, raw: str, logged: str) -> None:
    assert apply(rules(read(rel)), field, raw) == logged
    assert TOK not in logged


@caddyfile
@pytest.mark.parametrize("field", FIELDS)
@pytest.mark.parametrize("value", UNCHANGED)
def test_other_values_unchanged(rel: str, field: str, value: str) -> None:
    assert apply(rules(read(rel)), field, value) == value


def _token_route_prefixes() -> set[str]:
    """Every `<prefix>/{token}` or `<prefix>/{report_id}` route the relay serves."""
    found: set[str] = set()
    for source in (ROOT / "src/podcast_relay").rglob("*.py"):
        text = source.read_text(encoding="utf-8")
        found.update(re.findall(r"[\"'](/[A-Za-z0-9_/.-]*/)\{(?:token|report_id)\}", text))
    return found


@caddyfile
def test_every_token_route_prefix_the_relay_serves_is_redacted(rel: str) -> None:
    prefixes = _token_route_prefixes()
    # The relay really serves token routes; an empty scan would make this vacuous.
    assert {"/r/", "/rec/", "/mcp/", "/api/review/", "/api/rec/", "/api/reports/"} <= prefixes
    rule_set = rules(read(rel))
    for prefix in sorted(prefixes):
        for tail in ("", "/page?x=1"):
            logged = apply(rule_set, "request>uri", f"{prefix}{TOK}{tail}")
            assert TOK not in logged, (prefix, tail, logged)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _can_connect(port: int) -> bool:
    try:
        socket.create_connection(("127.0.0.1", port), 0.2).close()
    except OSError:
        return False
    return True


def _access_entries(path: Path) -> list[dict]:
    """Parse Caddy's console-format access lines (`...<TAB>handled request<TAB>{json}`)."""
    return [
        json.loads(line[line.index("\t{") + 1 :])
        for line in path.read_text(encoding="utf-8").splitlines()
        if "http.log.access" in line
    ]


def _get(port: int, target: str, headers: dict[str, str]) -> tuple[int, str]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", target, headers=headers)
        response = conn.getresponse()
        return response.status, response.read().decode()
    finally:
        conn.close()


REAL_REQUESTS = [
    (f"/r/{TOK}?t={TOK}", {}),
    ("/healthz", {"Referer": f"https://sharecut.studio/r/{TOK}/p?next=/r/{TOK}"}),
    (f"/api/review/{TOK}/a?t={TOK}", {}),
    (f"/auth/login/google?next=%2Fr%2F{TOK}", {}),
    (f"/auth/magic-link/consume?token={TOK}&next=%2Fr%2F{TOK}", {}),
    (f"/r%2F{TOK}%2Fpage", {}),
    (f"/%72/{TOK}", {}),
    (f"/%72ec/{TOK}", {}),
]


@pytest.mark.skipif(CADDY is None, reason="no caddy binary on PATH")
@caddyfile
def test_real_caddy_redacts_log(rel: str, tmp_path: Path) -> None:
    """Serve the file's own log block and route matcher from a throwaway site, then read the log."""
    assert CADDY is not None
    matcher = next(line for line in read(rel).splitlines() if "@relay path" in line)
    port = _free_port()
    config = tmp_path / "Caddyfile"
    config.write_text(
        "{\n\tadmin off\n\tauto_https off\n}\n"
        f":{port} {{\n"
        f'\theader Location "/r/{TOK}/x?t={TOK}"\n'
        f"{matcher}\n"
        '\thandle @relay {\n\t\trespond "relay" 200\n\t}\n'
        '\trespond "other" 404\n' + log_block(read(rel)) + "}\n",
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
            assert wait_for(lambda: _can_connect(port)), "caddy did not start"
            bodies = [_get(port, target, headers) for target, headers in REAL_REQUESTS]
            assert wait_for(lambda: len(_access_entries(out_path)) >= len(REAL_REQUESTS))
        finally:
            proc.terminate()
            try:
                proc.wait(10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(10)
    # Every request, encoded forms and auth routes included, reached the relay matcher.
    assert bodies == [(200, "relay")] * len(REAL_REQUESTS)
    assert TOK not in out_path.read_text(encoding="utf-8")
    entries = _access_entries(out_path)
    by_uri = {entry["request"]["uri"]: entry for entry in entries}
    assert set(by_uri) == {
        "/r/-REDACTED",
        "/healthz",
        "/api/review/-REDACTED/a",
        "/auth/login/google?-REDACTED",
        "/auth/magic-link/consume?-REDACTED",
        "/-REDACTED",
    }
    # Caddy rewrites the header arrays too, not only the string field.
    assert by_uri["/healthz"]["request"]["headers"]["Referer"] == [
        "https://sharecut.studio/r/-REDACTED/p"
    ]
    assert all(entry["resp_headers"]["Location"] == ["/r/-REDACTED/x"] for entry in entries)
