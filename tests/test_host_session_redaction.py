"""A diagnostics bundle never carries the exchange code or the owner session cookie."""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from podcast_mcp.services.support.diagnostics import DiagnosticsService
from podcast_mcp.services.support.doctor import DoctorReport
from podcast_mcp.util.host_session_wire import SESSION_COOKIE
from podcast_mcp.util.redact import redact_secrets, sanitize

CODE = "Zk3vQ8wRtY1uXc5bN7mP0aLsD2fGhJ4eT6iO9pAqWxE"
SESSION_ID = "Hq2WnB8vKd4sMx7RtY0uXc3bN5mP1aLfD6gJeO9iTpA"


def test_a_log_line_with_the_exchange_url_is_redacted() -> None:
    line = f'127.0.0.1:50000 - "GET /api/session/exchange?code={CODE} HTTP/1.1" 303'

    assert sanitize(line) == (
        '127.0.0.1:50000 - "GET /api/session/exchange?code=<redacted> HTTP/1.1" 303'
    )
    assert redact_secrets(line) == (
        '127.0.0.1:50000 - "GET /api/session/exchange?code=<redacted> HTTP/1.1" 303'
    )


def test_a_cookie_assignment_and_a_cookie_header_are_redacted() -> None:
    assert sanitize(f"set {SESSION_COOKIE}={SESSION_ID}; Path=/") == (
        f"set {SESSION_COOKIE}=<redacted>; Path=/"
    )
    assert sanitize(f"Cookie: {SESSION_COOKIE}={SESSION_ID}") == "Cookie: <redacted>"


def test_the_bundle_holds_neither_the_code_nor_the_session_id(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    diagnostics = "podcast_mcp.services.support.diagnostics"
    monkeypatch.setattr(f"{diagnostics}.run_doctor_checks", lambda _project=None: DoctorReport())
    monkeypatch.setattr(
        f"{diagnostics}.component_status", lambda: {"ready": True, "models": [], "tools": {}}
    )
    monkeypatch.setattr(
        f"{diagnostics}.ffmpeg_probe_info",
        lambda: {"ffmpeg": {"ok": True}, "ffprobe": {"ok": True}},
    )
    home = tmp_path / "home"
    logs = home / "Library" / "Logs" / "ShareCut Studio"
    logs.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home)
    (logs / "sidecar.log").write_text(
        f"GET /api/session/exchange?code={CODE} 303\n{SESSION_COOKIE}={SESSION_ID}\n",
        encoding="utf-8",
    )
    out = tmp_path / "out"

    report = DiagnosticsService().build_bundle(None, out_dir=out, include_logs=True)

    with zipfile.ZipFile(report.path) as bundle:
        text = "".join(bundle.read(name).decode("utf-8", "replace") for name in bundle.namelist())
    assert CODE not in text
    assert SESSION_ID not in text
    assert f"{SESSION_COOKIE}=<redacted>" in text
