from __future__ import annotations

import pytest

from podcast_mcp.util.text import collapse_whitespace, count_noun, lexicon_form, normalize_text


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


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Um.", "um"),
        ("-huh.", "huh"),
        ("Uh-huh,", "uh-huh"),
        ("don't.", "don't"),
        ("\u201cRoom,\u201d", "room"),
        ("stor-", "stor"),
        ("  You   know,", "you know"),
        ("...", ""),
    ],
)
def test_lexicon_form_strips_edge_punctuation_only(text: str, expected: str) -> None:
    assert lexicon_form(text) == expected
