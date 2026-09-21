"""Cross-platform names for files written to an episode's ``export/`` directory."""

from __future__ import annotations

import hashlib
import re

MAX_FILENAME_COMPONENT_BYTES = 255
# The longest standard sidecar is ``.chapters.json`` (14 bytes).  Reserve one
# extra byte so ordinary format extensions still fit in the same component.
MAX_EXPORT_STEM_BYTES = 240

_WINDOWS_RESERVED_BASENAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{number}" for number in range(1, 10)}
    | {f"LPT{number}" for number in range(1, 10)}
)
_UNSAFE_STEM_CHARS = re.compile(r"[^\w.-]+", flags=re.UNICODE)
_UNSAFE_ASCII_STEM_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


def _truncate_utf8(value: str, max_bytes: int) -> str:
    """Truncate at a UTF-8 character boundary, preserving a stable suffix."""
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value

    digest = hashlib.sha256(encoded).hexdigest()[:12]
    suffix = f"-{digest}"
    prefix_budget = max_bytes - len(suffix.encode("ascii"))
    prefix: list[str] = []
    used = 0
    for char in value:
        char_bytes = len(char.encode("utf-8"))
        if used + char_bytes > prefix_budget:
            break
        prefix.append(char)
        used += char_bytes
    return "".join(prefix).rstrip(" ._-") + suffix


def sanitize_export_stem(
    name: str,
    *,
    fallback: str = "episode",
    max_bytes: int = MAX_EXPORT_STEM_BYTES,
    replacement: str = "_",
    ascii_only: bool = False,
) -> str:
    """Return a portable export filename stem with a bounded UTF-8 byte length.

    The result is one safe filename component: it cannot be a dot path, end in
    a Windows-trimmed dot/space, or resolve to a Windows device name. Long names
    retain a deterministic digest suffix, preventing truncation collisions.
    ``max_bytes`` intentionally reserves room for the file extension.
    ``replacement`` is restricted to the established export (``_``) and bounce
    (``-``) separators; ``ascii_only`` preserves legacy bounce naming.
    """
    if max_bytes <= 13:
        raise ValueError("max_bytes must leave room for the truncation hash")
    if replacement not in {"_", "-"}:
        raise ValueError("replacement must be '_' or '-'")

    unsafe_chars = _UNSAFE_ASCII_STEM_CHARS if ascii_only else _UNSAFE_STEM_CHARS
    cleaned = unsafe_chars.sub(replacement, name).strip(" ._-")
    if not cleaned:
        cleaned = fallback
    basename, dot, remainder = cleaned.partition(".")
    if basename.upper() in _WINDOWS_RESERVED_BASENAMES:
        cleaned = f"{basename}_file{dot}{remainder}"
    return _truncate_utf8(cleaned, max_bytes)
