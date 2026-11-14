"""Validate a post-sign-in ``next`` destination as a same-origin path (open-redirect guard)."""

from __future__ import annotations

from urllib.parse import unquote

MAX_NEXT_LENGTH = 2048


def safe_next_path(value: object, default: str = "/") -> str:
    """Return ``value`` if it is a same-origin absolute path, else ``default``.

    Accepts ``/``, ``/r/<token>``, ``/?project=x``. Rejects scheme or network-relative forms
    (``https://``, ``//host``, ``/\\host``), backslashes, whitespace and control or non-ASCII
    characters, and anything over ``MAX_NEXT_LENGTH``. Both the raw and the once-decoded
    form are checked, so ``%2f%2f`` and ``%5c`` cannot smuggle a ``//`` or ``\\`` through.
    """
    if not isinstance(value, str) or not value or len(value) > MAX_NEXT_LENGTH:
        return default
    for candidate in (value, unquote(value)):
        if not candidate.isascii() or not candidate.isprintable() or " " in candidate:
            return default
        if "\\" in candidate or not candidate.startswith("/") or candidate.startswith("//"):
            return default
    return value
