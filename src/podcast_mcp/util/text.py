from __future__ import annotations

import re
import unicodedata


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


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
