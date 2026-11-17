from __future__ import annotations

import io
import logging
import re
import time
from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError, field_validator
from pydantic_core import PydanticCustomError

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


def test_sanitize_replaces_a_capitalised_folder_written_with_lowercase_hex_escapes() -> None:
    folder = Path("/Srv/Shows/My Episode")
    line = 'GET /api/document/state?path=%2fSrv%2fShows%2fMy%20Episode%2fep.sharecut HTTP/1.1" 400'
    out = sanitize(line, home=Path("/Users/host"), workspace=folder)
    assert out == 'GET /api/document/state?path=<workspace>%2fep.sharecut HTTP/1.1" 400'


def test_sanitize_does_not_match_a_folder_whose_letters_differ_in_case() -> None:
    # A path is case-sensitive: other letters name another folder, so it stays as written.
    line = "path=%2fsrv%2fshows%2fmy%20episode%2fep.sharecut"
    out = sanitize(line, home=Path("/Users/host"), workspace=Path("/Srv/Shows/My Episode"))
    assert out == line


def test_sanitize_replaces_the_percent_encoded_home_and_extra_paths() -> None:
    line = "a %2FUsers%2Fhost%2F.cache b %2Fopt%2Fpodcast-cache%2Fx"
    out = sanitize(
        line,
        home=Path("/Users/host"),
        extra=[(Path("/opt/podcast-cache"), "<cache>")],
    )
    assert out == "a ~%2F.cache b <cache>%2Fx"


# A validation error prints where it failed, and a dict key of the document (a speaker's name)
# is part of that place. Only numbers and the model's own field names may stay.
_NAMES = frozenset({"meta", "ingest_alignment", "align_method", "entries", "label", "name"})


def _pydantic_block(*locations: str) -> str:
    rows = [f"{len(locations)} validation error{'s' if len(locations) != 1 else ''} for X"]
    for loc in locations:
        rows.append(loc)
        rows.append("  Input should be a valid string [type=string_type]")
        rows.append(
            "    For further information visit https://errors.pydantic.dev/2.14/v/string_type"
        )
    return "\n".join(rows)


def _block_after(locations: list[str], expected: list[str]) -> tuple[str, str]:
    return (
        sanitize(_pydantic_block(*locations), field_names=_NAMES),
        _pydantic_block(*expected),
    )


def test_sanitize_masks_a_dict_key_in_a_validation_location() -> None:
    out, expected = _block_after(
        ["meta.ingest_alignment.Zelda Quimby.align_method"],
        ["meta.ingest_alignment.*.align_method"],
    )
    assert out == expected


def test_sanitize_masks_every_error_of_one_block() -> None:
    out, expected = _block_after(
        ["meta.ingest_alignment.Zelda.align_method", "entries.3.label", "meta.ingest_alignment.Bo"],
        ["meta.ingest_alignment.*.align_method", "entries.3.label", "meta.ingest_alignment.*"],
    )
    assert out == expected


@pytest.mark.parametrize(
    "key",
    [
        "Zelda Quimby",
        "Zelda)Quimby",
        "Zéldá日本Quimby",
        "Zelda:Quimby",
        "Zelda/Quimby",
        "[Zelda]",
        "`Zelda`",
        "Zelda Quimby)Borgo",
    ],
)
def test_sanitize_covers_every_part_of_an_odd_key(key: str) -> None:
    loc = f"meta.ingest_alignment.{key}.align_method"
    out = sanitize(_pydantic_block(loc), field_names=_NAMES)
    for part in re.split(r"[\n.:/ )`\[\]]", key):
        if part:
            assert part not in out, (key, out)
    assert "meta.ingest_alignment." in out
    assert out.count("[type=string_type]") == 1
    assert "https://errors.pydantic.dev/2.14/v/string_type" in out


def test_sanitize_masks_a_key_with_a_dot_as_several_stars() -> None:
    out = sanitize(_pydantic_block("meta.ingest_alignment.`a.b`.align_method"), field_names=_NAMES)
    assert "meta.ingest_alignment.*.*.align_method" in out
    assert "`" not in out


def test_sanitize_leaves_a_key_with_a_newline_to_the_source_rule() -> None:
    # Stated boundary: an entry is ONE location line followed by an indented ``[type=...]`` line.
    # A key that itself holds a line break is outside it; the episode file's own keys never get
    # this far (``load_project`` masks them at the source).
    block = _pydantic_block("meta.ingest_alignment.Zelda\nQuimby.align_method")
    assert sanitize(block, field_names=_NAMES) == block


def test_sanitize_keeps_a_location_of_indexes_and_field_names() -> None:
    block = _pydantic_block("entries.0.label", "meta.name", "entries.12.label")
    assert sanitize(block, field_names=_NAMES) == block


def test_sanitize_keeps_a_key_that_equals_a_field_name() -> None:
    # Accepted: the text of the location cannot tell this key from the field, and the name is
    # public (it is in the code).
    block = _pydantic_block("meta.ingest_alignment.label.align_method")
    assert sanitize(block, field_names=_NAMES) == block


def test_sanitize_without_field_names_masks_every_word_but_numbers() -> None:
    out = sanitize(_pydantic_block("entries.0.label", "meta.ingest_alignment.Zelda.align_method"))
    assert "entries.0.label" not in out
    assert "*.0.*" in out
    assert "*.*.*.*" in out
    assert "Zelda" not in out


@pytest.mark.parametrize("key", ["Zelda", "Zel)da", "Zelda\nQuimby", "Zelda Quimby", "Zéldá"])
def test_sanitize_masks_the_key_in_the_old_unreadable_sentence(key: str) -> None:
    text = (
        "ProjectUnreadableError: The project file is damaged and could not be read "
        f"(unexpected contents at meta.ingest_alignment.{key}.align_method). "
        "Restore it from a backup, or open a copy of the project."
    )
    out = sanitize(text, field_names=_NAMES)
    assert key not in out
    assert "(unexpected contents at meta.ingest_alignment.*" in out
    assert out.endswith("). Restore it from a backup, or open a copy of the project.")
    assert out.count("align_method") == 1


def test_sanitize_keeps_the_old_unreadable_sentence_when_it_names_fields_only() -> None:
    text = "(unexpected contents at entries.0.label). Restore it from a backup"
    assert sanitize(text, field_names=_NAMES) == text


def test_sanitize_cuts_the_old_sentence_to_the_end_of_the_line_when_its_tail_is_missing() -> None:
    out = sanitize(
        "x (unexpected contents at meta.ingest_alignment.Zelda.align_method\nnext",
        field_names=_NAMES,
    )
    assert out == "x (unexpected contents at meta.ingest_alignment.*.align_method\nnext"


@pytest.mark.parametrize(
    "text",
    [
        "3 validation errors were counted in the nightly run",
        "no validation error for meta.name.Zelda here",
        "unexpected contents at the door",
        "GET /api/x?q=unexpected+contents+at+meta HTTP/1.1 200",
        "validation error for Zelda.Quimby",
        'INFO:     127.0.0.1:1 - "GET /api/project HTTP/1.1" 200 OK',
        "Percent 50% done + more; a+b=3; 100%25 sure",
    ],
)
def test_sanitize_leaves_other_shapes_that_use_the_words_alone(text: str) -> None:
    # Only a header "N validation error(s) for X" followed by location lines, or the sentence
    # with its "unexpected contents at <place>" followed by a closing parenthesis, is rewritten.
    assert sanitize(text, field_names=_NAMES) == text


def test_sanitize_of_two_megabytes_with_locations_stays_fast() -> None:
    block = _pydantic_block("meta.ingest_alignment.Zelda Quimby.align_method", "entries.0.label")
    text = (block + "\n" + "INFO: 127.0.0.1 GET /api/x 200\n" * 20) * 2000
    text = text[: 2 * 1024 * 1024]
    start = time.perf_counter()
    out = sanitize(text, field_names=_NAMES)
    assert time.perf_counter() - start < 10
    assert "Zelda" not in out


def _entry(key: str) -> str:
    return (
        f"meta.{key}.align_method\n"
        "  Input should be a valid string [type=string_type]\n"
        "    For further information visit https://errors.pydantic.dev/2.14/v/string_type"
    )


@pytest.mark.parametrize(
    "prefix",
    [
        "pydantic_core._pydantic_core.ValidationError: ",
        "Nov 17 ERROR probe: failed: ",
        "RuntimeError: wrapped: ",
        "ERROR:    ",
        "",
    ],
)
def test_sanitize_masks_a_location_whose_header_is_not_at_the_line_start(prefix: str) -> None:
    text = f"{prefix}2 validation errors for Outer\n{_entry('Daniela Secretname')}\nnext line"
    out = sanitize(text, field_names=_NAMES)
    assert "Daniela" not in out
    assert "Secretname" not in out
    assert out.startswith(f"{prefix}2 validation errors for Outer\nmeta.*.align_method\n")
    assert out.endswith("\nnext line")


def test_a_header_with_no_entry_leaves_the_lines_after_it_unchanged() -> None:
    tail = "\n  Something indented [type=elsewhere]"
    lines = "".join(f"GET /api/item.{n} 200 ok.line\n" for n in range(200))
    text = "x: 2 validation errors for Outer\n" + lines + "y" * 2500 + tail
    assert sanitize(text, field_names=_NAMES) == text


def test_tens_of_thousands_of_bare_headers_are_fast() -> None:
    # The bound is loose on purpose (a loaded CI runner must pass; about 0.4 s unloaded). It
    # guards a block rule whose work per bare header grows with the text after it (a rescan of
    # the rest of the input): 36000 headers in 2 MB would then take longer than the bound. Measured
    # on such rescans: the cheapest took 10.8 s against the 10 s bound, a regex rescan 20 s and more.
    text = ("1 validation error for Outer\n" + "some ordinary line. with dots\n") * 40000
    text = text[: 2 * 1024 * 1024]
    start = time.perf_counter()
    assert sanitize(text, field_names=_NAMES) == text
    assert time.perf_counter() - start < 10


# --- the exact block rule: a header, then at most N entries of one location line each ---------

_REAL_NAMES = frozenset({"name", "tags", "align_method"})


class _Inner(BaseModel):
    align_method: str


class _Keyed(BaseModel):
    tags: dict[str, _Inner]


class _Plain(BaseModel):
    name: str


def _keyed_error(speaker: str) -> ValidationError:
    try:
        _Keyed.model_validate({"tags": {speaker: {"align_method": 7}}})
    except ValidationError as exc:
        return exc
    raise AssertionError("accepted")


def _plain_error() -> ValidationError:
    try:
        _Plain.model_validate({"name": [1]})
    except ValidationError as exc:
        return exc
    raise AssertionError("accepted")


def _log_text(records: list[tuple[str, str, object]], *, exc_info: bool = False) -> str:
    """What a stream handler writes for ``records`` (level, message, args)."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s:%(message)s"))
    logger = logging.getLogger("podcast_mcp.test_redact_exact")
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    logger.addHandler(handler)
    try:
        for level, message, arg in records:
            if isinstance(arg, ValidationError) and exc_info:
                try:
                    raise arg
                except ValidationError:
                    getattr(logger, level)(message, exc_info=True)
            elif arg is None:
                getattr(logger, level)(message)
            else:
                getattr(logger, level)(message, arg)
    finally:
        logger.removeHandler(handler)
    return stream.getvalue()


_ORDINARY = (
    "INFO:x:ordinary line A render finished in 3.5s\n",
    "WARNING:x:ordinary line B disk 12.5 GB free\n",
)


@pytest.mark.parametrize("exc_info", [False, True])
def test_two_real_blocks_keep_every_line_between_them(exc_info: bool) -> None:
    speaker = "Dani" + "ela Secret" + "name"
    records: list[tuple[str, str, object]] = [
        ("error", "tool arguments rejected: %s", _keyed_error(speaker)),
        ("info", "ordinary line A render finished in 3.5s", None),
        ("warning", "ordinary line B disk 12.5 GB free", None),
        ("error", "second call rejected: %s", _plain_error()),
        ("info", "ordinary line C after", None),
    ]
    raw = _log_text(records, exc_info=exc_info)
    assert speaker in raw
    out = sanitize(raw, field_names=_REAL_NAMES)
    assert "Daniela" not in out
    assert "Secretname" not in out
    for line in ("ordinary line A render finished in 3.5s", "ordinary line B disk 12.5 GB free"):
        assert f":{line}\n" in out
    assert "ordinary line C after" in out
    assert out.count(" validation error for _Keyed") == 1
    assert out.count(" validation error for _Plain") == 1
    assert "\ntags.*.align_method\n" in out
    assert "\nname\n  Input should be a valid string [type=string_type" in out
    # every other line is byte for byte what was logged: only the one location line changed
    changed = [
        a
        for a, b in zip(raw.splitlines(), out.splitlines(), strict=True)
        if a != b and "input_value=" not in a
    ]
    assert changed == [f"tags.{speaker}.align_method"]


def test_a_sentence_that_only_says_it_does_not_eat_the_lines_after_it() -> None:
    real = _log_text([("error", "later: %s", _keyed_error("Dani" + "ela Secret" + "name"))])
    text = (
        "WARNING: 3 validation errors for the upload\n"
        "the file foo.mp3 was skipped\n"
        "INFO: ok\n" + real
    )
    out = sanitize(text, field_names=_REAL_NAMES)
    assert out.startswith(
        "WARNING: 3 validation errors for the upload\nthe file foo.mp3 was skipped\nINFO: ok\n"
    )
    assert "Secretname" not in out
    assert "ERROR:podcast_mcp.test_redact_exact:later: 1 validation error for _Keyed\n" in out
    assert "\ntags.*.align_method\n" in out


def test_the_count_in_the_header_is_honoured() -> None:
    speaker = "Dani" + "ela Secret" + "name"
    text = (
        "1 validation error for X\n"
        f"tags.{speaker}.align_method\n"
        "  bad [type=string_type, input_type=int]\n"
        f"tags.{speaker}.align_method\n"
        "  bad [type=string_type, input_type=int]\n"
    )
    out = sanitize(text, field_names=_REAL_NAMES)
    assert out.splitlines()[1] == "tags.*.align_method"
    assert out.splitlines()[3] == f"tags.{speaker}.align_method"


def test_a_crlf_block_is_masked_and_keeps_its_line_ends() -> None:
    speaker = "Dani" + "ela Secret" + "name"
    text = (
        "INFO: before\r\n"
        "1 validation error for _Keyed\r\n"
        f"tags.{speaker}.align_method\r\n"
        "  Input should be a valid string [type=string_type, input_type=int]\r\n"
        "    For further information visit https://errors.pydantic.dev/2.14/v/string_type\r\n"
        "INFO: after tags.x.y\r\n"
    )
    out = sanitize(text, field_names=_REAL_NAMES)
    assert out == text.replace(f"tags.{speaker}.align_method", "tags.*.align_method")


@pytest.mark.parametrize(
    "text",
    [
        "INFO: 1 validation error for the form\nline.one.two\nINFO: next\n",
        "2 validation errors for X\n  indented [type=x]\nplain text\n",
        "1 validation error for X\nloc.a.b\n [type=x]\n",
        "1 validation error for X\nloc.a.b\n  no closing [type=x\n",
        "1 validation error for X\nloc.a.b\n  closing without opening type]\n",
        "1 validation error for X\n\nloc.a.b\n  m [type=x]\n",
        "WARNING: [type=x] seen in the wild\n  a.b.c [type=y] was it\n",
        "0 validation errors for X\nloc.a.b\n  m [type=x]\n",
        "validation errors for X\nloc.a.b\n  m [type=x]\n",
        "1 validation error for\nloc.a.b\n  m [type=x]\n",
        'Traceback (most recent call last):\n  File "a.py", line 3, in f\n    g()\nValueError: 5\n',
        "  indented one\n    indented two [type=3]\nplain.dotted.text here\n",
        "1 validation error for X\n" + "z" * 2100 + "\n  m [type=x]\n",
        "5 validation errors for X, and it went on\nthe next line\nanother.dotted.line\n",
    ],
)
def test_ordinary_log_text_without_an_entry_is_returned_byte_for_byte(text: str) -> None:
    assert sanitize(text, field_names=_REAL_NAMES) == text


def test_one_line_of_2_mb_of_headers_is_fast() -> None:
    # The bound is loose on purpose (about 1.3 s unloaded, so a loaded CI runner passes). It
    # guards the title cap: a header with no line end must not make the regex read to the end
    # of the 2 MB line again for every header (quadratic, tens of seconds).
    text = ("1 validation errors for " * (2 * 1024 * 1024 // 23 + 1))[: 2 * 1024 * 1024]
    start = time.perf_counter()
    out = sanitize(text, field_names=_REAL_NAMES)
    assert time.perf_counter() - start < 10
    assert out == text


def test_a_header_whose_tail_is_over_500_characters_is_not_a_header() -> None:
    speaker = "Dani" + "ela Secret" + "name"
    text = "1 validation error for " + "Z" * 501 + f"\ntags.{speaker}.align_method\n  m [type=x]\n"
    assert sanitize(text, field_names=_REAL_NAMES) == text


def test_many_blocks_with_ordinary_lines_between_stay_fast() -> None:
    block = _log_text([("error", "x: %s", _keyed_error("Dani" + "ela Secret" + "name"))])
    text = (block + "INFO:x:ordinary\n" * 5) * 1500
    text = text[: 256 * 1024]
    start = time.perf_counter()
    out = sanitize(text, field_names=_REAL_NAMES)
    assert time.perf_counter() - start < 5
    assert "Secretname" not in out
    assert out.count("INFO:x:ordinary\n") == text.count("INFO:x:ordinary\n")


# --- a block whose entries carry no ``For further information`` line --------------------------


class _NoUrlInner(BaseModel):
    align_method: str

    @field_validator("align_method")
    @classmethod
    def _always_wrong(cls, value: str) -> str:
        raise PydanticCustomError("no_url_error", "this value is not allowed")


class _NoUrlKeyed(BaseModel):
    tags: dict[str, _NoUrlInner]


def test_a_block_whose_entries_have_no_further_information_line_masks_both_locations() -> None:
    first, second = "Dani" + "ela Secret" + "name", "Zel" + "da Quim" + "by"
    try:
        _NoUrlKeyed.model_validate(
            {"tags": {first: {"align_method": "a"}, second: {"align_method": "b"}}}
        )
    except ValidationError as exc:
        raw = str(exc)
    else:
        raise AssertionError("accepted")
    # a custom error type has no documentation page: real pydantic prints no URL line
    assert "For further information" not in raw
    assert raw.count("[type=no_url_error") == 2
    assert f"tags.{first}.align_method\n" in raw
    assert f"tags.{second}.align_method\n" in raw
    out = sanitize(raw, field_names=_REAL_NAMES)
    # nothing else changes but the two location lines and the quoted input values
    expected = re.sub(r"input_value='.'", "input_value=<hidden>", raw)
    expected = expected.replace(f"tags.{first}.", "tags.*.").replace(f"tags.{second}.", "tags.*.")
    assert out == expected
    assert out.count("tags.*.align_method\n") == 2


def test_a_location_of_non_ascii_digits_is_masked() -> None:
    # ``str.isdecimal`` is true for Arabic-Indic digits; they are no index, so they could be
    # a key of the document (a speaker's name written in digits).
    block = "1 validation error for X\ntags.\u0663\u0664.a\n  m [type=x]\n"
    out = sanitize(block, field_names=frozenset({"tags", "a"}))
    assert out == block.replace("\u0663\u0664", "*")


def test_a_seven_digit_count_is_no_header() -> None:
    # The count is at most six digits and not the tail of a longer number: without the
    # look-behind "234567 validation errors for X" would be read as a header.
    speaker = "Dani" + "ela Secret" + "name"
    text = f"1234567 validation errors for X\ntags.{speaker}.align_method\n  m [type=x]\n"
    assert sanitize(text, field_names=_REAL_NAMES) == text
