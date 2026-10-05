from __future__ import annotations

import re
import unicodedata


def collapse_whitespace(text: str) -> str:
    """Collapse each whitespace run to one space and trim both ends; case is preserved."""
    return re.sub(r"\s+", " ", text).strip()


def normalize_text(text: str) -> str:
    """Case-insensitive comparison form: lowercase plus ``collapse_whitespace``."""
    return collapse_whitespace(text.lower())


def lexicon_form(text: str) -> str:
    """Comparison form for matching ASR words against a word lexicon.

    Lowercase, with leading and trailing punctuation stripped from each
    whitespace-separated token. Inner apostrophes and hyphens stay, and tokens
    that were only punctuation drop out: ``"Um."`` -> ``"um"``, ``"-huh."`` ->
    ``"huh"``, ``"Uh-huh,"`` -> ``"uh-huh"``, ``"You  know"`` -> ``"you know"``.
    """
    tokens = (_strip_edge_punctuation(token) for token in text.lower().split())
    return " ".join(token for token in tokens if token)


def _strip_edge_punctuation(token: str) -> str:
    start, end = 0, len(token)
    while start < end and unicodedata.category(token[start]).startswith("P"):
        start += 1
    while end > start and unicodedata.category(token[end - 1]).startswith("P"):
        end -= 1
    return token[start:end]


def has_meaningful_text(text: str) -> bool:
    """Whether *text* contains more than whitespace or invisible controls.

    Unicode control (``Cc``) and format (``Cf``) characters can make a string
    non-empty without contributing transcript content.
    """
    return any(
        not char.isspace() and unicodedata.category(char) not in {"Cc", "Cf"} for char in text
    )


def count_noun(n: int, noun: str) -> str:
    """`1 issue` / `2 issues` / `0 issues` (regular English plural: appends `s` unless *n* == 1)."""
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"
