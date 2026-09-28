from __future__ import annotations

import pytest

from podcast_mcp.util.text import collapse_whitespace, count_noun, normalize_text


@pytest.mark.parametrize(
    ("n", "expected"),
    [(0, "0 issues"), (1, "1 issue"), (2, "2 issues"), (10, "10 issues")],
)
def test_count_noun(n: int, expected: str) -> None:
    assert count_noun(n, "issue") == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [("  a \t b\n", "a b"), ("Teh  Fox", "Teh Fox"), ("", "")],
)
def test_collapse_whitespace_keeps_case(text: str, expected: str) -> None:
    assert collapse_whitespace(text) == expected


def test_normalize_text_lowercases_collapsed_text() -> None:
    assert normalize_text("  Teh \t FOX ") == "teh fox"
