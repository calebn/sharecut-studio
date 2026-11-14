"""Unit table for the post-sign-in ``next`` validator (open-redirect guard, #3743)."""

from __future__ import annotations

import pytest

from podcast_mcp.util.safe_redirect import MAX_NEXT_LENGTH, safe_next_path

LEGIT = [
    "/",
    "/r/tok_abc123",
    "/?project=x",
    "/rec/tok_abc123",
    "/r/tok?tab=notes#c-4",
    "/a?b=c#d",
]

HOSTILE = [
    "https://evil.example",
    "http://evil.example/x",
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "\\evil.example",
    "/%5Cevil.example",
    "/%2F%2Fevil.example",
    "/%2f%2fevil.example",
    "%2F%2Fevil.example",
    "%2f%2fevil",
    "%5cevil",
    "\tevil.example",
    "\n/evil.example",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,x",
    "evil.example",
    "relative/path",
    " /evil.example",
    "/evil.example ",
    "/\tevil.example",
    "/\nevil.example",
    "/\revil.example",
    "/evil\x00",
    "/\u00e9vil",
    "/\u2028evil",
    "/" + "a" * MAX_NEXT_LENGTH,
    "",
]


@pytest.mark.parametrize("value", LEGIT)
def test_legit_same_origin_paths_pass_through(value: str) -> None:
    assert safe_next_path(value) == value


@pytest.mark.parametrize("value", HOSTILE)
def test_hostile_values_fall_back_to_default(value: str) -> None:
    assert safe_next_path(value) == "/"
    assert safe_next_path(value, default="/r/fallback") == "/r/fallback"


@pytest.mark.parametrize("value", [None, 0, 1, b"/r/x", ["/"], {"next": "/"}])
def test_non_string_falls_back(value: object) -> None:
    assert safe_next_path(value) == "/"


def test_length_cap_is_inclusive() -> None:
    ok = "/" + "a" * (MAX_NEXT_LENGTH - 1)
    assert safe_next_path(ok) == ok
    assert safe_next_path(ok + "a") == "/"
