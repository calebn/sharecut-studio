from __future__ import annotations

import re
import time
from pathlib import Path

import pytest

from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.redact import (
    _mask_values,
    mentions_host_path,
    redact_secrets,
    redact_share_paths,
    sanitize,
)
from share_path_helpers import SHAPES, SPELLINGS, spell


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


def test_redact_secrets_masks_literals_and_share_paths_but_keeps_hosts():
    from podcast_mcp.util.redact import redact_secrets

    out = redact_secrets(
        "dial relay.example.test 192.168.1.7 with sekrit-value at /r/fantastic-acoustic-whale/x",
        ["sekrit-value", ""],
    )
    assert out == "dial relay.example.test 192.168.1.7 with <redacted> at /r/<share-token>/x"


def test_redact_secrets_masks_the_longer_secret_first():
    from podcast_mcp.util.redact import redact_secrets

    assert redact_secrets("a-b-secret", ["a-b", "a-b-secret"]) == "<redacted>"


HOST_PATH_TEXTS = [
    "raw media not found: /Users/caleb nelson/My Show/x.wav",
    "A wav not found: ~/Podcasts/Secret Show/raw.wav",
    "A wav not found: ~/raw.wav",
    "read ~caleb/Secret/raw.wav failed",
    r"in C:\Users\Name With Space\Secret Show\raw.wav now",
    "C:/Users/host/Podcasts/raw.wav",
    r"D:\Shows\Ep 1\raw.wav",
    "a /srv/shows/Gäste/Ana/raw.wav b",
    "/srv/shows/épisode/raw.wav",
    "/media/shows/日本語 番組/第1回.wav",
    "file:///Users/caleb%20nelson/My%20Show/x.wav",
    "file:///Users/caleb nelson/My Show/x.wav end",
    "file:///C:/Users/Name With Space/x.wav",
    r"\\nas\shows\Secret Show\raw.wav",
    "cannot read '/Users/host/ep one/raw.wav' (permission denied)",
    "path=/Users/host/x.wav; next",
    "(see /tmp/a b/c.wav)",
    "Caleb's: /Users/Caleb's Show/x.wav",
    "/Users/Caleb Nelson",
    "failed at /tmp",
    "/Users/host/Podcasts/Secret Show/Ep 1 raw.wav missing",
    "reading /Users/host/Library/Application Support/Show/x.wav (x)",
    "not found: /Users/host/raw.",
    "line one\n/Users/host/raw.wav\nline three",
    "cannot read /tmp/Talkin' Shop/ep1/raw.wav",
    'bad /Users/host/"Best" Cut/raw.wav',
    "no /Users/host/What? Show/raw.wav",
    r"missing:\Users\host\Secret\raw.wav",
    r"missing:\Users",
    r"missing:\home",
    r"missing-\home\host\Secret\raw.wav",
    r"missing)\users\host\Secret\raw.wav",
    "missing: %2fUsers%2fhost",
    "missing: %2FUsers%2fhost",
    r"missing: ~host\Secret\raw.wav",
    r"missing: Secret\raw.wav",
    r"missing: ..\host\raw.wav",
    r"missing: Podcasts\ep 12\raw.wav",
    "missing: Secret%5craw.wav",
    "missing: C%3A%5CUsers%5Chost",
    "missing: Secret%5Craw.wav",
    r"see a\b",
]
CONSERVATIVE_PATH_TEXTS = [
    "mode must be current/suggested/ab",
    "1/2 of 3/4",
    "see https://example.com/a/b ok",
]
PATH_FREE_TEXTS = [
    "comment c9 not found",
    "Rendering Talkin' Shop",
    "A wav not found: A.wav",
]


@pytest.mark.parametrize("text", HOST_PATH_TEXTS)
def test_mentions_host_path_finds_a_path_whatever_its_folders_hold(text: str) -> None:
    assert mentions_host_path(text)


@pytest.mark.parametrize("text", CONSERVATIVE_PATH_TEXTS)
def test_guest_message_conservatively_withholds_slash_bearing_prose(text: str) -> None:
    assert (
        CodedError(text, code="invalid_state").guest_message()
        == "That didn't work; ask the host to check this episode."
    )


@pytest.mark.parametrize("text", PATH_FREE_TEXTS)
def test_mentions_host_path_leaves_prose_alone(text: str) -> None:
    assert not mentions_host_path(text)


TOKEN = "velvet-quokka-umbra"


@pytest.mark.parametrize(
    "path",
    [
        f"/r/{TOKEN}/daw",
        f"/rec/{TOKEN}",
        f"/api/review/{TOKEN}/daw/ws",
        f"/api/rec/{TOKEN}/ws",
        f"/mcp/{TOKEN}/mcp",
        f"/api/shares/{TOKEN}/revoke",
        f"/api/shares/{TOKEN}/restore",
        f"/api/shares/record/{TOKEN}/replace",
        f"/auth/login/github?next=%2Fr%2F{TOKEN}%3Fa%3D1",
        f"/auth/login/github?next=%2fapi%2freview%2f{TOKEN}",
        f"/x?next=%252Fapi%252Fshares%252Frecord%252F{TOKEN}%252Freplace",
        f"/R/{TOKEN}/daw",
        f"/REC/{TOKEN}",
        f"/Rec/{TOKEN}",
        f"/API/REVIEW/{TOKEN}/daw/ws",
        f"/Api/Review/{TOKEN}/comments",
        f"/API/REC/{TOKEN}/ws",
        f"/MCP/{TOKEN}/mcp",
        f"/Mcp/{TOKEN}/mcp",
        f"/API/SHARES/{TOKEN}/REVOKE",
        f"/Api/Shares/{TOKEN}/restore",
        f"/API/SHARES/RECORD/{TOKEN}/REPLACE",
        f"/Api/Shares/Record/{TOKEN}/replace",
        f"/auth/login/github?next=%2FR%2F{TOKEN}%3Fa%3D1",
        f"/auth/login/github?next=%2FAPI%2fREVIEW%2f{TOKEN}",
        f"/x?next=%252FAPI%252FSHARES%252FRECORD%252F{TOKEN}%252FREPLACE",
    ],
)
def test_redact_share_paths_masks_the_token_of_every_share_route(path: str) -> None:
    out = redact_share_paths(f"POST {path} HTTP/1.1")

    assert TOKEN not in out
    assert "<share-token>" in out


def test_redact_share_paths_keeps_routes_that_carry_no_token() -> None:
    line = "POST /api/shares/rooms/0123456789ab/revoke /api/shares/record /api/health"

    assert redact_share_paths(line) == line


def test_redact_secrets_masks_a_prefix_of_a_secret_from_the_minimum_length() -> None:
    out = redact_secrets(f"{TOKEN} velvet-quok velvet velve {TOKEN[:12]}-x", [TOKEN], min_prefix=6)

    assert "velvet" not in out
    assert "velve" in out


def test_redact_secrets_leaves_nothing_of_a_secret_that_shares_its_start_with_another() -> None:
    other = "velvet-heron-pine"
    out = redact_secrets(f"a {other} b", [TOKEN, other], min_prefix=6)

    assert out == "a <redacted> b"


def test_redact_secrets_masks_two_adjacent_secrets_as_one_run() -> None:
    out = redact_secrets(f"{TOKEN}{TOKEN}", [TOKEN], min_prefix=6)

    assert out == "<redacted>"


def test_redact_secrets_sees_a_secret_that_is_only_percent_encoded() -> None:
    out = redact_secrets("next=%76elvet-quokka-umbra", [TOKEN], min_prefix=6)

    assert "quokka" not in out
    assert "umbra" not in out


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (f"/r/{TOKEN}/ws", "/r/<share-token>/ws"),
        (f"/api/review/{TOKEN}/daw/ws", "/api/review/<share-token>/daw/ws"),
        (f"%2Fr%2F{TOKEN}", "%2Fr%2F<share-token>"),
        (f"/r//{TOKEN}/ws", "/r//<share-token>/ws"),
    ],
)
def test_redact_share_paths_keeps_the_separators_around_the_masked_token(
    text: str, expected: str
) -> None:
    assert redact_share_paths(text) == expected


def _reference_mask(text: str, secrets: list[str], min_prefix: int | None) -> str:
    spans: list[tuple[int, int]] = []
    for secret in set(secrets):
        keep = len(secret) if min_prefix is None else min(len(secret), min_prefix)
        pattern = (
            re.escape(secret[:keep])
            + "".join(f"(?:{re.escape(ch)}" for ch in secret[keep:])
            + ")?" * (len(secret) - keep)
        )
        spans.extend(m.span() for m in re.finditer(pattern, text))
    merged: list[list[int]] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    out = text
    for start, end in reversed(merged):
        out = out[:start] + "<redacted>" + out[end:]
    return out


@pytest.mark.parametrize(
    "text",
    [
        TOKEN,
        f"{TOKEN}{TOKEN}",
        f"{TOKEN} {TOKEN}",
        f"x{TOKEN}y",
        "velvet-quokka-umbra-heron velvet-quokka",
        "velvet-heron-pine-quokka-umbra",
        "velvet velve velvet-q",
        "no secret here",
        "",
    ],
)
@pytest.mark.parametrize("min_prefix", [None, 6])
def test_mask_values_matches_the_one_span_at_a_time_reference(
    text: str, min_prefix: int | None
) -> None:
    secrets = [TOKEN, "velvet-heron-pine", "quokka-umbra-x"]

    assert _mask_values(text, secrets, min_prefix) == _reference_mask(text, secrets, min_prefix)


def test_redact_secrets_masks_dense_hits_in_linear_time() -> None:
    secrets = [f"tok{i}-alpha-beta-gamma" for i in range(10)]
    chunk = " ".join(secrets) + " plain words between the hits "
    text = chunk * (1_000_000 // len(chunk))

    start = time.perf_counter()
    out = redact_secrets(text, secrets, min_prefix=6)
    elapsed = time.perf_counter() - start

    assert out.count("<redacted>") == 10 * (len(text) // len(chunk))
    assert "alpha" not in out
    assert elapsed < 1.0


_DOT_TOKEN = "swift-amber-otter"
_ONE_SPELLING_PER_SHAPE = [
    pytest.param(spell(shape, SPELLINGS[i % len(SPELLINGS)], _DOT_TOKEN), id=f"{shape}-{i}")
    for i, shape in enumerate(SHAPES)
]


@pytest.mark.parametrize("path", _ONE_SPELLING_PER_SHAPE)
def test_a_dot_segment_or_doubled_slash_before_the_token_does_not_hide_it(path: str) -> None:
    for out in (redact_share_paths(path), sanitize(path), redact_secrets(path, [])):
        assert _DOT_TOKEN not in out
        assert "<share-token>" in out


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/r/./swift-amber-otter", "/r/./<share-token>"),
        ("/r/../swift-amber-otter", "/r/../<share-token>"),
        ("/rec/../swift-amber-otter", "/rec/../<share-token>"),
        ("/api/review/./swift-amber-otter/daw/meta", "/api/review/./<share-token>/daw/meta"),
        ("/api/./review/swift-amber-otter/daw/meta", "/api/./review/<share-token>/daw/meta"),
        ("/api//review//swift-amber-otter/daw/meta", "/api//review//<share-token>/daw/meta"),
        (
            "/api/shares/./record/./swift-amber-otter/replace",
            "/api/shares/./record/./<share-token>/replace",
        ),
        ("/r/%2e/swift-amber-otter", "/r/%2e/<share-token>"),
        ("/r/%2E%2E/swift-amber-otter", "/r/%2E%2E/<share-token>"),
        ("/r/.%2e/swift-amber-otter", "/r/.%2e/<share-token>"),
        ("/r/%252e/swift-amber-otter", "/r/%252e/<share-token>"),
        ("%2Fr%2F.%2Fswift-amber-otter", "%2Fr%2F.%2F<share-token>"),
        ("/api%2F%2e%2F/review/swift-amber-otter", "/api%2F%2e%2F/review/<share-token>"),
    ],
)
def test_share_paths_keep_their_dot_segments_and_lose_only_the_token(
    path: str, expected: str
) -> None:
    assert redact_share_paths(path) == expected


@pytest.mark.parametrize(
    "path",
    [
        "/r/.hidden-file-name",
        "/r/..-notes-longname",
        "/r/a.b-long-file-name",
        "/r/./ab",
        "/r/.../swift-amber-otter",
    ],
)
def test_a_dotted_name_or_a_short_word_after_a_root_is_not_masked(path: str) -> None:
    assert redact_share_paths(path) == path


@pytest.mark.xfail(strict=True, reason="walk-out through a named segment is not masked; see #3919")
def test_a_walk_out_through_a_named_segment_hides_the_token() -> None:
    assert _DOT_TOKEN not in redact_share_paths("/r/x/../swift-amber-otter")


def test_redact_share_paths_handles_many_dot_segments_in_linear_time() -> None:
    text = "/r" + "/./" * 400_000 + "x"

    start = time.perf_counter()
    out = redact_share_paths(text)
    elapsed = time.perf_counter() - start

    assert out == text
    assert elapsed < 1.0


def test_sanitize_hides_a_validation_input_value() -> None:
    text = "  Field required [type=missing, input_value={'name': 'MARK-A'}, input_type=dict]"
    out = sanitize(text, home=Path("/Users/host"))
    assert "MARK-A" not in out
    assert out.startswith("  Field required [type=missing, input_value=")
    assert out.endswith(", input_type=dict]")


def test_sanitize_hides_a_value_that_holds_the_input_type_text() -> None:
    text = "x [type=string_type, input_value='a, input_type=str MARK-B', input_type=str]"
    out = sanitize(text, home=Path("/Users/host"))
    assert "MARK-B" not in out
    assert out.endswith(", input_type=str]")


def test_sanitize_hides_every_validation_error_on_its_own_line() -> None:
    text = (
        "a.b\n  bad [type=x, input_value={'n': 'MARK-C'}, input_type=dict]\n"
        "c.d\n  bad [type=x, input_value=['MARK-D'], input_type=list]\nafter MARK-E"
    )
    out = sanitize(text, home=Path("/Users/host"))
    assert "MARK-C" not in out
    assert "MARK-D" not in out
    assert out.endswith("after MARK-E")
    assert out.count("input_type=") == 2


def test_sanitize_cuts_an_input_value_with_no_input_type_to_the_end_of_the_line() -> None:
    text = "bad [type=x, input_value={'n': 'MARK-F'}\nnext MARK-G line"
    out = sanitize(text, home=Path("/Users/host"))
    assert "MARK-F" not in out
    assert out.endswith("\nnext MARK-G line")


def test_sanitize_leaves_text_without_an_input_value_alone() -> None:
    text = "input_type=dict and input value 3 [type=x]"
    assert sanitize(text, home=Path("/Users/host")) == text


@pytest.mark.parametrize(
    ("folder", "encoded"),
    [
        (
            "/tmp/ep one/raw",
            ["%2Ftmp%2Fep%20one%2Fraw", "%2ftmp%2fep%20one%2fraw", "%2Ftmp%2Fep+one%2Fraw"],
        ),
        ("/tmp/Épisode", ["%2Ftmp%2F%C3%89pisode", "/tmp/%C3%89pisode", "%2Ftmp%2F%c3%89pisode"]),
        ("C:\\Users\\me\\ep", ["C%3A%5CUsers%5Cme%5Cep", "C%3a%5cUsers%5cme%5cep"]),
        ("/tmp/ep(1)!", ["%2Ftmp%2Fep%281%29%21", "%2Ftmp%2Fep(1)!"]),
    ],
)
def test_sanitize_replaces_the_percent_encoded_workspace(folder: str, encoded: list[str]) -> None:
    for spelling in encoded:
        line = f'"WebSocket /api/host/ws?path={spelling}%2Fepisode.sharecut&client_id=v 403'
        out = sanitize(line, home=Path("/Users/host"), workspace=Path(folder))
        assert (
            out == '"WebSocket /api/host/ws?path=<workspace>%2Fepisode.sharecut&client_id=v 403'
        ), spelling


def test_sanitize_replaces_the_percent_encoded_home_and_extra_paths() -> None:
    line = "a %2FUsers%2Fhost%2F.cache b %2Fopt%2Fpodcast-cache%2Fx"
    out = sanitize(
        line,
        home=Path("/Users/host"),
        extra=[(Path("/opt/podcast-cache"), "<cache>")],
    )
    assert out == "a ~%2F.cache b <cache>%2Fx"
