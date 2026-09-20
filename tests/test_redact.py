from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.util.redact import sanitize


@pytest.mark.parametrize(
    ("raw", "home", "workspace", "expected"),
    [
        (
            "/Users/host/episode/raw/host.wav",
            Path("/Users/host"),
            Path("/Users/host/episode"),
            "<workspace>/raw/host.wav",
        ),
        (
            "cache is /Users/host/.cache/podcast_mcp",
            Path("/Users/host"),
            None,
            "cache is ~/.cache/podcast_mcp",
        ),
        (
            "https://share.example/r/fantastic-acoustic-whale/daw",
            Path("/Users/host"),
            None,
            "https://share.example/r/<share-token>/daw",
        ),
        (
            "https://share.example/r/spiffy-urchin-of-forgiveness/daw",
            Path("/Users/host"),
            None,
            "https://share.example/r/<share-token>/daw",
        ),
        (
            "https://share.example/r/abcdefghijklmnopqrstuvwxyz012345-_x",
            Path("/Users/host"),
            None,
            "https://share.example/r/<share-token>",
        ),
        (
            "https://share.example/rec/abcdefghijklmnopqrstuvwxyz012345-_x",
            Path("/Users/host"),
            None,
            "https://share.example/rec/<share-token>",
        ),
        (
            '127.0.0.1:8765 - "GET /api/review/fantastic-acoustic-whale/comments HTTP/1.1" 200',
            Path("/Users/host"),
            None,
            '127.0.0.1:8765 - "GET /api/review/<share-token>/comments HTTP/1.1" 200',
        ),
        (
            '127.0.0.1:8765 - "POST /mcp/spiffy-urchin-of-forgiveness/mcp HTTP/1.1" 200',
            Path("/Users/host"),
            None,
            '127.0.0.1:8765 - "POST /mcp/<share-token>/mcp HTTP/1.1" 200',
        ),
        (
            "token=fantastic-acoustic-whale",
            Path("/Users/host"),
            None,
            "token=<redacted>",
        ),
        (
            "well-known-issue in the mix",
            Path("/Users/host"),
            None,
            "well-known-issue in the mix",
        ),
        (
            "X-Sharecut-Boot-Token: synthetic-test-value",
            Path("/Users/host"),
            None,
            "X-Sharecut-Boot-Token: <redacted>",
        ),
        (
            "Authorization: Bearer secret-value",
            Path("/Users/host"),
            None,
            "Authorization: <redacted>",
        ),
        (
            "Cookie: session=abc; other=1",
            Path("/Users/host"),
            None,
            "Cookie: <redacted>",
        ),
        (
            "contact prod@example.com please",
            Path("/Users/host"),
            None,
            "contact <email> please",
        ),
        (
            "peer 10.0.0.8 vs loopback 127.0.0.1",
            Path("/Users/host"),
            None,
            "peer <ip> vs loopback 127.0.0.1",
        ),
        (
            "listen on 2001:db8:0:0:0:0:0:1 keep ::1",
            Path("/Users/host"),
            None,
            "listen on <ip> keep ::1",
        ),
        (
            "secret=hunter2 password=x api_key=abcd api-key=efgh",
            Path("/Users/host"),
            None,
            "secret=<redacted> password=<redacted> api_key=<redacted> api-key=<redacted>",
        ),
        (
            "hex " + ("a" * 32) + " end",
            Path("/Users/host"),
            None,
            "hex <hex> end",
        ),
        (
            "b64 " + ("A" * 32) + "== end",
            Path("/Users/host"),
            None,
            "b64 <b64> end",
        ),
    ],
)
def test_sanitize_table(
    raw: str,
    home: Path,
    workspace: Path | None,
    expected: str,
) -> None:
    assert sanitize(raw, home=home, workspace=workspace) == expected


def test_sanitize_empty() -> None:
    assert sanitize("") == ""


def test_sanitize_loopback_v6_uncompressed() -> None:
    assert (
        sanitize("loop 0:0:0:0:0:0:0:1 keep 2001:db8:0:0:0:0:0:2", home=Path("/Users/host"))
        == "loop 0:0:0:0:0:0:0:1 keep <ip>"
    )


def test_sanitize_extra_paths_before_home() -> None:
    cache = Path("/opt/podcast-cache")
    assert (
        sanitize(
            f"whisper {cache / 'whisper'} and home /Users/host/secret",
            home=Path("/Users/host"),
            extra=[(cache, "<cache>")],
        )
        == "whisper <cache>/whisper and home ~/secret"
    )


def test_sanitize_bare_coolname_survives() -> None:
    assert (
        sanitize("mention fantastic-acoustic-whale in notes", home=Path("/Users/host"))
        == "mention fantastic-acoustic-whale in notes"
    )


def test_sanitize_resolve_oserror(monkeypatch: pytest.MonkeyPatch) -> None:
    home = Path("/Users/host")

    def boom(self: Path) -> Path:
        raise OSError("x")

    monkeypatch.setattr(Path, "resolve", boom)
    assert sanitize("/Users/host/cache", home=home) == "~/cache"
